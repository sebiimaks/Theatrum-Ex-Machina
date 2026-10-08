import * as assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as crypto from './private-hub-crypto.ts';
import { PrivateHubLease } from './private-hub-lock.ts';
import { PRIVATE_HUB_HEADER_FILE, PrivateHubStore, isPrivateHubStoreCleanupFailure } from './private-hub-store.ts';

const password = 'Synthetic reviewed catalogue recovery password';
const canary = 'PRIVATE-RECOVERY-CANARY-synthetic-personal-title';
const first = Buffer.from(JSON.stringify({ title: canary, revision: 1 }));
const second = Buffer.from(JSON.stringify({ title: canary, revision: 2 }));
const current = (): boolean => true;
const validate = (plaintext: Buffer): boolean => {
  try { const value = JSON.parse(plaintext.toString('utf8')); return typeof value.title === 'string' && Number.isSafeInteger(value.revision); }
  catch { return false; }
};
type Options = Parameters<PrivateHubStore['recoverRecordWithReview']>[1];
const options = (extra: Partial<Options> = {}): Options => ({ maximumBytes: 4096, validate, confirm: async () => true, isCurrent: current, ...extra });

async function fixture(t: TestContext): Promise<{
  root: string; directory: string; primary: string; store: PrivateHubStore; key: Buffer; recordPath(id: string): string;
}> {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..'), '.private-record-recovery-test-'));
  const directory = path.join(root, 'hub');
  const store = await PrivateHubStore.create(directory, password);
  const header = JSON.parse(await fs.promises.readFile(path.join(directory, PRIVATE_HUB_HEADER_FILE), 'utf8'));
  const key = await crypto.unlockPrivateHub(header, password);
  const recordPath = (id: string): string => path.join(directory, createHmac('sha256', key)
    .update('theatrum-private-hub-record-name-v1\0').update(id).digest('hex') + '.sealed');
  t.after(async () => {
    key.fill(0);
    await store.lock().catch(error => { if (!isPrivateHubStoreCleanupFailure(error)) { throw error; } });
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  await store.writeRecord('catalogue', first);
  await store.writeRecord('catalogue', second);
  return { root, directory, primary: recordPath('catalogue'), store, key, recordPath };
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const stat = await fs.promises.lstat(file);
    result[name] = stat.isSymbolicLink() ? 'link:' + await fs.promises.readlink(file)
      : stat.isFile() ? createHash('sha256').update(await fs.promises.readFile(file)).digest('hex') : 'directory';
  }
  return result;
}

async function evidenceFiles(directory: string): Promise<string[]> {
  return (await fs.promises.readdir(directory)).filter(name => name.endsWith('.recovery'));
}

async function readEvidence(directory: string, key: Buffer, hubId: string): Promise<{ metadata: unknown; raw: Buffer }> {
  const names = await evidenceFiles(directory);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[0-9a-f]{48}\.recovery$/);
  const sealed = await fs.promises.readFile(path.join(directory, names[0]));
  const plaintext = crypto.decryptPrivateHubRecord(key, hubId, 'recovery-evidence:' + names[0].slice(0, 48), sealed);
  try {
    const size = plaintext.readUInt32BE(0);
    return { metadata: JSON.parse(plaintext.subarray(4, 4 + size).toString('utf8')), raw: Buffer.from(plaintext.subarray(4 + size)) };
  } finally { plaintext.fill(0); }
}

test('a healthy primary is read-only and does not examine or substitute a corrupt backup', async t => {
  const { store, directory, primary } = await fixture(t);
  await fs.promises.writeFile(primary + '.bak', 'unusable backup');
  const before = await fingerprint(directory);
  assert.equal(await store.recoverRecordWithReview('catalogue', options({ confirm: async () => { assert.fail('Healthy record must not prompt'); } })), 'not-needed');
  assert.deepEqual(await fingerprint(directory), before);
  assert.deepEqual(await store.readRecord('catalogue'), second);
});

