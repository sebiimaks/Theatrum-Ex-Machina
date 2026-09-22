import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { NewImageElement } from '../interfaces/final-object.interface';
import { addCatalogueMediaLocationAuthority } from './catalogue-media-authority';

const NodeModule = require('node:module');
const workspace = '/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs';

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve: resolve!, reject: reject! };
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function remainsPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  assert.equal(settled, false);
}

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];
  kill(signal = 'SIGTERM'): boolean { this.signals.push(signal); return true; }
  finish(): void { this.exitCode = 1; this.emit('exit', 1); }
}

async function fixture(run: (context: ReturnType<typeof load>) => Promise<void>): Promise<void> {
  const context = load();
  try { await run(context); } finally {
    context.restore();
    fs.rmSync(context.directory, { recursive: true, force: true });
  }
}

function load() {
  fs.mkdirSync(path.join(workspace, 'tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(workspace, 'tmp/normal-media-drain-'));
  const source = path.join(directory, 'source');
  const asset = path.join(directory, 'vha-fixture');
  fs.mkdirSync(source);
  fs.mkdirSync(asset);
  for (const name of ['thumbnails', 'filmstrips', 'clips']) { fs.mkdirSync(path.join(asset, name)); }
  const video = path.join(source, 'video.mp4');
  fs.writeFileSync(video, 'synthetic-media');
  const notifications: unknown[][] = [];
  const settings = { height: 18, clipHeight: 18, clipSnippets: 0, clipSnippetLength: 1, fixed: true, n: 1 };
  const globals: any = {
    debug: false, hubName: 'fixture', selectedOutputFolder: directory,
    currentlyOpenVhaFile: path.join(directory, 'fixture.scaena'),
    catalogueStorage: Object.freeze({ kind: 'normal' }), catalogueSessionGeneration: 1,
    selectedSourceFolders: { 0: { path: source, watch: true } },
    authorizedSourceFolderPaths: new Set([source]),
    authorizedSourceFolderRealPaths: new Map([[source, source]]),
    authorizedSourceWatchPaths: new Set([source]),
    authorizedCatalogueImageHashes: new Set(['fixturehash']),
    authorizedCatalogueMediaLocations: new Set(),
    screenshotSettings: settings, additionalExtensions: [],
    angularApp: { sender: { isDestroyed: () => false, send: (...args: unknown[]) => notifications.push(args) } },
  };
  const image = { ...NewImageElement(), hash: 'fixturehash', fileName: 'video.mp4', partialPath: '/', inputSource: 0,
    duration: 1, height: 18, screens: 1, missing: false };
  addCatalogueMediaLocationAuthority(globals.authorizedCatalogueMediaLocations, image);
  const metadata = deferred<any>();
  let probes = 0;
  const watcherClose = deferred<void>();
  const watcher = Object.assign(new EventEmitter(), { close: () => watcherClose.promise });
  const filesystem: any = { ...fs, promises: { ...fs.promises } };
  const nativeProbeChild = new Child();
  let nativeProbeCallback: (error: Error | null, data: string, stderr: string) => void;
  const originalLoad = NodeModule._load;
  const owned = ['./main-extract', './main-extract-async', './main-support'].map(name => require.resolve(name));
  owned.forEach(name => delete require.cache[name]);
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'fs') { return filesystem; }
    if (request === 'electron') {
      return { nativeImage: {}, powerSaveBlocker: { start: () => 1, stop: () => undefined } };
    }
    if (request === './main-globals') { return { GLOBALS: globals }; }
    if (request === './media-tool-paths') { return { ffmpegPath: 'unused-test-decoder' }; }
    if (request === './main-support') {
      return {
        extractMetadataAsync: () => { probes++; return metadata.promise; },
        sendCurrentProgress: (...args: unknown[]) => notifications.push(args),
        insertTemporaryFieldsSingle: (value: unknown) => value,
        cleanUpFileName: (value: string) => value,
      };
    }
    if (request === 'chokidar') { return { watch: () => watcher }; }
    if (request === 'child_process') {
      return { ...originalLoad.call(this, request, ...args), execFile: (_command: string, _arguments: string[], _options: unknown, callback: typeof nativeProbeCallback) => {
        nativeProbeCallback = callback;
        return nativeProbeChild;
      } };
    }
    return originalLoad.call(this, request, ...args);
  };
  let extraction: typeof import('./main-extract');
  let queues: typeof import('./main-extract-async');
  let support: typeof import('./main-support');
  try {
    extraction = require('./main-extract');
    queues = require('./main-extract-async');
    support = require(require.resolve('./main-support'));
  } finally { NodeModule._load = originalLoad; }
  return { directory, source, asset, video, globals, image, notifications, metadata, watcherClose, watcher,
    filesystem, nativeProbeChild,
    finishNativeProbe: (error: Error | null, data = '') => nativeProbeCallback(error, data, ''),
    extraction: extraction!, queues: queues!, support: support!, get probes() { return probes; },
    restore: () => { owned.forEach(name => delete require.cache[name]); } };
}

