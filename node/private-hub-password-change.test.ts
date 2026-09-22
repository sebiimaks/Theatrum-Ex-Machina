import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as crypto from './private-hub-crypto.ts';
import { PRIVATE_HUB_HEADER_FILE, PrivateHubStore } from './private-hub-store.ts';

const password = 'Synthetic original private-hub password';
const replacement = 'Synthetic changed password with emoji 🔒';
const current = (): boolean => true;

async function fixture(t: TestContext): Promise<{ root: string; directory: string; store: PrivateHubStore; header: string }> {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..'), '.private-password-change-test-'));
  const directory = path.join(root, 'hub');
  const store = await PrivateHubStore.create(directory, password);
  await store.writeRecord('catalogue', Buffer.from('Synthetic confidential catalogue'));
  t.after(async () => {
    await store.lock();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, directory, store, header: path.join(directory, PRIVATE_HUB_HEADER_FILE) };
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    result[name] = createHash('sha256').update(await fs.promises.readFile(path.join(directory, name))).digest('hex');
  }
  return result;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function openAndRead(directory: string, credential: string): Promise<void> {
  const reopened = await PrivateHubStore.open(directory, credential);
  try { assert.equal((await reopened.readRecord('catalogue')).toString(), 'Synthetic confidential catalogue'); }
  finally { await reopened.lock(); }
}

test('password change rewraps only the header, preserves records, and reopens only with the new password', async t => {
  const { directory, store, header } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from('Synthetic confidential catalogue'));
  const before = await fingerprint(directory);
  const oldHeader = JSON.parse(await fs.promises.readFile(header, 'utf8'));
  assert.equal(await store.changePassword(password, replacement, current), 'changed');
  const after = await fingerprint(directory);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const name of Object.keys(before)) {
    if (name !== PRIVATE_HUB_HEADER_FILE) { assert.equal(after[name], before[name]); }
  }
  assert.notEqual(after[PRIVATE_HUB_HEADER_FILE], before[PRIVATE_HUB_HEADER_FILE]);
  const newHeader = JSON.parse(await fs.promises.readFile(header, 'utf8'));
  assert.equal(newHeader.hubId, oldHeader.hubId);
  assert.equal(newHeader.keyCheck, oldHeader.keyCheck);
  assert.notEqual(newHeader.kdf.salt, oldHeader.kdf.salt);
  assert.equal((await store.readRecord('catalogue')).toString(), 'Synthetic confidential catalogue');
  await store.writeRecord('still-usable', Buffer.from('After changing the password'));
  for (const name of await fs.promises.readdir(directory)) {
    const bytes = await fs.promises.readFile(path.join(directory, name));
    assert.equal(bytes.includes(password), false);
    assert.equal(bytes.includes(replacement), false);
    assert.equal(name.endsWith('.pending'), false);
    assert.notEqual(name, PRIVATE_HUB_HEADER_FILE + '.bak');
  }
  await store.lock();
  await assert.rejects(PrivateHubStore.open(directory, password));
  await openAndRead(directory, replacement);
});

test('an incorrect current password is read-only and leaves the active store usable', async t => {
  const { directory, store } = await fixture(t);
  const before = await fingerprint(directory);
  assert.equal(await store.changePassword('wrong password', replacement, current), 'incorrect-password');
  assert.equal(store.locked, false);
  assert.deepEqual(await fingerprint(directory), before);
  assert.equal((await store.readRecord('catalogue')).toString(), 'Synthetic confidential catalogue');
  assert.equal(await store.changePassword(password, replacement, current), 'changed');
});

test('invalid credentials are rejected before any password derivation or filesystem operation', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const unlock = t.mock.method(crypto, 'unlockPrivateHub', async () => { throw new Error('Must not derive'); });
  const invalid: unknown[] = ['', null, undefined, {}, 2, 'a'.repeat(1025), '🔒'.repeat(257), '\ud800', '\udc00', '\ud800a'];
  for (const value of invalid) {
    await assert.rejects(store.changePassword(value as string, replacement, current), /unavailable/);
    await assert.rejects(store.changePassword(password, value as string, current), /unavailable/);
  }
  await assert.rejects(store.changePassword(password, replacement, null), /unavailable/);
  assert.equal(unlock.mock.callCount(), 0);
  assert.equal(store.locked, false);
  assert.deepEqual(await fingerprint(directory), before);
});

test('at most one credential operation may be admitted, including while its KDF awaits', async t => {
  const { store } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const original = crypto.unlockPrivateHub;
  const unlock = t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof original>) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const first = store.changePassword(password, replacement, current);
  await entered.promise;
  await assert.rejects(store.changePassword(password, 'second change', current), /unavailable/);
  assert.equal(unlock.mock.callCount(), 1);
  release.resolve();
  assert.equal(await first, 'changed');
});

