import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { WebContents } from 'electron';
import { NewImageElement, type FinalObject, type ImageElement } from '../interfaces/final-object.interface';
import { PRIVATE_GALLERY_CHANNELS as channels } from '../interfaces/private-gallery';
import { snapshotPrivateHubPasswordChange } from '../interfaces/private-hub-credentials';
import type { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { exportPrivateHubToPlaintext, isPrivateHubPlaintextExportCleanupFailure } from './private-hub-plaintext-export';
import { privateVideoRevision } from './private-hub-metadata';
import { createPrivatePreviewSet } from './private-hub-preview-set';
import { PrivateSourcePlayback } from './private-source-playback';
import * as sourceScan from './private-source-scan';
import * as sourceCheck from './private-source-check';
import { capturePrivatePreviewSource, isPrivatePreviewSourceCleanupFailure } from './private-preview-source';

type Handler = (event: any, ...args: unknown[]) => Promise<any>;
const handlers = new Map<string, Handler>();
const ipcMain = Object.assign(new EventEmitter(), {
  handle(channel: string, handler: Handler): void {
    if (handlers.has(channel)) { throw new Error('existing owner'); }
    handlers.set(channel, handler);
  },
  removeHandler(channel: string): void { handlers.delete(channel); },
});
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let register: typeof import('./private-gallery-request').registerPrivateGalleryRequest;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    return request === 'electron' ? { ipcMain } : originalLoad.call(this, request, ...args);
  };
  register = require('./private-gallery-request').registerPrivateGalleryRequest;
} finally { NodeModule._load = originalLoad; }
const ENTRY = 'theatrum://app/index.html';
class Contents extends EventEmitter {
  destroyed = false;
  url = ENTRY;
  mainFrame = { url: ENTRY, parent: null, detached: false, isDestroyed: () => false };
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
}
const image = (index: number): ImageElement => ({ ...NewImageElement(), hash: `hash-${index}`, cleanName: `Video ${index}`,
  fileName: `secret-file-${index}.mp4`, partialPath: '/secret-folder', inputSource: 0, notes: `Private note ${index}`,
  tags: index % 2 ? ['Birds > Owls'] : ['Insects'], duration: 120, width: 1920, height: 1080, stars: 5.5,
  locations: [{ inputSource: 0, fileName: 'private-source.mp4', partialPath: '/private' }] });
function fixture(t: TestContext, images = [image(0), image(1)], initialUrl = ENTRY,
  chooseSourceDirectory?: (root: string) => Promise<string | undefined>,
  copyDestination: (() => Promise<string | undefined>) | null = async () => '/synthetic-copy', playback?: PrivateSourcePlayback) {
  const contents = new Contents(); contents.url = initialUrl; contents.mainFrame.url = initialUrl;
  const controller = new AbortController();
  let current = true;
  let reads = 0;
  let locks = 0;
  let hubLocks = 0;
  let locking: PrivateHubSession['lock'] = async () => { current = false; controller.abort(); };
  const edits: unknown[] = [];
  let protectionValue: { autoLockMinutes: 0 | 1 | 5 | 15 | 30; recordPlaybackHistory?: boolean } = { autoLockMinutes: 5 };
  let readingProtection = async () => ({ ...protectionValue });
  let writingProtection: PrivateHubSession['updateProtection'] = async (_generation, value, current) => {
    assert.equal(current(), true); protectionValue = { ...value }; return { ...protectionValue };
  };
  let choosingCopyDestination = copyDestination;
  let copying: PrivateHubSession['createUnprotectedCopy'] = async (_generation, _value, current, options) => {
    assert.equal(current(), true);
    return await options.chooseDestination() ? 'copied' : 'cancelled';
  };
  let changingPassword: PrivateHubSession['changePassword'] = async () => 'changed';
  const appliedProtection: unknown[] = [];
  let applyingProtection = (value: unknown): boolean => { appliedProtection.push(value); return true; };
  let reading = async (): Promise<FinalObject> => ({ images, hubName: 'Secret hub title',
    inputDirs: { 0: { path: '/secret-source', watch: true } } } as unknown as FinalObject);
  let lockAction = (): void => { locks++; };
  let generating: PrivateHubSession['generatePreviews'] = async (_generation, source) => {
    assert.equal(source.isCurrent(), true);
    return createPrivatePreviewSet(source.hash, 256, 144, 3, true);
  };
  let relocating: PrivateHubSession['relocateSource'] = async (_generation, review, current) => {
    assert.equal(current(), true); assert.equal(review.isCurrent(), true); return { status: 'relocated' };
  };
  let refreshing: PrivateHubSession['refreshVideo'] = async (_generation, source, _location, update, options) => {
    assert.equal(options?.isCurrent(), true); assert.equal(source.isCurrent(), true);
    const selected = images[update.index];
    if (!selected || privateVideoRevision(selected) !== update.revision) { return { status: 'conflict' }; }
    images[update.index] = { ...selected, hash: source.hash, fileSize: source.byteLength, duration: 30, width: 640, height: 360, screens: 2 };
    return { status: 'refreshed', image: images[update.index] };
  };
  let importing: PrivateHubSession['importVideo'] = async () => ({ status: 'imported', index: 2 });
  let adding: PrivateHubSession['addSource'] = async (_generation, review, current) => {
    assert.equal(current(), true); assert.equal(review.isCurrent(), true); return { status: 'added' };
  };
  let choosingNewSource: () => Promise<string | undefined> = async () => undefined;
  let choosingImport: (root: string) => Promise<string | readonly string[] | undefined> = async () => undefined;
  let choosingLocation: (root: string) => Promise<string | undefined> = async () => undefined;
  let confirmingLocation: (root: string, videoCount: number) => Promise<boolean> = async () => true;
  let confirmingScan: (count: number, more: boolean) => Promise<boolean> = async () => true;
  let writing: PrivateHubSession['updateVideoMetadata'] = async (generation, request, current) => {
    assert.equal(generation, 7); assert.equal(current(), true);
    const selected = images[request.index];
    if (!selected || privateVideoRevision(selected) !== request.revision) { return { status: 'conflict' }; }
    images[request.index] = { ...selected, notes: request.notes, tags: [...request.tags],
      ...(Object.hasOwn(request, 'rating') ? { stars: (request.rating! + 0.5) as ImageElement['stars'] } : {}) };
    return { status: 'saved', image: images[request.index] };
  };
  const historyWrites: unknown[] = [];
  let recording: PrivateHubSession['recordVideoPlayback'] = async (generation, request, current) => {
    assert.equal(generation, 7); assert.equal(current(), true);
    if (protectionValue.recordPlaybackHistory !== true) { return { status: 'disabled' }; }
    const selected = images[request.index];
    if (!selected || privateVideoRevision(selected) !== request.revision) { return { status: 'conflict' }; }
    images[request.index] = { ...selected, lastPlayed: request.playedAt, timesPlayed: (selected.timesPlayed ?? 0) + 1 };
    return { status: 'recorded', image: images[request.index] };
  };
  const historyResets: unknown[] = [];
  const historyConfirmations: unknown[] = [];
  let confirmingHistory: NonNullable<Parameters<typeof register>[0]['confirmPlaybackHistoryReset']> = async () => true;
  let resettingHistory: PrivateHubSession['resetPlaybackHistory'] = async (generation, metric, current, confirm) => {
    assert.equal(generation, 7); assert.equal(current(), true);
    const selected = images.filter(row => Object.hasOwn(row, metric) && row[metric] !== 0);
    if (!selected.length) { return { status: 'unchanged' }; }
    if (!await confirm(selected.length)) { return { status: 'cancelled' }; }
    if (!current()) { throw new Error('Revoked'); }
    for (const row of selected) { row[metric] = 0; }
    return { status: 'reset', count: selected.length };
  };
  const hub = {
    isCurrent: (generation: number) => generation === 7 && current && !controller.signal.aborted,
    revocationSignal: () => controller.signal,
    lock: (...args: Parameters<PrivateHubSession['lock']>) => { hubLocks++; return locking(...args); },
    readCatalogue: (generation: number) => { assert.equal(generation, 7); reads++; return reading(); },
    updateVideoMetadata: (...args: Parameters<PrivateHubSession['updateVideoMetadata']>) => {
      edits.push(args[1]); return writing(...args);
    },
    resetPlaybackHistory: (...args: Parameters<PrivateHubSession['resetPlaybackHistory']>) => {
      historyResets.push(args[1]); return resettingHistory(...args);
    },
    recordVideoPlayback: (...args: Parameters<PrivateHubSession['recordVideoPlayback']>) => {
      historyWrites.push(args[1]); return recording(...args);
    },
    refreshVideo: (...args: Parameters<PrivateHubSession['refreshVideo']>) => refreshing(...args),
    generatePreviews: (...args: Parameters<PrivateHubSession['generatePreviews']>) => generating(...args),
    addSource: (...args: Parameters<PrivateHubSession['addSource']>) => adding(...args),
    importVideo: (...args: Parameters<PrivateHubSession['importVideo']>) => importing(...args),
    relocateSource: (...args: Parameters<PrivateHubSession['relocateSource']>) => relocating(...args),
    readProtection: () => readingProtection(),
    touchIdStatus: async () => 'disabled',
    enableTouchId: async () => 'enabled',
    disableTouchId: async () => 'disabled',
    updateProtection: (...args: Parameters<PrivateHubSession['updateProtection']>) => writingProtection(...args),
    changePassword: (...args: Parameters<PrivateHubSession['changePassword']>) => changingPassword(...args),
    createUnprotectedCopy: (...args: Parameters<PrivateHubSession['createUnprotectedCopy']>) => copying(...args),
  } as unknown as PrivateHubSession;
  const options = { contents: contents as unknown as WebContents, hub, generation: 7,
    isCurrent: () => current, onLock: () => lockAction(), chooseSourceDirectory, playback,
    chooseSourceLocation: (root: string) => choosingLocation(root),
    chooseImportVideo: (root: string) => choosingImport(root),
    chooseNewSourceDirectory: () => choosingNewSource(),
    confirmSourceLocation: (root: string, videoCount: number) => confirmingLocation(root, videoCount),
    confirmSourceScan: (count: number, more: boolean) => confirmingScan(count, more),
    confirmPlaybackHistoryReset: (metric: 'lastPlayed' | 'timesPlayed', count: number) => {
      historyConfirmations.push({ metric, count }); return confirmingHistory(metric, count);
    },
    onProtectionChanged: (value: unknown) => applyingProtection(value),
    chooseUnprotectedCopyDestination: copyDestination ? () => choosingCopyDestination!() : undefined };
  const dispose = register(options);
  let expectQuarantined = false;
  t.after(async () => {
    if (expectQuarantined) { await assert.rejects(dispose(), /Private gallery cleanup unavailable/); }
    else { await dispose(); }
    assert.equal(handlers.size, 0); assert.equal(ipcMain.listenerCount(channels.lock), 0);
    assert.equal(ipcMain.listenerCount(channels.cancelUnprotectedCopy), 0);
    assert.equal(ipcMain.listenerCount(channels.cancelSourceConnection), 0);
    assert.equal(ipcMain.listenerCount(channels.stopOriginal), 0);
    assert.equal(ipcMain.listenerCount(channels.cancelImport), 0);
  });
  const list = handlers.get(channels.list)!;
  const detail = handlers.get(channels.detail)!;
  const save = handlers.get(channels.save)!;
  const regenerate = handlers.get(channels.regenerate)!;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { contents, controller, options, event, list, detail, save, regenerate, dispose, edits, historyWrites,
    refreshVideo: handlers.get(channels.refreshVideo)!,
    refreshing: (next: typeof refreshing) => { refreshing = next; },
    playOriginal: handlers.get(channels.playOriginal)!,
    ackOriginalPlayback: handlers.get(channels.ackOriginalPlayback)!,
    resetPlaybackHistory: handlers.get(channels.resetPlaybackHistory)!, historyResets, historyConfirmations,
    resettingHistory: (next: typeof resettingHistory) => { resettingHistory = next; },
    confirmHistory: (next: typeof confirmingHistory) => { confirmingHistory = next; },
    recording: (next: typeof recording) => { recording = next; },
    stopOriginal: (...args: unknown[]) => ipcMain.emit(channels.stopOriginal, event, ...args),
    addSource: handlers.get(channels.addSource)!,
    adding: (next: typeof adding) => { adding = next; },
    chooseNewSource: (next: typeof choosingNewSource) => { choosingNewSource = next; },
    sources: handlers.get(channels.sources)!, connectSource: handlers.get(channels.connectSource)!,
    disconnectSource: handlers.get(channels.disconnectSource)!,
    checkSource: handlers.get(channels.checkSource)!,
    relocateSource: handlers.get(channels.relocateSource)!,
    importVideo: handlers.get(channels.importVideo)!,
    scanSource: handlers.get(channels.scanSource)!,
    confirmScan: (next: typeof confirmingScan) => { confirmingScan = next; },
    importProgress: handlers.get(channels.importProgress)!,
    importing: (next: typeof importing) => { importing = next; },
    chooseImport: (next: typeof choosingImport) => { choosingImport = next; },
    cancelImport: (...args: unknown[]) => ipcMain.emit(channels.cancelImport, event, ...args),
    relocate: (next: typeof relocating) => { relocating = next; },
    chooseLocation: (next: typeof choosingLocation) => { choosingLocation = next; },
    confirmLocation: (next: typeof confirmingLocation) => { confirmingLocation = next; },
    cancelSource: (...args: unknown[]) => ipcMain.emit(channels.cancelSourceConnection, event, ...args),
    changePassword: handlers.get(channels.changePassword)!,
    createUnprotectedCopy: handlers.get(channels.createUnprotectedCopy)!,
    copying: (next: typeof copying) => { copying = next; },
    chooseCopy: (next: NonNullable<typeof choosingCopyDestination>) => { choosingCopyDestination = next; },
    cancelCopy: (...args: unknown[]) => ipcMain.emit(channels.cancelUnprotectedCopy, event, ...args),
    changingPassword: (next: typeof changingPassword) => { changingPassword = next; },
    locking: (next: typeof locking) => { locking = next; }, hubLocks: () => hubLocks,
    protection: handlers.get(channels.protection)!, setProtection: handlers.get(channels.setProtection)!, appliedProtection,
    readProtection: (next: typeof readingProtection) => { readingProtection = next; },
    writeProtection: (next: typeof writingProtection) => { writingProtection = next; },
    applyProtection: (next: typeof applyingProtection) => { applyingProtection = next; },
    expectQuarantinedDisposal: () => { expectQuarantined = true; },
    generate: (operation: typeof generating) => { generating = operation; },
    cancel: (...args: unknown[]) => ipcMain.emit(channels.cancelRegeneration, event, ...args),
    write: (operation: typeof writing) => { writing = operation; },
    read: (operation: typeof reading) => { reading = operation; }, reads: () => reads,
    stale: () => { current = false; }, lockAction: (action: () => void) => { lockAction = action; }, locks: () => locks,
    lock: (...args: unknown[]) => ipcMain.emit(channels.lock, event, ...args),
    page: (query = '', offset = 0) => list(event, { query, offset }),
  };
}

test('pages only display metadata with opaque selection IDs and excludes every source field', async t => {
  const f = fixture(t, Array.from({ length: 50 }, (_v, i) => image(i)));
  const page = await f.page();
  assert.equal(page.status, 'ready'); assert.equal(page.total, 50); assert.equal(page.items.length, 48);
  const item = page.items[0];
  assert.match(item.id, /^[a-f0-9]{32}$/);
  assert.equal(item.title, 'Video 0'); assert.equal(item.rating, 5); assert.equal(item.favourite, true);
  assert.match(item.thumbnailUrl, /^theatrum:\/\/app\/media\/thumbnails\/hash-0\.jpg\?v=[a-f0-9]{32}$/);
  assert.deepEqual(Object.keys(item).sort(), ['duration', 'favourite', 'height', 'id', 'rating', 'tags', 'thumbnailUrl', 'title', 'width']);
  assert.doesNotMatch(JSON.stringify(page), /secret|Private note|fileName|inputDirs|locations|partialPath|hubName/);
  const next = await f.page('', 48);
  assert.equal(next.items.length, 2); assert.equal(next.items[0].title, 'Video 48');
  assert.equal(f.reads(), 1, 'display projection is read only and loaded once per browser lifetime');
  assert.equal((await f.page()).items[0].id, item.id);
});

async function sourceFixture(t: TestContext, playback?: PrivateSourcePlayback, extraImages: ImageElement[] = []) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'gallery-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const images: ImageElement[] = [{ ...image(0), fileName: 'synthetic.mp4', partialPath: '', locations: undefined, screens: 3 }, ...extraImages];
  await fs.writeFile(path.join(root, images[0].fileName), 'Synthetic source descriptor contents');
  let picks = 0;
  let choosing = async (_root: string): Promise<string | undefined> => root;
  const f = fixture(t, images, ENTRY, requested => { picks++; assert.equal(requested, root); return choosing(requested); }, undefined, playback);
  let catalogue = { images, inputDirs: { 0: { path: root } } } as unknown as FinalObject;
  f.read(async () => catalogue);
  const id = (await f.page()).items[0].id;
  const item = (await f.detail(f.event, id)).item;
  return { ...f, root, images, id, item, picks: () => picks,
    choose: (next: typeof choosing) => { choosing = next; },
    catalogue: (next: FinalObject) => { catalogue = next; },
    run: (revision = item.revision) => f.regenerate(f.event, { id, revision }),
    refresh: (revision = item.revision) => f.refreshVideo(f.event, { id, revision }),
  };
}

async function relocationFixture(t: TestContext, playback?: PrivateSourcePlayback) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'gallery-relocation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previousRoot = path.join(root, 'previous'); const nextRoot = path.join(root, 'next');
  await fs.mkdir(previousRoot); await fs.mkdir(nextRoot);
  const content = 'Synthetic relocation source';
  for (const directory of [previousRoot, nextRoot]) { await fs.writeFile(path.join(directory, 'synthetic.mp4'), content); }
  const images = [{ ...image(0), fileName: 'synthetic.mp4', partialPath: '', locations: undefined,
    fileSize: Buffer.byteLength(content), screens: 3 }];
  let catalogue = { images, inputDirs: { 0: { path: previousRoot, watch: true } } } as unknown as FinalObject;
  let picks = 0; let confirmations = 0; let writes = 0;
  const f = fixture(t, images, ENTRY, async root => root, undefined, playback);
  f.read(async () => catalogue);
  f.chooseLocation(async old => { assert.equal(old, previousRoot); picks++; return nextRoot; });
  f.confirmLocation(async (next, count) => { assert.equal(next, nextRoot); assert.equal(count, 1); confirmations++; return true; });
  f.relocate(async (_generation, review, current) => {
    assert.equal(current(), true); assert.equal(review.matchesCatalogue(catalogue), true);
    assert.equal(await review.validate(), true);
    writes++; catalogue = { ...catalogue, inputDirs: { ...catalogue.inputDirs,
      0: { ...catalogue.inputDirs[0], path: review.newRoot } } };
    return { status: 'relocated' };
  });
  const videoId = (await f.page()).items[0].id;
  const sourceId = (await f.sources(f.event)).items[0].id;
  return { ...f, root, previousRoot, nextRoot, videoId, sourceId,
    picks: () => picks, confirmations: () => confirmations, writes: () => writes,
    catalogue: () => catalogue, replaceCatalogue: (value: FinalObject) => { catalogue = value; },
    run: () => f.relocateSource(f.event, sourceId) };
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

async function trustedSourceCleanupFailure(t: TestContext, root: string): Promise<Error> {
  const restore = failSourceDescriptorClose(t, path.join(root, 'synthetic.mp4'));
  try {
    try {
      await capturePrivatePreviewSource({ hash: 'hash-0', root, fileName: 'synthetic.mp4',
        partialPath: '', inputSource: 0, isCurrent: () => true });
      assert.fail('The injected descriptor failure must prevent capture.');
    } catch (error) {
      assert.ok(isPrivatePreviewSourceCleanupFailure(error));
      return error;
    }
  } finally { await restore(); }
}

test('regeneration grants the native-selected saved source and rotates opaque edit and preview revisions', async t => {
  const f = await sourceFixture(t);
  assert.equal(f.item.regenerable, true);
  let sourceSeen: any;
  f.generate(async (_generation, source) => {
    sourceSeen = source;
    const lease = await source.open(); assert.ok(lease.fd >= 0); await lease.close();
    return createPrivatePreviewSet(source.hash, 256, 144, 3, true);
  });
  const result = await f.run();
  assert.equal(result.status, 'generated'); assert.notEqual(result.item.revision, f.item.revision);
  for (const kind of ['thumbnailUrl', 'posterUrl', 'clipUrl', 'filmstripUrl'] as const) {
    assert.notEqual(result.item[kind], f.item[kind]);
    assert.match(new URL(result.item[kind]).search, /^\?v=[a-f0-9]{32}$/);
  }
  assert.equal(result.item.notes, f.item.notes); assert.equal(sourceSeen.isCurrent(), false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic\.mp4|gallery-source-|inputDirs|fileName|partialPath|generation/);
  assert.equal((await f.run(result.item.revision)).status, 'generated');
  assert.equal(f.picks(), 1, 'the private window reuses only its own in-memory grant');
  assert.deepEqual(await f.run(), { status: 'conflict' });
});

test('failed initial capture cleanup returns no diagnostics and permanently rejects gallery disposal', async t => {
  const f = await sourceFixture(t);
  const restore = failSourceDescriptorClose(t, path.join(f.root, 'synthetic.mp4'));
  f.expectQuarantinedDisposal();
  f.generate(async () => { assert.fail('failed capture must never reach the generator'); });
  try {
    assert.deepEqual(await f.run(), { status: 'unavailable' });
    assert.ok(f.locks() >= 1);
    assert.deepEqual(await f.page(), { status: 'unavailable' });
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  } finally { await restore(); }
  await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
});

test('trusted generator cleanup failure survives the session boundary as a permanent gallery quarantine', async t => {
  const f = await sourceFixture(t);
  const failure = await trustedSourceCleanupFailure(t, f.root);
  let lockCalls = 0;
  f.lockAction(() => { lockCalls++; throw new Error(f.root); });
  f.expectQuarantinedDisposal();
  f.generate(async () => { throw failure; });
  assert.deepEqual(await f.run(), { status: 'unavailable' });
  assert.ok(lockCalls >= 1);
  assert.deepEqual(await f.run(), { status: 'unavailable' });
  assert.deepEqual(await f.page(), { status: 'unavailable' });
  await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
});

test('an actual failed source finalizer blocks a generated acknowledgement and gallery drainage', async t => {
  const f = await sourceFixture(t);
  let restore: (() => Promise<void>) | undefined;
  let sourceSeen: Parameters<PrivateHubSession['generatePreviews']>[1] | undefined;
  f.expectQuarantinedDisposal();
  f.generate(async (_generation, source) => {
    sourceSeen = source;
    restore = failSourceDescriptorClose(t, path.join(f.root, 'synthetic.mp4'));
    await source.open();
    return createPrivatePreviewSet(source.hash, 256, 144, 3, true);
  });
  try {
    assert.deepEqual(await f.run(), { status: 'unavailable' });
    assert.equal(sourceSeen?.isCurrent(), false);
    assert.ok(f.locks() >= 1);
    await assert.rejects(sourceSeen!.close(), isPrivatePreviewSourceCleanupFailure);
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  } finally { await restore?.(); }
  await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
});

test('cancel, wrong folder and missing source return specific bounded outcomes without generation', async t => {
  const f = await sourceFixture(t); let generated = 0;
  f.generate(async () => { generated++; throw new Error('must not run'); });
  f.choose(async () => undefined); assert.deepEqual(await f.run(), { status: 'cancelled' });
  f.choose(async () => path.dirname(f.root)); assert.deepEqual(await f.run(), { status: 'wrong-folder' });
  await fs.unlink(path.join(f.root, 'synthetic.mp4'));
  f.choose(async () => f.root); assert.deepEqual(await f.run(), { status: 'source-unavailable' });
  assert.equal(generated, 0);
});

test('regeneration never grants arbitrary paths, stale IDs or malformed requests', async t => {
  const f = await sourceFixture(t);
  for (const value of [null, {}, { id: f.id, revision: f.item.revision, path: f.root },
    { id: 'f'.repeat(32), revision: f.item.revision }, { id: f.id, revision: 'bad' }]) {
    assert.deepEqual(await f.regenerate(f.event, value), { status: 'unavailable' });
  }
  assert.deepEqual(await f.regenerate({ ...f.event, sender: new Contents() }, { id: f.id, revision: f.item.revision }), { status: 'unavailable' });
  assert.equal(f.picks(), 0);
  f.images[0].notes = 'newer metadata';
  assert.deepEqual(await f.run(), { status: 'conflict' }); assert.equal(f.picks(), 0);
});

test('source remapping while a native picker is open cannot acquire capture authority', async t => {
  const f = await sourceFixture(t);
  f.choose(async () => {
    f.catalogue({ images: f.images, inputDirs: { 0: { path: path.dirname(f.root) } } } as unknown as FinalObject);
    return f.root;
  });
  f.generate(async () => { assert.fail('remapped source must not generate'); });
  assert.deepEqual(await f.run(), { status: 'conflict' });
});

test('duplicate hashes disable generation without disabling notes editing', async t => {
  const f = await sourceFixture(t);
  f.images.push({ ...f.images[0], fileName: 'duplicate.mp4' });
  const item = (await f.detail(f.event, f.id)).item;
  assert.equal(item.regenerable, false); assert.equal(item.editable, true);
  assert.deepEqual(await f.run(item.revision), { status: 'unavailable' });
  assert.equal(f.picks(), 0);
});

