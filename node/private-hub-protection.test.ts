import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { snapshotPrivateHubProtection, type PrivateHubProtection } from '../interfaces/private-hub-protection';
import { readPrivateHubProtection, writePrivateHubProtection } from './private-hub-protection';
import { PrivateHubStore } from './private-hub-store';
import { PrivateHubSession } from './private-hub-session';
import { writePrivateHubCatalogue } from './private-hub-catalogue';

const password = 'Synthetic encrypted automatic lock password';
const record = 'settings:protection';
const generic = { message: 'Private hub protection settings are unavailable.' };
const current = () => true;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-protection-'));
  const directory = path.join(root, 'encrypted-hub');
  const store = await PrivateHubStore.create(directory, password);
  const closers = [() => store.lock()];
  t.after(async () => {
    for (const close of closers) { await close(); }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, directory, store, closers };
}

async function sessionFixture(t: TestContext) {
  const f = await fixture(t);
  const catalogue: FinalObject = { hubName: 'Synthetic protection hub', version: 3, addTags: [], removeTags: [], numOfFolders: 1,
    images: [{ ...NewImageElement(), hash: 'synthetic', fileName: 'synthetic.mp4', screens: 3 }],
    inputDirs: { 0: { path: path.join(f.root, 'unused-source'), watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 } };
  await writePrivateHubCatalogue(f.store, catalogue);
  const bytes = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: f.store.hubId }));
  try { await f.store.writeNewRecord('session:activation', bytes); }
  finally { bytes.fill(0); await f.store.lock(); }
  let opened!: PrivateHubStore;
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (directory: string, secret: string) => {
    opened = await open(directory, secret);
    return opened;
  });
  const session = new PrivateHubSession();
  const { generation } = await session.unlock(f.directory, password);
  f.closers.unshift(() => session.close());
  return { ...f, store: opened, session, generation, catalogue };
}

async function primary(directory: string): Promise<string> {
  const records = (await fs.readdir(directory)).filter(name => name.endsWith('.sealed'));
  assert.equal(records.length, 1);
  return path.join(directory, records[0]);
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await fs.readdir(directory)) {
    result[name] = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
  }
  return result;
}

function holdRead(t: TestContext, store: PrivateHubStore, id = record) {
  const ready = deferred();
  const release = deferred();
  const read = store.readRecord.bind(store);
  let held = false;
  t.mock.method(store, 'readRecord', async (name: string, maximum?: number) => {
    if (name === id && !held) { held = true; ready.resolve(); await release.promise; }
    return read(name, maximum);
  });
  return { ready, release };
}

test('a missing primary and backup default to five minutes without writing ordinary or private files', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.directory);
  assert.deepEqual(await readPrivateHubProtection(f.store), { autoLockMinutes: 5 });
  assert.deepEqual(await fingerprint(f.directory), before);
  assert.deepEqual(await fs.readdir(f.root), ['encrypted-hub']);
});

test('only the whitelist round trips through encrypted records and survives reopening without plaintext settings', async t => {
  const f = await fixture(t);
  for (const autoLockMinutes of [0, 1, 5, 15, 30] as const) {
    const returned = await writePrivateHubProtection(f.store, { autoLockMinutes }, current);
    assert.deepEqual(returned, { autoLockMinutes });
    returned.autoLockMinutes = 0;
    assert.deepEqual(await readPrivateHubProtection(f.store), { autoLockMinutes });
  }
  await f.store.lock();
  const reopened = await PrivateHubStore.open(f.directory, password);
  f.closers.unshift(() => reopened.lock());
  assert.deepEqual(await readPrivateHubProtection(reopened), { autoLockMinutes: 30 });
  for (const name of await fs.readdir(f.directory)) {
    assert.doesNotMatch(name, /protection|settings|autoLock/);
    const bytes = await fs.readFile(path.join(f.directory, name));
    for (const text of [password, 'autoLockMinutes', 'settings:protection', 'Synthetic protection hub']) {
      assert.equal(bytes.includes(Buffer.from(text)), false, name);
    }
  }
  assert.deepEqual(await fs.readdir(f.root), ['encrypted-hub']);
});

test('malformed, unsupported and oversized authenticated settings reject instead of defaulting or replacing them', async t => {
  const f = await fixture(t);
  for (const raw of ['not JSON', 'null', '[]', '{}', '{"version":2,"autoLockMinutes":5}',
    '{"version":1,"autoLockMinutes":2}', '{"version":1,"autoLockMinutes":"5"}',
    '{"version":1,"autoLockMinutes":0,"other":true}', '{"autoLockMinutes":5}',
    JSON.stringify({ version: 1, autoLockMinutes: 5, padding: 'x'.repeat(300) })]) {
    await f.store.writeRecord(record, Buffer.from(raw));
    const before = await fingerprint(f.directory);
    await assert.rejects(readPrivateHubProtection(f.store), generic);
    await assert.rejects(writePrivateHubProtection(f.store, { autoLockMinutes: 30 }, current), generic);
    assert.deepEqual(await fingerprint(f.directory), before);
  }
});

