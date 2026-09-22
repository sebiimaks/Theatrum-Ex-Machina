import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPrivateTouchIdCleanupFailure, createPrivateTouchIdProvider, isPrivateTouchIdCleanupFailure,
  type PrivateTouchIdNativeBinding, type PrivateTouchIdNativeResult } from './private-touch-id';

const identity = 'b'.repeat(64);
const secret = (): Buffer => Buffer.alloc(64, 0x83);
const signal = (): AbortSignal => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(result: PrivateTouchIdNativeResult = { status: 'unavailable' }) {
  const calls: { kind: string; identity: string; payload?: Buffer; snapshot?: Buffer }[] = [];
  const cancelled: number[] = [];
  const acknowledged: { operation: number; accepted: boolean }[] = [];
  let response = Promise.resolve(result);
  let finish = (accepted: boolean): Promise<PrivateTouchIdNativeResult> => Promise.resolve({ status: accepted ? 'enrolled' : 'cancelled' });
  let cancel: (operation: number) => void = operation => { cancelled.push(operation); };
  const binding: PrivateTouchIdNativeBinding = {
    begin(kind, account, payload) {
      calls.push({ kind, identity: account, payload, snapshot: payload && Buffer.from(payload) });
      return { operation: 7, result: response };
    },
    cancel(operation) { cancel(operation); },
    finishEnrollment(operation, accepted) { acknowledged.push({ operation, accepted }); return finish(accepted); },
  };
  let loads = 0;
  const provider = createPrivateTouchIdProvider({ platform: 'darwin', loadNative: () => { loads++; return binding; } });
  return { provider, binding, calls, cancelled, acknowledged, get loads() { return loads; },
    response(value: Promise<PrivateTouchIdNativeResult>) { response = value; },
    finish(value: typeof finish) { finish = value; },
    cancel(value: typeof cancel) { cancel = value; },
  };
}