for (const ending of ['cancel', 'lock', 'dispose', 'abort', 'navigate', 'replace-frame']) {
  test(`native source picker completion cannot resume generation after ${ending}`, async t => {
    const f = await sourceFixture(t);
    let finish!: (root: string) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.choose(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    f.generate(async () => { assert.fail('stale picker must not generate'); });
    const work = f.run(); await ready;
    assert.deepEqual(await f.page(), { status: 'busy' });
    assert.deepEqual(await f.run(), { status: 'busy' });
    let drain: Promise<void> | undefined;
    if (ending === 'cancel') { f.cancel(); }
    if (ending === 'lock') { f.lock(); }
    if (ending === 'dispose') { drain = f.dispose(); }
    if (ending === 'abort') { f.controller.abort(); }
    if (ending === 'navigate') { f.contents.emit('did-start-navigation', { isMainFrame: true, url: ENTRY }); }
    if (ending === 'replace-frame') { f.contents.mainFrame = new Contents().mainFrame; }
    let drained = false;
    void drain?.then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    finish(f.root);
    assert.deepEqual(await work, { status: ending === 'cancel' ? 'cancelled' : 'unavailable' });
    await drain;
  });
}

test('cancellation aborts a running source capability and waits for the generator to drain', async t => {
  const f = await sourceFixture(t); let sourceSeen: any;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void; const release = new Promise<void>(resolve => { finish = resolve; });
  f.generate(async (_generation, source, options) => {
    sourceSeen = source; assert.equal(options?.signal?.aborted, false); started(); await release;
    assert.equal(options?.signal?.aborted, true);
    return createPrivatePreviewSet(source.hash, 256, 144, 3, true);
  });
  const work = f.run(); await ready;
  f.cancel('invalid'); assert.equal(sourceSeen.isCurrent(), true);
  f.cancel(); assert.equal(sourceSeen.isCurrent(), false);
  assert.deepEqual(await f.page(), { status: 'busy' });
  finish(); assert.deepEqual(await work, { status: 'cancelled' });
  assert.equal((await f.page()).status, 'ready');
});

test('search uses title and hierarchical tags, excludes deleted files and folder entries', async t => {
  const f = fixture(t, [image(0), image(1), { ...image(2), deleted: true }, { ...image(3), cleanName: '*FOLDER*' }]);
  assert.equal((await f.page()).total, 2);
  assert.equal((await f.page('  OWLS  ')).items[0].title, 'Video 1');
  assert.equal((await f.page('video 0')).items[0].title, 'Video 0');
  assert.equal((await f.page('secret-source')).total, 0);
  assert.equal((await f.page('Private note')).total, 0);
});

test('details require a previously issued ID and copy bounded display fields only', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.detail(f.event, '0'.repeat(32)), { status: 'unavailable' });
  assert.equal(f.reads(), 0);
  const { items } = await f.page();
  const selected = await f.detail(f.event, items[0].id);
  assert.equal(selected.item.notes, 'Private note 0');
  assert.match(selected.item.clipUrl, /^theatrum:\/\/app\/media\/clips\/hash-0\.mp4\?v=[a-f0-9]{32}$/);
  assert.match(selected.item.posterUrl, /^theatrum:\/\/app\/media\/clips\/hash-0\.jpg\?v=[a-f0-9]{32}$/);
  assert.match(selected.item.filmstripUrl, /^theatrum:\/\/app\/media\/filmstrips\/hash-0\.jpg\?v=[a-f0-9]{32}$/);
  assert.equal(selected.item.truncated, false);
  assert.equal(selected.item.editable, true); assert.match(selected.item.revision, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(selected), /secret|fileName|inputDirs|locations|partialPath|hubName/);
  selected.item.tags.push('Changed by caller');
  const reloaded = (await f.detail(f.event, items[0].id)).item;
  assert.deepEqual(reloaded.tags, ['Insects']);
  assert.equal(reloaded.revision, selected.item.revision, 'unchanged metadata keeps its editing authority');
  for (const kind of ['thumbnailUrl', 'posterUrl', 'clipUrl', 'filmstripUrl'] as const) {
    assert.notEqual(reloaded[kind], selected.item[kind], 'reload also refreshes a generation cancelled after publication');
  }
});

test('oversized display text is explicitly shortened without changing the source catalogue', async t => {
  const source = { ...image(0), cleanName: 'T'.repeat(3000), notes: 'N'.repeat(70_000), tags: Array(140).fill('x'.repeat(600)) };
  const f = fixture(t, [source]);
  const { items } = await f.page();
  const { item } = await f.detail(f.event, items[0].id);
  assert.equal(item.title.length, 2048); assert.equal(item.notes.length, 65_536);
  assert.equal(item.tags.length, 128); assert.equal(item.tags[0].length, 512); assert.equal(item.truncated, true);
  assert.equal(item.editable, false);
  assert.equal(source.notes.length, 70_000); assert.equal(source.tags.length, 140);
});

test('invalid numbers never become invalid display metadata or a preview path injection', async t => {
  const f = fixture(t, [{ ...image(0), duration: NaN, width: Infinity, height: -1, stars: 0.5 }]);
  const { items } = await f.page();
  assert.deepEqual([items[0].duration, items[0].width, items[0].height, items[0].rating], [0, 0, 0, 0]);
});

test('malformed payloads never load a catalogue or reach a lock callback', async t => {
  const f = fixture(t);
  for (const args of [[], [null], [{}], [{ query: '', offset: 0, path: '/private' }], [{ query: 'x'.repeat(201), offset: 0 }],
    [{ query: '', offset: -1 }], [{ query: '', offset: 1 }], [{ query: '', offset: Infinity }], [{ query: '', offset: 100_001 }],
    [{ query: '', offset: 0 }, 'extra']]) {
    assert.deepEqual(await f.list(f.event, ...args), { status: 'unavailable' });
  }
  for (const id of [null, {}, '/private', 'f'.repeat(31), 'x'.repeat(32), 'f'.repeat(33)]) {
    assert.deepEqual(await f.detail(f.event, id), { status: 'unavailable' });
  }
  f.lock('extra'); assert.equal(f.locks(), 0); assert.equal(f.reads(), 0);
});

test('untrusted windows, child frames, detached and destroyed frames have no gallery authority', async t => {
  const f = fixture(t); const other = new Contents();
  for (const event of [null, {}, { sender: other, senderFrame: f.contents.mainFrame },
    { sender: f.contents, senderFrame: other.mainFrame }, { sender: f.contents, senderFrame: null }]) {
    assert.deepEqual(await f.list(event, { query: '', offset: 0 }), { status: 'unavailable' });
    ipcMain.emit(channels.lock, event);
  }
  f.contents.mainFrame.parent = {} as any;
  assert.equal((await f.page()).status, 'unavailable');
  f.contents.mainFrame.parent = null; f.contents.mainFrame.detached = true;
  assert.equal((await f.page()).status, 'unavailable');
  f.contents.mainFrame.detached = false; f.contents.mainFrame.isDestroyed = () => true;
  assert.equal((await f.page()).status, 'unavailable');
  assert.equal(f.reads(), 0); assert.equal(f.locks(), 0);
});

test('frame replacement and exact-URL drift revoke old selection authority', async t => {
  const f = fixture(t); const { items } = await f.page();
  for (const url of [ENTRY + '?v=1', ENTRY + '#', 'file:///private', 'theatrum://app:443/index.html', 'https://app/index.html']) {
    f.contents.mainFrame.url = url;
    assert.equal((await f.detail(f.event, items[0].id)).status, 'unavailable');
  }
  f.contents.mainFrame.url = ENTRY;
  f.contents.mainFrame = new Contents().mainFrame;
  assert.equal((await f.detail({ sender: f.contents, senderFrame: f.contents.mainFrame }, items[0].id)).status, 'unavailable');
});

test('only the initial exact navigation is allowed; same-URL reload permanently revokes display access', async t => {
  const f = fixture(t, [image(0)], 'about:blank');
  assert.equal((await f.page()).status, 'unavailable');
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: ENTRY });
  f.contents.url = ENTRY; f.contents.mainFrame.url = ENTRY;
  assert.equal((await f.page()).status, 'ready');
  f.contents.emit('did-start-navigation', { isMainFrame: false, url: 'about:blank' });
  assert.equal((await f.page()).status, 'ready');
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: ENTRY });
  assert.equal((await f.page()).status, 'unavailable');
});

for (const ending of ['lock', 'dispose', 'abort', 'replace-frame', 'stale']) {
  test(`pending decrypted catalogue completion is discarded after ${ending}`, async t => {
    const f = fixture(t);
    let resolve!: (value: FinalObject) => void;
    f.read(() => new Promise(yes => { resolve = yes; }));
    const pending = f.page();
    assert.deepEqual(await f.page(), { status: 'busy' });
    if (ending === 'lock') { f.lock(); }
    if (ending === 'dispose') { f.dispose(); }
    if (ending === 'abort') { f.controller.abort(); }
    if (ending === 'replace-frame') { f.contents.mainFrame = new Contents().mainFrame; }
    if (ending === 'stale') { f.stale(); }
    resolve({ images: [image(0)] } as FinalObject);
    assert.deepEqual(await pending, { status: 'unavailable' });
    assert.deepEqual(await f.page(), { status: 'unavailable' });
  });
}

test('lock invalidates before callback reentry and consumes all subsequent gallery requests', async t => {
  const f = fixture(t); const { items } = await f.page();
  let late!: Promise<unknown>;
  f.lockAction(() => { late = f.detail(f.event, items[0].id); throw new Error('Private diagnostics'); });
  f.lock(); f.lock();
  assert.deepEqual(await late, { status: 'unavailable' });
  assert.deepEqual(await f.page(), { status: 'unavailable' });
});

test('storage and malformed-hash failures return generic status without native diagnostics', async t => {
  const f = fixture(t);
  f.read(async () => { throw new Error('/private/source secret password'); });
  assert.deepEqual(await f.page(), { status: 'unavailable' });
  f.read(async () => ({ images: [{ ...image(0), hash: '../secret' }] } as FinalObject));
  assert.deepEqual(await f.page(), { status: 'unavailable' });
});

test('another registration cannot replace an active owner or inherit its issued IDs', async t => {
  const f = fixture(t); const { items } = await f.page();
  assert.throws(() => register(f.options), /Private gallery unavailable/);
  const oldDetail = f.detail;
  f.dispose();
  const disposeNext = register(f.options);
  try {
    assert.deepEqual(await oldDetail(f.event, items[0].id), { status: 'unavailable' });
    assert.deepEqual(await handlers.get(channels.detail)!(f.event, items[0].id), { status: 'unavailable' });
  } finally { disposeNext(); }
});

test('partial registration failure removes only its own handler and leaves another owner intact', () => {
  const other: Handler = async () => 'another owner';
  handlers.set(channels.detail, other);
  const contents = new Contents(); const controller = new AbortController();
  try {
    assert.throws(() => register({ contents: contents as unknown as WebContents,
      hub: { isCurrent: () => true, revocationSignal: () => controller.signal } as unknown as PrivateHubSession,
      generation: 1, isCurrent: () => true, onLock: () => undefined, onProtectionChanged: () => true }), /Private gallery unavailable/);
    assert.equal(handlers.get(channels.detail), other);
    assert.equal(handlers.has(channels.list), false);
    assert.equal(contents.listenerCount('did-start-navigation'), 0);
  } finally { handlers.clear(); }
});

test('saving edits only the issued catalogue row, rotates revision and updates tag search', async t => {
  const images = [{ ...image(0), deleted: true }, image(1), { ...image(2), hash: 'hash-1' }];
  const f = fixture(t, images);
  const id = (await f.page()).items[0].id;
  const selected = (await f.detail(f.event, id)).item;
  const request = { id, revision: selected.revision, notes: '<script>literal notes</script>', tags: ['Birds > Coastal'] };
  const result = await f.save(f.event, request);
  assert.equal(result.status, 'saved'); assert.equal(result.item.notes, request.notes);
  assert.notEqual(result.item.revision, selected.revision);
  assert.equal((f.edits[0] as any).index, 1, 'filtered-out rows do not shift stored index');
  assert.match((f.edits[0] as any).revision, /^[a-f0-9]{64}$/);
  assert.equal(images[2].notes, 'Private note 2', 'duplicate media hash does not select another row');
  assert.equal((await f.page('coastal')).items[0].id, id);
  assert.equal((await f.page('Owls')).total, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret|fileName|inputSource|locations|partialPath|persistedRevision/);
  assert.deepEqual(await f.save(f.event, request), { status: 'conflict' });
  assert.equal(f.edits.length, 1, 'an old renderer revision cannot start another write');
});

test('stale storage edits conflict and detail reload supplies the latest revision for deliberate retry', async t => {
  const images = [image(0)]; const f = fixture(t, images);
  const id = (await f.page()).items[0].id;
  const selected = (await f.detail(f.event, id)).item;
  const request = { id, revision: selected.revision, notes: 'Draft', tags: selected.tags };
  images[0].notes = 'Newer stored note';
  assert.deepEqual(await f.save(f.event, request), { status: 'conflict' });
  assert.equal(images[0].notes, 'Newer stored note');
  const reloaded = (await f.detail(f.event, id)).item;
  assert.equal(reloaded.notes, 'Newer stored note'); assert.notEqual(reloaded.revision, selected.revision);
  assert.equal((await f.save(f.event, { ...request, revision: reloaded.revision })).status, 'saved');
});

test('detail reload never rebinds an issued selection to a reordered or replaced source', async t => {
  const images = [image(0), image(1)]; const f = fixture(t, images);
  const id = (await f.page()).items[0].id;
  images.reverse();
  assert.deepEqual(await f.detail(f.event, id), { status: 'unavailable' });
  images.reverse(); images[0].fileName = 'replacement.mp4';
  assert.deepEqual(await f.detail(f.event, id), { status: 'unavailable' });
});

test('save rejects malformed, invented and uneditable requests before reaching storage', async t => {
  const f = fixture(t, [{ ...image(0), notes: 'N'.repeat(65_537) }, { ...image(1), cleanName: 'T'.repeat(2049) }]);
  const { items } = await f.page();
  const selected = (await f.detail(f.event, items[0].id)).item;
  const request = { id: items[0].id, revision: selected.revision, notes: '', tags: [] };
  for (const value of [null, {}, { ...request, path: '/private' }, { ...request, notes: 'x'.repeat(65_537) },
    { ...request, tags: Array(129).fill('tag') }, { ...request, tags: ['x'.repeat(513)] },
    { ...request, tags: [null] }, { ...request, revision: '../private' }, request]) {
    assert.deepEqual(await f.save(f.event, value), { status: 'invalid' });
  }
  assert.deepEqual(await f.save(f.event, { ...request, id: 'f'.repeat(32) }), { status: 'unavailable' });
  assert.deepEqual(await f.save({ ...f.event, sender: new Contents() }, request), { status: 'unavailable' });
  assert.deepEqual(await f.save(f.event, request, 'extra'), { status: 'unavailable' });
  assert.equal(f.edits.length, 0);
  const titleOnly = (await f.detail(f.event, items[1].id)).item;
  assert.equal(titleOnly.truncated, true); assert.equal(titleOnly.editable, true);
});

for (const ending of ['lock', 'dispose', 'abort', 'replace-frame', 'navigate', 'stale']) {
  test(`pending metadata save loses authority and suppresses late completion after ${ending}`, async t => {
    const f = fixture(t); const id = (await f.page()).items[0].id;
    const selected = (await f.detail(f.event, id)).item;
    let resolve!: (value: any) => void;
    let authorized!: () => boolean;
    f.write((_generation, _request, current) => { authorized = current; return new Promise(yes => { resolve = yes; }); });
    const pending = f.save(f.event, { id, revision: selected.revision, notes: 'Draft', tags: [] });
    assert.equal(authorized(), true);
    assert.deepEqual(await f.page(), { status: 'busy' });
    assert.deepEqual(await f.detail(f.event, id), { status: 'busy' });
    assert.deepEqual(await f.save(f.event, { id, revision: selected.revision, notes: 'Again', tags: [] }), { status: 'busy' });
    if (ending === 'lock') { f.lock(); }
    if (ending === 'dispose') { f.dispose(); }
    if (ending === 'abort') { f.controller.abort(); }
    if (ending === 'replace-frame') { f.contents.mainFrame = new Contents().mainFrame; }
    if (ending === 'navigate') { f.contents.emit('did-start-navigation', { isMainFrame: true, url: ENTRY }); }
    if (ending === 'stale') { f.stale(); }
    assert.equal(authorized(), false);
    resolve({ status: 'saved', image: { ...image(0), notes: 'Draft', tags: [] } });
    assert.deepEqual(await pending, { status: 'unavailable' });
  });
}

test('save copies renderer tags and exposes only bounded status on storage refusal or exception', async t => {
  const f = fixture(t); const id = (await f.page()).items[0].id;
  const selected = (await f.detail(f.event, id)).item;
  const request = { id, revision: selected.revision, notes: 'Draft', tags: ['Original'] };
  for (const status of ['busy', 'invalid', 'conflict'] as const) {
    f.write(async () => ({ status }));
    assert.deepEqual(await f.save(f.event, request), { status });
  }
  f.write(async () => { throw new Error('/private native key'); });
  assert.deepEqual(await f.save(f.event, request), { status: 'unavailable' });
  request.tags.push('Changed after call');
  assert.deepEqual((f.edits[0] as any).tags, ['Original']);
});

test('protection reads and saves only through current owner and applies policy after persistence', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.protection(f.event), { status: 'ready', autoLockMinutes: 5 });
  assert.deepEqual(await f.setProtection(f.event, { autoLockMinutes: 1 }), { status: 'saved', autoLockMinutes: 1 });
  assert.deepEqual(f.appliedProtection, [{ autoLockMinutes: 1 }]);
  assert.deepEqual(await f.protection(f.event), { status: 'ready', autoLockMinutes: 1 });
  for (const event of [{ ...f.event, sender: new Contents() }, { ...f.event, senderFrame: {} }]) {
    assert.deepEqual(await f.protection(event), { status: 'unavailable' });
    assert.deepEqual(await f.setProtection(event, { autoLockMinutes: 0 }), { status: 'unavailable' });
  }
  for (const value of [null, { autoLockMinutes: 2 }, { autoLockMinutes: '5' }, { autoLockMinutes: 5, path: '/secret' },
    { get autoLockMinutes() { throw new Error('untrusted getter'); } }]) {
    assert.deepEqual(await f.setProtection(f.event, value), { status: 'unavailable' });
  }
  assert.deepEqual(await f.protection(f.event, {}), { status: 'unavailable' });
  assert.deepEqual(f.appliedProtection, [{ autoLockMinutes: 1 }]);
});

test('pending protection save holds shared admission and suppresses an obsolete completion', async t => {
  const f = fixture(t);
  let finish!: () => void;
  let authority!: () => boolean;
  f.writeProtection(async (_generation, value, current) => {
    authority = current;
    await new Promise<void>(resolve => { finish = resolve; });
    return value;
  });
  const request = { autoLockMinutes: 1 };
  const saving = f.setProtection(f.event, request);
  request.autoLockMinutes = 30;
  assert.equal(authority(), true);
  assert.deepEqual(await f.page(), { status: 'busy' });
  assert.deepEqual(await f.protection(f.event), { status: 'busy' });
  f.stale();
  assert.equal(authority(), false);
  finish();
  assert.deepEqual(await saving, { status: 'unavailable' });
  assert.deepEqual(f.appliedProtection, []);
});

test('failed live policy update revokes gallery authority even if its lock callback fails', async t => {
  const f = fixture(t);
  f.applyProtection(() => { throw new Error('timer diagnostics'); });
  f.lockAction(() => { throw new Error('observer diagnostics'); });
  assert.deepEqual(await f.setProtection(f.event, { autoLockMinutes: 0 }), { status: 'unavailable' });
  assert.deepEqual(await f.page(), { status: 'unavailable' });
  assert.deepEqual(await f.protection(f.event), { status: 'unavailable' });
});

test('late protection reads and persistence failures never become saved policy', async t => {
  const f = fixture(t);
  f.writeProtection(async () => { throw new Error('/private/source diagnostics'); });
  assert.deepEqual(await f.setProtection(f.event, { autoLockMinutes: 15 }), { status: 'unavailable' });
  assert.deepEqual(f.appliedProtection, []);
  let finish!: (value: { autoLockMinutes: 5 }) => void;
  f.readProtection(() => new Promise(resolve => { finish = resolve; }));
  const reading = f.protection(f.event);
  f.controller.abort(); finish({ autoLockMinutes: 5 });
  assert.deepEqual(await reading, { status: 'unavailable' });
});

const passwordChange = () => ({ currentPassword: 'Current synthetic password', newPassword: 'Replacement synthetic password' });

test('credential requests reject malformed, oversized, accessor and extra-field input without reading secrets', async t => {
  const f = fixture(t);
  let calls = 0, reads = 0;
  f.changingPassword(async () => { calls++; return 'changed'; });
  const accessor = { get currentPassword() { reads++; throw new Error('private'); }, newPassword: 'valid' };
  const hidden = Object.defineProperty(passwordChange(), 'hidden', { value: 'private' });
  for (const args of [[], [null], [[]], [{}], [passwordChange(), 'extra'], [accessor], [hidden],
    [{ ...passwordChange(), [Symbol('extra')]: 'private' }], [Object.create(passwordChange())],
    [{ ...passwordChange(), path: '/secret' }], [{ ...passwordChange(), currentPassword: '' }],
    [{ ...passwordChange(), currentPassword: 'x'.repeat(1025) }],
    [{ ...passwordChange(), newPassword: 'é'.repeat(513) }], [{ ...passwordChange(), newPassword: '\ud800' }],
    [{ currentPassword: 'same', newPassword: 'same' }]]) {
    assert.deepEqual(await f.changePassword(f.event, ...args), { status: 'invalid' });
  }
  assert.equal(calls, 0); assert.equal(reads, 0); assert.equal(f.locks(), 0);
});

test('credentials require the exact live window and main frame before invoking session work', async t => {
  const f = fixture(t); const other = new Contents();
  let calls = 0;
  f.changingPassword(async () => { calls++; return 'changed'; });
  for (const event of [null, {}, { sender: other, senderFrame: f.contents.mainFrame },
    { sender: f.contents, senderFrame: other.mainFrame }, { sender: f.contents, senderFrame: null }]) {
    assert.deepEqual(await f.changePassword(event, passwordChange()), { status: 'unavailable' });
  }
  f.contents.mainFrame.parent = {} as any;
  assert.equal((await f.changePassword(f.event, passwordChange())).status, 'unavailable');
  f.contents.mainFrame.parent = null; f.contents.mainFrame.detached = true;
  assert.equal((await f.changePassword(f.event, passwordChange())).status, 'unavailable');
  f.contents.mainFrame.detached = false; f.contents.mainFrame.url = ENTRY + '#fragment';
  assert.equal((await f.changePassword(f.event, passwordChange())).status, 'unavailable');
  assert.equal(calls, 0);
});

test('incorrect current passwords remain retryable and copied credential references are cleared immediately', async t => {
  const f = fixture(t);
  let seen: unknown;
  let copied: unknown;
  let finish!: (value: 'incorrect-password') => void;
  f.changingPassword((_generation, value, current) => {
    assert.equal(_generation, 7); assert.equal(current(), true);
    seen = value; copied = snapshotPrivateHubPasswordChange(value);
    return new Promise(resolve => { finish = resolve; });
  });
  const caller = passwordChange();
  const changing = f.changePassword(f.event, caller);
  caller.currentPassword = 'Changed by caller';
  await Promise.resolve();
  assert.deepEqual(copied, passwordChange());
  assert.deepEqual(seen, { currentPassword: '', newPassword: '' });
  assert.equal(caller.currentPassword, 'Changed by caller', 'Never mutate caller-owned objects');
  finish('incorrect-password');
  assert.deepEqual(await changing, { status: 'incorrect-password' });
  assert.equal(f.locks(), 0);
  f.changingPassword(async () => 'incorrect-password');
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'incorrect-password' });
  assert.equal((await f.page()).status, 'ready');
});

test('pending password changes block every gallery operation while Lock stays available', async t => {
  const f = fixture(t); const first = (await f.page()).items[0];
  const selected = (await f.detail(f.event, first.id)).item;
  let finish!: (value: 'changed') => void;
  f.changingPassword(() => new Promise(resolve => { finish = resolve; }));
  const changing = f.changePassword(f.event, passwordChange());
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'busy' });
  assert.deepEqual(await f.page(), { status: 'busy' });
  assert.deepEqual(await f.detail(f.event, first.id), { status: 'busy' });
  assert.deepEqual(await f.save(f.event, { id: first.id, revision: selected.revision, notes: '', tags: [] }), { status: 'busy' });
  assert.deepEqual(await f.regenerate(f.event, { id: first.id, revision: selected.revision }), { status: 'busy' });
  assert.deepEqual(await f.protection(f.event), { status: 'busy' });
  assert.deepEqual(await f.setProtection(f.event, { autoLockMinutes: 1 }), { status: 'busy' });
  f.cancel(); f.lock(); assert.equal(f.locks(), 1);
  finish('changed');
  assert.deepEqual(await changing, { status: 'unavailable' });
});

test('existing gallery reads, saves and regeneration exclude credential admission', async t => {
  const f = await sourceFixture(t);
  let calls = 0;
  f.changingPassword(async () => { calls++; return 'changed'; });
  let finishRead!: (value: { autoLockMinutes: 5 }) => void;
  f.readProtection(() => new Promise(resolve => { finishRead = resolve; }));
  const reading = f.protection(f.event);
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'busy' });
  finishRead({ autoLockMinutes: 5 }); await reading;
  let finishWrite!: (value: { autoLockMinutes: 1 }) => void;
  f.writeProtection(() => new Promise(resolve => { finishWrite = resolve; }));
  const saving = f.setProtection(f.event, { autoLockMinutes: 1 });
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'busy' });
  finishWrite({ autoLockMinutes: 1 }); await saving;
  let finishPick!: (value: undefined) => void;
  f.choose(() => new Promise(resolve => { finishPick = resolve; }));
  const generating = f.run();
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'busy' });
  await new Promise(resolve => setImmediate(resolve));
  finishPick(undefined); await generating;
  assert.equal(calls, 0);
});

