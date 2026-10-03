import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { capturePrivatePreviewSource } from './private-preview-source';
import { reviewPrivateSourceRelocation, type PrivateSourceRelocationReview } from './private-source-relocation';

const password = 'Synthetic relocation password';
const marker = 'PRIVATE_RELOCATION_SESSION_SYNTHETIC';
const current = (): boolean => true;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-relocation-session-'));
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
    const result = await reviewPrivateSourceRelocation({ catalogue: await session.readCatalogue(generation), sourceIndex: 0,
      newRoot, signal: controller.signal, isCurrent: () => session.isCurrent(generation) });
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') { throw new Error('Synthetic relocation review failed'); }
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

test('relocation changes only the saved root, preserves raw fields, and persists encrypted across reopening', async t => {
  const f = await fixture(t);
  const review = await f.review();
  assert.deepEqual(await f.session.relocateSource(f.generation, review, current), { status: 'relocated' });
  const expected = structuredClone(f.catalogue);
  expected.inputDirs[0].path = f.newRoot;
  assert.deepEqual(await f.readStored(), expected);
  assert.equal(await fs.readFile(path.join(f.newRoot, 'nested', 'video.mp4'), 'utf8'), 'synthetic video');
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.inputDirs[0].path, f.newRoot);
  assert.equal(reopened.catalogue.images[0].notes, marker);
  assert.equal(reopened.catalogue.images[0].missing, true, 'relocation does not rewrite media scan state');
  for (const name of await fs.readdir(f.directory)) {
    const bytes = await fs.readFile(path.join(f.directory, name));
    for (const privateValue of [marker, password, f.newRoot, f.catalogue.inputDirs[0].path]) {
      assert.equal(bytes.includes(Buffer.from(privateValue)), false, 'No tested private marker in encrypted records');
    }
  }
});

test('unbranded reviews are invalid and cannot invoke untrusted predicates or write', async t => {
  const f = await fixture(t);
  t.mock.method(f.store, 'writeRecord', async () => { assert.fail('No invalid review write'); });
  const forged = { sourceIndex: 0, newRoot: f.newRoot, videoCount: 1, isCurrent: () => { assert.fail('No forged predicate'); } };
  assert.deepEqual(await f.session.relocateSource(f.generation, forged as unknown as PrivateSourceRelocationReview, current), { status: 'invalid' });
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('concurrent unrelated notes and source fields survive a relocation transaction', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const newer = structuredClone(f.catalogue);
  newer.images[0].notes = 'A newer note';
  newer.inputDirs[0].watch = false;
  Object.assign(newer.inputDirs[0], { futureSource: { changed: true } });
  await f.session.writeCatalogue(f.generation, newer);
  assert.deepEqual(await f.session.relocateSource(f.generation, review, current), { status: 'relocated' });
  newer.inputDirs[0].path = f.newRoot;
  assert.deepEqual(await f.readStored(), newer);
});

test('a source root changed after review conflicts without overwriting it', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const newer = structuredClone(f.catalogue);
  newer.inputDirs[0].path = path.join(f.root, 'another-root');
  await f.session.writeCatalogue(f.generation, newer);
  assert.deepEqual(await f.session.relocateSource(f.generation, review, current), { status: 'conflict' });
  assert.deepEqual(await f.readStored(), newer);
});

test('changed referenced video metadata conflicts without changing the saved root', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const newer = structuredClone(f.catalogue);
  newer.images[0].fileSize++;
  await f.session.writeCatalogue(f.generation, newer);
  assert.deepEqual(await f.session.relocateSource(f.generation, review, current), { status: 'conflict' });
  assert.deepEqual(await f.readStored(), newer);
});

test('reviewed files changed before write are rejected', async t => {
  const f = await fixture(t);
  const review = await f.review();
  await fs.writeFile(path.join(f.newRoot, 'nested', 'video.mp4'), 'changed content');
  const write = t.mock.method(f.store, 'writeRecord', async () => { assert.fail('Changed files must not publish a location'); });
  await assert.rejects(f.session.relocateSource(f.generation, review, current), /private hub session is unavailable/);
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('a cancelled review cannot enter the catalogue queue', async t => {
  const f = await fixture(t);
  const review = await f.review();
  f.controller.abort();
  await assert.rejects(f.session.relocateSource(f.generation, review, current), /private hub session is unavailable/);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('operation cancellation after catalogue read prevents publication and preserves the session', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const held = await heldRead(t, f.store);
  let permitted = true;
  const writing = f.session.relocateSource(f.generation, review, () => permitted);
  const rejected = assert.rejects(writing, /private hub session is unavailable/);
  await held.started.promise;
  permitted = false;
  held.release.resolve();
  await rejected;
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('locking during an admitted read prevents relocation and drains the request', async t => {
  const f = await fixture(t);
  const review = await f.review();
  const held = await heldRead(t, f.store);
  const writing = f.session.relocateSource(f.generation, review, current);
  const rejected = assert.rejects(writing, /private hub session is unavailable/);
  await held.started.promise;
  const locking = f.session.lock();
  held.release.resolve();
  await rejected;
  await locking;
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.inputDirs[0].path, f.catalogue.inputDirs[0].path);
});

test('publication rechecks native authority and owned plaintext output buffers are wiped', async t => {
  const f = await fixture(t);
  const review = await f.review();
  let permitted = true;
  let borrowed!: Buffer;
  t.mock.method(f.store, 'writeRecord', async (_id: string, bytes: Buffer, authorize: () => boolean) => {
    borrowed = bytes;
    assert.equal(authorize(), true);
    permitted = false;
    assert.equal(authorize(), false);
    throw new Error('Synthetic publication denial');
  });
  await assert.rejects(f.session.relocateSource(f.generation, review, () => permitted));
  assert.ok(borrowed.length > 0 && borrowed.every(byte => byte === 0));
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('storage failure locks the session instead of reporting a successful relocation', async t => {
  const f = await fixture(t);
  const review = await f.review();
  t.mock.method(f.store, 'writeRecord', async () => { throw new Error('Synthetic write failure'); });
  await assert.rejects(f.session.relocateSource(f.generation, review, current), /private hub session is unavailable/);
  assert.equal(f.session.isCurrent(f.generation), false);
});


test('queued relocation excludes preview generation and credential operations until it settles', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const review = await f.review();
  const source = await capturePrivatePreviewSource({ hash: f.catalogue.images[0].hash, root: f.newRoot,
    partialPath: '/nested', fileName: 'video.mp4', inputSource: 0,
    signal: f.session.revocationSignal(f.generation), isCurrent: () => f.session.isCurrent(f.generation) });
  t.after(() => source.close());
  const held = await heldRead(t, f.store);
  const writing = f.session.relocateSource(f.generation, review, current);
  await held.started.promise;
  await assert.rejects(f.session.generatePreviews(f.generation, source), /private hub session is unavailable/);
  await assert.rejects(f.session.changePassword(f.generation,
    { currentPassword: password, newPassword: password + ' new' }, current), /private hub session is unavailable/);
  await assert.rejects(f.session.createUnprotectedCopy(f.generation,
    { password, acknowledge: true }, current, { signal: f.controller.signal,
      chooseDestination: async () => { assert.fail('A queued relocation must block export selection'); } }),
  /private hub session is unavailable/);
  held.release.resolve();
  assert.deepEqual(await writing, { status: 'relocated' });
  assert.equal(await f.session.changePassword(f.generation,
    { currentPassword: 'Wrong synthetic password', newPassword: password + ' new' }, current), 'incorrect-password',
  'Writer reservation must be released after relocation');
});
