import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as privateHubCrypto from './private-hub-crypto.ts';
import {
  PRIVATE_HUB_MAX_HEADER_BYTES,
  PRIVATE_HUB_MAX_SEALED_RECORD_BYTES,
} from './private-hub-crypto.ts';
import { PRIVATE_HUB_LOCK_FILE, PrivateHubLease, PrivateHubLeaseError } from './private-hub-lock.ts';
import { PRIVATE_HUB_HEADER_FILE, PrivateHubStore } from './private-hub-store.ts';

const password = 'Synthetic private hub test passphrase';
const canary = 'PRIVATE-CANARY-source-video-title-personal-note-and-tags';

async function fixture(t: TestContext): Promise<{ root: string; directory: string; store: PrivateHubStore }> {
  // Keep all synthetic filesystem fixtures inside the authorized checkout.
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..'), '.private-hub-store-test-'));
  const directory = path.join(root, 'vault');
  const store = await PrivateHubStore.create(directory, password);
  t.after(async () => {
    await store.lock();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, directory, store };
}

async function primaryPath(directory: string): Promise<string> {
  const names = (await fs.promises.readdir(directory)).filter(name => name.endsWith('.sealed'));
  assert.equal(names.length, 1);
  return path.join(directory, names[0]);
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    result[name] = createHash('sha256').update(await fs.promises.readFile(path.join(directory, name))).digest('hex');
  }
  return result;
}

test('creates opaque private records, round trips bytes, and reopens without exposing plaintext', async t => {
  const { directory, store } = await fixture(t);
  const payload = Buffer.from(canary);
  await store.writeRecord('catalogue', payload);
  assert.deepEqual(await store.readRecord('catalogue'), payload);
  assert.deepEqual(payload, Buffer.from(canary), 'writing never wipes or mutates caller-owned data');
  const names = await fs.promises.readdir(directory);
  assert.equal(names.length, 3);
  assert.ok(names.includes(PRIVATE_HUB_HEADER_FILE));
  assert.ok(names.some(name => /^[0-9a-f]{64}\.sealed$/.test(name)));
  for (const name of names) {
    const contents = await fs.promises.readFile(path.join(directory, name));
    assert.equal(contents.includes(canary), false);
    if (process.platform !== 'win32') {
      assert.equal((await fs.promises.stat(path.join(directory, name))).mode & 0o777, 0o600);
    }
  }
  if (process.platform !== 'win32') {
    assert.equal((await fs.promises.stat(directory)).mode & 0o777, 0o700);
  }
  const originalFiles = await fingerprint(directory);
  await store.lock();
  const reopened = await PrivateHubStore.open(directory, password);
  try {
    assert.equal(reopened.hubId, store.hubId);
    assert.deepEqual(await reopened.readRecord('catalogue'), payload);
    assert.deepEqual(await fingerprint(directory), originalFiles);
  } finally {
    await reopened.lock();
  }
});

