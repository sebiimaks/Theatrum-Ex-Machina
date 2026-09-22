import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrivateHubIdleLock, type PrivateHubIdleLockOptions } from './private-hub-idle-lock';
import type { PrivateHubAutoLockMinutes } from '../interfaces/private-hub-protection';

function fixture(minutes?: PrivateHubAutoLockMinutes, overrides: Partial<PrivateHubIdleLockOptions> = {}) {
  let time = 0;
  let current = true;
  let locks = 0;
  let sequence = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const cleared: unknown[] = [];
  const controller = new PrivateHubIdleLock({ minutes, isCurrent: () => current, onLock: () => { locks++; },
    now: () => time,
    schedule: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clear: handle => { cleared.push(handle); timers.delete(handle as number); },
    ...overrides });
  return { controller, timers, cleared,
    get locks() { return locks; },
    now: (value: number) => { time = value; },
    owner: (value: boolean) => { current = value; },
    next: () => {
      assert.equal(timers.size, 1);
      return [...timers.values()][0];
    },
    fire: () => {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      timers.delete(id);
      timer.callback();
    },
  };
}

test('default policy locks once at five minutes and no activity can revive the lifetime', () => {
  const f = fixture();
  assert.equal(f.next().delay, 300_000);
  f.now(300_000); f.fire();
  assert.equal(f.locks, 1);
  assert.equal(f.controller.check(), false);
  assert.equal(f.controller.activity(), false);
  assert.equal(f.controller.setMinutes(0), false);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
  assert.equal(f.locks, 1);
});

test('every supported policy uses the expected native timer, while off schedules none', () => {
  for (const minutes of [0, 1, 5, 15, 30] as const) {
    const f = fixture(minutes);
    assert.equal(f.controller.check(), true);
    if (minutes) { assert.equal(f.next().delay, minutes * 60_000); }
    else { assert.equal(f.timers.size, 0); }
    f.controller.dispose();
    assert.equal(f.timers.size, 0);
    assert.equal(f.locks, 0);
  }
});

test('native activity before the deadline moves it and ignores an already queued old timer callback', () => {
  const f = fixture(1);
  const stale = f.next().callback;
  f.now(59_999);
  assert.equal(f.controller.activity(), true);
  assert.equal(f.next().delay, 60_000);
  stale();
  assert.equal(f.locks, 0);
  assert.equal(f.timers.size, 1);
  f.now(119_999); f.fire();
  assert.equal(f.locks, 1);
});

test('late or exact-deadline activity fails closed even before the delayed timer fires', () => {
  for (const elapsed of [60_000, 60_001, 3_600_000]) {
    const f = fixture(1);
    const delayed = f.next().callback;
    f.now(elapsed);
    assert.equal(f.controller.activity(), false);
    assert.equal(f.locks, 1);
    assert.equal(f.timers.size, 0);
    delayed();
    assert.equal(f.locks, 1);
  }
});

test('early timer callbacks reschedule only the remaining elapsed deadline', () => {
  const f = fixture(5);
  f.now(90_000); f.fire();
  assert.equal(f.next().delay, 210_000);
  assert.equal(f.locks, 0);
  f.now(310_000); f.fire();
  assert.equal(f.locks, 1);
});

test('checking main-owned work does not extend inactivity or replace its timer', () => {
  const f = fixture(1);
  const original = f.next();
  f.now(40_000);
  assert.equal(f.controller.check(), true);
  assert.equal(f.next(), original);
  assert.equal(f.cleared.length, 0);
  f.now(60_000);
  assert.equal(f.controller.check(), false);
  assert.equal(f.locks, 1);
});

test('policy extension or disabling cannot bypass an already expired old deadline', () => {
  for (const minutes of [0, 5, 30] as const) {
    const f = fixture(1);
    f.now(60_000);
    assert.equal(f.controller.setMinutes(minutes), false);
    assert.equal(f.locks, 1);
    assert.equal(f.timers.size, 0);
  }
});

test('changing duration preserves elapsed time and shorter policies can lock immediately', () => {
  const longer = fixture(1);
  longer.now(45_000);
  assert.equal(longer.controller.setMinutes(5), true);
  assert.equal(longer.next().delay, 255_000);
  longer.now(300_000);
  assert.equal(longer.controller.check(), false);
  const shorter = fixture(5);
  shorter.now(90_000);
  assert.equal(shorter.controller.setMinutes(1), false);
  assert.equal(shorter.locks, 1);
  const same = fixture(5);
  same.now(90_000);
  assert.equal(same.controller.setMinutes(5), true);
  assert.equal(same.next().delay, 210_000);
  same.controller.dispose();
});

test('off preserves elapsed inactivity until genuine activity occurs', () => {
  const f = fixture(5);
  f.now(40_000);
  assert.equal(f.controller.setMinutes(0), true);
  assert.equal(f.timers.size, 0);
  f.now(90_000);
  assert.equal(f.controller.setMinutes(1), false);
  assert.equal(f.locks, 1);
  const active = fixture(0);
  active.now(3_600_000);
  assert.equal(active.controller.activity(), true);
  active.now(3_620_000);
  assert.equal(active.controller.setMinutes(1), true);
  assert.equal(active.next().delay, 40_000);
  active.controller.dispose();
});

