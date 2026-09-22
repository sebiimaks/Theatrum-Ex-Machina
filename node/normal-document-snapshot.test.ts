import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { buildCatalogueMediaLocationAuthority } from './catalogue-media-authority';
import { NORMAL_CATALOGUE_STORAGE, readCatalogueStorage, writeCatalogueStorage, type CatalogueStorage } from './catalogue-storage';
import { GLOBALS, type VhaGlobals } from './main-globals';
import { captureNormalDocumentSnapshot, type NormalDocumentSnapshotOptions } from './normal-document-snapshot';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '..', 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, 'normal-document-snapshot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const firstRoot = path.join(directory, 'first-source');
  const secondRoot = path.join(directory, 'second-source');
  const cataloguePath = path.join(directory, 'Synthetic.scaena');
  const inputDirs = { 0: { path: firstRoot, watch: true }, 1: { path: secondRoot, watch: false } };
  const images = [
    { ...NewImageElement(), hash: 'zebra', fileName: 'zebra.mp4', cleanName: 'zebra', inputSource: 0, partialPath: '/first', notes: 'Original' },
    { ...NewImageElement(), hash: 'ant', fileName: 'ant.mp4', cleanName: 'ant', inputSource: 1, partialPath: '/second' },
  ];
  const catalogue: FinalObject = {
    addTags: [], removeTags: [], hubName: 'Synthetic', images, inputDirs, version: 3, numOfFolders: 2,
    screenshotSettings: { n: 10, height: 288, fixed: true, clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0 },
  };
  const target = Object.freeze({ kind: 'normal' as const, filePath: cataloguePath });
  await writeCatalogueStorage(target, catalogue);
  const state: VhaGlobals = {
    ...GLOBALS, catalogueStorage: NORMAL_CATALOGUE_STORAGE, catalogueAccessMode: 'read-write', catalogueSessionGeneration: 14,
    catalogueTransitionActive: true, cataloguePersistenceActive: false,
    currentlyOpenVhaFile: cataloguePath, selectedOutputFolder: directory, hubName: 'Synthetic',
    selectedSourceFolders: structuredClone(inputDirs), screenshotSettings: structuredClone(catalogue.screenshotSettings),
    authorizedCataloguePaths: new Set([cataloguePath]), authorizedCatalogueImageHashes: new Set(images.map(image => image.hash)),
    authorizedCatalogueMediaLocations: buildCatalogueMediaLocationAuthority(images),
    authorizedSourceFolderPaths: new Set([firstRoot, secondRoot]),
    authorizedSourceFolderRealPaths: new Map([[firstRoot, firstRoot], [secondRoot, secondRoot]]),
    authorizedSourceWatchPaths: new Set([firstRoot]),
  };
  let paused = true;
  let current = true;
  const capture = (overrides: Partial<NormalDocumentSnapshotOptions> = {}) => captureNormalDocumentSnapshot({
    state, assertPaused: () => { assert.equal(paused, true); }, isCurrent: () => current, ...overrides,
  });
  return { directory, state, catalogue, target, capture, firstRoot, secondRoot,
    resume: () => { paused = false; }, invalidate: () => { current = false; } };
}

test('writes frozen edits atomically to the captured normal catalogue and keeps its normal backup', async t => {
  const h = await fixture(t);
  const snapshot = h.capture();
  const incoming = structuredClone(h.catalogue);
  incoming.hubName = 'Renderer must not rename the hub';
  incoming.version = 99;
  incoming.screenshotSettings.n = 999;
  incoming.inputDirs[0].watch = false;
  incoming.images[0].notes = 'Saved video notes';
  await snapshot.saveSnapshot(incoming);
  snapshot.assertCurrent();
  const saved = (await readCatalogueStorage(h.target)).finalObject!;
  assert.equal(saved.hubName, 'Synthetic');
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.screenshotSettings, h.catalogue.screenshotSettings);
  assert.equal(saved.inputDirs[0].watch, true);
  assert.equal(saved.images.find(image => image.hash === 'zebra')?.notes, 'Saved video notes');
  assert.equal(JSON.parse(await fs.readFile(h.target.filePath + '.bak', 'utf8')).images[0].notes, 'Original');
  assert.deepEqual((await fs.readdir(h.directory)).sort(), ['Synthetic.scaena', 'Synthetic.scaena.bak']);
  assert.equal(incoming.images[0].uuid, '');
  assert.equal(saved.images[0].uuid, undefined);
  assert.equal(saved.numOfFolders, 2);
  await assert.rejects(snapshot.saveSnapshot(incoming), /unavailable/);
});

