import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { convertCatalogueToPrivateHub, isPrivateHubConversionCleanupFailure } from './private-hub-conversion';
import { PrivateHubSession, type PrivateHubSessionOptions } from './private-hub-session';
import { PrivateHubStore, PRIVATE_HUB_HEADER_FILE, isPrivateHubStoreCleanupFailure } from './private-hub-store';
import { PRIVATE_HUB_LOCK_FILE } from './private-hub-lock';
import { writePrivateHubMedia, PRIVATE_HUB_MEDIA_CHUNK_BYTES } from './private-hub-media';
import { createPrivatePreviewSet, privatePreviewSetMemberId, privatePreviewSetRecordId, publishPrivatePreviewSet,
  type PrivatePreviewSet } from './private-hub-preview-set';
import { capturePrivatePreviewSource, isPrivatePreviewSourceCleanupFailure,
  type PrivatePreviewSource, type PrivatePreviewSourceOptions } from './private-preview-source';
import * as previewGeneration from './private-hub-preview-generation';
import * as mediaProcess from './private-media-process';
import * as privateMedia from './private-hub-media';
import { PrivateHubOpenCoordinator } from './private-hub-open';
import { PrivateApplicationTransition } from './private-application-transition';
import { NormalApplicationPause } from './normal-application-pause';
import { NormalOperationScope } from './normal-operation-scope';

const password = 'Session synthetic passphrase 2026';
const hash = 'session-video';
const marker = 'SESSION-PRIVATE-CANARY';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve: resolve! };
}

async function fixture(t: TestContext, options: PrivateHubSessionOptions = {}): Promise<{
  directory: string; session: PrivateHubSession; catalogue: FinalObject;
  expectQuarantinedClose(predicate?: (error: unknown) => boolean): void;
}> {
  const temporary = path.join(__dirname, '..', 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-session-'));
  const source = path.join(root, 'source');
  const directory = path.join(root, 'private-hub');
  await fs.mkdir(source);
  const catalogue: FinalObject = {
    addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
    images: [{ ...NewImageElement(), hash, fileName: marker + '.mp4', notes: marker }],
    inputDirs: { 0: { path: '/unopened/' + marker, watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 1, fixed: true, height: 144, n: 3 },
  };
  const cataloguePath = path.join(source, 'original.scaena');
  await fs.writeFile(cataloguePath, JSON.stringify(catalogue));
  for (const [folder, extension, value] of [
    ['thumbnails', '.jpg', 'thumbnail'], ['filmstrips', '.jpg', 'filmstrip'], ['clips', '.jpg', 'poster'], ['clips', '.mp4', '0123456789'],
  ]) {
    const target = path.join(source, 'vha-' + marker, folder);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, hash + extension), value);
  }
  await convertCatalogueToPrivateHub({ cataloguePath, destinationDirectory: directory, password, assertSourceQuiescent: () => undefined });
  const session = new PrivateHubSession(options);
  let quarantinePredicate: ((error: unknown) => boolean) | undefined;
  t.after(async () => {
    if (quarantinePredicate) { await assert.rejects(session.close(), quarantinePredicate); }
    else { await session.close(); }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { directory, session, catalogue, expectQuarantinedClose: (predicate = previewGeneration.isPrivatePreviewGenerationCleanupFailure) => {
    quarantinePredicate = predicate;
  } };
}

async function generationFixture(t: TestContext): Promise<Awaited<ReturnType<typeof fixture>> & {
  generation: number; root: string;
  capture(overrides?: Partial<PrivatePreviewSourceOptions>): Promise<PrivatePreviewSource>;
  expectSourceCleanupFailure(source: PrivatePreviewSource): void;
}> {
  const f = await fixture(t);
  const root = path.join(path.dirname(f.directory), 'synthetic-videos');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, f.catalogue.images[0].fileName), 'SYNTHETIC VIDEO INPUT');
  f.catalogue.inputDirs[0].path = root;
  f.catalogue.images[0].screens = 3;
  const { generation } = await f.session.unlock(f.directory, password);
  await f.session.writeCatalogue(generation, f.catalogue);
  const sources: PrivatePreviewSource[] = [];
  const failedSources = new Set<PrivatePreviewSource>();
  t.after(async () => {
    for (const source of sources) {
      if (failedSources.has(source)) { await assert.rejects(source.close(), isPrivatePreviewSourceCleanupFailure); }
      else { await source.close(); }
    }
  });
  const capture = async (overrides: Partial<PrivatePreviewSourceOptions> = {}): Promise<PrivatePreviewSource> => {
    const source = await capturePrivatePreviewSource({ hash, root, fileName: f.catalogue.images[0].fileName,
      partialPath: '', inputSource: 0, signal: f.session.revocationSignal(generation),
      isCurrent: () => f.session.isCurrent(generation), ...overrides });
    sources.push(source);
    return source;
  };
  return { ...f, generation, root, capture, expectSourceCleanupFailure: source => { failedSources.add(source); } };
}

function failSourceDescriptorClose(t: TestContext, file: string): () => Promise<void> {
  const nativeFs: typeof import('node:fs/promises') = require('node:fs/promises');
  const open = nativeFs.open.bind(nativeFs);
  const closers: (() => Promise<void>)[] = [];
  const mock = t.mock.method(nativeFs, 'open', async (...args: Parameters<typeof nativeFs.open>) => {
    const handle = await open(...args);
    if (args[0] === file) {
      closers.push(handle.close.bind(handle));
      t.mock.method(handle, 'close', async () => { throw new Error(file); });
    }
    return handle;
  });
  return async () => {
    mock.mock.restore();
    for (const close of closers) { await close(); }
  };
}

async function trustedSourceCleanupFailure(t: TestContext, root: string, fileName: string): Promise<Error> {
  const restore = failSourceDescriptorClose(t, path.join(root, fileName));
  try {
    try {
      await capturePrivatePreviewSource({ hash, root, fileName, partialPath: '', inputSource: 0, isCurrent: () => true });
      assert.fail('The injected descriptor failure must prevent capture.');
    } catch (error) {
      assert.ok(isPrivatePreviewSourceCleanupFailure(error));
      return error;
    }
  } finally { await restore(); }
}

function captureStore(t: TestContext): () => PrivateHubStore {
  let captured: PrivateHubStore;
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (directory: string, secret: string) => {
    captured = await open(directory, secret);
    return captured;
  });
  return () => captured;
}

function request(init: RequestInit = {}): Request { return new Request('theatrum://app/private-preview', init); }

async function stagePreviewSet(store: PrivateHubStore, label: string, clip: Buffer | false): Promise<PrivatePreviewSet> {
  const set = createPrivatePreviewSet(hash, 256, 144, 3, clip !== false);
  for (const kind of ['thumbnail', 'filmstrip', 'clip-poster'] as const) {
    if (kind === 'clip-poster' && clip === false) { continue; }
    await store.writeNewRecord(privatePreviewSetMemberId(set, kind), Buffer.from(`${label}:${kind}`));
  }
  if (clip !== false) {
    await writePrivateHubMedia(store, privatePreviewSetMemberId(set, 'clip'), (async function* () { yield clip; })());
  }
  return set;
}

