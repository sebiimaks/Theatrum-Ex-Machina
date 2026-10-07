import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { privateVideoRevision } from './private-hub-metadata';
import { capturePrivatePreviewSource, isPrivatePreviewSourceCleanupFailure, type PrivatePreviewSource } from './private-preview-source';
import { createPrivatePreviewSet, privatePreviewSetMemberId, publishPrivatePreviewSet } from './private-hub-preview-set';
import * as generation from './private-hub-preview-generation';

const password = 'Synthetic refresh session password';
const marker = 'PRIVATE_REFRESH_SESSION_CANARY';
const metadata = { duration: 20, width: 640, height: 360, fps: 23.976, hasAudio: true };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-refresh-session-'));
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(path.join(sourceRoot, 'nested'), { recursive: true });
  const file = path.join(sourceRoot, 'nested', marker + '.mp4');
  await fs.writeFile(file, 'SYNTHETIC CHANGED ORIGINAL VIDEO');
  const directory = path.join(root, 'encrypted');
  const catalogue: FinalObject = { addTags: ['vocabulary'], removeTags: ['retained'],
    hubName: marker, version: 3, numOfFolders: 17,
    images: [{ ...NewImageElement(), hash: 'existing', cleanName: 'User title', fileName: path.basename(file), partialPath: '/nested',
      notes: marker, tags: ['Keep tag', 'Keep tag'], stars: 4.5, lastPlayed: 1234, timesPlayed: 2,
      dateAdded: 5000, playlist: 42, year: 2001, defaultScreen: 1, missing: true,
      duration: 10, width: 320, height: 180, fps: 30, fileSize: 200, screens: 3 }],
    inputDirs: { 0: { path: sourceRoot, watch: true, ignoredSubdirectories: ['B', 'A', 'A'] } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 4 } };
  Object.assign(catalogue, { futureCatalogue: { retained: true } });
  Object.assign(catalogue.images[0], { futureImage: { retained: true }, metadataImportFailed: true });
  Object.assign(catalogue.inputDirs[0], { futureSource: { retained: true } });
  const initial = await PrivateHubStore.create(directory, password);
  await writePrivateHubCatalogue(initial, catalogue);
  await initial.writeNewRecord('preview:thumbnail:existing', Buffer.from('old-thumbnail'));
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
  const location = { hash: 'fresh-refresh-hash', root: sourceRoot, inputSource: 0, partialPath: '/nested', fileName: path.basename(file) };
  const capture = () => capturePrivatePreviewSource({ ...location, signal: controller.signal, isCurrent: current });
  const source = await capture();
  t.after(async () => { if (!quarantined) { await source.close(); } });
  const readStored = async (): Promise<FinalObject> => {
    const bytes = await store.readRecord('catalogue');
    try { return JSON.parse(bytes.toString('utf8')) as FinalObject; }
    finally { bytes.fill(0); }
  };
  const update = { index: 0, revision: privateVideoRevision((await session.readCatalogue(currentGeneration)).images[0]) };
  return { root, file, sourceRoot, directory, catalogue, session, store, generation: currentGeneration,
    controller, location, source, capture, readStored, current, update, revoke: () => { allowed = false; },
    expectQuarantine: () => { quarantined = true; } };
}
function mockGenerator(t: TestContext, before?: (source: PrivatePreviewSource) => Promise<void>) {
  return t.mock.method(generation, 'generatePrivateHubPreviews', async (
    store: PrivateHubStore, source: PrivatePreviewSource, settings: FinalObject['screenshotSettings'],
    options: generation.PrivatePreviewGenerationOptions,
  ) => {
    assert.equal(options.isCurrent(), true);
    assert.equal(options.expectedScreenCount, undefined, 'refresh allows the new geometry');
    options.onMetadata?.(Object.freeze(metadata));
    await before?.(source);
    if (!options.isCurrent()) { throw new Error('Synthetic cancellation'); }
    const set = createPrivatePreviewSet(source.hash, settings.height * 16 / 9, settings.height, 4, false);
    await store.writeNewRecord(privatePreviewSetMemberId(set, 'thumbnail'), Buffer.from(marker + '-thumbnail'));
    await store.writeNewRecord(privatePreviewSetMemberId(set, 'filmstrip'), Buffer.from(marker + '-filmstrip'));
    await publishPrivatePreviewSet(store, set, options.isCurrent);
    return set;
  });
}