test('drain waits for actual child close after exit and freezes new decoder admission', async () => fixture(async c => {
  const child = new Child();
  const result = c.extraction.spawn_ffmpeg_and_run_detailed([], 60_000, 'synthetic decoder', () => child);
  const drain = c.queues.beginNormalMediaDrain();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.throws(() => c.queues.resetAllQueues(), /still stopping/);
  let spawned = false;
  assert.equal((await c.extraction.spawn_ffmpeg_and_run_detailed([], 10, 'blocked', () => { spawned = true; })).success, false);
  assert.equal(spawned, false);
  child.finish();
  assert.equal((await result).success, false);
  await remainsPending(drain);
  child.emit('close');
  await drain;
  c.queues.resetAllQueues();
}));

test('failed termination does not count as child completion', async () => fixture(async c => {
  const child = new Child();
  const result = c.extraction.spawn_ffmpeg_and_run_detailed([], 60_000, 'synthetic decoder', () => child);
  const drain = c.queues.beginNormalMediaDrain();
  child.emit('error', new Error('synthetic kill failure'));
  await result;
  await remainsPending(drain);
  child.finish();
  child.emit('close');
  await drain;
}));

test('a suspended native image callback keeps draining and cannot write after revocation', async () => fixture(async c => {
  const native = deferred<Buffer>();
  const replacement = c.extraction.replaceThumbnailWithNewImage(
    path.join(c.asset, 'thumbnails', 'fixturehash.jpg'), path.join(c.directory, 'input.png'), 18, () => native.promise,
  );
  const drain = c.queues.beginNormalMediaDrain();
  await remainsPending(drain);
  native.resolve(Buffer.from('not-published'));
  assert.equal(await replacement, false);
  await drain;
  assert.deepEqual(fs.readdirSync(path.join(c.asset, 'thumbnails')), []);
}));

test('crawler abort cancels queued requests but awaits the actual active filesystem callback', async () => fixture(async c => {
  let finishRead: (...args: unknown[]) => void;
  let calls = 0;
  c.filesystem.readdir = (_directory: string, _options: unknown, callback: (...args: unknown[]) => void): void => {
    calls++; finishRead = callback;
  };
  const controller = new AbortController();
  const crawler = c.queues.createBoundedCrawlerFileSystem(1, 20, controller.signal);
  const callbacks: { error: NodeJS.ErrnoException; entries: unknown }[] = [];
  const callback = (error: NodeJS.ErrnoException, entries: unknown): void => { callbacks.push({ error, entries }); };
  crawler.readdir(c.source, { withFileTypes: true }, callback);
  crawler.readdir(c.source, { withFileTypes: true }, callback);
  controller.abort();
  const drain = c.queues.beginNormalMediaDrain();
  await remainsPending(drain);
  assert.equal(calls, 1);
  assert.equal(callbacks.length, 1);
  finishRead!(null, [{ name: 'late-source-file' }]);
  await drain;
  assert.equal(callbacks.length, 2);
  assert.ok(callbacks.every(result => result.error.code === 'ABORT_ERR' && result.entries === undefined));
}));

test('metadata callback without a scan session cannot publish into replacement queues', async () => fixture(async c => {
  let done = 0;
  c.queues.metadataQueueRunner({ dateAdded: 1, fullPath: c.video, inputSource: 0, name: 'video.mp4', partialPath: '/' }, () => { done++; });
  assert.equal(c.probes, 1);
  c.queues.resetAllQueues();
  c.notifications.length = 0;
  c.metadata.resolve({ ...c.image, fullPath: c.video });
  await tick();
  assert.equal(done, 1);
  assert.deepEqual(c.notifications, []);
  await c.queues.beginNormalMediaDrain();
}));

test('drain waits for a metadata worker and suppresses its late publication', async () => fixture(async c => {
  let done = 0;
  c.queues.metadataQueueRunner({ dateAdded: 1, fullPath: c.video, inputSource: 0, name: 'video.mp4', partialPath: '/' }, () => { done++; });
  assert.equal(c.probes, 1);
  const drain = c.queues.beginNormalMediaDrain();
  c.notifications.length = 0;
  await remainsPending(drain);
  c.metadata.resolve({ ...c.image, fullPath: c.video });
  await drain;
  assert.equal(done, 1);
  assert.deepEqual(c.notifications, []);
}));