async function assertPreviewUnavailable(response: Promise<Response>): Promise<void> {
  const result = await response.catch(() => undefined);
  if (result) { assert.equal(result.status, 404); assert.equal(await result.text(), ''); }
}

test('first activation verifies a complete conversion; edits survive lock and reopen without old receipt digests', async t => {
  const { directory, session, catalogue } = await fixture(t);
  assert.deepEqual(session.status, { state: 'idle', generation: 0 });
  const first = await session.unlock(directory, password);
  assert.deepEqual(first.catalogue, catalogue);
  const edited = structuredClone(catalogue);
  edited.images[0].notes = 'Updated private notes';
  await session.writeCatalogue(first.generation, edited);
  edited.images[0].notes = 'Caller changed this after save';
  assert.equal((await session.readCatalogue(first.generation)).images[0].notes, 'Updated private notes');
  const draining = session.lock();
  assert.equal(session.status.state, 'locked');
  assert.equal(session.isCurrent(first.generation), false);
  await draining;
  const reopened = await session.unlock(directory, password);
  assert.equal(reopened.catalogue.images[0].notes, 'Updated private notes');
  assert.notEqual(reopened.generation, first.generation);
  assert.ok(!JSON.stringify(session.status).includes(marker));
  assert.ok(!JSON.stringify(session.status).includes(directory));
  await session.close();
  assert.equal(session.status.state, 'idle');
});

test('all preview types use current catalogue authority and clips retain authenticated range support', async t => {
  const { directory, session } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  for (const [kind, expected] of [['thumbnail', 'thumbnail'], ['filmstrip', 'filmstrip'], ['clip-poster', 'poster'], ['clip', '0123456789']] as const) {
    const response = await session.createPreviewResponse(generation, kind, hash, request());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control')!, /no-store/);
    assert.equal(await response.text(), expected);
  }
  const range = await session.createPreviewResponse(generation, 'clip', hash, request({ headers: { Range: 'bytes=2-4' } }));
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '234');
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', 'not-in-catalogue', request()));
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', '../escape', request()));
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', hash, request(), { isAuthorized: () => false }));
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', hash, request(), { isAuthorized: () => { throw new Error(marker); } }), error => !String(error).includes(marker));
});

test('deleting a catalogue video revokes already-created preview streams as well as future requests', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  const old = await session.createPreviewResponse(generation, 'clip', hash, request());
  const updated = structuredClone(catalogue);
  updated.images = [];
  await session.writeCatalogue(generation, updated);
  await assert.rejects(old.text());
  await assert.rejects(session.createPreviewResponse(generation, 'clip', hash, request()));
});

test('external main-process authorization is rechecked after creating a response', async t => {
  const { directory, session } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  let authorized = true;
  for (const kind of ['thumbnail', 'clip'] as const) {
    authorized = true;
    const response = await session.createPreviewResponse(generation, kind, hash, request(), { isAuthorized: () => authorized });
    authorized = false;
    await assert.rejects(response.text());
  }
});

test('wrong passwords, incomplete conversion, and corrupted activation markers fail closed with generic errors', async t => {
  const { directory, session } = await fixture(t);
  await assert.rejects(session.unlock(directory, 'wrong'), /private hub session is unavailable/);
  assert.equal(session.status.state, 'locked');
  await session.lock();
  const store = await PrivateHubStore.open(directory, password);
  await store.writeRecord('session:activation', Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: 'wrong' })));
  await store.lock();
  await assert.rejects(session.unlock(directory, password));
  await session.lock();
  const incomplete = path.join(path.dirname(directory), 'incomplete');
  const empty = await PrivateHubStore.create(incomplete, password);
  await empty.lock();
  await assert.rejects(session.unlock(incomplete, password));
  assert.equal(session.status.state, 'locked');
});

test('a changed converted catalogue cannot create the initial activation marker', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const store = await PrivateHubStore.open(directory, password);
  catalogue.images[0].notes = 'Changed before verification';
  await store.writeRecord('catalogue', Buffer.from(JSON.stringify(catalogue)));
  await store.lock();
  await assert.rejects(session.unlock(directory, password));
  await session.lock();
  const reopened = await PrivateHubStore.open(directory, password);
  try { await assert.rejects(reopened.readRecord('session:activation'), /does not exist/); }
  finally { await reopened.lock(); }
});

test('lock cancels a pending unlock immediately and closes the late-opened store before draining', async t => {
  const { directory, session } = await fixture(t);
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  const ready = deferred();
  const release = deferred();
  let late: PrivateHubStore;
  t.mock.method(PrivateHubStore, 'open', async (target: string, secret: string) => {
    late = await open(target, secret);
    ready.resolve();
    await release.promise;
    return late;
  });
  const unlocking = session.unlock(directory, password);
  const rejected = assert.rejects(unlocking, /private hub session is unavailable/);
  await ready.promise;
  const draining = session.lock();
  assert.equal(session.status.state, 'locked');
  await rejected;
  await assert.rejects(session.unlock(directory, password));
  release.resolve();
  await draining;
  assert.equal(late!.locked, true);
  assert.equal(session.status.state, 'locked');
});

test('concurrent unlock attempts are bounded and never replace an active session', async t => {
  const { directory, session } = await fixture(t);
  const first = session.unlock(directory, password);
  await assert.rejects(session.unlock(directory, password));
  const opened = await first;
  await assert.rejects(session.unlock(directory, password));
  assert.equal(session.isCurrent(opened.generation), true);
});

test('the current generation exposes only a revocation signal which aborts before lock returns', async t => {
  const { directory, session } = await fixture(t);
  assert.throws(() => session.revocationSignal(session.status.generation));
  const first = await session.unlock(directory, password);
  const signal = session.revocationSignal(first.generation);
  assert.equal(signal.aborted, false);
  assert.equal(signal, session.revocationSignal(first.generation));
  assert.throws(() => session.revocationSignal(first.generation + 1));
  let revoked = false;
  signal.addEventListener('abort', () => { revoked = true; });
  const draining = session.lock();
  assert.equal(revoked, true);
  assert.equal(signal.aborted, true);
  assert.throws(() => session.revocationSignal(first.generation));
  await draining;
  const second = await session.unlock(directory, password);
  const next = session.revocationSignal(second.generation);
  assert.notEqual(next, signal);
  assert.equal(next.aborted, false);
  assert.throws(() => session.revocationSignal(first.generation));
});