test('cleanup failure has a generic unforgeable brand', () => {
  const error = createPrivateTouchIdCleanupFailure();
  assert.ok(isPrivateTouchIdCleanupFailure(error));
  assert.equal(error.message, 'Touch ID cleanup could not be confirmed.');
  assert.equal(isPrivateTouchIdCleanupFailure(new Error(error.message)), false);
  assert.equal(isPrivateTouchIdCleanupFailure({ message: error.message }), false);
  assert.equal(isPrivateTouchIdCleanupFailure(null), false);
});
test('unsupported platforms do not load native code', async () => {
  const provider = createPrivateTouchIdProvider({ platform: 'linux', loadNative: () => { throw new Error('must not load'); } });
  assert.equal(await provider.availability(), 'unavailable');
  assert.equal(await provider.has(identity), false);
  assert.equal(await provider.enroll(identity, secret(), signal()), 'unavailable');
  assert.equal(await provider.unlock(identity, signal()), undefined);
  assert.equal(await provider.remove(identity, signal()), false);
});
test('missing and malformed addons fail closed and are loaded once', async () => {
  for (const load of [() => undefined, () => ({} as PrivateTouchIdNativeBinding), () => { throw new Error('private absolute path'); }]) {
    let attempts = 0;
    const provider = createPrivateTouchIdProvider({ platform: 'darwin', loadNative: () => { attempts++; return load(); } });
    assert.equal(await provider.availability(), 'unavailable');
    assert.equal(await provider.unlock(identity, signal()), undefined);
    assert.equal(attempts, 1);
  }
});
test('availability accepts only supported native states', async () => {
  assert.equal(await fixture({ status: 'available' }).provider.availability(), 'available');
  assert.equal(await fixture({ status: 'unavailable' }).provider.availability(), 'unavailable');
  assert.equal(await fixture({ status: 'cancelled' }).provider.availability(), 'unavailable');
  await assert.rejects(fixture({ status: 'present' }).provider.availability(), isPrivateTouchIdCleanupFailure);
});
test('has only reports a positive native existence result', async () => {
  for (const status of ['present', 'absent', 'unavailable', 'cancelled'] as const) {
    const f = fixture({ status });
    assert.equal(await f.provider.has(identity), status === 'present');
    assert.deepEqual(f.calls.map(call => [call.kind, call.identity]), [['has', identity]]);
  }
});
test('identity and secret validation happen before native loading', async () => {
  const f = fixture();
  for (const value of ['', 'b'.repeat(63), 'B'.repeat(64), '../hub', 'b'.repeat(65), null, 7]) {
    await assert.rejects(f.provider.has(value as string), /Touch ID is unavailable/);
    await assert.rejects(f.provider.unlock(value as string, signal()), /Touch ID is unavailable/);
    await assert.rejects(f.provider.remove(value as string, signal()), /Touch ID is unavailable/);
    await assert.rejects(f.provider.enroll(value as string, secret(), signal()), /Touch ID is unavailable/);
  }
  for (const value of [Buffer.alloc(0), Buffer.alloc(63), Buffer.alloc(65), new Uint8Array(64), 'password', null]) {
    await assert.rejects(f.provider.enroll(identity, value as Buffer, signal()), /Touch ID is unavailable/);
  }
  for (const value of [null, {}, { aborted: false }]) {
    await assert.rejects(f.provider.unlock(identity, value as AbortSignal), /Touch ID is unavailable/);
  }
  assert.equal(f.loads, 0);
});
test('timeouts are bounded', () => {
  for (const timeoutMs of [0, -1, 300001, NaN, Infinity, 1.2]) {
    assert.throws(() => createPrivateTouchIdProvider({ timeoutMs }), /Touch ID is unavailable/);
  }
});
test('pre-aborted operations never reach native code', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  assert.equal(await f.provider.enroll(identity, secret(), controller.signal), 'cancelled');
  assert.equal(await f.provider.unlock(identity, controller.signal), undefined);
  assert.equal(await f.provider.remove(identity, controller.signal), false);
  assert.equal(f.loads, 0);
});
test('enrollment clones its input and wipes its own copy before awaiting native completion', async () => {
  const f = fixture({ status: 'enrolled' });
  const input = secret();
  assert.equal(await f.provider.enroll(identity, input, signal()), 'enrolled');
  assert.deepEqual(f.calls[0].snapshot, input);
  assert.notEqual(f.calls[0].payload, input);
  assert.deepEqual(f.calls[0].payload, Buffer.alloc(64));
  assert.deepEqual(input, secret());
  assert.deepEqual(f.acknowledged, [{ operation: 7, accepted: true }]);
});
test('successful unlock transfers an independent bounded buffer and wipes the native result', async () => {
  const nativeSecret = secret();
  const f = fixture({ status: 'secret', secret: nativeSecret });
  const value = await f.provider.unlock(identity, signal());
  assert.deepEqual(value, secret());
  assert.notEqual(value, nativeSecret);
  assert.deepEqual(nativeSecret, Buffer.alloc(64));
  value!.fill(0);
});
test('unlock treats missing credentials and cancellation as password fallback', async () => {
  for (const status of ['unavailable', 'missing', 'cancelled'] as const) {
    assert.equal(await fixture({ status }).provider.unlock(identity, signal()), undefined);
  }
});
test('remove accepts confirmed absence without biometric availability', async () => {
  for (const status of ['removed', 'absent', 'cancelled', 'unavailable'] as const) {
    assert.equal(await fixture({ status }).provider.remove(identity, signal()), status === 'removed' || status === 'absent');
  }
});
test('concurrent requests cannot overlap or replace the first reservation', async () => {
  const f = fixture(); const work = deferred<PrivateTouchIdNativeResult>(); f.response(work.promise);
  const first = f.provider.unlock(identity, signal());
  await assert.rejects(f.provider.availability(), /Touch ID is unavailable/);
  await assert.rejects(f.provider.enroll(identity, secret(), signal()), /Touch ID is unavailable/);
  assert.equal(f.calls.length, 1);
  work.resolve({ status: 'missing' });
  assert.equal(await first, undefined);
  f.response(Promise.resolve({ status: 'available' }));
  assert.equal(await f.provider.availability(), 'available');
});
test('abort waits for native completion and discards a late recovered secret', async () => {
  const f = fixture(); const work = deferred<PrivateTouchIdNativeResult>(); f.response(work.promise);
  const controller = new AbortController();
  let completed = false;
  const pending = f.provider.unlock(identity, controller.signal).then(value => { completed = true; return value; });
  controller.abort();
  await Promise.resolve();
  assert.equal(completed, false);
  assert.deepEqual(f.cancelled, [7]);
  await assert.rejects(f.provider.availability(), /Touch ID is unavailable/);
  const nativeSecret = secret(); work.resolve({ status: 'secret', secret: nativeSecret });
  assert.equal(await pending, undefined);
  assert.deepEqual(nativeSecret, Buffer.alloc(64));
});
test('abort while enrollment is pending rejects the provisional enrollment and awaits rollback', async () => {
  const f = fixture(); const work = deferred<PrivateTouchIdNativeResult>(); const rollback = deferred<PrivateTouchIdNativeResult>();
  f.response(work.promise); f.finish(() => rollback.promise);
  const controller = new AbortController();
  let completed = false;
  const pending = f.provider.enroll(identity, secret(), controller.signal).then(value => { completed = true; return value; });
  controller.abort(); work.resolve({ status: 'enrolled' });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.acknowledged, [{ operation: 7, accepted: false }]);
  assert.equal(completed, false);
  rollback.resolve({ status: 'cancelled' });
  assert.equal(await pending, 'cancelled');
});
test('a committed enrollment remains successful when a later lifecycle abort arrives', async () => {
  const f = fixture({ status: 'enrolled' });
  const controller = new AbortController();
  f.finish(accepted => { assert.equal(accepted, true); controller.abort(); return Promise.resolve({ status: 'enrolled' }); });
  assert.equal(await f.provider.enroll(identity, secret(), controller.signal), 'enrolled');
});
test('confirmed removal is not reported as undone by a late abort', async () => {
  const f = fixture(); const work = deferred<PrivateTouchIdNativeResult>(); f.response(work.promise);
  const controller = new AbortController();
  const pending = f.provider.remove(identity, controller.signal);
  controller.abort(); work.resolve({ status: 'removed' });
  assert.equal(await pending, true);
});
test('timeout invalidates native work but retains its reservation until it drains', async () => {
  const work = deferred<PrivateTouchIdNativeResult>(); const cancelSeen = deferred<void>();
  const binding: PrivateTouchIdNativeBinding = {
    begin: () => ({ operation: 5, result: work.promise }),
    cancel: () => cancelSeen.resolve(),
    finishEnrollment: async () => ({ status: 'cancelled' }),
  };
  const provider = createPrivateTouchIdProvider({ platform: 'darwin', loadNative: () => binding, timeoutMs: 2 });
  const pending = provider.unlock(identity, signal());
  await cancelSeen.promise;
  await assert.rejects(provider.availability(), /Touch ID is unavailable/);
  work.resolve({ status: 'missing' });
  assert.equal(await pending, undefined);
});
test('cleanup-failed permanently quarantines the provider', async () => {
  const f = fixture({ status: 'cleanup-failed' });
  await assert.rejects(f.provider.enroll(identity, secret(), signal()), isPrivateTouchIdCleanupFailure);
  f.response(Promise.resolve({ status: 'available' }));
  await assert.rejects(f.provider.availability(), isPrivateTouchIdCleanupFailure);
  await assert.rejects(f.provider.remove(identity, signal()), isPrivateTouchIdCleanupFailure);
  assert.equal(f.calls.length, 1);
});
test('rollback ambiguity is branded and cannot be retried through a fresh operation', async () => {
  const f = fixture({ status: 'enrolled' });
  f.finish(async () => ({ status: 'cleanup-failed' }));
  await assert.rejects(f.provider.enroll(identity, secret(), signal()), isPrivateTouchIdCleanupFailure);
  await assert.rejects(f.provider.has(identity), isPrivateTouchIdCleanupFailure);
});
test('native global quarantine is preserved across new providers', async () => {
  const f = fixture();
  f.binding.begin = () => { throw Object.assign(new Error('internal'), { code: 'PRIVATE_TOUCH_ID_CLEANUP_FAILED' }); };
  await assert.rejects(f.provider.availability(), isPrivateTouchIdCleanupFailure);
});
test('duplicate and other safely completed native failures do not delete or quarantine existing entries', async () => {
  const f = fixture({ status: 'error' });
  await assert.rejects(f.provider.enroll(identity, secret(), signal()), error => {
    assert.equal(isPrivateTouchIdCleanupFailure(error), false);
    assert.equal((error as Error).message, 'Touch ID is unavailable.'); return true;
  });
  assert.deepEqual(f.acknowledged, []);
  assert.deepEqual(f.calls.map(call => call.kind), ['enroll']);
  f.response(Promise.resolve({ status: 'present' }));
  assert.equal(await f.provider.has(identity), true);
});
test('ambiguous mutating native rejections quarantine and redact all error details', async () => {
  for (const kind of ['enroll', 'remove'] as const) {
    const f = fixture();
    const work = deferred<PrivateTouchIdNativeResult>(); f.response(work.promise);
    const pending = kind === 'enroll' ? f.provider.enroll(identity, secret(), signal()) : f.provider.remove(identity, signal());
    work.reject(new Error('sensitive-system-detail'));
    await assert.rejects(pending, error => {
      assert.ok(isPrivateTouchIdCleanupFailure(error));
      assert.equal((error as Error).message.includes('sensitive'), false); return true;
    });
  }
});
test('ordinary native read rejections are redacted without falsely claiming a mutation cleanup failure', async () => {
  const f = fixture(); const work = deferred<PrivateTouchIdNativeResult>(); f.response(work.promise);
  const pending = f.provider.unlock(identity, signal());
  work.reject(new Error('private-path-or-os-error'));
  await assert.rejects(pending, error => {
    assert.equal(isPrivateTouchIdCleanupFailure(error), false);
    assert.equal((error as Error).message, 'Touch ID is unavailable.'); return true;
  });
});
test('native cancellation failure quarantines even after a late success and wipes its result', async () => {
  const f = fixture(); const work = deferred<PrivateTouchIdNativeResult>(); f.response(work.promise);
  f.cancel(() => { throw new Error('native-context-private-detail'); });
  const controller = new AbortController();
  const pending = f.provider.unlock(identity, controller.signal);
  controller.abort();
  const bytes = secret(); work.resolve({ status: 'secret', secret: bytes });
  await assert.rejects(pending, isPrivateTouchIdCleanupFailure);
  assert.deepEqual(bytes, Buffer.alloc(64));
});
test('malformed native handles fail closed without accepting an unbounded request', async () => {
  for (const operation of [0, -1, NaN, Infinity, 1.5]) {
    const f = fixture(); f.binding.begin = () => ({ operation, result: Promise.resolve({ status: 'available' }) });
    await assert.rejects(f.provider.availability(), isPrivateTouchIdCleanupFailure);
  }
});
test('malformed and oversized recovered secrets are wiped and rejected', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(63, 1), Buffer.alloc(65, 1)]) {
    const f = fixture({ status: 'secret', secret: bytes });
    await assert.rejects(f.provider.unlock(identity, signal()), isPrivateTouchIdCleanupFailure);
    assert.deepEqual(bytes, Buffer.alloc(bytes.length));
  }
});
test('unexpected secret-bearing non-unlock results are wiped', async () => {
  for (const status of ['available', 'absent', 'present'] as const) {
    const bytes = secret(); const f = fixture({ status, secret: bytes });
    await assert.rejects(f.provider.availability(), isPrivateTouchIdCleanupFailure);
    assert.deepEqual(bytes, Buffer.alloc(64));
  }
});
test('abort listeners are removed after completion', async () => {
  const f = fixture({ status: 'missing' });
  const controller = new AbortController();
  await f.provider.unlock(identity, controller.signal);
  controller.abort();
  assert.deepEqual(f.cancelled, []);
});

