import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as crypto from './private-hub-crypto';
import { PRIVATE_HUB_HEADER_FILE, PrivateHubStore } from './private-hub-store';

const password = 'Synthetic read-only authentication 🔒';
const current = () => true;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const base = path.resolve(__dirname, '../tmp');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'password-verification-'));
  const directory = path.join(root, 'hub');
  const store = await PrivateHubStore.create(directory, password);
  await store.writeRecord('catalogue', Buffer.from('Unchanged synthetic catalogue'));
  t.after(async () => { await store.lock(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, store, header: path.join(directory, PRIVATE_HUB_HEADER_FILE) };
}
async function snapshot(directory: string) {
  const result: Record<string, string> = {};
  for (const name of (await fs.readdir(directory)).sort()) { result[name] = (await fs.readFile(path.join(directory, name))).toString('hex'); }
  return result;
}

test('read-only authentication accepts only the current password and changes no stored files', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.directory);
  assert.equal(await f.store.verifyPassword('incorrect', current), false);
  assert.equal(await f.store.verifyPassword(password, current), true);
  assert.equal(f.store.locked, false);
  assert.deepEqual(await snapshot(f.directory), before);
  await f.store.changePassword(password, 'Synthetic replacement', current);
  assert.equal(await f.store.verifyPassword(password, current), false);
  assert.equal(await f.store.verifyPassword('Synthetic replacement', current), true);
});

test('invalid credentials or guards never derive a password', async t => {
  const f = await fixture(t);
  const derive = t.mock.method(crypto, 'unlockPrivateHub', async () => { throw new Error('must not run'); });
  for (const value of ['', '\ud800', 'x'.repeat(1025), null]) {
    await assert.rejects(f.store.verifyPassword(value, current), /authentication unavailable/);
  }
  for (const guard of [() => false, () => { throw new Error('private diagnostic'); }, (() => Promise.resolve(true)) as any]) {
    await assert.rejects(f.store.verifyPassword(password, guard), /authentication unavailable/);
  }
  assert.equal(derive.mock.callCount(), 0);
});

test('verification and password changes share one admission and wipe their comparison key', async t => {
  const f = await fixture(t);
  const started = deferred(); const release = deferred();
  const derive = crypto.unlockPrivateHub;
  let key!: Buffer;
  t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof derive>) => {
    started.resolve(); await release.promise; key = await derive(...args); return key;
  });
  const work = f.store.verifyPassword(password, current);
  await started.promise;
  await assert.rejects(f.store.verifyPassword(password, current));
  await assert.rejects(f.store.changePassword(password, 'replacement', current));
  release.resolve();
  assert.equal(await work, true);
  assert.ok(key.every(byte => byte === 0));
});

test('wrong derived keys are wiped and never treated as successful authentication', async t => {
  const f = await fixture(t); const key = Buffer.alloc(32, 19);
  t.mock.method(crypto, 'unlockPrivateHub', async () => key);
  await assert.rejects(f.store.verifyPassword(password, current), /authentication unavailable/);
  assert.ok(key.every(byte => byte === 0));
});

test('revocation during derivation cannot return a late credential result or recover authority', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred();
  const derive = crypto.unlockPrivateHub; let key!: Buffer; let allowed = true;
  t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof derive>) => {
    started.resolve(); await release.promise; key = await derive(...args); return key;
  });
  const work = assert.rejects(f.store.verifyPassword(password, () => allowed), /authentication unavailable/);
  await started.promise; allowed = false; release.resolve(); await work;
  assert.ok(key.every(byte => byte === 0));
  assert.equal(f.store.locked, false);
});

test('locking is synchronous and waits for pending derivation and key wiping', async t => {
  const f = await fixture(t); const started = deferred(); const release = deferred();
  const derive = crypto.unlockPrivateHub; let key!: Buffer;
  t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof derive>) => {
    started.resolve(); await release.promise; key = await derive(...args); return key;
  });
  const work = assert.rejects(f.store.verifyPassword(password, current), /authentication unavailable/);
  await started.promise;
  let drained = false; const locking = f.store.lock().then(() => { drained = true; });
  assert.equal(f.store.locked, true); await Promise.resolve(); assert.equal(drained, false);
  release.resolve(); await Promise.all([work, locking]); assert.ok(key.every(byte => byte === 0));
});

test('header replacement during failed authentication is an error rather than an incorrect password', async t => {
  const f = await fixture(t); const before = await fs.readFile(f.header);
  t.mock.method(crypto, 'unlockPrivateHub', async () => {
    const alternate = path.join(f.directory, 'replacement-header');
    await fs.writeFile(alternate, before); await fs.rename(alternate, f.header); throw new Error('wrong');
  });
  await assert.rejects(f.store.verifyPassword('wrong', current), /authentication unavailable/);
});


test('the comparison key is wiped before any post-authentication filesystem await', async t => {
  const f = await fixture(t); const derive = crypto.unlockPrivateHub;
  let key: Buffer | undefined;
  t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof derive>) => { key = await derive(...args); return key; });
  const original = fs.lstat;
  // fs/promises namespace bindings are read-only, so intercept the shared API object.
  const promises = require('node:fs').promises as typeof fs;
  let checks = 0;
  t.mock.method(promises, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (key) { checks++; assert.ok(key.every(byte => byte === 0)); }
    return original(...args as [any]);
  });
  assert.equal(await f.store.verifyPassword(password, current), true);
  assert.ok(checks > 0);
});
