import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement } from '../interfaces/final-object.interface';
import { recoverPrivateHubCatalogue, reviewPrivateHubCatalogueRecovery } from './private-catalogue-recovery';
import { PrivateHubStore } from './private-hub-store';
import { PrivateHubSession } from './private-hub-session';
import { readPrivateHubProtection } from './private-hub-protection';

const password = 'Synthetic catalogue recovery password';
const canary = 'SYNTHETIC-PRIVATE-CATALOGUE-RECOVERY-NOTES';
const generic = { message: 'Private hub catalogue recovery is unavailable.' };
const current = (): boolean => true;
const confirm = async (): Promise<boolean> => true;

function catalogue() {
  return { hubName: 'Synthetic recovery hub', version: 3, addTags: [], removeTags: [], numOfFolders: 1,
    images: [{ ...NewImageElement(), hash: 'synthetic', fileName: 'synthetic.mp4', notes: canary }],
    inputDirs: { 0: { path: path.resolve(__dirname, '../tmp/unopened-recovery-source'), watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 },
    futureCatalogueField: { deliberatelyPreserved: true } };
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    result[name] = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
  }
  return result;
}

async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-catalogue-recovery-'));
  const directory = path.join(root, 'hub');
  const store = await PrivateHubStore.create(directory, password);
  t.after(async () => {
    await store.lock();
    await fs.rm(root, { recursive: true, force: true });
  });
  const records = new Map<string, string>();
  const write = async (recordId: string, bytes: Buffer): Promise<string> => {
    const before = new Set(await fs.readdir(directory));
    try { await store.writeRecord(recordId, bytes); }
    finally { bytes.fill(0); }
    if (!records.has(recordId)) {
      const added = (await fs.readdir(directory)).filter(name => name.endsWith('.sealed') && !before.has(name));
      assert.equal(added.length, 1);
      records.set(recordId, path.join(directory, added[0]));
    }
    return records.get(recordId)!;
  };
  // Include formatting and unknown fields whose original bytes must survive.
  const original = Buffer.from('\uFEFF' + JSON.stringify(catalogue(), null, 2) + '\n');
  const primary = await write('catalogue', Buffer.from(original));
  await write('catalogue', Buffer.from('SYNTHETIC-invalid-current-catalogue'));
  const activation = await write('session:activation', Buffer.from(JSON.stringify({
    format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId,
  })));
  const preview = await write('preview:thumbnail:synthetic', Buffer.from('Synthetic encrypted preview payload'));
  return { root, directory, store, primary, activation, preview, original, write };
}

test('reviewed recovery restores exact authenticated backup bytes and retains preview and unknown catalogue fields', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.directory);
  let confirmations = 0;
  assert.equal(await recoverPrivateHubCatalogue(f.store, { isCurrent: current, confirm: async review => {
    confirmations++;
    assert.deepEqual(review, { videoCount: 1 });
    assert.equal(Object.isFrozen(review), true);
    assert.deepEqual(await fingerprint(f.directory), before, 'review is read-only');
    return true;
  } }), 'recovered');
  assert.equal(confirmations, 1);
  const restored = await f.store.readRecord('catalogue');
  try { assert.deepEqual(restored, f.original); }
  finally { restored.fill(0); }
  const after = await fingerprint(f.directory);
  assert.equal(after[path.basename(f.primary)], before[path.basename(f.primary) + '.bak']);
  assert.equal(after[path.basename(f.primary) + '.bak'], before[path.basename(f.primary) + '.bak']);
  assert.equal(after[path.basename(f.preview)], before[path.basename(f.preview)]);
  assert.equal(after[path.basename(f.activation)], before[path.basename(f.activation)]);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 1, 'damaged primary gets an opaque encrypted archive');
  assert.deepEqual(await readPrivateHubProtection(f.store), { autoLockMinutes: 5, recordPlaybackHistory: false });
  for (const name of Object.keys(after)) {
    assert.doesNotMatch(name, /catalogue|notes|synthetic/i);
    if (name.endsWith('.recovery')) { assert.match(name, /^[0-9a-f]{48}\.recovery$/); }
    const raw = await fs.readFile(path.join(f.directory, name));
    for (const value of [password, canary, 'SYNTHETIC-invalid-current-catalogue']) {
      assert.equal(raw.includes(Buffer.from(value)), false);
      assert.equal(raw.includes(Buffer.from(value, 'utf16le')), false);
    }
  }
  assert.deepEqual(await fs.readdir(f.root), ['hub']);
  await f.store.lock();
  const session = new PrivateHubSession();
  try {
    const opened = await session.unlock(f.directory, password);
    assert.equal(opened.catalogue.images[0].notes, canary);
    assert.equal((opened.catalogue as unknown as ReturnType<typeof catalogue>).futureCatalogueField.deliberatelyPreserved, true);
  } finally { await session.close(); }
});