test('drain waits for native watcher close and ignores late watcher notifications', async () => fixture(async c => {
  c.queues.startWatcher(0, c.source, true);
  const drain = c.queues.beginNormalMediaDrain();
  c.notifications.length = 0;
  c.watcher.emit('unlink', 'video.mp4');
  c.watcher.emit('error', new Error('late native event'));
  c.watcher.emit('ready');
  assert.deepEqual(c.notifications, []);
  assert.throws(() => c.queues.startWatcher(0, c.source, true), /stopped/);
  await remainsPending(drain);
  c.watcherClose.resolve();
  await drain;
}));

test('failed watcher close rejects the transition and cannot be reset into normal work', async () => fixture(async c => {
  c.queues.startWatcher(0, c.source, true);
  const drain = c.queues.beginNormalMediaDrain();
  c.watcherClose.reject(new Error('synthetic close failure'));
  await assert.rejects(drain, /watcher could not be stopped/);
  assert.throws(() => c.queues.resetAllQueues(), /still stopping/);
}));

test('in-flight preview cleanup is drained and sends no completion into the next session', async () => fixture(async c => {
  const target = path.join(c.asset, 'thumbnails', 'orphan.jpg');
  fs.writeFileSync(target, 'synthetic-jpeg');
  const unlinkStarted = deferred<void>();
  const releaseUnlink = deferred<void>();
  c.filesystem.promises.unlink = async (file: string): Promise<void> => {
    unlinkStarted.resolve();
    await releaseUnlink.promise;
    await fs.promises.unlink(file);
  };
  const cleanup = c.queues.removeThumbnailsNotInHub(new Map(), c.directory, c.asset);
  await unlinkStarted.promise;
  const drain = c.queues.beginNormalMediaDrain();
  c.notifications.length = 0;
  await remainsPending(drain);
  releaseUnlink.resolve();
  assert.equal(await cleanup, false);
  await drain;
  assert.deepEqual(c.notifications, []);
}));

test('cancelled regeneration still drains pending staging writes and their cleanup', async () => fixture(async c => {
  const mkdirStarted = deferred<void>();
  const releaseMkdir = deferred<void>();
  const originalMkdir = c.filesystem.promises.mkdir;
  c.filesystem.promises.mkdir = async (directory: string, options?: unknown): Promise<unknown> => {
    if (directory.endsWith('.thumbnail-regeneration')) {
      mkdirStarted.resolve();
      await releaseMkdir.promise;
    }
    return originalMkdir(directory, options);
  };
  const regeneration = c.queues.regenerateThumbnails(c.image);
  const rejected = assert.rejects(regeneration, /cancelled/);
  await mkdirStarted.promise;
  const drain = c.queues.beginNormalMediaDrain();
  await rejected;
  await remainsPending(drain);
  releaseMkdir.resolve();
  await drain;
  assert.deepEqual(fs.readdirSync(path.join(c.asset, '.thumbnail-regeneration')), []);
  assert.deepEqual(fs.readdirSync(path.join(c.asset, 'thumbnails')), []);
}));


test('drain stops a real suspended decoder and waits for native close', { skip: process.platform === 'win32' }, async () => fixture(async c => {
  const decoder = path.join(workspace, 'build', 'media-tools', 'ffmpeg');
  assert.ok(fs.realpathSync(decoder).startsWith('/Users/sm/Workspace/'));
  let child: ChildProcess;
  const result = c.extraction.spawn_ffmpeg_and_run_detailed(
    ['-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1', '-f', 'null', '-'],
    60_000, 'synthetic suspended decoder', (_command, args, options) => {
      child = spawn(decoder, args, { ...options, cwd: c.directory });
      return child;
    },
  );
  try {
    await once(child!, 'spawn');
    assert.equal(child!.kill('SIGSTOP'), true);
    await new Promise(resolve => setTimeout(resolve, 30));
    let closed = false;
    child!.once('close', () => { closed = true; });
    const drain = c.queues.beginNormalMediaDrain();
    await remainsPending(drain);
    await drain;
    assert.equal(closed, true);
    assert.ok(['SIGTERM', 'SIGKILL'].includes(child!.signalCode as string));
    assert.equal((await result).success, false);
  } finally {
    if (child!.exitCode === null && child!.signalCode === null) {
      child!.kill('SIGKILL');
      await once(child!, 'close');
    }
  }
}));


test('private transition waits for detached source-access callback without granting it a new session', async () => fixture(async c => {
  let finishAccess: (error: NodeJS.ErrnoException | null) => void;
  c.filesystem.access = (_directory: string, _mode: number, callback: typeof finishAccess): void => { finishAccess = callback; };
  c.support.setUpDirectoryWatchers(c.globals.selectedSourceFolders, [c.image], false);
  const drain = c.queues.beginNormalMediaDrain();
  c.notifications.length = 0;
  await remainsPending(drain);
  finishAccess!(null);
  await drain;
  assert.deepEqual(c.notifications, []);
  assert.equal(c.queues.hasSourceWatcher(0), false);
}));

