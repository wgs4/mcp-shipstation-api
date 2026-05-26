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
// Two fail-safe mechanisms, both best-effort (a broken watchdog must
// never crash or degrade the server):
//   1. Daemon poll loop (~20s): exits if reparented to init
//      (ppid==1, parent-death backstop) or if idle beyond the timeout
//      (catches the lingering-socket case where sshd is still alive
//      but nobody's home).
//   2. last-activity clock bumped at both entry and exit of every MCP
//      request, with an in-flight request counter so the watchdog can
//      NEVER kill mid-flight (would cause duplicate labels / shipments
//      / vouchers on retry).
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

import { performance } from 'node:perf_hooks';

const POLL_INTERVAL_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800; // 30 minutes
const MAX_IDLE_TIMEOUT_SECONDS = 86_400; // 24h hard cap -- defeats accidental "never expire"

let lastActivityMonoMs = performance.now();
let activeRequests = 0;
let watchdogTimer = null;
let initialPpid = process.ppid;

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
 */
export function shouldExit({
  ppid,
  startPpid,
  activeRequests: inFlight,
  lastActivityMono,
  nowMono,
  idleTimeoutSec,
}) {
  const parentDied = ppid === 1 && startPpid !== 1;
  if (parentDied) return true;
  if (inFlight > 0) return false;
  if ((nowMono - lastActivityMono) / 1000 > idleTimeoutSec) return true;
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

function pollOnce({ exit = (code) => process.exit(code), log = console.error } = {}) {
  try {
    const ppid = process.ppid;
    const nowMono = performance.now();
    const idleTimeoutSec = idleTimeoutSeconds();
    if (
      shouldExit({
        ppid,
        startPpid: initialPpid,
        activeRequests,
        lastActivityMono: lastActivityMonoMs,
        nowMono,
        idleTimeoutSec,
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
  log(
    `[watchdog] armed (poll=${Math.floor(intervalMs / 1000)}s, idle_timeout=${idleTimeoutSec}s, ppid=${process.ppid}${
      initialPpid === 1 ? ', running under init -- parent-death detection disabled' : ''
    })`,
  );

  watchdogTimer = setInterval(() => pollOnce({ log }), intervalMs);
  // unref so the watchdog timer alone never keeps a healthy process alive
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
  return watchdogTimer;
}

/** Test-only: stop the poll timer and reset state. */
export function _stopForTests() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  lastActivityMonoMs = performance.now();
  activeRequests = 0;
  initialPpid = process.ppid;
}
