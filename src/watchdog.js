// In-server lifecycle watchdog -- orphan-process self-termination.
//
// Why this exists: on the prod MCP host this server is spawned per Claude
// session as a bare `ssh ... node src/mcp-server.js` child (no PTY,
// parent = `sshd: itdept@notty`). When a Claude session ends abruptly
// (Conductor workspace closed, laptop sleep, network drop, crash), the
// local ssh socket can linger, sshd stays blocked on the child, and the
// Node child never receives stdin EOF or SIGHUP -> it runs forever.
// Stranded fleets (~48 MB each here, plus much larger siblings) OOM the
// 8 GB shared VM. sshd's own ClientAlive* settings do NOT catch this
// trigger, so the child must self-terminate independently.
//
// Three fail-safe mechanisms, all best-effort (a broken watchdog must
// never crash or degrade the server):
//   1. Daemon poll loop (~20s): exits if reparented to init
//      (ppid==1, parent-death backstop) or if idle beyond the timeout
//      (catches the lingering-socket case where sshd is still alive
//      but nobody's home).
//   2. last-activity clock bumped at both entry and exit of every MCP
//      request, with an in-flight request counter so the watchdog can
//      NEVER kill mid-flight (would cause duplicate labels / shipments
//      / vouchers on retry).
//   3. Transport-liveness gate (on the idle kill ONLY): the idle timer
//      cannot tell "open Claude session, user just hasn't touched a tool
//      for 30 min" from "lingering socket, session gone" -- and killing
//      the former is a live-session regression. The Mac-side ssh client
//      is spawned with `ServerAliveInterval=30`, so as long as that ssh
//      process lives it emits an SSH keepalive every ~30s; the server's
//      TCP socket then shows its byte counters advancing every ~30s even
//      when zero MCP messages flow. A lingering orphan's counters FREEZE.
//      So each poll we read this connection's `bytes_received` via
//      `ss -tin` (peer identified from SSH_CONNECTION) and SUPPRESS the
//      idle kill only while the counter has PROVABLY advanced within the
//      last _TRANSPORT_FRESH_WINDOW_MS. This never weakens orphan/OOM
//      protection: (a) the ppid==1 backstop is untouched and still
//      immediate; (b) the in-flight-request gate is untouched; (c) ANY
//      inability to measure -- MCP_TRANSPORT_LIVENESS=0, SSH_CONNECTION
//      unset (local dev / tests / macOS), `ss` missing/erroring, the peer
//      4-tuple not found, a parse failure, frozen counters, or a non-ESTAB
//      state -- yields "not alive", i.e. today's exact idle behavior (idle
//      timer applies unmodified); we NEVER "assume alive". Because the gate
//      only holds an ALREADY-idle session, when its transport later dies the
//      kill fires within one fresh-window + one poll (~3-4 min) of transport
//      death. Env hatch: MCP_TRANSPORT_LIVENESS=0 disables just this gate,
//      reverting to the pre-gate idle behavior (fails toward MORE protection).
//
// Linux PR_SET_PDEATHSIG is deliberately NOT used here -- it would
// require a native FFI dependency (e.g. node-prctl) which adds build
// fragility, Docker image weight, and attack surface for a feature
// whose acceptance criterion is already "exits within ~20s". The
// ppid==1 poll catches the same case at the same effective resolution.
//
// We also do NOT read process.stdin -- the MCP StdioServerTransport
// owns it and a stray read would corrupt the protocol. ppid polling
// is the portable equivalent.
//
// Hardening notes (from /cso adversarial pass):
//   - Idle timeout is clamped to MAX_IDLE_TIMEOUT_SECONDS so a typo or
//     hostile env var cannot effectively disable cleanup.
//   - Elapsed-time math uses performance.now() (monotonic), so NTP /
//     manual clock jumps cannot kill an active server or mask idleness.
//   - ppid==1 is only treated as parent-death if we DID NOT start
//     under PID 1 (so systemd/launchd/container-init deployments
//     don't self-terminate the moment the watchdog arms).
//   - In-flight request count gates idle exit; watchdog only kills
//     when activeRequests === 0. Parent-death exit is still
//     unconditional -- if the parent is gone there is no one to
//     return a response to.
//   - Transport-liveness only ever SUPPRESSES the idle kill; it can
//     never cause a kill and defaults to "not alive" on any doubt.

