import * as assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as crypto from './private-hub-crypto.ts';
import { isPrivateHubStoreCleanupFailure, PRIVATE_HUB_HEADER_FILE, PrivateHubStore } from './private-hub-store.ts';
import { createPrivateTouchIdCleanupFailure, isPrivateTouchIdCleanupFailure, type PrivateTouchIdProvider } from './private-touch-id.ts';

const password = 'Synthetic original recovery password';
const replacement = 'Synthetic interrupted replacement password 🔒';
const current = (): boolean => true;
const confirm = async (): Promise<boolean> => true;
const pendingSuffix = '.' + 'a'.repeat(48) + '.pending';

async function fixture(t: TestContext): Promise<{ root: string; directory: string; header: string; pending: string; store: PrivateHubStore }> {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..'), '.private-password-resume-test-'));
  const directory = path.join(root, 'hub');
  const store = await PrivateHubStore.create(directory, password);
  t.after(async () => {
    await store.lock().catch(error => {
      if (!isPrivateTouchIdCleanupFailure(error) && !isPrivateHubStoreCleanupFailure(error)) { throw error; }
    });
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  await store.writeRecord('catalogue', Buffer.from('Synthetic catalogue before edit'));
  await store.writeRecord('catalogue', Buffer.from('Synthetic current catalogue'));
  await store.writeRecord('preview:synthetic', Buffer.from('Synthetic private preview'));
  const header = path.join(directory, PRIVATE_HUB_HEADER_FILE);
  const saved = JSON.parse(await fs.promises.readFile(header, 'utf8'));
  const key = await crypto.unlockPrivateHub(saved, password);
  const pending = header + pendingSuffix;
  try {
    const staged = await crypto.changePrivateHubPassword(saved, key, replacement);
    await fs.promises.writeFile(pending, JSON.stringify(staged), { flag: 'wx', mode: 0o600 });
  } finally { key.fill(0); }
  return { root, directory, header, pending, store };
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    const target = path.join(directory, name);
    const stat = await fs.promises.lstat(target);
    result[name] = stat.isSymbolicLink() ? 'link:' + await fs.promises.readlink(target)
      : stat.isFile() ? createHash('sha256').update(await fs.promises.readFile(target)).digest('hex') : 'directory';
  }
  return result;
}

async function openAndRead(directory: string, credential: string): Promise<void> {
  const reopened = await PrivateHubStore.open(directory, credential);
  try {
    assert.equal((await reopened.readRecord('catalogue')).toString(), 'Synthetic current catalogue');
    assert.equal((await reopened.readBackupRecord('catalogue')).toString(), 'Synthetic catalogue before edit');
    assert.equal((await reopened.readRecord('preview:synthetic')).toString(), 'Synthetic private preview');
  } finally { await reopened.lock(); }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('resumption adopts the authenticated staged inode and preserves catalogue, backups and previews', async t => {
  const { directory, header, pending, store } = await fixture(t);
  const before = await fingerprint(directory);
  const inode = await fs.promises.stat(pending);
  let confirmations = 0;
  assert.equal(await store.resumePasswordChange(password, replacement, current, async () => {
    confirmations++;
    assert.deepEqual(await fingerprint(directory), before);
    return true;
  }), 'changed');
  assert.equal(confirmations, 1);
  const after = await fingerprint(directory);
  assert.equal(after[PRIVATE_HUB_HEADER_FILE], before[path.basename(pending)]);
  assert.equal((await fs.promises.stat(header)).ino, inode.ino);
  for (const name of Object.keys(before)) {
    if (name !== PRIVATE_HUB_HEADER_FILE && name !== path.basename(pending)) { assert.equal(after[name], before[name]); }
  }
  assert.equal(Object.hasOwn(after, path.basename(pending)), false);
  assert.equal(Object.hasOwn(after, PRIVATE_HUB_HEADER_FILE + '.bak'), false);
  assert.equal((await store.readRecord('catalogue')).toString(), 'Synthetic current catalogue');
  await store.writeRecord('after-recovery', Buffer.from('A successful later save'));
  await store.lock();
  await assert.rejects(PrivateHubStore.open(directory, password));
  await openAndRead(directory, replacement);
});

test('a missing staging file returns not-found only after authenticating the saved password', async t => {
  const { directory, pending, store } = await fixture(t);
  await fs.promises.unlink(pending);
  const before = await fingerprint(directory);
  const unexpected = async (): Promise<boolean> => { assert.fail('No confirmation without a staged credential'); };
  assert.equal(await store.resumePasswordChange('wrong old password', replacement, current, unexpected), 'incorrect-password');
  assert.equal(await store.resumePasswordChange(password, replacement, current, unexpected), 'not-found');
  assert.deepEqual(await fingerprint(directory), before);
  assert.equal(store.locked, false);
});

for (const [label, oldCredential, newCredential] of [
  ['current', 'incorrect current password', replacement], ['replacement', password, 'incorrect new password'],
]) {
  test(`an incorrect ${label} password neither confirms nor changes any file`, async t => {
    const { directory, store } = await fixture(t);
    const before = await fingerprint(directory);
    assert.equal(await store.resumePasswordChange(oldCredential, newCredential, current, async () => {
      assert.fail('Incorrect credentials must not reach confirmation');
    }), 'incorrect-password');
    assert.deepEqual(await fingerprint(directory), before);
    assert.equal(store.locked, false);
  });
}

test('invalid inputs, identical passwords and invalid callbacks do not derive a key', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const unlock = t.mock.method(crypto, 'unlockPrivateHub', async () => { throw new Error('Unexpected KDF'); });
  for (const input of ['', null, undefined, {}, 'x'.repeat(1025), '\ud800']) {
    await assert.rejects(store.resumePasswordChange(input as string, replacement, current, confirm), /unavailable/);
    await assert.rejects(store.resumePasswordChange(password, input as string, current, confirm), /unavailable/);
  }
  await assert.rejects(store.resumePasswordChange(password, password, current, confirm), /unavailable/);
  await assert.rejects(store.resumePasswordChange(password, replacement, null, confirm), /unavailable/);
  await assert.rejects(store.resumePasswordChange(password, replacement, current, null), /unavailable/);
  assert.equal(unlock.mock.callCount(), 0);
  assert.deepEqual(await fingerprint(directory), before);
});

for (const suffix of ['.' + 'b'.repeat(48) + '.pending', '.bak', '.unknown.pending', '.unexpected']) {
  test(`an additional ${suffix.endsWith('.bak') ? 'backup' : 'header sibling'} blocks recovery without changing files (${suffix.length})`, async t => {
    const { store, directory, header, pending } = await fixture(t);
    await fs.promises.copyFile(pending, header + suffix);
    const before = await fingerprint(directory);
    await assert.rejects(store.resumePasswordChange(password, replacement, current, confirm), /unavailable/);
    assert.deepEqual(await fingerprint(directory), before);
    assert.equal(store.locked, false);
  });
}

for (const kind of ['wrong-hub', 'wrong-key', 'corrupt', 'oversized', 'symlink', 'hardlink', 'directory']) {
  test(`a ${kind} staging candidate fails closed and is preserved`, async t => {
    const { store, directory, root, pending } = await fixture(t);
    if (kind === 'wrong-hub' || kind === 'wrong-key') {
      const unrelated = await crypto.createPrivateHub(replacement);
      try {
        if (kind === 'wrong-key') {
          const saved = JSON.parse(await fs.promises.readFile(pending, 'utf8'));
          // Rebind a valid unrelated data key to the owned hub ID and wrap it.
          unrelated.header.hubId = saved.hubId;
          unrelated.header.keyCheck = createHmac('sha256', unrelated.key).update(JSON.stringify([
            unrelated.header.format, unrelated.header.version, 'key-check', saved.hubId,
          ])).digest('base64');
          const rebound = await crypto.changePrivateHubPassword(unrelated.header, unrelated.key, replacement);
          await fs.promises.writeFile(pending, JSON.stringify(rebound));
        } else { await fs.promises.writeFile(pending, JSON.stringify(unrelated.header)); }
      } finally { unrelated.key.fill(0); }
    } else if (kind === 'corrupt') { await fs.promises.writeFile(pending, '{broken'); }
    else if (kind === 'oversized') { await fs.promises.writeFile(pending, Buffer.alloc(crypto.PRIVATE_HUB_MAX_HEADER_BYTES + 1)); }
    else {
      const source = path.join(root, 'unrelated-staged-credential');
      await fs.promises.rename(pending, source);
      if (kind === 'symlink') { await fs.promises.symlink(source, pending); }
      else if (kind === 'hardlink') { await fs.promises.link(source, pending); }
      else { await fs.promises.mkdir(pending); }
    }
    const before = await fingerprint(directory);
    await assert.rejects(store.resumePasswordChange(password, replacement, current, async () => { assert.fail('Invalid candidate confirmed'); }), /unavailable/);
    assert.deepEqual(await fingerprint(directory), before);
  });
}

test('both comparison keys are wiped before confirmation, and cancellation is read-only', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const keys: Buffer[] = [];
  const original = crypto.unlockPrivateHub;
  t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof original>) => {
    const key = await original(...args);
    keys.push(key);
    return key;
  });
  assert.equal(await store.resumePasswordChange(password, replacement, current, async () => {
    assert.equal(keys.length, 2);
    assert.ok(keys.every(key => key.every(byte => byte === 0)));
    return false;
  }), 'cancelled');
  assert.deepEqual(await fingerprint(directory), before);
  assert.equal(store.locked, false);
});