for (const kind of ['missing', 'authentication', 'schema', 'accidental-plaintext', 'empty']) {
  test(`${kind} primary recovers only its valid backup, retaining encrypted evidence where needed`, async t => {
    const { store, directory, primary, key } = await fixture(t);
    if (kind === 'missing') { await fs.promises.unlink(primary); }
    else if (kind === 'schema') { await fs.promises.writeFile(primary, crypto.encryptPrivateHubRecord(key, store.hubId, 'catalogue', Buffer.from('{"title":3}'))); }
    else if (kind === 'authentication') {
      const raw = await fs.promises.readFile(primary); raw[raw.length - 1] ^= 1;
      await fs.promises.writeFile(primary, raw);
    } else { await fs.promises.writeFile(primary, kind === 'empty' ? '' : canary); }
    const raw = kind === 'missing' ? undefined : await fs.promises.readFile(primary);
    const backup = await fs.promises.readFile(primary + '.bak');
    const before = await fingerprint(directory);
    let confirmations = 0;
    assert.equal(await store.recoverRecordWithReview('catalogue', options({ confirm: async () => {
      confirmations++;
      assert.deepEqual(await fingerprint(directory), before, 'review does not write');
      return true;
    } })), 'recovered');
    assert.equal(confirmations, 1);
    assert.deepEqual(await store.readRecord('catalogue'), first);
    assert.deepEqual(await fs.promises.readFile(primary), backup);
    assert.deepEqual(await fs.promises.readFile(primary + '.bak'), backup);
    if (raw) {
      const evidence = await readEvidence(directory, key, store.hubId);
      assert.deepEqual(evidence.metadata, { format: 'theatrum-private-recovery-evidence', version: 1, recordId: 'catalogue' });
      assert.deepEqual(evidence.raw, raw);
    } else { assert.deepEqual(await evidenceFiles(directory), []); }
    for (const name of await fs.promises.readdir(directory)) {
      const bytes = await fs.promises.readFile(path.join(directory, name));
      for (const text of [canary, password]) {
        assert.equal(bytes.includes(Buffer.from(text)), false);
        assert.equal(bytes.includes(Buffer.from(text, 'utf16le')), false);
      }
    }
    await store.lock();
    const reopened = await PrivateHubStore.open(directory, password);
    try { assert.deepEqual(await reopened.readRecord('catalogue'), first); }
    finally { await reopened.lock(); }
  });
}

for (const invalid of [false, undefined, 1, 'yes']) {
  test(`confirmation ${String(invalid)} is cancellation and preserves the damaged primary`, async t => {
    const { store, directory, primary } = await fixture(t);
    await fs.promises.writeFile(primary, canary);
    const before = await fingerprint(directory);
    assert.equal(await store.recoverRecordWithReview('catalogue', options({ confirm: async () => invalid as boolean })), 'cancelled');
    assert.deepEqual(await fingerprint(directory), before);
    assert.equal(store.locked, false);
  });
}

for (const kind of ['missing', 'corrupt', 'schema', 'wrong-key', 'wrong-record', 'oversized']) {
  test(`${kind} backup fails before confirmation with no writes`, async t => {
    const { store, directory, primary, key } = await fixture(t);
    await fs.promises.writeFile(primary, canary);
    if (kind === 'missing') { await fs.promises.unlink(primary + '.bak'); }
    else if (kind === 'corrupt') { await fs.promises.writeFile(primary + '.bak', 'invalid'); }
    else if (kind === 'oversized') { await fs.promises.writeFile(primary + '.bak', Buffer.alloc(4096 + crypto.PRIVATE_HUB_RECORD_OVERHEAD_BYTES + 1)); }
    else {
      const selectedKey = kind === 'wrong-key' ? Buffer.alloc(32, 42) : key;
      const id = kind === 'wrong-record' ? 'another-catalogue' : 'catalogue';
      await fs.promises.writeFile(primary + '.bak', crypto.encryptPrivateHubRecord(selectedKey, store.hubId, id, kind === 'schema' ? Buffer.from('null') : first));
    }
    const before = await fingerprint(directory);
    await assert.rejects(store.recoverRecordWithReview('catalogue', options({ confirm: async () => { assert.fail('Invalid backup must not prompt'); } })), /unavailable/);
    assert.deepEqual(await fingerprint(directory), before);
  });
}

