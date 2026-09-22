import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { privateVideoRevision, type PrivateVideoMetadataUpdate } from './private-hub-metadata';
import { capturePrivatePreviewSource } from './private-preview-source';
import { createPrivatePreviewSet } from './private-hub-preview-set';
import * as previewGeneration from './private-hub-preview-generation';

const password = 'Synthetic private metadata password';
const marker = 'PRIVATE_METADATA_SYNTHETIC_CANARY';
const current = (): boolean => true;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-metadata-'));
  const directory = path.join(root, 'sealed-hub');
  const sources = path.join(root, 'synthetic-sources');
  await fs.mkdir(sources);
  const catalogue: FinalObject = {
    addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
    images: ['First', 'Selected', 'Other'].map((title, index) => ({
      ...NewImageElement(), hash: index < 2 ? 'shared-hash' : 'other-hash', cleanName: title,
      fileName: 'synthetic-' + index + '.mp4', screens: 3, notes: marker + ':' + title,
      tags: ['Legacy, tag', 'old>flat'],
      unknownVideoField: { preserved: title, nested: [3, 1, 2] },
    })),
    inputDirs: { 0: { path: sources, watch: false, ignoredSubdirectories: ['B', 'A', 'A'] } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 },
    tagDefinitions: ['Legacy, tag', 'old>flat'], tagColors: { 'Legacy, tag': '#112233' },
  };
  Object.assign(catalogue, { unknownCatalogueField: { futureVersion: true, values: [7, 4] } });
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
  t.after(async () => { await session.close(); await fs.rm(root, { recursive: true, force: true }); });
  const readStored = async (): Promise<FinalObject> => {
    const bytes = await store.readRecord('catalogue');
    try { return JSON.parse(bytes.toString('utf8')) as FinalObject; }
    finally { bytes.fill(0); }
  };
  const update = (index = 1, notes = 'New ' + marker): PrivateVideoMetadataUpdate => ({
    index, revision: privateVideoRevision(catalogue.images[index]), notes, tags: [...catalogue.images[index].tags!],
  });
  const source = async () => {
    const image = catalogue.images[2];
    await fs.writeFile(path.join(sources, image.fileName), 'Synthetic preview source');
    const captured = await capturePrivatePreviewSource({ hash: image.hash, root: sources,
      fileName: image.fileName, partialPath: '', inputSource: 0,
      signal: session.revocationSignal(generation), isCurrent: () => session.isCurrent(generation) });
    t.after(() => captured.close());
    return captured;
  };
  return { root, directory, catalogue, session, generation, store, readStored, update, source };
}

async function holdCatalogueRead(t: TestContext, store: PrivateHubStore) {
  const ready = deferred();
  const release = deferred();
  const read = store.readRecord.bind(store);
  let held = false;
  t.mock.method(store, 'readRecord', async (id: string, limit?: number) => {
    if (!held && id === 'catalogue') { held = true; ready.resolve(); await release.promise; }
    return read(id, limit);
  });
  t.after(() => release.resolve());
  return { ready, release };
}

test('private revisions cover the complete selected row, including unknown metadata', () => {
  const image = { ...NewImageElement(), hash: 'same', extra: { retained: true } };
  const changed = { ...image, extra: { retained: false } };
  assert.equal(privateVideoRevision(image), privateVideoRevision(structuredClone(image)));
  assert.notEqual(privateVideoRevision(image), privateVideoRevision(changed));
  assert.notEqual(privateVideoRevision(image), privateVideoRevision({ ...image, notes: 'changed' }));
});

