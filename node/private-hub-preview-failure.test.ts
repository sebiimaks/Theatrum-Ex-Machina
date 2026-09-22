import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import type { ScreenshotSettings } from '../interfaces/final-object.interface';
import { getMediaToolPath } from './media-tool-paths.ts';
import { readPrivateHubPreview } from './private-hub-catalogue.ts';
import { PRIVATE_HUB_MEDIA_CHUNK_BYTES } from './private-hub-media.ts';
import { generatePrivateHubPreviews, isPrivatePreviewGenerationCleanupFailure } from './private-hub-preview-generation.ts';
import { createPrivatePreviewSet, privatePreviewSetMemberId, publishPrivatePreviewSet, readPrivatePreviewSet } from './private-hub-preview-set.ts';
import { PrivateHubStore } from './private-hub-store.ts';
import * as mediaProcess from './private-media-process.ts';
import { capturePrivatePreviewSource, isPrivatePreviewSourceCleanupFailure } from './private-preview-source.ts';
import { privateProbeCommand } from './private-preview-plan.ts';

const cwd = path.resolve(__dirname, '..');
const password = 'Synthetic chunk failure test passphrase';
const settings: ScreenshotSettings = { height: 144, clipHeight: 144, fixed: true, n: 3, clipSnippets: 2, clipSnippetLength: 1 };
const failure = { name: 'Error', message: 'Private preview generation could not be completed.' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function fixture(t: TestContext, expectSourceCleanupFailure = false) {
  await fs.promises.mkdir(path.join(cwd, 'tmp'), { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(cwd, 'tmp/private-preview-failure-'));
  const directory = path.join(root, 'hub');
  const sourcePath = path.join(root, 'synthetic-source.mp4');
  const generated = childProcess.spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', sourcePath],
  { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const store = await PrivateHubStore.create(directory, password);
  const source = await capturePrivatePreviewSource({ hash: 'source-1', root, partialPath: '', fileName: path.basename(sourcePath),
    inputSource: 0, isCurrent: location => location.hash === 'source-1' && location.root === root && location.fileName === path.basename(sourcePath) });
  t.after(async () => {
    if (expectSourceCleanupFailure) { await assert.rejects(source.close(), isPrivatePreviewSourceCleanupFailure); }
    else { await source.close(); }
    await store.lock();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  const original = createPrivatePreviewSet(source.hash, 256, 144, 3, false);
  await store.writeNewRecord(privatePreviewSetMemberId(original, 'thumbnail'), Buffer.from('original-thumbnail'));
  await store.writeNewRecord(privatePreviewSetMemberId(original, 'filmstrip'), Buffer.from('original-filmstrip'));
  await publishPrivatePreviewSet(store, original, () => true);
  return { store, source, directory, original, sourcePath };
}

/** A quarantined production module has intentionally no reset API. Isolate only
 * that module in tests, retaining the real media/source WeakSet authorities. */
function isolatedGenerator(): typeof generatePrivateHubPreviews {
  const id = require.resolve('./private-hub-preview-generation.ts');
  const cached = require.cache[id];
  delete require.cache[id];
  try { return (require(id) as typeof import('./private-hub-preview-generation')).generatePrivateHubPreviews; }
  finally { if (cached) { require.cache[id] = cached; } else { delete require.cache[id]; } }
}

async function realCleanupFailure(t: TestContext): Promise<Error> {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stdin: null, kill: () => true,
  });
  const spawn = t.mock.method(childProcess, 'spawn', () => child as unknown as childProcess.ChildProcess);
  try {
    const process = mediaProcess.streamPrivateMediaProcess({ ...privateProbeCommand(), sourceFd: 41,
      timeoutMs: 1, signal: new AbortController().signal, isCurrent: () => true });
    let failure: Error | undefined;
    await assert.rejects(process.next(), error => {
      assert.ok(mediaProcess.isPrivateMediaProcessCleanupFailure(error));
      failure = error;
      return true;
    });
    return failure!;
  } finally { child.emit('close', 1, 'SIGKILL'); spawn.mock.restore(); }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); }
    else { signal.addEventListener('abort', () => resolve(), { once: true }); }
  });
}