test('source-access callback cannot acquire fresh authority after an ordinary queue reset', async () => fixture(async c => {
  let finishAccess: (error: NodeJS.ErrnoException | null) => void;
  c.filesystem.access = (_directory: string, _mode: number, callback: typeof finishAccess): void => { finishAccess = callback; };
  c.support.setUpDirectoryWatchers(c.globals.selectedSourceFolders, [c.image], false);
  c.queues.resetAllQueues();
  c.notifications.length = 0;
  finishAccess!(null);
  assert.deepEqual(c.notifications, []);
  assert.equal(c.queues.hasSourceWatcher(0), false);
  await c.queues.beginNormalMediaDrain();
}));

for (const drift of ['storage', 'session', 'sender', 'source', 'authorization', 'authorization-replacement'] as const) {
  test(`source-access callback refuses changed ${drift} authority`, async () => fixture(async c => {
    let finishAccess: (error: NodeJS.ErrnoException | null) => void;
    c.filesystem.access = (_directory: string, _mode: number, callback: typeof finishAccess): void => { finishAccess = callback; };
    c.support.setUpDirectoryWatchers(c.globals.selectedSourceFolders, [c.image], false);
    if (drift === 'storage') { c.globals.catalogueStorage = Object.freeze({ kind: 'normal' }); }
    if (drift === 'session') { c.globals.catalogueSessionGeneration++; }
    if (drift === 'sender') { c.globals.angularApp.sender = { isDestroyed: () => false, send: (...args: unknown[]) => c.notifications.push(args) }; }
    if (drift === 'source') { c.globals.selectedSourceFolders = { 0: { path: c.source, watch: true } }; }
    if (drift === 'authorization') { c.globals.authorizedSourceFolderPaths.clear(); }
    if (drift === 'authorization-replacement') { c.globals.authorizedSourceFolderPaths = new Set([c.source]); }
    c.notifications.length = 0;
    finishAccess!(null);
    assert.deepEqual(c.notifications, []);
    assert.equal(c.queues.hasSourceWatcher(0), false);
    await c.queues.beginNormalMediaDrain();
  }));
}

test('ordinary detached source access still announces connection and starts its authorized watcher', async () => fixture(async c => {
  let finishAccess: (error: NodeJS.ErrnoException | null) => void;
  c.filesystem.access = (_directory: string, _mode: number, callback: typeof finishAccess): void => { finishAccess = callback; };
  c.support.setUpDirectoryWatchers(c.globals.selectedSourceFolders, [c.image], false);
  c.notifications.length = 0;
  await tick();
  finishAccess!(null);
  assert.deepEqual(c.notifications[0], ['directory-now-connected', 0, c.source]);
  assert.equal(c.queues.hasSourceWatcher(0), true);
  const drain = c.queues.beginNormalMediaDrain();
  c.watcherClose.resolve();
  await drain;
}));


test('metadata probe cancellation result cannot release its actual child-close lease', async () => fixture(async c => {
  const metadata = c.support.extractMetadataAsync(c.video, c.globals.screenshotSettings);
  const rejected = assert.rejects(metadata, /unavailable/);
  const drain = c.queues.beginNormalMediaDrain();
  assert.deepEqual(c.nativeProbeChild.signals, ['SIGTERM']);
  c.finishNativeProbe(new Error('cancelled'));
  await rejected;
  await remainsPending(drain);
  c.nativeProbeChild.finish();
  c.nativeProbeChild.emit('close');
  await drain;
}));

test('metadata source stat callback remains owned after its probe child closes', async () => fixture(async c => {
  let finishStat: (error: NodeJS.ErrnoException | null, stats: fs.Stats) => void;
  c.filesystem.stat = (_file: string, callback: typeof finishStat): void => { finishStat = callback; };
  const metadata = c.support.extractMetadataAsync(c.video, c.globals.screenshotSettings);
  const rejected = assert.rejects(metadata, /unavailable/);
  c.finishNativeProbe(null, JSON.stringify({ streams: [{ width: 16, height: 16, r_frame_rate: '1/1', duration: '1' }], format: { duration: '1', size: '15' } }));
  c.nativeProbeChild.finish();
  c.nativeProbeChild.emit('close');
  const drain = c.queues.beginNormalMediaDrain();
  await remainsPending(drain);
  finishStat!(null, fs.statSync(c.video));
  await rejected;
  await drain;
}));