test('edits only the exact indexed duplicate-hash row and persists encrypted data without changing unrelated fields', async t => {
  const f = await fixture(t);
  const request = f.update();
  request.tags.push(' Animals > Birds ');
  const result = await f.session.updateVideoMetadata(f.generation, request, current);
  assert.equal(result.status, 'saved');
  const expected = structuredClone(f.catalogue);
  expected.images[1].notes = request.notes;
  expected.images[1].tags!.push('Animals > Birds');
  assert.deepEqual(await f.readStored(), expected, 'source exclusions, unknown fields, preview settings and other rows stay exact');
  if (result.status === 'saved') {
    assert.deepEqual(result.image, expected.images[1]);
    result.image.notes = 'Changed returned object';
    result.image.tags!.push('Changed returned tags');
  }
  assert.deepEqual(await f.readStored(), expected);
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images[1].notes, request.notes);
  assert.deepEqual(reopened.catalogue.images[1].tags, expected.images[1].tags);
  for (const name of await fs.readdir(f.directory)) {
    const bytes = await fs.readFile(path.join(f.directory, name));
    assert.equal(bytes.includes(Buffer.from(marker)), false, name);
    assert.equal(bytes.includes(Buffer.from('Animals > Birds')), false, name);
    assert.equal(bytes.includes(Buffer.from(password)), false, name);
    assert.equal(bytes.includes(Buffer.from(f.catalogue.inputDirs[0].path)), false, name);
  }
});

test('a stale selected revision conflicts while an unrelated changed row is retained by a fresh transaction', async t => {
  const f = await fixture(t);
  const latest = structuredClone(f.catalogue);
  latest.images[1].notes = 'Concurrent selected-row edit';
  await f.session.writeCatalogue(f.generation, latest);
  assert.deepEqual(await f.session.updateVideoMetadata(f.generation, f.update(), current), { status: 'conflict' });
  assert.equal(f.session.isCurrent(f.generation), true);
  const next = { ...f.update(), revision: privateVideoRevision(latest.images[1]) };
  latest.images[2].notes = 'Concurrent unrelated-row edit';
  await f.session.writeCatalogue(f.generation, latest);
  assert.equal((await f.session.updateVideoMetadata(f.generation, next, current)).status, 'saved');
  assert.equal((await f.readStored()).images[2].notes, 'Concurrent unrelated-row edit');
});

test('index reordering cannot rebind a request to a different video with the same hash', async t => {
  const f = await fixture(t);
  const reordered = structuredClone(f.catalogue);
  [reordered.images[0], reordered.images[1]] = [reordered.images[1], reordered.images[0]];
  await f.session.writeCatalogue(f.generation, reordered);
  assert.deepEqual(await f.session.updateVideoMetadata(f.generation, f.update(), current), { status: 'conflict' });
  assert.deepEqual(await f.readStored(), reordered);
});

