import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { PrivateConversionState } from '../interfaces/private-conversion';

interface TestBridge {
  getState(...args: unknown[]): Promise<PrivateConversionState | undefined>;
  submit(...args: unknown[]): Promise<boolean>;
  cancel(...args: unknown[]): void;
}

const source = fs.readFileSync(path.resolve(__dirname, '../private-conversion-preload.cjs'), 'utf8');
const cleanState = () => ({ phase: 'review', completed: 0, total: 0,
  review: { videos: 2, availablePreviews: 4, previewBytes: 1234,
    missingPreviews: { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 } } });
function fixture(...results: unknown[]) {
  const result = results.length ? results[0] : true;
  const exposed: Record<string, unknown> = {}; const invoked: unknown[][] = []; const sent: unknown[][] = []; const imports: string[] = [];
  const control = { result };
  runInNewContext(source, { require: (name: string) => {
    imports.push(name); if (name !== 'electron') { throw new Error('Forbidden module'); }
    return { contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { exposed[key] = value; } },
      ipcRenderer: { invoke: async (...args: unknown[]) => {
        invoked.push(args); if (control.result instanceof Error) { throw control.result; } return control.result;
      }, send: (...args: unknown[]) => { sent.push(args); if (control.result instanceof Error) { throw control.result; } } } };
  } });
  return { exposed, invoked, sent, imports, control, bridge: exposed.privateConversion as TestBridge };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('failure state exposes only whitelisted categories and never diagnostic strings', async () => {
  for (const failure of ['destination-unavailable', 'destination-exists', 'permission-denied', 'storage-full',
    'files-unavailable', 'source-inspection-failed', 'source-changed', 'storage-initialization-failed',
    'catalogue-encryption-failed', 'preview-copy-failed', 'verification-failed', 'receipt-failed', 'conversion-failed']) {
    const input = { ...cleanState(), phase: 'failed', failure, message: 'SECRET /PRIVATE/PATH', cause: { password: 'SECRET' } };
    const f = fixture(input);
    const result = await f.bridge.getState();
    assert.deepEqual(plain(result), { ...cleanState(), phase: 'failed', failure });
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|message|cause/);
  }
  for (const failure of ['SECRET /PRIVATE/PATH', 'ENOSPC', '__proto__', {}, null, 1]) {
    assert.equal(await fixture({ ...cleanState(), phase: 'failed', failure }).bridge.getState(), undefined);
  }
  assert.equal(await fixture({ ...cleanState(), failure: 'storage-full' }).bridge.getState(), undefined);
});

test('standalone bridge exposes only three frozen methods and imports only Electron', () => {
  const f = fixture(); assert.deepEqual(f.imports, ['electron']);
  assert.deepEqual(Object.keys(f.exposed), ['privateConversion']);
  assert.deepEqual(Object.keys(f.bridge).sort(), ['cancel', 'getState', 'submit']); assert.ok(Object.isFrozen(f.bridge));
  for (const name of ['on', 'ipc', 'send', 'invoke', 'files', 'clipboard', 'platform', 'process']) { assert.equal((f.bridge as unknown as Record<string, unknown>)[name], undefined); }
});

test('count-only state is deep frozen and stripped of paths, password, proof and event fields', async () => {
  const input = Object.assign(cleanState(), { password: 'secret', sender: { path: '/synthetic/private' } });
  Object.assign(input.review, { path: '/synthetic/private', proof: {} });
  Object.assign(input.review.missingPreviews, { hash: 'private-hash' });
  const f = fixture(input); const result = (await f.bridge.getState())!;
  assert.deepEqual(plain(result), cleanState());
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.review)); assert.ok(Object.isFrozen(result.review.missingPreviews));
  input.review.videos = 99; assert.equal(result.review.videos, 2);
  assert.deepEqual(f.invoked, [['private-conversion-state']]);
  assert.doesNotMatch(JSON.stringify(result), /secret|synthetic|private-hash|sender/);
});

test('every declared phase and valid zero or large counts survive validation', async () => {
  for (const phase of ['review', 'selecting', 'scanning', 'copying', 'verifying', 'complete', 'failed']) {
    const input = { ...cleanState(), phase, completed: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER };
    assert.deepEqual(plain(await fixture(input).bridge.getState()), input);
  }
});

test('malformed state and native exceptions expose no object or diagnostic', async () => {
  for (const result of [null, undefined, false, 'private', new Error('/private diagnostic'), {},
    { ...cleanState(), phase: 'secret' }, { ...cleanState(), completed: -1 }, { ...cleanState(), total: 0.5 },
    { ...cleanState(), completed: 1, total: 0 }, { ...cleanState(), total: Infinity },
    { ...cleanState(), review: { ...cleanState().review, videos: Number.MAX_SAFE_INTEGER + 1 } },
    { ...cleanState(), review: { ...cleanState().review, previewBytes: '1234' } },
    { ...cleanState(), review: { ...cleanState().review, missingPreviews: { thumbnail: 0, filmstrip: 0, clip: 0 } } },
    { ...cleanState(), review: { ...cleanState().review, missingPreviews: { ...cleanState().review.missingPreviews, clip: NaN } } },
    { get phase() { throw new Error('Private getter'); } }]) {
    assert.equal(await fixture(result).bridge.getState(), undefined);
  }
});