test('revocation drainage is captured only for the current generation and survives later reuse', async t => {
  const { directory, session } = await fixture(t);
  assert.throws(() => session.revocationDrained(session.status.generation));
  const first = await session.unlock(directory, password);
  const firstDrain = session.revocationDrained(first.generation);
  assert.equal(firstDrain, session.revocationDrained(first.generation));
  assert.throws(() => session.revocationDrained(first.generation + 1));
  let completed = false;
  void firstDrain.then(() => { completed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'capturing drainage must not lock the session');
  assert.equal(session.isCurrent(first.generation), true);
  await session.lock();
  await firstDrain;
  assert.equal(completed, true);
  assert.throws(() => session.revocationDrained(first.generation));
  const second = await session.unlock(directory, password);
  const secondDrain = session.revocationDrained(second.generation);
  assert.notEqual(secondDrain, firstDrain);
  assert.throws(() => session.revocationDrained(first.generation));
  let nextCompleted = false;
  void secondDrain.then(() => { nextCompleted = true; });
  await firstDrain;
  assert.equal(nextCompleted, false);
  await session.close();
  await secondDrain;
});

test('captured revocation drainage waits for an external session lock and its held catalogue write', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const write = store.writeRecord.bind(store);
  const started = deferred();
  const finish = deferred();
  t.mock.method(store, 'writeRecord', async (...args: Parameters<typeof store.writeRecord>) => {
    await write(...args);
    started.resolve();
    await finish.promise;
  });
  const captured = session.revocationDrained(generation);
  let completed = false;
  void captured.then(() => { completed = true; });
  const writing = session.writeCatalogue(generation, catalogue);
  const writeRejected = assert.rejects(writing);
  await started.promise;
  const locking = session.lock();
  try {
    assert.equal(store.lockSignal.aborted, true);
    assert.equal(session.isCurrent(generation), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'physical store closure cannot bypass session queue drainage');
    await assert.rejects(session.unlock(directory, password));
  } finally { finish.resolve(); }
  await Promise.all([captured, locking, writeRejected]);
  assert.equal(completed, true);
});

test('external store revocation drains both the store and the remaining session operation', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const lock = store.lock.bind(store);
  const storeFinish = deferred();
  t.mock.method(store, 'lock', () => lock().then(() => storeFinish.promise));
  const read = store.readRecord.bind(store);
  const started = deferred();
  const operationFinish = deferred();
  t.mock.method(store, 'readRecord', async (...args: Parameters<typeof store.readRecord>) => {
    const bytes = await read(...args);
    started.resolve();
    await operationFinish.promise;
    return bytes;
  });
  const captured = session.revocationDrained(generation);
  let completed = false;
  void captured.then(() => { completed = true; });
  const reading = session.readCatalogue(generation);
  const readRejected = assert.rejects(reading);
  await started.promise;
  const externalLock = store.lock();
  try {
    assert.equal(store.lockSignal.aborted, true);
    assert.equal(session.isCurrent(generation), false);
    assert.throws(() => session.revocationDrained(generation));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    storeFinish.resolve();
    await externalLock;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'store drainage must still wait for the revoked session queue');
  } finally { storeFinish.resolve(); operationFinish.resolve(); }
  await Promise.all([captured, externalLock, readRejected]);
  assert.equal(completed, true);
});

test('reentrant abort and onLock observers cannot settle the captured generation before the outer store drain', async t => {
  const observerDrains: Promise<void>[] = [];
  const { directory, session } = await fixture(t, { onLock: () => { observerDrains.push(session.lock()); } });
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const lock = store.lock.bind(store);
  const finish = deferred();
  t.mock.method(store, 'lock', () => lock().then(() => finish.promise));
  const captured = session.revocationDrained(generation);
  let completed = false;
  void captured.then(() => { completed = true; });
  store.lockSignal.addEventListener('abort', () => { observerDrains.push(session.lock()); }, { once: true });
  const outer = session.lock();
  try {
    assert.equal(observerDrains.length, 2);
    // This nested abort observer sees no store and can complete immediately;
    // it must not steal the outer lock's captured generation completion.
    await observerDrains[0];
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false);
  } finally { finish.resolve(); }
  await Promise.all([captured, outer, ...observerDrains]);
  assert.equal(completed, true);
});

test('captured revocation drainage propagates a late outer failure after a reentrant lock succeeds', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const lock = store.lock.bind(store);
  const finish = deferred();
  const failure = new Error('synthetic late lock cleanup failure');
  let injectFailure = true;
  t.mock.method(store, 'lock', () => {
    const fail = injectFailure;
    injectFailure = false;
    const drained = lock();
    return fail ? drained.then(async () => { await finish.promise; throw failure; }) : drained;
  });
  const captured = session.revocationDrained(generation);
  let completed = false;
  void captured.then(() => { completed = true; }, () => { completed = true; });
  let nested!: Promise<void>;
  store.lockSignal.addEventListener('abort', () => { nested = session.lock(); }, { once: true });
  const outer = session.lock();
  const outerRejected = assert.rejects(outer, error => error === failure);
  try {
    await nested;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false);
  } finally { finish.resolve(); }
  await outerRejected;
  // Deliberately attach after rejection: the captured completion retains the
  // failure without producing an unhandled housekeeping rejection meanwhile.
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(captured, error => error === failure);
  assert.equal(completed, true);
});

test('a synchronous store-lock failure rejects captured drainage instead of stranding cleanup', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const lock = store.lock.bind(store);
  const failure = new Error('synthetic synchronous lock failure');
  let injectFailure = true;
  t.mock.method(store, 'lock', () => {
    const fail = injectFailure;
    injectFailure = false;
    const drained = lock();
    if (fail) { throw failure; }
    return drained;
  });
  const captured = session.revocationDrained(generation);
  const rejection = assert.rejects(captured, error => error === failure);
  await assert.rejects(session.lock(), error => error === failure);
  await rejection;
  assert.equal(store.locked, true);
  assert.equal(session.isCurrent(generation), false);
});

test('lost storage ownership aborts the current revocation signal before teardown completes', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const signal = session.revocationSignal(generation);
  const draining = getStore().lock();
  assert.equal(signal.aborted, true);
  assert.equal(session.isCurrent(generation), false);
  await draining;
  await session.lock();
});

test('lock invalidates queued reads and writes and rejects a decrypted catalogue returning after revocation', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const read = store.readRecord.bind(store);
  const ready = deferred();
  const release = deferred();
  t.mock.method(store, 'readRecord', async (id: string, limit?: number) => {
    const bytes = await read(id, limit);
    if (id === 'catalogue') { ready.resolve(); await release.promise; }
    return bytes;
  });
  const reading = session.readCatalogue(generation);
  const readRejected = assert.rejects(reading);
  await ready.promise;
  const writing = session.writeCatalogue(generation, catalogue);
  const writeRejected = assert.rejects(writing);
  const draining = session.lock();
  assert.equal(store.locked, true);
  release.resolve();
  await Promise.all([readRejected, writeRejected, draining]);
  await assert.rejects(session.readCatalogue(generation));
  await assert.rejects(session.writeCatalogue(generation, catalogue));
  await assert.rejects(session.createPreviewResponse(generation, 'clip', hash, request()));
});

test('queued catalogue saves snapshot caller input and bound operation admission', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const read = store.readRecord.bind(store);
  const ready = deferred();
  const release = deferred();
  let held = false;
  t.mock.method(store, 'readRecord', async (id: string, limit?: number) => {
    if (!held && id === 'catalogue') { held = true; ready.resolve(); await release.promise; }
    return read(id, limit);
  });
  const reading = session.readCatalogue(generation);
  await ready.promise;
  catalogue.images[0].notes = 'Snapshot before enqueue';
  const writing = session.writeCatalogue(generation, catalogue);
  catalogue.images[0].notes = 'Mutable caller after enqueue';
  const pending = Array.from({ length: 14 }, () => session.readCatalogue(generation));
  await assert.rejects(session.readCatalogue(generation));
  release.resolve();
  await Promise.all([reading, writing, ...pending]);
  assert.equal((await session.readCatalogue(generation)).images[0].notes, 'Snapshot before enqueue');
});

