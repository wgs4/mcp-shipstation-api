// Regression tests for the in-server lifecycle watchdog.
//
// Root cause being guarded: orphaned per-session MCP children that never
// get stdin EOF / SIGHUP run forever and OOM the shared prod VM. The
// watchdog must self-terminate when (a) reparented to init -- and we
// did not START under init -- or (b) idle beyond the configured timeout
// AND no request is in flight.
//
// These tests exercise ONLY the pure decision/config helpers -- no fork,
// no real process.exit, no live network. They must FAIL if the watchdog
// is absent and PASS once it is wired in.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  shouldExit,
  idleTimeoutSeconds,
  wrapWithActivityBump,
  bumpActivity,
  _getLastActivityMonoMs,
  _getActiveRequests,
  startLifecycleWatchdog,
  _stopForTests,
  transportLivenessEnabled,
  sshConnectionPeer,
  normalizeSsIp,
  parseSsBytesReceived,
  readSshBytesReceived,
  isTransportAlive,
  _setTransportStateForTests,
  _TRANSPORT_FRESH_WINDOW_MS,
} from '../../src/watchdog.js';

describe('lifecycle watchdog -- decision function', () => {
  test('exits when reparented to init AND we did not start as PID 1', () => {
    assert.strictEqual(
      shouldExit({
        ppid: 1,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 1_000_000,
        nowMono: 1_000_000,
        idleTimeoutSec: 1800,
      }),
      true,
    );
  });

  test('parent-death exit ignores in-flight count (no one to respond to anyway)', () => {
    assert.strictEqual(
      shouldExit({
        ppid: 1,
        startPpid: 4242,
        activeRequests: 5,
        lastActivityMono: 1_000_000,
        nowMono: 1_000_000,
        idleTimeoutSec: 1800,
      }),
      true,
    );
  });

  test('does NOT parent-death-exit when started under init (systemd / launchd / docker)', () => {
    // ppid==1 is normal here; without the startPpid guard the watchdog
    // would self-kill the moment it armed. Idle exit still applies for
    // these deployments -- only the parent-death backstop is suppressed.
    assert.strictEqual(
      shouldExit({
        ppid: 1,
        startPpid: 1,
        activeRequests: 0,
        lastActivityMono: 1_000_000,
        nowMono: 1_000_500, // recent activity, well under idle window
        idleTimeoutSec: 1800,
      }),
      false,
    );
  });

  test('still idle-exits under init when timeout exceeded (idle path stays active)', () => {
    assert.strictEqual(
      shouldExit({
        ppid: 1,
        startPpid: 1,
        activeRequests: 0,
        lastActivityMono: 0,
        nowMono: 1_800_001,
        idleTimeoutSec: 1800,
      }),
      true,
    );
  });

  test('exits when idle exceeded and no requests in flight', () => {
    assert.strictEqual(
      shouldExit({
        ppid: 4242,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 0,
        nowMono: 1_801_000,
        idleTimeoutSec: 1800,
      }),
      true,
    );
  });

  test('does NOT idle-exit while a request is in flight (prevents duplicate labels)', () => {
    // The critical safety: ShipStation tools like create_label /
    // create_shipment side-effect remotely. Killing mid-flight after
    // the HTTP call returned 200 but before we ship the response would
    // make the client retry and duplicate the shipment.
    assert.strictEqual(
      shouldExit({
        ppid: 4242,
        startPpid: 4242,
        activeRequests: 1,
        lastActivityMono: 0,
        nowMono: 9_999_999_999,
        idleTimeoutSec: 1800,
      }),
      false,
    );
  });

  test('does NOT exit when alive and recent', () => {
    assert.strictEqual(
      shouldExit({
        ppid: 4242,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 1_000_000,
        nowMono: 1_000_500,
        idleTimeoutSec: 1800,
      }),
      false,
    );
  });

  test('idle boundary is strict greater-than (exactly at timeout is not over)', () => {
    assert.strictEqual(
      shouldExit({
        ppid: 4242,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 0,
        nowMono: 1_800_000,
        idleTimeoutSec: 1800,
      }),
      false,
    );
    assert.strictEqual(
      shouldExit({
        ppid: 4242,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 0,
        nowMono: 1_800_001,
        idleTimeoutSec: 1800,
      }),
      true,
    );
  });

  test('transportAlive defaults to false when omitted (pre-mechanism-3 behavior)', () => {
    // Every existing caller omits transportAlive; the idle kill must fire.
    assert.strictEqual(
      shouldExit({
        ppid: 4242,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 0,
        nowMono: 1_801_000,
        idleTimeoutSec: 1800,
      }),
      true,
    );
  });

  test('idle-exits when idle exceeded AND transport NOT alive', () => {
    assert.strictEqual(
      shouldExit({
        ppid: 4242,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 0,
        nowMono: 1_801_000,
        idleTimeoutSec: 1800,
        transportAlive: false,
      }),
      true,
    );
  });

  test('does NOT idle-exit when idle exceeded but transport IS alive (live-session hold)', () => {
    // Open Claude session, user idle 30+ min, but ssh keepalives still
    // advancing the socket counters -> hold, do not kill.
    assert.strictEqual(
      shouldExit({
        ppid: 4242,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 0,
        nowMono: 9_999_999_999,
        idleTimeoutSec: 1800,
        transportAlive: true,
      }),
      false,
    );
  });

  test('parent-death still kills even when transport is alive (orphan protection never weakened)', () => {
    assert.strictEqual(
      shouldExit({
        ppid: 1,
        startPpid: 4242,
        activeRequests: 0,
        lastActivityMono: 1_000_000,
        nowMono: 1_000_000,
        idleTimeoutSec: 1800,
        transportAlive: true,
      }),
      true,
    );
  });

  test('in-flight request still blocks idle exit regardless of transportAlive', () => {
    for (const transportAlive of [true, false]) {
      assert.strictEqual(
        shouldExit({
          ppid: 4242,
          startPpid: 4242,
          activeRequests: 1,
          lastActivityMono: 0,
          nowMono: 9_999_999_999,
          idleTimeoutSec: 1800,
          transportAlive,
        }),
        false,
      );
    }
  });
});

