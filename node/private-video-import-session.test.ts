import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { capturePrivatePreviewSource, isPrivatePreviewSourceCleanupFailure, type PrivatePreviewSource } from './private-preview-source';
import { createPrivatePreviewSet, privatePreviewSetMemberId, publishPrivatePreviewSet } from './private-hub-preview-set';
import * as generation from './private-hub-preview-generation';

const password = 'Synthetic manual import password';
const marker = 'PRIVATE_IMPORT_SESSION_CANARY';
const metadata = { duration: 3.5, width: 160, height: 90, fps: 30, hasAudio: false };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-import-session-'));
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(path.join(sourceRoot, 'nested'), { recursive: true });
  const file = path.join(sourceRoot, 'nested', marker + '.mp4');
  await fs.writeFile(file, 'SYNTHETIC ORIGINAL VIDEO');
  const directory = path.join(root, 'encrypted');
  const catalogue: FinalObject = { addTags: ['added vocabulary'], removeTags: ['removed vocabulary'],
    hubName: marker, version: 3, numOfFolders: 17,
    images: [{ ...NewImageElement(), hash: 'existing', cleanName: 'Existing', fileName: 'existing.mp4', notes: marker,
      tags: ['Existing tag'], lastPlayed: 1234, timesPlayed: 2 }],
    inputDirs: { 0: { path: sourceRoot, watch: true, ignoredSubdirectories: ['B', 'A', 'A'] } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 } };
  Object.assign(catalogue, { futureCatalogue: { retained: true } });
  Object.assign(catalogue.images[0], { futureImage: { retained: true } });
  Object.assign(catalogue.inputDirs[0], { futureSource: { retained: true } });
  const initial = await PrivateHubStore.create(directory, password);
  await writePrivateHubCatalogue(initial, catalogue);
  const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: initial.hubId }));
  try { await initial.writeNewRecord('session:activation', activation); }
  finally { activation.fill(0); await initial.lock(); }
  let store!: PrivateHubStore;
  const nativeOpen = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (target: string, secret: string) => { store = await nativeOpen(target, secret); return store; });
  const session = new PrivateHubSession();
  const { generation: currentGeneration } = await session.unlock(directory, password);
  let quarantined = false;
  t.after(async () => {
    if (quarantined) { await assert.rejects(session.close(), isPrivatePreviewSourceCleanupFailure); }
    else { await session.close(); }
  });
  const controller = new AbortController();
  let allowed = true;
  const current = (): boolean => allowed && !controller.signal.aborted && session.isCurrent(currentGeneration);
  const location = { hash: 'fresh-import-hash', root: sourceRoot, inputSource: 0, partialPath: '/nested', fileName: path.basename(file) };
  const capture = () => capturePrivatePreviewSource({ ...location, signal: controller.signal, isCurrent: current });
  const source = await capture();
  t.after(async () => { if (!quarantined) { await source.close(); } });
  const readStored = async (): Promise<FinalObject> => {
    const bytes = await store.readRecord('catalogue');
    try { return JSON.parse(bytes.toString('utf8')) as FinalObject; }
    finally { bytes.fill(0); }
  };
  return { root, file, sourceRoot, directory, catalogue, session, store, generation: currentGeneration,
    controller, location, source, capture, readStored, current, revoke: () => { allowed = false; },
    expectQuarantine: () => { quarantined = true; } };
}
function mockGenerator(t: TestContext, before?: (source: PrivatePreviewSource) => Promise<void>) {
  return t.mock.method(generation, 'generatePrivateHubPreviews', async (
    store: PrivateHubStore, source: PrivatePreviewSource, settings: FinalObject['screenshotSettings'],
    options: generation.PrivatePreviewGenerationOptions,
  ) => {
    assert.equal(options.isCurrent(), true);
    options.onMetadata?.(Object.freeze(metadata));
    await before?.(source);
    if (!options.isCurrent()) { throw new Error('Synthetic cancellation'); }
    const set = createPrivatePreviewSet(source.hash, settings.height * 16 / 9, settings.height, 3, false);
    await store.writeNewRecord(privatePreviewSetMemberId(set, 'thumbnail'), Buffer.from(marker + '-thumbnail'));
    await store.writeNewRecord(privatePreviewSetMemberId(set, 'filmstrip'), Buffer.from(marker + '-filmstrip'));
    await publishPrivatePreviewSet(store, set, options.isCurrent);
    return set;
  });
}