import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const POLL_INTERVAL_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800; // 30 minutes
const MAX_IDLE_TIMEOUT_SECONDS = 86_400; // 24h hard cap -- defeats accidental "never expire"

// --- Transport-liveness gate (mechanism 3) constants ---
//
// The idle kill is SUPPRESSED only while the ancestor ssh connection's byte
// counters have advanced within this window. 180s = 6 SSH keepalive periods
// (ServerAliveInterval=30) -- generous enough to never trip on a live-but-quiet
// session, tight enough that a dead peer flips to "not alive" within 3 minutes.
export const _TRANSPORT_FRESH_WINDOW_MS = 180_000;
// Rate-limit the "idle but holding" log so a long-held session doesn't spam a
// line every 20s.
const TRANSPORT_SUPPRESS_LOG_INTERVAL_MS = 600_000;
// Absolute path -- do NOT trust PATH for a security-relevant probe.
const SS_BINARY = '/usr/bin/ss';
// TCP states `ss` can print in the State column; used only to recognize a
// connection-header line (vs the column header or an indented info line).
const TCP_STATES = new Set([
  'ESTAB',
  'SYN-SENT',
  'SYN-RECV',
  'FIN-WAIT-1',
  'FIN-WAIT-2',
  'TIME-WAIT',
  'CLOSE-WAIT',
  'LAST-ACK',
  'LISTEN',
  'CLOSING',
  'UNCONN',
  'CLOSE',
]);
const SS_BYTES_RECEIVED_RE = /\bbytes_received:(\d+)\b/;

let lastActivityMonoMs = performance.now();
let activeRequests = 0;
let watchdogTimer = null;
let initialPpid = process.ppid;

// --- Transport-liveness gate (mechanism 3) mutable state ---
//
// Resolved ONCE at startLifecycleWatchdog() time; the gate is inactive unless
// it is enabled AND SSH_CONNECTION parses -- both fail-safe toward the pre-gate
// idle behavior.
let transportPeer = null;
let transportGateActive = false;
// last proven-advance tracking. transportLastAdvanceMs is the monotonic time we
// last OBSERVED bytes_received increase; it is only ever set on a proven advance
// (never seeded from a single reading), so "alive" means the counters
// demonstrably moved -- not merely that one probe succeeded.
let transportLastBytes = null;
let transportLastAdvanceMs = null;
let transportLastSuppressLogMs = 0;

/**
 * Resolve MCP_IDLE_TIMEOUT_SECONDS defensively. Bad values fall back to
 * the default, and any value above MAX_IDLE_TIMEOUT_SECONDS is clamped
 * down so a hostile or fat-fingered env var cannot effectively disable
 * the watchdog.
 */
export function idleTimeoutSeconds(env = process.env) {
  const raw = env.MCP_IDLE_TIMEOUT_SECONDS;
  if (raw === undefined || raw === null) return DEFAULT_IDLE_TIMEOUT_SECONDS;
  const trimmed = String(raw).trim();
  if (trimmed === '') return DEFAULT_IDLE_TIMEOUT_SECONDS;
  if (!/^-?\d+$/.test(trimmed)) return DEFAULT_IDLE_TIMEOUT_SECONDS;
  const val = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(val) || val <= 0) return DEFAULT_IDLE_TIMEOUT_SECONDS;
  if (val > MAX_IDLE_TIMEOUT_SECONDS) return MAX_IDLE_TIMEOUT_SECONDS;
  return val;
}