test('wrong passwords are read-only and do not prevent a later correct unlock', async t => {
  const { directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  await store.lock();
  const before = await fingerprint(directory);
  await assert.rejects(PrivateHubStore.open(directory, 'wrong password'));
  assert.deepEqual(await fingerprint(directory), before);
  const reopened = await PrivateHubStore.open(directory, password);
  await reopened.lock();
});

test('existing directories and concurrent sessions are refused without overwriting data', async t => {
  const { root, directory, store } = await fixture(t);
  await assert.rejects(PrivateHubStore.open(directory, password), /already has an open session/);
  const before = await fingerprint(directory);
  await assert.rejects(PrivateHubStore.create(directory, password), { code: 'EEXIST' });
  assert.deepEqual(await fingerprint(directory), before);
  const existing = path.join(root, 'ordinary-folder');
  await fs.promises.mkdir(existing);
  await fs.promises.writeFile(path.join(existing, 'keep.txt'), 'Unrelated user file');
  await assert.rejects(PrivateHubStore.create(existing, password), { code: 'EEXIST' });
  assert.deepEqual(await fs.promises.readdir(existing), ['keep.txt']);
  assert.equal(await fs.promises.readFile(path.join(existing, 'keep.txt'), 'utf8'), 'Unrelated user file');
  await store.writeRecord('catalogue', Buffer.from('still usable'));
});

test('replacement preserves an authenticated encrypted backup and recovery is explicit', async t => {
  const { directory, store } = await fixture(t);
  const first = Buffer.from(canary + '-first');
  const second = Buffer.from(canary + '-second');
  await store.writeRecord('catalogue', first);
  const primary = await primaryPath(directory);
  const firstCiphertext = await fs.promises.readFile(primary);
  await store.writeRecord('catalogue', second);
  assert.deepEqual(await store.readRecord('catalogue'), second);
  assert.deepEqual(await store.readBackupRecord('catalogue'), first);
  assert.deepEqual(await fs.promises.readFile(primary + '.bak'), firstCiphertext);
  assert.equal(firstCiphertext.includes(canary), false);
  const damaged = await fs.promises.readFile(primary);
  damaged[damaged.length - 1] ^= 1;
  await fs.promises.writeFile(primary, damaged);
  const before = await fingerprint(directory);
  await assert.rejects(store.readRecord('catalogue'));
  await assert.rejects(store.writeRecord('catalogue', Buffer.from('must not replace corrupt data')));
  assert.deepEqual(await fingerprint(directory), before);
  await store.recoverRecord('catalogue');
  assert.deepEqual(await store.readRecord('catalogue'), first);
  assert.deepEqual(await store.readBackupRecord('catalogue'), first);
});

test('missing primary and damaged backup are never silently overwritten', async t => {
  const { directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from('first'));
  await store.writeRecord('catalogue', Buffer.from('second'));
  const primary = await primaryPath(directory);
  await fs.promises.unlink(primary);
  await assert.rejects(store.writeRecord('catalogue', Buffer.from('third')), /explicitly recover/);
  await store.recoverRecord('catalogue');
  assert.equal((await store.readRecord('catalogue')).toString(), 'first');
  await fs.promises.writeFile(primary + '.bak', Buffer.from('invalid ciphertext'));
  const before = await fingerprint(directory);
  await assert.rejects(store.writeRecord('catalogue', Buffer.from('fourth')));
  await assert.rejects(store.recoverRecord('catalogue'));
  assert.deepEqual(await fingerprint(directory), before);
});

test('an interrupted replacement leaves the old primary and encrypted backup intact', async t => {
  const { directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  const primary = await primaryPath(directory);
  const oldCiphertext = await fs.promises.readFile(primary);
  const originalRename = fs.promises.rename;
  const renameMock = t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, destination: fs.PathLike) => {
    if (destination === primary) {
      const stagedBytes = await fs.promises.readFile(source);
      assert.equal(stagedBytes.includes(canary), false);
      throw Object.assign(new Error('Synthetic interrupted replacement'), { code: 'EIO' });
    }
    return originalRename(source, destination);
  });
  await assert.rejects(store.writeRecord('catalogue', Buffer.from(canary + '-replacement')), /Synthetic interrupted/);
  renameMock.mock.restore();
  assert.deepEqual(await fs.promises.readFile(primary), oldCiphertext);
  assert.deepEqual(await fs.promises.readFile(primary + '.bak'), oldCiphertext);
  assert.equal((await fs.promises.readdir(directory)).some(name => name.endsWith('.pending')), false);
  assert.equal((await store.readRecord('catalogue')).toString(), canary);
});