for (const ending of ['lock', 'dispose', 'abort', 'replace-frame', 'navigate', 'stale']) {
  test(`credential work drains and late completion is suppressed after ${ending}`, async t => {
    const f = fixture(t);
    let authority!: () => boolean;
    let finish!: (value: 'changed') => void;
    f.changingPassword((_generation, _value, current) => {
      authority = current;
      return new Promise(resolve => { finish = resolve; });
    });
    const changing = f.changePassword(f.event, passwordChange());
    await Promise.resolve();
    assert.equal(authority(), true);
    if (ending === 'lock') { f.lock(); }
    if (ending === 'dispose') { void f.dispose(); }
    if (ending === 'abort') { f.controller.abort(); }
    if (ending === 'replace-frame') { f.contents.mainFrame = new Contents().mainFrame; }
    if (ending === 'navigate') { f.contents.emit('did-start-navigation', { isMainFrame: true, url: ENTRY }); }
    if (ending === 'stale') { f.stale(); }
    assert.equal(authority(), false);
    let drained = false;
    const disposal = f.dispose().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false, 'Disposal must await admitted credential work');
    finish('changed');
    assert.deepEqual(await changing, { status: 'unavailable' });
    await disposal; assert.equal(drained, true);
  });
}

test('successful password changes revoke before lock callback reentry and disposal never deadlocks', async t => {
  const f = fixture(t);
  let late!: Promise<unknown>, drain!: Promise<void>;
  let called = false;
  f.lockAction(() => {
    called = true;
    late = f.changePassword(f.event, passwordChange());
    drain = f.dispose();
  });
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'changed' });
  assert.equal(called, true); assert.equal(f.hubLocks(), 1);
  assert.equal(f.options.hub.isCurrent(7), false);
  assert.deepEqual(await late, { status: 'unavailable' });
  await drain;
  assert.deepEqual(await f.page(), { status: 'unavailable' });
});

test('credential drainage is already installed when the session synchronously revokes ownership', async t => {
  const f = fixture(t);
  let finish!: (value: 'changed') => void;
  let disposal!: Promise<void>, drained = false;
  f.changingPassword(() => {
    disposal = f.dispose().then(() => { drained = true; });
    return new Promise(resolve => { finish = resolve; });
  });
  const changing = f.changePassword(f.event, passwordChange());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  finish('changed');
  assert.deepEqual(await changing, { status: 'unavailable' });
  await disposal;
});

test('revocation before deferred credential admission performs no credential work', async t => {
  const f = fixture(t);
  f.changingPassword(async () => { assert.fail('Revoked credentials must not reach storage'); });
  const changing = f.changePassword(f.event, passwordChange());
  f.lock();
  assert.deepEqual(await changing, { status: 'unavailable' });
});

test('credential exceptions and malformed session success stay generic and never lock as a success', async t => {
  const f = fixture(t);
  f.changingPassword(async () => { throw new Error('/private/current and replacement passwords'); });
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'unavailable' });
  f.changingPassword(async () => ({ status: 'changed' }) as any);
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'unavailable' });
  assert.equal(f.locks(), 0);
});


test('credential success locks keys before a throwing browser observer and quarantines cleanup', async t => {
  const f = fixture(t); f.expectQuarantinedDisposal();
  f.lockAction(() => {
    assert.equal(f.options.hub.isCurrent(7), false);
    assert.equal(f.controller.signal.aborted, true);
    throw new Error('Browser cleanup failed before it could lock storage');
  });
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'unavailable' });
  assert.equal(f.hubLocks(), 1);
  assert.equal(f.options.hub.isCurrent(7), false);
  await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
});

test('credential success awaits independent hub drainage while browser disposal waits for credentials', async t => {
  const f = fixture(t);
  let finish!: () => void, observed = false, drained = false;
  let disposal!: Promise<void>;
  f.locking(() => {
    f.stale(); f.controller.abort();
    return new Promise(resolve => { finish = resolve; });
  });
  f.lockAction(() => { observed = true; disposal = f.dispose().then(() => { drained = true; }); });
  let returned = false;
  const changing = f.changePassword(f.event, passwordChange()).then(value => { returned = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed, true); assert.equal(returned, false); assert.equal(drained, false);
  finish();
  assert.deepEqual(await changing, { status: 'changed' });
  await disposal; assert.equal(drained, true);
});

for (const failure of ['throw', 'reject', 'still-current']) {
  test(`credential success quarantines an independent hub lock failure: ${failure}`, async t => {
    const f = fixture(t); f.expectQuarantinedDisposal();
    f.locking(() => {
      if (failure === 'throw') { throw new Error('Private lock diagnostics'); }
      if (failure === 'reject') { f.stale(); return Promise.reject(new Error('Private drain diagnostics')); }
      return Promise.resolve();
    });
    assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'unavailable' });
    assert.equal(f.hubLocks(), 1); assert.equal(f.locks(), 1, 'Browser cleanup must still be attempted');
    assert.deepEqual(await f.page(), { status: 'unavailable' });
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  });
}

test('unexpected async browser observer cannot create a disposal cycle or unhandled rejection', async t => {
  const f = fixture(t); f.expectQuarantinedDisposal();
  let disposal!: Promise<void>;
  f.lockAction(() => { disposal = f.dispose(); return disposal; });
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'unavailable' });
  assert.equal(f.options.hub.isCurrent(7), false);
  await assert.rejects(disposal, /Private gallery cleanup unavailable/);
  await new Promise(resolve => setImmediate(resolve));
});

test('credential retry response is discarded when revoked between work and handler continuations', async t => {
  const f = fixture(t);
  let completed = false, scheduled = false;
  const isCurrent = f.options.hub.isCurrent.bind(f.options.hub);
  t.mock.method(f.options.hub, 'isCurrent', (generation: number) => {
    const result = isCurrent(generation);
    if (completed && !scheduled) {
      scheduled = true;
      queueMicrotask(() => { f.stale(); });
    }
    return result;
  });
  f.changingPassword(async () => { completed = true; return 'incorrect-password'; });
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'unavailable' });
  assert.equal(scheduled, true); assert.equal(f.hubLocks(), 0);
});


const plaintextCopy = () => ({ password: 'Synthetic source password', acknowledge: true });

test('unprotected copy requires an exact acknowledged credential and native destination capability', async t => {
  const f = fixture(t); let calls = 0, reads = 0;
  f.copying(async () => { calls++; return 'copied'; });
  const accessor = { get password() { reads++; throw new Error('private'); }, acknowledge: true };
  const hidden = Object.defineProperty(plaintextCopy(), 'hidden', { value: 'private' });
  for (const args of [[], [null], [[]], [{}], [plaintextCopy(), 'extra'], [accessor], [hidden],
    [{ ...plaintextCopy(), [Symbol('extra')]: 'private' }], [Object.create(plaintextCopy())],
    [{ ...plaintextCopy(), destination: '/secret' }], [{ password: '', acknowledge: true }],
    [{ password: 'é'.repeat(513), acknowledge: true }], [{ password: '\ud800', acknowledge: true }],
    [{ password: 'valid', acknowledge: false }], [{ password: 'valid', acknowledge: 'true' }]]) {
    assert.deepEqual(await f.createUnprotectedCopy(f.event, ...args), { status: 'invalid' });
  }
  assert.equal(calls, 0); assert.equal(reads, 0);
  await f.dispose();
  const missing = fixture(t, undefined, ENTRY, undefined, null);
  missing.copying(async () => { assert.fail('No picker means no export authority'); });
  assert.deepEqual(await missing.createUnprotectedCopy(missing.event, plaintextCopy()), { status: 'unavailable' });
  await missing.dispose();
});

test('unprotected copy requires the exact current main frame before seeing credentials or choosing a folder', async t => {
  const f = fixture(t); const other = new Contents();
  let calls = 0; f.copying(async () => { calls++; return 'copied'; });
  for (const event of [null, {}, { sender: other, senderFrame: f.contents.mainFrame },
    { sender: f.contents, senderFrame: other.mainFrame }, { sender: f.contents, senderFrame: null }]) {
    assert.deepEqual(await f.createUnprotectedCopy(event, plaintextCopy()), { status: 'unavailable' });
    ipcMain.emit(channels.cancelUnprotectedCopy, event);
  }
  f.contents.mainFrame.detached = true;
  assert.equal((await f.createUnprotectedCopy(f.event, plaintextCopy())).status, 'unavailable');
  assert.equal(calls, 0);
});

test('unprotected copy snapshots and clears credentials immediately while exposing no selected path', async t => {
  const f = fixture(t); let seen: any, copied: unknown;
  let finish!: (value: 'copied') => void;
  f.copying((_generation, value, current, options) => {
    assert.equal(_generation, 7); assert.equal(current(), true); assert.equal(options.signal.aborted, false);
    seen = value; copied = { ...(value as object) };
    return new Promise(resolve => { finish = resolve; });
  });
  const caller = plaintextCopy();
  const copying = f.createUnprotectedCopy(f.event, caller);
  caller.password = 'caller changed password';
  await Promise.resolve();
  assert.deepEqual(copied, plaintextCopy()); assert.deepEqual(seen, { password: '', acknowledge: true });
  assert.equal(caller.password, 'caller changed password');
  finish('copied'); assert.deepEqual(await copying, { status: 'copied' });
  assert.equal(f.hubLocks(), 0); assert.equal(f.locks(), 0);
  assert.equal((await f.page()).status, 'ready', 'Source remains unlocked and usable after a copy');
});

test('copy status responses remain bounded and ordinary failures permit retry without locking', async t => {
  const f = fixture(t);
  for (const status of ['copied', 'incorrect-password', 'cancelled', 'failed'] as const) {
    f.copying(async () => status);
    assert.deepEqual(await f.createUnprotectedCopy(f.event, plaintextCopy()), { status });
  }
  f.copying(async () => ({ status: 'copied', path: '/secret' }) as any);
  assert.deepEqual(await f.createUnprotectedCopy(f.event, plaintextCopy()), { status: 'unavailable' });
  f.copying(async () => { throw new Error('/secret source and destination'); });
  assert.deepEqual(await f.createUnprotectedCopy(f.event, plaintextCopy()), { status: 'failed' });
  assert.equal(f.hubLocks(), 0); assert.equal(f.locks(), 0);
});

test('pending copy gates gallery and credential work while cancellation remains one-shot and holds admission', async t => {
  const f = fixture(t); const selected = (await f.page()).items[0];
  const detail = (await f.detail(f.event, selected.id)).item;
  let finish!: (value: 'copied') => void, aborts = 0;
  let authority!: () => boolean;
  f.copying((_generation, _value, current, options) => {
    authority = current; options.signal.addEventListener('abort', () => { aborts++; });
    return new Promise(resolve => { finish = resolve; });
  });
  f.cancelCopy();
  const copying = f.createUnprotectedCopy(f.event, plaintextCopy());
  assert.deepEqual(await f.createUnprotectedCopy(f.event, plaintextCopy()), { status: 'busy' });
  assert.deepEqual(await f.changePassword(f.event, passwordChange()), { status: 'busy' });
  assert.deepEqual(await f.page(), { status: 'busy' });
  assert.deepEqual(await f.detail(f.event, selected.id), { status: 'busy' });
  assert.deepEqual(await f.save(f.event, { id: selected.id, revision: detail.revision, notes: '', tags: [] }), { status: 'busy' });
  assert.deepEqual(await f.regenerate(f.event, { id: selected.id, revision: detail.revision }), { status: 'busy' });
  assert.deepEqual(await f.protection(f.event), { status: 'busy' });
  assert.deepEqual(await f.setProtection(f.event, { autoLockMinutes: 1 }), { status: 'busy' });
  f.cancel(); assert.equal(aborts, 0);
  f.cancelCopy('extra'); assert.equal(aborts, 0);
  ipcMain.emit(channels.cancelUnprotectedCopy, { ...f.event, senderFrame: new Contents().mainFrame });
  assert.equal(aborts, 0); f.cancelCopy(); f.cancelCopy();
  assert.equal(aborts, 1); assert.equal(authority(), false);
  assert.deepEqual(await f.protection(f.event), { status: 'busy' });
  finish('copied'); assert.deepEqual(await copying, { status: 'cancelled' });
  f.cancelCopy(); assert.equal(aborts, 1); assert.equal((await f.page()).status, 'ready');
});

for (const ending of ['cancel', 'lock', 'dispose', 'abort', 'replace-frame', 'navigate', 'stale']) {
  test(`late copy destination cannot grant a folder after ${ending}; disposal waits for copy work`, async t => {
    const f = fixture(t);
    let choose!: () => Promise<string | undefined>, authority!: () => boolean, copySignal!: AbortSignal;
    let finish!: (value: string) => void;
    let copyDone!: (value: 'copied') => void;
    f.chooseCopy(() => new Promise(resolve => { finish = resolve; }));
    f.copying((_generation, _value, current, options) => {
      choose = options.chooseDestination; authority = current; copySignal = options.signal;
      return new Promise(resolve => { copyDone = resolve; });
    });
    const copying = f.createUnprotectedCopy(f.event, plaintextCopy());
    await Promise.resolve();
    const picking = choose();
    if (ending === 'cancel') { f.cancelCopy(); }
    if (ending === 'lock') { f.lock(); }
    if (ending === 'dispose') { void f.dispose(); }
    if (ending === 'abort') { f.controller.abort(); }
    if (ending === 'replace-frame') { f.contents.mainFrame = new Contents().mainFrame; }
    if (ending === 'navigate') { f.contents.emit('did-start-navigation', { isMainFrame: true, url: ENTRY }); }
    if (ending === 'stale') { f.stale(); }
    assert.equal(authority(), false);
    finish('/secret selected directory');
    assert.equal(await picking, undefined);
    assert.equal(await choose(), undefined, 'A stale retry cannot reopen the native picker');
    let drained = false;
    const disposal = f.dispose().then(() => { drained = true; });
    assert.equal(copySignal.aborted, true);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    copyDone('copied'); assert.deepEqual(await copying, { status: 'unavailable' });
    await disposal; assert.equal(drained, true);
  });
}

test('copy drainage is installed before synchronous session reentry and late success is suppressed', async t => {
  const f = fixture(t); let disposal!: Promise<void>, finish!: (value: 'copied') => void, drained = false;
  f.copying(() => {
    disposal = f.dispose().then(() => { drained = true; });
    return new Promise(resolve => { finish = resolve; });
  });
  const copying = f.createUnprotectedCopy(f.event, plaintextCopy());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  finish('copied'); assert.deepEqual(await copying, { status: 'unavailable' }); await disposal;
});

test('copy completion is checked again between work and handler continuations', async t => {
  const f = fixture(t); let completed = false, scheduled = false;
  const isCurrent = f.options.hub.isCurrent.bind(f.options.hub);
  t.mock.method(f.options.hub, 'isCurrent', (generation: number) => {
    const result = isCurrent(generation);
    if (completed && !scheduled) { scheduled = true; queueMicrotask(() => { f.stale(); }); }
    return result;
  });
  f.copying(async () => { completed = true; return 'copied'; });
  assert.deepEqual(await f.createUnprotectedCopy(f.event, plaintextCopy()), { status: 'unavailable' });
});

test('existing protection and password work refuse unprotected copies and ignore unrelated cancellation', async t => {
  const f = fixture(t); let calls = 0;
  f.copying(async () => { calls++; return 'copied'; });
  let finishRead!: (value: { autoLockMinutes: 5 }) => void;
  f.readProtection(() => new Promise(resolve => { finishRead = resolve; }));
  const reading = f.protection(f.event);
  f.cancelCopy(); assert.deepEqual(await f.createUnprotectedCopy(f.event, plaintextCopy()), { status: 'busy' });
  finishRead({ autoLockMinutes: 5 }); await reading;
  let finishPassword!: (value: 'incorrect-password') => void;
  f.changingPassword(() => new Promise(resolve => { finishPassword = resolve; }));
  const changing = f.changePassword(f.event, passwordChange());
  f.cancelCopy(); assert.deepEqual(await f.createUnprotectedCopy(f.event, plaintextCopy()), { status: 'busy' });
  finishPassword('incorrect-password'); await changing;
  assert.equal(calls, 0);
});


async function trustedPlaintextCleanupFailure(t: TestContext): Promise<Error> {
  const root = await fs.mkdtemp(path.resolve(__dirname, '../tmp/gallery-copy-cleanup-'));
  const store = await PrivateHubStore.create(path.join(root, 'encrypted'), 'Synthetic test password');
  t.after(async () => { await store.lock(); await fs.rm(root, { recursive: true, force: true }); });
  const catalogue: FinalObject = { addTags: [], hubName: 'Synthetic copy', images: [], inputDirs: {}, numOfFolders: 0,
    removeTags: [], version: 3, screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 1, fixed: true, height: 144, n: 5 } };
  await store.writeRecord('catalogue', Buffer.from(JSON.stringify(catalogue)));
  const nativeFs: typeof import('node:fs/promises') = require('node:fs/promises');
  const open = nativeFs.open.bind(nativeFs);
  const mock = t.mock.method(nativeFs, 'open', async (...args: Parameters<typeof nativeFs.open>) => {
    const handle = await open(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(path.join(root, 'ordinary', '.catalogue-'))) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); throw new Error('Synthetic ambiguous close'); });
    }
    return handle;
  });
  try {
    try {
      await exportPrivateHubToPlaintext(store, { destinationDirectory: path.join(root, 'ordinary'), assertSourceQuiescent: () => undefined });
      assert.fail('The injected close failure must produce a trusted cleanup error');
    } catch (error) {
      assert.ok(isPrivateHubPlaintextExportCleanupFailure(error));
      return error;
    }
  } finally { mock.mock.restore(); }
}

for (const cancel of [false, true]) {
  test(`trusted copy cleanup failure permanently quarantines gallery disposal${cancel ? ' after cancellation' : ''}`, async t => {
    const failure = await trustedPlaintextCleanupFailure(t);
    const f = fixture(t); f.expectQuarantinedDisposal();
    let reject!: (reason: Error) => void;
    f.copying(() => new Promise((_resolve, no) => { reject = no; }));
    f.lockAction(() => { throw new Error('Private observer failure cannot remove quarantine'); });
    const copying = f.createUnprotectedCopy(f.event, plaintextCopy());
    await Promise.resolve();
    if (cancel) { f.cancelCopy(); }
    reject(failure);
    assert.deepEqual(await copying, { status: 'unavailable' });
    assert.deepEqual(await f.page(), { status: 'unavailable' });
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  });
}


test('copy picker cannot return a destination when authority checking synchronously cancels it', async t => {
  const f = fixture(t); let picked = false, cancelled = false;
  const isCurrent = f.options.hub.isCurrent.bind(f.options.hub);
  f.chooseCopy(async () => { picked = true; return '/synthetic destination'; });
  t.mock.method(f.options.hub, 'isCurrent', (generation: number) => {
    const result = isCurrent(generation);
    if (picked && !cancelled) { cancelled = true; f.cancelCopy(); }
    return result;
  });
  f.copying(async (_generation, _value, _current, options) => {
    assert.equal(await options.chooseDestination(), undefined);
    assert.equal(options.signal.aborted, true);
    return 'cancelled';
  });
  assert.deepEqual(await f.createUnprotectedCopy(f.event, plaintextCopy()), { status: 'cancelled' });
  assert.equal(cancelled, true);
});


test('Touch ID bridge projects only bounded state and consumes a snapshot of the enrollment password', async t => {
  const f = fixture(t);
  assert.deepEqual(await handlers.get(channels.touchIdStatus)!(f.event), { outcome: 'available', state: 'disabled' });
  let captured: any;
  t.mock.method(f.options.hub, 'enableTouchId', async (generation, value, current, signal) => {
    assert.equal(generation, 7); assert.equal(current(), true); assert.equal(signal.aborted, false);
    captured = value; assert.equal(captured.password, ' exact '); return 'enabled';
  });
  const original = { password: ' exact ' };
  assert.deepEqual(await handlers.get(channels.enableTouchId)!(f.event, original), { outcome: 'enabled' });
  assert.equal(captured.password, ''); assert.equal(original.password, ' exact ');
  assert.deepEqual(await handlers.get(channels.disableTouchId)!(f.event), { outcome: 'disabled' });
});

test('Touch ID bridge rejects foreign frames and accessor payloads without invoking native methods', async t => {
  const f = fixture(t); let reads = 0;
  const enable = t.mock.method(f.options.hub, 'enableTouchId', async () => { throw new Error('must not run'); });
  assert.deepEqual(await handlers.get(channels.enableTouchId)!({ ...f.event, senderFrame: { ...f.contents.mainFrame } }, { password: 'secret' }), { outcome: 'unavailable' });
  assert.deepEqual(await handlers.get(channels.enableTouchId)!(f.event, { get password() { reads++; return 'secret'; } }), { outcome: 'unavailable' });
  assert.deepEqual(await handlers.get(channels.disableTouchId)!(f.event, 'extra'), { outcome: 'unavailable' });
  assert.equal(reads, 0); assert.equal(enable.mock.callCount(), 0);
});

test('Touch ID bridge revokes native lifetime immediately and waits for late enrollment on disposal', async t => {
  const f = fixture(t); let release!: (value: 'enabled') => void; let signal!: AbortSignal;
  const gate = new Promise<'enabled'>(yes => { release = yes; });
  t.mock.method(f.options.hub, 'enableTouchId', async (_generation, _value, _current, owned) => { signal = owned; return gate; });
  const work = handlers.get(channels.enableTouchId)!(f.event, { password: 'secret' });
  await Promise.resolve();
  assert.deepEqual(await f.page(), { status: 'busy' });
  let drained = false; const disposal = f.dispose().then(() => { drained = true; });
  assert.equal(signal.aborted, true); await Promise.resolve(); assert.equal(drained, false);
  release('enabled'); assert.deepEqual(await work, { outcome: 'unavailable' }); await disposal;
});


test('source relocation saves only the reviewed location, expires every selection and requires explicit reconnection', async t => {
  const f = await relocationFixture(t);
  assert.equal((await f.connectSource(f.event, f.sourceId)).status, 'connected');
  const previous = f.catalogue();
  assert.deepEqual(await f.run(), { status: 'relocated' });
  assert.equal(f.picks(), 1); assert.equal(f.confirmations(), 1); assert.equal(f.writes(), 1);
  assert.deepEqual(f.catalogue().images, previous.images);
  assert.equal(f.catalogue().inputDirs[0].watch, true);
  assert.equal(f.catalogue().inputDirs[0].path, f.nextRoot);
  assert.deepEqual(await f.detail(f.event, f.videoId), { status: 'unavailable' });
  assert.deepEqual(await f.connectSource(f.event, f.sourceId), { status: 'unavailable' });
  const next = (await f.sources(f.event)).items[0];
  assert.equal(next.connected, false); assert.notEqual(next.id, f.sourceId);
  assert.notEqual((await f.page()).items[0].id, f.videoId);
});

test('relocation rejects foreign frames, malformed IDs and missing native controls before opening a picker', async t => {
  const f = await relocationFixture(t);
  for (const args of [[], [null], [{}], [f.previousRoot], ['a'.repeat(32)], [f.sourceId, 'extra']]) {
    assert.deepEqual(await f.relocateSource(f.event, ...args), { status: 'unavailable' });
  }
  assert.deepEqual(await f.relocateSource({ ...f.event, senderFrame: { ...f.contents.mainFrame } }, f.sourceId), { status: 'unavailable' });
  const picker = f.options.chooseSourceLocation;
  f.options.chooseSourceLocation = undefined!;
  assert.deepEqual(await f.run(), { status: 'unavailable' });
  f.options.chooseSourceLocation = picker; f.options.confirmSourceLocation = undefined!;
  assert.deepEqual(await f.run(), { status: 'unavailable' });
  assert.equal(f.picks(), 0); assert.equal(f.writes(), 0);
});

for (const stage of ['picker', 'confirmation'] as const) {
  test(`relocation ${stage} cancellation preserves catalogue and drains late native results`, async t => {
    const f = await relocationFixture(t);
    let finish!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const held = async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); };
    if (stage === 'picker') { f.chooseLocation(async () => { await held(); return f.nextRoot; }); }
    else { f.confirmLocation(async () => { await held(); return true; }); }
    const work = f.run(); await ready;
    assert.deepEqual(await f.sources(f.event), { status: 'busy' });
    assert.deepEqual(await f.page(), { status: 'busy' });
    assert.deepEqual(await f.run(), { status: 'busy' });
    assert.deepEqual(await f.disconnectSource(f.event, f.sourceId), { status: 'busy' });
    f.cancelSource('extra');
    ipcMain.emit(channels.cancelSourceConnection, { ...f.event, senderFrame: { ...f.contents.mainFrame } });
    f.cancelSource(); finish();
    assert.deepEqual(await work, { status: 'cancelled' });
    assert.equal(f.writes(), 0); assert.equal(f.catalogue().inputDirs[0].path, f.previousRoot);
    assert.equal((await f.detail(f.event, f.videoId)).status, 'ready');
  });

  test(`relocation ${stage} drains on disposal and does not commit after its owner is revoked`, async t => {
    const f = await relocationFixture(t);
    let finish!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const held = async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); };
    if (stage === 'picker') { f.chooseLocation(async () => { await held(); return f.nextRoot; }); }
    else { f.confirmLocation(async () => { await held(); return true; }); }
    const work = f.run(); await ready;
    let disposed = false; const disposal = f.dispose().then(() => { disposed = true; });
    await Promise.resolve(); assert.equal(disposed, false); finish();
    assert.deepEqual(await work, { status: 'unavailable' }); await disposal;
    assert.equal(f.writes(), 0); assert.equal(f.confirmations(), 0);
  });
}

