import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PrivateHubStore } from './private-hub-store';
import { createPrivatePreviewSet, privatePreviewSetMemberId, publishPrivatePreviewSet, resolvePrivatePreviewId } from './private-hub-preview-set';
import { readPrivateHubPreview, writePrivateHubPreview } from './private-hub-catalogue';
import { createPrivateThumbnailOverride, privateThumbnailOverrideMemberId, privateThumbnailOverrideRecordId,
  publishPrivateThumbnailOverride, readPrivateThumbnailOverride } from './private-thumbnail-override';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.resolve(__dirname, '../tmp/private-thumbnail-override-'));
  const store = await PrivateHubStore.create(path.join(root, 'hub'), 'Synthetic thumbnail password');
  t.after(async () => { await store.lock(); await fs.rm(root, { recursive: true, force: true }); });
  return store;
}
for (const generated of [false, true]) {
  test(`thumbnail override preserves ${generated ? 'generated' : 'legacy'} filmstrip and retires on regeneration`, async t => {
    const store = await fixture(t); const hash = 'video-1';
    const set = createPrivatePreviewSet(hash, 256, 144, 3, false);
    if (generated) {
      for (const kind of ['thumbnail', 'filmstrip'] as const) { await store.writeNewRecord(privatePreviewSetMemberId(set, kind), Buffer.from(kind)); }
      await publishPrivatePreviewSet(store, set, () => true);
    } else {
      for (const kind of ['thumbnail', 'filmstrip'] as const) { await writePrivateHubPreview(store, kind, hash, Buffer.from(kind)); }
    }
    const previousStrip = await resolvePrivatePreviewId(store, hash, 'filmstrip');
    const override = createPrivateThumbnailOverride(hash, generated ? set.generation : 'legacy', 144);
    await store.writeNewRecord(privateThumbnailOverrideMemberId(override), Buffer.from('custom'));
    assert.equal((await readPrivateHubPreview(store, 'thumbnail', hash)).toString(), 'thumbnail');
    await publishPrivateThumbnailOverride(store, override, () => true);
    assert.equal((await readPrivateHubPreview(store, 'thumbnail', hash)).toString(), 'custom');
    assert.equal(await resolvePrivatePreviewId(store, hash, 'filmstrip'), previousStrip);
    const next = createPrivatePreviewSet(hash, 256, 144, 3, false);
    await store.writeNewRecord(privatePreviewSetMemberId(next, 'thumbnail'), Buffer.from('regenerated'));
    await publishPrivatePreviewSet(store, next, () => true);
    assert.equal((await readPrivateHubPreview(store, 'thumbnail', hash)).toString(), 'regenerated');
    assert.deepEqual(await readPrivateThumbnailOverride(store, hash), override, 'stale encrypted records remain recoverable');
  });
}
test('missing active custom image never falls back to legacy', async t => {
  const store = await fixture(t);
  await writePrivateHubPreview(store, 'thumbnail', 'video', Buffer.from('legacy'));
  await publishPrivateThumbnailOverride(store, createPrivateThumbnailOverride('video', 'legacy', 144), () => true);
  await assert.rejects(readPrivateHubPreview(store, 'thumbnail', 'video'));
});
for (const change of ['hash', 'version', 'redirect', 'geometry', 'base', 'large'] as const) {
  test(`invalid ${change} override is refused even when its base generation is stale`, async t => {
    const store = await fixture(t); const hash = 'video';
    const override = { ...createPrivateThumbnailOverride(hash, '0'.repeat(48), 144) };
    if (change === 'hash') { override.hash = 'other'; }
    if (change === 'version') { Object.assign(override, { version: 2 }); }
    if (change === 'redirect') { Object.assign(override, { member: 'catalogue' }); }
    if (change === 'geometry') { override.width = 999; }
    if (change === 'base') { override.baseGeneration = '../escape'; }
    await store.writeRecord(privateThumbnailOverrideRecordId(hash), change === 'large' ? Buffer.alloc(1025) : Buffer.from(JSON.stringify(override)));
    await assert.rejects(resolvePrivatePreviewId(store, hash, 'thumbnail'));
  });
}
test('absent override primary with encrypted backup cannot silently restore the generated thumbnail', async t => {
  const store = await fixture(t); const hash = 'video';
  await publishPrivateThumbnailOverride(store, createPrivateThumbnailOverride(hash, 'legacy', 144), () => true);
  await publishPrivateThumbnailOverride(store, createPrivateThumbnailOverride(hash, 'legacy', 144), () => true);
  const read = store.readRecord.bind(store);
  t.mock.method(store, 'readRecord', async (id: string, max?: number) => {
    if (id === privateThumbnailOverrideRecordId(hash)) { throw Object.assign(new Error('Absent'), { code: 'ENOENT' }); }
    return read(id, max);
  });
  await assert.rejects(readPrivateThumbnailOverride(store, hash));
});
test('cancelled, throwing and asynchronous publication guards retain the previous override', async t => {
  const store = await fixture(t); const previous = createPrivateThumbnailOverride('video', 'legacy', 144);
  await publishPrivateThumbnailOverride(store, previous, () => true);
  for (const guard of [() => false, () => { throw new Error('Private filename'); }, (async () => true) as unknown as () => boolean]) {
    await assert.rejects(publishPrivateThumbnailOverride(store, createPrivateThumbnailOverride('video', 'legacy', 144), guard));
    assert.deepEqual(await readPrivateThumbnailOverride(store, 'video'), previous);
  }
});