for (const mutation of ['replaced', 'changed-bytes', 'extra-pending', 'extra-backup', 'revoked', 'header-replaced']) {
  test(`confirmation cannot authorize a candidate after ${mutation}`, async t => {
    const { store, directory, header, pending } = await fixture(t);
    let authorized = true;
    let afterConfirmation: Record<string, string>;
    await assert.rejects(store.resumePasswordChange(password, replacement, () => authorized, async () => {
      if (mutation === 'replaced') {
        const substitute = pending + '.substitute';
        await fs.promises.copyFile(pending, substitute);
        await fs.promises.rename(substitute, pending);
      } else if (mutation === 'changed-bytes') {
        await fs.promises.appendFile(pending, '\n');
      } else if (mutation === 'extra-pending') {
        await fs.promises.copyFile(pending, header + '.' + 'b'.repeat(48) + '.pending');
      } else if (mutation === 'extra-backup') {
        await fs.promises.copyFile(header, header + '.bak');
      } else if (mutation === 'header-replaced') {
        await fs.promises.appendFile(header, '\n');
      } else { authorized = false; }
      afterConfirmation = await fingerprint(directory);
      return true;
    }), /unavailable/);
    assert.deepEqual(await fingerprint(directory), afterConfirmation);
  });
}

test('credential operations remain exclusive while confirmation is pending', async t => {
  const { store } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const recovering = store.resumePasswordChange(password, replacement, current, async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  await entered.promise;
  await assert.rejects(store.resumePasswordChange(password, replacement, current, confirm), /unavailable/);
  await assert.rejects(store.changePassword(password, replacement, current), /unavailable/);
  await assert.rejects(store.verifyPassword(password, current), /unavailable/);
  release.resolve();
  assert.equal(await recovering, 'changed');
});

test('locking during confirmation drains it and preserves both credentials without publishing', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  const entered = deferred();
  const release = deferred();
  const recovering = assert.rejects(store.resumePasswordChange(password, replacement, current, async () => {
    entered.resolve();
    await release.promise;
    return true;
  }), /unavailable/);
  await entered.promise;
  let drained = false;
  const locking = store.lock().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  await assert.rejects(PrivateHubStore.open(directory, password), /already has an open session/);
  release.resolve();
  await Promise.all([recovering, locking]);
  assert.deepEqual(await fingerprint(directory), before);
  await openAndRead(directory, password);
});

