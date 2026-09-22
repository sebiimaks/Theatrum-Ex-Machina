import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { normalOperationScope } from './normal-operation-scope';
import { GLOBALS } from './main-globals';
import { NORMAL_CATALOGUE_STORAGE } from './catalogue-storage';
import { NewImageElement } from '../interfaces/final-object.interface';
import { buildCatalogueMediaLocationAuthority } from './catalogue-media-authority';
import { createCatalogueMetadataExport } from '../interfaces/catalogue-metadata-transfer';

type Listener = (event: any, ...args: any[]) => any;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
let openDialog: () => Promise<any> = async () => ({ canceled: true, filePaths: [] });
let saveDialog: () => Promise<any> = async () => ({ canceled: true });
let messageBox: () => Promise<any> = async () => ({ response: 0 });
let openPath: () => Promise<string> = async () => '';
let playlistWrite = async (destination: string, items: unknown[]): Promise<void> => { await fs.writeFile(destination, JSON.stringify(items)); };
let nativeCalls = 0;
const image = { isEmpty: () => false, resize() { return this; }, toPNG: () => Buffer.alloc(0) };
const NodeModule = require('node:module'); const originalLoad = NodeModule._load;
let setUp: typeof import('./main-ipc').setUpIpcMessages;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') {
      return {
        app: {}, BrowserWindow: { getFocusedWindow: () => undefined },
        dialog: {
          showOpenDialog: () => { nativeCalls++; return openDialog(); },
          showSaveDialog: () => { nativeCalls++; return saveDialog(); },
          showMessageBox: () => { nativeCalls++; return messageBox(); },
        },
        nativeImage: { createFromBuffer: () => image, createFromPath: () => image },
        powerSaveBlocker: { start: () => 1, stop: () => undefined },
        shell: { openPath: () => { nativeCalls++; return openPath(); } },
      };
    }
    if (request === './main-support') {
      const support = originalLoad.call(this, request, ...args);
      return { ...support, createDotPlsFile: (destination: string, items: unknown[], done: (error?: Error) => void) => {
        void playlistWrite(destination, items).then(() => done(), done);
      } };
    }
    return originalLoad.call(this, request, ...args);
  };
  setUp = require('./main-ipc').setUpIpcMessages;
} finally { NodeModule._load = originalLoad; }

async function fixture(t: TestContext) {
  const root = path.resolve(__dirname, '..', 'tmp'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'normal-ipc-drain-'));
  const previous = { ...GLOBALS };
  const on = new Map<string, Listener>(); const handle = new Map<string, Listener>(); const messages: unknown[][] = [];
  const errors: unknown[][] = [];
  let trusted = true; let closeCalls = 0;
  const event = { sender: { id: 1, isDestroyed: () => false, send: (...args: unknown[]) => messages.push(args) } };
  const window = { isDestroyed: () => false, close: () => { closeCalls++; }, webContents: { id: 1 } };
  const item = { ...NewImageElement(), hash: 'synthetic', cleanName: 'Synthetic', fileName: 'synthetic.mp4', partialPath: '', inputSource: 0 };
  const cataloguePath = path.join(directory, 'normal.scaena');
  await fs.writeFile(cataloguePath, '{}'); await fs.writeFile(path.join(directory, item.fileName), 'synthetic fixture');
  Object.assign(GLOBALS, {
    catalogueStorage: NORMAL_CATALOGUE_STORAGE, catalogueSessionGeneration: 7,
    catalogueTransitionActive: false, cataloguePersistenceActive: false, catalogueAccessMode: 'read-write',
    currentlyOpenVhaFile: cataloguePath, hubName: 'Synthetic', settingsPath: directory,
    authorizedCatalogueMediaLocations: buildCatalogueMediaLocationAuthority([item]), authorizedCatalogueImageHashes: new Set([item.hash]),
    authorizedCataloguePaths: new Set([cataloguePath]), winRef: window, readyToQuit: false,
    authorizedSourceFolderPaths: new Set([directory]), authorizedSourceFolderRealPaths: new Map([[directory, directory]]),
    authorizedSourceWatchPaths: new Set(), selectedSourceFolders: { 0: { path: directory, watch: false } },
    pendingInputDirectorySelections: new Set(), pendingOutputDirectorySelections: new Set(), preferredVideoPlayer: '',
    requestCatalogueOpenDispatch: undefined,
  });
  nativeCalls = 0;
  t.mock.method(console, 'warn', () => undefined); t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); }); t.mock.method(console, 'log', () => undefined);
  t.after(async () => {
    normalOperationScope.resume(await normalOperationScope.seal());
    Object.assign(GLOBALS, previous); await fs.rm(directory, { recursive: true, force: true });
  });
  setUp({ on: (key: string, listener: Listener) => on.set(key, listener), handle: (key: string, listener: Listener) => handle.set(key, listener) },
    window, directory, {}, () => trusted);
  return { directory, on, handle, event, messages, errors, item, untrust: () => { trusted = false; }, closeCalls: () => closeCalls };
}

