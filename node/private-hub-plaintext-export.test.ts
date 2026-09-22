import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubPreview } from './private-hub-catalogue';
import * as media from './private-hub-media';
import { createPrivatePreviewSet, privatePreviewSetMemberId, privatePreviewSetRecordId, publishPrivatePreviewSet } from './private-hub-preview-set';
import { exportPrivateHubToPlaintext, isPrivateHubPlaintextExportCleanupFailure,
  type PrivateHubPlaintextExportOptions } from './private-hub-plaintext-export';

const hash = 'Synthetic-Video_1';
const hubName = 'Synthetic export hub';
const options = (destinationDirectory: string): PrivateHubPlaintextExportOptions => ({ destinationDirectory, assertSourceQuiescent: () => undefined });
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const absent = (): Error => Object.assign(new Error('Synthetic absent'), { code: 'ENOENT' });
const clip = Buffer.alloc(media.PRIVATE_HUB_MEDIA_CHUNK_BYTES + 31, 0x51);
const payloads = { thumbnail: Buffer.from('Synthetic private thumbnail'), filmstrip: Buffer.from('Synthetic private filmstrip'),
  'clip-poster': Buffer.from('Synthetic private poster'), clip };
async function fixture(t: TestContext, previews = true) {
  const root = await fs.mkdtemp(path.resolve(__dirname, '../tmp/private-plaintext-export-'));
  const directory = path.join(root, 'encrypted');
  const destination = path.join(root, 'ordinary-copy');
  const store = await PrivateHubStore.create(directory, 'Synthetic export password');
  const catalogue: FinalObject = { addTags: [], hubName, images: [{ ...NewImageElement(), hash, fileName: 'original-never-opened.mp4',
    notes: 'Private notes preserve exact formatting', tags: ['Private tag'] }],
    inputDirs: { 0: { path: path.join(root, 'original-files-must-not-be-opened'), watch: false } }, numOfFolders: 1,
    removeTags: [], version: 3, screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 1, fixed: true, height: 144, n: 5 } };
  const raw = Buffer.from('\uFEFF' + JSON.stringify({ ...catalogue, futureProperty: { exact: 'value' } }, null, 3) + '\n');
  await store.writeRecord('catalogue', raw);
  if (previews) {
    for (const [kind, bytes] of Object.entries(payloads)) {
      await writePrivateHubPreview(store, kind as keyof typeof payloads, hash, bytes);
    }
  }
  t.after(async () => { await store.lock(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, destination, store, raw, catalogue, ordinary: path.join(destination, hubName + '.scaena'),
    assets: path.join(destination, 'vha-' + hubName), options: options(destination) };
}
async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await fs.readdir(directory)).sort()) {
    const target = path.join(directory, name);
    const stat = await fs.lstat(target);
    result[name] = `${stat.ino}:${stat.mtimeMs}:${stat.nlink}:` + digest(await fs.readFile(target));
  }
  return result;
}
async function assertNoCatalogue(filePath: string): Promise<void> { await assert.rejects(fs.lstat(filePath), { code: 'ENOENT' }); }

test('legacy export preserves exact catalogue bytes and all preview types without touching encrypted source or originals', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.directory);
  const events: unknown[] = [];
  const result = await exportPrivateHubToPlaintext(f.store, { ...f.options, onProgress: value => events.push(value) });
  assert.equal(result.previewCount, 4);
  assert.equal(result.byteLength, f.raw.length + Object.values(payloads).reduce((total, bytes) => total + bytes.length, 0));
  assert.deepEqual(await fs.readFile(f.ordinary), f.raw);
  assert.deepEqual(await fs.readFile(path.join(f.assets, 'thumbnails', hash + '.jpg')), payloads.thumbnail);
  assert.deepEqual(await fs.readFile(path.join(f.assets, 'filmstrips', hash + '.jpg')), payloads.filmstrip);
  assert.deepEqual(await fs.readFile(path.join(f.assets, 'clips', hash + '.jpg')), payloads['clip-poster']);
  assert.deepEqual(await fs.readFile(path.join(f.assets, 'clips', hash + '.mp4')), clip);
  assert.deepEqual(await fingerprint(f.directory), before);
  assert.equal(JSON.stringify(events).includes(hubName), false);
  assert.equal(JSON.stringify(events).includes('Private'), false);
  assert.deepEqual(events.at(-1), { stage: 'complete', completed: 4, total: 4 });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.destination)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(f.ordinary)).mode & 0o777, 0o600);
  }
  assert.equal((await fs.readdir(f.destination)).some(name => name.endsWith('.pending')), false);
});