test('storage-lock loss revokes authority; teardown errors cannot prevent synchronous key wiping', async t => {
  const calls: string[] = [];
  const { directory, session } = await fixture(t, { onLock: reason => {
    calls.push(reason);
    assert.equal(observed?.locked, true);
    assert.equal(session.status.state, 'locked');
    throw new Error(marker);
  } });
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const observed = getStore();
  const response = await session.createPreviewResponse(generation, 'clip', hash, request());
  await observed.lock();
  assert.equal(session.isCurrent(generation), false);
  assert.deepEqual(calls, ['storage-lock-lost']);
  await assert.rejects(response.text());
  await session.lock();
});

test('lock hooks may reenter lock and reject asynchronously without retaining authority', async t => {
  const { directory, session } = await fixture(t, { onLock: async () => {
    assert.equal(observed?.locked, true);
    await session.lock();
    throw new Error(marker);
  } });
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const observed = getStore();
  await session.lock();
  assert.equal(session.isCurrent(generation), false);
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('ambiguous catalogue write failures lock the session and never try a plaintext write', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  t.mock.method(getStore(), 'writeRecord', async () => { throw new Error('/private/secret/' + marker); });
  await assert.rejects(session.writeCatalogue(generation, catalogue), error => !String(error).includes(marker));
  assert.equal(session.status.state, 'locked');
  assert.equal(getStore().locked, true);
});

test('invalid catalogue writes do not remove current authority or persist unsafe preview identities', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  catalogue.images[0].hash = '../escape';
  await assert.rejects(session.writeCatalogue(generation, catalogue));
  assert.equal(session.isCurrent(generation), true);
  assert.equal(await (await session.createPreviewResponse(generation, 'thumbnail', hash, request())).text(), 'thumbnail');
});

test('a lock during the queue completion microtasks discards a catalogue before public handoff', async t => {
  const { directory, session } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  const current = session.isCurrent.bind(session);
  let checks = 0;
  t.mock.method(session, 'isCurrent', (candidate: number) => {
    const authorized = current(candidate);
    if (++checks === 3) { queueMicrotask(() => { void session.lock(); }); }
    return authorized;
  });
  await assert.rejects(session.readCatalogue(generation));
  assert.equal(session.status.state, 'locked');
});

test('a lock during save completion prevents a stale save success handoff', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  const current = session.isCurrent.bind(session);
  let checks = 0;
  t.mock.method(session, 'isCurrent', (candidate: number) => {
    const authorized = current(candidate);
    if (++checks === 5) { queueMicrotask(() => { void session.lock(); }); }
    return authorized;
  });
  await assert.rejects(session.writeCatalogue(generation, catalogue));
  assert.equal(session.status.state, 'locked');
});

test('close retains the private locked state until a cancelled unlock actually drains', async t => {
  const { directory, session } = await fixture(t);
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  const ready = deferred();
  const release = deferred();
  t.mock.method(PrivateHubStore, 'open', async (target: string, secret: string) => {
    const store = await open(target, secret);
    ready.resolve();
    await release.promise;
    return store;
  });
  const opening = session.unlock(directory, password);
  const rejected = assert.rejects(opening);
  await ready.promise;
  const closing = session.close();
  assert.equal(session.status.state, 'locked');
  await rejected;
  await assert.rejects(session.unlock(directory, password));
  release.resolve();
  await closing;
  assert.equal(session.status.state, 'idle');
});

test('an authorization callback cannot lock the session and still authorize a HEAD response', async t => {
  const { directory, session } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', hash, request({ method: 'HEAD' }), {
    isAuthorized: () => { void session.lock(); return true; },
  }));
  assert.equal(session.status.state, 'locked');
});

test('unread image responses reserve a bounded byte budget before storage reads and release on consumption or cancel', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const read = store.readRecord.bind(store);
  let reads = 0;
  t.mock.method(store, 'readRecord', (id: string, limit?: number) => { reads++; return read(id, limit); });
  const unread = await Promise.all(Array.from({ length: 4 }, () => session.createPreviewResponse(generation, 'thumbnail', hash, request())));
  assert.equal(reads, 8, 'each admitted image checks its preview-set manifest and then reads its image');
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', hash, request()));
  await assert.rejects(session.createPreviewResponse(generation, 'clip', hash, request()));
  assert.equal(reads, 8, 'capacity rejection must happen before reading a manifest or allocating a preview');
  assert.equal(await unread[0].text(), 'thumbnail');
  const afterRead = await session.createPreviewResponse(generation, 'thumbnail', hash, request());
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', hash, request()));
  await unread[1].body!.cancel();
  const afterCancel = await session.createPreviewResponse(generation, 'thumbnail', hash, request());
  await Promise.all([unread[2].body!.cancel(), unread[3].body!.cancel(), afterRead.body!.cancel(), afterCancel.body!.cancel()]);
  // Double cancellation cannot refund twice and enlarge the budget.
  await unread[1].body!.cancel();
  const refill = await Promise.all(Array.from({ length: 4 }, () => session.createPreviewResponse(generation, 'thumbnail', hash, request())));
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', hash, request()));
  await Promise.all(refill.map(response => response.body!.cancel()));
});

test('unread clips also have a response count limit, restored by cancellation and lock', async t => {
  const { directory, session } = await fixture(t);
  const first = await session.unlock(directory, password);
  const unread: Response[] = [];
  for (let index = 0; index < 16; index++) {
    unread.push(await session.createPreviewResponse(first.generation, 'clip', hash, request()));
  }
  await assert.rejects(session.createPreviewResponse(first.generation, 'clip', hash, request()));
  await unread[0].body!.cancel();
  unread[0] = await session.createPreviewResponse(first.generation, 'clip', hash, request());
  await assert.rejects(session.createPreviewResponse(first.generation, 'clip', hash, request()));
  await session.lock();
  await Promise.all(unread.map(response => assert.rejects(response.text())));
  const second = await session.unlock(directory, password);
  const restored = await Promise.all(Array.from({ length: 4 }, () => session.createPreviewResponse(second.generation, 'thumbnail', hash, request())));
  await assert.rejects(session.createPreviewResponse(second.generation, 'thumbnail', hash, request()));
  await Promise.all(restored.map(response => response.body!.cancel()));
});

test('HEAD, rejected ranges, authorization failures and unavailable previews do not leak response reservations', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  catalogue.images.push({ ...NewImageElement(), hash: 'missing-preview', fileName: 'missing.mp4' });
  await session.writeCatalogue(generation, catalogue);
  for (let index = 0; index < 18; index++) {
    assert.equal((await session.createPreviewResponse(generation, 'thumbnail', hash, request({ method: 'HEAD' }))).status, 200);
    assert.equal((await session.createPreviewResponse(generation, 'clip', hash, request({ method: 'HEAD' }))).status, 200);
    assert.equal((await session.createPreviewResponse(generation, 'thumbnail', hash, request({ headers: { Range: 'bytes=99-' } }))).status, 416);
    assert.equal((await session.createPreviewResponse(generation, 'clip', hash, request({ method: 'POST' }))).status, 405);
    assert.equal((await session.createPreviewResponse(generation, 'thumbnail', 'missing-preview', request())).status, 404);
    await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', hash, request(), { isAuthorized: () => false }));
  }
  const unread = await Promise.all(Array.from({ length: 4 }, () => session.createPreviewResponse(generation, 'thumbnail', hash, request())));
  await Promise.all(unread.map(response => response.body!.cancel()));
});