test('complete previews and technical fields become reachable through one catalogue publication', async t => {
  const f = await fixture(t);
  const oldSource = await fs.readFile(f.file);
  mockGenerator(t, async source => {
    assert.deepEqual(await f.readStored(), f.catalogue);
    const response = await f.session.createPreviewResponse(f.generation, 'thumbnail', 'existing', new Request('theatrum://app/media'));
    assert.equal(await response.text(), 'old-thumbnail');
    await assert.rejects(f.session.createPreviewResponse(f.generation, 'thumbnail', source.hash, new Request('theatrum://app/media')));
  });
  const result = await f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current });
  assert.equal(result.status, 'refreshed');
  if (result.status !== 'refreshed') { assert.fail('Expected refreshed result'); }
  const saved = await f.readStored();
  assert.deepEqual(saved.images[0], result.image);
  const expected = { ...f.catalogue.images[0], hash: f.location.hash, fileSize: oldSource.length,
    birthtime: Math.round(f.source.birthtime), mtime: Math.round(f.source.mtime), duration: metadata.duration,
    width: metadata.width, height: metadata.height, fps: metadata.fps,
    bitrate: Math.round(oldSource.length / metadata.duration / 1_000_000 * 100) / 100, screens: 4 };
  assert.deepEqual(saved, { ...f.catalogue, images: [expected] });
  assert.deepEqual(await fs.readFile(f.file), oldSource);
  assert.equal(f.source.signal.aborted, true);
  const response = await f.session.createPreviewResponse(f.generation, 'thumbnail', f.location.hash, new Request('theatrum://app/media'));
  assert.equal(await response.text(), marker + '-thumbnail');
  await assert.rejects(f.session.createPreviewResponse(f.generation, 'thumbnail', 'existing', new Request('theatrum://app/media')));
  const backup = await f.store.readBackupRecord('catalogue');
  try { assert.deepEqual(JSON.parse(backup.toString()), f.catalogue); } finally { backup.fill(0); }
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images[0].hash, f.location.hash);
  assert.equal(reopened.catalogue.images[0].screens, 4);
  for (const name of await fs.readdir(f.directory)) {
    const bytes = await fs.readFile(path.join(f.directory, name));
    for (const value of [marker, password, f.file, f.sourceRoot, oldSource]) {
      assert.equal(bytes.includes(typeof value === 'string' ? Buffer.from(value) : value), false);
    }
  }
});

for (const change of ['notes', 'root', 'aliases', 'old-hash-owner', 'new-hash-owner', 'ignored'] as const) {
  test(`${change} change refuses refresh before any decode`, async t => {
    const f = await fixture(t);
    const newer = structuredClone(f.catalogue);
    if (change === 'notes') { newer.images[0].notes = 'Changed'; }
    if (change === 'root') { newer.inputDirs[0].path += '-different'; }
    if (change === 'aliases') {
      newer.images[0].locations = [
        { fileName: f.location.fileName, inputSource: 0, partialPath: '/nested', missing: true },
        { fileName: 'other.mp4', inputSource: 0, partialPath: '/nested', missing: true },
      ];
    }
    if (change === 'old-hash-owner') { newer.images.push({ ...newer.images[0], deleted: true }); }
    if (change === 'new-hash-owner') { newer.images.push({ ...newer.images[0], hash: f.location.hash, deleted: true }); }
    if (change === 'ignored') { newer.inputDirs[0].ignoredSubdirectories = ['nested']; }
    await f.session.writeCatalogue(f.generation, newer);
    if (change === 'aliases') { f.update.revision = privateVideoRevision(newer.images[0]); }
    const generated = mockGenerator(t);
    assert.deepEqual(await f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current }),
      { status: change === 'aliases' || change === 'ignored' ? 'invalid' : 'conflict' });
    assert.equal(generated.mock.callCount(), 0);
    assert.deepEqual(await f.readStored(), newer);
    assert.equal(f.source.signal.aborted, true);
  });
}

test('existing encrypted manifest under a proposed new namespace cannot be replaced', async t => {
  const f = await fixture(t); const generated = mockGenerator(t);
  const existing = createPrivatePreviewSet(f.location.hash, 256, 144, 3, false);
  await publishPrivatePreviewSet(f.store, existing, () => true);
  assert.deepEqual(await f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current }), { status: 'conflict' });
  assert.equal(generated.mock.callCount(), 0);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('invalid requests, forged capabilities and mismatched bindings do not consume a valid source', async t => {
  const f = await fixture(t); const generated = mockGenerator(t);
  assert.deepEqual(await f.session.refreshVideo(f.generation, f.source, f.location, { index: -1, revision: '' },
    { isCurrent: () => { assert.fail('No callback for malformed request'); } }), { status: 'invalid' });
  await assert.rejects(f.session.refreshVideo(f.generation, { ...f.source } as PrivatePreviewSource, f.location, f.update,
    { isCurrent: () => { assert.fail('No callback for forged source'); } }));
  await assert.rejects(f.session.refreshVideo(f.generation, f.source, { ...f.location, hash: 'other' }, f.update, { isCurrent: f.current }));
  assert.equal(f.source.isCurrent(), true);
  assert.equal(generated.mock.callCount(), 0);
});