test('source removal revokes its paths and media while offline retained media remains saveable', async t => {
  const h = await fixture(t);
  const incoming = structuredClone(h.catalogue);
  delete incoming.inputDirs[0];
  await h.capture().saveSnapshot(incoming);
  assert.deepEqual([...h.state.authorizedCatalogueImageHashes], ['ant']);
  assert.deepEqual([...h.state.authorizedSourceFolderPaths], [h.secondRoot]);
  assert.deepEqual([...h.state.authorizedSourceFolderRealPaths], [[h.secondRoot, h.secondRoot]]);
  assert.deepEqual([...h.state.authorizedSourceWatchPaths], []);
  const saved = (await readCatalogueStorage(h.target)).finalObject!;
  assert.deepEqual(saved.images.map(image => image.hash), ['ant']);
  assert.equal(saved.numOfFolders, 1);
});

test('source removal promotes an already-owned surviving location and preserves metadata', async t => {
  const h = await fixture(t);
  h.catalogue.images[0].locations = [
    { fileName: 'zebra.mp4', inputSource: 0, partialPath: '/first' },
    { fileName: 'zebra-alias.mp4', inputSource: 1, partialPath: '/alias' },
  ];
  h.state.authorizedCatalogueMediaLocations = buildCatalogueMediaLocationAuthority(h.catalogue.images);
  const incoming = structuredClone(h.catalogue);
  delete incoming.inputDirs[0];
  await h.capture().saveSnapshot(incoming);
  const saved = (await readCatalogueStorage(h.target)).finalObject!;
  const retained = saved.images.find(image => image.hash === 'zebra')!;
  assert.equal(retained.fileName, 'zebra-alias.mp4');
  assert.equal(retained.inputSource, 1);
  assert.equal(retained.notes, 'Original');
  assert.equal(retained.locations?.length, 1);
});

test('persisted image projection drops deleted entries and adjacent duplicates and sorts normal folder order', async t => {
  const h = await fixture(t);
  const incoming = structuredClone(h.catalogue);
  incoming.images = [incoming.images[1], incoming.images[0], structuredClone(incoming.images[0]),
    { ...incoming.images[1], deleted: true }];
  await h.capture().saveSnapshot(incoming);
  const saved = (await readCatalogueStorage(h.target)).finalObject!;
  assert.deepEqual(saved.images.map(image => image.hash), ['zebra', 'ant']);
  assert.equal(saved.images.some(image => image.deleted || image.selected || image.uuid), false);
});

for (const change of ['add-source', 'remap-source', 'new-hash', 'remap-media', 'new-alias', 'folder-placeholder'] as const) {
  test(`rejects ${change} before writing or publishing authority`, async t => {
    const h = await fixture(t);
    const incoming = structuredClone(h.catalogue);
    if (change === 'add-source') { incoming.inputDirs[2] = { path: h.directory, watch: true }; }
    if (change === 'remap-source') { incoming.inputDirs[0].path = h.directory; }
    if (change === 'new-hash') { incoming.images[0].hash = 'unowned'; }
    if (change === 'remap-media') { incoming.images[0].fileName = 'unowned.mp4'; }
    if (change === 'new-alias') { incoming.images[0].locations = [{ fileName: 'unowned.mp4', inputSource: 0, partialPath: '/first' }]; }
    if (change === 'folder-placeholder') { incoming.images[0].cleanName = '*FOLDER*'; }
    let writes = 0;
    const originalAuthority = h.state.authorizedCatalogueMediaLocations;
    await assert.rejects(h.capture({ write: async () => { writes++; } }).saveSnapshot(incoming), { message: 'The normal catalogue snapshot is unavailable.' });
    assert.equal(writes, 0);
    assert.equal(h.state.authorizedCatalogueMediaLocations, originalAuthority);
    assert.equal((await readCatalogueStorage(h.target)).finalObject!.images[0].notes, 'Original');
  });
}

for (const mode of ['no-hub', 'read-only'] as const) {
  test(`${mode} accepts only a null snapshot and performs no write`, async t => {
    const h = await fixture(t);
    if (mode === 'no-hub') { h.state.currentlyOpenVhaFile = ''; } else { h.state.catalogueAccessMode = 'read-only'; }
    let writes = 0;
    const options = { write: async () => { writes++; } };
    await h.capture(options).saveSnapshot(null);
    await assert.rejects(h.capture(options).saveSnapshot(h.catalogue), /unavailable/);
    assert.equal(writes, 0);
  });
}

test('an active writable catalogue cannot issue save evidence for a null snapshot', async t => {
  const h = await fixture(t);
  await assert.rejects(h.capture().saveSnapshot(null), /unavailable/);
});