test('relocation detects changed source identity before and after the picker without confirming', async t => {
  const f = await relocationFixture(t);
  const original = f.catalogue();
  const changed = { ...original, inputDirs: { 0: { path: f.nextRoot, watch: true } } } as FinalObject;
  f.replaceCatalogue(changed);
  assert.deepEqual(await f.run(), { status: 'conflict' }); assert.equal(f.picks(), 0);
  f.replaceCatalogue(original);
  f.chooseLocation(async () => { f.replaceCatalogue(changed); return f.nextRoot; });
  assert.deepEqual(await f.run(), { status: 'conflict' });
  assert.equal(f.writes(), 0); assert.equal(f.confirmations(), 0);
});

test('relocation refuses unmatched files and native cancellation without changing grants or catalogue', async t => {
  const f = await relocationFixture(t);
  await f.connectSource(f.event, f.sourceId);
  f.chooseLocation(async () => undefined);
  assert.deepEqual(await f.run(), { status: 'cancelled' });
  f.chooseLocation(async () => f.nextRoot);
  f.confirmLocation(async () => false);
  assert.deepEqual(await f.run(), { status: 'cancelled' });
  f.confirmLocation(async () => { assert.fail('Mismatching source must not reach confirmation'); });
  await fs.writeFile(path.join(f.nextRoot, 'synthetic.mp4'), 'wrong size');
  assert.deepEqual(await f.run(), { status: 'source-unavailable' });
  assert.equal(f.writes(), 0); assert.equal((await f.sources(f.event)).items[0].connected, true);
});

test('relocation rejects late catalogue conflict and discards a cancelled successful publication while expiring IDs', async t => {
  const f = await relocationFixture(t);
  f.relocate(async () => ({ status: 'conflict' }));
  assert.deepEqual(await f.run(), { status: 'conflict' });
  assert.deepEqual(await f.detail(f.event, f.videoId), { status: 'unavailable' });
  const sourceId = (await f.sources(f.event)).items[0].id;
  f.relocate(async () => { f.cancelSource(); return { status: 'relocated' }; });
  assert.deepEqual(await f.relocateSource(f.event, sourceId), { status: 'cancelled' });
  assert.deepEqual(await f.detail(f.event, f.videoId), { status: 'unavailable' });
  assert.deepEqual(await f.connectSource(f.event, f.sourceId), { status: 'unavailable' });
});

test('relocation retires cached grants and IDs when publication succeeds but cancellation rejects completion', async t => {
  const f = await relocationFixture(t);
  await f.connectSource(f.event, f.sourceId);
  const original = f.catalogue();
  f.relocate(async (_generation, review) => {
    f.replaceCatalogue({ ...original, inputDirs: { 0: { ...original.inputDirs[0], path: review.newRoot } } });
    f.cancelSource();
    throw new Error('Synthetic rejected completion after publication');
  });
  assert.deepEqual(await f.run(), { status: 'cancelled' });
  assert.equal(f.catalogue().inputDirs[0].path, f.nextRoot);
  assert.deepEqual(await f.detail(f.event, f.videoId), { status: 'unavailable' });
  assert.deepEqual(await f.connectSource(f.event, f.sourceId), { status: 'unavailable' });
  assert.equal((await f.sources(f.event)).items[0].connected, false);
  // Restoring the former catalogue location must not revive its old session grant.
  f.replaceCatalogue(original);
  assert.equal((await f.sources(f.event)).items[0].connected, false);
});

test('relocation errors remain generic and helper review is disposed after a rejected storage operation', async t => {
  const f = await relocationFixture(t);
  let reviewed: import('./private-source-relocation').PrivateSourceRelocationReview | undefined;
  f.relocate(async (_generation, review) => { reviewed = review; throw new Error('/private/catalogue/path'); });
  assert.deepEqual(await f.run(), { status: 'source-unavailable' });
  assert.ok(reviewed); assert.equal(reviewed.isCurrent(), false);
  assert.equal(f.writes(), 0);
});

test('source folders return only generic labels, counts and opaque IDs without probing ungranted paths', async t => {
  const f = fixture(t);
  const catalogue = { images: [image(0), { ...image(1), locations: [
    { inputSource: 0, fileName: 'one.mp4', partialPath: '/' },
    { inputSource: 0, fileName: 'two.mp4', partialPath: '/' },
    { inputSource: 7, fileName: 'three.mp4', partialPath: '/' },
  ] }, { ...image(2), deleted: true }, { ...image(3), cleanName: '*FOLDER*' }], inputDirs: {
    0: { path: '/secret/source' }, 1: { path: '/' }, 2: { path: 'relative' }, 7: { path: '/other/source' },
  } } as unknown as FinalObject;
  f.read(async () => catalogue);
  const nativeFs: typeof import('node:fs') = require('node:fs');
  const stat = t.mock.method(nativeFs, 'lstatSync', () => { throw new Error('No source probes expected'); });
  const result = await f.sources(f.event);
  assert.equal(result.status, 'ready');
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item: any) => [item.title, item.videoCount, item.connected]),
    [['Source folder 1', 2, false], ['Source folder 2', 1, false]]);
  assert.match(result.items[0].id, /^[a-f0-9]{32}$/);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['connected', 'id', 'title', 'videoCount']);
  assert.doesNotMatch(JSON.stringify(result), /secret|other|inputDirs|inputSource|sourcePath|root|index|identity/);
  assert.deepEqual(await f.sources(f.event), result, 'IDs remain stable within one unchanged source table');
  assert.equal(stat.mock.callCount(), 0);
  assert.equal(f.edits.length, 0);
});

test('source actions require issued IDs, exact arguments and the active main frame', async t => {
  const f = await sourceFixture(t);
  const listed = await f.sources(f.event);
  const id = listed.items[0].id;
  const foreign = { sender: f.contents, senderFrame: { ...f.contents.mainFrame } };
  for (const action of [f.sources, f.connectSource, f.disconnectSource]) {
    assert.deepEqual(await action(foreign, id), { status: 'unavailable' });
  }
  for (const args of [[], ['/secret/path'], [{ id }], [id, 'extra'], ['f'.repeat(32)], [f.id]]) {
    assert.deepEqual(await f.connectSource(f.event, ...args), { status: 'unavailable' });
    assert.deepEqual(await f.disconnectSource(f.event, ...args), { status: 'unavailable' });
  }
  assert.deepEqual(await f.sources(f.event, undefined), { status: 'unavailable' });
  assert.equal(f.picks(), 0);
});

test('explicit source connection caches only the selected saved folder and disconnect revokes it', async t => {
  const f = await sourceFixture(t);
  const id = (await f.sources(f.event)).items[0].id;
  const connected = await f.connectSource(f.event, id);
  assert.deepEqual(connected, { status: 'connected', item: { id, title: 'Source folder 1', videoCount: 1, connected: true } });
  assert.equal(f.picks(), 1);
  assert.equal((await f.sources(f.event)).items[0].connected, true);
  assert.equal((await f.connectSource(f.event, id)).status, 'connected');
  assert.equal(f.picks(), 1);
  const disconnected = await f.disconnectSource(f.event, id);
  assert.equal(disconnected.status, 'disconnected'); assert.equal(disconnected.item.connected, false);
  assert.equal((await f.sources(f.event)).items[0].connected, false);
  assert.equal((await f.connectSource(f.event, id)).status, 'connected');
  assert.equal(f.picks(), 2);
  assert.equal(f.edits.length, 0);
});

test('connection uses the shared operation gate and cancellation ignores foreign and malformed messages', async t => {
  const f = await sourceFixture(t);
  const id = (await f.sources(f.event)).items[0].id;
  let finish!: (value: string) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.choose(() => { began(); return new Promise(resolve => { finish = resolve; }); });
  const connecting = f.connectSource(f.event, id);
  await started;
  const reads = f.reads();
  assert.deepEqual(await f.sources(f.event), { status: 'busy' });
  assert.deepEqual(await f.disconnectSource(f.event, id), { status: 'busy' });
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'busy' });
  assert.deepEqual(await f.protection(f.event), { status: 'busy' });
  assert.deepEqual(await f.page(), { status: 'busy' });
  assert.equal(f.reads(), reads);
  ipcMain.emit(channels.cancelSourceConnection, { sender: f.contents, senderFrame: { ...f.contents.mainFrame } });
  f.cancelSource('extra');
  finish(f.root);
  assert.equal((await connecting).status, 'connected');
});

for (const ending of ['cancel', 'lock', 'navigate', 'abort', 'dispose'] as const) {
  test(`late source selection after ${ending} cannot grant access and disposal drains its native picker`, async t => {
    const f = await sourceFixture(t);
    const id = (await f.sources(f.event)).items[0].id;
    let finish!: (value: string) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    f.choose(() => { began(); return new Promise(resolve => { finish = resolve; }); });
    const connecting = f.connectSource(f.event, id);
    await started;
    if (ending === 'cancel') { f.cancelSource(); }
    if (ending === 'lock') { f.lock(); }
    if (ending === 'navigate') { f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: ENTRY + '#new' }); }
    if (ending === 'abort') { f.controller.abort(); }
    let drained = false;
    const disposal = ending === 'cancel' ? undefined : f.dispose().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    finish(f.root);
    assert.deepEqual(await connecting, { status: ending === 'cancel' ? 'cancelled' : 'unavailable' });
    await disposal;
    if (ending === 'cancel') {
      assert.equal((await f.sources(f.event)).items[0].connected, false);
      f.choose(async () => f.root);
      assert.equal((await f.connectSource(f.event, id)).status, 'connected');
      assert.equal(f.picks(), 2, 'cancelled picker did not cache a grant');
    }
  });
}

test('changed saved source identity conflicts before selection and after a late native picker result', async t => {
  const f = await sourceFixture(t);
  const id = (await f.sources(f.event)).items[0].id;
  const original = { images: f.images, inputDirs: { 0: { path: f.root } } } as unknown as FinalObject;
  const changed = { images: f.images, inputDirs: { 0: { path: f.root + '-replaced' } } } as unknown as FinalObject;
  f.catalogue(changed);
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'conflict' });
  assert.equal(f.picks(), 0);
  f.catalogue(original);
  f.choose(async () => { f.catalogue(changed); return f.root; });
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'conflict' });
  f.catalogue(original);
  assert.equal((await f.sources(f.event)).items[0].connected, false, 'conflicting late grant was revoked');
  f.choose(async () => f.root);
  assert.equal((await f.connectSource(f.event, id)).status, 'connected');
  assert.equal(f.picks(), 2);
  f.catalogue(changed);
  const replacement = (await f.sources(f.event)).items[0];
  assert.notEqual(replacement.id, id);
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'unavailable' });
});

test('source enumeration bounds the saved table and catalogue and never launches native selection', async t => {
  const f = fixture(t);
  for (const catalogue of [
    { images: [], inputDirs: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [i, { path: `/saved/${i}` }])) },
    { images: Array(100_001), inputDirs: {} },
  ]) {
    f.read(async () => catalogue as FinalObject);
    assert.deepEqual(await f.sources(f.event), { status: 'unavailable' });
  }
});

test('source selection reports cancellation, wrong folder and missing folder without native diagnostics', async t => {
  const f = await sourceFixture(t);
  const id = (await f.sources(f.event)).items[0].id;
  f.choose(async () => undefined);
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'cancelled' });
  f.choose(async () => f.root + '-other');
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'wrong-folder' });
  f.choose(async () => { throw new Error('/secret/native/path'); });
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'unavailable' });
  f.choose(async () => f.root);
  await fs.rm(f.root, { recursive: true, force: true });
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'source-unavailable' });
});


test('duplicate saved roots share connection state and regeneration uses an explicit source grant', async t => {
  const f = await sourceFixture(t);
  f.catalogue({ images: f.images, inputDirs: { 0: { path: f.root }, 3: { path: f.root } } } as unknown as FinalObject);
  const listed = await f.sources(f.event);
  assert.equal(listed.items.length, 2);
  await f.connectSource(f.event, listed.items[0].id);
  assert.deepEqual((await f.sources(f.event)).items.map((item: any) => item.connected), [true, true]);
  assert.equal((await f.run()).status, 'generated');
  assert.equal(f.picks(), 1, 'regeneration reused the explicitly connected source');
  await f.disconnectSource(f.event, listed.items[1].id);
  assert.deepEqual((await f.sources(f.event)).items.map((item: any) => item.connected), [false, false]);
});

test('cancelling during post-picker catalogue verification revokes a grant before another action can reuse it', async t => {
  const f = await sourceFixture(t);
  const id = (await f.sources(f.event)).items[0].id;
  const catalogue = { images: f.images, inputDirs: { 0: { path: f.root } } } as unknown as FinalObject;
  f.choose(async () => {
    f.read(async () => { f.cancelSource(); return catalogue; });
    return f.root;
  });
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'cancelled' });
  f.read(async () => catalogue);
  assert.equal((await f.sources(f.event)).items[0].connected, false);
  f.choose(async () => f.root);
  assert.equal((await f.connectSource(f.event, id)).status, 'connected');
  assert.equal(f.picks(), 2);
});

test('source methods do not read catalogues while another private operation owns the gate', async t => {
  const f = await sourceFixture(t);
  const id = (await f.sources(f.event)).items[0].id;
  let finish!: () => void;
  f.readProtection(() => new Promise(resolve => { finish = () => resolve({ autoLockMinutes: 5 }); }));
  const operation = f.protection(f.event);
  const reads = f.reads();
  assert.deepEqual(await f.sources(f.event), { status: 'busy' });
  assert.deepEqual(await f.connectSource(f.event, id), { status: 'busy' });
  assert.deepEqual(await f.disconnectSource(f.event, id), { status: 'busy' });
  assert.equal(f.reads(), reads); assert.equal(f.picks(), 0);
  finish(); await operation;
});


async function playbackFixture(t: TestContext) {
  const playback = new PrivateSourcePlayback({ signal: new AbortController().signal,
    isCurrent: () => true, onFailure: () => undefined });
  const f = await sourceFixture(t, playback);
  return { ...f, playback, play: (revision = f.item.revision) => f.playOriginal(f.event, { id: f.id, revision }),
    response: (url: string) => playback.createResponse(new Request(url)) };
}

test('original playback grants only the saved source and returns an opaque URL without catalogue writes', async t => {
  const f = await playbackFixture(t);
  assert.equal(f.item.playable, true);
  const before = JSON.stringify(f.images);
  const result = await f.play();
  assert.equal(result.status, 'ready'); assert.match(result.url, /^theatrum:\/\/app\/original\/[a-f0-9]{64}$/);
  assert.equal(await (await f.response(result.url)).text(), 'Synthetic source descriptor contents');
  assert.doesNotMatch(JSON.stringify(result), /synthetic|gallery-source|fileName|partialPath|inputSource|hash-/);
  assert.equal(JSON.stringify(f.images), before); assert.equal(f.edits.length, 0); assert.equal(f.picks(), 1);
  f.stopOriginal();
  assert.equal((await f.response(result.url)).status, 404, 'stop retires capability synchronously');
  assert.equal((await f.play()).status, 'ready'); assert.equal(f.picks(), 1, 'session source grant can be reused');
});

async function deliveredPlayback(f: Awaited<ReturnType<typeof playbackFixture>>) {
  const ready = await f.play();
  assert.equal(ready.status, 'ready');
  assert.equal(await (await f.response(ready.url)).text(), 'Synthetic source descriptor contents');
  return ready.url as string;
}

async function enableHistory(f: Awaited<ReturnType<typeof playbackFixture>>) {
  assert.equal((await f.setProtection(f.event, { autoLockMinutes: 5, recordPlaybackHistory: true })).status, 'saved');
}

test('private playback history stays disabled until enabled and does not change existing metrics', async t => {
  const f = await playbackFixture(t);
  const before = JSON.stringify(f.images);
  const url = await deliveredPlayback(f);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'disabled' });
  assert.equal(f.historyWrites.length, 1); assert.equal(f.edits.length, 0);
  assert.equal(JSON.stringify(f.images), before);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'ignored' });
  assert.equal(f.historyWrites.length, 1); assert.equal(f.appliedProtection.length, 0);
});

test('ready tokens and HEAD or GET traffic alone never record playback', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const ready = await f.play();
  assert.equal(ready.status, 'ready'); assert.equal(f.historyWrites.length, 0);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, ready.url), { status: 'ignored' });
  const head = await f.playback.createResponse(new Request(ready.url, { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.deepEqual(await f.ackOriginalPlayback(f.event, ready.url), { status: 'ignored' });
  assert.equal(await (await f.response(ready.url)).text(), 'Synthetic source descriptor contents');
  assert.equal(f.historyWrites.length, 0);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, ready.url), { status: 'recorded' });
  assert.equal(f.historyWrites.length, 1);
});

test('acknowledgement rejects renderer metadata, non-original URLs and wrong frames without catalogue access', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const url = await deliveredPlayback(f); const reads = f.reads();
  for (const args of [[], [null], [{}], [[url]], [url, 123], [url, { timesPlayed: 100 }],
    [{ url, playedAt: 123 }], ['file:///private.mp4'], [f.item.clipUrl], [url + '?time=1']]) {
    assert.deepEqual(await f.ackOriginalPlayback(f.event, ...args), { status: 'invalid' });
  }
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: null },
    { ...f.event, senderFrame: { ...f.contents.mainFrame } },
    { ...f.event, senderFrame: { ...f.contents.mainFrame, parent: f.contents.mainFrame } }]) {
    assert.deepEqual(await f.ackOriginalPlayback(event, url), { status: 'unavailable' });
  }
  assert.deepEqual(await f.ackOriginalPlayback(f.event, 'theatrum://app/original/' + 'a'.repeat(64)), { status: 'ignored' });
  assert.equal(f.reads(), reads); assert.equal(f.historyWrites.length, 0); assert.equal(f.picks(), 1);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'recorded' });
});

test('playback records the main clock exactly once per active original token and never renews idle protection', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const instant = 1_790_000_123_456;
  t.mock.method(Date, 'now', () => instant);
  const beforeCount = f.images[0].timesPlayed ?? 0;
  const url = await deliveredPlayback(f);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'recorded' });
  assert.equal(f.images[0].lastPlayed, instant); assert.equal(f.images[0].timesPlayed, beforeCount + 1);
  assert.deepEqual(f.historyWrites[0], { index: 0, revision: privateVideoRevision({ ...f.images[0],
    lastPlayed: 0, timesPlayed: beforeCount }), playedAt: instant });
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'ignored' });
  assert.equal((await f.response(url)).status, 200, 'acknowledgement does not retire the video');
  const next = await deliveredPlayback(f);
  assert.notEqual(next, url);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'ignored' });
  assert.deepEqual(await f.ackOriginalPlayback(f.event, next), { status: 'recorded' });
  assert.equal(f.images[0].timesPlayed, beforeCount + 2); assert.equal(f.historyWrites.length, 2);
  assert.equal(f.appliedProtection.length, 1, 'only the explicit settings save affects idle protection');
  assert.equal(f.locks(), 0); assert.equal(f.hubLocks(), 0);
});

test('history advances the cached full-row CAS without invalidating a notes/rating draft or recent sorting', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const originalRevision = f.item.revision;
  const oldCount = f.images[0].timesPlayed ?? 0;
  const url = await deliveredPlayback(f);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'recorded' });
  const historyRevision = privateVideoRevision(f.images[0]);
  const recent = await f.list(f.event, { query: '', offset: 0, collection: 'recent', sort: 'last-played', direction: 'desc' });
  assert.equal(recent.status, 'ready'); assert.equal(recent.total, 1); assert.equal(recent.items[0].id, f.id);
  const detail = await f.detail(f.event, f.id);
  assert.equal(detail.item.revision, originalRevision);
  const saved = await f.save(f.event, { id: f.id, revision: originalRevision, notes: 'Uninterrupted draft', tags: ['History'], rating: 3 });
  assert.equal(saved.status, 'saved');
  assert.deepEqual(f.edits[0], { index: 0, revision: historyRevision, notes: 'Uninterrupted draft', tags: ['History'], rating: 3 });
  assert.equal(f.images[0].timesPlayed, oldCount + 1); assert.ok(f.images[0].lastPlayed! > 0);
});

test('turning history off preserves previously recorded metrics and stops later increments', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const first = await deliveredPlayback(f);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, first), { status: 'recorded' });
  const before = JSON.stringify(f.images);
  assert.equal((await f.setProtection(f.event, { autoLockMinutes: 5, recordPlaybackHistory: false })).status, 'saved');
  const next = await deliveredPlayback(f);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, next), { status: 'disabled' });
  assert.equal(JSON.stringify(f.images), before);
  assert.deepEqual(await f.ackOriginalPlayback(f.event, first), { status: 'ignored' });
  assert.equal(f.historyWrites.length, 2);
});

for (const outcome of ['disabled', 'conflict', 'invalid', 'busy', 'throw'] as const) {
  test(`a ${outcome} history outcome consumes its acknowledgement without retry`, async t => {
    const f = await playbackFixture(t); await enableHistory(f);
    const url = await deliveredPlayback(f); const before = JSON.stringify(f.images);
    f.recording(async () => { if (outcome === 'throw') { throw new Error('Sensitive storage detail'); }
      return { status: outcome }; });
    assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: outcome === 'throw' ? 'unavailable' : outcome });
    assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'ignored' });
    assert.equal(f.historyWrites.length, 1); assert.equal(JSON.stringify(f.images), before);
  });
}

test('an external row edit conflicts with playback history and is not hidden by cache advancement', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const url = await deliveredPlayback(f);
  f.images[0].notes = 'Concurrent external change';
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'conflict' });
  assert.equal(f.images[0].notes, 'Concurrent external change');
  assert.deepEqual(await f.save(f.event, { id: f.id, revision: f.item.revision, notes: 'Stale draft', tags: [] }), { status: 'conflict' });
});

for (const ending of ['stop', 'source-replacement', 'file-replacement', 'frame-replacement'] as const) {
  test(`a delivered original cannot be acknowledged after ${ending}`, async t => {
    const f = await playbackFixture(t); await enableHistory(f);
    const url = await deliveredPlayback(f);
    if (ending === 'stop') { f.stopOriginal(); }
    else if (ending === 'frame-replacement') { f.contents.mainFrame = { ...f.contents.mainFrame }; }
    else if (ending === 'source-replacement') {
      const previous = f.root + '-original'; await fs.rename(f.root, previous);
      t.after(() => fs.rm(previous, { recursive: true, force: true }));
      await fs.mkdir(f.root); await fs.writeFile(path.join(f.root, 'synthetic.mp4'), 'Replacement');
    } else {
      await fs.rename(path.join(f.root, 'synthetic.mp4'), path.join(f.root, 'previous.mp4'));
      await fs.writeFile(path.join(f.root, 'synthetic.mp4'), 'Replacement');
    }
    assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: ending === 'frame-replacement' ? 'unavailable' : 'ignored' });
    assert.equal(f.historyWrites.length, 0);
  });
}

test('Stop preserves an already admitted playback fact and a subsequent draft saves after drainage', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const url = await deliveredPlayback(f);
  let finish!: () => void; let began!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; });
  f.recording(async (_generation, request, current) => {
    began(); await new Promise<void>(resolve => { finish = resolve; });
    assert.equal(current(), true, 'ordinary Stop does not invalidate admitted history');
    f.images[0] = { ...f.images[0], timesPlayed: 1, lastPlayed: request.playedAt };
    return { status: 'recorded', image: f.images[0] };
  });
  const work = f.ackOriginalPlayback(f.event, url); await ready;
  f.stopOriginal();
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'ignored' });
  assert.deepEqual(await f.save(f.event, { id: f.id, revision: f.item.revision, notes: 'Still a draft', tags: [] }), { status: 'busy' });
  assert.equal((await f.response(url)).status, 404);
  finish(); assert.deepEqual(await work, { status: 'recorded' });
  assert.equal((await f.save(f.event, { id: f.id, revision: f.item.revision, notes: 'Still a draft', tags: [] })).status, 'saved');
  assert.equal(f.images[0].timesPlayed, 1);
});

test('Stop in the same turn cannot cancel a playback fact admitted before session dispatch', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const url = await deliveredPlayback(f);
  const work = f.ackOriginalPlayback(f.event, url); f.stopOriginal();
  assert.deepEqual(await work, { status: 'recorded' }); assert.equal(f.historyWrites.length, 1);
});

for (const ending of ['lock', 'revocation', 'navigation', 'frame-replacement', 'dispose'] as const) {
  test(`${ending} revokes and drains an admitted history write`, async t => {
    const f = await playbackFixture(t); await enableHistory(f);
    const url = await deliveredPlayback(f);
    let finish!: () => void; let began!: () => void;
    let authority!: () => boolean;
    const ready = new Promise<void>(resolve => { began = resolve; });
    f.recording(async (_generation, _request, current) => {
      authority = current;
      began(); await new Promise<void>(resolve => { finish = resolve; });
      assert.equal(current(), false); throw new Error('Revoked');
    });
    const work = f.ackOriginalPlayback(f.event, url); await ready;
    if (ending === 'lock') { f.lock(); }
    if (ending === 'revocation') { f.controller.abort(); }
    if (ending === 'navigation') { f.contents.emit('did-start-navigation', { isMainFrame: true, url: ENTRY, isSameDocument: false }); }
    if (ending === 'frame-replacement') { f.contents.mainFrame = { ...f.contents.mainFrame }; }
    if (ending !== 'dispose') { assert.equal(authority(), false, 'each boundary independently revokes publication'); }
    let disposed = false;
    const disposal = f.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(disposed, false);
    finish(); assert.deepEqual(await work, { status: 'unavailable' }); await disposal;
    assert.equal(disposed, true); assert.equal(f.historyWrites.length, 1);
  });
}

test('history drainage is registered before a session callback synchronously disposes the bridge', async t => {
  const f = await playbackFixture(t); await enableHistory(f);
  const url = await deliveredPlayback(f);
  let disposal!: Promise<void>; let disposed = false; let finish!: () => void;
  f.recording(async (_generation, _request, current) => {
    disposal = f.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => { finish = resolve; });
    assert.equal(current(), false); return { status: 'disabled' };
  });
  const work = f.ackOriginalPlayback(f.event, url);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  finish(); assert.deepEqual(await work, { status: 'unavailable' }); await disposal;
  assert.equal(disposed, true);
});