/**
 * Pure decision function: should the watchdog terminate this process?
 *
 * Parent-death exit (ppid === 1 and we did not start as PID 1's child)
 * is unconditional -- no one is left to receive a response, and we
 * must free memory on the shared VM. Idle exit is suppressed while
 * any request is in flight, since killing mid-flight would drop a
 * response after the remote ShipStation side-effect has already
 * happened, leading clients to retry and duplicate labels/shipments.
 *
 * `transportAlive` (mechanism 3) gates ONLY the idle path: an idle
 * session whose ssh transport is provably alive (client keepalives still
 * advancing the socket byte counters) is held, not killed. It defaults to
 * false so every caller that cannot measure transport liveness -- and every
 * pre-mechanism-3 caller/test -- gets today's exact idle behavior. Parent
 * death and the in-flight gate are unaffected by it.
 */
export function shouldExit({
  ppid,
  startPpid,
  activeRequests: inFlight,
  lastActivityMono,
  nowMono,
  idleTimeoutSec,
  transportAlive = false,
}) {
  const parentDied = ppid === 1 && startPpid !== 1;
  if (parentDied) return true;
  if (inFlight > 0) return false;
  if ((nowMono - lastActivityMono) / 1000 > idleTimeoutSec && !transportAlive) return true;
  return false;
}

/** Bump the last-activity clock. Safe to call from any handler. */
export function bumpActivity() {
  lastActivityMonoMs = performance.now();
}

/** Test-only accessors. */
export function _getLastActivityMonoMs() {
  return lastActivityMonoMs;
}
export function _getActiveRequests() {
  return activeRequests;
}

/**
 * Wrap an MCP request handler so:
 *   - in-flight count is incremented on entry, decremented on exit
 *   - activity clock is bumped at both ends (so a long tool call still
 *     gets credit for "I was busy" after it returns)
 *   - errors propagate unchanged
 *
 * Never let the watchdog break a real request -- bookkeeping is
 * try/catch-wrapped and a thrown bump never reaches the caller.
 */
export function wrapWithActivityBump(handler) {
  return async (...args) => {
    try { activeRequests += 1; bumpActivity(); } catch { /* never break a request */ }
    try {
      return await handler(...args);
    } finally {
      try { activeRequests = Math.max(0, activeRequests - 1); bumpActivity(); } catch { /* never break a request */ }
    }
  };
}

// ---------------------------------------------------------------------------
// Transport-liveness gate (mechanism 3)
// ---------------------------------------------------------------------------

/**
 * Parsed SSH_CONNECTION peer: the client 3-tuple that identifies our socket.
 *
 * @typedef {Object} SshPeer
 * @property {string} clientIp
 * @property {string} clientPort
 * @property {string} serverPort
 */

/**
 * Runs `ss` and returns its stdout. Injectable so tests can drive the parser
 * and fail-safe paths without a real `ss` binary (mirrors monkeypatching
 * subprocess.run in the Python reference).
 *
 * @typedef {(binary: string, args: string[]) => string} SsRunner
 */

