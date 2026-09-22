import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { GLOBALS } from './main-globals';
import { NORMAL_CATALOGUE_STORAGE } from './catalogue-storage';
import { NormalOperationScope } from './normal-operation-scope';
import type { PrivateHubSession } from './private-hub-session';
import { createCatalogueMetadataExport } from '../interfaces/catalogue-metadata-transfer';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';

type Listener = (event: any, ...args: any[]) => any;
let nativeCalls = 0;
let saveDialog: () => Promise<unknown> = async () => ({ canceled: true });
const image = { isEmpty: () => false, resize() { return this; }, toPNG: () => Buffer.alloc(0) };
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let setUp: typeof import('./main-ipc').setUpIpcMessages;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') {
      return {
        app: {}, BrowserWindow: { getFocusedWindow: () => undefined },
        dialog: {
          showSaveDialog: () => { nativeCalls++; return saveDialog(); },
          showOpenDialog: async () => { nativeCalls++; return { canceled: true }; },
          showMessageBox: async () => { nativeCalls++; return { response: 0 }; },
        },
        nativeImage: { createFromBuffer: () => image, createFromPath: () => image },
        powerSaveBlocker: { start: () => 1, stop: () => undefined },
        shell: { openPath: () => { nativeCalls++; }, showItemInFolder: () => { nativeCalls++; } },
      };
    }
    return originalLoad.call(this, request, ...args);
  };
  setUp = require('./main-ipc').setUpIpcMessages;
} finally { NodeModule._load = originalLoad; }

async function fixture(t: TestContext) {
  const root = path.resolve(__dirname, '..', 'tmp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'private-ipc-'));
  const previous = { ...GLOBALS };
  t.after(async () => { Object.assign(GLOBALS, previous); await fs.rm(directory, { recursive: true, force: true }); });
  const on = new Map<string, Listener>();
  const handle = new Map<string, Listener>();
  const messages: unknown[][] = [];
  const event = { sender: { id: 1, isDestroyed: () => false, send: (...args: unknown[]) => messages.push(args) } };
  const window = { isDestroyed: () => false, close: () => { nativeCalls++; }, webContents: { id: 1 } };
  Object.assign(GLOBALS, {
    catalogueStorage: NORMAL_CATALOGUE_STORAGE, catalogueSessionGeneration: 7,
    catalogueTransitionActive: false, cataloguePersistenceActive: false, catalogueAccessMode: 'read-write',
    currentlyOpenVhaFile: path.join(directory, 'normal.scaena'), hubName: 'Synthetic', settingsPath: directory,
    authorizedCatalogueMediaLocations: new Set(), authorizedCatalogueImageHashes: new Set(),
    authorizedCataloguePaths: new Set(), winRef: window, readyToQuit: false,
  });
  nativeCalls = 0;
  setUp({ on: (key: string, listener: Listener) => on.set(key, listener), handle: (key: string, listener: Listener) => handle.set(key, listener) },
    window, directory, {}, () => true);
  return { directory, on, handle, event, messages };
}

function privateBinding(directory: string): void {
  GLOBALS.catalogueStorage = { kind: 'private', cataloguePath: directory, session: {} as PrivateHubSession, generation: 4 };
}

function metadata() {
  return createCatalogueMetadataExport([{ ...NewImageElement(), hash: 'testhash', fileName: 'synthetic.mp4', notes: 'SYNTHETIC_PRIVATE_NOTE' }]).document;
}

test('all legacy IPC entry points fail closed in private mode before dialogs, settings, exports or media work', async t => {
  const { directory, on, handle, event, messages } = await fixture(t);
  privateBinding(directory);
  const untrustedState = { appState: { hubName: 'SYNTHETIC_PRIVATE_NOTE', currentVhaFile: directory }, shortcuts: new Map() };
  // Deliberately malformed parameters would fail inside legacy handlers. The
  // private-mode boundary must prevent those handlers from being called at all.
  for (const listener of on.values()) { listener(event, untrustedState, null); }
  for (const listener of handle.values()) {
    assert.equal((await listener(event, untrustedState)).status, 'private-unavailable');
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(nativeCalls, 0);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.ok(messages.some(item => item[0] === 'current-vha-file-save-failed'));
  assert.ok(messages.some(item => item[0] === 'close-window-save-failed'));
  assert.equal(JSON.stringify(messages).includes('SYNTHETIC_PRIVATE_NOTE'), false);
  assert.equal(GLOBALS.catalogueStorage.kind, 'private');
});

for (const change of ['private-mode', 'generation', 'transition'] as const) {
  test(`metadata export cancels without writing when ${change} changes during its native dialog`, async t => {
    const { directory, handle, event } = await fixture(t);
    t.mock.method(console, 'error', () => undefined);
    let resolveDialog!: (result: unknown) => void;
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    saveDialog = () => { entered(); return new Promise(resolve => { resolveDialog = resolve; }); };
    const result = handle.get('export-catalogue-metadata')!(event, metadata());
    await entering;
    if (change === 'private-mode') { privateBinding(directory); }
    else if (change === 'generation') { GLOBALS.catalogueSessionGeneration++; }
    else { GLOBALS.catalogueTransitionActive = true; }
    resolveDialog({ canceled: false, filePath: path.join(directory, 'export.json') });
    assert.equal((await result).status, change === 'transition' ? 'error' : 'cancelled');
    assert.deepEqual(await fs.readdir(directory), []);
    assert.equal(nativeCalls, 1);
  });
}

test('VHA2 export also rechecks storage after its native dialog', async t => {
  const { directory, handle, event } = await fixture(t);
  t.mock.method(console, 'error', () => undefined);
  const catalogue: FinalObject = {
    version: 3, hubName: 'Synthetic', inputDirs: {}, images: [], addTags: [], removeTags: [], numOfFolders: 0,
    screenshotSettings: { n: 1, height: 288, fixed: true, clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0 },
  };
  saveDialog = async () => { privateBinding(directory); return { canceled: false, filePath: path.join(directory, 'export.vha2') }; };
  assert.equal((await handle.get('export-vha2-catalogue')!(event, catalogue)).status, 'cancelled');
  assert.deepEqual(await fs.readdir(directory), []);
});

test('normal metadata export still writes the explicitly selected document', async t => {
  const { directory, handle, event } = await fixture(t);
  const destination = path.join(directory, 'export.json');
  saveDialog = async () => ({ canceled: false, filePath: destination });
  assert.equal((await handle.get('export-catalogue-metadata')!(event, metadata())).status, 'success');
  assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).entries[0].notes, 'SYNTHETIC_PRIVATE_NOTE');
  assert.equal(nativeCalls, 1);
});