test('lock immediately rejects queued work and discards a pending read before decryption', async t => {
  const { directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  const primary = await primaryPath(directory);
  const before = await fingerprint(directory);
  let releaseRead: () => void;
  let enteredRead: () => void;
  const hold = new Promise<void>(resolve => { releaseRead = resolve; });
  const entered = new Promise<void>(resolve => { enteredRead = resolve; });
  const originalOpen = fs.promises.open;
  const openMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === primary) {
      const originalRead = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof handle.read>) => {
        enteredRead();
        await hold;
        return originalRead(...readArgs);
      });
    }
    return handle;
  });
  const read = assert.rejects(store.readRecord('catalogue'), /locked/);
  await entered;
  const write = assert.rejects(store.writeRecord('catalogue', Buffer.from('queued plaintext')), /locked/);
  const lock = store.lock();
  assert.equal(store.locked, true);
  await assert.rejects(store.readRecord('catalogue'), /locked/);
  await assert.rejects(store.writeRecord('catalogue', Buffer.from('new plaintext')), /locked/);
  await assert.rejects(store.readBackupRecord('catalogue'), /locked/);
  await assert.rejects(store.recoverRecord('catalogue'), /locked/);
  await assert.rejects(PrivateHubStore.open(directory, password), /already has an open session/);
  releaseRead();
  await Promise.all([read, write, lock]);
  openMock.mock.restore();
  assert.deepEqual(await fingerprint(directory), before);
  const reopened = await PrivateHubStore.open(directory, password);
  await reopened.lock();
});

test('rejects path traversal identifiers, root aliases, linked records, and replaced directories', async t => {
  const { root, directory, store } = await fixture(t);
  for (const id of ['../outside', '/absolute', '..', '.', 'preview\\outside', 'control\0', '', 'x'.repeat(257)]) {
    await assert.rejects(store.writeRecord(id, Buffer.from(canary)), /identifier/);
  }
  await store.writeRecord('catalogue', Buffer.from(canary));
  const primary = await primaryPath(directory);
  const alias = path.join(root, 'alias');
  await fs.promises.symlink(directory, alias, 'dir');
  await assert.rejects(PrivateHubStore.open(alias, password), /symbolic links/);
  const external = path.join(root, 'unrelated.txt');
  await fs.promises.writeFile(external, 'Unrelated data');
  await fs.promises.unlink(primary);
  await fs.promises.symlink(external, primary);
  await assert.rejects(store.readRecord('catalogue'), /regular files/);
  await assert.rejects(store.writeRecord('catalogue', Buffer.from(canary)), /regular files/);
  assert.equal(await fs.promises.readFile(external, 'utf8'), 'Unrelated data');
  await fs.promises.unlink(primary);
  await fs.promises.link(external, primary);
  await assert.rejects(store.readRecord('catalogue'), /regular files/);
  await assert.rejects(store.writeRecord('catalogue', Buffer.from(canary)), /regular files/);
  await fs.promises.rename(directory, path.join(root, 'original-vault'));
  await fs.promises.mkdir(directory);
  await assert.rejects(store.writeRecord('catalogue', Buffer.from(canary)), /directory was replaced/);
  assert.deepEqual(await fs.promises.readdir(directory), []);
});

