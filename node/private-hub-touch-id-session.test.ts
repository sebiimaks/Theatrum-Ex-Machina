import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { snapshotPrivateHubTouchIdEnable } from '../interfaces/private-hub-credentials';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { createPrivateTouchIdCleanupFailure, isPrivateTouchIdCleanupFailure, type PrivateTouchIdProvider } from './private-touch-id';

const password = 'Synthetic Touch ID password';
const current = () => true;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'touch-id-session-'));
  const directory = path.join(root, 'hub');
  const entries = new Map<string, Buffer>();
  const provider: PrivateTouchIdProvider = {
    availability: async () => 'available',
    has: async identity => entries.has(identity),
    enroll: async (identity, secret) => { assert.equal(entries.has(identity), false); entries.set(identity, Buffer.from(secret)); return 'enrolled'; },
    unlock: async identity => { const value = entries.get(identity); return value && Buffer.from(value); },
    remove: async identity => { entries.get(identity)?.fill(0); entries.delete(identity); return true; },
  };
  const created = await PrivateHubStore.create(directory, password);
  const catalogue: FinalObject = { hubName: 'Synthetic Touch ID hub', version: 3, addTags: [], removeTags: [], numOfFolders: 1,
    images: [{ ...NewImageElement(), hash: 'synthetic', fileName: 'synthetic.mp4', screens: 3, notes: 'Protected notes' }],
    inputDirs: { 0: { path: path.join(root, 'unused-source'), watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 } };
  await writePrivateHubCatalogue(created, catalogue);
  const marker = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: created.hubId }));
  try { await created.writeNewRecord('session:activation', marker); }
  finally { marker.fill(0); await created.lock(); }
  const session = new PrivateHubSession({ touchId: provider });
  const { generation } = await session.unlock(directory, password);
  t.after(async () => {
    await session.close().catch(() => undefined);
    for (const secret of entries.values()) { secret.fill(0); }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { directory, session, generation, catalogue, provider, entries, signal: new AbortController().signal };
}

test('Touch ID credential capture rejects accessors, extra keys and malformed Unicode', () => {
  let reads = 0;
  const values = [null, undefined, [], {}, { password, extra: true }, { password, [Symbol()]: true },
    { get password() { reads++; return password; } }, { password: '' }, { password: '\ud800' }, { password: 'a'.repeat(1025) }];
  for (const value of values) { assert.equal(snapshotPrivateHubTouchIdEnable(value), undefined); }
  assert.equal(reads, 0);
  assert.deepEqual(snapshotPrivateHubTouchIdEnable({ password: '  e\u0301  ' }), { password: '  e\u0301  ' });
});

test('enrollment, biometric reopening, disabling and password fallback preserve the catalogue', async t => {
  const f = await fixture(t);
  assert.equal(await f.session.touchIdStatus(f.generation, f.signal), 'disabled');
  assert.equal(await f.session.enableTouchId(f.generation, { password }, current, f.signal), 'enabled');
  assert.equal(await f.session.touchIdStatus(f.generation, f.signal), 'enabled');
  await f.session.lock();
  const reopened = await f.session.unlockWithTouchId(f.directory);
  assert.deepEqual(reopened.catalogue, f.catalogue);
  assert.equal(await f.session.disableTouchId(reopened.generation, current, f.signal), 'disabled');
  assert.equal(f.entries.size, 0);
  await f.session.lock();
  await assert.rejects(f.session.unlockWithTouchId(f.directory));
  assert.deepEqual((await f.session.unlock(f.directory, password)).catalogue, f.catalogue);
});

test('an incorrect password never reaches Touch ID enrollment', async t => {
  const f = await fixture(t);
  const enroll = t.mock.method(f.provider, 'enroll', async () => { throw new Error('must not call'); });
  assert.equal(await f.session.enableTouchId(f.generation, { password: 'wrong' }, current, f.signal), 'incorrect-password');
  assert.equal(enroll.mock.callCount(), 0);
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('password changes revoke this Mac enrollment before reporting success', async t => {
  const f = await fixture(t);
  await f.session.enableTouchId(f.generation, { password }, current, f.signal);
  const replacement = 'Synthetic new Touch ID password';
  assert.equal(await f.session.changePassword(f.generation, { currentPassword: password, newPassword: replacement }, current), 'changed');
  assert.equal(f.entries.size, 0);
  await f.session.lock();
  await assert.rejects(f.session.unlockWithTouchId(f.directory));
  assert.deepEqual((await f.session.unlock(f.directory, replacement)).catalogue, f.catalogue);
});

test('lock cancels pending enrollment and drains late native completion and rollback', async t => {
  const f = await fixture(t);
  const started = deferred();
  const release = deferred<'enrolled'>();
  let nativeSignal!: AbortSignal;
  t.mock.method(f.provider, 'enroll', async (identity, secret, signal) => {
    f.entries.set(identity, Buffer.from(secret)); nativeSignal = signal; started.resolve(); return release.promise;
  });
  const work = f.session.enableTouchId(f.generation, { password }, current, f.signal);
  const rejected = assert.rejects(work);
  await started.promise;
  await assert.rejects(f.session.changePassword(f.generation, { currentPassword: password, newPassword: 'other' }, current));
  await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue));
  let drained = false;
  const lock = f.session.lock().then(() => { drained = true; });
  assert.equal(nativeSignal.aborted, true);
  await Promise.resolve(); assert.equal(drained, false);
  release.resolve('enrolled');
  await rejected; await lock;
  assert.equal(f.entries.size, 0);
  assert.deepEqual((await f.session.unlock(f.directory, password)).catalogue, f.catalogue);
});

test('unproven Keychain cleanup quarantines the session and later unlock attempts', async t => {
  const f = await fixture(t);
  t.mock.method(f.provider, 'enroll', async () => { throw createPrivateTouchIdCleanupFailure(); });
  await assert.rejects(f.session.enableTouchId(f.generation, { password }, current, f.signal), isPrivateTouchIdCleanupFailure);
  assert.equal(f.session.isCurrent(f.generation), false);
  await assert.rejects(f.session.lock(), isPrivateTouchIdCleanupFailure);
  await assert.rejects(f.session.unlock(f.directory, password));
  await assert.rejects(f.session.unlockWithTouchId(f.directory));
});

test('a cancelled late Touch ID unlock cannot reactivate a locked session', async t => {
  const f = await fixture(t);
  await f.session.enableTouchId(f.generation, { password }, current, f.signal);
  await f.session.lock();
  const started = deferred(); const release = deferred(); let returned: Buffer | undefined;
  t.mock.method(f.provider, 'unlock', async identity => {
    started.resolve(); await release.promise; returned = Buffer.from(f.entries.get(identity)!); return returned;
  });
  const work = f.session.unlockWithTouchId(f.directory);
  const rejected = assert.rejects(work);
  await started.promise;
  const lock = f.session.lock(); release.resolve();
  await rejected; await lock;
  assert.equal(returned?.every(byte => byte === 0), true);
  assert.equal(f.session.status.state, 'locked');
});

test('sessions without a native provider retain password-only behavior', async t => {
  const f = await fixture(t);
  await f.session.close();
  const passwordOnly = new PrivateHubSession();
  t.after(() => passwordOnly.close());
  const opened = await passwordOnly.unlock(f.directory, password);
  assert.equal(await passwordOnly.touchIdStatus(opened.generation, f.signal), 'unavailable');
  await assert.rejects(passwordOnly.unlockWithTouchId(f.directory));
  assert.deepEqual(await passwordOnly.readCatalogue(opened.generation), f.catalogue);
});


test('a poisoned status query locks and quarantines the session instead of returning ordinary unavailability', async t => {
  const f = await fixture(t);
  t.mock.method(f.provider, 'availability', async () => { throw createPrivateTouchIdCleanupFailure(); });
  await assert.rejects(f.session.touchIdStatus(f.generation, f.signal), isPrivateTouchIdCleanupFailure);
  assert.equal(f.session.isCurrent(f.generation), false);
  await assert.rejects(f.session.lock(), isPrivateTouchIdCleanupFailure);
});