/** Native probe/images remain real; only streaming clip producers are controlled. */
function blockedClipProducers(t: TestContext, holdCleanup = false, cleanupFailure?: Error) {
  const run = mediaProcess.streamPrivateMediaProcess;
  const nestedWaiting = deferred();
  const nestedClosing = deferred();
  const nestedClosed = deferred();
  const allowClose = deferred();
  if (!holdCleanup) { allowClose.resolve(); }
  const state = {
    nestedBytes: Buffer.from('synthetic-transport-stream'),
    remuxBytes: Buffer.alloc(PRIVATE_HUB_MEDIA_CHUNK_BYTES + 31, 0x4b),
    nestedFd: undefined as number | undefined,
    nestedFinished: false,
    remuxFinished: false,
    nestedClosing: nestedClosing.promise,
    nestedClosed: nestedClosed.promise,
    releaseCleanup: allowClose.resolve,
  };
  const finishNested = async (): Promise<void> => {
    nestedClosing.resolve();
    await allowClose.promise;
    state.nestedFinished = true;
    nestedClosed.resolve();
    if (cleanupFailure) { throw cleanupFailure; }
  };
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', (options: mediaProcess.PrivateMediaProcessOptions) => {
    if (options.args.includes('-mpegts_flags')) {
      return (async function* (): AsyncGenerator<Buffer> {
        state.nestedFd = options.sourceFd;
        try {
          yield state.nestedBytes;
          nestedWaiting.resolve();
          await waitForAbort(options.signal);
          throw new Error('Synthetic nested encoder cancelled: private-source-canary');
        } finally { await finishNested(); }
      })();
    }
    if (options.args.includes('-movflags')) {
      return (async function* (): AsyncGenerator<Buffer> {
        const input = options.input![Symbol.asyncIterator]();
        let pending: Promise<IteratorResult<Uint8Array>> | undefined;
        try {
          assert.equal((await input.next()).done, false);
          // Simulate an assembler actively pumping stdin from a nested encoder.
          // Its pending next() is handled immediately to avoid unhandled errors.
          pending = input.next();
          void pending.catch(() => undefined);
          await nestedWaiting.promise;
          yield state.remuxBytes;
          await waitForAbort(options.signal);
          throw new Error('Synthetic remux cancelled: private-source-canary');
        } finally {
          await pending?.catch(() => undefined);
          await input.return?.();
          state.remuxFinished = true;
        }
      })();
    }
    return run(options);
  });
  return state;
}

test('encrypted chunk failure drains a stalled remux and nested encoder before generation admission reopens', { timeout: 30_000 }, async t => {
  const { store, source, original } = await fixture(t);
  const producers = blockedClipProducers(t, true);
  const write = store.writeNewRecord.bind(store);
  let failedChunks = 0;
  t.mock.method(store, 'writeNewRecord', async (id: string, bytes: Buffer) => {
    if (id.startsWith('media-chunk:')) { failedChunks++; throw new Error('Synthetic encrypted write failure: private-source-canary'); }
    return write(id, bytes);
  });
  let settled = false;
  const pending = generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, failure);
  try {
    await producers.nestedClosing;
    assert.equal(failedChunks, 1);
    assert.equal(settled, false, 'generation cannot settle while nested cleanup is still pending');
    await assert.rejects(generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true }), failure);
    assert.ok(producers.remuxBytes.every(byte => byte === 0));
    producers.releaseCleanup();
    await rejected;
    assert.equal(producers.nestedFinished, true);
    assert.equal(producers.remuxFinished, true);
    assert.ok(producers.nestedBytes.every(byte => byte === 0));
    assert.throws(() => fs.fstatSync(producers.nestedFd!), { code: 'EBADF' });
    assert.deepEqual(await readPrivatePreviewSet(store, source.hash), original);
    assert.equal((await readPrivateHubPreview(store, 'thumbnail', source.hash)).toString(), 'original-thumbnail');
    t.mock.restoreAll();
    const replacement = await generatePrivateHubPreviews(store, source, { ...settings, clipSnippets: 0 }, { isCurrent: () => true });
    assert.notEqual(replacement.generation, original.generation, 'a fresh job is admitted after the failed job drains');
  } finally { producers.releaseCleanup(); await pending.catch(() => undefined); }
});