test('rename failure locks the store and preserves the verified staging credential for retry', async t => {
  const { store, directory, header } = await fixture(t);
  const before = await fingerprint(directory);
  const original = fs.promises.rename;
  const rename = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    if (target === header) { throw new Error('Synthetic publication failure'); }
    return original(source, target);
  });
  await assert.rejects(store.resumePasswordChange(password, replacement, current, confirm), /unavailable/);
  assert.equal(store.locked, true);
  await store.lock();
  rename.mock.restore();
  assert.deepEqual(await fingerprint(directory), before);
  await openAndRead(directory, password);
});

test('directory sync failure after publication locks instead of claiming a durable change', { skip: process.platform === 'win32' }, async t => {
  const { store, directory } = await fixture(t);
  const original = fs.promises.open;
  const open = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (args[0] === directory) { t.mock.method(handle, 'sync', async () => { throw new Error('Synthetic directory sync failure'); }); }
    return handle;
  });
  await assert.rejects(store.resumePasswordChange(password, replacement, current, confirm), /unavailable/);
  assert.equal(store.locked, true);
  await store.lock();
  open.mock.restore();
  await openAndRead(directory, replacement);
});

test('revocation after rename drains submitted publication and prevents late success', async t => {
  const { store, directory, header } = await fixture(t);
  let authorized = true;
  const original = fs.promises.rename;
  const rename = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    await original(source, target);
    if (target === header) { authorized = false; }
  });
  await assert.rejects(store.resumePasswordChange(password, replacement, () => authorized, confirm), /unavailable/);
  assert.equal(store.locked, true);
  await store.lock();
  rename.mock.restore();
  await openAndRead(directory, replacement);
});