test('authentication failure preserves damaged bytes and never returns default protection', async t => {
  const f = await fixture(t);
  await writePrivateHubProtection(f.store, { autoLockMinutes: 1 }, current);
  const file = await primary(f.directory);
  const bytes = await fs.readFile(file); bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(file, bytes);
  const before = await fingerprint(f.directory);
  await assert.rejects(readPrivateHubProtection(f.store), generic);
  await assert.rejects(writePrivateHubProtection(f.store, { autoLockMinutes: 0 }, current), generic);
  assert.deepEqual(await fingerprint(f.directory), before);
});

test('missing primary with any surviving backup requires explicit recovery', async t => {
  const f = await fixture(t);
  await writePrivateHubProtection(f.store, { autoLockMinutes: 1 }, current);
  await writePrivateHubProtection(f.store, { autoLockMinutes: 30 }, current);
  const file = await primary(f.directory);
  await fs.unlink(file);
  for (const corrupt of [false, true]) {
    if (corrupt) { await fs.writeFile(file + '.bak', Buffer.from('Damaged encrypted settings')); }
    const before = await fingerprint(f.directory);
    await assert.rejects(readPrivateHubProtection(f.store), generic);
    await assert.rejects(writePrivateHubProtection(f.store, { autoLockMinutes: 0 }, current), generic);
    assert.deepEqual(await fingerprint(f.directory), before);
  }
});

test('non-missing primary failures never inspect a backup or expose native errors', async t => {
  const f = await fixture(t);
  t.mock.method(f.store, 'readRecord', async () => { throw Object.assign(new Error(f.directory), { code: 'EACCES' }); });
  const backup = t.mock.method(f.store, 'readBackupRecord', async () => { assert.fail('Not a missing primary'); });
  await assert.rejects(readPrivateHubProtection(f.store), generic);
  assert.equal(backup.mock.callCount(), 0);
});

test('request shape validation rejects getters, extra keys, symbols and non-whitelisted values before storage access', async t => {
  const f = await fixture(t);
  const read = t.mock.method(f.store, 'readRecord', async () => { assert.fail('Invalid input must not access storage'); });
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'autoLockMinutes', { enumerable: true, get: () => { getterCalls++; return 5; } });
  const symbol = { autoLockMinutes: 5, [Symbol('extra')]: true };
  for (const value of [null, [], {}, getter, symbol, { autoLockMinutes: 5, extra: true }, { autoLockMinutes: 2 },
    { autoLockMinutes: -1 }, { autoLockMinutes: NaN }, { autoLockMinutes: '5' }]) {
    assert.equal(snapshotPrivateHubProtection(value), undefined);
    await assert.rejects(writePrivateHubProtection(f.store, value as PrivateHubProtection, current), generic);
  }
  assert.equal(getterCalls, 0);
  assert.equal(read.mock.callCount(), 0);
});

test('writes snapshot caller input before awaiting storage and erase owned plaintext buffers', async t => {
  const f = await fixture(t);
  const held = holdRead(t, f.store);
  const write = f.store.writeRecord.bind(f.store);
  const retained: Buffer[] = [];
  t.mock.method(f.store, 'writeRecord', (id: string, bytes: Buffer, guard?: () => boolean) => {
    retained.push(bytes);
    return write(id, bytes, guard);
  });
  const value: PrivateHubProtection = { autoLockMinutes: 1 };
  const work = writePrivateHubProtection(f.store, value, current);
  await held.ready.promise;
  value.autoLockMinutes = 0;
  held.release.resolve();
  assert.deepEqual(await work, { autoLockMinutes: 1 });
  assert.deepEqual(await readPrivateHubProtection(f.store), { autoLockMinutes: 1 });
  assert.equal(retained.length, 1);
  assert.ok(retained.every(bytes => bytes.every(byte => byte === 0)));
});

test('reads wipe decrypted primary and surviving backup buffers', async t => {
  const f = await fixture(t);
  await writePrivateHubProtection(f.store, { autoLockMinutes: 1 }, current);
  await writePrivateHubProtection(f.store, { autoLockMinutes: 5 }, current);
  const read = f.store.readRecord.bind(f.store);
  const backup = f.store.readBackupRecord.bind(f.store);
  const retained: Buffer[] = [];
  t.mock.method(f.store, 'readRecord', async (...args: Parameters<typeof read>) => {
    const bytes = await read(...args); retained.push(bytes); return bytes;
  });
  t.mock.method(f.store, 'readBackupRecord', async (...args: Parameters<typeof backup>) => {
    const bytes = await backup(...args); retained.push(bytes); return bytes;
  });
  assert.deepEqual(await readPrivateHubProtection(f.store), { autoLockMinutes: 5 });
  await fs.unlink(await primary(f.directory));
  await assert.rejects(readPrivateHubProtection(f.store), generic);
  assert.equal(retained.length, 2);
  assert.ok(retained.every(bytes => bytes.every(byte => byte === 0)));
});