test('a healthy primary never offers or silently restores its older backup', async t => {
  const f = await fixture(t);
  await f.write('catalogue', Buffer.from(f.original));
  const before = await fingerprint(f.directory);
  let confirmations = 0;
  assert.equal(await recoverPrivateHubCatalogue(f.store, { isCurrent: current,
    confirm: async () => { confirmations++; return true; } }), 'not-needed');
  assert.equal(confirmations, 0);
  assert.deepEqual(await fingerprint(f.directory), before);
});

test('declining recovery leaves every encrypted file unchanged', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.directory);
  assert.equal(await recoverPrivateHubCatalogue(f.store, { isCurrent: current, confirm: async () => false }), 'cancelled');
  assert.deepEqual(await fingerprint(f.directory), before);
});

test('a missing catalogue primary can be explicitly restored without manufacturing an archive', async t => {
  const f = await fixture(t);
  await fs.unlink(f.primary);
  const before = await fingerprint(f.directory);
  assert.equal(await recoverPrivateHubCatalogue(f.store, { isCurrent: current, confirm }), 'recovered');
  const after = await fingerprint(f.directory);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 1);
  assert.equal(after[path.basename(f.primary)], before[path.basename(f.primary) + '.bak']);
});

for (const damage of ['missing', 'missing-with-backup', 'wrong-hub', 'extra-field', 'oversized', 'damaged'] as const) {
  test(`activation ${damage} prevents recovery before confirmation without creating activation`, async t => {
    const f = await fixture(t);
    if (damage === 'missing') { await fs.unlink(f.activation); }
    else if (damage === 'missing-with-backup') {
      await f.write('session:activation', Buffer.from(JSON.stringify({
        format: 'theatrum-private-hub-activation', version: 1, hubId: f.store.hubId,
      })));
      await fs.unlink(f.activation);
    }
    else if (damage === 'damaged') { await fs.writeFile(f.activation, 'Synthetic broken activation'); }
    else {
      const marker = { format: 'theatrum-private-hub-activation', version: 1, hubId: damage === 'wrong-hub' ? 'a'.repeat(32) : f.store.hubId,
        ...(damage === 'extra-field' ? { unexpected: true } : {}) };
      await f.write('session:activation', Buffer.from(JSON.stringify(marker) + (damage === 'oversized' ? ' '.repeat(512) : '')));
    }
    const before = await fingerprint(f.directory);
    let confirmations = 0;
    await assert.rejects(recoverPrivateHubCatalogue(f.store, { isCurrent: current,
      confirm: async () => { confirmations++; return true; } }), generic);
    assert.equal(confirmations, 0);
    assert.deepEqual(await fingerprint(f.directory), before);
  });
}

for (const policy of [
  { version: 1, autoLockMinutes: 15 },
  { version: 2, autoLockMinutes: 1, recordPlaybackHistory: false },
  { version: 2, autoLockMinutes: 30, recordPlaybackHistory: true },
]) {
  test(`current protection version ${policy.version} and history ${String(policy.recordPlaybackHistory)} survives recovery`, async t => {
    const f = await fixture(t);
    const settings = await f.write('settings:protection', Buffer.from(JSON.stringify(policy)));
    const before = await fs.readFile(settings);
    assert.equal(await recoverPrivateHubCatalogue(f.store, { isCurrent: current, confirm }), 'recovered');
    assert.deepEqual(await fs.readFile(settings), before);
    assert.deepEqual(await readPrivateHubProtection(f.store), { autoLockMinutes: policy.autoLockMinutes,
      recordPlaybackHistory: policy.recordPlaybackHistory ?? false });
  });
}

for (const damage of ['malformed', 'oversized', 'orphan-backup', 'damaged'] as const) {
  test(`protection ${damage} prevents catalogue recovery instead of reverting policy`, async t => {
    const f = await fixture(t);
    const settings = await f.write('settings:protection', Buffer.from(JSON.stringify({ version: 2,
      autoLockMinutes: 1, recordPlaybackHistory: true })));
    if (damage === 'orphan-backup') {
      await f.write('settings:protection', Buffer.from(JSON.stringify({ version: 2, autoLockMinutes: 5, recordPlaybackHistory: true })));
      await fs.unlink(settings);
    } else if (damage === 'damaged') { await fs.writeFile(settings, 'Synthetic broken protection'); }
    else {
      await f.write('settings:protection', Buffer.from(damage === 'malformed' ? '{"version":2,"autoLockMinutes":0}'
        : JSON.stringify({ version: 2, autoLockMinutes: 1, recordPlaybackHistory: true }) + ' '.repeat(256)));
    }
    const before = await fingerprint(f.directory);
    let confirmations = 0;
    await assert.rejects(recoverPrivateHubCatalogue(f.store, { isCurrent: current,
      confirm: async () => { confirmations++; return true; } }), generic);
    assert.equal(confirmations, 0);
    assert.deepEqual(await fingerprint(f.directory), before);
  });
}