test('the verified staging inode is synced before its atomic adoption', async t => {
  const { store, header, pending } = await fixture(t);
  const originalOpen = fs.promises.open;
  const originalRename = fs.promises.rename;
  let synced = false;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === pending) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => { await sync(); synced = true; });
    }
    return handle;
  });
  t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    if (target === header) { assert.equal(synced, true); }
    return originalRename(source, target);
  });
  assert.equal(await store.resumePasswordChange(password, replacement, current, confirm), 'changed');
});

test('a staging sync failure preserves both files without starting publication', async t => {
  const { store, directory, pending } = await fixture(t);
  const before = await fingerprint(directory);
  const original = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (args[0] === pending) {
      t.mock.method(handle, 'sync', async () => { throw new Error('Synthetic staging sync failure'); });
    }
    return handle;
  });
  await assert.rejects(store.resumePasswordChange(password, replacement, current, confirm), /unavailable/);
  assert.deepEqual(await fingerprint(directory), before);
  assert.equal(store.locked, false);
});

test('uncertain staging handle cleanup locks and quarantines the hub without publishing', async t => {
  const { store, directory, pending } = await fixture(t);
  const before = await fingerprint(directory);
  const original = fs.promises.open;
  const open = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (args[0] === pending) {
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      let synced = false;
      t.mock.method(handle, 'sync', async () => { await sync(); synced = true; });
      t.mock.method(handle, 'close', async () => {
        await close();
        if (synced) { throw new Error('Synthetic unconfirmed handle close'); }
      });
    }
    return handle;
  });
  await assert.rejects(store.resumePasswordChange(password, replacement, current, confirm), isPrivateHubStoreCleanupFailure);
  assert.equal(store.locked, true);
  await assert.rejects(store.lock(), isPrivateHubStoreCleanupFailure);
  open.mock.restore();
  assert.deepEqual(await fingerprint(directory), before);
  await assert.rejects(PrivateHubStore.open(directory, password), isPrivateHubStoreCleanupFailure);
});