test('reservation precedes authority callbacks and blocks competing writes and regeneration', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred();
  t.after(release.resolve);
  mockGenerator(t, async () => { entered.resolve(); await release.promise; });
  let attempted = false; let rejectedWrite: Promise<void> | undefined;
  const second = await f.capture(); t.after(() => second.close());
  const refreshing = f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: () => {
    if (!attempted) {
      attempted = true;
      rejectedWrite = assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue));
    }
    return f.current();
  } });
  assert.deepEqual(await f.session.refreshVideo(f.generation, second, f.location, f.update, { isCurrent: f.current }), { status: 'busy' });
  await assert.rejects(f.session.generatePreviews(f.generation, second));
  await entered.promise; await rejectedWrite;
  assert.equal(second.isCurrent(), true, 'busy admission retains caller ownership');
  release.resolve(); assert.equal((await refreshing).status, 'refreshed');
});

test('request and source-location snapshots cannot be changed after synchronous admission', async t => {
  const f = await fixture(t); mockGenerator(t);
  const refreshing = f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current });
  f.location.hash = 'mutated'; f.location.fileName = 'mutated.mp4'; f.update.index = 10; f.update.revision = '0'.repeat(64);
  const result = await refreshing;
  assert.equal(result.status, 'refreshed');
  assert.equal((await f.readStored()).images[0].hash, 'fresh-refresh-hash');
});

for (const change of ['notes', 'settings', 'unrelated'] as const) {
  test(`publication rechecks ${change} changes and preserves current raw catalogue`, async t => {
    const f = await fixture(t); let newer!: FinalObject;
    mockGenerator(t, async () => {
      newer = structuredClone(f.catalogue);
      if (change === 'notes') { newer.images[0].notes = 'Concurrent saved notes'; }
      if (change === 'settings') { newer.screenshotSettings.n = 5; }
      if (change === 'unrelated') { Object.assign(newer, { futureCatalogue: { retained: 'newer' } }); }
      const bytes = Buffer.from(JSON.stringify(newer));
      try { await f.store.writeRecord('catalogue', bytes); } finally { bytes.fill(0); }
    });
    const result = await f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current });
    assert.equal(result.status, change === 'unrelated' ? 'refreshed' : 'conflict');
    const saved = await f.readStored();
    if (change === 'unrelated') {
      assert.deepEqual((saved as FinalObject & { futureCatalogue: unknown }).futureCatalogue, { retained: 'newer' });
      assert.equal(saved.images[0].hash, f.location.hash);
    } else { assert.deepEqual(saved, newer); }
  });
}

test('cancellation during decoding drains before admitting writes and retains the original catalogue', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred();
  t.after(release.resolve);
  mockGenerator(t, async () => { entered.resolve(); await release.promise; });
  const refreshing = f.session.refreshVideo(f.generation, f.source, f.location, f.update, { signal: f.controller.signal, isCurrent: f.current });
  const rejected = assert.rejects(refreshing);
  await entered.promise; f.controller.abort();
  await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue));
  release.resolve(); await rejected;
  assert.equal(f.source.signal.aborted, true);
  assert.deepEqual(await f.readStored(), f.catalogue);
  assert.equal(f.session.isCurrent(f.generation), true);
  await f.session.writeCatalogue(f.generation, f.catalogue);
});

test('Lock waits for decoder drainage and prevents late replacement', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred();
  t.after(release.resolve);
  mockGenerator(t, async () => { entered.resolve(); await release.promise; });
  const rejected = assert.rejects(f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current }));
  await entered.promise;
  let locked = false; const locking = f.session.lock().then(() => { locked = true; });
  await Promise.resolve(); assert.equal(locked, false);
  release.resolve(); await rejected; await locking;
  assert.equal((await f.session.unlock(f.directory, password)).catalogue.images[0].hash, 'existing');
});

test('source replacement after preview staging leaves old catalogue and previews authoritative', async t => {
  const f = await fixture(t); mockGenerator(t);
  const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, current?: () => boolean) => {
    await write(id, bytes, current);
    if (id.startsWith('preview-set:')) { await fs.rename(f.file, f.file + '.old'); await fs.writeFile(f.file, 'replacement'); }
  });
  await assert.rejects(f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current }));
  assert.deepEqual(await f.readStored(), f.catalogue);
  const response = await f.session.createPreviewResponse(f.generation, 'thumbnail', 'existing', new Request('theatrum://app/media'));
  assert.equal(await response.text(), 'old-thumbnail');
});