test('current generated sets win over legacy bytes and disabled clips suppress older clips and posters', async t => {
  const f = await fixture(t);
  const set = createPrivatePreviewSet(hash, 256, 144, 5, false);
  await f.store.writeNewRecord(privatePreviewSetMemberId(set, 'thumbnail'), Buffer.from('Current thumbnail'));
  await f.store.writeNewRecord(privatePreviewSetMemberId(set, 'filmstrip'), Buffer.from('Current filmstrip'));
  await publishPrivatePreviewSet(f.store, set, () => true);
  const before = await fingerprint(f.directory);
  assert.equal((await exportPrivateHubToPlaintext(f.store, f.options)).previewCount, 2);
  assert.equal((await fs.readFile(path.join(f.assets, 'thumbnails', hash + '.jpg'))).toString(), 'Current thumbnail');
  assert.deepEqual(await fs.readdir(path.join(f.assets, 'clips')), []);
  assert.deepEqual(await fingerprint(f.directory), before);
});

test('current generated clip members are streamed from their selected generation', async t => {
  const f = await fixture(t);
  const set = createPrivatePreviewSet(hash, 256, 144, 5, true);
  for (const kind of ['thumbnail', 'filmstrip', 'clip-poster'] as const) {
    await f.store.writeNewRecord(privatePreviewSetMemberId(set, kind), Buffer.from('Current ' + kind));
  }
  const current = Buffer.from('Current private clip');
  await media.writePrivateHubMedia(f.store, privatePreviewSetMemberId(set, 'clip'), (async function* () { yield current; })());
  await publishPrivatePreviewSet(f.store, set, () => true);
  assert.equal((await exportPrivateHubToPlaintext(f.store, f.options)).previewCount, 4);
  assert.deepEqual(await fs.readFile(path.join(f.assets, 'clips', hash + '.mp4')), current);
});

test('genuinely absent legacy previews retain their missing state without regeneration', async t => {
  const f = await fixture(t, false);
  const before = await fingerprint(f.directory);
  assert.deepEqual(await exportPrivateHubToPlaintext(f.store, f.options), { previewCount: 0, byteLength: f.raw.length });
  assert.deepEqual(await fs.readFile(f.ordinary), f.raw);
  for (const kind of ['thumbnails', 'filmstrips', 'clips']) { assert.deepEqual(await fs.readdir(path.join(f.assets, kind)), []); }
  assert.deepEqual(await fingerprint(f.directory), before);
});

test('missing current-set members never fall back to available legacy previews', async t => {
  const f = await fixture(t);
  await publishPrivatePreviewSet(f.store, createPrivatePreviewSet(hash, 256, 144, 5, true), () => true);
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  await assertNoCatalogue(f.ordinary);
});

test('corrupt preview-set and clip manifests cannot be silently treated as missing', async t => {
  const f = await fixture(t);
  await f.store.writeRecord(privatePreviewSetRecordId(hash), Buffer.from('{broken'));
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  await assertNoCatalogue(f.ordinary);
  const g = await fixture(t);
  await g.store.writeRecord(media.privateHubMediaManifestRecordId('preview:clip:' + hash), Buffer.from('{broken'));
  await assert.rejects(exportPrivateHubToPlaintext(g.store, g.options));
  await assertNoCatalogue(g.ordinary);
});

test('legacy backup-only image and clip manifests require recovery, never absence fallback', async t => {
  for (const id of ['preview:thumbnail:' + hash, media.privateHubMediaManifestRecordId('preview:clip:' + hash)]) {
    const f = await fixture(t);
    const original = f.store.readRecord.bind(f.store);
    t.mock.method(f.store, 'readRecord', async (recordId: string, maximum?: number) => {
      if (recordId === id) { throw absent(); }
      return original(recordId, maximum);
    });
    const backup = t.mock.method(f.store, 'readBackupRecord', async (recordId: string) => {
      if (recordId === id) { return Buffer.from('Surviving backup'); }
      throw absent();
    });
    await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
    assert.ok(backup.mock.callCount() > 0);
    await assertNoCatalogue(f.ordinary);
  }
});

test('relative, nested, ancestor, existing and symlinked destinations are refused without overwriting data', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.destination);
  const marker = path.join(f.destination, 'keep.txt');
  await fs.writeFile(marker, 'Unrelated destination');
  const alias = path.join(f.root, 'alias');
  await fs.symlink(f.destination, alias, 'dir');
  for (const destinationDirectory of ['relative-path', f.directory, path.join(f.directory, 'nested'), f.root,
    f.destination, alias, path.join(alias, 'new-copy')]) {
    await assert.rejects(exportPrivateHubToPlaintext(f.store, { ...f.options, destinationDirectory }));
  }
  assert.equal(await fs.readFile(marker, 'utf8'), 'Unrelated destination');
  assert.deepEqual(await fs.readdir(f.destination), ['keep.txt']);
});

