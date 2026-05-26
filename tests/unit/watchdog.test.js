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