describe('lifecycle watchdog -- idle timeout config', () => {
  test('defaults to 1800s when env var unset', () => {
    assert.strictEqual(idleTimeoutSeconds({}), 1800);
  });

  test('honors valid positive int override', () => {
    assert.strictEqual(idleTimeoutSeconds({ MCP_IDLE_TIMEOUT_SECONDS: '60' }), 60);
  });

  test('clamps absurdly large values to MAX (86400s = 24h)', () => {
    // A hostile or fat-fingered env var must not effectively disable
    // the watchdog. 999999999999 would have made the VM die before
    // the timeout ever fired.
    assert.strictEqual(
      idleTimeoutSeconds({ MCP_IDLE_TIMEOUT_SECONDS: '999999999999' }),
      86_400,
    );
  });

  test('accepts values right at the MAX cap', () => {
    assert.strictEqual(
      idleTimeoutSeconds({ MCP_IDLE_TIMEOUT_SECONDS: '86400' }),
      86_400,
    );
  });

  for (const bad of ['', '   ', 'abc', '-5', '0', '12.5', 'NaN']) {
    test(`falls back to default on bad value: ${JSON.stringify(bad)}`, () => {
      assert.strictEqual(
        idleTimeoutSeconds({ MCP_IDLE_TIMEOUT_SECONDS: bad }),
        1800,
      );
    });
  }
});

describe('lifecycle watchdog -- activity bump and in-flight tracking', () => {
  test('wrapWithActivityBump bumps clock and tracks in-flight count', async () => {
    const beforeClock = _getLastActivityMonoMs();
    const beforeActive = _getActiveRequests();
    let inFlightDuringCall = -1;
    const wrapped = wrapWithActivityBump(async (req) => {
      // While inside the handler, the counter must reflect us.
      inFlightDuringCall = _getActiveRequests();
      return { id: req.id };
    });
    await new Promise((r) => setTimeout(r, 5));
    const result = await wrapped({ id: 42 });
    assert.deepStrictEqual(result, { id: 42 });
    assert.strictEqual(inFlightDuringCall, beforeActive + 1);
    assert.strictEqual(_getActiveRequests(), beforeActive);
    assert.ok(_getLastActivityMonoMs() > beforeClock);
  });

  test('wrapWithActivityBump decrements in-flight even when handler throws', async () => {
    const before = _getActiveRequests();
    const wrapped = wrapWithActivityBump(async () => {
      throw new Error('boom');
    });
    await assert.rejects(() => wrapped({}), /boom/);
    assert.strictEqual(_getActiveRequests(), before);
  });

  test('bumpActivity advances the monotonic clock', async () => {
    const a = _getLastActivityMonoMs();
    await new Promise((r) => setTimeout(r, 5));
    bumpActivity();
    assert.ok(_getLastActivityMonoMs() > a);
  });
});

