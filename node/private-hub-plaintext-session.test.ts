import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { snapshotPrivateHubPlaintextCopyRequest } from '../interfaces/private-hub-credentials';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { privateVideoRevision } from './private-hub-metadata';
import * as exporter from './private-hub-plaintext-export';

const password = 'Synthetic copy password';
const current = () => true;
const request = () => ({ password, acknowledge: true });
const generic = { message: 'The private hub session is unavailable.' };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const base = path.resolve(__dirname, '../tmp'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'plaintext-session-'));
  const directory = path.join(root, 'encrypted');
  const created = await PrivateHubStore.create(directory, password);
  const catalogue: FinalObject = { hubName: 'Synthetic copy hub', version: 3, addTags: [], removeTags: [], numOfFolders: 1,
    images: [{ ...NewImageElement(), hash: 'synthetic', fileName: 'synthetic.mp4', screens: 3, notes: 'Retained notes' }],
    inputDirs: { 0: { path: path.join(root, 'unused-source'), watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 } };
  await writePrivateHubCatalogue(created, catalogue);
  const marker = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: created.hubId }));
  try { await created.writeNewRecord('session:activation', marker); } finally { marker.fill(0); await created.lock(); }
  const open = PrivateHubStore.open.bind(PrivateHubStore); let store!: PrivateHubStore;
  t.mock.method(PrivateHubStore, 'open', async (...args: Parameters<typeof open>) => { store = await open(...args); return store; });
  const session = new PrivateHubSession(); const { generation } = await session.unlock(directory, password);
  t.after(async () => { await session.close().catch(() => undefined); await fs.rm(root, { recursive: true, force: true }); });
  const controller = new AbortController(); const destination = path.join(root, 'copy');
  const options = { chooseDestination: async () => destination, signal: controller.signal };
  return { root, directory, session, generation, catalogue, store, controller, destination, options };
}

test('copy credentials require exact explicit acknowledgement without reading getters', () => {
  let reads = 0;
  const invalid = [null, [], {}, { password }, { ...request(), acknowledge: false }, { ...request(), extra: true },
    { ...request(), [Symbol()]: true }, { password: '\ud800', acknowledge: true },
    { get password() { reads++; return password; }, acknowledge: true }];
  for (const value of invalid) { assert.equal(snapshotPrivateHubPlaintextCopyRequest(value), undefined); }
  assert.equal(reads, 0);
  assert.deepEqual(snapshotPrivateHubPlaintextCopyRequest({ password: ' exact 🌿 ', acknowledge: true }), { password: ' exact 🌿 ', acknowledge: true });
});

test('password is checked before choosing a destination and a copy keeps the encrypted session usable', async t => {
  const f = await fixture(t); let picks = 0;
  const options = { ...f.options, chooseDestination: async () => { picks++; return f.destination; } };
  assert.equal(await f.session.createUnprotectedCopy(f.generation, { password: 'wrong', acknowledge: true }, current, options), 'incorrect-password');
  assert.equal(picks, 0); assert.equal(f.session.isCurrent(f.generation), true);
  const before = await f.store.readRecord('catalogue');
  assert.equal(await f.session.createUnprotectedCopy(f.generation, request(), current, options), 'copied');
  assert.equal(picks, 1); assert.equal(f.session.isCurrent(f.generation), true);
  assert.deepEqual(await fs.readFile(path.join(f.destination, 'Synthetic copy hub.scaena')), before);
  assert.deepEqual(await f.store.readRecord('catalogue'), before); before.fill(0);
});

test('invalid requests and revoked authority never authenticate or show the destination picker', async t => {
  const f = await fixture(t); const verify = t.mock.method(f.store, 'verifyPassword', async () => true);
  const pick = t.mock.fn(f.options.chooseDestination); const options = { ...f.options, chooseDestination: pick };
  await assert.rejects(f.session.createUnprotectedCopy(f.generation, { password }, current, options), generic);
  await assert.rejects(f.session.createUnprotectedCopy(f.generation, request(), () => false, options), generic);
  assert.equal(verify.mock.callCount(), 0); assert.equal(pick.mock.callCount(), 0);
});

test('a cancelled native picker creates nothing and permits a fresh attempt', async t => {
  const f = await fixture(t);
  assert.equal(await f.session.createUnprotectedCopy(f.generation, request(), current, { ...f.options, chooseDestination: async () => undefined }), 'cancelled');
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  assert.equal(await f.session.createUnprotectedCopy(f.generation, request(), current, f.options), 'copied');
});

test('copy admission freezes all writers through native destination selection', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred<string | undefined>();
  const copying = f.session.createUnprotectedCopy(f.generation, request(), current, {
    ...f.options, chooseDestination: () => { started.resolve(); return release.promise; },
  });
  await started.promise;
  await assert.rejects(f.session.createUnprotectedCopy(f.generation, request(), current, f.options), generic);
  await assert.rejects(f.session.changePassword(f.generation, { currentPassword: password, newPassword: 'new' }, current), generic);
  await assert.rejects(f.session.updateProtection(f.generation, { autoLockMinutes: 0 }, current), generic);
  await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue), generic);
  assert.deepEqual(await f.session.updateVideoMetadata(f.generation, {
    index: 0, revision: privateVideoRevision(f.catalogue.images[0]), notes: 'changed', tags: [],
  }, current), { status: 'busy' });
  release.resolve(undefined); assert.equal(await copying, 'cancelled');
});