test('duplicate preview hashes and absent strip geometry do not disable original playback', async t => {
  const f = await playbackFixture(t);
  f.images[0].screens = 0;
  f.images.push({ ...f.images[0], cleanName: 'Duplicate hash', fileName: 'other.mp4' });
  const item = (await f.detail(f.event, f.id)).item;
  assert.equal(item.regenerable, false); assert.equal(item.playable, true);
  assert.equal((await f.play(item.revision)).status, 'ready');
});

test('unsupported original containers return a fixed status without probing or prompting', async t => {
  const f = await playbackFixture(t);
  f.images[0].fileName = 'synthetic.mkv';
  const page = await f.page();
  assert.deepEqual(await f.detail(f.event, page.items[0].id), { status: 'unavailable' }, 'old identity is retired');
  assert.deepEqual(await f.play(), { status: 'conflict' });
  assert.equal(f.picks(), 0);
  await f.dispose();
  const playback = new PrivateSourcePlayback({ signal: new AbortController().signal, isCurrent: () => true, onFailure: () => undefined });
  const fresh = fixture(t, f.images, ENTRY, async () => { assert.fail('unsupported sources never prompt'); }, undefined, playback);
  fresh.read(async () => ({ images: f.images, inputDirs: { 0: { path: f.root } } } as unknown as FinalObject));
  const id = (await fresh.page()).items[0].id;
  const item = (await fresh.detail(fresh.event, id)).item;
  assert.equal(item.playable, false);
  assert.deepEqual(await fresh.playOriginal(fresh.event, { id, revision: item.revision }), { status: 'unsupported' });
  await fresh.dispose();
});

test('original start rejects malformed requests and unissued IDs before source authority', async t => {
  const f = await playbackFixture(t);
  for (const value of [null, {}, { id: f.id, revision: f.item.revision, path: f.root },
    { id: 'f'.repeat(32), revision: f.item.revision }, { id: f.id, revision: 'bad' }]) {
    assert.deepEqual(await f.playOriginal(f.event, value), { status: 'unavailable' });
  }
  assert.deepEqual(await f.playOriginal({ ...f.event, senderFrame: { ...f.contents.mainFrame } },
    { id: f.id, revision: f.item.revision }), { status: 'unavailable' });
  assert.equal(f.picks(), 0);
  f.images[0].notes = 'Changed after review';
  assert.deepEqual(await f.play(), { status: 'conflict' }); assert.equal(f.picks(), 0);
});

test('cancel, wrong folder and unavailable original return bounded statuses', async t => {
  const f = await playbackFixture(t);
  f.choose(async () => undefined); assert.deepEqual(await f.play(), { status: 'cancelled' });
  f.choose(async () => path.dirname(f.root)); assert.deepEqual(await f.play(), { status: 'wrong-folder' });
  f.choose(async () => f.root);
  await fs.unlink(path.join(f.root, 'synthetic.mp4'));
  assert.deepEqual(await f.play(), { status: 'source-unavailable' });
});

for (const ending of ['stop', 'lock', 'dispose', 'abort', 'navigate', 'replace-frame']) {
  test(`an original source picker cannot resume playback after ${ending}`, async t => {
    const f = await playbackFixture(t);
    let finish!: (value: string) => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.choose(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const work = f.play(); await ready;
    assert.deepEqual(await f.page(), { status: 'busy' });
    assert.deepEqual(await f.play(), { status: 'busy' });
    let drain: Promise<void> | undefined;
    if (ending === 'stop') { f.stopOriginal(); }
    if (ending === 'lock') { f.lock(); }
    if (ending === 'dispose') { drain = f.dispose(); }
    if (ending === 'abort') { f.controller.abort(); }
    if (ending === 'navigate') { f.contents.emit('did-start-navigation', { isMainFrame: true, url: ENTRY }); }
    if (ending === 'replace-frame') { f.contents.mainFrame = new Contents().mainFrame; }
    let drained = false;
    if (drain) { void drain.then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false); }
    finish(f.root);
    assert.deepEqual(await work, { status: ending === 'stop' ? 'cancelled' : 'unavailable' });
    await drain;
    assert.equal((await f.response('theatrum://app/original/' + 'a'.repeat(64))).status, 404);
  });
}

test('untrusted or malformed stop cannot cancel an original picker', async t => {
  const f = await playbackFixture(t);
  f.choose(async () => {
    ipcMain.emit(channels.stopOriginal, { ...f.event, senderFrame: { ...f.contents.mainFrame } });
    f.stopOriginal('extra');
    return f.root;
  });
  assert.equal((await f.play()).status, 'ready');
});

for (const change of ['catalogue-source', 'catalogue-row']) {
  test(`original playback revalidates ${change} after its native picker`, async t => {
    const f = await playbackFixture(t);
    f.choose(async () => {
      if (change === 'catalogue-source') {
        f.catalogue({ images: f.images, inputDirs: { 0: { path: path.dirname(f.root) } } } as unknown as FinalObject);
      } else { f.images[0].notes = 'Updated while picker was open'; }
      return f.root;
    });
    assert.deepEqual(await f.play(), { status: 'conflict' });
  });
}

for (const operation of ['list', 'detail', 'sources', 'connect', 'disconnect', 'save', 'regenerate', 'protection', 'set-protection']) {
  test(`${operation} retires an original capability before its work`, async t => {
    const f = await playbackFixture(t);
    const source = (await f.sources(f.event)).items[0];
    const active = await f.play(); assert.equal(active.status, 'ready');
    let work: Promise<unknown>;
    if (operation === 'list') { work = f.page(); }
    else if (operation === 'detail') { work = f.detail(f.event, f.id); }
    else if (operation === 'sources') { work = f.sources(f.event); }
    else if (operation === 'connect') { work = f.connectSource(f.event, source.id); }
    else if (operation === 'disconnect') { work = f.disconnectSource(f.event, source.id); }
    else if (operation === 'save') { work = f.save(f.event, { id: f.id, revision: f.item.revision, notes: 'Updated', tags: [] }); }
    else if (operation === 'regenerate') { work = f.run(); }
    else if (operation === 'protection') { work = f.protection(f.event); }
    else { work = f.setProtection(f.event, { autoLockMinutes: 15 }); }
    await work;
    assert.equal((await f.response(active.url)).status, 404);
  });
}

test('source relocation retires an active original before the native location picker', async t => {
  const playback = new PrivateSourcePlayback({ signal: new AbortController().signal, isCurrent: () => true, onFailure: () => undefined });
  const f = await relocationFixture(t, playback);
  const item = (await f.detail(f.event, f.videoId)).item;
  const active = await f.playOriginal(f.event, { id: f.videoId, revision: item.revision });
  assert.equal(active.status, 'ready');
  f.chooseLocation(async () => {
    assert.equal((await playback.createResponse(new Request(active.url))).status, 404);
    return f.nextRoot;
  });
  assert.deepEqual(await f.run(), { status: 'relocated' });
});

test('replacement of a connected folder revokes active playback and requires a fresh grant', async t => {
  const f = await playbackFixture(t);
  const active = await f.play();
  const previous = f.root + '-original';
  await fs.rename(f.root, previous);
  t.after(() => fs.rm(previous, { recursive: true, force: true }));
  await fs.mkdir(f.root);
  await fs.writeFile(path.join(f.root, 'synthetic.mp4'), 'Replacement source');
  assert.equal((await f.response(active.url)).status, 404);
  const next = await f.play();
  assert.equal(next.status, 'ready'); assert.equal(f.picks(), 2);
  assert.equal(await (await f.response(next.url)).text(), 'Replacement source');
});

test('original descriptor cleanup failure quarantines the gallery and its disposer', async t => {
  const f = await playbackFixture(t);
  const restore = failSourceDescriptorClose(t, path.join(f.root, 'synthetic.mp4'));
  f.expectQuarantinedDisposal();
  try {
    assert.deepEqual(await f.play(), { status: 'unavailable' });
    assert.ok(f.locks() >= 1);
    assert.deepEqual(await f.page(), { status: 'unavailable' });
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  } finally { await restore(); }
});

test('playback manager cleanup rejection blocks source mutations and private gallery disposal', async t => {
  const f = await playbackFixture(t);
  const active = await f.play(); assert.equal(active.status, 'ready');
  const nativeStop = f.playback.stop.bind(f.playback);
  const mock = t.mock.method(f.playback, 'stop', () => {
    void nativeStop().catch(() => undefined);
    return Promise.reject(new Error('Private cleanup detail'));
  });
  f.expectQuarantinedDisposal();
  try {
    assert.deepEqual(await f.setProtection(f.event, { autoLockMinutes: 15 }), { status: 'unavailable' });
    assert.equal(f.appliedProtection.length, 0); assert.ok(f.locks() >= 1);
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  } finally { mock.mock.restore(); await nativeStop(); }
});


test('original requests never probe an ungranted source before the native picker accepts it', async t => {
  const f = await playbackFixture(t);
  const nativeFs: typeof import('node:fs') = require('node:fs');
  const stat = nativeFs.lstatSync;
  let approved = false; let probes = 0;
  t.mock.method(nativeFs, 'lstatSync', (...args: Parameters<typeof stat>) => {
    if (typeof args[0] === 'string' && args[0].startsWith(f.root)) {
      probes++; assert.equal(approved, true, 'native approval precedes source filesystem access');
    }
    return stat(...args);
  });
  f.choose(async () => { assert.equal(probes, 0); approved = true; return f.root; });
  assert.equal((await f.play()).status, 'ready'); assert.ok(probes > 0);
});

test('a late manager start cannot deliver its ready token after Stop, and disposal waits for it', async t => {
  const f = await playbackFixture(t);
  const start = f.playback.start.bind(f.playback);
  let finish!: () => void; let began!: (url: string) => void;
  const ready = new Promise<string>(resolve => { began = resolve; });
  t.mock.method(f.playback, 'start', async (...args) => {
    const url = await start(...args);
    began(url); await new Promise<void>(resolve => { finish = resolve; }); return url;
  });
  const work = f.play(); const url = await ready;
  f.stopOriginal();
  assert.equal((await f.response(url)).status, 404);
  let drained = false;
  const disposal = f.dispose().then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  finish();
  assert.deepEqual(await work, { status: 'unavailable' });
  await disposal;
});

test('source-affecting operations await the retired playback cleanup before writing', async t => {
  const f = await playbackFixture(t);
  const active = await f.play();
  const stop = f.playback.stop.bind(f.playback);
  let finish!: () => void;
  let calls = 0;
  const mock = t.mock.method(f.playback, 'stop', () => {
    const drain = stop();
    if (++calls !== 1) { return drain; }
    return drain.then(() => new Promise<void>(resolve => { finish = resolve; }));
  });
  const work = f.setProtection(f.event, { autoLockMinutes: 15 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.appliedProtection.length, 0);
  assert.equal((await f.response(active.url)).status, 404);
  assert.deepEqual(await f.page(), { status: 'busy' });
  finish();
  assert.equal((await work).status, 'saved'); assert.equal(f.appliedProtection.length, 1);
  mock.mock.restore();
});


function batchResult(total: number, imported: number, duplicates = 0, failed = 0,
  outcome: 'completed' | 'cancelled' | 'stopped' = 'completed') {
  return { status: 'finished', outcome, total, processed: imported + duplicates + failed, imported, duplicates, failed };
}

async function importFixture(t: TestContext, playback?: PrivateSourcePlayback) {
  const f = await sourceFixture(t, playback);
  const selected = path.join(f.root, 'new-video.mp4');
  await fs.writeFile(selected, 'Synthetic imported video');
  let picks = 0;
  f.chooseImport(async root => { assert.equal(root, f.root); picks++; return selected; });
  let writes = 0;
  let captured: import('./private-preview-source').PrivatePreviewSource | undefined;
  f.importing(async (_generation, source, location, options) => {
    writes++; captured = source;
    assert.equal(options.isCurrent(), true); assert.equal(source.isCurrent(), true);
    assert.equal(location.root, f.root); assert.equal(location.fileName, 'new-video.mp4');
    assert.equal(location.partialPath, ''); assert.match(location.hash, /^[a-f0-9]{64}$/);
    return { status: 'imported', index: 1 };
  });
  const sourceId = (await f.sources(f.event)).items[0].id;
  return { ...f, sourceId, selected, picks: () => picks, writes: () => writes, captured: () => captured,
    runImport: () => f.importVideo(f.event, sourceId) };
}

test('import uses native selected source authority, closes capture and retires cached catalogue IDs', async t => {
  const f = await importFixture(t);
  const result = await f.runImport();
  assert.deepEqual(result, batchResult(1, 1));
  assert.equal(f.picks(), 1); assert.equal(f.writes(), 1); assert.equal(f.captured()?.isCurrent(), false);
  assert.deepEqual(await f.detail(f.event, f.id), { status: 'unavailable' });
  assert.deepEqual(await f.connectSource(f.event, f.sourceId), { status: 'unavailable' });
  assert.notEqual((await f.page()).items[0].id, f.id);
  assert.doesNotMatch(JSON.stringify(result), /root|path|file|hash|index/);
});

test('import validates frame, ID, arity and native capability before picking', async t => {
  const f = await importFixture(t);
  for (const args of [[], ['bad'], [f.sourceId, 'extra'], [{ id: f.sourceId }], ['a'.repeat(32)]]) {
    assert.deepEqual(await f.importVideo(f.event, ...args), { status: 'unavailable' });
  }
  assert.deepEqual(await f.importVideo({ ...f.event, senderFrame: { ...f.contents.mainFrame } }, f.sourceId), { status: 'unavailable' });
  f.options.chooseImportVideo = undefined!;
  assert.deepEqual(await f.runImport(), { status: 'unavailable' });
  assert.equal(f.picks(), 0); assert.equal(f.writes(), 0);
});

for (const selected of ['relative.mp4', '/outside-synthetic-root/file.mp4', 'ROOT', 'PARENT', 'DOT', 'NUL']) {
  test(`import refuses ${selected} before source capture`, async t => {
    const f = await importFixture(t);
    const value = selected === 'ROOT' ? f.root : selected === 'PARENT' ? f.root + '/../outside.mp4'
      : selected === 'DOT' ? f.root + '/./new-video.mp4' : selected === 'NUL' ? f.selected + '\0' : selected;
    f.chooseImport(async () => value);
    assert.deepEqual(await f.runImport(), { status: 'invalid' }); assert.equal(f.writes(), 0);
  });
}

test('import rejects symlink sources without submitting a session write', async t => {
  const f = await importFixture(t);
  const link = path.join(f.root, 'linked.mp4'); await fs.symlink(f.selected, link);
  f.chooseImport(async () => link);
  assert.deepEqual(await f.runImport(), batchResult(1, 0, 0, 1)); assert.equal(f.writes(), 0);
});

test('import detects remapped source after native selection', async t => {
  const f = await importFixture(t);
  f.chooseImport(async () => {
    f.catalogue({ images: f.images, inputDirs: { 0: { path: f.root + '-changed', watch: false } } } as unknown as FinalObject);
    return f.selected;
  });
  assert.deepEqual(await f.runImport(), batchResult(1, 0, 0, 0, 'stopped')); assert.equal(f.writes(), 0);
});

for (const revoke of ['cancel', 'dispose', 'lock'] as const) {
  test(`import ${revoke} drains a late file picker without reading or publishing`, async t => {
    const f = await importFixture(t);
    let finish!: () => void; let start!: () => void;
    const ready = new Promise<void>(resolve => { start = resolve; });
    f.chooseImport(async () => { start(); await new Promise<void>(resolve => { finish = resolve; }); return f.selected; });
    const work = f.runImport(); await ready;
    assert.deepEqual(await f.page(), { status: 'busy' }); assert.deepEqual(await f.runImport(), { status: 'busy' });
    let drained = false; let disposal: Promise<void> | undefined;
    if (revoke === 'cancel') {
      f.cancelImport('extra');
      ipcMain.emit(channels.cancelImport, { ...f.event, senderFrame: { ...f.contents.mainFrame } });
      f.cancelImport();
    } else if (revoke === 'lock') { f.controller.abort(); }
    else { disposal = f.dispose().then(() => { drained = true; }); }
    await Promise.resolve(); assert.equal(drained, false); finish();
    assert.deepEqual(await work, { status: revoke === 'cancel' ? 'cancelled' : 'unavailable' });
    await disposal; assert.equal(f.writes(), 0);
  });
}

test('import cancellation after admitted publication expires old IDs and closes captured descriptors', async t => {
  const f = await importFixture(t);
  let captured: import('./private-preview-source').PrivatePreviewSource | undefined;
  f.importing(async (_generation, source) => { captured = source; f.cancelImport(); return { status: 'imported', index: 1 }; });
  assert.deepEqual(await f.runImport(), batchResult(1, 1, 0, 0, 'cancelled'));
  assert.equal(captured?.isCurrent(), false);
  assert.deepEqual(await f.detail(f.event, f.id), { status: 'unavailable' });
  assert.notEqual((await f.page()).items[0].id, f.id);
});

test('import failure stays generic, closes the capture and permits refreshed catalogue reads', async t => {
  const f = await importFixture(t);
  let captured: import('./private-preview-source').PrivatePreviewSource | undefined;
  f.importing(async (_generation, source) => { captured = source; throw new Error('/private/source/path'); });
  assert.deepEqual(await f.runImport(), batchResult(1, 0, 0, 1));
  assert.equal(captured?.isCurrent(), false); assert.equal((await f.page()).status, 'ready');
});

test('import retires active original playback before choosing a file', async t => {
  const playback = new PrivateSourcePlayback({ signal: new AbortController().signal, isCurrent: () => true, onFailure: () => undefined });
  const f = await importFixture(t, playback);
  const playing = await f.playOriginal(f.event, { id: f.id, revision: f.item.revision });
  assert.equal(playing.status, 'ready');
  f.chooseImport(async () => {
    assert.equal((await playback.createResponse(new Request(playing.url))).status, 404); return f.selected;
  });
  assert.deepEqual(await f.runImport(), batchResult(1, 1));
});


async function sourceAdditionFixture(t: TestContext, playback?: PrivateSourcePlayback) {
  const f = await sourceFixture(t, playback);
  const nextRoot = await fs.mkdtemp(path.resolve(__dirname, '../tmp/gallery-source-add-'));
  t.after(() => fs.rm(nextRoot, { recursive: true, force: true }));
  let catalogue = { images: f.images, inputDirs: { 0: { path: f.root, watch: true } } } as unknown as FinalObject;
  f.read(async () => catalogue);
  let picks = 0; let writes = 0;
  f.chooseNewSource(async () => { picks++; return nextRoot; });
  let captured: import('./private-source-addition').PrivateSourceAdditionReview | undefined;
  f.adding(async (_generation, review, current) => {
    assert.equal(current(), true); assert.equal(review.matchesCatalogue(catalogue), true);
    assert.equal(await review.validate(), true); assert.equal(review.newRoot, nextRoot);
    captured = review; writes++;
    catalogue = { ...catalogue, inputDirs: { ...catalogue.inputDirs, [review.sourceIndex]: { path: nextRoot, watch: false } } };
    return { status: 'added' };
  });
  const sourceId = (await f.sources(f.event)).items[0].id;
  return { ...f, nextRoot, sourceId, picks: () => picks, writes: () => writes, captured: () => captured,
    saved: () => catalogue, replace: (next: FinalObject) => { catalogue = next; }, runAdd: () => f.addSource(f.event) };
}

test('adding a source saves only its reviewed location, retires IDs and leaves it disconnected', async t => {
  const f = await sourceAdditionFixture(t);
  assert.deepEqual(await f.runAdd(), { status: 'added' });
  assert.equal(f.picks(), 1); assert.equal(f.writes(), 1); assert.equal(f.captured()?.isCurrent(), false);
  const result = await f.sources(f.event);
  assert.deepEqual(result.items.map((item: any) => [item.title, item.videoCount, item.connected]),
    [['Source folder 1', 1, false], ['Source folder 2', 0, false]]);
  assert.deepEqual(f.saved().inputDirs[1], { path: f.nextRoot, watch: false });
  assert.equal(f.saved().images.length, 1);
  assert.equal(f.picks(), 1, 'saving never invokes a separate access picker');
  assert.deepEqual(await f.detail(f.event, f.id), { status: 'unavailable' });
  assert.deepEqual(await f.connectSource(f.event, f.sourceId), { status: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /path|inputDirs|nextRoot|gallery-source-add/);
});

test('add source rejects extra arguments, foreign frames and missing native picker without reading or selecting', async t => {
  const f = await sourceAdditionFixture(t);
  const reads = f.reads();
  for (const args of [['arbitrary/path'], [{}], [undefined]]) {
    assert.deepEqual(await f.addSource(f.event, ...args), { status: 'unavailable' });
  }
  assert.deepEqual(await f.addSource({ ...f.event, senderFrame: { ...f.contents.mainFrame } }), { status: 'unavailable' });
  f.options.chooseNewSourceDirectory = undefined!;
  assert.deepEqual(await f.runAdd(), { status: 'unavailable' });
  assert.equal(f.picks(), 0); assert.equal(f.reads(), reads);
});

test('add source refuses duplicate, ancestor and descendant selections without catalogue writes', async t => {
  const f = await sourceAdditionFixture(t);
  for (const chosen of [f.root, path.dirname(f.root), path.join(f.root, 'child')]) {
    f.chooseNewSource(async () => chosen);
    assert.deepEqual(await f.runAdd(), { status: chosen === f.root ? 'duplicate' : 'invalid' });
  }
  assert.equal(f.writes(), 0);
});

test('add source refuses the source limit before native selection', async t => {
  const f = await sourceAdditionFixture(t);
  f.replace({ ...f.saved(), inputDirs: Object.fromEntries(Array.from({ length: 256 }, (_, index) =>
    [index, { path: f.root + '-' + index, watch: false }])) });
  assert.deepEqual(await f.runAdd(), { status: 'limit' }); assert.equal(f.picks(), 0); assert.equal(f.writes(), 0);
});

test('add source native cancellation and symlink refusal leave the catalogue unchanged', async t => {
  const f = await sourceAdditionFixture(t); const before = f.saved();
  f.chooseNewSource(async () => undefined);
  assert.deepEqual(await f.runAdd(), { status: 'cancelled' });
  const link = path.join(f.nextRoot, 'linked-root'); await fs.symlink(f.root, link);
  f.chooseNewSource(async () => link);
  const result = await f.runAdd();
  assert.equal(result.status, 'source-unavailable');
  assert.equal(f.saved(), before); assert.equal(f.writes(), 0);
});

for (const revoke of ['cancel', 'dispose', 'lock'] as const) {
  test(`add source ${revoke} drains late picker selection without creating catalogue authority`, async t => {
    const f = await sourceAdditionFixture(t);
    let finish!: () => void; let start!: () => void;
    const ready = new Promise<void>(resolve => { start = resolve; });
    f.chooseNewSource(async () => { start(); await new Promise<void>(resolve => { finish = resolve; }); return f.nextRoot; });
    const work = f.runAdd(); await ready;
    assert.deepEqual(await f.sources(f.event), { status: 'busy' }); assert.deepEqual(await f.runAdd(), { status: 'busy' });
    assert.deepEqual(await f.run(), { status: 'busy' });
    let disposal: Promise<void> | undefined; let drained = false;
    if (revoke === 'cancel') {
      f.cancelSource('extra');
      ipcMain.emit(channels.cancelSourceConnection, { ...f.event, senderFrame: { ...f.contents.mainFrame } });
      f.cancelSource();
    } else if (revoke === 'lock') { f.controller.abort(); }
    else { disposal = f.dispose().then(() => { drained = true; }); }
    await Promise.resolve(); assert.equal(drained, false); finish();
    assert.deepEqual(await work, { status: revoke === 'cancel' ? 'cancelled' : 'unavailable' });
    await disposal; assert.equal(f.writes(), 0);
  });
}

test('add source retires cached identities after a cancelled successful publication', async t => {
  const f = await sourceAdditionFixture(t);
  f.adding(async () => { f.cancelSource(); return { status: 'added' }; });
  assert.deepEqual(await f.runAdd(), { status: 'cancelled' });
  assert.deepEqual(await f.detail(f.event, f.id), { status: 'unavailable' });
  assert.notEqual((await f.page()).items[0].id, f.id);
});

test('add source errors are generic and dispose the main-owned review', async t => {
  const f = await sourceAdditionFixture(t);
  let review: import('./private-source-addition').PrivateSourceAdditionReview | undefined;
  f.adding(async (_generation, value) => { review = value; throw new Error('/sensitive/private/folder'); });
  assert.deepEqual(await f.runAdd(), { status: 'source-unavailable' });
  assert.equal(review?.isCurrent(), false); assert.equal((await f.page()).status, 'ready');
});

test('add source retires original playback before opening its native picker', async t => {
  const playback = new PrivateSourcePlayback({ signal: new AbortController().signal, isCurrent: () => true, onFailure: () => undefined });
  const f = await sourceAdditionFixture(t, playback);
  const playing = await f.playOriginal(f.event, { id: f.id, revision: f.item.revision });
  assert.equal(playing.status, 'ready');
  f.chooseNewSource(async () => {
    assert.equal((await playback.createResponse(new Request(playing.url))).status, 404); return f.nextRoot;
  });
  assert.deepEqual(await f.runAdd(), { status: 'added' });
});


test('adding a root never restores an old grant after main-owned catalogue replacement', async t => {
  const f = await sourceAdditionFixture(t);
  assert.equal((await f.connectSource(f.event, f.sourceId)).status, 'connected');
  f.replace({ ...f.saved(), images: [], inputDirs: {} });
  f.chooseNewSource(async () => f.root);
  f.adding(async (_generation, review) => {
    f.replace({ ...f.saved(), inputDirs: { [review.sourceIndex]: { path: review.newRoot, watch: false } } });
    return { status: 'added' };
  });
  assert.deepEqual(await f.runAdd(), { status: 'added' });
  const sources = await f.sources(f.event);
  assert.equal(sources.items.length, 1); assert.equal(sources.items[0].connected, false);
});

test('batch import serializes descriptor lifetimes and reports duplicates and per-file failures', async t => {
  const f = await importFixture(t);
  const failing = path.join(f.root, 'broken.mp4');
  const second = path.join(f.root, 'second.mp4');
  await fs.writeFile(failing, 'Synthetic invalid media'); await fs.writeFile(second, 'Synthetic video');
  f.chooseImport(async () => [f.selected, path.join(f.root, 'synthetic.mp4'), failing, second]);
  const seen: string[] = []; let previous: import('./private-preview-source').PrivatePreviewSource | undefined;
  f.importing(async (_generation, source, location) => {
    assert.equal(previous?.isCurrent() ?? false, false, 'previous descriptor is drained before next import');
    previous = source; seen.push(location.fileName);
    if (location.fileName === 'broken.mp4') { throw new Error('/PRIVATE-PATH'); }
    return { status: 'imported', index: seen.length };
  });
  const before = await fs.readFile(f.selected);
  const result = await f.runImport();
  assert.deepEqual(result, batchResult(4, 2, 1, 1));
  assert.deepEqual(seen, ['new-video.mp4', 'broken.mp4', 'second.mp4']);
  assert.equal(previous?.isCurrent(), false);
  assert.deepEqual(await fs.readFile(f.selected), before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|path|fileName|root|hash|index/);
  assert.deepEqual(await f.importProgress(f.event), { status: 'idle' });
});

for (const kind of ['empty', 'oversized', 'sparse', 'getter', 'outside-last', 'non-string'] as const) {
  test(`batch rejects ${kind} selection entirely before starting any import`, async t => {
    const f = await importFixture(t);
    let selected: string[] = [f.selected];
    if (kind === 'empty') { selected = []; }
    if (kind === 'oversized') { selected = Array(101).fill(f.selected); }
    if (kind === 'sparse') { selected = new Array(2); selected[0] = f.selected; }
    if (kind === 'getter') { Object.defineProperty(selected, '0', { get: () => { assert.fail('Do not invoke native result accessors'); } }); }
    if (kind === 'outside-last') { selected.push('/outside-source/private.mp4'); }
    if (kind === 'non-string') { selected.push(42 as unknown as string); }
    f.chooseImport(async () => selected);
    assert.deepEqual(await f.runImport(), { status: kind === 'oversized' ? 'limit' : 'invalid' });
    assert.equal(f.writes(), 0);
    assert.deepEqual(await f.importProgress(f.event), { status: 'idle' });
  });
}

test('batch snapshots the native array and provides copied numeric progress through the pending gate', async t => {
  const f = await importFixture(t);
  const second = path.join(f.root, 'second.mp4'); await fs.writeFile(second, 'Synthetic second');
  const selected = [f.selected, second]; f.chooseImport(async () => selected);
  let start!: () => void; const entered = new Promise<void>(yes => { start = yes; });
  let resume!: () => void; const release = new Promise<void>(yes => { resume = yes; }); t.after(() => resume());
  const seen: string[] = [];
  f.importing(async (_generation, _source, location) => {
    seen.push(location.fileName);
    if (seen.length === 1) { start(); await release; }
    return { status: 'imported', index: seen.length };
  });
  assert.deepEqual(await f.importProgress(f.event), { status: 'idle' });
  const work = f.runImport(); await entered;
  selected[1] = '/outside-root/private.mp4'; selected.push('/outside-root/extra.mp4');
  const reads = f.reads();
  const progress = await f.importProgress(f.event);
  assert.deepEqual(progress, { status: 'running', total: 2, processed: 0, imported: 0, duplicates: 0, failed: 0 });
  progress.imported = 99;
  assert.equal((await f.importProgress(f.event)).imported, 0);
  assert.deepEqual(await f.importProgress(f.event, 'extra'), { status: 'unavailable' });
  assert.deepEqual(await f.importProgress({ ...f.event, senderFrame: { ...f.contents.mainFrame } }), { status: 'unavailable' });
  assert.deepEqual(await f.importProgress({ ...f.event, sender: {} }), { status: 'unavailable' });
  assert.equal(f.reads(), reads, 'progress performs no catalogue or file access');
  assert.deepEqual(await f.sources(f.event), { status: 'busy' });
  assert.deepEqual(await f.runImport(), { status: 'busy' });
  resume();
  assert.deepEqual(await work, batchResult(2, 2));
  assert.deepEqual(seen, ['new-video.mp4', 'second.mp4']);
  assert.deepEqual(await f.importProgress(f.event), { status: 'idle' });
});

test('batch refuses a repeated path already committed earlier in the same selection', async t => {
  const f = await importFixture(t);
  f.chooseImport(async () => [f.selected, f.selected]);
  let writes = 0;
  f.importing(async (_generation, _source, location) => {
    writes++;
    f.images.push({ ...NewImageElement(), ...location, locations: undefined, cleanName: 'Imported' });
    return { status: 'imported', index: f.images.length - 1 };
  });
  assert.deepEqual(await f.runImport(), batchResult(2, 1, 1));
  assert.equal(writes, 1);
});

for (const stop of ['cancel', 'remap', 'replace-root', 'conflict'] as const) {
  test(`batch ${stop} retains known completion and starts no later file`, async t => {
    const f = await importFixture(t);
    const second = path.join(f.root, 'second.mp4'); await fs.writeFile(second, 'Synthetic second');
    f.chooseImport(async () => [f.selected, second]);
    const moved = f.root + '-old';
    t.after(async () => { try { await fs.rename(moved, f.root); } catch { /* Original location retained unless replacement was exercised. */ } });
    let writes = 0;
    f.importing(async () => {
      writes++;
      if (stop === 'cancel') { f.cancelImport(); }
      if (stop === 'remap') { f.catalogue({ images: f.images, inputDirs: { 0: { path: f.root + '-moved' } } } as unknown as FinalObject); }
      if (stop === 'replace-root') { await fs.rename(f.root, moved); await fs.mkdir(f.root); }
      return stop === 'conflict' ? { status: 'conflict' } : { status: 'imported', index: 1 };
    });
    const result = await f.runImport();
    assert.deepEqual(result, batchResult(2, stop === 'conflict' ? 0 : 1, 0, 0, stop === 'cancel' ? 'cancelled' : 'stopped'));
    assert.equal(writes, 1);
    if (stop === 'replace-root') { await fs.rmdir(f.root); await fs.rename(moved, f.root); }
  });
}

test('batch disposal drains the active file and rejects all late progress and completion', async t => {
  const f = await importFixture(t);
  const second = path.join(f.root, 'second.mp4'); await fs.writeFile(second, 'Synthetic second');
  f.chooseImport(async () => [f.selected, second]);
  let start!: () => void; const entered = new Promise<void>(yes => { start = yes; });
  let resume!: () => void; const release = new Promise<void>(yes => { resume = yes; }); t.after(() => resume());
  let writes = 0; let captured: import('./private-preview-source').PrivatePreviewSource | undefined;
  f.importing(async (_generation, source) => { writes++; captured = source; start(); await release; throw new Error('cancelled'); });
  const work = f.runImport(); await entered;
  let disposed = false; const disposal = f.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  assert.deepEqual(await f.importProgress(f.event), { status: 'unavailable' });
  resume(); assert.deepEqual(await work, { status: 'unavailable' }); await disposal;
  assert.equal(writes, 1); assert.equal(captured?.isCurrent(), false);
});

test('batch source cleanup failure quarantines the session instead of continuing', async t => {
  const f = await importFixture(t);
  const second = path.join(f.root, 'second.mp4'); await fs.writeFile(second, 'Synthetic second');
  f.chooseImport(async () => [f.selected, second]);
  const restore = failSourceDescriptorClose(t, f.selected);
  f.expectQuarantinedDisposal();
  try {
    assert.deepEqual(await f.runImport(), { status: 'unavailable' });
    assert.equal(f.writes(), 0); assert.ok(f.locks() > 0);
    assert.deepEqual(await f.importProgress(f.event), { status: 'unavailable' });
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  } finally { await restore(); }
});

test('batch finalizer failure suppresses a completed acknowledgement and never starts the next file', async t => {
  const f = await importFixture(t);
  const second = path.join(f.root, 'second.mp4'); await fs.writeFile(second, 'Synthetic second');
  f.chooseImport(async () => [f.selected, second]);
  let restore: (() => Promise<void>) | undefined; let writes = 0;
  f.expectQuarantinedDisposal();
  f.importing(async (_generation, source) => {
    writes++;
    restore = failSourceDescriptorClose(t, f.selected);
    await source.open();
    return { status: 'imported', index: 1 };
  });
  try {
    assert.deepEqual(await f.runImport(), { status: 'unavailable' });
    assert.equal(writes, 1); assert.ok(f.locks() > 0);
    assert.deepEqual(await f.importProgress(f.event), { status: 'unavailable' });
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  } finally { await restore?.(); }
});

const gallerySorts = ['catalogue', 'name', 'date-added', 'last-played', 'rating', 'duration', 'file-size'] as const;
const galleryDirections = ['asc', 'desc'] as const;
function sortableImages(): ImageElement[] {
  return [
    { cleanName: 'Video 10', dateAdded: 30, lastPlayed: 30, stars: 3.5, duration: 30, fileSize: 300 },
    { cleanName: 'Video 2', dateAdded: 10, lastPlayed: 10, stars: 1.5, duration: 10, fileSize: 100 },
    { cleanName: 'VIDEO 2', dateAdded: 10, lastPlayed: 10, stars: 1.5, duration: 10, fileSize: 100 },
    { cleanName: 'Video 1', dateAdded: 20, lastPlayed: 20, stars: 2.5, duration: 20, fileSize: 200 },
    { cleanName: 'Video 20', dateAdded: 0, lastPlayed: 0, stars: NaN, duration: 0, fileSize: 0 },
  ].map((values, index) => Object.assign(image(index), values));
}
for (const sort of gallerySorts) {
  for (const direction of galleryDirections) {
    test(`gallery ${sort} ${direction} ordering preserves stable ties, missing values and cached identities`, async t => {
      const images = sortableImages(); const f = fixture(t, images);
      const initial = await f.page();
      const indices = sort === 'catalogue' ? direction === 'asc' ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0]
        : sort === 'name' ? direction === 'asc' ? [3, 1, 2, 0, 4] : [4, 0, 1, 2, 3]
        : direction === 'asc' ? [1, 2, 3, 0, 4] : [0, 3, 1, 2, 4];
      const page = await f.list(f.event, { query: '', offset: 0, sort, direction });
      assert.equal(page.status, 'ready'); assert.equal(page.total, 5);
      assert.deepEqual(page.items.map((item: any) => item.title), indices.map(index => images[index].cleanName));
      assert.deepEqual(page.items.map((item: any) => item.id), indices.map(index => initial.items[index].id));
      assert.deepEqual((await f.page()).items.map((item: any) => item.id), initial.items.map((item: any) => item.id), 'sorting never mutates catalogue order');
      assert.equal(f.reads(), 1); assert.equal(f.edits.length, 0);
      assert.deepEqual(Object.keys(page.items[0]).sort(), Object.keys(initial.items[0]).sort(), 'sort metrics stay main-only');
    });
  }
}

for (const sort of ['date-added', 'last-played', 'file-size', 'duration', 'rating'] as const) {
  test(`${sort} rejects malformed and default metrics and keeps unknowns last in either direction`, async t => {
    const key = { 'date-added': 'dateAdded', 'last-played': 'lastPlayed', 'file-size': 'fileSize', duration: 'duration', rating: 'stars' }[sort];
    const unknown: unknown[] = [undefined, null, '20', NaN, Infinity, -1, 0, Number.MAX_VALUE];
    if (sort !== 'duration') { unknown.push(1.25); }
    if (sort === 'date-added' || sort === 'last-played') { unknown.push(8.64e15 + 1); }
    if (sort === 'rating') { unknown.push(1, 6.5); }
    const known = sort === 'rating' ? [0.5, 5.5] : sort === 'duration' ? [0.25, 2] : [1, 2];
    const images = [...known, ...unknown].map((value, index) => Object.assign(image(index), { [key]: value }));
    const f = fixture(t, images);
    for (const direction of galleryDirections) {
      const page = await f.list(f.event, { query: '', offset: 0, sort, direction });
      const expected = [...(direction === 'asc' ? [0, 1] : [1, 0]), ...unknown.map((_value, index) => index + 2)];
      assert.deepEqual(page.items.map((item: any) => item.title), expected.map(index => images[index].cleanName));
    }
  });
}

test('recent includes only valid positive last-played timestamps and intersects search without probing originals', async t => {
  const values: unknown[] = [0, undefined, null, '1', -1, NaN, Infinity, 1.25, 8.64e15 + 1, 1, 8.64e15];
  const images = values.map((lastPlayed, index) => Object.assign(image(index), { lastPlayed, tags: ['Recent subject'] }));
  const f = fixture(t, images, ENTRY, async () => { assert.fail('Collection browsing cannot prompt for originals'); });
  const recent = await f.list(f.event, { query: '  RECENT SUBJECT ', offset: 0, collection: 'recent', sort: 'last-played', direction: 'desc' });
  assert.equal(recent.total, 2); assert.deepEqual(recent.items.map((item: any) => item.title), ['Video 10', 'Video 9']);
  const filtered = await f.list(f.event, { query: 'video 9', offset: 0, collection: 'recent' });
  assert.equal(filtered.total, 1); assert.equal(filtered.items[0].id, recent.items[1].id);
  assert.equal((await f.list(f.event, { query: 'missing', offset: 0, collection: 'recent' })).total, 0);
  assert.equal(f.reads(), 1); assert.equal(f.edits.length, 0);
});

test('favourites use exact saved rating and search intersection precedes sorting and 48-row pagination', async t => {
  const images = Array.from({ length: 123 }, (_value, index) => Object.assign(image(index), {
    cleanName: `Clip ${index}`, stars: index % 2 === 0 ? 5.5 : 4.5, tags: index < 120 ? ['Chosen'] : ['Other'],
  }));
  const f = fixture(t, images);
  const request = { query: 'chosen', collection: 'favourites', sort: 'name', direction: 'desc' };
  const first = await f.list(f.event, { ...request, offset: 0 });
  const second = await f.list(f.event, { ...request, offset: 48 });
  const expected = Array.from({ length: 60 }, (_value, index) => `Clip ${118 - index * 2}`);
  assert.equal(first.total, 60); assert.equal(second.total, 60);
  assert.equal(first.items.length, 48); assert.equal(second.items.length, 12);
  assert.deepEqual([...first.items, ...second.items].map(item => item.title), expected);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 60);
  assert.deepEqual((await f.list(f.event, { ...request, offset: 96 })).items, []);
  assert.equal(f.reads(), 1);
});