describe('lifecycle watchdog -- startup', () => {
  test('MCP_DISABLE_WATCHDOG=1 fully disables (returns null)', () => {
    const logs = [];
    const timer = startLifecycleWatchdog({
      env: { MCP_DISABLE_WATCHDOG: '1' },
      log: (m) => logs.push(m),
    });
    assert.strictEqual(timer, null);
    assert.ok(logs.some((l) => l.includes('disabled')));
  });

  test('starts a timer and logs arming info when enabled', () => {
    const logs = [];
    const timer = startLifecycleWatchdog({
      env: {},
      intervalMs: 1000,
      log: (m) => logs.push(m),
    });
    assert.ok(timer, 'should return a timer handle');
    assert.ok(logs.some((l) => l.includes('armed')));
    _stopForTests();
  });
});

// ---------------------------------------------------------------------------
// Mechanism 3: transport-liveness gate
// ---------------------------------------------------------------------------

// Build a realistic `ss -tin` block for one ESTAB connection.
function ssBlock({
  state = 'ESTAB',
  local = '192.168.1.193:23500',
  peer = '192.168.1.230:51314',
  bytesReceived = 1000,
  header = true,
} = {}) {
  const lines = [];
  if (header) {
    lines.push('State  Recv-Q Send-Q   Local Address:Port    Peer Address:Port  Process');
  }
  lines.push(`${state}  0      0        ${local}    ${peer}`);
  lines.push(
    `\t cubic wscale:7,7 rto:204 rtt:0.05/0.02 bytes_sent:500 bytes_received:${bytesReceived} segs_out:9`,
  );
  return lines.join('\n') + '\n';
}

describe('lifecycle watchdog -- transportLivenessEnabled', () => {
  test('enabled by default (env var unset)', () => {
    assert.strictEqual(transportLivenessEnabled({}), true);
  });
  test('disabled only for exact "0"', () => {
    assert.strictEqual(transportLivenessEnabled({ MCP_TRANSPORT_LIVENESS: '0' }), false);
    assert.strictEqual(transportLivenessEnabled({ MCP_TRANSPORT_LIVENESS: '1' }), true);
    assert.strictEqual(transportLivenessEnabled({ MCP_TRANSPORT_LIVENESS: 'false' }), true);
  });
});

describe('lifecycle watchdog -- SSH_CONNECTION parsing', () => {
  test('parses a valid SSH_CONNECTION', () => {
    assert.deepStrictEqual(
      sshConnectionPeer({ SSH_CONNECTION: '192.168.1.230 51314 192.168.1.193 23500' }),
      { clientIp: '192.168.1.230', clientPort: '51314', serverPort: '23500' },
    );
  });
  test('returns null when SSH_CONNECTION is absent (local dev / macOS)', () => {
    assert.strictEqual(sshConnectionPeer({}), null);
  });
  test('returns null on wrong field count', () => {
    assert.strictEqual(sshConnectionPeer({ SSH_CONNECTION: '192.168.1.230 51314 192.168.1.193' }), null);
  });
  test('returns null on non-integer ports (garbage)', () => {
    assert.strictEqual(
      sshConnectionPeer({ SSH_CONNECTION: '192.168.1.230 abc 192.168.1.193 23500' }),
      null,
    );
    assert.strictEqual(
      sshConnectionPeer({ SSH_CONNECTION: 'garbage-with-no-structure' }),
      null,
    );
  });
  test('parses an IPv6 client', () => {
    assert.deepStrictEqual(
      sshConnectionPeer({ SSH_CONNECTION: '2001:db8::1 51314 2001:db8::2 23500' }),
      { clientIp: '2001:db8::1', clientPort: '51314', serverPort: '23500' },
    );
  });
});

describe('lifecycle watchdog -- normalizeSsIp', () => {
  test('strips IPv6 brackets', () => {
    assert.strictEqual(normalizeSsIp('[2001:db8::1]'), '2001:db8::1');
  });
  test('strips ::ffff: v4-mapped-v6 prefix', () => {
    assert.strictEqual(normalizeSsIp('::ffff:192.168.1.230'), '192.168.1.230');
  });
  test('strips both bracket and v4-mapped prefix', () => {
    assert.strictEqual(normalizeSsIp('[::ffff:192.168.1.230]'), '192.168.1.230');
  });
  test('passes a plain v4 through unchanged', () => {
    assert.strictEqual(normalizeSsIp('192.168.1.230'), '192.168.1.230');
  });
});

