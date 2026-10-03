import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { capturePrivatePreviewSource } from './private-preview-source';
import { reviewPrivateSourceAddition, type PrivateSourceAdditionReview } from './private-source-addition';

const password = 'Synthetic addition password';
const marker = 'PRIVATE_ADDITION_SESSION_SYNTHETIC';
const current = (): boolean => true;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-addition-session-'));
  const directory = path.join(root, 'encrypted');
  const newRoot = path.join(root, 'selected-folder');
  await fs.mkdir(path.join(newRoot, 'nested'), { recursive: true });
  await fs.writeFile(path.join(newRoot, 'nested', 'video.mp4'), 'synthetic video');
  const catalogue: FinalObject = {
    addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
    images: [{ ...NewImageElement(), hash: 'synthetic-video', cleanName: marker, fileName: 'video.mp4',
      partialPath: '/nested', fileSize: 15, notes: marker, tags: ['Legacy, tag'], missing: true,
      locations: [{ inputSource: 0, partialPath: '/nested', fileName: 'video.mp4', missing: true }] }],
    inputDirs: { 0: { path: path.join(root, 'old-offline-folder'), watch: true,
      ignoredSubdirectories: ['B', 'A', 'A'] } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 },
  };
  Object.assign(catalogue, { futureCatalogue: [3, 2, 1] });
  Object.assign(catalogue.inputDirs[0], { futureSource: { retained: true } });
  Object.assign(catalogue.images[0], { futureImage: { preserved: true } });
  const initial = await PrivateHubStore.create(directory, password);
  await writePrivateHubCatalogue(initial, catalogue);
  const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: initial.hubId }));
  try { await initial.writeNewRecord('session:activation', activation); }
  finally { activation.fill(0); await initial.lock(); }
  let store!: PrivateHubStore;
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (target: string, secret: string) => { store = await open(target, secret); return store; });
  const session = new PrivateHubSession();
  const { generation } = await session.unlock(directory, password);
  t.after(() => session.close());
  const controller = new AbortController();
  const review = async () => {
    const result = await reviewPrivateSourceAddition({ catalogue: await session.readCatalogue(generation), newRoot, signal: controller.signal, isCurrent: () => session.isCurrent(generation) });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') { throw new Error('Synthetic addition review failed'); }
    t.after(() => result.review.dispose());
    return result.review;
  };
  const readStored = async (): Promise<FinalObject> => {
    const bytes = await store.readRecord('catalogue');
    try { return JSON.parse(bytes.toString('utf8')) as FinalObject; }
    finally { bytes.fill(0); }
  };
  return { root, directory, newRoot, catalogue, session, generation, controller, store, review, readStored };
}
async function heldRead(t: TestContext, store: PrivateHubStore) {
  const started = deferred();
  const release = deferred();
  const read = store.readRecord.bind(store);
  t.mock.method(store, 'readRecord', async (id: string, limit?: number) => {
    if (id === 'catalogue') { started.resolve(); await release.promise; }
    return read(id, limit);
  });
  t.after(() => release.resolve());
  return { started, release };
}

test('source addition appends only a disconnected location with watch disabled and survives reopening', async t => {
  const f = await fixture(t);
  const review = await f.review();
  assert.deepEqual(await f.session.addSource(f.generation, review, current), { status: 'added' });
  const expected = structuredClone(f.catalogue);
  expected.inputDirs[1] = { path: f.newRoot, watch: false };
  assert.deepEqual(await f.readStored(), expected);
  assert.equal(await fs.readFile(path.join(f.newRoot, 'nested', 'video.mp4'), 'utf8'), 'synthetic video');
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(reopened.catalogue.inputDirs[1], { path: f.newRoot, watch: false });
  assert.equal(reopened.catalogue.images.length, 1, 'Adding a source never scans or imports videos');
  assert.equal(reopened.catalogue.numOfFolders, f.catalogue.numOfFolders);
  for (const name of await fs.readdir(f.directory)) {
    const bytes = await fs.readFile(path.join(f.directory, name));
    for (const privateValue of [marker, password, f.newRoot, f.catalogue.inputDirs[0].path]) {
      assert.equal(bytes.includes(Buffer.from(privateValue)), false, 'No tested private marker in encrypted records');
    }
  }
});

test('unbranded source reviews cannot invoke predicates or enter storage', async t => {
  const f = await fixture(t);
  const forged = { sourceIndex: 1, newRoot: f.newRoot, isCurrent: () => { assert.fail('No forged predicate'); } };
  const write = t.mock.method(f.store, 'writeRecord', async () => { assert.fail('No unreviewed source write'); });
  assert.deepEqual(await f.session.addSource(f.generation, forged as unknown as PrivateSourceAdditionReview,
    () => { assert.fail('No external predicate for an unbranded review'); }), { status: 'invalid' });
  assert.equal(write.mock.callCount(), 0);
});