test('password changes wait behind record operations and locking rejects a queued change before deriving', async t => {
  const { store, directory } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const originalOpen = fs.promises.open;
  const open = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('.sealed')) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof read>) => {
        entered.resolve();
        await release.promise;
        return read(...readArgs);
      });
    }
    return handle;
  });
  const reading = assert.rejects(store.readRecord('catalogue'));
  await entered.promise;
  const unlock = t.mock.method(crypto, 'unlockPrivateHub', async () => { throw new Error('Must not derive'); });
  const changing = assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  const locking = store.lock();
  release.resolve();
  await Promise.all([reading, changing, locking]);
  assert.equal(unlock.mock.callCount(), 0);
  unlock.mock.restore();
  open.mock.restore();
  await openAndRead(directory, password);
});

test('the authenticated comparison key is wiped before rewrapping starts', async t => {
  const { store } = await fixture(t);
  const originalUnlock = crypto.unlockPrivateHub;
  const originalChange = crypto.changePrivateHubPassword;
  let comparedKey: Buffer;
  t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof originalUnlock>) => {
    comparedKey = await originalUnlock(...args);
    return comparedKey;
  });
  t.mock.method(crypto, 'changePrivateHubPassword', async (...args: Parameters<typeof originalChange>) => {
    assert.ok(comparedKey.every(byte => byte === 0));
    return originalChange(...args);
  });
  assert.equal(await store.changePassword(password, replacement, current), 'changed');
  assert.ok(comparedKey.every(byte => byte === 0));
});

test('a returned key that does not belong to the owned session is wiped and cannot replace the header', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const wrong = Buffer.alloc(32, 7);
  t.mock.method(crypto, 'unlockPrivateHub', async () => wrong);
  await assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  assert.ok(wrong.every(byte => byte === 0));
  assert.deepEqual(await fingerprint(directory), before);
});

test('locking during authentication drains the pending operation, wipes the returned key, and leaves the old password', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const entered = deferred();
  const release = deferred();
  const original = crypto.unlockPrivateHub;
  let key: Buffer;
  const unlock = t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof original>) => {
    key = await original(...args);
    entered.resolve();
    await release.promise;
    return key;
  });
  const changing = assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  await entered.promise;
  let drained = false;
  const locking = store.lock().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release.resolve();
  await Promise.all([changing, locking]);
  assert.ok(key.every(byte => byte === 0));
  assert.deepEqual(await fingerprint(directory), before);
  unlock.mock.restore();
  await openAndRead(directory, password);
});

test('revoked authority during rewrapping prevents publication', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const entered = deferred();
  const release = deferred();
  const original = crypto.changePrivateHubPassword;
  let authorized = true;
  t.mock.method(crypto, 'changePrivateHubPassword', async (...args: Parameters<typeof original>) => {
    const changed = await original(...args);
    entered.resolve();
    await release.promise;
    return changed;
  });
  const changing = assert.rejects(store.changePassword(password, replacement, () => authorized), /unavailable/);
  await entered.promise;
  authorized = false;
  release.resolve();
  await changing;
  assert.deepEqual(await fingerprint(directory), before);
});

test('an authority callback that throws fails closed without deriving or modifying the header', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const unlock = t.mock.method(crypto, 'unlockPrivateHub', async () => { throw new Error('Must not derive'); });
  await assert.rejects(store.changePassword(password, replacement, () => { throw new Error('revoked'); }));
  assert.equal(unlock.mock.callCount(), 0);
  assert.deepEqual(await fingerprint(directory), before);
});

test('an on-disk header replaced during authentication is never overwritten', async t => {
  const { store, directory, header } = await fixture(t);
  const original = crypto.unlockPrivateHub;
  const existing = await fs.promises.readFile(header);
  const changed = Buffer.concat([existing, Buffer.from('\n')]);
  t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof original>) => {
    const key = await original(...args);
    await fs.promises.writeFile(header, changed);
    return key;
  });
  await assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  assert.deepEqual(await fs.promises.readFile(header), changed);
  assert.equal((await fs.promises.readdir(directory)).some(name => name.endsWith('.pending')), false);
});

test('a linked header is refused without reading or changing its target', async t => {
  const { store, header, root } = await fixture(t);
  const outside = path.join(root, 'unrelated-header');
  await fs.promises.writeFile(outside, 'Unrelated private data');
  await fs.promises.unlink(header);
  await fs.promises.symlink(outside, header);
  await assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  assert.equal(await fs.promises.readFile(outside, 'utf8'), 'Unrelated private data');
  assert.ok((await fs.promises.lstat(header)).isSymbolicLink());
});

