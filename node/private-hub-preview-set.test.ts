import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PrivateHubStore } from './private-hub-store.ts';
import { readPrivateHubPreview, writePrivateHubPreview } from './private-hub-catalogue.ts';
import { createPrivatePreviewSet, privatePreviewSetMemberId, privatePreviewSetRecordId,
  publishPrivatePreviewSet, readPrivatePreviewSet, resolvePrivatePreviewId } from './private-hub-preview-set.ts';

async function fixture(t: TestContext): Promise<{ directory: string; store: PrivateHubStore }> {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '../tmp'), 'private-set-'));
  const directory = path.join(root, 'hub');
  const store = await PrivateHubStore.create(directory, 'Synthetic preview set passphrase');
  t.after(async () => { await store.lock(); await fs.promises.rm(root, { recursive: true, force: true }); });
  return { directory, store };
}

test('initial conversion uses encrypted legacy records; set publication selects all new members together', async t => {
  const { store } = await fixture(t);
  const hash = 'video-1';
  await writePrivateHubPreview(store, 'thumbnail', hash, Buffer.from('old thumbnail'));
  await writePrivateHubPreview(store, 'filmstrip', hash, Buffer.from('old filmstrip'));
  const set = createPrivatePreviewSet(hash, 256, 144, 3, false);
  const thumbnail = privatePreviewSetMemberId(set, 'thumbnail');
  await store.writeNewRecord(thumbnail, Buffer.from('new thumbnail'));
  assert.equal((await readPrivateHubPreview(store, 'thumbnail', hash)).toString(), 'old thumbnail');
  await store.writeNewRecord(privatePreviewSetMemberId(set, 'filmstrip'), Buffer.from('new filmstrip'));
  await publishPrivatePreviewSet(store, set, () => true);
  assert.deepEqual(await readPrivatePreviewSet(store, hash), set);
  assert.equal((await readPrivateHubPreview(store, 'thumbnail', hash)).toString(), 'new thumbnail');
  assert.equal((await readPrivateHubPreview(store, 'filmstrip', hash)).toString(), 'new filmstrip');
  const next = createPrivatePreviewSet(hash, 256, 144, 3, false);
  await store.writeNewRecord(privatePreviewSetMemberId(next, 'thumbnail'), Buffer.from('replacement'));
  await publishPrivatePreviewSet(store, next, () => true);
  assert.equal((await store.readRecord(thumbnail)).toString(), 'new thumbnail', 'previously resolved generation remains immutable');
});

test('explicitly disabled clips and corrupt manifests cannot fall back to legacy previews', async t => {
  const { store } = await fixture(t);
  const hash = 'video-1';
  await writePrivateHubPreview(store, 'clip', hash, Buffer.from('legacy clip'));
  await writePrivateHubPreview(store, 'clip-poster', hash, Buffer.from('legacy poster'));
  const set = createPrivatePreviewSet(hash, 256, 144, 3, false);
  await publishPrivatePreviewSet(store, set, () => true);
  await assert.rejects(resolvePrivatePreviewId(store, hash, 'clip'));
  await assert.rejects(readPrivateHubPreview(store, 'clip-poster', hash));
  await store.writeRecord(privatePreviewSetRecordId(hash), Buffer.from('{broken'));
  await assert.rejects(resolvePrivatePreviewId(store, hash, 'thumbnail'));
  await assert.rejects(resolvePrivatePreviewId(store, hash, 'clip'));
});

test('strict manifests bind identity, reject redirects, and bound member IDs for long hashes', async t => {
  const { store } = await fixture(t);
  const hash = 'v'.repeat(200);
  const set = createPrivatePreviewSet(hash, 896, 504, 30, true);
  assert.ok(privatePreviewSetMemberId(set, 'clip-poster').length <= 256);
  for (const modified of [{ ...set, hash: 'another-video' }, { ...set, thumbnail: 'arbitrary' },
    { ...set, generation: '../escape' }, { ...set, screenCount: 1000 }, { ...set, clip: 'yes' }]) {
    await store.writeRecord(privatePreviewSetRecordId(hash), Buffer.from(JSON.stringify(modified)));
    await assert.rejects(readPrivatePreviewSet(store, hash));
  }
  await store.writeRecord(privatePreviewSetRecordId(hash), Buffer.alloc(1025));
  await assert.rejects(readPrivatePreviewSet(store, hash));
});

test('revocation during staging prevents final publication and preserves the active set', async t => {
  const { directory, store } = await fixture(t);
  const set = createPrivatePreviewSet('video-1', 256, 144, 3, false);
  await publishPrivatePreviewSet(store, set, () => true);
  const [primary] = (await fs.promises.readdir(directory)).filter(name => name.endsWith('.sealed'));
  let allowed = true;
  let intercepted = false;
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    const name = path.basename(String(args[0]));
    if (name.startsWith(primary + '.') && /^[a-f0-9]{48}\.pending$/.test(name.slice(primary.length + 1))) {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        const result = await write(...writeArgs);
        allowed = false;
        intercepted = true;
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(publishPrivatePreviewSet(store, createPrivatePreviewSet('video-1', 256, 144, 3, true), () => allowed));
  assert.equal(intercepted, true);
  assert.deepEqual(await readPrivatePreviewSet(store, 'video-1'), set);
  assert.equal(store.locked, false);
});

test('throwing, asynchronous, and reentrant locking commit guards fail closed', async t => {
  const { store } = await fixture(t);
  const set = createPrivatePreviewSet('video-1', 256, 144, 3, false);
  await assert.rejects(publishPrivatePreviewSet(store, set, () => { throw new Error('secret source path'); }));
  await assert.rejects(publishPrivatePreviewSet(store, set, (async () => true) as unknown as () => boolean));
  assert.equal(await readPrivatePreviewSet(store, 'video-1'), undefined);
  await assert.rejects(publishPrivatePreviewSet(store, set, () => { void store.lock(); return true; }));
});

test('a missing primary with a surviving encrypted backup requires recovery instead of legacy fallback', async t => {
  const { directory, store } = await fixture(t);
  await publishPrivatePreviewSet(store, createPrivatePreviewSet('video-1', 256, 144, 3, false), () => true);
  await publishPrivatePreviewSet(store, createPrivatePreviewSet('video-1', 256, 144, 3, true), () => true);
  const [primary] = (await fs.promises.readdir(directory)).filter(name => name.endsWith('.sealed'));
  await fs.promises.unlink(path.join(directory, primary));
  await assert.rejects(resolvePrivatePreviewId(store, 'video-1', 'thumbnail'));
  await store.recoverRecord(privatePreviewSetRecordId('video-1'));
  assert.equal((await readPrivatePreviewSet(store, 'video-1'))?.clip, false);
});

test('preview adapter wipes plaintext revoked during its final asynchronous handoff', async t => {
  const { store } = await fixture(t);
  await writePrivateHubPreview(store, 'thumbnail', 'video-1', Buffer.from('private image'));
  const read = store.readRecord.bind(store);
  let observed: Buffer | undefined;
  t.mock.method(store, 'readRecord', async (id: string, limit?: number) => {
    const bytes = await read(id, limit);
    if (id === 'preview:thumbnail:video-1') { observed = bytes; queueMicrotask(() => { void store.lock(); }); }
    return bytes;
  });
  await assert.rejects(readPrivateHubPreview(store, 'thumbnail', 'video-1'));
  assert.ok(observed?.every(value => value === 0));
});