test('manual import publishes one encrypted row after complete previews and preserves raw catalogue data', async t => {
  const f = await fixture(t);
  mockGenerator(t, async source => {
    assert.deepEqual(await f.readStored(), f.catalogue);
    await assert.rejects(f.session.createPreviewResponse(f.generation, 'thumbnail', source.hash, new Request('theatrum://app/media')));
  });
  const before = await fs.readFile(f.file);
  const result = await f.session.importVideo(f.generation, f.source, f.location, { isCurrent: f.current });
  assert.deepEqual(result, { status: 'imported', index: 1 });
  assert.equal(f.source.signal.aborted, true);
  const saved = await f.readStored();
  const imported = saved.images.pop()!;
  assert.equal(saved.numOfFolders, 2, 'derived folder count includes the imported subdirectory');
  assert.deepEqual(saved, { ...f.catalogue, numOfFolders: 2 });
  assert.equal(imported.hash, f.location.hash);
  assert.equal(imported.duration, metadata.duration);
  assert.equal(imported.fps, metadata.fps);
  assert.equal(imported.width, metadata.width);
  assert.equal(imported.fileSize, before.length);
  assert.equal(imported.screens, 3);
  assert.ok(imported.dateAdded! > 0);
  assert.deepEqual(await fs.readFile(f.file), before);
  const response = await f.session.createPreviewResponse(f.generation, 'thumbnail', imported.hash, new Request('theatrum://app/media'));
  assert.equal(await response.text(), marker + '-thumbnail');
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images.length, 2);
  assert.equal(reopened.catalogue.images[1].hash, imported.hash);
  for (const name of await fs.readdir(f.directory)) {
    const bytes = await fs.readFile(path.join(f.directory, name));
    for (const value of [marker, password, f.file, f.sourceRoot]) { assert.equal(bytes.includes(Buffer.from(value)), false); }
  }
});

test('consecutive imports release admission after success and duplicate while retaining encrypted results', async t => {
  const f = await fixture(t);
  const generated = mockGenerator(t);
  const secondLocation = { ...f.location, hash: 'second-batch-import-hash', fileName: marker + '-second.mp4' };
  const secondFile = path.join(f.sourceRoot, 'nested', secondLocation.fileName);
  const secondOriginal = Buffer.from('SYNTHETIC SECOND ORIGINAL VIDEO');
  await fs.writeFile(secondFile, secondOriginal);
  const firstOriginal = await fs.readFile(f.file);
  const first = await f.session.importVideo(f.generation, f.source, f.location,
    { signal: f.controller.signal, isCurrent: f.current });
  assert.deepEqual(first, { status: 'imported', index: 1 });
  assert.equal(f.source.signal.aborted, true);
  const duplicateLocation = { ...f.location, hash: 'duplicate-batch-import-hash' };
  const duplicate = await capturePrivatePreviewSource({ ...duplicateLocation, signal: f.controller.signal, isCurrent: f.current });
  t.after(() => duplicate.close());
  assert.deepEqual(await f.session.importVideo(f.generation, duplicate, duplicateLocation,
    { signal: f.controller.signal, isCurrent: f.current }), { status: 'duplicate' });
  assert.equal(duplicate.signal.aborted, true);
  const second = await capturePrivatePreviewSource({ ...secondLocation, signal: f.controller.signal, isCurrent: f.current });
  t.after(() => second.close());
  assert.deepEqual(await f.session.importVideo(f.generation, second, secondLocation,
    { signal: f.controller.signal, isCurrent: f.current }), { status: 'imported', index: 2 });
  assert.equal(second.signal.aborted, true);
  assert.equal(generated.mock.callCount(), 2, 'duplicate does not decode or generate previews');
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(reopened.catalogue.images.map(image => image.hash), ['existing', f.location.hash, secondLocation.hash]);
  for (const hash of [f.location.hash, secondLocation.hash]) {
    const response = await f.session.createPreviewResponse(reopened.generation, 'thumbnail', hash, new Request('theatrum://app/media'));
    assert.equal(await response.text(), marker + '-thumbnail');
  }
  assert.deepEqual(await fs.readFile(f.file), firstOriginal);
  assert.deepEqual(await fs.readFile(secondFile), secondOriginal);
  for (const name of await fs.readdir(f.directory)) {
    const bytes = await fs.readFile(path.join(f.directory, name));
    for (const value of [marker, password, f.sourceRoot, firstOriginal, secondOriginal]) {
      assert.equal(bytes.includes(typeof value === 'string' ? Buffer.from(value) : value), false);
    }
  }
});