for (const channel of ['choose-input', 'choose-output', 'reconnect-this-folder', 'select-default-video-player']) {
  test(`${channel} holds the drain until its native dialog returns and grants no late authority`, async t => {
    const f = await fixture(t); const dialog = deferred<any>(); openDialog = () => dialog.promise;
    const running = f.on.get(channel)!(f.event, 0);
    assert.equal(nativeCalls, 1); assert.equal(normalOperationScope.pendingCount, 1);
    const draining = normalOperationScope.seal(); let drained = false;
    void draining.then(() => { drained = true; });
    await f.on.get(channel)!(f.event, 0); assert.equal(nativeCalls, 1);
    await turn(); assert.equal(drained, false);
    dialog.resolve({ canceled: false, filePaths: [f.directory] });
    await running; normalOperationScope.assertDrained(await draining);
    assert.equal(GLOBALS.pendingInputDirectorySelections.size, 0);
    assert.equal(GLOBALS.pendingOutputDirectorySelections.size, 0);
    assert.equal(GLOBALS.preferredVideoPlayer, '');
    assert.deepEqual(f.messages, []);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['normal.scaena', 'synthetic.mp4']);
  });
}

test('queued metadata export returns a generic cancellation and never writes after sealing', async t => {
  const f = await fixture(t); const dialog = deferred<any>(); saveDialog = () => dialog.promise;
  const document = createCatalogueMetadataExport([{ ...f.item, notes: 'SYNTHETIC_NOTE' }]).document;
  const running = f.handle.get('export-catalogue-metadata')!(f.event, document);
  const draining = normalOperationScope.seal();
  dialog.resolve({ canceled: false, filePath: path.join(f.directory, 'export.json') });
  const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
  normalOperationScope.assertDrained(await draining);
  await assert.rejects(fs.stat(path.join(f.directory, 'export.json')), { code: 'ENOENT' });
});

test('native media launch completion is drained and cannot reply into a replaced frame', async t => {
  const f = await fixture(t); const launch = deferred<string>(); openPath = () => launch.promise;
  const running = f.on.get('open-media-file')!(f.event, f.item);
  assert.equal(nativeCalls, 1);
  f.untrust(); launch.resolve('SYNTHETIC_SOURCE_PATH cannot be opened'); await running;
  assert.deepEqual(f.messages, []);
  assert.equal(JSON.stringify(f.errors).includes('SYNTHETIC_SOURCE_PATH'), false);
});

test('playlist creation callback and revoked temporary-file cleanup both finish before drain', async t => {
  const f = await fixture(t); const writing = deferred(); const entered = deferred();
  playlistWrite = async (destination, items) => { entered.resolve(); await writing.promise; await fs.writeFile(destination, JSON.stringify(items)); };
  const running = f.on.get('please-create-playlist')!(f.event, [f.item]);
  await entered.promise;
  const draining = normalOperationScope.seal(); let drained = false;
  void draining.then(() => { drained = true; });
  await turn(); assert.equal(drained, false);
  writing.resolve(); await running; await draining;
  assert.equal(nativeCalls, 0); assert.deepEqual(f.messages, []);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['normal.scaena', 'synthetic.mp4']);
});

test('sealing retires an already launched playlist timer and drains cleanup immediately', async t => {
  const f = await fixture(t); const launched = deferred();
  playlistWrite = async (destination, items) => { await fs.writeFile(destination, JSON.stringify(items)); };
  openPath = async () => { launched.resolve(); return ''; };
  const running = f.on.get('please-create-playlist')!(f.event, [f.item]);
  await launched.promise; await turn();
  assert.equal(normalOperationScope.pendingCount, 2);
  await normalOperationScope.seal(); await running;
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['normal.scaena', 'synthetic.mp4']);
});

test('close failure dialogs remain in the operation drain and cannot close after revocation', async t => {
  const f = await fixture(t); const dialog = deferred<any>(); const entered = deferred();
  messageBox = () => { entered.resolve(); return dialog.promise; };
  const running = f.on.get('close-window')!(f.event, null, null);
  await entered.promise;
  const draining = normalOperationScope.seal(); let drained = false;
  void draining.then(() => { drained = true; });
  await turn(); assert.equal(drained, false);
  dialog.resolve({ response: 0 }); await running; await draining;
  assert.equal(f.closeCalls(), 0); assert.equal(GLOBALS.cataloguePersistenceActive, false);
});

for (const changed of ['frame', 'generation'] as const) {
  test(`native source selection is discarded after the ${changed} changes without sealing`, async t => {
    const f = await fixture(t); const dialog = deferred<any>(); openDialog = () => dialog.promise;
    const running = f.on.get('choose-input')!(f.event);
    if (changed === 'frame') { f.untrust(); } else { GLOBALS.catalogueSessionGeneration++; }
    dialog.resolve({ canceled: false, filePaths: [f.directory] }); await running;
    assert.equal(GLOBALS.pendingInputDirectorySelections.size, 0);
    assert.equal(GLOBALS.pendingOutputDirectorySelections.size, 0);
    assert.deepEqual(f.messages, []);
  });
}

test('a current native selection still grants its explicit source and wizard output directory', async t => {
  const f = await fixture(t); openDialog = async () => ({ canceled: false, filePaths: [f.directory] });
  await f.on.get('choose-input')!(f.event);
  assert.equal(GLOBALS.pendingInputDirectorySelections.has(f.directory), true);
  assert.equal(GLOBALS.pendingOutputDirectorySelections.has(f.directory), true);
  assert.deepEqual(f.messages, [['input-folder-chosen', f.directory]]);
});