test('rejects oversized sparse records and headers before allocating their declared contents', async t => {
  const { directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  const primary = await primaryPath(directory);
  await fs.promises.truncate(primary, PRIVATE_HUB_MAX_SEALED_RECORD_BYTES + 1);
  await assert.rejects(store.readRecord('catalogue'), /size limit/);
  await assert.rejects(store.writeRecord('catalogue', Buffer.from('replacement')), /size limit/);
  await store.lock();
  await fs.promises.truncate(path.join(directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES + 1);
  await assert.rejects(PrivateHubStore.open(directory, password), /size limit/);
});

test('linked headers and backups are rejected without following their targets', async t => {
  const { root, directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  const primary = await primaryPath(directory);
  const external = path.join(root, 'unrelated.txt');
  await fs.promises.writeFile(external, 'Unrelated data');
  await fs.promises.symlink(external, primary + '.bak');
  await assert.rejects(store.writeRecord('catalogue', Buffer.from('replacement')), /regular files/);
  await assert.rejects(store.recoverRecord('catalogue'), /regular files/);
  await store.lock();
  const header = path.join(directory, PRIVATE_HUB_HEADER_FILE);
  await fs.promises.unlink(header);
  await fs.promises.symlink(external, header);
  await assert.rejects(PrivateHubStore.open(directory, password), /regular files/);
  assert.equal(await fs.promises.readFile(external, 'utf8'), 'Unrelated data');
});

test('lock at the post-decryption promise boundary wipes the unreturned plaintext', async t => {
  const { store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  const originalDecrypt = privateHubCrypto.decryptPrivateHubRecord;
  let decrypted: Buffer | undefined;
  const decryptMock = t.mock.method(privateHubCrypto, 'decryptPrivateHubRecord', (...args: Parameters<typeof originalDecrypt>) => {
    decrypted = originalDecrypt(...args);
    queueMicrotask(() => { void store.lock(); });
    return decrypted;
  });
  await assert.rejects(store.readRecord('catalogue'), /locked/);
  decryptMock.mock.restore();
  await store.lock();
  assert.ok(decrypted);
  assert.ok(decrypted.every(byte => byte === 0));
});

test('header replacement during unlock is rejected and the discarded key is wiped', async t => {
  const { directory, store } = await fixture(t);
  await store.lock();
  const headerPath = path.join(directory, PRIVATE_HUB_HEADER_FILE);
  const originalHeader = await fs.promises.readFile(headerPath);
  const originalUnlock = privateHubCrypto.unlockPrivateHub;
  let discardedKey: Buffer | undefined;
  const unlockMock = t.mock.method(privateHubCrypto, 'unlockPrivateHub', async (...args: Parameters<typeof originalUnlock>) => {
    discardedKey = await originalUnlock(...args);
    await fs.promises.writeFile(headerPath, Buffer.concat([originalHeader, Buffer.from('\n')]));
    return discardedKey;
  });
  await assert.rejects(PrivateHubStore.open(directory, password), /header changed during unlock/);
  unlockMock.mock.restore();
  assert.ok(discardedKey);
  assert.ok(discardedKey.every(byte => byte === 0));
  const reopened = await PrivateHubStore.open(directory, password);
  try {
    await fs.promises.writeFile(headerPath, originalHeader);
    await assert.rejects(reopened.writeRecord('catalogue', Buffer.from(canary)), /header changed/);
    await assert.rejects(reopened.readRecord('catalogue'), /header changed/);
    assert.deepEqual((await fs.promises.readdir(directory)).sort(), [PRIVATE_HUB_LOCK_FILE, PRIVATE_HUB_HEADER_FILE].sort());
  } finally {
    await reopened.lock();
  }
});

test('file-handle stat failure closes the staging handle and never writes plaintext', async t => {
  const { directory, store } = await fixture(t);
  const originalOpen = fs.promises.open;
  let closed = false;
  const openMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('.pending')) {
      t.mock.method(handle, 'stat', async () => { throw new Error('Synthetic stat failure'); });
      const originalClose = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        closed = true;
        return originalClose();
      });
    }
    return handle;
  });
  await assert.rejects(store.writeRecord('catalogue', Buffer.from(canary)), /Synthetic stat failure/);
  openMock.mock.restore();
  assert.equal(closed, true);
  for (const name of await fs.promises.readdir(directory)) {
    assert.equal((await fs.promises.readFile(path.join(directory, name))).includes(canary), false);
  }
  await store.writeRecord('catalogue', Buffer.from(canary));
  assert.equal((await store.readRecord('catalogue')).toString(), canary);
});