for (const moment of ['before', 'after'] as const) {
  test(`cancellation ${moment} catalogue publication retires uncertain authority and wipes output`, async t => {
    const f = await fixture(t); mockGenerator(t); const write = f.store.writeRecord.bind(f.store);
    let retained: Buffer | undefined;
    t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, current?: () => boolean) => {
      if (id === 'catalogue') {
        retained = bytes;
        if (moment === 'before') { f.controller.abort(); }
      }
      await write(id, bytes, current);
      if (id === 'catalogue' && moment === 'after') { f.controller.abort(); }
    });
    await assert.rejects(f.session.refreshVideo(f.generation, f.source, f.location, f.update,
      { signal: f.controller.signal, isCurrent: f.current }));
    assert.equal(f.session.status.state, 'locked');
    assert.ok(retained?.every(byte => byte === 0));
    await f.session.lock();
    const reopened = await f.session.unlock(f.directory, password);
    assert.equal(reopened.catalogue.images[0].hash, moment === 'after' ? f.location.hash : 'existing');
  });
}

test('cancellation while committed source cleanup drains locks instead of returning stale renderer state', async t => {
  const f = await fixture(t); mockGenerator(t); const entered = deferred(); const release = deferred();
  t.after(release.resolve);
  const prototype = Object.getPrototypeOf(f.source) as PrivatePreviewSource;
  const close = prototype.close;
  let held = false;
  const mocked = t.mock.method(prototype, 'close', async function (this: PrivatePreviewSource) {
    await close.call(this);
    if (this === f.source && !held) { held = true; entered.resolve(); await release.promise; }
  });
  const rejected = assert.rejects(f.session.refreshVideo(f.generation, f.source, f.location, f.update,
    { signal: f.controller.signal, isCurrent: f.current }));
  await entered.promise; f.controller.abort(); release.resolve(); await rejected;
  mocked.mock.restore();
  assert.equal(f.session.status.state, 'locked');
  await f.session.lock();
  assert.equal((await f.session.unlock(f.directory, password)).catalogue.images[0].hash, f.location.hash);
});

test('source descriptor cleanup failure quarantines the session even after generation failure', async t => {
  const f = await fixture(t); const open = fs.open.bind(fs); const closers: (() => Promise<void>)[] = [];
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
    const lease = await source.open(); await lease.close(); throw new Error('Unreachable');
  });
  f.expectQuarantine();
  await assert.rejects(f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current }), isPrivatePreviewSourceCleanupFailure);
  assert.equal(f.session.status.state, 'locked');
  openMock.mock.restore();
  for (const close of closers) { await close(); }
});

test('legacy optional omissions and noncanonical location spelling survive refresh unchanged', async t => {
  const f = await fixture(t); mockGenerator(t);
  const legacy = structuredClone(f.catalogue);
  const image = legacy.images[0];
  delete image.notes; delete image.tags; delete image.dateAdded; delete image.playlist;
  image.partialPath = 'nested';
  image.locations = [{ fileName: image.fileName, inputSource: 0, partialPath: 'nested', missing: true }];
  await f.session.writeCatalogue(f.generation, legacy);
  const viewed = await f.session.readCatalogue(f.generation);
  assert.notDeepEqual(viewed.inputDirs[0].ignoredSubdirectories, legacy.inputDirs[0].ignoredSubdirectories);
  assert.equal(privateVideoRevision(viewed.images[0]), privateVideoRevision(image));
  const result = await f.session.refreshVideo(f.generation, f.source, f.location,
    { index: 0, revision: privateVideoRevision(viewed.images[0]) }, { isCurrent: f.current });
  assert.equal(result.status, 'refreshed');
  const saved = await f.readStored();
  assert.deepEqual(saved.inputDirs, legacy.inputDirs);
  assert.deepEqual(saved.images[0].locations, image.locations);
  assert.equal(saved.images[0].partialPath, 'nested');
  for (const field of ['notes', 'tags', 'dateAdded', 'playlist']) { assert.equal(Object.hasOwn(saved.images[0], field), false); }
});

test('an already cancelled request retains caller ownership and does not invoke authority', async t => {
  const f = await fixture(t); const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.session.refreshVideo(f.generation, f.source, f.location, f.update,
    { signal: aborted.signal, isCurrent: () => { assert.fail('Already cancelled'); } }));
  assert.equal(f.source.isCurrent(), true);
});

test('a generator that never supplies bounded metadata cannot publish a replacement row', async t => {
  const f = await fixture(t);
  t.mock.method(generation, 'generatePrivateHubPreviews', async () => createPrivatePreviewSet(f.location.hash, 256, 144, 4, false));
  await assert.rejects(f.session.refreshVideo(f.generation, f.source, f.location, f.update, { isCurrent: f.current }));
  assert.deepEqual(await f.readStored(), f.catalogue);
  assert.equal(f.source.signal.aborted, true);
  assert.equal(f.session.isCurrent(f.generation), true);
});