/** @type {SsRunner} */
const defaultSsRunner = (binary, args) =>
  execFileSync(binary, args, {
    encoding: 'utf8',
    timeout: 3000,
    // Ignore stdin/stderr; we only parse stdout. A nonzero exit throws (caught
    // by the caller and treated as "cannot measure" -> not alive).
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/**
 * True unless the operator set MCP_TRANSPORT_LIVENESS=0.
 *
 * The gate defaults ON, but is only ever ACTIVE when SSH_CONNECTION is also
 * present (see `sshConnectionPeer`). Disabling it reverts to the exact pre-gate
 * idle-kill behavior.
 */
export function transportLivenessEnabled(env = process.env) {
  return env.MCP_TRANSPORT_LIVENESS !== '0';
}

/**
 * Parse SSH_CONNECTION into `{clientIp, clientPort, serverPort}`.
 *
 * SSH_CONNECTION is `"<client_ip> <client_port> <server_ip> <server_port>"` in
 * the spawned process env. Returns null (gate permanently inactive this
 * process) when the var is absent, has the wrong shape, or carries non-integer
 * ports -- the fail-safe path.
 */
export function sshConnectionPeer(env = process.env) {
  const raw = env.SSH_CONNECTION;
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 4) return null;
  const [clientIp, clientPort, , serverPort] = parts;
  if (!clientIp) return null;
  if (!/^\d+$/.test(clientPort) || !/^\d+$/.test(serverPort)) return null;
  return { clientIp, clientPort, serverPort };
}

/**
 * Normalize an `ss` address token for comparison.
 *
 * Strips IPv6 brackets and the `::ffff:` v4-mapped-v6 prefix so a peer that
 * `ss` renders as `[::ffff:192.168.1.230]` matches SSH_CONNECTION's plain
 * `192.168.1.230`.
 */
export function normalizeSsIp(addr) {
  let a = addr.trim();
  if (a.startsWith('[') && a.endsWith(']')) {
    a = a.slice(1, -1);
  }
  if (a.startsWith('::ffff:')) {
    a = a.slice('::ffff:'.length);
  }
  return a;
}

/**
 * Pure parser: extract `bytes_received` for one ESTAB connection.
 *
 * Scans `ss -tin` text for the ESTAB connection whose local port ==
 * `serverPort` and whose peer == `clientIp:clientPort` (bracket / v4-mapped
 * tolerant), then reads `bytes_received:N` from its following indented info
 * line(s). Returns null on ANY failure to positively identify and parse that
 * one connection (empty/garbage input, tuple not found, state not ESTAB, no
 * counter present) -- the fail-safe contract. Side-effect-free and text-only so
 * it is unit-testable without `ss`.
 */
export function parseSsBytesReceived(ssOutput, clientIp, clientPort, serverPort) {
  if (!ssOutput) return null;
  if (!/^\d+$/.test(clientPort) || !/^\d+$/.test(serverPort)) return null;
  const wantCport = Number.parseInt(clientPort, 10);
  const wantSport = Number.parseInt(serverPort, 10);
  const wantIp = normalizeSsIp(clientIp);

  const lines = ssOutput.split('\n');
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    // A connection-header line is non-indented and starts with a TCP state.
    if (line.length === 0 || /^\s/.test(line)) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5 || !TCP_STATES.has(tokens[0])) continue;
    if (tokens[0] !== 'ESTAB') continue;
    const local = tokens[3];
    const peer = tokens[4];
    // Split on the LAST ':' so IPv6 addresses (which contain ':') split right.
    const li = local.lastIndexOf(':');
    const pi = peer.lastIndexOf(':');
    if (li < 0 || pi < 0) continue;
    const laddr = local.slice(0, li);
    const lport = local.slice(li + 1);
    const paddr = peer.slice(0, pi);
    const pport = peer.slice(pi + 1);
    if (!/^\d+$/.test(lport) || !/^\d+$/.test(pport)) continue;
    if (
      Number.parseInt(lport, 10) !== wantSport ||
      Number.parseInt(pport, 10) !== wantCport
    ) {
      continue;
    }
    if (normalizeSsIp(paddr) !== wantIp) continue;
    // Matched header -> read bytes_received from the following info block.
    let j = i + 1;
    while (j < n && (lines[j].length === 0 || /^\s/.test(lines[j]))) {
      const m = SS_BYTES_RECEIVED_RE.exec(lines[j]);
      if (m) return Number.parseInt(m[1], 10);
      j++;
    }
    return null; // header matched but no counter -> fail-safe
  }
  return null;
}

/**
 * Probe the ssh connection's `bytes_received` via `ss -tin`.
 *
 * Returns the current counter, or null on ANY failure (peer null, `ss`
 * missing/timeout/nonzero exit, tuple not found, parse failure) -- callers
 * treat null as "cannot measure -> not alive". The impure counterpart to the
 * pure `parseSsBytesReceived`; the `runSs` seam mirrors the Python reference's
 * monkeypatchable `subprocess.run`.
 */