test('getState rejects arguments before IPC', async () => {
  const f = fixture(cleanState()); assert.equal(await f.bridge.getState('extra'), undefined); assert.deepEqual(f.invoked, []);
});

test('submit forwards only unchanged password and primitive explicit consents', async () => {
  const f = fixture(); const password = '  private 🦉 e\u0301\t';
  assert.equal(await f.bridge.submit(password, true, true), true);
  assert.deepEqual(f.invoked, [['private-conversion-submit', password, true, true]]);
  assert.equal(await f.bridge.submit('again', false, true), false); f.bridge.cancel(); assert.deepEqual(f.sent, []);
});

test('malformed passwords and consents never enter IPC or consume a valid submit', async () => {
  const f = fixture();
  for (const args of [[], [null, false, true], [7, false, true], [{ password: 'pw' }, false, true],
    [new String('pw'), false, true], ['', false, true], ['\ud800', false, true], ['\udc00', false, true],
    ['x\ud800x', false, true], ['x'.repeat(1025), false, true], ['é'.repeat(513), false, true], ['😀'.repeat(257), false, true],
    ['pw'], ['pw', false], ['pw', false, false], ['pw', false, 1], ['pw', 'true', true], ['pw', false, true, 'extra']]) {
    assert.equal(await f.bridge.submit(...args), false);
  }
  assert.deepEqual(f.invoked, []);
  assert.equal(await f.bridge.submit('😀'.repeat(256), false, true), true); assert.equal(f.invoked.length, 1);
});

test('whitespace password remains unchanged', async () => {
  const f = fixture(); assert.equal(await f.bridge.submit(' \t\n', false, true), true);
  assert.deepEqual(f.invoked, [['private-conversion-submit', ' \t\n', false, true]]);
});

test('submit returns strict boolean and hides native diagnostics without enabling retry', async () => {
  for (const result of [false, null, undefined, 'true', { sender: { path: '/private' } }, new Error('Private diagnostic')]) {
    const f = fixture(result); assert.equal(await f.bridge.submit('pw', false, true), false);
    assert.equal(await f.bridge.submit('again', false, true), false); assert.equal(f.invoked.length, 1);
    f.bridge.cancel(); assert.deepEqual(f.sent, [['private-conversion-cancel']]);
  }
});

test('concurrent submissions invoke once', async () => {
  const work = deferred<boolean>(); const f = fixture(work.promise);
  const first = f.bridge.submit('first', false, true); assert.equal(await f.bridge.submit('second', true, true), false);
  work.resolve(true); assert.equal(await first, true); assert.equal(f.invoked.length, 1);
});

test('cancel while submit is pending sends once and suppresses a late success', async () => {
  const work = deferred<boolean>(); const f = fixture(work.promise); const pending = f.bridge.submit('pw', false, true);
  f.bridge.cancel('extra'); assert.deepEqual(f.sent, []);
  f.bridge.cancel(); f.bridge.cancel(); assert.deepEqual(f.sent, [['private-conversion-cancel']]);
  work.resolve(true); assert.equal(await pending, false);
  assert.equal(await f.bridge.getState(), undefined); assert.equal(await f.bridge.submit('again', false, true), false);
  assert.equal(f.invoked.length, 1);
});

test('cancel before submit blocks work and later state requests', async () => {
  const f = fixture(); f.bridge.cancel();
  assert.equal(await f.bridge.submit('pw', false, true), false); assert.equal(await f.bridge.getState(), undefined);
  assert.deepEqual(f.invoked, []); assert.deepEqual(f.sent, [['private-conversion-cancel']]);
});

test('a pending state reply cannot revive a cancelled form', async () => {
  const work = deferred<unknown>(); const f = fixture(work.promise); const pending = f.bridge.getState();
  f.bridge.cancel(); work.resolve(cleanState()); assert.equal(await pending, undefined);
});

test('progress remains queryable while submit is pending and failure remains queryable afterward', async () => {
  const work = deferred<boolean>(); const f = fixture(work.promise); const pending = f.bridge.submit('pw', false, true);
  f.control.result = { ...cleanState(), phase: 'copying', completed: 1, total: 4 };
  assert.equal((await f.bridge.getState())!.phase, 'copying'); work.resolve(false); assert.equal(await pending, false);
  f.control.result = { ...cleanState(), phase: 'failed' }; assert.equal((await f.bridge.getState())!.phase, 'failed');
});

test('cancellation send exceptions are swallowed without exposing diagnostics', () => {
  const f = fixture(new Error('/private diagnostic')); assert.doesNotThrow(() => f.bridge.cancel()); assert.equal(f.sent.length, 1);
});