for (const sort of gallerySorts) {
  test(`${sort} pagination is stable across page boundaries with repeated keys`, async t => {
    const images = Array.from({ length: 103 }, (_value, index) => Object.assign(image(index), {
      cleanName: `Group ${index % 3}`, dateAdded: index % 3 + 1, lastPlayed: index % 3 + 1,
      duration: index % 3 + 1, fileSize: index % 3 + 1, stars: index % 3 + 0.5,
    }));
    const f = fixture(t, images);
    const initial = await f.page();
    for (const direction of galleryDirections) {
      const pages = [];
      for (const offset of [0, 48, 96]) {
        pages.push(await f.list(f.event, { query: '', offset, sort, direction }));
      }
      assert.deepEqual(pages.map(page => page.total), [103, 103, 103]);
      const items = pages.flatMap(page => page.items);
      assert.equal(items.length, 103); assert.equal(new Set(items.map(item => item.id)).size, 103);
      const expected = Array.from({ length: 103 }, (_value, index) => index).sort((a, b) =>
        sort === 'catalogue' ? (direction === 'asc' ? 1 : -1) * (a - b)
          : (direction === 'asc' ? 1 : -1) * (a % 3 - b % 3) || a - b);
      const reference = new Map<number, string>(initial.items.map((item: any, index: number) => [index, item.id]));
      for (const [position, index] of expected.entries()) {
        if (reference.has(index)) { assert.equal(items[position].id, reference.get(index)); }
      }
      assert.deepEqual(items.map(item => item.title), expected.map(index => images[index].cleanName));
    }
  });
}

test('empty collections preserve exact zero totals and legacy query defaults', async t => {
  const f = fixture(t, []);
  for (const collection of ['all', 'favourites', 'recent']) {
    assert.deepEqual(await f.list(f.event, { query: '', offset: 0, collection, sort: 'name', direction: 'desc' }),
      { status: 'ready', total: 0, offset: 0, items: [] });
  }
  assert.deepEqual(await f.page(), { status: 'ready', total: 0, offset: 0, items: [] });
});

test('list query rejects unknown keys, symbols, accessors, prototypes and invalid sort options without invoking getters', async t => {
  const f = fixture(t);
  let getters = 0;
  const bad: unknown[] = [
    { query: '', offset: 0, collection: 'other' }, { query: '', offset: 0, collection: undefined },
    { query: '', offset: 0, collection: 1 }, { query: '', offset: 0, sort: 'private-path' },
    { query: '', offset: 0, sort: undefined }, { query: '', offset: 0, sort: {} },
    { query: '', offset: 0, direction: 'ASC' }, { query: '', offset: 0, direction: undefined },
    { query: '', offset: 0, [Symbol('hidden')]: true },
    Object.assign(Object.create({ collection: 'all' }), { query: '', offset: 0 }),
    Object.assign(Object.create({ query: '' }), { offset: 0 }),
  ];
  for (const key of ['query', 'offset', 'collection', 'sort', 'direction']) {
    const accessor = { query: '', offset: 0 };
    Object.defineProperty(accessor, key, { enumerable: true, get: () => { getters++; return key === 'offset' ? 0 : ''; } });
    bad.push(accessor);
    const hidden = { query: '', offset: 0 };
    Object.defineProperty(hidden, key, { enumerable: false, value: key === 'offset' ? 0 : '' });
    bad.push(hidden);
  }
  for (const value of bad) { assert.deepEqual(await f.list(f.event, value), { status: 'unavailable' }); }
  assert.equal(getters, 0); assert.equal(f.reads(), 0);
  assert.equal((await f.list(f.event, Object.assign(Object.create(null), { query: '', offset: 0 }))).status, 'ready');
});

test('sorting and collection requests cannot deliver cached results after authority expires', async t => {
  const f = fixture(t, sortableImages());
  await f.page(); f.stale();
  assert.deepEqual(await f.list(f.event, { query: '', offset: 0, collection: 'recent', sort: 'last-played', direction: 'desc' }),
    { status: 'unavailable' });
  assert.equal(f.reads(), 1);
});

test('metadata refresh updates collection and sort keys without replacing existing selection IDs', async t => {
  const images = sortableImages(); const f = fixture(t, images);
  const initial = await f.list(f.event, { query: '', offset: 0, sort: 'last-played', direction: 'desc' });
  const id = initial.items[1].id;
  const detail = await f.detail(f.event, id);
  f.write(async (_generation, request, current) => {
    assert.equal(current(), true);
    images[request.index] = { ...images[request.index], tags: ['Saved collection tag'], notes: request.notes,
      stars: 5.5, lastPlayed: 50, dateAdded: 50, duration: 50, fileSize: 500 };
    return { status: 'saved', image: images[request.index] };
  });
  const saved = await f.save(f.event, { id, revision: detail.item.revision, tags: ['Saved collection tag'], notes: 'Updated notes' });
  assert.equal(saved.status, 'saved'); assert.equal(saved.item.id, id);
  for (const sort of ['date-added', 'last-played', 'rating', 'duration', 'file-size']) {
    const page = await f.list(f.event, { query: 'saved collection', offset: 0, collection: 'favourites', sort, direction: 'desc' });
    assert.equal(page.total, 1); assert.equal(page.items[0].id, id);
    const all = await f.list(f.event, { query: '', offset: 0, sort, direction: 'desc' });
    assert.equal(all.items[0].id, id);
  }
});

test('rating save updates favourites and rating order while preserving selection identity', async t => {
  const images = [image(0), { ...image(1), stars: 3.5 as const }, { ...image(2), stars: 3.5 as const }];
  const f = fixture(t, images);
  const initial = await f.page(); const id = initial.items[0].id;
  let selected = (await f.detail(f.event, id)).item;
  const request = { id, revision: selected.revision, notes: selected.notes, tags: selected.tags, rating: 2 };
  let saved = await f.save(f.event, request);
  assert.equal(saved.status, 'saved'); assert.equal(saved.item.id, id);
  assert.equal(saved.item.rating, 2); assert.equal(saved.item.favourite, false);
  assert.equal((f.edits[0] as any).rating, 2); assert.equal(images[0].stars, 2.5);
  assert.equal((await f.list(f.event, { query: '', offset: 0, collection: 'favourites' })).total, 0);
  const sorted = await f.list(f.event, { query: '', offset: 0, sort: 'rating', direction: 'desc' });
  assert.deepEqual(sorted.items.map((item: any) => item.id), [initial.items[1].id, initial.items[2].id, id]);
  assert.deepEqual(await f.save(f.event, request), { status: 'conflict' });
  selected = saved.item;
  saved = await f.save(f.event, { id, revision: selected.revision, notes: 'Rated favourite', tags: ['Favourite tag'], rating: 5 });
  assert.equal(saved.status, 'saved'); assert.equal(saved.item.favourite, true); assert.equal(saved.item.rating, 5);
  const favourites = await f.list(f.event, { query: 'favourite tag', offset: 0, collection: 'favourites' });
  assert.equal(favourites.total, 1); assert.equal(favourites.items[0].id, id);
  saved = await f.save(f.event, { id, revision: saved.item.revision, notes: 'Unrated', tags: ['Favourite tag'], rating: 0 });
  assert.equal(saved.item.rating, 0); assert.equal(saved.item.favourite, false); assert.equal(images[0].stars, 0.5);
});

test('legacy notes and tags save omits rating from the storage request and preserves raw stars', async t => {
  const images: ImageElement[] = [Object.assign(image(0), { stars: 'legacy unknown rating' })];
  const f = fixture(t, images); const id = (await f.page()).items[0].id;
  const selected = (await f.detail(f.event, id)).item;
  const saved = await f.save(f.event, { id, revision: selected.revision, notes: 'Legacy notes edit', tags: selected.tags });
  assert.equal(saved.status, 'saved'); assert.equal(Object.hasOwn(f.edits[0] as object, 'rating'), false);
  assert.equal(images[0].stars, 'legacy unknown rating');
});

test('rating saves reject unknown fields, invalid scalars and accessors without invoking storage or getters', async t => {
  const f = fixture(t); const id = (await f.page()).items[0].id;
  const selected = (await f.detail(f.event, id)).item;
  const base = { id, revision: selected.revision, notes: selected.notes, tags: selected.tags };
  let getters = 0;
  const invalid: unknown[] = [undefined, null, '5', true, -1, 6, 0.5, NaN, Infinity, {}, []].map(rating => ({ ...base, rating }));
  invalid.push({ ...base, rating: 5, favourite: true }, { ...base, [Symbol('rating')]: 5 },
    Object.assign(Object.create({ rating: 5 }), base));
  for (const key of ['id', 'revision', 'notes', 'tags', 'rating']) {
    const accessor = { ...base };
    Object.defineProperty(accessor, key, { enumerable: true, get: () => { getters++; return 5; } });
    invalid.push(accessor);
    const hidden = { ...base };
    Object.defineProperty(hidden, key, { enumerable: false, value: 5 }); invalid.push(hidden);
  }
  const tags = ['tag'];
  Object.defineProperty(tags, '0', { enumerable: true, get: () => { getters++; return 'tag'; } });
  invalid.push({ ...base, tags, rating: 5 });
  const iterator = ['tag'];
  Object.defineProperty(iterator, Symbol.iterator, { value: () => { getters++; throw new Error('No iterator'); } });
  invalid.push({ ...base, tags: iterator, rating: 5 });
  for (const value of invalid) { assert.deepEqual(await f.save(f.event, value), { status: 'invalid' }); }
  assert.equal(getters, 0); assert.equal(f.edits.length, 0);
});

test('concurrent stored rating conflicts with a stale editor until explicit detail refresh', async t => {
  const images = [image(0)]; const f = fixture(t, images);
  const id = (await f.page()).items[0].id;
  const selected = (await f.detail(f.event, id)).item;
  images[0].stars = 1.5;
  const request = { id, revision: selected.revision, notes: selected.notes, tags: selected.tags, rating: 4 };
  assert.deepEqual(await f.save(f.event, request), { status: 'conflict' });
  assert.equal(images[0].stars, 1.5);
  const refreshed = (await f.detail(f.event, id)).item;
  assert.equal(refreshed.rating, 1); assert.equal(refreshed.id, id);
  assert.equal((await f.save(f.event, { ...request, revision: refreshed.revision })).status, 'saved');
  assert.equal(images[0].stars, 4.5);
});


async function scanFixture(t: TestContext) {
  const f = await sourceFixture(t);
  const selected = path.join(f.root, 'discovered-video.mp4');
  await fs.writeFile(selected, 'Synthetic discovered video');
  let confirmations = 0; let writes = 0;
  f.confirmScan(async (count, more) => { confirmations++; assert.equal(count, 1); assert.equal(more, false); return true; });
  const captured: import('./private-preview-source').PrivatePreviewSource[] = [];
  f.importing(async (_generation, source, location, options) => {
    writes++; captured.push(source);
    assert.equal(options.isCurrent(), true); assert.equal(source.isCurrent(), true);
    f.images.push({ ...NewImageElement(), ...location, locations: undefined, cleanName: 'Discovered video' });
    return { status: 'imported', index: f.images.length - 1 };
  });
  const sourceId = (await f.sources(f.event)).items[0].id;
  return { ...f, selected, sourceId, writes: () => writes, confirmations: () => confirmations, captured,
    runScan: () => f.scanSource(f.event, sourceId) };
}