test('duplicate locations are rejected before decoding without changing catalogue', async t => {
  const f = await fixture(t);
  const newer = structuredClone(f.catalogue);
  newer.inputDirs[1] = { path: path.join(f.sourceRoot, 'nested'), watch: false };
  newer.images.push({ ...NewImageElement(), hash: 'other-existing', fileName: f.location.fileName,
    cleanName: 'Overlapping root', inputSource: 1, partialPath: '', missing: true });
  await f.session.writeCatalogue(f.generation, newer);
  const generated = mockGenerator(t);
  assert.deepEqual(await f.session.importVideo(f.generation, f.source, f.location, { isCurrent: f.current }), { status: 'duplicate' });
  assert.equal(generated.mock.callCount(), 0);
  assert.deepEqual(await f.readStored(), newer);
});

for (const change of ['root', 'hash', 'ignored'] as const) {
  test(`${change} conflicts or invalidates import before decoding`, async t => {
    const f = await fixture(t);
    const newer = structuredClone(f.catalogue);
    if (change === 'root') { newer.inputDirs[0].path = path.join(f.root, 'different-root'); }
    if (change === 'hash') { newer.images[0].hash = f.location.hash; newer.images[0].deleted = true; }
    if (change === 'ignored') { newer.inputDirs[0].ignoredSubdirectories = ['nested']; }
    await f.session.writeCatalogue(f.generation, newer);
    const generated = mockGenerator(t);
    assert.deepEqual(await f.session.importVideo(f.generation, f.source, f.location, { isCurrent: f.current }),
      { status: change === 'ignored' ? 'invalid' : 'conflict' });
    assert.equal(generated.mock.callCount(), 0);
    assert.deepEqual(await f.readStored(), newer);
  });
}

test('unbranded sources and mismatched locations cannot invoke authority or consume a real source', async t => {
  const f = await fixture(t);
  const fake = { ...f.source } as PrivatePreviewSource;
  await assert.rejects(f.session.importVideo(f.generation, fake, f.location, { isCurrent: () => { assert.fail('No forged callback'); } }));
  await assert.rejects(f.session.importVideo(f.generation, f.source, { ...f.location, hash: 'wrong' }, { isCurrent: f.current }));
  assert.equal(f.source.isCurrent(), true);
});

test('mutation admission closes synchronously and other saves are refused while decoding', async t => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  mockGenerator(t, async () => { entered.resolve(); await release.promise; });
  const second = await f.capture();
  t.after(() => second.close());
  const importing = f.session.importVideo(f.generation, f.source, f.location, { isCurrent: f.current });
  await assert.rejects(f.session.importVideo(f.generation, second, f.location, { isCurrent: f.current }));
  await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue));
  await entered.promise;
  assert.equal(second.isCurrent(), true, 'rejected admission retains caller ownership');
  assert.equal((await f.session.readCatalogue(f.generation)).images.length, 1);
  release.resolve();
  assert.deepEqual(await importing, { status: 'imported', index: 1 });
});

test('authority callback reentrant writes prevent import admission', async t => {
  const f = await fixture(t);
  let writing: Promise<void> | undefined;
  const generated = mockGenerator(t);
  await assert.rejects(f.session.importVideo(f.generation, f.source, f.location, { isCurrent: () => {
    writing ??= f.session.writeCatalogue(f.generation, f.catalogue); return true;
  } }));
  await writing;
  assert.equal(generated.mock.callCount(), 0);
  assert.equal(f.source.isCurrent(), true);
});