test('caller cancellation stops nested producers while an encrypted chunk write is pending', { timeout: 30_000 }, async t => {
  const { store, source, original } = await fixture(t);
  const producers = blockedClipProducers(t);
  const controller = new AbortController();
  const chunkEntered = deferred();
  const releaseWrite = deferred();
  const write = store.writeNewRecord.bind(store);
  t.mock.method(store, 'writeNewRecord', async (id: string, bytes: Buffer) => {
    if (id.startsWith('media-chunk:')) {
      chunkEntered.resolve();
      await releaseWrite.promise;
      throw new Error('Synthetic delayed encrypted write failure: private-source-canary');
    }
    return write(id, bytes);
  });
  let settled = false;
  const pending = generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true, signal: controller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, failure);
  try {
    await chunkEntered.promise;
    controller.abort('private-source-canary');
    await producers.nestedClosed;
    assert.equal(settled, false, 'pending storage cleanup retains the global admission slot');
    assert.ok(producers.remuxBytes.every(byte => byte === 0));
    await assert.rejects(generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true }), failure);
    releaseWrite.resolve();
    await rejected;
    assert.equal(producers.remuxFinished, true);
    assert.equal(producers.nestedFinished, true);
    assert.throws(() => fs.fstatSync(producers.nestedFd!), { code: 'EBADF' });
    assert.deepEqual(await readPrivatePreviewSet(store, source.hash), original);
    assert.equal((await readPrivateHubPreview(store, 'thumbnail', source.hash)).toString(), 'original-thumbnail');
  } finally { releaseWrite.resolve(); producers.releaseCleanup(); await pending.catch(() => undefined); }
});

test('store locking erases the pending chunk assembly and preserves the previous active set after reopening', { timeout: 30_000 }, async t => {
  const { store, source, directory, original } = await fixture(t);
  const producers = blockedClipProducers(t);
  const chunkEntered = deferred();
  const releaseWrite = deferred();
  const write = store.writeNewRecord.bind(store);
  let assembly: Buffer | undefined;
  t.mock.method(store, 'writeNewRecord', async (id: string, bytes: Buffer) => {
    if (id.startsWith('media-chunk:')) {
      assembly = bytes;
      chunkEntered.resolve();
      await releaseWrite.promise;
      throw new Error('Synthetic locked write failure: private-source-canary');
    }
    return write(id, bytes);
  });
  const pending = generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true });
  const rejected = assert.rejects(pending, failure);
  try {
    await chunkEntered.promise;
    const locked = store.lock();
    assert.ok(assembly?.every(byte => byte === 0), 'store lock wipes the chunk assembler synchronously');
    assert.ok(producers.remuxBytes.every(byte => byte === 0));
    await producers.nestedClosed;
    releaseWrite.resolve();
    await rejected;
    await locked;
    assert.equal(producers.remuxFinished, true);
    assert.equal(producers.nestedFinished, true);
    assert.throws(() => fs.fstatSync(producers.nestedFd!), { code: 'EBADF' });
    const reopened = await PrivateHubStore.open(directory, password);
    try {
      assert.deepEqual(await readPrivatePreviewSet(reopened, source.hash), original);
      assert.equal((await readPrivateHubPreview(reopened, 'thumbnail', source.hash)).toString(), 'original-thumbnail');
    } finally { await reopened.lock(); }
  } finally { releaseWrite.resolve(); producers.releaseCleanup(); await pending.catch(() => undefined); }
});