describe('lifecycle watchdog -- parseSsBytesReceived', () => {
  const IP = '192.168.1.230';
  const CPORT = '51314';
  const SPORT = '23500';

  test('reads bytes_received for the matching ESTAB connection', () => {
    const out = ssBlock({ bytesReceived: 4242 });
    assert.strictEqual(parseSsBytesReceived(out, IP, CPORT, SPORT), 4242);
  });

  test('returns null on empty / garbage input', () => {
    assert.strictEqual(parseSsBytesReceived('', IP, CPORT, SPORT), null);
    assert.strictEqual(parseSsBytesReceived('not remotely ss output', IP, CPORT, SPORT), null);
  });

  test('returns null when the peer 4-tuple is absent (wrong port)', () => {
    const out = ssBlock({ bytesReceived: 4242 });
    assert.strictEqual(parseSsBytesReceived(out, IP, '99999', SPORT), null);
  });

  test('ignores a non-ESTAB connection with the matching tuple', () => {
    const out = ssBlock({ state: 'TIME-WAIT', bytesReceived: 4242 });
    assert.strictEqual(parseSsBytesReceived(out, IP, CPORT, SPORT), null);
  });

  test('selects the correct peer among several connections', () => {
    const other = ssBlock({
      peer: '10.0.0.9:40000',
      bytesReceived: 111,
      header: true,
    });
    const wanted = ssBlock({ bytesReceived: 999, header: false });
    const out = other + wanted;
    assert.strictEqual(parseSsBytesReceived(out, IP, CPORT, SPORT), 999);
    // and the other peer resolves to its own counter
    assert.strictEqual(parseSsBytesReceived(out, '10.0.0.9', '40000', SPORT), 111);
  });

  test('tolerates a v4-mapped-v6 peer rendering', () => {
    const out = ssBlock({
      local: '[::ffff:192.168.1.193]:23500',
      peer: '[::ffff:192.168.1.230]:51314',
      bytesReceived: 7777,
    });
    assert.strictEqual(parseSsBytesReceived(out, IP, CPORT, SPORT), 7777);
  });

  test('returns null when header matches but no bytes_received counter present', () => {
    const out =
      'ESTAB  0  0  192.168.1.193:23500  192.168.1.230:51314\n\t cubic rto:204 (no counter here)\n';
    assert.strictEqual(parseSsBytesReceived(out, IP, CPORT, SPORT), null);
  });

  test('returns null on non-integer requested ports', () => {
    const out = ssBlock({ bytesReceived: 4242 });
    assert.strictEqual(parseSsBytesReceived(out, IP, 'abc', SPORT), null);
  });
});

describe('lifecycle watchdog -- readSshBytesReceived (injectable runner)', () => {
  const peer = { clientIp: '192.168.1.230', clientPort: '51314', serverPort: '23500' };

  test('returns the parsed counter from a canned runner', () => {
    const runSs = () => ssBlock({ bytesReceived: 5150 });
    assert.strictEqual(readSshBytesReceived(peer, runSs), 5150);
  });

  test('returns null when peer is null', () => {
    assert.strictEqual(readSshBytesReceived(null, () => ssBlock()), null);
  });

  test('returns null when the runner throws (ss missing / nonzero exit / timeout)', () => {
    const runSs = () => {
      throw new Error('spawn /usr/bin/ss ENOENT');
    };
    assert.strictEqual(readSshBytesReceived(peer, runSs), null);
  });

  test('returns null when the runner output does not contain our peer', () => {
    const runSs = () => ssBlock({ peer: '10.9.9.9:12345' });
    assert.strictEqual(readSshBytesReceived(peer, runSs), null);
  });
});