for (const invalid of [undefined, 1, 'true', Promise.resolve(true), 'throw']) {
  test(`validator ${String(invalid)} fails closed instead of treating a healthy record as corrupt`, async t => {
    const { store, directory } = await fixture(t);
    const before = await fingerprint(directory);
    await assert.rejects(store.recoverRecordWithReview('catalogue', options({
      validate: () => { if (invalid === 'throw') { throw new Error('validator failure'); } return invalid as unknown as boolean; },
      confirm: async () => { assert.fail('Invalid validator must not prompt'); },
    })), /unavailable/);
    assert.deepEqual(await fingerprint(directory), before);
  });
}

test('all authenticated plaintext buffers are wiped before a held confirmation', async t => {
  const { store, directory, primary } = await fixture(t);
  await fs.promises.writeFile(primary, 'corrupt');
  await store.writeRecord('policy', Buffer.from('allowed'));
  const original = crypto.decryptPrivateHubRecord;
  const plaintexts: Buffer[] = [];
  t.mock.method(crypto, 'decryptPrivateHubRecord', (...args: Parameters<typeof original>) => {
    const buffer = original(...args); plaintexts.push(buffer); return buffer;
  });
  const before = await fingerprint(directory);
  assert.equal(await store.recoverRecordWithReview('catalogue', options({
    guards: [{ recordId: 'policy', maximumBytes: 32, validate: value => value?.toString() === 'allowed' }],
    confirm: async () => {
      assert.equal(plaintexts.length, 2);
      assert.ok(plaintexts.every(buffer => buffer.every(byte => byte === 0)));
      await Promise.resolve();
      assert.ok(plaintexts.every(buffer => buffer.every(byte => byte === 0)));
      return false;
    },
  })), 'cancelled');
  assert.deepEqual(await fingerprint(directory), before);
});

for (const [which, mutation] of [
  ['primary', 'replaced'], ['primary', 'bytes'], ['primary', 'removed'], ['backup', 'replaced'], ['backup', 'bytes'], ['backup', 'removed'],
  ['header', 'bytes'], ['missing-primary', 'created'],
]) {
  test(`${which} ${mutation} during review cannot be overwritten`, async t => {
    const { store, directory, primary } = await fixture(t);
    await fs.promises.writeFile(primary, 'corrupt');
    if (which === 'missing-primary') { await fs.promises.unlink(primary); }
    const target = which === 'backup' ? primary + '.bak' : which === 'header' ? path.join(directory, PRIVATE_HUB_HEADER_FILE) : primary;
    let changed: Record<string, string>;
    await assert.rejects(store.recoverRecordWithReview('catalogue', options({ confirm: async () => {
      if (mutation === 'replaced') {
        await fs.promises.copyFile(target, target + '.swap');
        await fs.promises.rename(target + '.swap', target);
      } else if (mutation === 'removed') { await fs.promises.unlink(target); }
      else { await fs.promises.writeFile(target, mutation === 'created' ? 'unexpected primary' : 'changed bytes'); }
      changed = await fingerprint(directory);
      return true;
    } })), /unavailable/);
    assert.deepEqual(await fingerprint(directory), changed);
  });
}

for (const which of ['primary', 'backup']) {
  for (const kind of ['symlink', 'hardlink', 'directory', 'oversized']) {
    test(`unsafe ${which} ${kind} cannot be reviewed or changed`, async t => {
      const { store, root, directory, primary } = await fixture(t);
      await fs.promises.writeFile(primary, 'corrupt');
      const target = which === 'primary' ? primary : primary + '.bak';
      if (kind === 'oversized') { await fs.promises.writeFile(target, Buffer.alloc(4096 + crypto.PRIVATE_HUB_RECORD_OVERHEAD_BYTES + 1)); }
      else {
        const kept = path.join(root, 'untouched-original');
        await fs.promises.rename(target, kept);
        if (kind === 'symlink') { await fs.promises.symlink(kept, target); }
        else if (kind === 'hardlink') { await fs.promises.link(kept, target); }
        else { await fs.promises.mkdir(target); }
      }
      const before = await fingerprint(directory);
      await assert.rejects(store.recoverRecordWithReview('catalogue', options({ confirm: async () => { assert.fail('Unsafe record must not prompt'); } })), /unavailable/);
      assert.deepEqual(await fingerprint(directory), before);
    });
  }
}