test('native open requests and queued dispatch stay outside private sessions before persisting paths', async () => {
  const source = await fs.readFile(path.resolve(__dirname, '..', 'main.ts'), 'utf8');
  const snippets = [
    source.slice(source.indexOf('function dispatchNextCatalogueOpenRequest'), source.indexOf('GLOBALS.requestCatalogueOpenDispatch =')),
    source.slice(source.indexOf('function requestCatalogueOpenFromSystem'), source.indexOf('function catalogueOpenFailureSuffix')),
  ].join('\n');
  const messages: unknown[] = [];
  const queued: string[] = [];
  let remembered = 0;
  const globals = { catalogueStorage: { kind: 'private' }, angularApp: { sender: { isDestroyed: () => false, send: (...args: unknown[]) => messages.push(args) } } };
  const context = {
    normalOperationScope: new NormalOperationScope(),
    privateApplicationWorkspace: { isActive: false, status: { quitRequested: false } }, path, isCataloguePickerFilePath: () => true,
    deferredNormalCatalogueOpens: [], MAX_DEFERRED_NORMAL_OPENS: 128,
    GLOBALS: globals, rendererCanReceiveCatalogueOpenRequests: true, catalogueOpenOperationActive: false,
    catalogueOpenQueue: { enqueue: (value: string) => queued.push(value), next: () => queued.shift() },
    rememberCataloguePath: (value: string) => { remembered++; return value; }, console,
  };
  const compiled = transpileModule(snippets, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled + "\nrequestCatalogueOpenFromSystem('synthetic.scaena'); dispatchNextCatalogueOpenRequest();", context);
  assert.equal(remembered, 0);
  assert.deepEqual(messages, []);
  globals.catalogueStorage = { kind: 'normal' };
  runInNewContext(compiled + "\nrequestCatalogueOpenFromSystem('synthetic.scaena');", context);
  assert.equal(remembered, 1);
  assert.equal(messages.length, 1);
});

test('the root main IPC wrapper prevents clipboard and other legacy handlers from running in private mode', async () => {
  const source = await fs.readFile(path.resolve(__dirname, '..', 'main.ts'), 'utf8');
  const start = source.indexOf('function trustedIpcOn(');
  const snippet = source.slice(start, source.indexOf('/**', start));
  const compiled = transpileModule(snippet, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText;
  let listener: Listener;
  let calls = 0;
  const globals = { catalogueStorage: { kind: 'private' } };
  runInNewContext(compiled + "\ntrustedIpcOn('write-clipboard-text', unsafe);", {
    normalOperationScope: new NormalOperationScope(),
    GLOBALS: globals, ipcMain: { on: (_channel: string, value: Listener) => { listener = value; } },
    isTrustedRenderer: () => true, unsafe: () => { calls++; }, console,
  });
  listener!({}, 'SYNTHETIC_PRIVATE_NOTE');
  assert.equal(calls, 0);
  globals.catalogueStorage = { kind: 'normal' };
  listener!({}, 'normal text');
  assert.equal(calls, 1);
});