const nativePath = join(__dirname, '..', 'build', 'privacy-tools', 'private-touch-id.node');
test('compiled addon rejects invalid arguments before any host or Keychain operation', { skip: process.platform !== 'darwin' || !existsSync(nativePath) }, () => {
  const native = require(nativePath) as PrivateTouchIdNativeBinding;
  for (const account of ['', 'x'.repeat(64), identity + '0', '../hub', 'a\0' + 'b'.repeat(62)]) {
    assert.throws(() => native.begin('has', account), /Touch ID is unavailable/);
  }
  assert.throws(() => native.begin('enroll', identity, Buffer.alloc(63)), /Touch ID is unavailable/);
  assert.throws(() => native.begin('enroll', identity, Buffer.alloc(65)), /Touch ID is unavailable/);
  assert.throws(() => native.begin('availability', identity), /Touch ID is unavailable/);
  assert.throws(() => native.cancel(NaN), /Touch ID is unavailable/);
  assert.throws(() => native.finishEnrollment(1, true), /Touch ID is unavailable/);
});
test('ordinary Node host is denied before LocalAuthentication or Keychain work', { skip: process.platform !== 'darwin' || !existsSync(nativePath) || !!process.versions.electron }, async () => {
  const native = require(nativePath) as PrivateTouchIdNativeBinding;
  assert.deepEqual(await native.begin('availability', '').result, { status: 'unavailable' });
});