test('invalid limits, callbacks, duplicate guards and record identifiers fail without writes', async t => {
  const { store, directory } = await fixture(t);
  const before = await fingerprint(directory);
  for (const maximumBytes of [-1, NaN, 1.5, Infinity, crypto.PRIVATE_HUB_MAX_SEALED_RECORD_BYTES]) {
    await assert.rejects(store.recoverRecordWithReview('catalogue', options({ maximumBytes })), /unavailable/);
  }
  for (const extra of [{ validate: null }, { confirm: null }, { isCurrent: null }, { guards: null },
    { guards: Array(5).fill({ recordId: 'policy', maximumBytes: 1, validate }) },
    { guards: [{ recordId: 'catalogue', maximumBytes: 1, validate }] },
    { guards: [{ recordId: 'policy', maximumBytes: 8193, validate }] },
    { guards: Array(2).fill({ recordId: 'policy', maximumBytes: 1, validate }) }]) {
    await assert.rejects(store.recoverRecordWithReview('catalogue', options(extra as Partial<Options>)), /unavailable/);
  }
  for (const id of ['', '../bad', 'bad/name', 'x'.repeat(257)]) { await assert.rejects(store.recoverRecordWithReview(id, options()), /unavailable/); }
  assert.deepEqual(await fingerprint(directory), before);
});

test('the maximum catalogue read limit permits small recoverable records', async t => {
  const { store, primary } = await fixture(t);
  await fs.promises.writeFile(primary, canary);
  assert.equal(await store.recoverRecordWithReview('catalogue', options({
    maximumBytes: crypto.PRIVATE_HUB_MAX_SEALED_RECORD_BYTES - crypto.PRIVATE_HUB_RECORD_OVERHEAD_BYTES,
  })), 'recovered');
  assert.deepEqual(await store.readRecord('catalogue'), first);
});

test('a damaged primary too large for its evidence envelope fails before review without changing files', async t => {
  const { store, directory, primary } = await fixture(t);
  await fs.promises.writeFile(primary, 'Synthetic oversized damaged primary');
  const maximumBytes = crypto.PRIVATE_HUB_MAX_SEALED_RECORD_BYTES - crypto.PRIVATE_HUB_RECORD_OVERHEAD_BYTES;
  await fs.promises.truncate(primary, maximumBytes);
  const before = await fs.promises.stat(primary);
  const names = await fs.promises.readdir(directory);
  await assert.rejects(store.recoverRecordWithReview('catalogue', options({ maximumBytes,
    confirm: async () => { assert.fail('Evidence cannot fit safely and must not prompt'); },
  })), /unavailable/);
  const after = await fs.promises.stat(primary);
  for (const property of ['size', 'ino', 'mtimeMs', 'ctimeMs'] as const) { assert.equal(after[property], before[property]); }
  assert.deepEqual(await fs.promises.readdir(directory), names);
});

for (const kind of ['permission', 'read-enoent', 'close']) {
  test(`${kind} filesystem failure is not interpreted as a corrupt or missing primary`, async t => {
    const { store, directory, primary } = await fixture(t);
    const before = await fingerprint(directory);
    const originalOpen = fs.promises.open;
    const openMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      if (args[0] === primary && kind !== 'close') {
        throw Object.assign(new Error('Synthetic read refusal'), { code: kind === 'permission' ? 'EACCES' : 'ENOENT' });
      }
      const handle = await originalOpen(...args);
      if (args[0] === primary) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, 'close', async () => { await close(); throw new Error('Synthetic close uncertainty'); });
      }
      return handle;
    });
    await assert.rejects(store.recoverRecordWithReview('catalogue', options({
      confirm: async () => { assert.fail('Filesystem errors must not prompt'); },
    })), kind === 'close' ? isPrivateHubStoreCleanupFailure : /unavailable/);
    openMock.mock.restore();
    assert.deepEqual(await fingerprint(directory), before);
    if (kind === 'close') {
      assert.equal(store.locked, true);
      await assert.rejects(store.lock(), isPrivateHubStoreCleanupFailure);
      await assert.rejects(PrivateHubStore.open(directory, password), isPrivateHubStoreCleanupFailure);
    }
  });
}