test('false owner authority and explicit disposal permanently retire activity without another lock', () => {
  const dormant = fixture(5, { isCurrent: () => false });
  assert.equal(dormant.controller.check(), false);
  assert.equal(dormant.timers.size, 0);
  assert.equal(dormant.locks, 0);
  const revoked = fixture(5);
  const stale = revoked.next().callback;
  revoked.owner(false);
  assert.equal(revoked.controller.check(), false);
  revoked.owner(true);
  assert.equal(revoked.controller.activity(), false);
  assert.equal(revoked.timers.size, 0);
  stale();
  assert.equal(revoked.locks, 0);
  const disposed = fixture(5);
  const callback = disposed.next().callback;
  disposed.controller.dispose(); disposed.controller.dispose(); callback();
  assert.equal(disposed.timers.size, 0);
  assert.equal(disposed.controller.setMinutes(1), false);
  assert.equal(disposed.locks, 0);
});

test('invalid initial clocks or policy values lock without scheduling', () => {
  for (const now of [NaN, Infinity, -Infinity, -1, '0', undefined]) {
    const f = fixture(5, { now: () => now as number });
    assert.equal(f.locks, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.controller.check(), false);
  }
  for (const minutes of [-1, 2, 1.5, NaN, Infinity, null, '5']) {
    const f = fixture(minutes as PrivateHubAutoLockMinutes);
    assert.equal(f.locks, 1);
    assert.equal(f.timers.size, 0);
  }
});

test('clock regression or failure revokes an active timer instead of extending it', () => {
  const f = fixture(5);
  f.now(50_000);
  assert.equal(f.controller.check(), true);
  f.now(49_999);
  assert.equal(f.controller.activity(), false);
  assert.equal(f.locks, 1);
  assert.equal(f.timers.size, 0);
  for (const invalid of [NaN, Infinity, -1]) {
    const broken = fixture(5);
    broken.now(invalid); broken.fire();
    assert.equal(broken.locks, 1);
    assert.equal(broken.controller.check(), false);
  }
  const thrown = fixture(5, { now: () => { throw new Error('Synthetic clock failure'); } });
  assert.equal(thrown.locks, 1);
});

test('invalid changed policies and thrown owner predicates lock immediately', () => {
  const f = fixture(5);
  assert.equal(f.controller.setMinutes(2 as PrivateHubAutoLockMinutes), false);
  assert.equal(f.locks, 1);
  assert.equal(f.timers.size, 0);
  const owner = fixture(5, { isCurrent: () => { throw new Error('Synthetic authority failure'); } });
  assert.equal(owner.locks, 1);
  assert.equal(owner.timers.size, 0);
});

test('scheduling and clearing faults fail closed, including disposal clearing failure', () => {
  const scheduled = fixture(5, { schedule: () => { throw new Error('Synthetic timer failure'); } });
  assert.equal(scheduled.locks, 1);
  assert.equal(scheduled.controller.check(), false);
  for (const handle of [undefined, null]) {
    const missing = fixture(5, { schedule: () => handle });
    assert.equal(missing.locks, 1);
    assert.equal(missing.controller.check(), false);
  }
  for (const action of ['activity', 'dispose'] as const) {
    const f = fixture(5, { clear: () => { throw new Error('Synthetic timer clearing failure'); } });
    const old = f.next().callback;
    f.controller[action]();
    assert.equal(f.locks, 1);
    assert.equal(f.controller.check(), false);
    old();
    assert.equal(f.locks, 1);
  }
});

test('a synchronous scheduler cannot recurse or revive a deadline and its returned handle is cleared', () => {
  const handle = {};
  const cleared: unknown[] = [];
  const f = fixture(5, { schedule: callback => { callback(); return handle; }, clear: value => { cleared.push(value); } });
  assert.equal(f.locks, 1);
  assert.equal(f.controller.activity(), false);
  assert.deepEqual(cleared, [handle]);
});

test('reentrant timer or authority adapters cannot renew an in-progress lifetime', () => {
  let reenter = false;
  const f = fixture(5, { isCurrent: () => {
    if (reenter) { controller!.activity(); }
    return true;
  } });
  const controller = f.controller;
  reenter = true;
  assert.equal(controller.check(), false);
  assert.equal(f.locks, 1);
  let recurse = false;
  const g = fixture(5, { schedule: () => {
    if (recurse) { scheduled!.check(); }
    return 1;
  }, clear: () => undefined });
  const scheduled = g.controller; recurse = true;
  assert.equal(scheduled.activity(), false);
  assert.equal(g.locks, 1);
});

test('lock observers run once after retirement, even if they reenter or throw', () => {
  let calls = 0;
  const f = fixture(1, { onLock: () => {
    calls++;
    assert.equal(controller!.check(), false);
    assert.equal(controller!.activity(), false);
    controller!.dispose();
    throw new Error('Synthetic observer failure');
  } });
  const controller = f.controller;
  f.now(60_000);
  assert.doesNotThrow(() => f.fire());
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
  controller.dispose();
  assert.equal(calls, 1);
});
