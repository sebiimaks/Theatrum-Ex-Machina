import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';

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
  const root = await fs.mkdtemp(path.join(temporary, 'password-recovery-session-'));
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

test('recovery rejects malformed or revoked requests before storage and keeps the healthy session open', async t => {
  const f = await fixture(t);
  const resume = t.mock.method(f.store, 'resumePasswordChange', async () => { throw new Error('must not run'); });
  await assert.rejects(f.session.resumePasswordChange(f.generation, { ...request(), newPassword: password }, current, async () => true), generic);
  await assert.rejects(f.session.resumePasswordChange(f.generation, request(), () => false, async () => true), generic);
  await assert.rejects(f.session.resumePasswordChange(f.generation, request(), current, undefined as any), generic);
  assert.equal(resume.mock.callCount(), 0); assert.equal(f.session.isCurrent(f.generation), true);
});

test('recovery owns credential buffers, wipes before confirmation, and accepts only explicit true', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred();
  const retained: Buffer[] = []; const from = Buffer.from;
  t.mock.method(Buffer, 'from', ((value: unknown, ...args: unknown[]) => {
    const bytes = Reflect.apply(from, Buffer, [value, ...args]) as Buffer;
    if (value === password || value === replacement) { retained.push(bytes); }
    return bytes;
  }) as typeof Buffer.from);
  t.mock.method(f.store, 'resumePasswordChange', async (old: string, next: string, guard: () => boolean, confirm: () => Promise<boolean>) => {
    assert.equal(old, password); assert.equal(next, replacement); assert.equal(guard(), true);
    await Promise.resolve(); started.resolve(); await release.promise;
    assert.equal(await confirm(), false); return 'cancelled';
  });
  const caller = request(); const work = f.session.resumePasswordChange(f.generation, caller, current, async () => 1 as any);
  caller.currentPassword = ''; caller.newPassword = ''; await started.promise;
  assert.equal(retained.length, 2); assert.ok(retained.every(bytes => bytes.every(value => value === 0)));
  release.resolve(); assert.equal(await work, 'cancelled'); assert.equal(f.session.isCurrent(f.generation), true);
});

test('pending recovery excludes writes and credentials while lock revokes immediately and drains native confirmation', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred<boolean>();
  t.mock.method(f.store, 'resumePasswordChange', async (_old: string, _next: string, _guard: () => boolean, confirm: () => Promise<boolean>) => {
    await confirm(); return 'changed';
  });
  const work = assert.rejects(f.session.resumePasswordChange(f.generation, request(), current,
    () => { started.resolve(); return release.promise; }), generic);
  await started.promise;
  await assert.rejects(f.session.resumePasswordChange(f.generation, request(), current, async () => true), generic);
  await assert.rejects(f.session.changePassword(f.generation, request(), current), generic);
  await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue), generic);
  await assert.rejects(f.session.updateProtection(f.generation, { autoLockMinutes: 0 }, current), generic);
  let drained = false; const locking = f.session.lock().then(() => { drained = true; });
  assert.equal(f.session.isCurrent(f.generation), false); assert.equal(f.store.locked, true);
  await Promise.resolve(); assert.equal(drained, false);
  release.resolve(true); await Promise.all([work, locking]); assert.equal(drained, true);
});

test('recovery rechecks authority after confirmation and remembers revocation despite callback reentry', async t => {
  const f = await fixture(t); let allowed = true;
  t.mock.method(f.store, 'resumePasswordChange', async (_old: string, _next: string, guard: () => boolean, confirm: () => Promise<boolean>) => {
    await assert.rejects(confirm(), generic); allowed = true; assert.equal(guard(), false); return 'changed';
  });
  await assert.rejects(f.session.resumePasswordChange(f.generation, request(), () => allowed,
    async () => { allowed = false; return true; }), generic);
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('incorrect passwords, absent candidates and cancellation remain retryable without changing catalogue contents', async t => {
  const f = await fixture(t); let confirmations = 0;
  for (const result of ['incorrect-password', 'not-found', 'cancelled'] as const) {
    t.mock.method(f.store, 'resumePasswordChange', async () => result);
    assert.equal(await f.session.resumePasswordChange(f.generation, request(), current,
      async () => { confirmations++; return true; }), result);
    assert.deepEqual(await f.session.readCatalogue(f.generation), f.catalogue);
  }
  assert.equal(confirmations, 0); assert.equal(f.session.isCurrent(f.generation), true);
});

test('credential recovery failure locks the session and suppresses underlying diagnostics', async t => {
  const f = await fixture(t);
  t.mock.method(f.store, 'resumePasswordChange', async () => { throw new Error(password + f.directory); });
  await assert.rejects(f.session.resumePasswordChange(f.generation, request(), current, async () => true), generic);
  assert.equal(f.store.locked, true); assert.equal(f.session.status.state, 'locked');
});