for (const which of ['primary', 'backup']) {
  test(`exact ${which} bytes remain bound even if filesystem timestamps appear unchanged`, async t => {
    const { store, primary } = await fixture(t);
    await fs.promises.writeFile(primary, 'corrupt');
    const target = which === 'primary' ? primary : primary + '.bak';
    const snapshot = await fs.promises.stat(target);
    const stableTimes = (stat: fs.Stats): fs.Stats => Object.assign(stat, { mtimeMs: snapshot.mtimeMs, ctimeMs: snapshot.ctimeMs });
    const originalStat = fs.promises.lstat;
    t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof originalStat>) => {
      const stat = await originalStat(...args);
      return args[0] === target ? stableTimes(stat as fs.Stats) : stat;
    });
    const originalOpen = fs.promises.open;
    const openMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (args[0] === target) {
        const stat = handle.stat.bind(handle);
        t.mock.method(handle, 'stat', async () => stableTimes(await stat()));
      }
      return handle;
    });
    let reviewed = false;
    await assert.rejects(store.recoverRecordWithReview('catalogue', options({ confirm: async () => {
      reviewed = true;
      const bytes = await fs.promises.readFile(target);
      bytes[bytes.length - 1] ^= 1;
      await fs.promises.writeFile(target, bytes);
      return true;
    } })), /unavailable/);
    openMock.mock.restore();
    assert.equal(reviewed, true);
    assert.equal(store.locked, false);
  });
}

for (const kind of ['backup-only', 'corrupt-primary', 'replaced', 'bytes', 'appeared', 'backup-appeared']) {
  test(`guard ${kind} blocks publication and keeps reviewed data intact`, async t => {
    const { store, directory, primary, recordPath } = await fixture(t);
    await fs.promises.writeFile(primary, 'corrupt');
    if (!['appeared', 'backup-appeared'].includes(kind)) { await store.writeRecord('policy', Buffer.from('allowed')); }
    const policy = recordPath('policy');
    if (kind === 'backup-only') { await fs.promises.rename(policy, policy + '.bak'); }
    if (kind === 'corrupt-primary') { await fs.promises.writeFile(policy, 'bad'); }
    let expected = await fingerprint(directory);
    await assert.rejects(store.recoverRecordWithReview('catalogue', options({
      guards: [{ recordId: 'policy', maximumBytes: 32, validate: value => value === undefined || value.toString() === 'allowed' }],
      confirm: async () => {
        if (['backup-only', 'corrupt-primary'].includes(kind)) { assert.fail('Invalid guard must not prompt'); }
        if (kind === 'replaced') {
          await fs.promises.copyFile(policy, policy + '.swap'); await fs.promises.rename(policy + '.swap', policy);
        } else { await fs.promises.writeFile(kind === 'backup-appeared' ? policy + '.bak' : policy, 'changed guard'); }
        expected = await fingerprint(directory);
        return true;
      },
    })), /unavailable/);
    assert.deepEqual(await fingerprint(directory), expected);
  });
}