test('existing unexplained header backups and staging files are preserved and block a successful change', async t => {
  const { store, header, directory } = await fixture(t);
  const bytes = await fs.promises.readFile(header);
  for (const suffix of ['.bak', '.' + 'a'.repeat(48) + '.pending']) {
    const stale = header + suffix;
    await fs.promises.writeFile(stale, bytes);
    const before = await fingerprint(directory);
    await assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
    assert.deepEqual(await fingerprint(directory), before);
    await fs.promises.unlink(stale);
  }
  assert.equal(await store.changePassword(password, replacement, current), 'changed');
});

test('an atomic rename failure locks the store, removes its new staging file, and preserves the old password', async t => {
  const { store, header, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const original = fs.promises.rename;
  const rename = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    if (target === header) { throw new Error('Synthetic publication failure'); }
    return original(source, target);
  });
  await assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  assert.equal(store.locked, true);
  await store.lock();
  assert.deepEqual(await fingerprint(directory), before);
  rename.mock.restore();
  await openAndRead(directory, password);
});

test('locking after rename is admitted prevents late success but drains an OS publication that may complete', async t => {
  const { store, header, directory } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const original = fs.promises.rename;
  const rename = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    if (target === header) {
      entered.resolve();
      await release.promise;
    }
    return original(source, target);
  });
  const changing = assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  await entered.promise;
  let drained = false;
  const locking = store.lock().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  await assert.rejects(PrivateHubStore.open(directory, replacement), /already has an open session/);
  release.resolve();
  await Promise.all([changing, locking]);
  rename.mock.restore();
  await assert.rejects(PrivateHubStore.open(directory, password));
  await openAndRead(directory, replacement);
  assert.equal((await fs.promises.readdir(directory)).some(name => name.endsWith('.pending') || name === PRIVATE_HUB_HEADER_FILE + '.bak'), false);
});

test('authority revoked after atomic publication cannot report success or leave the store unlocked', async t => {
  const { store, header, directory } = await fixture(t);
  const original = fs.promises.rename;
  let authorized = true;
  const rename = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    await original(source, target);
    if (target === header) { authorized = false; }
  });
  await assert.rejects(store.changePassword(password, replacement, () => authorized), /unavailable/);
  assert.equal(store.locked, true);
  await store.lock();
  rename.mock.restore();
  await openAndRead(directory, replacement);
});

test('a replaced published header is not adopted as the new trusted snapshot', async t => {
  const { store, header, directory } = await fixture(t);
  const original = fs.promises.rename;
  const originalHeader = await fs.promises.readFile(header);
  const rename = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    await original(source, target);
    if (target === header) {
      const substitute = header + '.substitute';
      await fs.promises.writeFile(substitute, originalHeader);
      await original(substitute, target);
    }
  });
  await assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  assert.equal(store.locked, true);
  await store.lock();
  rename.mock.restore();
  await openAndRead(directory, password);
});

test('an authorization callback cannot reentrantly admit a second credential operation', async t => {
  const { store } = await fixture(t);
  let reentrant: Promise<void>;
  let calls = 0;
  assert.equal(await store.changePassword(password, replacement, () => {
    if (calls++ === 0) {
      reentrant = assert.rejects(store.changePassword(password, 'Reentrant replacement', current), /unavailable/);
    }
    return true;
  }), 'changed');
  await reentrant;
});

test('header replacement while checking an incorrect password returns unavailable instead of a credential result', async t => {
  const { store, header } = await fixture(t);
  const original = crypto.unlockPrivateHub;
  const changed = Buffer.concat([await fs.promises.readFile(header), Buffer.from('\n')]);
  t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof original>) => {
    try { return await original(...args); }
    catch {
      await fs.promises.writeFile(header, changed);
      throw new Error('Authentication failed');
    }
  });
  await assert.rejects(store.changePassword('Incorrect password', replacement, current), /unavailable/);
  assert.deepEqual(await fs.promises.readFile(header), changed);
});

test('a directory sync failure after publication locks the store without claiming which password survived', { skip: process.platform === 'win32' }, async t => {
  const { store, directory } = await fixture(t);
  const original = fs.promises.open;
  const open = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (args[0] === directory) {
      t.mock.method(handle, 'sync', async () => { throw new Error('Synthetic directory sync failure'); });
    }
    return handle;
  });
  await assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  assert.equal(store.locked, true);
  await store.lock();
  open.mock.restore();
  await openAndRead(directory, replacement);
  assert.equal((await fs.promises.readdir(directory)).some(name => name.endsWith('.pending') || name === PRIVATE_HUB_HEADER_FILE + '.bak'), false);
});