test('a simulated crash between exclusive publication and unlink fails closed without deleting aliases', async t => {
  const { directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  const primary = await primaryPath(directory);
  await store.lock();
  const pending = path.join(directory, 'synthetic-interrupted-publication.pending');
  await fs.promises.link(primary, pending);
  const before = await fingerprint(directory);
  const reopened = await PrivateHubStore.open(directory, password);
  try {
    await assert.rejects(reopened.readRecord('catalogue'), /regular files/);
    await assert.rejects(reopened.writeRecord('catalogue', Buffer.from('replacement')), /regular files/);
    assert.deepEqual(await fingerprint(directory), before);
  } finally {
    await reopened.lock();
  }
  const header = path.join(directory, PRIVATE_HUB_HEADER_FILE);
  await fs.promises.link(header, path.join(directory, 'synthetic-interrupted-header.pending'));
  const headerState = await fingerprint(directory);
  await assert.rejects(PrivateHubStore.open(directory, password), /regular files/);
  assert.deepEqual(await fingerprint(directory), headerState);
});

test('operation backpressure rejects excess queued work and releases the queue after lock', async t => {
  const { store } = await fixture(t);
  const accepted = Array.from({ length: 32 }, (_, index) => assert.rejects(
    store.writeRecord('queued:' + index, Buffer.from(canary)), /locked/,
  ));
  await assert.rejects(store.writeRecord('excess', Buffer.from(canary)), /queue is full/);
  const locking = store.lock();
  await Promise.all([...accepted, locking]);
  assert.equal(store.locked, true);
});

test('a header changed during creation is not adopted with the original key', async t => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'new-vault');
  const originalCreate = privateHubCrypto.createPrivateHub;
  let discardedKey: Buffer | undefined;
  const createMock = t.mock.method(privateHubCrypto, 'createPrivateHub', async (...args: Parameters<typeof originalCreate>) => {
    const result = await originalCreate(...args);
    discardedKey = result.key;
    return result;
  });
  const originalLink = fs.promises.link;
  const linkMock = t.mock.method(fs.promises, 'link', async (...args: Parameters<typeof originalLink>) => {
    await originalLink(...args);
    if (String(args[1]) === path.join(directory, PRIVATE_HUB_HEADER_FILE)) {
      const published = await fs.promises.readFile(args[1]);
      await fs.promises.writeFile(args[1], Buffer.concat([published, Buffer.from('\n')]));
    }
  });
  await assert.rejects(PrivateHubStore.create(directory, password), /header changed before verification/);
  linkMock.mock.restore();
  createMock.mock.restore();
  assert.ok(discardedKey);
  assert.ok(discardedKey.every(byte => byte === 0));
  const reopened = await PrivateHubStore.open(directory, password);
  await reopened.lock();
});