for (const stage of ['evidence-open', 'evidence-directory-sync', 'primary-rename', 'primary-directory-sync']) {
  test(`${stage} failure preserves evidence and backup and locks before reuse`, async t => {
    const { store, directory, primary, key } = await fixture(t);
    await fs.promises.writeFile(primary, canary);
    const backup = await fs.promises.readFile(primary + '.bak');
    const originalOpen = fs.promises.open;
    let directorySyncs = 0;
    const openMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      if (stage === 'evidence-open' && String(args[0]).includes('.recovery.') && args[1] === 'wx') { throw new Error('Synthetic evidence write failure'); }
      const handle = await originalOpen(...args);
      if (args[0] === directory) {
        const sync = handle.sync.bind(handle);
        t.mock.method(handle, 'sync', async () => {
          directorySyncs++;
          if ((stage === 'evidence-directory-sync' && directorySyncs === 1) || (stage === 'primary-directory-sync' && directorySyncs === 2)) {
            throw new Error('Synthetic directory sync failure');
          }
          return sync();
        });
      }
      return handle;
    });
    const originalRename = fs.promises.rename;
    const renameMock = t.mock.method(fs.promises, 'rename', async (...args: Parameters<typeof originalRename>) => {
      if (stage === 'primary-rename' && args[1] === primary) { throw new Error('Synthetic primary rename failure'); }
      return originalRename(...args);
    });
    await assert.rejects(store.recoverRecordWithReview('catalogue', options()), /unavailable/);
    openMock.mock.restore(); renameMock.mock.restore();
    assert.equal(store.locked, true);
    await store.lock();
    assert.deepEqual(await fs.promises.readFile(primary + '.bak'), backup);
    assert.deepEqual(await fs.promises.readFile(primary), stage === 'primary-directory-sync' ? backup : Buffer.from(canary));
    if (stage === 'evidence-open') { assert.deepEqual(await evidenceFiles(directory), []); }
    else { assert.deepEqual((await readEvidence(directory, key, store.hubId)).raw, Buffer.from(canary)); }
  });
}

test('revocation while confirmation is held closes admission and retains the lease until confirmation drains', async t => {
  const { store, directory, primary } = await fixture(t);
  await fs.promises.writeFile(primary, canary);
  const before = await fingerprint(directory);
  let enter: () => void;
  let finish: (result: boolean) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<boolean>(resolve => { finish = resolve; });
  const operation = assert.rejects(store.recoverRecordWithReview('catalogue', options({ confirm: async () => { enter(); return held; } })), /unavailable/);
  await entered;
  await assert.rejects(PrivateHubStore.open(directory, password), /already has an open session/);
  await assert.rejects(PrivateHubLease.acquire(directory), /another process/);
  const queued = assert.rejects(store.writeRecord('queued-record', Buffer.from('queued synthetic')), /locked/);
  let closed = false;
  const closing = store.lock().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  await assert.rejects(PrivateHubStore.open(directory, password), /already has an open session/);
  finish(true);
  await Promise.all([operation, queued, closing]);
  assert.deepEqual(await fingerprint(directory), before);
  const reopened = await PrivateHubStore.open(directory, password);
  await reopened.lock();
});

test('the current-operation guard cannot regain authority once it returns false', async t => {
  const { store, directory, primary } = await fixture(t);
  await fs.promises.writeFile(primary, canary);
  const before = await fingerprint(directory);
  let allowed = true;
  await assert.rejects(store.recoverRecordWithReview('catalogue', options({
    isCurrent: () => { const value = allowed; allowed = true; return value; },
    confirm: async () => { allowed = false; return true; },
  })), /unavailable/);
  assert.deepEqual(await fingerprint(directory), before);
});

test('the final publication check notices backup replacement after evidence has been retained', async t => {
  const { store, directory, primary, key } = await fixture(t);
  await fs.promises.writeFile(primary, canary);
  const originalOpen = fs.promises.open;
  let changed = false;
  const openMock = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(primary + '.') && String(args[0]).endsWith('.pending') && args[1] === 'wx') {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => {
        await sync();
        changed = true;
        await fs.promises.writeFile(primary + '.bak', 'unexpected changed backup');
      });
    }
    return handle;
  });
  await assert.rejects(store.recoverRecordWithReview('catalogue', options()), /unavailable/);
  openMock.mock.restore();
  assert.equal(changed, true);
  assert.equal(store.locked, true);
  await store.lock();
  assert.equal(await fs.promises.readFile(primary, 'utf8'), canary);
  assert.equal(await fs.promises.readFile(primary + '.bak', 'utf8'), 'unexpected changed backup');
  assert.deepEqual((await readEvidence(directory, key, store.hubId)).raw, Buffer.from(canary));
});