for (const stage of [1, 2]) {
  test(`locking during password authentication ${stage} drains and wipes the returned key`, async t => {
    const { store, directory } = await fixture(t);
    const before = await fingerprint(directory);
    const entered = deferred();
    const release = deferred();
    const original = crypto.unlockPrivateHub;
    let captured: Buffer;
    let calls = 0;
    const unlock = t.mock.method(crypto, 'unlockPrivateHub', async (...args: Parameters<typeof original>) => {
      const key = await original(...args);
      if (++calls === stage) {
        captured = key;
        entered.resolve();
        await release.promise;
      }
      return key;
    });
    const recovering = assert.rejects(store.resumePasswordChange(password, replacement, current, async () => {
      assert.fail('No confirmation after locking');
    }), /unavailable/);
    await entered.promise;
    let drained = false;
    const locking = store.lock().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    release.resolve();
    await Promise.all([recovering, locking]);
    assert.ok(captured.every(byte => byte === 0));
    unlock.mock.restore();
    assert.deepEqual(await fingerprint(directory), before);
    await openAndRead(directory, password);
  });
}

test('a substituted published inode is not adopted even when it contains valid staged bytes', async t => {
  const { store, directory, header, pending } = await fixture(t);
  const bytes = await fs.promises.readFile(pending);
  const original = fs.promises.rename;
  const rename = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, target: fs.PathLike) => {
    await original(source, target);
    if (target === header) {
      const substitute = header + '.substitute';
      await fs.promises.writeFile(substitute, bytes);
      await original(substitute, header);
    }
  });
  await assert.rejects(store.resumePasswordChange(password, replacement, current, confirm), /unavailable/);
  assert.equal(store.locked, true);
  await store.lock();
  rename.mock.restore();
  await openAndRead(directory, replacement);
});

test('current authority cannot reentrantly admit another credential operation', async t => {
  const { store } = await fixture(t);
  let reentrant: Promise<void>;
  let called = false;
  assert.equal(await store.resumePasswordChange(password, replacement, () => {
    if (!called) {
      called = true;
      reentrant = assert.rejects(store.resumePasswordChange(password, replacement, current, confirm), /unavailable/);
    }
    return true;
  }, confirm), 'changed');
  await reentrant;
});

for (const failure of [false, true]) {
  test(`existing Touch ID removal ${failure ? 'cleanup failure blocks publication' : 'precedes publication'}`, async t => {
    const { store, directory, header } = await fixture(t);
    const before = await fingerprint(directory);
    const saved = JSON.parse(await fs.promises.readFile(header, 'utf8'));
    const identity = crypto.privateHubTouchIdIdentity(saved);
    let confirmed = false;
    let removed = false;
    const device: PrivateTouchIdProvider = {
      availability: async () => 'available',
      enroll: async () => { assert.fail('No enrollment during password recovery'); },
      unlock: async () => { assert.fail('Both passwords remain mandatory'); },
      has: async value => { assert.equal(value, identity); assert.equal(confirmed, true); return true; },
      remove: async (value, signal) => {
        assert.equal(value, identity);
        assert.equal(signal.aborted, false);
        assert.deepEqual(await fingerprint(directory), before);
        if (failure) { throw createPrivateTouchIdCleanupFailure(); }
        removed = true;
        return true;
      },
    };
    const recovering = store.resumePasswordChange(password, replacement, current, async () => {
      confirmed = true;
      return true;
    }, device);
    if (failure) {
      await assert.rejects(recovering, isPrivateTouchIdCleanupFailure);
      assert.equal(store.locked, true);
      await assert.rejects(store.lock(), isPrivateTouchIdCleanupFailure);
      assert.deepEqual(await fingerprint(directory), before);
    } else {
      assert.equal(await recovering, 'changed');
      assert.equal(removed, true);
    }
  });
}