export function readSshBytesReceived(peer, runSs = defaultSsRunner) {
  if (peer === null) return null;
  let stdout;
  try {
    stdout = runSs(SS_BINARY, ['-tin', `sport = :${peer.serverPort}`]);
  } catch {
    // `ss` missing, nonzero exit, or timeout -> cannot measure -> not alive.
    return null;
  }
  return parseSsBytesReceived(
    stdout,
    peer.clientIp,
    peer.clientPort,
    peer.serverPort
  );
}

/**
 * Stateful tick-level probe: is the ssh transport provably alive right now?
 *
 * Reads the current `bytes_received`, updates the proven-advance tracking
 * (module state, reset by `_stopForTests`), and returns true only while a
 * counter increase has been OBSERVED within `_TRANSPORT_FRESH_WINDOW_MS`.
 * Returns false whenever the gate is inactive or the probe cannot measure --
 * NEVER assumes alive. `runSs` is injectable for tests.
 */
export function isTransportAlive(nowMono, runSs = defaultSsRunner) {
  if (!transportGateActive) return false;
  const cur = readSshBytesReceived(transportPeer, runSs);
  if (cur === null) {
    // Cannot measure -> transport not alive (today's idle behavior applies).
    return false;
  }
  if (transportLastBytes !== null && cur > transportLastBytes) {
    transportLastAdvanceMs = nowMono;
  }
  transportLastBytes = cur;
  return (
    transportLastAdvanceMs !== null &&
    nowMono - transportLastAdvanceMs <= _TRANSPORT_FRESH_WINDOW_MS
  );
}

function pollOnce({ exit = (code) => process.exit(code), log = console.error } = {}) {
  try {
    const ppid = process.ppid;
    const nowMono = performance.now();
    const idleTimeoutSec = idleTimeoutSeconds();

    // Mechanism 3: compute transport-liveness this tick. Inactive gate or any
    // inability to measure yields false (fail-safe: idle timer unmodified).
    const transportAlive = transportGateActive ? isTransportAlive(nowMono) : false;

    if (
      shouldExit({
        ppid,
        startPpid: initialPpid,
        activeRequests,
        lastActivityMono: lastActivityMonoMs,
        nowMono,
        idleTimeoutSec,
        transportAlive,
      })
    ) {
      const parentDied = ppid === 1 && initialPpid !== 1;
      const reason = parentDied
        ? 'parent died (reparented to init, ppid=1)'
        : `idle ${Math.floor((nowMono - lastActivityMonoMs) / 1000)}s exceeded timeout ${idleTimeoutSec}s`;
      log(
        `[watchdog] self-terminating -- ${reason}. Exiting now to free memory and avoid OOM on the shared VM.`,
      );
      exit(0);
      return;
    }

    // Idle kill was SUPPRESSED by the transport gate -- log at most once per
    // TRANSPORT_SUPPRESS_LOG_INTERVAL_MS (no 20s spam).
    if (
      transportGateActive &&
      transportAlive &&
      activeRequests === 0 &&
      (nowMono - lastActivityMonoMs) / 1000 > idleTimeoutSec
    ) {
      if (nowMono - transportLastSuppressLogMs >= TRANSPORT_SUPPRESS_LOG_INTERVAL_MS) {
        const idleS = Math.floor((nowMono - lastActivityMonoMs) / 1000);
        log(
          `[watchdog] idle ${idleS}s > ${idleTimeoutSec}s but ssh transport alive (client keepalives flowing); holding.`,
        );
        transportLastSuppressLogMs = nowMono;
      }
    }
  } catch (err) {
    // Watchdog must never crash the server. Log and keep going.
    try {
      log(`[watchdog] poll iteration raised; continuing: ${err && err.message}`);
    } catch {
      // ignore
    }
  }
}