test('source scan requires a native grant and count-only confirmation before encrypted import', async t => {
  const f = await scanFixture(t);
  let granted = false; let confirmed = false; let enumerations = 0;
  const opendir = fs.opendir;
  t.mock.method(fs, 'opendir', (async (...args: Parameters<typeof fs.opendir>) => {
    assert.equal(granted, true, 'directory enumeration starts only after the native source grant');
    enumerations++; return opendir(...args);
  }) as typeof fs.opendir);
  f.choose(async root => { granted = true; return root; });
  f.confirmScan(async (...args) => {
    assert.deepEqual(args, [1, false]); confirmed = true;
    assert.equal(f.writes(), 0); assert.deepEqual(await f.importProgress(f.event), { status: 'idle' }); return true;
  });
  const original = await fs.readFile(f.selected);
  assert.deepEqual(await f.runScan(), batchResult(1, 1));
  assert.equal(confirmed, true); assert.ok(enumerations > 0); assert.equal(f.writes(), 1);
  assert.equal(f.captured[0].isCurrent(), false); assert.deepEqual(await fs.readFile(f.selected), original);
  const sources = await f.sources(f.event);
  assert.deepEqual(await f.scanSource(f.event, sources.items[0].id), { status: 'nothing-new' });
  assert.deepEqual(await f.importProgress(f.event), { status: 'idle' });
});

test('source scan validates frame, opaque source ID, arity and native confirmation capability before probing', async t => {
  const f = await scanFixture(t);
  const opendir = t.mock.method(fs, 'opendir', async () => { assert.fail('Do not probe invalid source requests'); });
  for (const args of [[], ['bad'], [f.sourceId, 'extra'], [{ id: f.sourceId }], ['a'.repeat(32)]]) {
    assert.deepEqual(await f.scanSource(f.event, ...args), { status: 'unavailable' });
  }
  assert.deepEqual(await f.scanSource({ ...f.event, senderFrame: { ...f.contents.mainFrame } }, f.sourceId), { status: 'unavailable' });
  f.options.confirmSourceScan = undefined!;
  assert.deepEqual(await f.runScan(), { status: 'unavailable' });
  assert.equal(opendir.mock.callCount(), 0); assert.equal(f.picks(), 0); assert.equal(f.writes(), 0);
});

test('cancelled access permission never enumerates a source or asks for import confirmation', async t => {
  const f = await scanFixture(t); f.choose(async () => undefined);
  const opendir = t.mock.method(fs, 'opendir', async () => { assert.fail('Cancelled permission cannot enumerate'); });
  assert.deepEqual(await f.runScan(), { status: 'cancelled' });
  assert.equal(opendir.mock.callCount(), 0); assert.equal(f.confirmations(), 0); assert.equal(f.writes(), 0);
});

test('source scan rechecks a saved source changed while the grant picker was open before enumeration', async t => {
  const f = await scanFixture(t);
  const opendir = t.mock.method(fs, 'opendir', async () => { assert.fail('Changed saved source cannot enumerate'); });
  f.choose(async () => {
    f.catalogue({ images: f.images, inputDirs: { 0: { path: f.root + '-changed' } } } as unknown as FinalObject);
    return f.root;
  });
  assert.deepEqual(await f.runScan(), { status: 'conflict' });
  assert.equal(opendir.mock.callCount(), 0); assert.equal(f.confirmations(), 0); assert.equal(f.writes(), 0);
});

test('declining a discovered batch performs no source-content reads or catalogue writes', async t => {
  const f = await scanFixture(t); f.confirmScan(async () => false);
  const open = t.mock.method(fs, 'open', async () => { assert.fail('A declined review cannot open media content'); });
  const result = await f.runScan();
  assert.deepEqual(result, { status: 'cancelled' }); assert.equal(open.mock.callCount(), 0); assert.equal(f.writes(), 0);
  assert.doesNotMatch(JSON.stringify(result), /root|path|discovered|fileName|hash|index/);
});

for (const revoke of ['cancel', 'dispose', 'lock'] as const) {
  test(`source scan ${revoke} drains a late native confirmation and never imports`, async t => {
    const f = await scanFixture(t);
    let start!: () => void; const ready = new Promise<void>(resolve => { start = resolve; });
    let finish!: () => void;
    f.confirmScan(async () => { start(); await new Promise<void>(resolve => { finish = resolve; }); return true; });
    const work = f.runScan(); await ready;
    assert.deepEqual(await f.page(), { status: 'busy' }); assert.deepEqual(await f.runScan(), { status: 'busy' });
    assert.deepEqual(await f.importVideo(f.event, f.sourceId), { status: 'busy' });
    assert.deepEqual(await f.importProgress(f.event), { status: 'idle' });
    let drained = false; let disposal: Promise<void> | undefined;
    if (revoke === 'cancel') { f.cancelImport(); }
    else if (revoke === 'lock') { f.controller.abort(); }
    else { disposal = f.dispose().then(() => { drained = true; }); }
    await Promise.resolve(); assert.equal(drained, false); finish();
    assert.deepEqual(await work, { status: revoke === 'cancel' ? 'cancelled' : 'unavailable' });
    await disposal; assert.equal(f.writes(), 0);
  });
}

for (const changed of ['file', 'ignored', 'root'] as const) {
  test(`source scan detects ${changed} changes made during confirmation before importing`, async t => {
    const f = await scanFixture(t);
    f.confirmScan(async () => {
      if (changed === 'file') { await fs.writeFile(f.selected, 'Changed reviewed bytes'); }
      else {
        f.catalogue({ images: f.images, inputDirs: { 0: { path: changed === 'root' ? f.root + '-changed' : f.root,
          ...(changed === 'ignored' ? { ignoredSubdirectories: ['excluded'] } : {}) } } } as unknown as FinalObject);
      }
      return true;
    });
    const result = await f.runScan();
    assert.deepEqual(result, { status: changed === 'file' ? 'source-unavailable' : 'conflict' });
    assert.equal(f.writes(), 0);
  });
}

test('source scan imports serially, preserves its review across own appends and shares numeric progress/cancellation', async t => {
  const f = await scanFixture(t);
  const second = path.join(f.root, 'second-video.mp4'); await fs.writeFile(second, 'Second synthetic discovered video');
  f.confirmScan(async (count, more) => { assert.equal(count, 2); assert.equal(more, false); return true; });
  let start!: () => void; const ready = new Promise<void>(resolve => { start = resolve; });
  let resume!: () => void; const release = new Promise<void>(resolve => { resume = resolve; }); t.after(() => resume());
  let writes = 0; let previous: import('./private-preview-source').PrivatePreviewSource | undefined;
  f.importing(async (_generation, source, location) => {
    assert.equal(previous?.isCurrent() ?? false, false); previous = source; writes++;
    if (writes === 2) { start(); await release; f.cancelImport(); throw new Error('Cancelled'); }
    f.images.push({ ...NewImageElement(), ...location, locations: undefined, cleanName: 'Discovered' });
    return { status: 'imported', index: f.images.length - 1 };
  });
  const work = f.runScan(); await ready;
  const progress = await f.importProgress(f.event);
  assert.deepEqual(progress, { status: 'running', total: 2, processed: 1, imported: 1, duplicates: 0, failed: 0 });
  assert.doesNotMatch(JSON.stringify(progress), /root|path|fileName|discovered|hash|index/);
  resume(); assert.deepEqual(await work, batchResult(2, 1, 0, 0, 'cancelled'));
  assert.equal(previous?.isCurrent(), false); assert.equal(f.images.length, 2);
});

test('source scan review prevents changed later files from being captured after an earlier publication', async t => {
  const f = await scanFixture(t);
  const second = path.join(f.root, 'second-video.mp4'); await fs.writeFile(second, 'Second synthetic discovered video');
  f.confirmScan(async () => true); let writes = 0;
  f.importing(async (_generation, _source, location) => {
    writes++; assert.equal(location.fileName, path.basename(f.selected));
    await fs.writeFile(second, 'Changed after the reviewed batch was confirmed');
    return { status: 'imported', index: 1 };
  });
  assert.deepEqual(await f.runScan(), batchResult(2, 1, 0, 0, 'stopped')); assert.equal(writes, 1);
});

test('source scan review remains part of source authority throughout descriptor capture and import', async t => {
  const f = await scanFixture(t); let writes = 0;
  f.importing(async (_generation, source, _location, options) => {
    writes++; await fs.writeFile(f.selected, 'Changed during admitted import');
    assert.equal(options.isCurrent(), false); assert.equal(source.isCurrent(), false);
    return { status: 'conflict' };
  });
  assert.deepEqual(await f.runScan(), batchResult(1, 0, 0, 0, 'stopped')); assert.equal(writes, 1);
});

for (const status of ['cancelled', 'invalid', 'limit', 'source-unavailable'] as const) {
  test(`source scan maps ${status} discovery failure without native confirmation`, async t => {
    const f = await scanFixture(t);
    t.mock.method(sourceScan, 'reviewPrivateSourceScan', async () => ({ status }));
    assert.deepEqual(await f.runScan(), { status: status === 'limit' ? 'scan-limit' : status });
    assert.equal(f.confirmations(), 0); assert.equal(f.writes(), 0);
  });
}

test('unconfirmed source scan directory cleanup quarantines the private session', async t => {
  const f = await scanFixture(t); const opendir = fs.opendir;
  t.mock.method(fs, 'opendir', (async (...args: Parameters<typeof fs.opendir>) => {
    const directory = await opendir(...args); const close = directory.close.bind(directory);
    directory.close = async () => { await close(); throw new Error('/PRIVATE-SCAN-PATH'); };
    return directory;
  }) as typeof fs.opendir);
  f.expectQuarantinedDisposal();
  assert.deepEqual(await f.runScan(), { status: 'unavailable' });
  assert.equal(f.confirmations(), 0); assert.equal(f.writes(), 0); assert.ok(f.locks() > 0);
  assert.deepEqual(await f.importProgress(f.event), { status: 'unavailable' });
  await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
});

// Playback-history maintenance has independent lifetime drainage because the
// count-only native confirmation can outlive its originating gallery window.
test('history reset accepts only one supported metric from the trusted main frame', async t => {
  const f = fixture(t); let touched = 0;
  const hostile = { get metric() { touched++; throw new Error('Private diagnostic'); } };
  for (const args of [[], [null], ['all'], ['Last played'], ['lastPlayed', true], [hostile], [new String('lastPlayed')]]) {
    assert.deepEqual(await f.resetPlaybackHistory(f.event, ...args), { status: 'invalid' });
  }
  for (const event of [{ ...f.event, sender: new Contents() }, { ...f.event, senderFrame: { ...f.contents.mainFrame } },
    { ...f.event, senderFrame: null }]) {
    assert.deepEqual(await f.resetPlaybackHistory(event, 'lastPlayed'), { status: 'unavailable' });
  }
  assert.equal(touched, 0); assert.equal(f.reads(), 0); assert.equal(f.historyResets.length, 0);
  assert.equal(f.historyConfirmations.length, 0);
  f.options.confirmPlaybackHistoryReset = undefined!;
  assert.deepEqual(await f.resetPlaybackHistory(f.event, 'lastPlayed'), { status: 'unavailable' });
  assert.equal(f.historyResets.length, 0);
});

for (const metric of ['lastPlayed', 'timesPlayed'] as const) {
  test(`history reset changes only ${metric} and retires cached selection/source IDs`, async t => {
    const images = [image(0), image(1)];
    images[0].lastPlayed = 100; images[0].timesPlayed = 3;
    images[1].lastPlayed = 200; images[1].timesPlayed = 4;
    const f = fixture(t, images);
    const page = await f.page(); const oldId = page.items[0].id;
    const detail = await f.detail(f.event, oldId);
    const sources = await f.sources(f.event); const sourceId = sources.items[0].id;
    const before = images.map(row => ({ ...row }));
    assert.deepEqual(await f.resetPlaybackHistory(f.event, metric), { status: 'reset', count: 2 });
    assert.deepEqual(f.historyResets, [metric]);
    assert.deepEqual(f.historyConfirmations, [{ metric, count: 2 }]);
    assert.deepEqual(images, before.map(row => ({ ...row, [metric]: 0 })));
    assert.equal((await f.detail(f.event, oldId)).status, 'unavailable');
    assert.equal((await f.save(f.event, { id: oldId, revision: detail.item.revision, notes: 'Stale', tags: [] })).status, 'unavailable');
    assert.equal((await f.disconnectSource(f.event, sourceId)).status, 'unavailable');
    const next = await f.page(); assert.notEqual(next.items[0].id, oldId);
    assert.notEqual((await f.sources(f.event)).items[0].id, sourceId);
    const recent = await f.list(f.event, { query: '', offset: 0, collection: 'recent', sort: 'last-played' });
    assert.equal(recent.total, metric === 'lastPlayed' ? 0 : 2);
    assert.equal(f.edits.length, 0); assert.equal(f.historyWrites.length, 0); assert.equal(f.appliedProtection.length, 0);
  });
}

test('history reset no-op skips confirmation, while cancellation preserves metrics and both retire cached IDs', async t => {
  const images = [image(0)]; images[0].lastPlayed = 100; images[0].timesPlayed = 0;
  const f = fixture(t, images); const before = JSON.stringify(images);
  const old = (await f.page()).items[0].id;
  assert.deepEqual(await f.resetPlaybackHistory(f.event, 'timesPlayed'), { status: 'unchanged' });
  assert.equal(f.historyConfirmations.length, 0);
  assert.equal((await f.detail(f.event, old)).status, 'unavailable');
  const next = (await f.page()).items[0].id; f.confirmHistory(async () => false);
  assert.deepEqual(await f.resetPlaybackHistory(f.event, 'lastPlayed'), { status: 'cancelled' });
  assert.equal(JSON.stringify(images), before); assert.equal(f.historyConfirmations.length, 1);
  assert.equal((await f.detail(f.event, next)).status, 'unavailable');
});

for (const result of [{ status: 'reset', count: 1 }, { status: 'reset', count: 100_000 },
  { status: 'unchanged' }, { status: 'cancelled' }, { status: 'busy' }, { status: 'invalid' }] as const) {
  test(`history reset returns only its bounded ${JSON.stringify(result)} outcome`, async t => {
    const f = fixture(t); f.resettingHistory(async () => result);
    assert.deepEqual(await f.resetPlaybackHistory(f.event, 'lastPlayed'), result);
  });
}

for (const value of [undefined, null, {}, { status: 'reset', count: 0 }, { status: 'reset', count: -1 },
  { status: 'reset', count: 100_001 }, { status: 'reset', count: 1.5 }, { status: 'reset', count: NaN },
  { status: 'reset', count: 1, secret: 'Hidden diagnostic' }, { status: 'unchanged', count: 0 },
  { status: 'cancelled', secret: 'Hidden diagnostic' }, { status: 'failed' }, Object.create({ status: 'unchanged' }),
  { get status() { throw new Error('Secret getter'); } }, { status: 'reset', get count() { throw new Error('Secret count'); } }]) {
  test(`history reset rejects malformed session outcome ${typeof value} without returning private fields`, async t => {
    const f = fixture(t); f.resettingHistory(async () => value as any);
    assert.deepEqual(await f.resetPlaybackHistory(f.event, 'timesPlayed'), { status: 'unavailable' });
  });
}

test('history reset refuses malformed native confirmation counts without opening the prompt', async t => {
  const f = fixture(t);
  f.resettingHistory(async (_generation, _metric, _current, confirm) => {
    for (const count of [0, -1, 1.5, NaN, Infinity, 100_001]) { assert.equal(await confirm(count), false); }
    return { status: 'unchanged' };
  });
  assert.deepEqual(await f.resetPlaybackHistory(f.event, 'lastPlayed'), { status: 'unchanged' });
  assert.equal(f.historyConfirmations.length, 0);
});

test('history reset stops the original before confirmation and serializes gallery mutations', async t => {
  const f = await playbackFixture(t);
  const url = await deliveredPlayback(f); f.images[0].lastPlayed = 123; let finish!: () => void; let began!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; });
  f.confirmHistory(async () => {
    assert.equal((await f.response(url)).status, 404);
    began(); await new Promise<void>(resolve => { finish = resolve; }); return true;
  });
  const work = f.resetPlaybackHistory(f.event, 'lastPlayed'); await ready;
  assert.deepEqual(await f.resetPlaybackHistory(f.event, 'timesPlayed'), { status: 'busy' });
  assert.deepEqual(await f.page(), { status: 'busy' });
  assert.deepEqual(await f.setProtection(f.event, { autoLockMinutes: 5 }), { status: 'busy' });
  assert.deepEqual(await f.save(f.event, { id: f.id, revision: f.item.revision, notes: 'No', tags: [] }), { status: 'busy' });
  assert.deepEqual(await f.ackOriginalPlayback(f.event, url), { status: 'ignored' });
  f.stopOriginal(); finish(); assert.deepEqual(await work, { status: 'reset', count: 1 });
  assert.equal(f.images[0].lastPlayed, 0);
  const source = (await f.sources(f.event)).items[0]; assert.equal(source.connected, true, 'reset does not revoke source access');
});

for (const ending of ['lock', 'revocation', 'navigation', 'frame-replacement', 'dispose'] as const) {
  test(`history reset drains a native confirmation after ${ending} and refuses late approval`, async t => {
    const images = [image(0)]; images[0].lastPlayed = 123;
    const f = fixture(t, images); let finish!: () => void; let began!: () => void;
    const ready = new Promise<void>(resolve => { began = resolve; });
    f.confirmHistory(async () => { began(); await new Promise<void>(resolve => { finish = resolve; }); return true; });
    const work = f.resetPlaybackHistory(f.event, 'lastPlayed'); await ready;
    if (ending === 'lock') { f.lock(); }
    if (ending === 'revocation') { f.controller.abort(); }
    if (ending === 'navigation') { f.contents.emit('did-start-navigation', { isMainFrame: true, url: ENTRY, isSameDocument: false }); }
    if (ending === 'frame-replacement') { f.contents.mainFrame = { ...f.contents.mainFrame }; }
    let drained = false; const disposal = f.dispose().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
    finish(); assert.deepEqual(await work, { status: 'unavailable' }); await disposal;
    assert.equal(images[0].lastPlayed, 123); assert.equal(drained, true);
  });
}

for (const callback of ['session', 'confirmation'] as const) {
  test(`history reset registers drainage before synchronous ${callback} reentry`, async t => {
    const f = fixture(t); let disposal!: Promise<void>; let drained = false; let finish!: () => void;
    const reenter = async () => {
      disposal = f.dispose().then(() => { drained = true; });
      await new Promise<void>(resolve => { finish = resolve; });
      return true;
    };
    f.confirmHistory(reenter);
    f.resettingHistory(async (_generation, _metric, current, confirm) => {
      if (callback === 'session') { await reenter(); }
      else { assert.equal(await confirm(1), false); }
      assert.equal(current(), false); return { status: 'unchanged' };
    });
    const work = f.resetPlaybackHistory(f.event, 'timesPlayed');
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
    finish(); assert.deepEqual(await work, { status: 'unavailable' }); await disposal; assert.equal(drained, true);
  });
}

test('history reset pending a session failure sanitizes diagnostics and permits the next request', async t => {
  const f = fixture(t);
  f.resettingHistory(async () => { throw new Error('Secret source and catalogue diagnostic'); });
  assert.deepEqual(await f.resetPlaybackHistory(f.event, 'lastPlayed'), { status: 'unavailable' });
  assert.equal((await f.page()).status, 'ready');
  f.confirmHistory(async () => { throw new Error('Secret prompt failure'); });
  f.resettingHistory(async (_generation, _metric, _current, confirm) => { await confirm(1); return { status: 'unchanged' }; });
  assert.deepEqual(await f.resetPlaybackHistory(f.event, 'lastPlayed'), { status: 'unavailable' });
  assert.equal((await f.page()).status, 'ready');
});

test('history reset drains playback retirement before the session can read or confirm', async t => {
  const f = await playbackFixture(t); const active = await f.play();
  const stop = f.playback.stop.bind(f.playback); let finish!: () => void; let calls = 0;
  const mock = t.mock.method(f.playback, 'stop', () => {
    const drain = stop();
    if (++calls !== 1) { return drain; }
    return drain.then(() => new Promise<void>(resolve => { finish = resolve; }));
  });
  const work = f.resetPlaybackHistory(f.event, 'timesPlayed');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.historyResets.length, 0); assert.equal(f.historyConfirmations.length, 0);
  assert.equal((await f.response(active.url)).status, 404);
  let drained = false; const disposal = f.dispose().then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
  finish(); assert.deepEqual(await work, { status: 'unavailable' }); await disposal;
  assert.equal(f.historyResets.length, 0); assert.equal(drained, true); mock.mock.restore();
});

async function sourceCheckFixture(t: TestContext) {
  const f = await sourceFixture(t);
  f.images[0].fileSize = (await fs.stat(path.join(f.root, f.images[0].fileName))).size;
  const selected = (await f.detail(f.event, f.id)).item;
  const sourceId = (await f.sources(f.event)).items[0].id;
  return { ...f, selected, sourceId, runCheck: () => f.checkSource(f.event, sourceId),
    savedCatalogue: () => ({ images: f.images, inputDirs: { 0: { path: f.root } } } as unknown as FinalObject) };
}
const checkedSourceCounts = (extra: Record<string, number> = {}) => ({ status: 'checked', total: 1,
  sameSize: 1, differentSize: 0, missing: 0, unverified: 0, ignored: 0, ...extra });

test('saved file check returns count-only size comparisons after native authority without reading media contents', async t => {
  const f = await sourceCheckFixture(t);
  const row = (index: number, fileName: string, fileSize: number, partialPath = '') => ({ ...image(index),
    locations: undefined, fileName, partialPath, fileSize });
  f.images.push(row(1, 'different.mp4', 100), row(2, 'missing.mp4', 10), row(3, 'unknown.mp4', 0),
    row(4, 'linked.mp4', 10), row(5, 'ignored.mp4', 10, '/ignored'));
  await fs.writeFile(path.join(f.root, 'different.mp4'), 'different');
  await fs.writeFile(path.join(f.root, 'unknown.mp4'), 'unknown');
  await fs.symlink(path.join(f.root, 'synthetic.mp4'), path.join(f.root, 'linked.mp4'));
  const catalogue = f.savedCatalogue(); catalogue.inputDirs[0].ignoredSubdirectories = ['ignored']; f.catalogue(catalogue);
  const before = JSON.stringify(catalogue);
  const nativeFs: typeof import('node:fs') = require('node:fs');
  const open = t.mock.method(fs, 'open', () => { throw new Error('No media descriptors expected'); });
  const read = t.mock.method(fs, 'readFile', () => { throw new Error('No media contents expected'); });
  const syncRead = t.mock.method(nativeFs, 'readFileSync', () => { throw new Error('No media contents expected'); });
  const result = await f.runCheck();
  assert.deepEqual(result, checkedSourceCounts({ total: 6, differentSize: 1, missing: 1, unverified: 2, ignored: 1 }));
  assert.deepEqual(Object.keys(result).sort(), ['differentSize', 'ignored', 'missing', 'sameSize', 'status', 'total', 'unverified']);
  assert.doesNotMatch(JSON.stringify(result), /revision|path|synthetic|different.mp4|ignored.mp4/);
  assert.equal(f.picks(), 1); assert.equal(open.mock.callCount(), 0); assert.equal(read.mock.callCount(), 0);
  assert.equal(syncRead.mock.callCount(), 0); assert.equal(JSON.stringify(catalogue), before);
  assert.equal(f.edits.length, 0); assert.equal(f.historyWrites.length, 0); assert.equal(f.historyResets.length, 0);
});

test('saved file check rejects forged sources, paths, argument shapes, senders and frames before reading or picking', async t => {
  const f = await sourceCheckFixture(t); const reads = f.reads();
  for (const args of [[], [undefined], [null], [f.root], [{ id: f.sourceId }], ['f'.repeat(32)], [f.id], [f.sourceId, 'extra']]) {
    assert.deepEqual(await f.checkSource(f.event, ...args), { status: 'unavailable' });
  }
  for (const event of [{ ...f.event, sender: new Contents() },
    { ...f.event, senderFrame: { ...f.contents.mainFrame } }, { ...f.event, senderFrame: null }]) {
    assert.deepEqual(await f.checkSource(event, f.sourceId), { status: 'unavailable' });
  }
  assert.equal(f.reads(), reads); assert.equal(f.picks(), 0);
});

test('saved file check probes neither root nor files until the native grant picker returns', async t => {
  const f = await sourceCheckFixture(t);
  let picked = false;
  f.choose(async () => { picked = true; return f.root; });
  const nativeFs: typeof import('node:fs') = require('node:fs');
  const lstatSync = nativeFs.lstatSync;
  const lstat = fs.lstat;
  let probes = 0;
  t.mock.method(nativeFs, 'lstatSync', (...args: Parameters<typeof lstatSync>) => {
    assert.equal(picked, true); probes++; return lstatSync(...args);
  });
  t.mock.method(fs, 'lstat', (...args: Parameters<typeof lstat>) => {
    assert.equal(picked, true); probes++; return lstat(...args);
  });
  assert.deepEqual(await f.runCheck(), checkedSourceCounts());
  assert.ok(probes > 0); assert.equal(f.picks(), 1);
});

test('saved file check retains cached row IDs, preview URLs and editing revisions and reuses a valid grant', async t => {
  const f = await sourceCheckFixture(t);
  const detail = await f.detail(f.event, f.id); const before = await f.page();
  assert.deepEqual(await f.runCheck(), checkedSourceCounts());
  assert.deepEqual(await f.page(), before);
  assert.deepEqual(await f.runCheck(), checkedSourceCounts()); assert.equal(f.picks(), 1);
  assert.equal((await f.sources(f.event)).items[0].connected, true);
  assert.equal((await f.save(f.event, { id: f.id, revision: detail.item.revision,
    notes: 'Retained notes draft', tags: detail.item.tags, rating: detail.item.rating })).status, 'saved');
});