test('deleted videos and synthetic folders cannot authorize retained encrypted preview records', async t => {
  const { directory, session, catalogue } = await fixture(t);
  const { generation } = await session.unlock(directory, password);
  catalogue.images[0].deleted = true;
  await session.writeCatalogue(generation, catalogue);
  await assert.rejects(session.createPreviewResponse(generation, 'thumbnail', hash, request()));
  catalogue.images[0].deleted = false;
  catalogue.images[0].cleanName = '*FOLDER*';
  await session.writeCatalogue(generation, catalogue);
  await assert.rejects(session.createPreviewResponse(generation, 'clip', hash, request()));
});

test('a rejected lock drain remains observable without an unhandled housekeeping rejection', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const lock = store.lock.bind(store);
  const failure = new Error('synthetic lock drain failure');
  const captured = session.revocationDrained(generation);
  let injectFailure = true;
  t.mock.method(store, 'lock', () => {
    const drained = lock();
    if (!injectFailure) { return drained; }
    injectFailure = false;
    return drained.then(() => { throw failure; });
  });
  await assert.rejects(session.lock(), error => error === failure);
  assert.equal(store.locked, true);
  assert.equal(session.isCurrent(generation), false);
  assert.equal(session.status.state, 'locked');
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(captured, error => error === failure);
});

test('cleanup failure during rejected unlock does not expose underlying errors or reject unobserved promises', async t => {
  const { directory, session } = await fixture(t);
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (target: string, secret: string) => {
    const store = await open(target, secret);
    const lock = store.lock.bind(store);
    let injectFailure = true;
    t.mock.method(store, 'readRecord', async () => { throw new Error('/private/' + marker); });
    t.mock.method(store, 'lock', () => {
      const drained = lock();
      if (!injectFailure) { return drained; }
      injectFailure = false;
      return drained.then(() => { throw new Error('/private/' + marker); });
    });
    return store;
  });
  await assert.rejects(session.unlock(directory, password), error => !String(error).includes(marker));
  assert.equal(session.status.state, 'locked');
  // Unlock cancellation settles promptly; the intentionally failed physical
  // teardown remains observable until it drains, including to a subsequent lock.
  await session.lock().catch(() => undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('session switches all four preview types only after publishing the complete active generation', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const set = await stagePreviewSet(store, 'new-generation', Buffer.from('new-generation:clip'));
  assert.equal(await (await session.createPreviewResponse(generation, 'thumbnail', hash, request())).text(), 'thumbnail');
  assert.equal(await (await session.createPreviewResponse(generation, 'clip', hash, request())).text(), '0123456789');
  await publishPrivatePreviewSet(store, set, () => session.isCurrent(generation));
  for (const kind of ['thumbnail', 'filmstrip', 'clip-poster', 'clip'] as const) {
    const response = await session.createPreviewResponse(generation, kind, hash, request());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control')!, /no-store/);
    assert.equal(await response.text(), `new-generation:${kind}`);
  }
});

test('a prepared clip response stays pinned across preview-set replacement while new requests use the new set', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const firstBytes = Buffer.alloc(PRIVATE_HUB_MEDIA_CHUNK_BYTES + 17, 0x61);
  const secondBytes = Buffer.alloc(PRIVATE_HUB_MEDIA_CHUNK_BYTES + 39, 0x62);
  const firstSet = await stagePreviewSet(store, 'first', firstBytes);
  await publishPrivatePreviewSet(store, firstSet, () => session.isCurrent(generation));
  const prepared = await session.createPreviewResponse(generation, 'clip', hash, request());
  const preparedButUnread = await session.createPreviewResponse(generation, 'clip', hash, request());
  assert.equal(prepared.headers.get('Content-Length'), String(firstBytes.length));
  const reader = prepared.body!.getReader();
  const firstChunk = await reader.read();
  assert.deepEqual(firstChunk.value, firstBytes.subarray(0, PRIVATE_HUB_MEDIA_CHUNK_BYTES));
  const secondSet = await stagePreviewSet(store, 'second', secondBytes);
  await publishPrivatePreviewSet(store, secondSet, () => session.isCurrent(generation));
  const current = await session.createPreviewResponse(generation, 'clip', hash, request());
  assert.equal(current.headers.get('Content-Length'), String(secondBytes.length));
  assert.deepEqual(Buffer.from(await current.arrayBuffer()), secondBytes);
  assert.deepEqual(Buffer.from(await preparedButUnread.arrayBuffer()), firstBytes);
  assert.deepEqual((await reader.read()).value, firstBytes.subarray(PRIVATE_HUB_MEDIA_CHUNK_BYTES));
  assert.equal((await reader.read()).done, true);
  assert.equal(await (await session.createPreviewResponse(generation, 'thumbnail', hash, request())).text(), 'second:thumbnail');
});

test('a published clip-disabled set suppresses retained legacy clips and posters', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  assert.equal(await (await session.createPreviewResponse(generation, 'clip', hash, request())).text(), '0123456789');
  const set = await stagePreviewSet(getStore(), 'without-clips', false);
  await publishPrivatePreviewSet(getStore(), set, () => session.isCurrent(generation));
  assert.equal(await (await session.createPreviewResponse(generation, 'thumbnail', hash, request())).text(), 'without-clips:thumbnail');
  assert.equal(await (await session.createPreviewResponse(generation, 'filmstrip', hash, request())).text(), 'without-clips:filmstrip');
  await assertPreviewUnavailable(session.createPreviewResponse(generation, 'clip', hash, request()));
  await assertPreviewUnavailable(session.createPreviewResponse(generation, 'clip-poster', hash, request()));
});

test('a corrupt active preview manifest refuses every preview without reading legacy or previous-generation records', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const set = await stagePreviewSet(store, 'previous', Buffer.from('previous:clip'));
  await publishPrivatePreviewSet(store, set, () => session.isCurrent(generation));
  await store.writeRecord(privatePreviewSetRecordId(hash), Buffer.from('malformed active manifest'));
  const read = store.readRecord.bind(store);
  const requested: string[] = [];
  t.mock.method(store, 'readRecord', (id: string, limit?: number) => { requested.push(id); return read(id, limit); });
  for (const kind of ['thumbnail', 'filmstrip', 'clip-poster', 'clip'] as const) {
    await assertPreviewUnavailable(session.createPreviewResponse(generation, kind, hash, request()));
  }
  assert.equal(requested.length, 4);
  assert.ok(requested.every(id => id === privatePreviewSetRecordId(hash)), 'failure must not attempt any preview fallback');
});

test('missing members of a valid active set never fall back to prior encrypted previews', async t => {
  const { directory, session } = await fixture(t);
  const getStore = captureStore(t);
  const { generation } = await session.unlock(directory, password);
  const store = getStore();
  const previous = await stagePreviewSet(store, 'previous', Buffer.from('previous:clip'));
  await publishPrivatePreviewSet(store, previous, () => session.isCurrent(generation));
  // Simulate deleted/corrupt storage: the authenticated manifest remains but its
  // immutable members are absent. The old set and converted records still exist.
  const incomplete = createPrivatePreviewSet(hash, 256, 144, 3, true);
  await publishPrivatePreviewSet(store, incomplete, () => session.isCurrent(generation));
  for (const kind of ['thumbnail', 'filmstrip', 'clip-poster', 'clip'] as const) {
    await assertPreviewUnavailable(session.createPreviewResponse(generation, kind, hash, request()));
  }
});