test('notes-only edits preserve duplicate and noncanonical legacy tags exactly', async t => {
  const f = await fixture(t);
  const catalogue = structuredClone(f.catalogue);
  const tags = [' a>b ', 'comma,value', '', 'duplicate', 'duplicate', 'old\nvalue'];
  catalogue.images[1].tags = [...tags];
  await f.session.writeCatalogue(f.generation, catalogue);
  const request = { ...f.update(), revision: privateVideoRevision(catalogue.images[1]), tags: [...tags] };
  assert.equal((await f.session.updateVideoMetadata(f.generation, request, current)).status, 'saved');
  const saved = await f.readStored();
  assert.deepEqual(saved.images[1].tags, tags);
  assert.deepEqual(await f.session.updateVideoMetadata(f.generation,
    { ...request, revision: privateVideoRevision(saved.images[1]), tags: [...tags, 'New'] }, current), { status: 'invalid' });
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('malformed or oversized requests and invalid newly added tags never write or lock the session', async t => {
  const f = await fixture(t);
  const writing = t.mock.method(f.store, 'writeRecord', async () => { assert.fail('Invalid metadata must not be written'); });
  const invalid = [
    null, [], {}, { ...f.update(), extra: true }, { ...f.update(), index: -1 }, { ...f.update(), index: 0.5 },
    { ...f.update(), revision: 'bad' }, { ...f.update(), notes: 42 }, { ...f.update(), notes: 'x'.repeat(65_537) },
    { ...f.update(), tags: Array(129).fill('Existing') }, { ...f.update(), tags: ['x'.repeat(513)] },
    { ...f.update(), tags: [42] }, { ...f.update(), tags: Array(1) },
    ...[['Duplicate', 'Duplicate'], [' A > B ', 'A > B'], [''], ['a,,b'], ['a\nb'], ['a > > b'], ['x'.repeat(121)]]
      .map(tags => ({ ...f.update(), tags })),
  ];
  for (const value of invalid) {
    assert.deepEqual(await f.session.updateVideoMetadata(f.generation, value as PrivateVideoMetadataUpdate, current), { status: 'invalid' });
    assert.equal(f.session.isCurrent(f.generation), true);
  }
  assert.equal(writing.mock.callCount(), 0);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('deleted/folder rows and truncated or malformed existing metadata are not overwritten', async t => {
  const f = await fixture(t);
  for (const change of [{ deleted: true }, { cleanName: '*FOLDER*' }, { notes: 'x'.repeat(65_537) },
    { notes: 42 }, { tags: ['x'.repeat(513)] }, { tags: Array(129).fill('Legacy') }, { tags: [42] }]) {
    const catalogue = structuredClone(f.catalogue);
    Object.assign(catalogue.images[1], change);
    await f.session.writeCatalogue(f.generation, catalogue);
    const request = { ...f.update(), revision: privateVideoRevision(catalogue.images[1]) };
    assert.deepEqual(await f.session.updateVideoMetadata(f.generation, request, current), { status: 'invalid' });
    assert.deepEqual(await f.readStored(), catalogue);
    assert.equal(f.session.isCurrent(f.generation), true);
  }
});

test('queued requests detach mutable input before their one read/compare/write operation', async t => {
  const f = await fixture(t);
  const held = await holdCatalogueRead(t, f.store);
  const reading = f.session.readCatalogue(f.generation);
  await held.ready.promise;
  const request = f.update();
  const update = f.session.updateVideoMetadata(f.generation, request, current);
  request.index = 0; request.notes = 'Changed after enqueue'; request.tags.splice(0, request.tags.length, 'Changed');
  request.revision = privateVideoRevision(f.catalogue.images[0]);
  held.release.resolve();
  await reading;
  assert.equal((await update).status, 'saved');
  const saved = await f.readStored();
  assert.equal(saved.images[1].notes, 'New ' + marker);
  assert.deepEqual(saved.images[1].tags, f.catalogue.images[1].tags);
  assert.deepEqual(saved.images[0], f.catalogue.images[0]);
});

test('concurrent updates compare after earlier saves and queue saturation reports busy without locking', async t => {
  const f = await fixture(t);
  const held = await holdCatalogueRead(t, f.store);
  const reading = f.session.readCatalogue(f.generation);
  await held.ready.promise;
  const pending = Array.from({ length: 15 }, (_, index) => f.session.updateVideoMetadata(f.generation, f.update(1, 'Edit ' + index), current));
  assert.deepEqual(await f.session.updateVideoMetadata(f.generation, f.update(), current), { status: 'busy' });
  assert.equal(f.session.isCurrent(f.generation), true);
  held.release.resolve();
  await reading;
  const results = await Promise.all(pending);
  assert.equal(results[0].status, 'saved');
  assert.ok(results.slice(1).every(result => result.status === 'conflict'));
  assert.equal((await f.readStored()).images[1].notes, 'Edit 0');
});

test('queued navigation revocation and revocation after a read prevent saving without locking storage', async t => {
  const f = await fixture(t);
  const held = await holdCatalogueRead(t, f.store);
  const reading = f.session.readCatalogue(f.generation);
  await held.ready.promise;
  let authorized = true;
  const update = f.session.updateVideoMetadata(f.generation, f.update(), () => authorized);
  const rejected = assert.rejects(update, /private hub session is unavailable/);
  authorized = false; held.release.resolve();
  await Promise.all([reading, rejected]);
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.deepEqual(await f.readStored(), f.catalogue);
  const read = f.store.readRecord.bind(f.store);
  let plaintext!: Buffer;
  authorized = true;
  t.mock.method(f.store, 'readRecord', async (id: string, limit?: number) => {
    plaintext = await read(id, limit); authorized = false; return plaintext;
  });
  await assert.rejects(f.session.updateVideoMetadata(f.generation, f.update(), () => authorized));
  assert.equal(plaintext.every(byte => byte === 0), true);
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('storage publication receives current authority and refuses revocation between admission and write', async t => {
  const f = await fixture(t);
  const write = f.store.writeRecord.bind(f.store);
  let authorized = true;
  let snapshot!: Buffer;
  t.mock.method(f.store, 'writeRecord', (id: string, bytes: Buffer, authority?: () => boolean) => {
    assert.equal(typeof authority, 'function');
    assert.equal(authority!(), true);
    snapshot = bytes;
    authorized = false;
    return write(id, bytes, authority);
  });
  await assert.rejects(f.session.updateVideoMetadata(f.generation, f.update(), () => authorized));
  assert.equal(snapshot.every(byte => byte === 0), true);
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('lock invalidates queued updates and rejects locked or stale generation access', async t => {
  const f = await fixture(t);
  const held = await holdCatalogueRead(t, f.store);
  const reading = f.session.readCatalogue(f.generation);
  const readRejected = assert.rejects(reading);
  await held.ready.promise;
  const editing = f.session.updateVideoMetadata(f.generation, f.update(), current);
  const editRejected = assert.rejects(editing);
  const draining = f.session.lock();
  assert.equal(f.store.locked, true);
  held.release.resolve();
  await Promise.all([readRejected, editRejected, draining]);
  await assert.rejects(f.session.updateVideoMetadata(f.generation, f.update(), current));
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images[1].notes, f.catalogue.images[1].notes);
  await assert.rejects(f.session.updateVideoMetadata(f.generation, f.update(), current));
});

test('lock during save completion drains the admitted write and never returns stale success', async t => {
  const f = await fixture(t);
  const started = deferred();
  const finish = deferred();
  const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, authority?: () => boolean) => {
    await write(id, bytes, authority); started.resolve(); await finish.promise;
  });
  t.after(() => finish.resolve());
  const editing = f.session.updateVideoMetadata(f.generation, f.update(), current);
  const rejected = assert.rejects(editing);
  await started.promise;
  let drained = false;
  const locking = f.session.lock().then(() => { drained = true; });
  assert.equal(f.store.locked, true);
  await Promise.resolve(); assert.equal(drained, false);
  finish.resolve();
  await Promise.all([rejected, locking]);
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images[1].notes, 'New ' + marker, 'already committed encrypted bytes remain durable');
});

for (const operation of ['readRecord', 'writeRecord'] as const) {
  test('actual ' + operation + ' failure locks storage and returns only a generic error', async t => {
    const f = await fixture(t);
    t.mock.method(f.store, operation, async () => { throw new Error(f.root + '/' + marker); });
    await assert.rejects(f.session.updateVideoMetadata(f.generation, f.update(), current), error => {
      assert.equal(String(error).includes(marker), false);
      assert.equal(String(error).includes(f.root), false);
      return true;
    });
    assert.equal(f.session.status.state, 'locked');
    assert.equal(f.store.locked, true);
  });
}

test('an admitted metadata transaction blocks preview generation until its encrypted write settles', async t => {
  const f = await fixture(t);
  const source = await f.source();
  const held = await holdCatalogueRead(t, f.store);
  const editing = f.session.updateVideoMetadata(f.generation, f.update(), current);
  await held.ready.promise;
  await assert.rejects(f.session.generatePreviews(f.generation, source));
  assert.equal(source.signal.aborted, false);
  held.release.resolve();
  assert.equal((await editing).status, 'saved');
});

test('active preview generation reports metadata busy without queuing or locking, then permits a save', async t => {
  const f = await fixture(t);
  const source = await f.source();
  const started = deferred();
  const finish = deferred();
  t.after(() => finish.resolve());
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async () => {
    started.resolve(); await finish.promise; return createPrivatePreviewSet('other-hash', 256, 144, 3, false);
  });
  const generating = f.session.generatePreviews(f.generation, source);
  await started.promise;
  assert.deepEqual(await f.session.updateVideoMetadata(f.generation, f.update(), current), { status: 'busy' });
  assert.equal(f.session.isCurrent(f.generation), true);
  finish.resolve(); await generating;
  assert.equal((await f.session.updateVideoMetadata(f.generation, f.update(), current)).status, 'saved');
});