test('an unclosed decoder preserves its trusted failure and quarantines global generation admission', { timeout: 10_000 }, async t => {
  const { store, source, original } = await fixture(t);
  const generate = isolatedGenerator();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stdin: null, kill: () => true,
  });
  let spawned = 0;
  let descriptor: number | undefined;
  t.mock.method(childProcess, 'spawn', (_file: string, _args: string[], options: childProcess.SpawnOptions) => {
    spawned++;
    descriptor = (options.stdio as number[])[3];
    return child as unknown as childProcess.ChildProcess;
  });
  const run = mediaProcess.streamPrivateMediaProcess;
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', (options: mediaProcess.PrivateMediaProcessOptions) => run({ ...options, timeoutMs: 1 }));
  await assert.rejects(generate(store, source, settings, { isCurrent: () => true }), error => {
    assert.ok(mediaProcess.isPrivateMediaProcessCleanupFailure(error));
    assert.ok(isPrivatePreviewGenerationCleanupFailure(error));
    return true;
  });
  assert.throws(() => fs.fstatSync(descriptor!), { code: 'EBADF' }, 'parent source lease is still closed');
  assert.deepEqual(await readPrivatePreviewSet(store, source.hash), original);
  child.emit('close', 1, 'SIGKILL');
  await assert.rejects(generate(store, source, settings, { isCurrent: () => true }), failure);
  assert.equal(spawned, 1, 'a late child close cannot reopen quarantined admission');
});

test('a return cleanup failure is retained when revocation already threw inside the producer loop', { timeout: 10_000 }, async t => {
  const { store, source, original } = await fixture(t);
  const generate = isolatedGenerator();
  const cleanup = await realCleanupFailure(t);
  const bytes = Buffer.from('synthetic-sensitive-probe-output');
  let current = true;
  let returned = 0;
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', () => ({
    [Symbol.asyncIterator]() { return this; },
    next: async () => { current = false; return { done: false, value: bytes }; },
    return: async () => { returned++; throw cleanup; },
  }));
  await assert.rejects(generate(store, source, settings, { isCurrent: () => current }), error => error === cleanup);
  assert.equal(returned, 1);
  assert.ok(bytes.every(byte => byte === 0));
  assert.deepEqual(await readPrivatePreviewSet(store, source.hash), original);
  current = true;
  await assert.rejects(generate(store, source, settings, { isCurrent: () => current }), failure);
  assert.equal(returned, 1);
  assert.equal(isPrivatePreviewGenerationCleanupFailure(new Error(cleanup.message)), false);
});

test('source lease close failure stays branded through generation cleanup and quarantines future jobs', { timeout: 10_000 }, async t => {
  const { store, source, sourcePath, original } = await fixture(t, true);
  const generate = isolatedGenerator();
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === sourcePath) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        await close();
        throw new Error('synthetic source-close failure: private-source-canary');
      });
    }
    return handle;
  });
  await assert.rejects(generate(store, source, settings, { isCurrent: () => true }), error => {
    assert.ok(isPrivatePreviewSourceCleanupFailure(error));
    assert.ok(isPrivatePreviewGenerationCleanupFailure(error));
    assert.equal(error.message.includes('private-source-canary'), false);
    return true;
  });
  assert.deepEqual(await readPrivatePreviewSet(store, source.hash), original);
  await assert.rejects(generate(store, source, settings, { isCurrent: () => true }), failure);
});

test('nested cleanup failure cannot be swallowed by a cancelled assembler input pump or all-settled drainage', { timeout: 10_000 }, async t => {
  const { store, source, original } = await fixture(t);
  const generate = isolatedGenerator();
  const cleanup = await realCleanupFailure(t);
  const producers = blockedClipProducers(t, false, cleanup);
  const write = store.writeNewRecord.bind(store);
  t.mock.method(store, 'writeNewRecord', async (id: string, bytes: Buffer) => {
    if (id.startsWith('media-chunk:')) { throw new Error('Synthetic encrypted chunk failure'); }
    return write(id, bytes);
  });
  await assert.rejects(generate(store, source, settings, { isCurrent: () => true }), error => error === cleanup);
  assert.equal(producers.nestedFinished, true);
  assert.equal(producers.remuxFinished, true);
  assert.ok(producers.nestedBytes.every(byte => byte === 0));
  assert.ok(producers.remuxBytes.every(byte => byte === 0));
  assert.throws(() => fs.fstatSync(producers.nestedFd!), { code: 'EBADF' });
  assert.deepEqual(await readPrivatePreviewSet(store, source.hash), original);
  await assert.rejects(generate(store, source, settings, { isCurrent: () => true }), failure);
});