for (const ending of ['cancel', 'lock', 'navigate', 'abort', 'dispose'] as const) {
  test(`saved file check ${ending} drains a late picker and does not retain authority or a partial report`, async t => {
    const f = await sourceCheckFixture(t);
    let finish!: (value: string) => void; let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    f.choose(() => { begin(); return new Promise(resolve => { finish = resolve; }); });
    const helper = t.mock.method(sourceCheck, 'checkPrivateSource', async () => { throw new Error('Check was never admitted'); });
    const checking = f.runCheck(); await started;
    if (ending === 'cancel') { f.cancelSource(); }
    if (ending === 'lock') { f.lock(); }
    if (ending === 'navigate') { f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: ENTRY + '#other' }); }
    if (ending === 'abort') { f.controller.abort(); }
    let drained = false;
    const disposal = ending === 'cancel' ? undefined : f.dispose().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    finish(f.root);
    assert.deepEqual(await checking, { status: ending === 'cancel' ? 'cancelled' : 'unavailable' });
    await disposal; assert.equal(helper.mock.callCount(), 0);
    if (ending === 'cancel') { assert.equal((await f.sources(f.event)).items[0].connected, false); }
  });
}

test('saved file check owns the shared operation gate and ignores forged cancellation', async t => {
  const f = await sourceCheckFixture(t);
  let finish!: (value: string) => void; let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  f.choose(() => { begin(); return new Promise(resolve => { finish = resolve; }); });
  const checking = f.runCheck(); await started; const reads = f.reads();
  assert.deepEqual(await f.runCheck(), { status: 'busy' });
  assert.deepEqual(await f.connectSource(f.event, f.sourceId), { status: 'busy' });
  assert.deepEqual(await f.disconnectSource(f.event, f.sourceId), { status: 'busy' });
  assert.deepEqual(await f.page(), { status: 'busy' });
  assert.deepEqual(await f.protection(f.event), { status: 'busy' });
  assert.equal(f.reads(), reads);
  ipcMain.emit(channels.cancelSourceConnection, { ...f.event, senderFrame: { ...f.contents.mainFrame } });
  f.cancelSource('extra'); finish(f.root);
  assert.deepEqual(await checking, checkedSourceCounts());
});

test('saved file check is busy before metadata reads while another private operation is pending', async t => {
  const f = await sourceCheckFixture(t); let finish!: () => void;
  f.readProtection(() => new Promise(resolve => { finish = () => resolve({ autoLockMinutes: 5 }); }));
  const protection = f.protection(f.event); const reads = f.reads();
  assert.deepEqual(await f.runCheck(), { status: 'busy' }); assert.equal(f.reads(), reads); assert.equal(f.picks(), 0);
  finish(); await protection;
});

test('saved file check retires original playback before a native picker or file review', async t => {
  const f = await playbackFixture(t); const sourceId = (await f.sources(f.event)).items[0].id;
  const active = await f.play(); assert.equal(active.status, 'ready');
  assert.equal((await f.checkSource(f.event, sourceId)).status, 'checked');
  assert.equal((await f.response(active.url)).status, 404);
});

test('saved source replacement conflicts before the check picker and after its late selection', async t => {
  const f = await sourceCheckFixture(t); const catalogue = f.savedCatalogue();
  const changed = { ...catalogue, inputDirs: { 0: { path: f.root + '-new' } } } as unknown as FinalObject;
  f.catalogue(changed); assert.deepEqual(await f.runCheck(), { status: 'conflict' }); assert.equal(f.picks(), 0);
  f.catalogue(catalogue); f.choose(async () => { f.catalogue(changed); return f.root; });
  assert.deepEqual(await f.runCheck(), { status: 'conflict' });
  f.catalogue(catalogue); assert.equal((await f.sources(f.event)).items[0].connected, false);
});

for (const change of ['root', 'ignored', 'reference', 'size'] as const) {
  test(`saved file check rejects a concurrent ${change} change and retires its grant`, async t => {
    const f = await sourceCheckFixture(t); const catalogue = f.savedCatalogue(); f.catalogue(catalogue);
    const check = sourceCheck.checkPrivateSource;
    t.mock.method(sourceCheck, 'checkPrivateSource', async (...args: Parameters<typeof check>) => {
      const result = await check(...args);
      if (change === 'root') { catalogue.inputDirs[0].path += '-new'; }
      if (change === 'ignored') { catalogue.inputDirs[0].ignoredSubdirectories = ['ignored']; }
      if (change === 'reference') { catalogue.images[0].fileName = 'replacement.mp4'; }
      if (change === 'size') { catalogue.images[0].fileSize++; }
      return result;
    });
    assert.deepEqual(await f.runCheck(), { status: 'conflict' });
    catalogue.inputDirs[0].path = f.root;
    assert.equal((await f.sources(f.event)).items[0].connected, false);
  });
}

test('saved file check permits unrelated notes and history changes without reporting a source conflict', async t => {
  const f = await sourceCheckFixture(t); const check = sourceCheck.checkPrivateSource;
  t.mock.method(sourceCheck, 'checkPrivateSource', async (...args: Parameters<typeof check>) => {
    const result = await check(...args); f.images[0].notes = 'External notes'; f.images[0].lastPlayed = 100; return result;
  });
  assert.deepEqual(await f.runCheck(), checkedSourceCounts()); assert.equal(f.images[0].notes, 'External notes');
});

for (const ending of ['cancel', 'dispose'] as const) {
  test(`saved file check registers drainage before ${ending} reentry from the helper`, async t => {
    const f = await sourceCheckFixture(t); let finish!: () => void; let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    let drained = false; let disposal: Promise<void> | undefined;
    t.mock.method(sourceCheck, 'checkPrivateSource', async (options: Parameters<typeof sourceCheck.checkPrivateSource>[0]) => {
      if (ending === 'cancel') { f.cancelSource(); } else { disposal = f.dispose().then(() => { drained = true; }); }
      assert.equal(options.isCurrent(), false); begin();
      await new Promise<void>(resolve => { finish = resolve; });
      return { ...checkedSourceCounts(), revision: 'f'.repeat(64) } as any;
    });
    const checking = f.runCheck(); await started;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    finish(); assert.deepEqual(await checking, { status: ending === 'cancel' ? 'cancelled' : 'unavailable' });
    await disposal;
    if (ending === 'cancel') { assert.equal((await f.sources(f.event)).items[0].connected, false); }
  });
}

test('saved file check loses a disconnected root as unavailable rather than counting every file missing', async t => {
  const f = await sourceCheckFixture(t);
  t.mock.method(sourceCheck, 'checkPrivateSource', async options => {
    await fs.rm(f.root, { recursive: true, force: true }); assert.equal(options.isCurrent(), false);
    return { status: 'cancelled' };
  });
  assert.deepEqual(await f.runCheck(), { status: 'source-unavailable' });
});

for (const status of ['cancelled', 'invalid', 'limit', 'source-unavailable'] as const) {
  test(`saved file check returns ${status} without counts or diagnostic fields`, async t => {
    const f = await sourceCheckFixture(t);
    t.mock.method(sourceCheck, 'checkPrivateSource', async () => ({ status, path: '/private/source', total: 1 } as any));
    assert.deepEqual(await f.runCheck(), { status });
    assert.equal((await f.sources(f.event)).items[0].connected, false);
  });
}

for (const fault of ['sum', 'negative', 'fraction', 'oversize', 'nan', 'extra', 'revision', 'hidden', 'accessor', 'unknown-status'] as const) {
  test(`saved file check rejects a malformed ${fault} count report without private data`, async t => {
    const f = await sourceCheckFixture(t); let getterCalls = 0;
    t.mock.method(sourceCheck, 'checkPrivateSource', async () => {
      const result: any = { ...checkedSourceCounts(), revision: sourceCheck.privateSourceCheckRevision(f.savedCatalogue(), 0) };
      if (fault === 'sum') { result.total = 2; }
      if (fault === 'negative') { result.missing = -1; }
      if (fault === 'fraction') { result.sameSize = 0.5; }
      if (fault === 'oversize') { result.total = result.sameSize = 10_001; }
      if (fault === 'nan') { result.total = NaN; }
      if (fault === 'extra') { result.path = '/private/path'; }
      if (fault === 'revision') { result.revision = '/private/revision'; }
      if (fault === 'hidden') { Object.defineProperty(result, 'total', { value: 1, enumerable: false }); }
      if (fault === 'accessor') { Object.defineProperty(result, 'total', { get: () => { getterCalls++; return 1; }, enumerable: true }); }
      if (fault === 'unknown-status') { result.status = '/private/diagnostic'; }
      return result;
    });
    assert.deepEqual(await f.runCheck(), { status: 'invalid' }); assert.equal(getterCalls, 0);
  });
}

test('saved file check hides helper exceptions and drops its provisional grant', async t => {
  const f = await sourceCheckFixture(t);
  t.mock.method(sourceCheck, 'checkPrivateSource', async () => { throw new Error('/private/source/file.mp4'); });
  assert.deepEqual(await f.runCheck(), { status: 'source-unavailable' });
  assert.equal((await f.sources(f.event)).items[0].connected, false);
});

for (const callback of ['catalogue', 'picker'] as const) {
  test(`saved file check drains disposal reentered inside its first ${callback} callback`, async t => {
    const f = await sourceCheckFixture(t); let finish!: () => void; let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    let drained = false; let disposal: Promise<void> | undefined;
    const reenter = async () => {
      disposal = f.dispose().then(() => { drained = true; }); begin();
      await new Promise<void>(resolve => { finish = resolve; });
    };
    if (callback === 'catalogue') { f.read(async () => { await reenter(); return f.savedCatalogue(); }); }
    else { f.choose(async () => { await reenter(); return f.root; }); }
    const checking = f.runCheck(); await started;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    finish(); assert.deepEqual(await checking, { status: 'unavailable' }); await disposal;
    assert.equal(drained, true);
  });
}

test('saved file check cancellation during post-picker metadata recheck removes the late grant', async t => {
  const f = await sourceCheckFixture(t);
  f.choose(async () => { f.read(async () => { f.cancelSource(); return f.savedCatalogue(); }); return f.root; });
  assert.deepEqual(await f.runCheck(), { status: 'cancelled' });
  f.read(async () => f.savedCatalogue()); f.choose(async () => f.root);
  assert.equal((await f.sources(f.event)).items[0].connected, false);
  assert.deepEqual(await f.runCheck(), checkedSourceCounts()); assert.equal(f.picks(), 2);
});


test('video refresh uses a new main-owned namespace, projects stored metadata and preserves the public row id', async t => {
  const f = await sourceFixture(t);
  assert.equal(f.item.refreshable, true);
  f.images[0].screens = 0;
  const selected = (await f.detail(f.event, f.id)).item;
  assert.equal(selected.regenerable, false, 'refresh does not require old preview geometry');
  assert.equal(selected.refreshable, true);
  let captured: Parameters<PrivateHubSession['refreshVideo']>[1] | undefined;
  f.refreshing(async (generation, source, location, update, options) => {
    assert.equal(generation, 7); assert.equal(update.index, 0);
    assert.equal(update.revision, privateVideoRevision(f.images[0]));
    assert.equal(options.isCurrent(), true); assert.equal(options.signal?.aborted, false);
    assert.match(source.hash, /^[a-f0-9]{32}$/); assert.notEqual(source.hash, 'hash-0');
    assert.equal(source.hash, location.hash); assert.equal(location.root, f.root);
    captured = source;
    f.images[0] = { ...f.images[0], hash: source.hash, width: 320, height: 180, duration: 7, screens: 4, fileSize: 99 };
    return { status: 'refreshed', image: { ...f.images[0], duration: 999 } };
  });
  const result = await f.refresh(selected.revision);
  assert.equal(result.status, 'refreshed'); assert.equal(result.item.id, f.id);
  assert.equal(result.item.duration, 7, 'actual stored image wins over session return');
  assert.equal(result.item.width, 320); assert.equal(result.item.height, 180);
  assert.equal(result.item.notes, selected.notes); assert.deepEqual(result.item.tags, selected.tags);
  assert.equal(result.item.rating, selected.rating);
  assert.notEqual(result.item.revision, selected.revision);
  assert.match(result.item.thumbnailUrl, new RegExp('/' + captured!.hash + '\\.jpg'));
  assert.equal(captured!.isCurrent(), false);
  assert.equal((await f.page()).items[0].id, f.id);
  assert.equal((await f.detail(f.event, f.id)).item.duration, 7);
  assert.doesNotMatch(JSON.stringify(result), /gallery-source-|synthetic\.mp4|partialPath|fileName|inputDirs/);
  assert.deepEqual(await f.refresh(), { status: 'conflict' });
  assert.equal((await f.refresh(result.item.revision)).status, 'refreshed');
  assert.equal(f.picks(), 1, 'successful refresh keeps only the private window grant');
});

for (const kind of ['alias', 'duplicate', 'tombstone', 'folder-hash', 'ignored', 'invalid-root', 'invalid-location']) {
  test(`refresh eligibility refuses ${kind} without acquiring original access`, async t => {
    const f = await sourceFixture(t);
    if (kind === 'alias') { f.images[0].locations = [{ inputSource: 0, partialPath: '/', fileName: 'synthetic.mp4' },
      { inputSource: 0, partialPath: '/', fileName: 'alias.mp4' }]; }
    if (['duplicate', 'tombstone', 'folder-hash'].includes(kind)) {
      f.images.push({ ...f.images[0], fileName: 'other.mp4', deleted: kind === 'tombstone',
        ...(kind === 'folder-hash' ? { cleanName: '*FOLDER*' } : {}) });
    }
    if (kind === 'ignored') { f.images[0].partialPath = '/ignored'; }
    if (kind === 'invalid-location') { f.images[0].fileName = '../bad.mp4'; }
    f.catalogue({ images: f.images, inputDirs: { 0: { path: kind === 'invalid-root' ? '/' : f.root,
      ...(kind === 'ignored' ? { ignoredSubdirectories: ['ignored'] } : {}) } } } as unknown as FinalObject);
    // Changed locations retire the existing selection under the ordinary detail guard.
    const result = await f.refresh();
    assert.ok(['invalid', 'conflict'].includes(result.status));
    assert.equal(f.picks(), 0);
  });
}

test('refresh projection disables ambiguous hashes including tombstones while preserving editing', async t => {
  const f = await sourceFixture(t);
  f.images.push({ ...f.images[0], deleted: true });
  const selected = (await f.detail(f.event, f.id)).item;
  assert.equal(selected.refreshable, false); assert.equal(selected.editable, true);
  assert.deepEqual(await f.refresh(selected.revision), { status: 'unavailable' });
  assert.equal(f.picks(), 0);
});

test('refresh accepts only an exact opaque data request and trusted main frame', async t => {
  const f = await sourceFixture(t);
  let getter = false;
  const accessor = { id: f.id, get revision() { getter = true; return f.item.revision; } };
  const symbol = { id: f.id, revision: f.item.revision, [Symbol('path')]: f.root };
  const hidden = Object.defineProperty({ id: f.id, revision: f.item.revision }, 'path', { value: f.root });
  for (const value of [undefined, null, [], {}, accessor, symbol, hidden,
    { id: f.id, revision: f.item.revision, path: f.root }, { id: f.id, revision: 'bad' }]) {
    assert.deepEqual(await f.refreshVideo(f.event, value), { status: 'invalid' });
  }
  assert.equal(getter, false);
  assert.deepEqual(await f.refreshVideo(f.event, { id: f.id, revision: f.item.revision }, true), { status: 'invalid' });
  assert.deepEqual(await f.refreshVideo(f.event, { id: 'f'.repeat(32), revision: f.item.revision }), { status: 'unavailable' });
  assert.deepEqual(await f.refreshVideo({ ...f.event, sender: new Contents() }, { id: f.id, revision: f.item.revision }), { status: 'unavailable' });
  assert.deepEqual(await f.refreshVideo({ ...f.event, senderFrame: new Contents().mainFrame }, { id: f.id, revision: f.item.revision }), { status: 'unavailable' });
  assert.equal(f.picks(), 0);
});

for (const when of ['before-picker', 'in-picker']) {
  for (const change of (when === 'before-picker' ? ['notes', 'row-moved', 'alias', 'ignored', 'duplicate-hash']
    : ['notes', 'row-moved', 'root', 'alias', 'ignored', 'duplicate-hash'])) {
    test(`refresh refuses ${change} changed ${when} and refreshes or retires cached authority`, async t => {
      const f = await sourceFixture(t);
      const mutate = () => {
        if (change === 'notes') { f.images[0].notes = 'newer edit'; }
        if (change === 'row-moved') { f.images.unshift({ ...image(42), locations: undefined }); }
        if (change === 'alias') { f.images[0].locations = [{ inputSource: 0, fileName: 'different.mp4', partialPath: '/' }]; }
        if (change === 'duplicate-hash') { f.images.push({ ...f.images[0], deleted: true }); }
        f.catalogue({ images: f.images, inputDirs: { 0: { path: change === 'root' ? path.dirname(f.root) : f.root,
          ...(change === 'ignored' ? { ignoredSubdirectories: ['/blocked'] } : {}) } } } as unknown as FinalObject);
        if (change === 'ignored') { f.images[0].partialPath = '/blocked'; }
      };
      if (when === 'before-picker') { mutate(); }
      else { f.choose(async () => { mutate(); return f.root; }); }
      f.refreshing(async () => { assert.fail('changed source must not generate'); });
      const result = await f.refresh();
      assert.ok(['conflict', 'invalid', 'wrong-folder'].includes(result.status));
      assert.equal(f.picks(), when === 'before-picker' ? 0 : 1);
      if (change === 'row-moved' || change === 'alias' || change === 'ignored') {
        assert.deepEqual(await f.detail(f.event, f.id), { status: 'unavailable' });
      }
      if (change === 'notes') { assert.equal((await f.detail(f.event, f.id)).item.notes, 'newer edit'); }
    });
  }
}

test('cancelled and wrong-folder refresh returns bounded status and preserves stored details', async t => {
  const f = await sourceFixture(t);
  f.choose(async () => undefined);
  assert.deepEqual(await f.refresh(), { status: 'cancelled' });
  let current = (await f.detail(f.event, f.id)).item;
  assert.equal(current.notes, f.item.notes);
  f.choose(async () => path.dirname(f.root));
  assert.deepEqual(await f.refresh(current.revision), { status: 'wrong-folder' });
  current = (await f.detail(f.event, f.id)).item;
  f.choose(async () => f.root); await fs.unlink(path.join(f.root, 'synthetic.mp4'));
  assert.deepEqual(await f.refresh(current.revision), { status: 'source-unavailable' });
});

for (const ending of ['cancel', 'lock', 'dispose', 'abort', 'navigate', 'replace-frame']) {
  test(`refresh picker and every pending gate drain safely after ${ending}`, async t => {
    const f = await sourceFixture(t);
    let finish!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.choose(() => { started(); return new Promise(resolve => { finish = () => resolve(f.root); }); });
    f.refreshing(async () => { assert.fail('revoked picker must not refresh'); });
    const work = f.refresh(); await ready;
    assert.deepEqual(await f.page(), { status: 'busy' });
    assert.deepEqual(await f.run(), { status: 'busy' });
    assert.deepEqual(await f.refresh(), { status: 'busy' });
    assert.deepEqual(await f.save(f.event, { id: f.id, revision: f.item.revision, notes: '', tags: [] }), { status: 'busy' });
    let drain: Promise<void> | undefined;
    if (ending === 'cancel') { f.cancel(); }
    if (ending === 'lock') { f.lock(); drain = f.dispose(); }
    if (ending === 'dispose') { drain = f.dispose(); }
    if (ending === 'abort') { f.controller.abort(); }
    if (ending === 'navigate') { f.contents.emit('did-start-navigation', { isMainFrame: true, url: ENTRY }); }
    if (ending === 'replace-frame') { f.contents.mainFrame = new Contents().mainFrame; }
    let drained = false; void drain?.then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    finish(); assert.deepEqual(await work, { status: ending === 'cancel' ? 'cancelled' : 'unavailable' });
    await drain;
  });
}

for (const ending of ['cancel', 'throw', 'cancel-throw']) {
  test(`refresh reconciles actual saved metadata after uncertain publication: ${ending}`, async t => {
    const f = await sourceFixture(t);
    let started!: () => void; let finish!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    let hash = '';
    f.refreshing(async (_generation, source) => {
      hash = source.hash;
      f.images[0] = { ...f.images[0], hash, duration: 9, width: 600, height: 400, screens: 8 };
      started(); await release;
      if (ending.includes('throw')) { throw new Error('private path diagnostics'); }
      return { status: 'refreshed', image: f.images[0] };
    });
    const work = f.refresh(); await ready;
    if (ending.includes('cancel')) { f.cancel(); }
    assert.deepEqual(await f.detail(f.event, f.id), { status: 'busy' });
    finish(); assert.deepEqual(await work, { status: ending.includes('cancel') ? 'cancelled' : 'unavailable' });
    const selected = (await f.detail(f.event, f.id)).item;
    assert.equal(selected.duration, 9); assert.equal(selected.width, 600); assert.equal(selected.id, f.id);
    assert.ok(selected.thumbnailUrl.includes(hash)); assert.notEqual(selected.revision, f.item.revision);
    assert.equal((await f.page()).items[0].duration, 9);
    assert.equal((await f.refresh(selected.revision)).status, ending.includes('throw') ? 'unavailable' : 'refreshed');
    assert.equal(f.picks(), 2, 'failed/cancelled operation retires its grant');
  });
}

test('cancelled published refresh retires a row moved to another index before completion', async t => {
  const f = await sourceFixture(t);
  f.refreshing(async (_generation, source) => {
    f.images[0] = { ...f.images[0], hash: source.hash, duration: 7 };
    f.images.unshift({ ...image(42), locations: undefined });
    f.cancel(); return { status: 'refreshed', image: f.images[1] };
  });
  assert.deepEqual(await f.refresh(), { status: 'conflict' });
  assert.deepEqual(await f.detail(f.event, f.id), { status: 'unavailable' });
  assert.deepEqual(await f.save(f.event, { id: f.id, revision: f.item.revision, notes: 'wrong row', tags: [] }), { status: 'unavailable' });
  assert.notEqual((await f.page()).items[1].id, f.id);
});

for (const callback of ['reader', 'picker', 'session']) {
  test(`refresh registers drainage before reentrant disposal in ${callback}`, async t => {
    const f = await sourceFixture(t);
    let entered!: () => void; let finish!: () => void; let drain: Promise<void> | undefined;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const reenter = () => { drain = f.dispose(); entered(); return hold; };
    if (callback === 'reader') { f.read(async () => { await reenter(); return { images: f.images,
      inputDirs: { 0: { path: f.root } } } as unknown as FinalObject; }); }
    if (callback === 'picker') { f.choose(async () => { await reenter(); return f.root; }); }
    if (callback === 'session') { f.refreshing(async () => { await reenter(); return { status: 'conflict' }; }); }
    const work = f.refresh(); await ready;
    let drained = false; void drain!.then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
    finish(); assert.deepEqual(await work, { status: 'unavailable' }); await drain;
  });
}

test('refresh quarantines source-finalizer failure and never acknowledges the new row', async t => {
  const f = await sourceFixture(t);
  let restore: (() => Promise<void>) | undefined;
  f.expectQuarantinedDisposal();
  f.refreshing(async (_generation, source) => {
    restore = failSourceDescriptorClose(t, path.join(f.root, 'synthetic.mp4')); await source.open();
    f.images[0] = { ...f.images[0], hash: source.hash };
    return { status: 'refreshed', image: f.images[0] };
  });
  try {
    assert.deepEqual(await f.refresh(), { status: 'unavailable' });
    assert.ok(f.locks() >= 1); assert.deepEqual(await f.page(), { status: 'unavailable' });
    await assert.rejects(f.dispose(), /Private gallery cleanup unavailable/);
  } finally { await restore?.(); }
});


test('refresh reread failure retires the stale cached identity after uncertain publication', async t => {
  const f = await sourceFixture(t);
  f.refreshing(async (_generation, source) => {
    f.images[0] = { ...f.images[0], hash: source.hash };
    f.read(async () => { throw new Error('Private stored catalogue details'); });
    return { status: 'refreshed', image: f.images[0] };
  });
  assert.deepEqual(await f.refresh(), { status: 'unavailable' });
  assert.deepEqual(await f.detail(f.event, f.id), { status: 'unavailable' });
  assert.deepEqual(await f.save(f.event, { id: f.id, revision: f.item.revision, notes: '', tags: [] }), { status: 'unavailable' });
});

test('refresh changed row metadata updates sorting using the stored measurements', async t => {
  const f = await sourceFixture(t, undefined, [{ ...image(1), fileName: 'other.mp4', partialPath: '',
    locations: undefined, fileSize: 80, duration: 20 }]);
  const query = { query: '', offset: 0, sort: 'duration', direction: 'asc' };
  assert.notEqual((await f.list(f.event, query)).items[0].id, f.id);
  f.refreshing(async (_generation, source) => {
    f.images[0] = { ...f.images[0], hash: source.hash, fileSize: 100, duration: 10 };
    return { status: 'refreshed', image: f.images[0] };
  });
  assert.equal((await f.refresh()).status, 'refreshed');
  const result = await f.list(f.event, query);
  assert.equal(result.items[0].id, f.id); assert.equal(result.items[0].duration, 10);
  const bySize = await f.list(f.event, { ...query, sort: 'file-size', direction: 'desc' });
  assert.equal(bySize.items[0].id, f.id);
});

test('refresh closes original playback before requesting file access', async t => {
  let stops = 0;
  const playback = { stop: async () => { stops++; }, dispose: async () => undefined } as unknown as PrivateSourcePlayback;
  const f = await sourceFixture(t, playback);
  const before = stops;
  f.choose(async () => { assert.ok(stops > before); return f.root; });
  assert.equal((await f.refresh()).status, 'refreshed');
});