test('capture requires the live pause, owner, normal storage and authorized existing catalogue', async t => {
  const h = await fixture(t);
  assert.throws(() => h.capture({ assertPaused: () => { throw new Error('Not paused'); } }));
  assert.throws(() => h.capture({ isCurrent: () => false }));
  const normal = h.state.catalogueStorage;
  h.state.catalogueStorage = { kind: 'private' } as CatalogueStorage;
  assert.throws(() => h.capture(), /unavailable/);
  h.state.catalogueStorage = normal;
  h.state.authorizedCataloguePaths.clear();
  assert.throws(() => h.capture(), /unavailable/);
});

for (const drift of ['owner', 'pause', 'generation', 'storage', 'catalogue-path', 'source-in-place', 'hash-in-place', 'path-in-place', 'authority-reference'] as const) {
  test(`${drift} drift during a pending write cannot publish authority or finish a valid snapshot`, async t => {
    const h = await fixture(t);
    const gate = deferred();
    const started = deferred();
    let settled = false;
    const originalSources = h.state.selectedSourceFolders;
    const originalAuthority = h.state.authorizedCatalogueMediaLocations;
    const snapshot = h.capture({ write: async (target, document) => {
      assert.equal(target.kind, 'normal');
      assert.equal(target.kind === 'normal' && target.filePath, h.target.filePath);
      started.resolve();
      await gate.promise;
      await writeCatalogueStorage(target, document);
    } });
    const incoming = structuredClone(h.catalogue);
    delete incoming.inputDirs[0];
    const saving = snapshot.saveSnapshot(incoming).finally(() => { settled = true; });
    const rejected = assert.rejects(saving, /unavailable/);
    await started.promise;
    if (drift === 'owner') { h.invalidate(); }
    if (drift === 'pause') { h.resume(); }
    if (drift === 'generation') { h.state.catalogueSessionGeneration++; }
    if (drift === 'storage') { h.state.catalogueStorage = { kind: 'private' } as CatalogueStorage; }
    if (drift === 'catalogue-path') { h.state.currentlyOpenVhaFile = path.join(h.directory, 'replacement.scaena'); }
    if (drift === 'source-in-place') { h.state.selectedSourceFolders[0].watch = false; }
    if (drift === 'hash-in-place') { h.state.authorizedCatalogueImageHashes.add('late'); }
    if (drift === 'path-in-place') { h.state.authorizedCataloguePaths.clear(); }
    if (drift === 'authority-reference') { h.state.authorizedCatalogueMediaLocations = new Set(originalAuthority); }
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(h.state.selectedSourceFolders, originalSources);
    gate.resolve();
    await rejected;
    assert.equal(h.state.selectedSourceFolders, originalSources);
    if (drift !== 'authority-reference') { assert.equal(h.state.authorizedCatalogueMediaLocations, originalAuthority); }
    // This original write was already admitted. Completion is awaited, but it
    // never retargets private storage or grants its result to a replacement hub.
    assert.deepEqual((await readCatalogueStorage(h.target)).finalObject!.images.map(image => image.hash), ['ant']);
    if (drift === 'catalogue-path') { await assert.rejects(fs.stat(h.state.currentlyOpenVhaFile), { code: 'ENOENT' }); }
    assert.throws(() => snapshot.assertCurrent(), /unavailable/);
  });
}

test('drift before save and a failing atomic writer preserve all main authority', async t => {
  const h = await fixture(t);
  let writes = 0;
  const stale = h.capture({ write: async () => { writes++; } });
  h.state.authorizedSourceWatchPaths.clear();
  await assert.rejects(stale.saveSnapshot(h.catalogue), /unavailable/);
  assert.equal(writes, 0);
  const originalAuthority = h.state.authorizedCatalogueMediaLocations;
  const incoming = structuredClone(h.catalogue);
  delete incoming.inputDirs[0];
  await assert.rejects(h.capture({ write: async () => { throw new Error('/synthetic/private/path'); } }).saveSnapshot(incoming),
    { message: 'The normal catalogue snapshot is unavailable.' });
  assert.equal(h.state.authorizedCatalogueMediaLocations, originalAuthority);
});

test('concurrent and reentrant saves cannot write twice', async t => {
  const h = await fixture(t);
  const gate = deferred();
  let writes = 0;
  let reentrant: Promise<void> | undefined;
  const snapshot = h.capture({ write: async () => {
    writes++;
    reentrant = snapshot.saveSnapshot(h.catalogue);
    await assert.rejects(reentrant, /unavailable/);
    await gate.promise;
  } });
  const saving = snapshot.saveSnapshot(h.catalogue);
  await assert.rejects(snapshot.saveSnapshot(h.catalogue), /unavailable/);
  gate.resolve();
  await saving;
  assert.equal(writes, 1);
});