/**
 * Wire up the watchdog. Idempotent and safe to call once at startup.
 *
 * Honors MCP_DISABLE_WATCHDOG=1 to fully disable (debug escape hatch).
 * Honors MCP_TRANSPORT_LIVENESS=0 to disable only the transport-liveness
 * gate (mechanism 3), reverting to the pre-gate idle-kill behavior.
 */
export function startLifecycleWatchdog({
  intervalMs = POLL_INTERVAL_MS,
  env = process.env,
  log = console.error,
} = {}) {
  if (env.MCP_DISABLE_WATCHDOG === '1') {
    log('[watchdog] disabled via MCP_DISABLE_WATCHDOG=1 (no orphan protection this run)');
    return null;
  }
  if (watchdogTimer) return watchdogTimer;

  initialPpid = process.ppid;
  lastActivityMonoMs = performance.now();
  activeRequests = 0;
  const idleTimeoutSec = idleTimeoutSeconds(env);

  // Mechanism 3: resolve the transport-liveness gate's peer ONCE at startup.
  // Inactive unless the gate is enabled AND SSH_CONNECTION parses -- both
  // fail-safe toward the pre-gate unmodified idle behavior.
  transportPeer = null;
  transportGateActive = false;
  transportLastBytes = null;
  transportLastAdvanceMs = null;
  transportLastSuppressLogMs = 0;
  if (transportLivenessEnabled(env)) {
    transportPeer = sshConnectionPeer(env);
    if (transportPeer !== null) {
      transportGateActive = true;
      log(
        `[watchdog] transport-liveness gate ACTIVE (ssh peer ` +
          `${transportPeer.clientIp}:${transportPeer.clientPort} -> ` +
          `:${transportPeer.serverPort}); the idle kill will be held only ` +
          `while the client keepalives advance this connection's byte counters`,
      );
    } else {
      log(
        '[watchdog] transport-liveness gate inactive (SSH_CONNECTION ' +
          'unset/unparseable); idle timer applies unmodified',
      );
    }
  } else {
    log(
      '[watchdog] transport-liveness gate disabled via ' +
        'MCP_TRANSPORT_LIVENESS=0; idle timer applies unmodified',
    );
  }

  log(
    `[watchdog] armed (poll=${Math.floor(intervalMs / 1000)}s, idle_timeout=${idleTimeoutSec}s, ppid=${process.ppid}, transport_gate=${
      transportGateActive ? 'active' : 'inactive'
    }${initialPpid === 1 ? ', running under init -- parent-death detection disabled' : ''})`,
  );

  watchdogTimer = setInterval(() => pollOnce({ log }), intervalMs);
  // unref so the watchdog timer alone never keeps a healthy process alive
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
  return watchdogTimer;
}

/** Test-only: stop the poll timer and reset all watchdog state. */
export function _stopForTests() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  lastActivityMonoMs = performance.now();
  activeRequests = 0;
  initialPpid = process.ppid;
  transportPeer = null;
  transportGateActive = false;
  transportLastBytes = null;
  transportLastAdvanceMs = null;
  transportLastSuppressLogMs = 0;
}

/**
 * Test-only: force the transport gate's module state so isTransportAlive can be
 * exercised deterministically without startLifecycleWatchdog(). Any field left
 * undefined is unchanged; passing a peer implicitly activates the gate unless
 * `active` is given explicitly.
 */
export function _setTransportStateForTests({
  peer,
  active,
  lastBytes,
  lastAdvanceMs,
} = {}) {
  if (peer !== undefined) transportPeer = peer;
  if (active !== undefined) transportGateActive = active;
  else if (peer !== undefined) transportGateActive = peer !== null;
  if (lastBytes !== undefined) transportLastBytes = lastBytes;
  if (lastAdvanceMs !== undefined) transportLastAdvanceMs = lastAdvanceMs;
}