test('concurrent unrelated notes, raw legacy fields and source preferences survive addition', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const newer = structuredClone(f.catalogue);
  newer.images[0].notes = 'A newer note'; newer.inputDirs[0].watch = false;
  Object.assign(newer.inputDirs[0], { futureSource: { changed: true } });
  await f.session.writeCatalogue(f.generation, newer);
  assert.deepEqual(await f.session.addSource(f.generation, review, current), { status: 'added' });
  newer.inputDirs[1] = { path: f.newRoot, watch: false };
  assert.deepEqual(await f.readStored(), newer);
});

test('legacy saved root spelling survives the raw catalogue transaction', async t => {
  const f = await fixture(t);
  const newer = structuredClone(f.catalogue);
  newer.inputDirs[0].path += '/nested/..';
  delete newer.images[0].locations;
  Object.assign(newer.images[0], { inputSource: '0' });
  await f.session.writeCatalogue(f.generation, newer);
  const review = await f.review();
  assert.deepEqual(await f.session.addSource(f.generation, review, current), { status: 'added' });
  newer.inputDirs[1] = { path: f.newRoot, watch: false };
  assert.deepEqual(await f.readStored(), newer);
});

for (const change of ['path', 'new-source', 'duplicate', 'overlap']) {
  test('concurrent ' + change + ' conflicts without overwriting later catalogue state', async t => {
    const f = await fixture(t);
    const review = await f.review();
    const newer = structuredClone(f.catalogue);
    switch (change) {
      case 'path': newer.inputDirs[0].path += '-moved'; break;
      case 'new-source': newer.inputDirs[1] = { path: path.join(f.root, 'later-source'), watch: true }; break;
      case 'duplicate': newer.inputDirs[1] = { path: f.newRoot, watch: false }; break;
      case 'overlap': newer.inputDirs[1] = { path: path.join(f.newRoot, 'nested'), watch: true }; break;
    }
    await f.session.writeCatalogue(f.generation, newer);
    assert.deepEqual(await f.session.addSource(f.generation, review, current), { status: 'conflict' });
    assert.deepEqual(await f.readStored(), newer);
    assert.equal(f.session.isCurrent(f.generation), true);
  });
}

test('the same review cannot append the directory twice', async t => {
  const f = await fixture(t);
  const review = await f.review();
  assert.deepEqual(await f.session.addSource(f.generation, review, current), { status: 'added' });
  assert.deepEqual(await f.session.addSource(f.generation, review, current), { status: 'conflict' });
  assert.equal(Object.keys((await f.readStored()).inputDirs).length, 2);
});

test('directory replacement before admission fails without writing', async t => {
  const f = await fixture(t);
  const review = await f.review();
  await fs.rename(f.newRoot, f.newRoot + '-old'); await fs.mkdir(f.newRoot);
  const write = t.mock.method(f.store, 'writeRecord', async () => { assert.fail('No replaced directory write'); });
  await assert.rejects(f.session.addSource(f.generation, review, current), /private hub session is unavailable/);
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('cancelled review cannot enter the queue and does not prevent a future reviewed operation', async t => {
  const f = await fixture(t);
  const review = await f.review();
  f.controller.abort();
  await assert.rejects(f.session.addSource(f.generation, review, current), /private hub session is unavailable/);
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('operation cancellation after catalogue read prevents publication and keeps the session usable', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const held = await heldRead(t, f.store);
  let permitted = true;
  const writing = f.session.addSource(f.generation, review, () => permitted);
  const rejected = assert.rejects(writing, /private hub session is unavailable/);
  await held.started.promise; permitted = false; held.release.resolve(); await rejected;
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('lock during queued read prevents source addition and waits for request drainage', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const held = await heldRead(t, f.store);
  const writing = f.session.addSource(f.generation, review, current);
  const rejected = assert.rejects(writing, /private hub session is unavailable/);
  await held.started.promise;
  let settled = false;
  const locking = f.session.lock().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  held.release.resolve(); await rejected; await locking;
  await f.session.unlock(f.directory, password);
  assert.deepEqual((await f.readStored()).inputDirs, f.catalogue.inputDirs);
});

test('writer reservation is active before a native authority predicate can reenter', async t => {
  const f = await fixture(t);
  const review = await f.review();
  let reentered: Promise<{ status: string }> | undefined;
  const writing = f.session.addSource(f.generation, review, () => {
    reentered ??= f.session.addSource(f.generation, review, current); return true;
  });
  assert.deepEqual(await writing, { status: 'added' });
  assert.deepEqual(await reentered, { status: 'busy' });
});

test('queued addition excludes competing generation, credential and export operations', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const review = await f.review();
  const source = await capturePrivatePreviewSource({ hash: f.catalogue.images[0].hash, root: f.newRoot,
    partialPath: '/nested', fileName: 'video.mp4', inputSource: 0,
    signal: f.session.revocationSignal(f.generation), isCurrent: () => f.session.isCurrent(f.generation) });
  t.after(() => source.close());
  const held = await heldRead(t, f.store);
  const writing = f.session.addSource(f.generation, review, current);
  await held.started.promise;
  assert.deepEqual(await f.session.addSource(f.generation, review, current), { status: 'busy' });
  await assert.rejects(f.session.generatePreviews(f.generation, source), /private hub session is unavailable/);
  await assert.rejects(f.session.changePassword(f.generation,
    { currentPassword: password, newPassword: password + ' new' }, current), /private hub session is unavailable/);
  await assert.rejects(f.session.createUnprotectedCopy(f.generation,
    { password, acknowledge: true }, current, { signal: f.controller.signal,
      chooseDestination: async () => { assert.fail('Queued addition must block export selection'); } }),
  /private hub session is unavailable/);
  held.release.resolve(); assert.deepEqual(await writing, { status: 'added' });
  assert.equal(await f.session.changePassword(f.generation,
    { currentPassword: 'Wrong synthetic password', newPassword: password + ' new' }, current), 'incorrect-password');
});

test('guarded publication rechecks authority, wipes owned bytes and locks on an uncertain failure', async t => {
  const f = await fixture(t);
  const review = await f.review();
  let permitted = true;
  let borrowed!: Buffer;
  t.mock.method(f.store, 'writeRecord', async (_id: string, bytes: Buffer, authorize: () => boolean) => {
    borrowed = bytes; assert.equal(authorize(), true);
    permitted = false; assert.equal(authorize(), false);
    throw new Error('Synthetic guarded-write failure');
  });
  await assert.rejects(f.session.addSource(f.generation, review, () => permitted), /private hub session is unavailable/);
  assert.ok(borrowed.length > 0 && borrowed.every(byte => byte === 0));
  assert.equal(f.session.isCurrent(f.generation), false);
});

test('a write failure after publication locks and reopening recovers the actual committed source', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, authorize: () => boolean) => {
    await write(id, bytes, authorize); throw new Error('Synthetic failure after publication');
  });
  await assert.rejects(f.session.addSource(f.generation, review, current), /private hub session is unavailable/);
  assert.equal(f.session.isCurrent(f.generation), false);
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(reopened.catalogue.inputDirs[1], { path: f.newRoot, watch: false });
});