test('authenticated interrupted header and record publications recover only their recognized aliases', async t => {
  const { directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  const primary = await primaryPath(directory);
  await store.lock();
  const header = path.join(directory, PRIVATE_HUB_HEADER_FILE);
  const headerAlias = header + '.' + 'a'.repeat(48) + '.pending';
  const recordAlias = primary + '.' + 'b'.repeat(48) + '.pending';
  await fs.promises.link(header, headerAlias);
  await fs.promises.link(primary, recordAlias);
  const unrelated = primary + '.' + 'c'.repeat(48) + '.pending';
  await fs.promises.writeFile(unrelated, 'unrelated encrypted staging bytes');
  const before = await fingerprint(directory);
  await assert.rejects(PrivateHubStore.open(directory, 'wrong password'));
  assert.deepEqual(await fingerprint(directory), before);
  const reopened = await PrivateHubStore.open(directory, password);
  try {
    await assert.rejects(fs.promises.stat(headerAlias), { code: 'ENOENT' });
    assert.equal((await fs.promises.stat(primary)).nlink, 2, 'record repair is deferred until authentication');
    assert.equal((await reopened.readRecord('catalogue')).toString(), canary);
    await assert.rejects(fs.promises.stat(recordAlias), { code: 'ENOENT' });
    assert.equal((await fs.promises.stat(primary)).nlink, 1);
    assert.equal(await fs.promises.readFile(unrelated, 'utf8'), 'unrelated encrypted staging bytes');
    await reopened.writeRecord('catalogue', Buffer.from('next revision'));
    assert.equal((await reopened.readBackupRecord('catalogue')).toString(), canary);
  } finally {
    await reopened.lock();
  }
});

test('damaged ciphertext and external publication aliases are preserved without repair', async t => {
  const { root, directory, store } = await fixture(t);
  await store.writeRecord('catalogue', Buffer.from(canary));
  const primary = await primaryPath(directory);
  const alias = primary + '.' + 'a'.repeat(48) + '.pending';
  const sealed = await fs.promises.readFile(primary);
  sealed[sealed.length - 1] ^= 1;
  await fs.promises.writeFile(primary, sealed);
  await fs.promises.link(primary, alias);
  let before = await fingerprint(directory);
  await assert.rejects(store.readRecord('catalogue'));
  await assert.rejects(store.writeRecord('catalogue', Buffer.from('replacement')));
  assert.deepEqual(await fingerprint(directory), before);
  const external = path.join(root, 'external-alias');
  await fs.promises.link(primary, external);
  before = await fingerprint(directory);
  await assert.rejects(store.readRecord('catalogue'), /regular files/);
  assert.deepEqual(await fingerprint(directory), before);
  assert.deepEqual(await fs.promises.readFile(external), sealed);
});

test('bounded reads reject oversize records before decrypting and immutable writes preserve existing data', async t => {
  const { directory, store } = await fixture(t);
  await store.writeNewRecord('catalogue', Buffer.from(canary));
  const before = await fingerprint(directory);
  await assert.rejects(store.writeNewRecord('catalogue', Buffer.from('replacement')), /already exists/);
  assert.deepEqual(await fingerprint(directory), before);
  const decryptMock = t.mock.method(privateHubCrypto, 'decryptPrivateHubRecord');
  await assert.rejects(store.readRecord('catalogue', 4), /size limit/);
  assert.equal(decryptMock.mock.callCount(), 0);
  decryptMock.mock.restore();
  assert.equal((await store.readRecord('catalogue', Buffer.byteLength(canary))).toString(), canary);
  for (const maximum of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(store.readRecord('catalogue', maximum), /read limit/);
  }
  await store.writeRecord('catalogue', Buffer.from('new'));
  await fs.promises.unlink(await primaryPath(directory));
  await assert.rejects(store.writeNewRecord('catalogue', Buffer.from('replacement')), /already exists/);
});

test('unexpected helper death locks the store, aborts consumers and prevents queued reads', async t => {
  const originalSpawn = childProcess.spawn;
  let helper: childProcess.ChildProcess | undefined;
  const spawnMock = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    helper = originalSpawn(...args);
    return helper;
  });
  const { directory, store } = await fixture(t);
  spawnMock.mock.restore();
  await store.writeRecord('catalogue', Buffer.from(canary));
  const abort = once(store.lockSignal, 'abort');
  helper!.kill('SIGKILL');
  await abort;
  assert.equal(store.locked, true);
  await assert.rejects(store.readRecord('catalogue'), /locked/);
  await assert.rejects(store.writeRecord('catalogue', Buffer.from('after helper failure')), /locked/);
  await store.lock();
  const reopened = await PrivateHubStore.open(directory, password);
  assert.equal((await reopened.readRecord('catalogue')).toString(), canary);
  await reopened.lock();
});