test('generation derives settings and strip geometry from storage and accepts an exact persisted alternate location', async t => {
  const f = await generationFixture(t);
  await fs.writeFile(path.join(f.root, 'alternate.mp4'), 'ALTERNATE SYNTHETIC VIDEO');
  f.catalogue.images[0].locations = [
    { inputSource: 0, partialPath: '/', fileName: f.catalogue.images[0].fileName },
    { inputSource: 0, partialPath: '/', fileName: 'alternate.mp4' },
  ];
  await f.session.writeCatalogue(f.generation, f.catalogue);
  const expectedSettings = structuredClone(f.catalogue.screenshotSettings);
  f.catalogue.screenshotSettings.n = 17;
  f.catalogue.images[0].screens = 17;
  const source = await f.capture({ fileName: 'alternate.mp4' });
  const expected = createPrivatePreviewSet(hash, 256, 144, 3, true);
  let calls = 0;
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async (
    store: PrivateHubStore, received: PrivatePreviewSource, settings: FinalObject['screenshotSettings'],
    options: previewGeneration.PrivatePreviewGenerationOptions,
  ) => {
    calls++;
    assert.equal(store.locked, false);
    assert.equal(received, source);
    assert.deepEqual(settings, expectedSettings);
    assert.equal(options.expectedScreenCount, 3);
    assert.equal(options.isCurrent(), true);
    return expected;
  });
  assert.deepEqual(await f.session.generatePreviews(f.generation, source), expected);
  assert.equal(calls, 1);
  assert.equal(source.signal.aborted, true);
  assert.equal((await f.session.readCatalogue(f.generation)).images[0].screens, 3);
});

test('generation refuses a known hash paired with a different file, root, or source index', async t => {
  const f = await generationFixture(t);
  await fs.writeFile(path.join(f.root, 'unlisted.mp4'), 'UNLISTED SYNTHETIC VIDEO');
  const otherRoot = path.join(path.dirname(f.root), 'other-videos');
  await fs.mkdir(otherRoot);
  await fs.writeFile(path.join(otherRoot, f.catalogue.images[0].fileName), 'OTHER SYNTHETIC VIDEO');
  const generation = t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async () => {
    throw new Error('Generator must not run for a mismatched location.');
  });
  for (const overrides of [{ fileName: 'unlisted.mp4' }, { root: otherRoot }, { inputSource: 9 }]) {
    const source = await f.capture(overrides);
    await assert.rejects(f.session.generatePreviews(f.generation, source), /private hub session is unavailable/);
    assert.equal(source.signal.aborted, true);
  }
  assert.equal(generation.mock.callCount(), 0);
  const real = await f.capture();
  const lookalike = { hash, signal: real.signal, open: real.open, close: real.close, isCurrent: () => true };
  await assert.rejects(f.session.generatePreviews(f.generation, lookalike));
  await assert.rejects(f.session.generatePreviews(f.generation, real, { signal: {} as AbortSignal }));
  assert.equal(real.signal.aborted, false, 'invalid options must not consume a caller-owned source');
  assert.equal(generation.mock.callCount(), 0);
});

test('generation bounds admission and freezes saves while catalogue reads and previews remain responsive', async t => {
  const f = await generationFixture(t);
  const started = deferred();
  const finish = deferred();
  const expected = createPrivatePreviewSet(hash, 256, 144, 3, true);
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async () => {
    started.resolve();
    await finish.promise;
    return expected;
  });
  const source = await f.capture();
  const generating = f.session.generatePreviews(f.generation, source);
  await started.promise;
  await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue));
  const another = await f.capture();
  await assert.rejects(f.session.generatePreviews(f.generation, another));
  assert.equal(another.signal.aborted, false, 'a rejected admission retains caller ownership');
  assert.equal((await f.session.readCatalogue(f.generation)).images[0].hash, hash);
  assert.equal(await (await f.session.createPreviewResponse(f.generation, 'thumbnail', hash, request())).text(), 'thumbnail');
  finish.resolve();
  assert.deepEqual(await generating, expected);
  await f.session.writeCatalogue(f.generation, f.catalogue);
});

test('generation cannot overtake an admitted catalogue save', async t => {
  const f = await generationFixture(t);
  const source = await f.capture();
  const writing = f.session.writeCatalogue(f.generation, f.catalogue);
  await assert.rejects(f.session.generatePreviews(f.generation, source));
  assert.equal(source.signal.aborted, false);
  await writing;
});

test('lock revokes a generating session synchronously and waits for the producer and source to drain', async t => {
  const f = await generationFixture(t);
  const source = await f.capture();
  const started = deferred();
  const cancelled = deferred();
  const finish = deferred();
  let options: previewGeneration.PrivatePreviewGenerationOptions;
  let producerClosed = false;
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async (
    _store: PrivateHubStore, received: PrivatePreviewSource, _settings: FinalObject['screenshotSettings'],
    receivedOptions: previewGeneration.PrivatePreviewGenerationOptions,
  ) => {
    options = receivedOptions;
    const lease = await received.open();
    started.resolve();
    try {
      await new Promise<void>(resolve => receivedOptions.signal!.addEventListener('abort', () => resolve(), { once: true }));
      cancelled.resolve();
      await finish.promise;
      throw new Error('cancelled');
    } finally { await lease.close(); producerClosed = true; }
  });
  const pending = f.session.generatePreviews(f.generation, source);
  const rejected = assert.rejects(pending);
  await started.promise;
  let drained = false;
  const locking = f.session.lock().then(() => { drained = true; });
  assert.equal(options!.signal!.aborted, true);
  assert.equal(options!.isCurrent(), false);
  assert.equal(f.session.status.state, 'locked');
  await cancelled.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(producerClosed, false);
  await assert.rejects(f.session.unlock(f.directory, password));
  finish.resolve();
  await Promise.all([locking, rejected]);
  assert.equal(producerClosed, true);
  assert.equal(source.signal.aborted, true);
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(await (await f.session.createPreviewResponse(reopened.generation, 'thumbnail', hash, request())).text(), 'thumbnail');
});

test('a stale generation result is discarded even when its producer ignores revocation', async t => {
  const f = await generationFixture(t);
  const source = await f.capture();
  const started = deferred();
  const finish = deferred();
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async () => {
    started.resolve();
    await finish.promise;
    return createPrivatePreviewSet(hash, 256, 144, 3, true);
  });
  const pending = f.session.generatePreviews(f.generation, source);
  const rejected = assert.rejects(pending);
  await started.promise;
  const closing = f.session.close();
  finish.resolve();
  await Promise.all([rejected, closing]);
  assert.equal(f.session.status.state, 'idle');
  assert.equal(source.signal.aborted, true);
});