test('authority loss during an existing-settings read prevents publication but allows a later deliberate retry', async t => {
  const f = await fixture(t);
  await writePrivateHubProtection(f.store, { autoLockMinutes: 5 }, current);
  const held = holdRead(t, f.store);
  let allowed = true;
  const work = writePrivateHubProtection(f.store, { autoLockMinutes: 0 }, () => allowed);
  const rejected = assert.rejects(work, generic);
  await held.ready.promise;
  allowed = false;
  held.release.resolve();
  await rejected;
  assert.deepEqual(await readPrivateHubProtection(f.store), { autoLockMinutes: 5 });
  allowed = true;
  assert.deepEqual(await writePrivateHubProtection(f.store, { autoLockMinutes: 1 }, () => allowed), { autoLockMinutes: 1 });
});

test('session protection changes persist across lock and reopening without changing the catalogue', async t => {
  const f = await sessionFixture(t);
  assert.deepEqual(await f.session.readProtection(f.generation), { autoLockMinutes: 5 });
  assert.deepEqual(await f.session.updateProtection(f.generation, { autoLockMinutes: 15 }, current), { autoLockMinutes: 15 });
  assert.deepEqual(await f.session.readCatalogue(f.generation), f.catalogue);
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(await f.session.readProtection(reopened.generation), { autoLockMinutes: 15 });
  assert.deepEqual(reopened.catalogue, f.catalogue);
});

test('a session locks immediately on authenticated malformed protection settings', async t => {
  const f = await sessionFixture(t);
  await f.store.writeRecord(record, Buffer.from('{"version":99,"autoLockMinutes":0}'));
  await assert.rejects(f.session.readProtection(f.generation));
  assert.equal(f.session.isCurrent(f.generation), false);
  assert.equal(f.session.status.state, 'locked');
  assert.equal(f.store.locked, true);
  assert.equal(f.store.lockSignal.aborted, true);
});

test('a session locks on a write failure while invalid requests do not damage an active session', async t => {
  const f = await sessionFixture(t);
  await assert.rejects(f.session.updateProtection(f.generation, { autoLockMinutes: 2 } as unknown as PrivateHubProtection, current));
  assert.equal(f.session.isCurrent(f.generation), true);
  t.mock.method(f.store, 'writeRecord', async () => { throw new Error(f.directory); });
  await assert.rejects(f.session.updateProtection(f.generation, { autoLockMinutes: 1 }, current), error => !String(error).includes(f.directory));
  assert.equal(f.store.locked, true);
  assert.equal(f.session.status.state, 'locked');
});

test('only one protection save is admitted and its queued input cannot change', async t => {
  const f = await sessionFixture(t);
  const held = holdRead(t, f.store, 'catalogue');
  const reading = f.session.readCatalogue(f.generation);
  await held.ready.promise;
  const value: PrivateHubProtection = { autoLockMinutes: 1 };
  const writing = f.session.updateProtection(f.generation, value, current);
  value.autoLockMinutes = 0;
  await assert.rejects(f.session.updateProtection(f.generation, { autoLockMinutes: 30 }, current));
  assert.equal(f.session.isCurrent(f.generation), true);
  held.release.resolve();
  await reading;
  assert.deepEqual(await writing, { autoLockMinutes: 1 });
  assert.deepEqual(await f.session.readProtection(f.generation), { autoLockMinutes: 1 });
  assert.deepEqual(await f.session.updateProtection(f.generation, { autoLockMinutes: 30 }, current), { autoLockMinutes: 30 });
});

test('lock discards late protection reads and queued writes without acknowledging stale settings', async t => {
  const f = await sessionFixture(t);
  const held = holdRead(t, f.store);
  const reading = f.session.readProtection(f.generation);
  const rejectedRead = assert.rejects(reading);
  await held.ready.promise;
  const writing = f.session.updateProtection(f.generation, { autoLockMinutes: 0 }, current);
  const rejectedWrite = assert.rejects(writing);
  const locked = f.session.lock();
  held.release.resolve();
  await Promise.all([rejectedRead, rejectedWrite, locked]);
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(await f.session.readProtection(reopened.generation), { autoLockMinutes: 5 });
});

test('a lock in queue completion microtasks rejects the final protection handoff', async t => {
  const f = await sessionFixture(t);
  const original = f.session.isCurrent.bind(f.session);
  let checks = 0;
  t.mock.method(f.session, 'isCurrent', (generation: number) => {
    const result = original(generation);
    if (++checks === 3) { queueMicrotask(() => { void f.session.lock(); }); }
    return result;
  });
  await assert.rejects(f.session.readProtection(f.generation));
  assert.equal(f.session.status.state, 'locked');
});

test('revoked renderer authority cancels a settings save without locking a healthy session', async t => {
  const f = await sessionFixture(t);
  const held = holdRead(t, f.store);
  let allowed = true;
  const writing = f.session.updateProtection(f.generation, { autoLockMinutes: 0 }, () => allowed);
  const rejected = assert.rejects(writing);
  await held.ready.promise;
  allowed = false; held.release.resolve();
  await rejected;
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.deepEqual(await f.session.readProtection(f.generation), { autoLockMinutes: 5 });
  allowed = true;
  assert.deepEqual(await f.session.updateProtection(f.generation, { autoLockMinutes: 1 }, () => allowed), { autoLockMinutes: 1 });
});