test('a killed writer between hard-link publication and unlink reopens and recovers authenticated content', async t => {
  const { directory, store } = await fixture(t);
  await store.lock();
  const root = path.resolve(__dirname, '..');
  const writer = childProcess.spawn(process.execPath, [
    '-r', require.resolve('ts-node/register'), '-e', `
      const fs = require('node:fs');
      const { PrivateHubStore } = require('./node/private-hub-store.ts');
      process.once('message', async ({ directory, password, canary }) => {
        const store = await PrivateHubStore.open(directory, password);
        const unlink = fs.promises.unlink;
        fs.promises.unlink = async file => {
          if (String(file).endsWith('.pending')) {
            process.send({ published: true });
            await new Promise(() => {});
          }
          return unlink(file);
        };
        await store.writeRecord('catalogue', Buffer.from(canary));
      });
    `,
  ], {
    cwd: root,
    env: { ...process.env, TS_NODE_PROJECT: path.join(root, 'tsconfig.persistence-tests.json'), TS_NODE_PREFER_TS_EXTS: 'true' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => writer.kill('SIGKILL'));
  writer.send({ directory, password, canary });
  assert.equal((await once(writer, 'message'))[0].published, true);
  await assert.rejects(PrivateHubStore.open(directory, password), /another process/);
  const ended = once(writer, 'close');
  writer.kill('SIGKILL');
  await ended;
  const primary = await primaryPath(directory);
  assert.equal((await fs.promises.stat(primary)).nlink, 2);
  const reopened = await PrivateHubStore.open(directory, password);
  try {
    assert.equal((await reopened.readRecord('catalogue')).toString(), canary);
    assert.equal((await fs.promises.stat(primary)).nlink, 1);
    assert.equal((await fs.promises.readdir(directory)).some(name => name.endsWith('.pending')), false);
  } finally {
    await reopened.lock();
  }
});

test('lock listeners can reenter lock without duplicating queue-drain completion', async t => {
  const { store } = await fixture(t);
  let reentrant: Promise<void> | undefined;
  store.lockSignal.addEventListener('abort', () => { reentrant = store.lock(); });
  const completion = store.lock();
  assert.equal(reentrant, completion);
  await completion;
});

test('helper death keeps the shared OS lock until an already-submitted publication drains', async t => {
  const originalSpawn = childProcess.spawn;
  let helper: childProcess.ChildProcess | undefined;
  const spawnMock = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    helper = originalSpawn(...args);
    return helper;
  });
  const { directory, store } = await fixture(t);
  spawnMock.mock.restore();
  await store.writeRecord('catalogue', Buffer.from('first revision'));
  const primary = await primaryPath(directory);
  let releasePublication!: () => void;
  let publicationEntered!: () => void;
  const gate = new Promise<void>(resolve => { releasePublication = resolve; });
  const entered = new Promise<void>(resolve => { publicationEntered = resolve; });
  const originalRename = fs.promises.rename;
  const renameMock = t.mock.method(fs.promises, 'rename', async (...args: Parameters<typeof fs.promises.rename>) => {
    if (args[1] === primary) {
      publicationEntered();
      // Model a filesystem operation already submitted before helper death.
      // It may still perform its replacement after the JS session locks.
      await gate;
    }
    return originalRename(...args);
  });
  const write = assert.rejects(store.writeRecord('catalogue', Buffer.from('interrupted revision')), /locked/);
  await entered;
  const abort = once(store.lockSignal, 'abort');
  helper!.kill('SIGKILL');
  await abort;
  try {
    assert.equal(store.locked, true);
    await assert.rejects(PrivateHubLease.acquire(directory), PrivateHubLeaseError,
      'a new helper cannot acquire while the old parent still has pending publication IO');
  } finally {
    releasePublication();
  }
  await write;
  await store.lock();
  renameMock.mock.restore();
  const reopened = await PrivateHubStore.open(directory, password);
  try {
    assert.equal((await reopened.readRecord('catalogue')).toString(), 'interrupted revision');
    await reopened.writeRecord('catalogue', Buffer.from('new owner revision'));
    assert.equal((await reopened.readRecord('catalogue')).toString(), 'new owner revision');
  } finally {
    await reopened.lock();
  }
});