test('generation failure keeps an unlocked session and prior previews available', async t => {
  const f = await generationFixture(t);
  const source = await f.capture();
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async () => { throw new Error(f.root); });
  await assert.rejects(f.session.generatePreviews(f.generation, source), error => !String(error).includes(f.root));
  assert.equal(f.session.isCurrent(f.generation), true);
  assert.equal(source.signal.aborted, true);
  assert.equal(await (await f.session.createPreviewResponse(f.generation, 'thumbnail', hash, request())).text(), 'thumbnail');
  await f.session.writeCatalogue(f.generation, f.catalogue);
});

test('a trusted generator cleanup failure locks storage and permanently quarantines the session', async t => {
  const getStore = captureStore(t);
  const f = await generationFixture(t);
  const store = getStore();
  const failure = await trustedSourceCleanupFailure(t, f.root, f.catalogue.images[0].fileName);
  const source = await f.capture();
  const signal = f.session.revocationSignal(f.generation);
  const revokedDrain = f.session.revocationDrained(f.generation);
  f.expectQuarantinedClose();
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async () => { throw failure; });
  await assert.rejects(f.session.generatePreviews(f.generation, source), error => {
    assert.equal(error, failure, 'trusted cleanup identity must survive session error sanitization');
    assert.equal(previewGeneration.isPrivatePreviewGenerationCleanupFailure(error), true);
    assert.doesNotMatch(String(error), /synthetic-videos|SESSION-PRIVATE-CANARY/);
    return true;
  });
  await assert.rejects(revokedDrain, error => error === failure);
  assert.equal(store.locked, true);
  assert.equal(store.lockSignal.aborted, true);
  assert.equal(signal.aborted, true);
  assert.equal(f.session.status.state, 'locked');
  assert.equal(f.session.isCurrent(f.generation), false);
  assert.equal(source.isCurrent(), false);
  await assert.rejects(store.readRecord('catalogue'));
  await assert.rejects(f.session.readCatalogue(f.generation));
  await assertPreviewUnavailable(f.session.createPreviewResponse(f.generation, 'thumbnail', hash, request()));
  await assert.rejects(f.session.lock(), previewGeneration.isPrivatePreviewGenerationCleanupFailure);
  await assert.rejects(f.session.close(), previewGeneration.isPrivatePreviewGenerationCleanupFailure);
  await assert.rejects(f.session.unlock(f.directory, password));
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.session.lock(), previewGeneration.isPrivatePreviewGenerationCleanupFailure);
  await assert.rejects(f.session.unlock(f.directory, password));
});

test('an actual source finalizer close failure cannot acknowledge generated previews or complete lock', async t => {
  const getStore = captureStore(t);
  const f = await generationFixture(t);
  const source = await f.capture();
  const store = getStore();
  const restore = failSourceDescriptorClose(t, path.join(f.root, f.catalogue.images[0].fileName));
  f.expectQuarantinedClose();
  f.expectSourceCleanupFailure(source);
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async (_store, received: PrivatePreviewSource) => {
    await received.open(); // The session owns final drainage even if a producer forgets its lease.
    return createPrivatePreviewSet(hash, 256, 144, 3, true);
  });
  try {
    await assert.rejects(f.session.generatePreviews(f.generation, source), isPrivatePreviewSourceCleanupFailure);
    assert.equal(store.locked, true);
    assert.equal(store.lockSignal.aborted, true);
    assert.equal(f.session.status.state, 'locked');
    assert.equal(f.session.isCurrent(f.generation), false);
    await assert.rejects(f.session.lock(), previewGeneration.isPrivatePreviewGenerationCleanupFailure);
    await assert.rejects(f.session.close(), previewGeneration.isPrivatePreviewGenerationCleanupFailure);
    await assert.rejects(f.session.unlock(f.directory, password));
  } finally { await restore(); }
  await assert.rejects(f.session.close(), previewGeneration.isPrivatePreviewGenerationCleanupFailure);
});

test('a changed probe count stops before preview staging and retains the persisted catalogue and previews', async t => {
  const f = await generationFixture(t);
  f.catalogue.images[0].screens = 2;
  await f.session.writeCatalogue(f.generation, f.catalogue);
  const source = await f.capture();
  const commands: string[] = [];
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', (options: mediaProcess.PrivateMediaProcessOptions) => {
    commands.push(options.tool);
    assert.equal(options.tool, 'ffprobe', 'a mismatched geometry must stop before any encoder starts');
    return (async function* (): AsyncGenerator<Buffer> {
      yield Buffer.from(JSON.stringify({ format: { duration: '8' }, streams: [{ codec_type: 'video', width: 160, height: 90 }] }));
    })();
  });
  await assert.rejects(f.session.generatePreviews(f.generation, source));
  assert.deepEqual(commands, ['ffprobe']);
  assert.equal((await f.session.readCatalogue(f.generation)).images[0].screens, 2);
  assert.equal(await (await f.session.createPreviewResponse(f.generation, 'filmstrip', hash, request())).text(), 'filmstrip');
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('caller cancellation drains only its generation and leaves the session available', async t => {
  const f = await generationFixture(t);
  const source = await f.capture();
  const started = deferred();
  const finish = deferred();
  const cancelled = deferred();
  const controller = new AbortController();
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async (
    _store: PrivateHubStore, _source: PrivatePreviewSource, _settings: FinalObject['screenshotSettings'],
    options: previewGeneration.PrivatePreviewGenerationOptions,
  ) => {
    started.resolve();
    await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
    cancelled.resolve();
    await finish.promise;
    throw new Error('cancelled');
  });
  const work = f.session.generatePreviews(f.generation, source, { signal: controller.signal });
  const rejected = assert.rejects(work);
  await started.promise;
  controller.abort(new Error(f.root));
  await cancelled.promise;
  assert.equal(f.session.isCurrent(f.generation), true);
  await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue));
  finish.resolve();
  await rejected;
  assert.equal(source.signal.aborted, true);
  await f.session.writeCatalogue(f.generation, f.catalogue);
});

test('first activation retains a trusted conversion cleanup failure through generic unlock rejection', async t => {
  const f = await fixture(t);
  f.expectQuarantinedClose(isPrivateHubConversionCleanupFailure);
  const getStore = captureStore(t);
  const open = privateMedia.openPrivateHubMedia;
  let returned = 0;
  let activations = 0;
  const write = PrivateHubStore.prototype.writeNewRecord;
  t.mock.method(PrivateHubStore.prototype, 'writeNewRecord', async function (this: PrivateHubStore, id: string, bytes: Buffer) {
    if (id === 'session:activation') { activations++; }
    return write.call(this, id, bytes);
  });
  t.mock.method(privateMedia, 'openPrivateHubMedia', async (...args: Parameters<typeof open>) => {
    const reader = await open(...args);
    return { byteLength: reader.byteLength, readRange: () => ({
      [Symbol.asyncIterator]() { return this; },
      async next() { throw new Error(marker + ' verification failed'); },
      async return() { returned++; throw new Error(marker + ' cleanup failed'); },
    }) };
  });
  await assert.rejects(f.session.unlock(f.directory, password), { message: 'The private hub session is unavailable.' });
  await assert.rejects(f.session.lock(), isPrivateHubConversionCleanupFailure);
  assert.equal(getStore().locked, true);
  assert.equal(f.session.status.state, 'locked');
  assert.equal(returned, 1);
  assert.equal(activations, 0);
  await assert.rejects(f.session.close(), isPrivateHubConversionCleanupFailure);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.session.lock(), isPrivateHubConversionCleanupFailure);
  await assert.rejects(f.session.unlock(f.directory, password), { message: 'The private hub session is unavailable.' });
});