test('cancellation while decoding preserves catalogue, drains source and permits another operation', async t => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  mockGenerator(t, async () => { entered.resolve(); await release.promise; });
  const importing = f.session.importVideo(f.generation, f.source, f.location, { signal: f.controller.signal, isCurrent: f.current });
  const failed = assert.rejects(importing, /private hub session is unavailable/);
  await entered.promise;
  f.controller.abort(); release.resolve(); await failed;
  assert.equal(f.source.signal.aborted, true);
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.deepEqual(await f.readStored(), f.catalogue);
  await f.session.writeCatalogue(f.generation, f.catalogue);
});

test('locking waits for an admitted decoder and prevents a late catalogue append', async t => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  mockGenerator(t, async () => { entered.resolve(); await release.promise; });
  const importing = f.session.importVideo(f.generation, f.source, f.location, { isCurrent: f.current });
  const failed = assert.rejects(importing);
  await entered.promise;
  let locked = false;
  const locking = f.session.lock().then(() => { locked = true; });
  await Promise.resolve();
  assert.equal(locked, false);
  release.resolve(); await failed; await locking;
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images.length, 1);
});

test('replaced source after preview staging cannot append a catalogue row', async t => {
  const f = await fixture(t);
  mockGenerator(t);
  const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, isCurrent?: () => boolean) => {
    await write(id, bytes, isCurrent);
    if (id.startsWith('preview-set:')) {
      await fs.rename(f.file, f.file + '.old');
      await fs.writeFile(f.file, 'replacement');
    }
  });
  await assert.rejects(f.session.importVideo(f.generation, f.source, f.location, { isCurrent: f.current }));
  assert.deepEqual(await f.readStored(), f.catalogue);
  assert.equal(f.source.signal.aborted, true);
});

test('cancel at catalogue publication guard refuses append and wipes retained output', async t => {
  const f = await fixture(t);
  mockGenerator(t);
  const write = f.store.writeRecord.bind(f.store);
  let output: Buffer | undefined;
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, isCurrent?: () => boolean) => {
    if (id === 'catalogue') {
      output = bytes;
      f.revoke();
      assert.equal(isCurrent?.(), false);
    }
    return write(id, bytes, isCurrent);
  });
  await assert.rejects(f.session.importVideo(f.generation, f.source, f.location, { isCurrent: f.current }));
  assert.ok(output);
  assert.equal(output.every(byte => byte === 0), true);
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images.length, 1);
});

test('post-commit cancellation does not claim rollback and reopened catalogue retains committed import', async t => {
  const f = await fixture(t);
  mockGenerator(t);
  const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, isCurrent?: () => boolean) => {
    await write(id, bytes, isCurrent);
    if (id === 'catalogue') { f.controller.abort(); }
  });
  await assert.rejects(f.session.importVideo(f.generation, f.source, f.location, { signal: f.controller.signal, isCurrent: f.current }));
  assert.equal(f.session.status.state, 'locked', 'a committed row cannot survive with a stale preview allowlist');
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images.length, 2);
  assert.equal(reopened.catalogue.images[1].hash, f.location.hash);
});

test('source descriptor cleanup failure quarantines the session even after decoding failure', async t => {
  const f = await fixture(t);
  const open = fs.open.bind(fs);
  const closers: (() => Promise<void>)[] = [];
  const nativeFs: typeof fs = require('node:fs/promises');
  const openMock = t.mock.method(nativeFs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === f.file) {
      closers.push(handle.close.bind(handle));
      t.mock.method(handle, 'close', async () => { throw new Error(marker); });
    }
    return handle;
  });
  t.mock.method(generation, 'generatePrivateHubPreviews', async (_store: PrivateHubStore, source: PrivatePreviewSource) => {
    const lease = await source.open();
    await lease.close();
    throw new Error('Unreachable');
  });
  f.expectQuarantine();
  await assert.rejects(f.session.importVideo(f.generation, f.source, f.location, { isCurrent: f.current }), isPrivatePreviewSourceCleanupFailure);
  assert.equal(f.session.status.state, 'locked');
  openMock.mock.restore();
  for (const close of closers) { await close(); }
});
