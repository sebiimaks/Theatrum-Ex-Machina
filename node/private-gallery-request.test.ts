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
  copyDestination: (() => Promise<string | undefined>) | null = async () => '/synthetic-copy') {
  const contents = new Contents(); contents.url = initialUrl; contents.mainFrame.url = initialUrl;
  const controller = new AbortController();
  let current = true;
  let reads = 0;
  let locks = 0;
  let hubLocks = 0;
  let locking: PrivateHubSession['lock'] = async () => { current = false; controller.abort(); };
  const edits: unknown[] = [];
  let protectionValue = { autoLockMinutes: 5 as 0 | 1 | 5 | 15 | 30 };
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
  let writing: PrivateHubSession['updateVideoMetadata'] = async (generation, request, current) => {
    assert.equal(generation, 7); assert.equal(current(), true);
    const selected = images[request.index];
    if (!selected || privateVideoRevision(selected) !== request.revision) { return { status: 'conflict' }; }
    images[request.index] = { ...selected, notes: request.notes, tags: [...request.tags] };
    return { status: 'saved', image: images[request.index] };
  };
  const hub = {
    isCurrent: (generation: number) => generation === 7 && current && !controller.signal.aborted,
    revocationSignal: () => controller.signal,
    lock: (...args: Parameters<PrivateHubSession['lock']>) => { hubLocks++; return locking(...args); },
    readCatalogue: (generation: number) => { assert.equal(generation, 7); reads++; return reading(); },
    updateVideoMetadata: (...args: Parameters<PrivateHubSession['updateVideoMetadata']>) => {
      edits.push(args[1]); return writing(...args);
    },
    generatePreviews: (...args: Parameters<PrivateHubSession['generatePreviews']>) => generating(...args),
    readProtection: () => readingProtection(),
    touchIdStatus: async () => 'disabled',
    enableTouchId: async () => 'enabled',
    disableTouchId: async () => 'disabled',
    updateProtection: (...args: Parameters<PrivateHubSession['updateProtection']>) => writingProtection(...args),
    changePassword: (...args: Parameters<PrivateHubSession['changePassword']>) => changingPassword(...args),
    createUnprotectedCopy: (...args: Parameters<PrivateHubSession['createUnprotectedCopy']>) => copying(...args),
  } as unknown as PrivateHubSession;
  const options = { contents: contents as unknown as WebContents, hub, generation: 7,
    isCurrent: () => current, onLock: () => lockAction(), chooseSourceDirectory,
    onProtectionChanged: (value: unknown) => applyingProtection(value),
    chooseUnprotectedCopyDestination: copyDestination ? () => choosingCopyDestination!() : undefined };
  const dispose = register(options);
  let expectQuarantined = false;
  t.after(async () => {
    if (expectQuarantined) { await assert.rejects(dispose(), /Private gallery cleanup unavailable/); }
    else { await dispose(); }
    assert.equal(handlers.size, 0); assert.equal(ipcMain.listenerCount(channels.lock), 0);
    assert.equal(ipcMain.listenerCount(channels.cancelUnprotectedCopy), 0);
  });
  const list = handlers.get(channels.list)!;
  const detail = handlers.get(channels.detail)!;
  const save = handlers.get(channels.save)!;
  const regenerate = handlers.get(channels.regenerate)!;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { contents, controller, options, event, list, detail, save, regenerate, dispose, edits,
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

async function sourceFixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'gallery-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const images = [{ ...image(0), fileName: 'synthetic.mp4', partialPath: '', locations: undefined, screens: 3 }];
  await fs.writeFile(path.join(root, images[0].fileName), 'Synthetic source descriptor contents');
  let picks = 0;
  let choosing = async (_root: string): Promise<string | undefined> => root;
  const f = fixture(t, images, ENTRY, requested => { picks++; assert.equal(requested, root); return choosing(requested); });
  let catalogue = { images, inputDirs: { 0: { path: root } } } as unknown as FinalObject;
  f.read(async () => catalogue);
  const id = (await f.page()).items[0].id;
  const item = (await f.detail(f.event, id)).item;
  return { ...f, root, images, id, item, picks: () => picks,
    choose: (next: typeof choosing) => { choosing = next; },
    catalogue: (next: FinalObject) => { catalogue = next; },
    run: (revision = item.revision) => f.regenerate(f.event, { id, revision }),
  };
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