test('static storage-open cleanup failure survives the generic unlock error and repeated disposal', async t => {
  const f = await fixture(t);
  f.expectQuarantinedClose(isPrivateHubStoreCleanupFailure);
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] === path.join(f.directory, PRIVATE_HUB_HEADER_FILE)) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); throw new Error(marker + ' private header close failed'); });
    }
    return handle;
  });
  await assert.rejects(f.session.unlock(f.directory, password), { message: 'The private hub session is unavailable.' });
  let failure: unknown;
  await assert.rejects(f.session.lock(), error => { failure = error; return isPrivateHubStoreCleanupFailure(error); });
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.session.close(), error => error === failure);
  await assert.rejects(f.session.lock(), error => error === failure);
  await assert.rejects(f.session.unlock(f.directory, password), { message: 'The private hub session is unavailable.' });
  assert.equal(f.session.status.state, 'locked');
});

test('late successful storage descriptor close cannot clear session or revocation quarantine', async t => {
  const f = await fixture(t);
  f.expectQuarantinedClose(isPrivateHubStoreCleanupFailure);
  const finishClose = deferred();
  t.after(() => { finishClose.resolve(); });
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] === path.join(f.directory, PRIVATE_HUB_LOCK_FILE)) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); await finishClose.promise; });
    }
    return handle;
  });
  const { generation } = await f.session.unlock(f.directory, password);
  const revoked = f.session.revocationDrained(generation);
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) =>
    schedule(callback, milliseconds === 5000 ? 50 : milliseconds, ...args));
  const locking = f.session.lock();
  let failure: unknown;
  const revocationRejected = assert.rejects(revoked, isPrivateHubStoreCleanupFailure);
  await assert.rejects(locking, error => { failure = error; return isPrivateHubStoreCleanupFailure(error); });
  await revocationRejected;
  finishClose.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.session.close(), error => error === failure);
  await assert.rejects(f.session.lock(), error => error === failure);
  await assert.rejects(f.session.unlock(f.directory, password));
  assert.equal(f.session.isCurrent(generation), false);
});

test('cleanup failure from a late unadopted store blocks restoration after unlock cancellation', async t => {
  const f = await fixture(t);
  f.expectQuarantinedClose(isPrivateHubStoreCleanupFailure);
  const opened = deferred();
  const returnStore = deferred();
  t.after(() => { returnStore.resolve(); });
  const nativeOpen = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args);
    if (args[0] === path.join(f.directory, PRIVATE_HUB_LOCK_FILE)) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); throw new Error(marker + ' late storage close'); });
    }
    return handle;
  });
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (...args: Parameters<typeof open>) => {
    const store = await open(...args);
    opened.resolve();
    await returnStore.promise;
    return store;
  });
  const unlocking = assert.rejects(f.session.unlock(f.directory, password), { message: 'The private hub session is unavailable.' });
  await opened.promise;
  const locking = f.session.lock();
  returnStore.resolve();
  await unlocking;
  await assert.rejects(locking, isPrivateHubStoreCleanupFailure);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.session.close(), isPrivateHubStoreCleanupFailure);
  await assert.rejects(f.session.unlock(f.directory, password));
});

// Keep this last: a proven cleanup failure intentionally quarantines the real
// opening coordinator's process-wide admission, with no test reset backdoor.
test('late activation cleanup cannot restore normal admission after the outer transition is cancelled', async t => {
  const f = await fixture(t);
  f.expectQuarantinedClose(isPrivateHubConversionCleanupFailure);
  const getStore = captureStore(t);
  let deadline!: () => void;
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 5000) { deadline = () => callback(...args); }
    return schedule(callback, milliseconds, ...args);
  });
  const returning = deferred();
  const finishReturn = deferred();
  let expireCleanup!: () => void;
  let returned = false;
  const open = privateMedia.openPrivateHubMedia;
  t.mock.method(privateMedia, 'openPrivateHubMedia', async (...args: Parameters<typeof open>) => {
    const reader = await open(...args);
    return { byteLength: reader.byteLength, readRange: () => ({
      [Symbol.asyncIterator]() { return this; },
      async next() { throw new Error(marker + ' verification interrupted'); },
      async return() {
        expireCleanup = deadline;
        returning.resolve();
        await finishReturn.promise;
        returned = true;
        return { done: true, value: undefined };
      },
    }) };
  });
  let browsers = 0;
  const coordinator = new PrivateHubOpenCoordinator({
    createSession: () => f.session,
    requestPassword: async () => password,
    createBrowser: async () => { browsers++; throw new Error('A failed activation must not allocate a browser'); },
  });
  const operations = new NormalOperationScope();
  let resumes = 0;
  const normal = new NormalApplicationPause({
    operations, canPause: () => true, onPause: () => undefined,
    pauseSources: async () => undefined, drainMedia: async () => undefined,
    resumeSources: () => undefined, resumeMedia: () => undefined, onResume: () => { resumes++; },
  });
  const owner = { isCurrent: () => true };
  const saved = Object.freeze({});
  let frozen = false;
  let hidden = false;
  let rendererReleases = 0;
  let quits = 0;
  const transition = new PrivateApplicationTransition({
    normal, captureNormal: () => owner, selectDirectory: async () => f.directory,
    document: {
      prepare: async (_owner, proof) => { normal.assertPaused(proof); frozen = true; return saved; },
      assertSaved: proof => { assert.equal(proof, saved); },
      cancel: async () => { frozen = false; },
    },
    createWorkspace: () => coordinator,
    hideNormal: () => { hidden = true; }, restoreNormal: () => { hidden = false; },
    releaseRenderer: () => { rendererReleases++; }, quit: () => { quits++; },
  });
  const opening = transition.open();
  try {
    await returning.promise;
    let disposed = false;
    const cancellation = transition.cancel().then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(disposed, false, 'Outer disposal must retain the pending activation verification');
    assert.equal(getStore().locked, true);
    expireCleanup();
    assert.equal(await opening, 'unavailable');
    await cancellation;
    await transition.settled;
    assert.equal(returned, false);
    assert.deepEqual(coordinator.status, { state: 'failed', cleanupFailed: true });
    assert.equal(transition.status.state, 'failed');
    assert.equal(transition.status.cleanupFailed, true);
    assert.equal(normal.status.state, 'paused');
    assert.equal(operations.accepting, false);
    assert.equal(frozen, true);
    assert.equal(hidden, true);
    assert.equal(resumes, 0);
    assert.equal(rendererReleases, 0);
    assert.equal(browsers, 0);
    await assert.rejects(f.session.lock(), isPrivateHubConversionCleanupFailure);
  } finally { finishReturn.resolve(); }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(returned, true);
  await assert.rejects(f.session.close(), isPrivateHubConversionCleanupFailure);
  await assert.rejects(f.session.unlock(f.directory, password));
  assert.equal(await transition.open(), 'unavailable');
  await transition.requestQuit();
  assert.equal(quits, 0);
  assert.equal(operations.accepting, false);
  assert.equal(frozen, true);
  assert.equal(hidden, true);
  assert.equal(resumes, 0);
  assert.equal(rendererReleases, 0);
});