for (const recordId of ['session:activation', 'settings:protection']) {
  test(`changing ${recordId} during confirmation invalidates the review`, async t => {
    const f = await fixture(t);
    const target = recordId === 'session:activation' ? f.activation : await f.write(recordId,
      Buffer.from(JSON.stringify({ version: 2, autoLockMinutes: 5, recordPlaybackHistory: false })));
    const raw = await fs.readFile(target);
    const primary = await fs.readFile(f.primary);
    const backup = await fs.readFile(f.primary + '.bak');
    let confirmations = 0;
    await assert.rejects(recoverPrivateHubCatalogue(f.store, { isCurrent: current, confirm: async () => {
      confirmations++;
      // Same bytes, new inode: stale file authority must not be accepted.
      const replacement = path.join(f.root, 'replacement');
      await fs.writeFile(replacement, raw, { flag: 'wx', mode: 0o600 });
      await fs.rename(replacement, target);
      return true;
    } }), generic);
    assert.equal(confirmations, 1);
    assert.deepEqual(await fs.readFile(f.primary), primary);
    assert.deepEqual(await fs.readFile(f.primary + '.bak'), backup);
  });
}

for (const suffix of ['', '.bak']) {
  test(`a protection ${suffix ? 'backup' : 'primary'} appearing while absent policy is reviewed invalidates recovery`, async t => {
    const f = await fixture(t);
    const settings = await f.write('settings:protection', Buffer.from(JSON.stringify({ version: 2,
      autoLockMinutes: 1, recordPlaybackHistory: true })));
    const raw = await fs.readFile(settings);
    await fs.unlink(settings);
    const primary = await fs.readFile(f.primary);
    let confirmations = 0;
    await assert.rejects(recoverPrivateHubCatalogue(f.store, { isCurrent: current, confirm: async () => {
      confirmations++;
      await fs.writeFile(settings + suffix, raw, { flag: 'wx', mode: 0o600 });
      return true;
    } }), generic);
    assert.equal(confirmations, 1);
    assert.deepEqual(await fs.readFile(f.primary), primary);
  });
}

test('revocation during confirmation preserves catalogue and backup and does not retry the confirmation', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.directory);
  let active = true;
  let confirmations = 0;
  await assert.rejects(recoverPrivateHubCatalogue(f.store, { isCurrent: () => active, confirm: async () => {
    confirmations++; active = false; return true;
  } }), generic);
  assert.equal(confirmations, 1);
  assert.deepEqual(await fingerprint(f.directory), before);
});

test('locking during confirmation revokes the operation before writes and drains after confirmation settles', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.directory);
  let locking: Promise<void> | undefined;
  await assert.rejects(recoverPrivateHubCatalogue(f.store, { isCurrent: current, confirm: async () => {
    locking = f.store.lock();
    assert.equal(f.store.locked, true);
    return true;
  } }), generic);
  assert.ok(locking);
  await locking;
  assert.deepEqual(await fingerprint(f.directory), before);
});

for (const backup of ['invalid-json', 'unsupported-hash'] as const) {
  test(`${backup} backup is not offered even when its encryption authenticates`, async t => {
    const f = await fixture(t);
    const value = catalogue();
    value.images[0].hash = '../unsupported';
    await f.write('catalogue', Buffer.from(backup === 'invalid-json' ? 'not JSON' : JSON.stringify(value)));
    await f.write('catalogue', Buffer.from('invalid current catalogue'));
    const before = await fingerprint(f.directory);
    let confirmations = 0;
    await assert.rejects(recoverPrivateHubCatalogue(f.store, { isCurrent: current,
      confirm: async () => { confirmations++; return true; } }), generic);
    assert.equal(confirmations, 0);
    assert.deepEqual(await fingerprint(f.directory), before);
  });
}

test('catalogue review excludes tombstones and folders but counts live duplicate entries', () => {
  const value = catalogue();
  value.images.push({ ...value.images[0] }, { ...value.images[0], deleted: true, hash: '../ignored-tombstone' },
    { ...value.images[0], cleanName: '*FOLDER*', hash: '../ignored-folder' });
  const raw = Buffer.from(JSON.stringify(value));
  const before = Buffer.from(raw);
  assert.deepEqual(reviewPrivateHubCatalogueRecovery(raw), { videoCount: 2 });
  assert.deepEqual(raw, before, 'review does not mutate caller-owned bytes');
});

test('catalogue review enforces the normal 100,000 distinct active hash limit', () => {
  const value = { ...catalogue(), images: Array.from({ length: 100_000 }, (_, index) => ({ hash: `video_${index}`, inputSource: 0 })) };
  assert.deepEqual(reviewPrivateHubCatalogueRecovery(Buffer.from(JSON.stringify(value))), { videoCount: 100_000 });
  value.images.push({ hash: 'one_more', inputSource: 0 });
  assert.throws(() => reviewPrivateHubCatalogueRecovery(Buffer.from(JSON.stringify(value))));
});