test('linked source recovery state is refused without removing publication aliases', async t => {
  const f = await fixture(t);
  const primary = (await fs.readdir(f.directory)).find(name => name.endsWith('.sealed'))!;
  const source = path.join(f.directory, primary);
  await fs.link(source, source + '.' + 'a'.repeat(48) + '.pending');
  const before = await fingerprint(f.directory);
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  assert.deepEqual(await fingerprint(f.directory), before);
  await assertNoCatalogue(f.ordinary);
});

test('preview identity count is bounded before destination creation', async t => {
  const f = await fixture(t, false);
  const images = Array.from({ length: 25001 }, (_, index) => ({ ...f.catalogue.images[0], hash: 'video-' + index }));
  await f.store.writeRecord('catalogue', Buffer.from(JSON.stringify({ ...f.catalogue, images })));
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  await assertNoCatalogue(f.destination);
});

test('image and clip byte limits reject oversized authenticated inputs', async t => {
  const f = await fixture(t, false);
  await f.store.writeRecord('preview:thumbnail:' + hash, Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  await assertNoCatalogue(f.ordinary);
  const g = await fixture(t, false);
  await g.store.writeRecord(media.privateHubMediaManifestRecordId('preview:clip:' + hash), Buffer.from(JSON.stringify({
    format: 'theatrum-private-hub-media', version: 1, generation: 'a'.repeat(48), chunkBytes: media.PRIVATE_HUB_MEDIA_CHUNK_BYTES,
    byteLength: media.PRIVATE_HUB_MEDIA_MAX_BYTES + 1, chunkCount: 1025,
  })));
  await assert.rejects(exportPrivateHubToPlaintext(g.store, g.options));
  await assertNoCatalogue(g.ordinary);
});

test('quiescence must be synchronous and cancellation from progress prevents catalogue publication', async t => {
  const f = await fixture(t);
  await assert.rejects(exportPrivateHubToPlaintext(f.store, { ...f.options, assertSourceQuiescent: async () => undefined }));
  await assertNoCatalogue(f.destination);
  const controller = new AbortController();
  await assert.rejects(exportPrivateHubToPlaintext(f.store, { ...f.options, signal: controller.signal,
    onProgress: () => controller.abort() }));
  await assertNoCatalogue(f.ordinary);
  assert.equal(f.store.locked, false);
});

test('cancellation after final link admission returns failure even if the catalogue became visible', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const original = fs.link;
  t.mock.method(fs, 'link', async (...args: Parameters<typeof original>) => {
    await original(...args);
    if (args[1] === f.ordinary) { controller.abort(); }
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, { ...f.options, signal: controller.signal }));
  assert.deepEqual(await fs.readFile(f.ordinary), f.raw);
  assert.equal((await fs.stat(f.ordinary)).nlink, 2, 'Interrupted plaintext publication is retained, not silently rolled back');
});

test('catalogue changes during plaintext staging are detected before final publication', async t => {
  const f = await fixture(t);
  const original = fs.open;
  let mutated = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (path.basename(String(args[0])).startsWith('.catalogue-')) {
      const write = handle.write.bind(handle);
      t.mock.method(handle, 'write', async (...writeArgs: Parameters<typeof write>) => {
        const result = await write(...writeArgs);
        if (!mutated) { mutated = true; await f.store.writeRecord('catalogue', Buffer.from(JSON.stringify({ ...f.catalogue, hubName: 'Changed source' }))); }
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  assert.equal(mutated, true);
  await assertNoCatalogue(f.ordinary);
});

test('a new preview set or previously absent legacy preview during copying prevents publication', async t => {
  for (const change of ['set', 'missing']) {
    const f = await fixture(t, false);
    let writing: Promise<unknown> | undefined;
    let changed = false;
    const original = f.store.readRecord.bind(f.store);
    t.mock.method(f.store, 'readRecord', async (id: string, maximum?: number) => {
      if (id === 'catalogue' && changed) { await writing; }
      return original(id, maximum);
    });
    await assert.rejects(exportPrivateHubToPlaintext(f.store, { ...f.options, onProgress: counts => {
      if (!changed && counts.stage === 'verifying') {
        changed = true;
        writing = change === 'set' ? publishPrivatePreviewSet(f.store, createPrivatePreviewSet(hash, 256, 144, 5, false), () => true)
          : f.store.writeRecord('preview:thumbnail:' + hash, Buffer.from('New preview'));
      }
    } }));
    await writing;
    await assertNoCatalogue(f.ordinary);
  }
});

test('target substitution is rejected without writing through an unrelated symlink', async t => {
  const f = await fixture(t);
  const unrelated = path.join(f.root, 'unrelated.jpg');
  await fs.writeFile(unrelated, 'Do not change');
  let substituted = false;
  const original = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof original>) => {
    const target = String(args[0]);
    if (!substituted && target === path.join(f.assets, 'thumbnails', hash + '.jpg')) {
      substituted = true;
      await fs.symlink(unrelated, target);
    }
    return original(...args);
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'Do not change');
  await assertNoCatalogue(f.ordinary);
});

test('a destination directory replaced during the copy is not adopted', async t => {
  const f = await fixture(t);
  const original = fs.open;
  let changed = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (!changed && String(args[0]) === path.join(f.assets, 'thumbnails', hash + '.jpg')) {
      changed = true;
      await fs.rename(f.destination, f.destination + '-moved');
      await fs.mkdir(f.destination);
    }
    return handle;
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  assert.deepEqual(await fs.readdir(f.destination), []);
  await assertNoCatalogue(f.ordinary);
});

test('plaintext chunks are wiped and output FDs close when cancellation interrupts a write', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const original = fs.open;
  let retained: Buffer | undefined;
  let closed = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (String(args[0]) === path.join(f.assets, 'thumbnails', hash + '.jpg')) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { closed = true; return close(); });
      const write = handle.write.bind(handle);
      t.mock.method(handle, 'write', async (...writeArgs: Parameters<typeof write>) => {
        retained = writeArgs[0] as Buffer;
        const result = await write(...writeArgs);
        controller.abort();
        assert.ok(retained.every(byte => byte === 0), 'Owned source bytes are wiped synchronously on abort');
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, { ...f.options, signal: controller.signal }));
  assert.ok(retained?.every(byte => byte === 0));
  assert.equal(closed, true);
  await assertNoCatalogue(f.ordinary);
});