test('cancel during destination selection rejects its late path and waits for the native picker to drain', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred<string>(); let settled = false;
  const copying = f.session.createUnprotectedCopy(f.generation, request(), current, {
    ...f.options, chooseDestination: () => { started.resolve(); return release.promise; },
  }).then(result => { settled = true; return result; });
  await started.promise; f.controller.abort(); await Promise.resolve(); assert.equal(settled, false);
  release.resolve(f.destination); assert.equal(await copying, 'cancelled');
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('lock immediately revokes authority but waits for a pending picker and cannot publish its late destination', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred<string>();
  const copying = assert.rejects(f.session.createUnprotectedCopy(f.generation, request(), current, {
    ...f.options, chooseDestination: () => { started.resolve(); return release.promise; },
  }), generic);
  await started.promise; let drained = false; const locking = f.session.lock().then(() => { drained = true; });
  assert.equal(f.store.locked, true); await Promise.resolve(); assert.equal(drained, false);
  await assert.rejects(f.session.unlock(f.directory, password));
  release.resolve(f.destination); await Promise.all([copying, locking]);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('owned password buffers are wiped before the native picker begins', async t => {
  const f = await fixture(t); const buffers: Buffer[] = []; const from = Buffer.from;
  t.mock.method(Buffer, 'from', ((value: unknown, ...args: unknown[]) => {
    const bytes = Reflect.apply(from, Buffer, [value, ...args]) as Buffer;
    if (value === password) { buffers.push(bytes); } return bytes;
  }) as typeof Buffer.from);
  const dto = request(); const started = deferred(); const release = deferred<boolean>();
  t.mock.method(f.store, 'verifyPassword', (secret: string) => { assert.equal(secret, password); started.resolve(); return release.promise; });
  const work = f.session.createUnprotectedCopy(f.generation, dto, current, { ...f.options, chooseDestination: async () => {
    assert.equal(buffers.length, 1); assert.ok(buffers.every(bytes => bytes.every(byte => byte === 0))); return undefined;
  } });
  dto.password = 'mutated'; await started.promise; release.resolve(true); assert.equal(await work, 'cancelled');
});

test('an existing target returns a bounded failure without damaging the target or locking the source', async t => {
  const f = await fixture(t); await fs.mkdir(f.destination); await fs.writeFile(path.join(f.destination, 'keep'), 'existing');
  assert.equal(await f.session.createUnprotectedCopy(f.generation, request(), current, f.options), 'failed');
  assert.equal(await fs.readFile(path.join(f.destination, 'keep'), 'utf8'), 'existing');
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('export cancellation is drained and no late success is returned', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred();
  t.mock.method(exporter, 'exportPrivateHubToPlaintext', async (_store, options: exporter.PrivateHubPlaintextExportOptions) => {
    started.resolve(); await release.promise; assert.equal(options.signal.aborted, true); options.assertSourceQuiescent();
    return { previewCount: 0, byteLength: 0 };
  });
  const work = f.session.createUnprotectedCopy(f.generation, request(), current, f.options);
  await started.promise; f.controller.abort(); release.resolve(); assert.equal(await work, 'cancelled');
});

test('a storage authentication failure locks the source without exposing diagnostics', async t => {
  const f = await fixture(t); t.mock.method(f.store, 'verifyPassword', async () => { throw new Error(password + f.directory); });
  await assert.rejects(f.session.createUnprotectedCopy(f.generation, request(), current, f.options), generic);
  assert.equal(f.store.locked, true);
});

test('unconfirmed export cleanup permanently quarantines the session and blocks reopening', async t => {
  const f = await fixture(t); const failure = new Error('synthetic cleanup failure');
  t.mock.method(exporter, 'isPrivateHubPlaintextExportCleanupFailure', error => error === failure);
  t.mock.method(exporter, 'exportPrivateHubToPlaintext', async () => { throw failure; });
  await assert.rejects(f.session.createUnprotectedCopy(f.generation, request(), current, f.options), error => error === failure);
  assert.equal(f.store.locked, true); await assert.rejects(f.session.lock(), error => error === failure);
  await assert.rejects(f.session.unlock(f.directory, password), generic);
});

test('lock already in progress rejects a late branded export cleanup failure and retains quarantine', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred();
  const failure = new Error('synthetic late cleanup failure');
  t.mock.method(exporter, 'isPrivateHubPlaintextExportCleanupFailure', error => error === failure);
  t.mock.method(exporter, 'exportPrivateHubToPlaintext', async () => { started.resolve(); await release.promise; throw failure; });
  const copy = assert.rejects(f.session.createUnprotectedCopy(f.generation, request(), current, f.options), error => error === failure);
  await started.promise;
  const locking = assert.rejects(f.session.lock(), error => error === failure);
  assert.equal(f.store.locked, true); release.resolve(); await Promise.all([copy, locking]);
  await assert.rejects(f.session.unlock(f.directory, password), generic);
  await assert.rejects(f.session.close(), error => error === failure);
});