test('late cancellation following successful storage publication locks the uncertain generation', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const write = f.store.writeRecord.bind(f.store);
  let permitted = true;
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, authorize: () => boolean) => {
    await write(id, bytes, authorize); permitted = false;
  });
  await assert.rejects(f.session.addSource(f.generation, review, () => permitted), /private hub session is unavailable/);
  assert.equal(f.session.isCurrent(f.generation), false);
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(reopened.catalogue.inputDirs[1], { path: f.newRoot, watch: false });
});

test('catalogue read failure closes the generation and returns no private diagnostic', async t => {
  const f = await fixture(t);
  const review = await f.review();
  t.mock.method(f.store, 'readRecord', async () => { throw new Error(f.newRoot + '/private-native-error'); });
  await assert.rejects(f.session.addSource(f.generation, review, current), error => {
    assert.equal((error as Error).message, 'The private hub session is unavailable.'); return true;
  });
  assert.equal(f.session.isCurrent(f.generation), false);
});

for (const position of ['same', 'parent', 'nested', 'case']) {
  test('a source ' + position + ' overlap with encrypted storage is rejected without a write', async t => {
    if (position === 'case' && process.platform !== 'darwin' && process.platform !== 'win32') { t.skip(); return; }
    const f = await fixture(t);
    // Keep the pre-existing saved source outside the selected parent so this
    // specifically exercises the private-store boundary at queued admission.
    const catalogue = structuredClone(f.catalogue);
    catalogue.inputDirs[0].path = path.join(path.dirname(f.root), 'offline-source');
    await f.session.writeCatalogue(f.generation, catalogue);
    let selected = f.directory;
    if (position === 'parent') { selected = f.root; }
    if (position === 'nested') { selected = path.join(f.directory, 'source-child'); await fs.mkdir(selected); }
    if (position === 'case') {
      // A real picker resolves on-disk spelling; validate this guard directly
      // with a directory whose case differs only from the store path property.
      Object.defineProperty(f.store, 'directory', { value: f.directory.toUpperCase() });
    }
    const result = await reviewPrivateSourceAddition({ catalogue, newRoot: selected,
      signal: f.controller.signal, isCurrent: () => f.session.isCurrent(f.generation) });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') { throw new Error('Expected synthetic source review'); }
    t.after(() => result.review.dispose());
    const write = t.mock.method(f.store, 'writeRecord', async () => { assert.fail('No source can overlap encrypted storage'); });
    assert.deepEqual(await f.session.addSource(f.generation, result.review, current), { status: 'invalid' });
    assert.equal(write.mock.callCount(), 0);
    if (position === 'case') { Object.defineProperty(f.store, 'directory', { value: f.directory }); }
    assert.deepEqual(await f.readStored(), catalogue);
    assert.equal(f.session.isCurrent(f.generation), true);
  });
}