test('an output FD close failure is branded for permanent session quarantine', async t => {
  const f = await fixture(t);
  const original = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (String(args[0]) === path.join(f.assets, 'thumbnails', hash + '.jpg')) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); throw new Error('Synthetic ambiguous close'); });
    }
    return handle;
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options), isPrivateHubPlaintextExportCleanupFailure);
  assert.equal(isPrivateHubPlaintextExportCleanupFailure(new Error('The unencrypted hub copy cleanup could not be confirmed.')), false);
  await assertNoCatalogue(f.ordinary);
});

test('failed iterator teardown is branded and takes precedence over ordinary cancellation', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const original = media.openPrivateHubMedia;
  t.mock.method(media, 'openPrivateHubMedia', async (...args: Parameters<typeof original>) => {
    const reader = await original(...args);
    return { byteLength: reader.byteLength, readRange: () => ({
      [Symbol.asyncIterator]() { return this; },
      async next() { controller.abort(); return { done: false, value: Buffer.from('Cancelled private chunk') }; },
      async return() { throw new Error('Synthetic incomplete teardown'); },
    }) };
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, { ...f.options, signal: controller.signal }), isPrivateHubPlaintextExportCleanupFailure);
  await assertNoCatalogue(f.ordinary);
});

test('authenticated image corruption fails instead of being exported or treated as absent', async t => {
  const f = await fixture(t, false);
  const before = new Set(await fs.readdir(f.directory));
  await writePrivateHubPreview(f.store, 'thumbnail', hash, payloads.thumbnail);
  const name = (await fs.readdir(f.directory)).find(entry => !before.has(entry))!;
  const file = path.join(f.directory, name);
  const encrypted = await fs.readFile(file);
  encrypted[encrypted.length - 1] ^= 1;
  await fs.writeFile(file, encrypted);
  const damaged = await fingerprint(f.directory);
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  assert.deepEqual(await fingerprint(f.directory), damaged);
  await assertNoCatalogue(f.ordinary);
});

test('a missing authenticated clip chunk is a failed copy rather than an absent legacy clip', async t => {
  const f = await fixture(t);
  const original = f.store.readRecord.bind(f.store);
  t.mock.method(f.store, 'readRecord', async (id: string, maximum?: number) => {
    if (id.startsWith('media-chunk:')) { throw absent(); }
    return original(id, maximum);
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  await assertNoCatalogue(f.ordinary);
});

test('destination readback hashes detect bytes corrupted before the final inode snapshot', async t => {
  const f = await fixture(t);
  const original = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (String(args[0]) === path.join(f.assets, 'thumbnails', hash + '.jpg') && (Number(args[1]) & 1) === 1) {
      const write = handle.write.bind(handle);
      t.mock.method(handle, 'write', async (...writeArgs: Parameters<typeof write>) => {
        const result = await write(...writeArgs);
        await write(Buffer.from('X'), 0, 1, 0);
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(exportPrivateHubToPlaintext(f.store, f.options));
  await assertNoCatalogue(f.ordinary);
});

test('asynchronous progress observers cannot outlive a successful copy acknowledgement', async t => {
  const f = await fixture(t);
  await assert.rejects(exportPrivateHubToPlaintext(f.store, { ...f.options, onProgress: async () => { throw new Error('Synthetic observer failure'); } }));
  await assertNoCatalogue(f.ordinary);
});