describe('lifecycle watchdog -- isTransportAlive (stateful)', () => {
  const peer = { clientIp: '192.168.1.230', clientPort: '51314', serverPort: '23500' };

  test('gate inactive -> always false, never probes', () => {
    _stopForTests();
    _setTransportStateForTests({ peer: null, active: false });
    let probed = false;
    const runSs = () => {
      probed = true;
      return ssBlock();
    };
    assert.strictEqual(isTransportAlive(1_000, runSs), false);
    assert.strictEqual(probed, false, 'must not probe when the gate is inactive');
  });

  test('single reading is NOT enough -- alive only after a proven advance', () => {
    _stopForTests();
    _setTransportStateForTests({ peer, active: true });
    // First probe: establishes a baseline, no advance seen yet -> not alive.
    assert.strictEqual(
      isTransportAlive(1_000, () => ssBlock({ bytesReceived: 100 })),
      false,
    );
    // Second probe with a higher counter -> proven advance -> alive.
    assert.strictEqual(
      isTransportAlive(2_000, () => ssBlock({ bytesReceived: 200 })),
      true,
    );
  });

  test('frozen counter -> stays not alive (lingering orphan)', () => {
    _stopForTests();
    _setTransportStateForTests({ peer, active: true });
    const frozen = () => ssBlock({ bytesReceived: 500 });
    assert.strictEqual(isTransportAlive(1_000, frozen), false);
    assert.strictEqual(isTransportAlive(2_000, frozen), false);
    assert.strictEqual(isTransportAlive(3_000, frozen), false);
  });

  test('advance goes stale after the fresh window elapses', () => {
    _stopForTests();
    _setTransportStateForTests({ peer, active: true });
    assert.strictEqual(isTransportAlive(1_000, () => ssBlock({ bytesReceived: 10 })), false);
    // proven advance at t=2_000
    assert.strictEqual(isTransportAlive(2_000, () => ssBlock({ bytesReceived: 20 })), true);
    // still within window (counter frozen but last advance recent)
    assert.strictEqual(
      isTransportAlive(2_000 + _TRANSPORT_FRESH_WINDOW_MS, () => ssBlock({ bytesReceived: 20 })),
      true,
    );
    // one ms past the window with no new advance -> not alive
    assert.strictEqual(
      isTransportAlive(2_001 + _TRANSPORT_FRESH_WINDOW_MS, () => ssBlock({ bytesReceived: 20 })),
      false,
    );
  });

  test('cannot-measure (runner throws) -> not alive even after a prior advance', () => {
    _stopForTests();
    _setTransportStateForTests({ peer, active: true });
    assert.strictEqual(isTransportAlive(1_000, () => ssBlock({ bytesReceived: 10 })), false);
    assert.strictEqual(isTransportAlive(2_000, () => ssBlock({ bytesReceived: 20 })), true);
    assert.strictEqual(
      isTransportAlive(2_500, () => {
        throw new Error('ss vanished');
      }),
      false,
    );
  });

  test('non-ESTAB / peer-not-found output -> not alive', () => {
    _stopForTests();
    _setTransportStateForTests({ peer, active: true });
    assert.strictEqual(
      isTransportAlive(1_000, () => ssBlock({ state: 'CLOSE-WAIT', bytesReceived: 10 })),
      false,
    );
  });
});

describe('lifecycle watchdog -- startup gate resolution', () => {
  test('MCP_TRANSPORT_LIVENESS=0 disables the gate at startup (logs disabled)', () => {
    _stopForTests();
    const logs = [];
    const timer = startLifecycleWatchdog({
      env: { MCP_TRANSPORT_LIVENESS: '0', SSH_CONNECTION: '192.168.1.230 51314 192.168.1.193 23500' },
      intervalMs: 1000,
      log: (m) => logs.push(m),
    });
    assert.ok(timer);
    assert.ok(logs.some((l) => l.includes('transport-liveness gate disabled')));
    assert.ok(logs.some((l) => l.includes('transport_gate=inactive')));
    _stopForTests();
  });

  test('SSH_CONNECTION present + gate enabled -> gate ACTIVE at startup', () => {
    _stopForTests();
    const logs = [];
    const timer = startLifecycleWatchdog({
      env: { SSH_CONNECTION: '192.168.1.230 51314 192.168.1.193 23500' },
      intervalMs: 1000,
      log: (m) => logs.push(m),
    });
    assert.ok(timer);
    assert.ok(logs.some((l) => l.includes('transport-liveness gate ACTIVE')));
    assert.ok(logs.some((l) => l.includes('transport_gate=active')));
    _stopForTests();
  });

  test('SSH_CONNECTION unset -> gate inactive at startup (local dev)', () => {
    _stopForTests();
    const logs = [];
    const timer = startLifecycleWatchdog({
      env: {},
      intervalMs: 1000,
      log: (m) => logs.push(m),
    });
    assert.ok(timer);
    assert.ok(logs.some((l) => l.includes('gate inactive (SSH_CONNECTION')));
    assert.ok(logs.some((l) => l.includes('transport_gate=inactive')));
    _stopForTests();
  });
});
