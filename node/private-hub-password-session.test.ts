import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { isPrivateHubPassword, snapshotPrivateHubPasswordChange } from '../interfaces/private-hub-credentials';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { privateVideoRevision } from './private-hub-metadata';

const password = 'Synthetic existing password';
const replacement = 'Synthetic replacement password';
const current = () => true;
const request = () => ({ currentPassword: password, newPassword: replacement });
const generic = { message: 'The private hub session is unavailable.' };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'password-session-'));
  const directory = path.join(root, 'hub');
  const created = await PrivateHubStore.create(directory, password);
  const catalogue: FinalObject = { hubName: 'Synthetic password hub', version: 3, addTags: [], removeTags: [], numOfFolders: 1,
    images: [{ ...NewImageElement(), hash: 'synthetic', fileName: 'synthetic.mp4', screens: 3, notes: 'Retained notes' }],
    inputDirs: { 0: { path: path.join(root, 'unused-source'), watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 } };
  await writePrivateHubCatalogue(created, catalogue);
  const marker = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: created.hubId }));
  try { await created.writeNewRecord('session:activation', marker); }
  finally { marker.fill(0); await created.lock(); }
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  let store!: PrivateHubStore;
  t.mock.method(PrivateHubStore, 'open', async (location: string, secret: string) => {
    store = await open(location, secret); return store;
  });
  const session = new PrivateHubSession();
  const { generation } = await session.unlock(directory, password);
  t.after(async () => { await session.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { directory, session, generation, catalogue, store };
}

test('credential snapshots reject accessors, symbols, extra properties and invalid Unicode without normalizing text', () => {
  let accessed = 0;
  const accessor = { newPassword: replacement, get currentPassword() { accessed++; return password; } };
  const malformed: unknown[] = [undefined, null, [], {}, accessor, { ...request(), extra: true },
    { ...request(), [Symbol()]: true }, { currentPassword: password, newPassword: password }];
  for (const bad of ['', '\ud800', '\udfff', 'x'.repeat(1025), 'é'.repeat(513), 12]) {
    malformed.push({ currentPassword: bad, newPassword: replacement }, { currentPassword: password, newPassword: bad });
  }
  for (const value of malformed) { assert.equal(snapshotPrivateHubPasswordChange(value), undefined); }
  assert.equal(accessed, 0);
  assert.equal(isPrivateHubPassword('🌿'.repeat(256)), true);
  assert.equal(isPrivateHubPassword('🌿'.repeat(257)), false);
  const value = { currentPassword: '  exact old  ', newPassword: 'e\u0301  ' };
  assert.deepEqual(snapshotPrivateHubPasswordChange(value), value);
});

test('a session reauthenticates, preserves catalogue/settings and reopens only with the new password', async t => {
  const f = await fixture(t);
  await f.session.updateProtection(f.generation, { autoLockMinutes: 15 }, current);
  assert.equal(await f.session.changePassword(f.generation, { ...request(), currentPassword: 'incorrect' }, current), 'incorrect-password');
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.equal(await f.session.changePassword(f.generation, request(), current), 'changed');
  assert.deepEqual(await f.session.readCatalogue(f.generation), f.catalogue);
  await f.session.lock();
  await assert.rejects(f.session.unlock(f.directory, password));
  const reopened = await f.session.unlock(f.directory, replacement);
  assert.deepEqual(reopened.catalogue, f.catalogue);
  assert.deepEqual(await f.session.readProtection(reopened.generation), { autoLockMinutes: 15 });
});

test('invalid requests do not invoke storage or lock a healthy session', async t => {
  const f = await fixture(t);
  const change = t.mock.method(f.store, 'changePassword', async () => { throw new Error('must not run'); });
  await assert.rejects(f.session.changePassword(f.generation, { ...request(), newPassword: password }, current), generic);
  await assert.rejects(f.session.changePassword(f.generation, request(), () => false), generic);
  assert.equal(change.mock.callCount(), 0);
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('pending password changes block other writers and a second credential operation while lock remains immediate', async t => {
  const f = await fixture(t);
  const started = deferred();
  const release = deferred<'changed'>();
  t.mock.method(f.store, 'changePassword', async () => { started.resolve(); return release.promise; });
  const work = f.session.changePassword(f.generation, request(), current);
  const rejected = assert.rejects(work, generic);
  await started.promise;
  await assert.rejects(f.session.changePassword(f.generation, request(), current), generic);
  await assert.rejects(f.session.updateProtection(f.generation, { autoLockMinutes: 0 }, current), generic);
  await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue), generic);
  const image = f.catalogue.images[0];
  assert.deepEqual(await f.session.updateVideoMetadata(f.generation, {
    index: 0, revision: privateVideoRevision(image), notes: 'changed', tags: [],
  }, current), { status: 'busy' });
  let drained = false;
  const locking = f.session.lock().then(() => { drained = true; });
  assert.equal(f.store.locked, true);
  assert.equal(f.session.isCurrent(f.generation), false);
  await Promise.resolve();
  assert.equal(drained, false);
  await assert.rejects(f.session.unlock(f.directory, password));
  release.resolve('changed');
  await Promise.all([rejected, locking]);
  assert.equal(drained, true);
});

test('queued credentials are detached from caller mutation and cleared before waiting on storage', async t => {
  const f = await fixture(t);
  const readingStarted = deferred();
  const releaseRead = deferred();
  const read = f.store.readRecord.bind(f.store);
  t.mock.method(f.store, 'readRecord', async (...args: Parameters<PrivateHubStore['readRecord']>) => {
    readingStarted.resolve(); await releaseRead.promise; return read(...args);
  });
  const retained: Buffer[] = [];
  const from = Buffer.from;
  t.mock.method(Buffer, 'from', ((value: unknown, ...args: unknown[]) => {
    const bytes = Reflect.apply(from, Buffer, [value, ...args]) as Buffer;
    if (value === password || value === replacement) { retained.push(bytes); }
    return bytes;
  }) as typeof Buffer.from);
  const reading = f.session.readCatalogue(f.generation);
  await readingStarted.promise;
  const dto = request();
  const work = f.session.changePassword(f.generation, dto, current);
  dto.currentPassword = ''; dto.newPassword = '';
  const started = deferred();
  const releaseChange = deferred<'incorrect-password'>();
  t.mock.method(f.store, 'changePassword', (old: string, next: string) => {
    assert.equal(old, password); assert.equal(next, replacement);
    started.resolve(); return releaseChange.promise;
  });
  releaseRead.resolve();
  await reading;
  await started.promise;
  assert.equal(retained.length, 2);
  assert.ok(retained.every(bytes => bytes.every(value => value === 0)));
  releaseChange.resolve('incorrect-password');
  assert.equal(await work, 'incorrect-password');
});

test('locking wipes queued credential buffers before the pending read is allowed to finish', async t => {
  const f = await fixture(t);
  const started = deferred(); const release = deferred();
  const read = f.store.readRecord.bind(f.store);
  t.mock.method(f.store, 'readRecord', async (...args: Parameters<PrivateHubStore['readRecord']>) => {
    started.resolve(); await release.promise; return read(...args);
  });
  const retained: Buffer[] = [];
  const from = Buffer.from;
  t.mock.method(Buffer, 'from', ((value: unknown, ...args: unknown[]) => {
    const bytes = Reflect.apply(from, Buffer, [value, ...args]) as Buffer;
    if (value === password || value === replacement) { retained.push(bytes); }
    return bytes;
  }) as typeof Buffer.from);
  const change = t.mock.method(f.store, 'changePassword', async () => 'changed' as const);
  const reading = assert.rejects(f.session.readCatalogue(f.generation));
  await started.promise;
  const changing = assert.rejects(f.session.changePassword(f.generation, request(), current), generic);
  const locking = f.session.lock();
  assert.equal(retained.length, 2);
  assert.ok(retained.every(bytes => bytes.every(value => value === 0)));
  release.resolve();
  await Promise.all([reading, changing, locking]);
  assert.equal(change.mock.callCount(), 0);
});

test('revocation during reauthentication rejects a late changed result without restoring authority', async t => {
  const f = await fixture(t);
  const started = deferred(); const release = deferred<'changed'>();
  let allowed = true;
  t.mock.method(f.store, 'changePassword', async (_old: string, _next: string, guard: () => boolean) => {
    started.resolve(); const result = await release.promise;
    assert.equal(guard(), false); allowed = true; assert.equal(guard(), false);
    return result;
  });
  const result = assert.rejects(f.session.changePassword(f.generation, request(), () => allowed), generic);
  await started.promise;
  allowed = false; release.resolve('changed');
  await result;
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('credential storage failure locks the session and never exposes storage diagnostics', async t => {
  const f = await fixture(t);
  t.mock.method(f.store, 'changePassword', async () => { throw new Error(password + f.directory); });
  await assert.rejects(f.session.changePassword(f.generation, request(), current), generic);
  assert.equal(f.store.locked, true);
  assert.equal(f.session.status.state, 'locked');
});

test('a pending protection save prevents credential admission', async t => {
  const f = await fixture(t);
  const release = deferred();
  const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (...args: Parameters<PrivateHubStore['writeRecord']>) => {
    await release.promise; return write(...args);
  });
  const saving = f.session.updateProtection(f.generation, { autoLockMinutes: 1 }, current);
  await assert.rejects(f.session.changePassword(f.generation, request(), current), generic);
  release.resolve();
  await saving;
});
