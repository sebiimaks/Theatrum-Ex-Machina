import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { buildCatalogueMediaLocationAuthority } from './catalogue-media-authority';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import type { BrowserWindow } from 'electron';
import { SAVED_NORMAL_DOCUMENT_CHANNELS as channels } from '../interfaces/saved-normal-document';
import { GLOBALS, type VhaGlobals } from './main-globals';
import { NormalApplicationPause } from './normal-application-pause';
import { NormalOperationScope } from './normal-operation-scope';
import type { PrivateHubOpenOptions, PrivateHubOpenOutcome } from './private-hub-open';
import type { PrivateApplicationWorkspace, PrivateApplicationWorkspaceOptions } from './private-application-workspace';
import type { TransitionPrivateWorkspace } from './private-application-transition';

const app = Object.assign(new EventEmitter(), { isReady: () => true, quits: 0, quit() { this.quits++; } });
const powerMonitor = new EventEmitter();
const ipcMain = new EventEmitter();
let pick: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>;
let makeWorkspace: (options: unknown) => TransitionPrivateWorkspace;
let makeConversionWorkspace: (options: unknown) => TransitionPrivateWorkspace;
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let createPrivateApplicationWorkspace: (options: PrivateApplicationWorkspaceOptions) => PrivateApplicationWorkspace;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') { return { app, powerMonitor, ipcMain, dialog: { showOpenDialog: (...values: unknown[]) => pick(...values) } }; }
    if (request === './private-conversion-workspace') { return { createPrivateConversionWorkspace: (options: unknown) => makeConversionWorkspace(options) }; }
    if (request === './private-hub-workspace') { return { createPrivateHubWorkspace: (options: unknown) => makeWorkspace(options) }; }
    return originalLoad.call(this, request, ...args);
  };
  createPrivateApplicationWorkspace = require('./private-application-workspace').createPrivateApplicationWorkspace;
} finally { NodeModule._load = originalLoad; }

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 5000; index++) {
    if (predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Native transition did not reach its expected stage.');
}

class MockFrame {
  url = 'theatrum://app/index.html';
  parent = null;
  detached = false;
  destroyed = false;
  messages: unknown[][] = [];
  onSend?: (...message: unknown[]) => void;
  isDestroyed(): boolean { return this.destroyed; }
  send(...message: unknown[]): void { this.onSend?.(...message); this.messages.push(message); }
}
class MockContents extends EventEmitter {
  destroyed = false;
  mainFrame = new MockFrame();
  url = this.mainFrame.url;
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
}
class MockWindow extends EventEmitter {
  webContents = new MockContents();
  destroyed = false;
  visible = true;
  restoredWhilePaused = false;
  restoreFails = false;
  onShow?: () => void;
  constructor(readonly operations: NormalOperationScope) { super(); }
  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  hide(): void { this.visible = false; }
  show(): void {
    this.restoredWhilePaused = !this.operations.accepting;
    if (this.restoreFails) { throw new Error('Synthetic window restoration failure.'); }
    this.visible = true;
    this.onShow?.();
  }
}

function fixture(t: TestContext) {
  app.quits = 0;
  const operations = new NormalOperationScope();
  const window = new MockWindow(operations);
  const state: VhaGlobals = { ...GLOBALS, currentlyOpenVhaFile: '', catalogueSessionGeneration: 1 };
  const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
  const mediaDrain = deferred();
  const privateDrain = deferred();
  const opening = deferred<PrivateHubOpenOutcome>();
  let holdMedia = false;
  let holdPrivate = false;
  let holdOpening = false;
  let privateState = 'idle';
  let privateFailed = false;
  let canStart = true;
  let factoryCalls = 0;
  let conversionFactoryCalls = 0;
  let pickerCalls = 0;
  let nativeOptions: PrivateHubOpenOptions | undefined;
  let afterResumes = 0;
  let resumedCurrent = false;
  const normal = new NormalApplicationPause({
    operations, canPause: () => true,
    onPause: () => { state.catalogueTransitionActive = true; },
    pauseSources: async () => undefined,
    drainMedia: () => holdMedia ? mediaDrain.promise : Promise.resolve(),
    resumeMedia: () => undefined, resumeSources: () => undefined,
    onResume: () => { state.catalogueTransitionActive = false; },
  });
  const retire = (): void => { privateState = privateFailed ? 'failed' : 'idle'; privateDrain.resolve(); };
  const native: TransitionPrivateWorkspace = {
    get status() { return { state: privateState, cleanupFailed: privateFailed }; },
    get settled() { return privateDrain.promise; },
    open(options) {
      nativeOptions = options; privateState = holdOpening ? 'opening' : 'open';
      options.signal!.addEventListener('abort', () => {
        if (privateState !== 'idle' && privateState !== 'failed') { privateState = 'closing'; }
      }, { once: true });
      return holdOpening ? opening.promise : Promise.resolve('opened');
    },
    cancel() {
      if (privateState !== 'idle' && privateState !== 'failed') { privateState = 'closing'; }
      if (!holdPrivate) { retire(); }
      return privateDrain.promise;
    },
  };
  pick = async (owner, options) => {
    pickerCalls++;
    assert.equal(owner, window);
    assert.deepEqual(options, { title: 'Open private hub', buttonLabel: 'Open private hub', properties: ['openDirectory', 'dontAddToRecent'] });
    assert.equal(app.listenerCount('before-quit'), 1);
    assert.equal(powerMonitor.listenerCount('lock-screen'), 1);
    return picker.promise;
  };
  makeWorkspace = options => {
    factoryCalls++;
    assert.deepEqual(options, { appDirectory: '/Users/sm/Workspace/synthetic-private-ui', lifecycle: 'external' });
    assert.equal(operations.accepting, false);
    assert.equal(window.visible, false);
    return native;
  };
  makeConversionWorkspace = options => { conversionFactoryCalls++; return makeWorkspace(options); };
  const workspace = createPrivateApplicationWorkspace({
    appDirectory: '/Users/sm/Workspace/synthetic-private-ui', normal, operations, state,
    getNormalWindow: () => window as unknown as BrowserWindow,
    canStart: () => canStart,
    isAllowedRendererUrl: url => url === 'theatrum://app/index.html',
    afterResume: () => { afterResumes++; resumedCurrent = operations.isCurrent(); },
  });
  const request = (): unknown[] | undefined => window.webContents.mainFrame.messages.find(message => message[0] === channels.request);
  const snapshot = (changes: { sender?: unknown; senderFrame?: unknown; id?: unknown; document?: FinalObject } = {}): void => {
    assert.ok(request());
    ipcMain.emit(channels.snapshot, {
      sender: changes.sender ?? window.webContents,
      senderFrame: changes.senderFrame ?? window.webContents.mainFrame,
    }, changes.id ?? request()![1], { status: 'snapshot', document: changes.document ?? null });
  };
  const select = (): void => picker.resolve({ canceled: false, filePaths: ['/Users/sm/Workspace/synthetic-private-hub'] });
  t.after(async () => {
    picker.resolve({ canceled: true, filePaths: [] }); mediaDrain.resolve(); opening.resolve('cancelled');
    holdPrivate = false; retire();
    await workspace.cancel();
    await workspace.settled;
    if (!workspace.status.cleanupFailed) {
      assert.equal(app.listenerCount('before-quit'), 0);
      assert.equal(powerMonitor.listenerCount('lock-screen'), 0);
      assert.equal(ipcMain.listenerCount(channels.snapshot), 0);
    }
    app.removeAllListeners(); powerMonitor.removeAllListeners(); ipcMain.removeAllListeners();
  });
  return { workspace, operations, normal, window, state, picker, mediaDrain, privateDrain, opening, select, snapshot, request, retire,
    holdMedia: () => { holdMedia = true; }, holdPrivate: () => { holdPrivate = true; }, holdOpening: () => { holdOpening = true; },
    failPrivate: () => { privateFailed = true; }, denyStart: () => { canStart = false; },
    conversionFactoryCalls: () => conversionFactoryCalls, factoryCalls: () => factoryCalls, pickerCalls: () => pickerCalls, nativeOptions: () => nativeOptions,
    afterResumes: () => afterResumes, resumedCurrent: () => resumedCurrent };
}

test('construction is dormant and unavailable admission never opens a native picker', async t => {
  const f = fixture(t);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal(ipcMain.listenerCount(channels.snapshot), 0);
  f.denyStart();
  assert.equal(await f.workspace.open(), 'unavailable');
  await f.workspace.settled;
  assert.equal(f.pickerCalls(), 0);
  assert.equal(f.workspace.isActive, false);
});

test('entry refuses a normal operation and an inherited completed async scope', async t => {
  const f = fixture(t);
  let later!: Promise<PrivateHubOpenOutcome>;
  await f.operations.run(async () => {
    assert.equal(await f.workspace.open(), 'unavailable');
    later = new Promise(resolve => setImmediate(() => { void f.workspace.open().then(resolve); }));
  });
  assert.equal(await later, 'unavailable');
  assert.equal(f.pickerCalls(), 0);
});

test('picker cancellation retains its native callback and never sends a private path into normal IPC', async t => {
  const f = fixture(t);
  const opening = f.workspace.open();
  assert.equal(await f.workspace.open(), 'busy');
  powerMonitor.emit('lock-screen');
  let complete = false;
  void f.workspace.settled.then(() => { complete = true; });
  await turn();
  assert.equal(complete, false);
  assert.equal(f.workspace.isActive, true);
  f.select();
  assert.equal(await opening, 'cancelled');
  assert.deepEqual(f.window.webContents.mainFrame.messages, []);
  assert.equal(f.factoryCalls(), 0);
  assert.equal(f.operations.accepting, true);
});

test('snapshot follows actual normal drain and accepts only the original main frame and nonce', async t => {
  const f = fixture(t); f.holdMedia();
  const opening = f.workspace.open(); f.select();
  await until(() => f.normal.status.state === 'pausing');
  assert.equal(f.request(), undefined);
  f.mediaDrain.resolve(); await until(() => !!f.request());
  assert.equal(f.operations.accepting, false);
  f.snapshot({ sender: {} }); f.snapshot({ senderFrame: new MockFrame() }); f.snapshot({ id: 'wrong request' });
  await turn(); assert.equal(f.factoryCalls(), 0);
  f.snapshot();
  assert.equal(await opening, 'opened');
  assert.equal(f.factoryCalls(), 1);
  assert.equal(f.nativeOptions()!.directory, '/Users/sm/Workspace/synthetic-private-hub');
  assert.equal(f.nativeOptions()!.isAuthorized(), true);
  assert.equal(f.window.webContents.mainFrame.messages.some(message => JSON.stringify(message).includes('synthetic-private-hub')), false);
  await f.workspace.cancel();
  assert.equal(f.window.restoredWhilePaused, true);
  assert.equal(f.operations.accepting, true);
  assert.equal(f.afterResumes(), 1);
  assert.equal(f.resumedCurrent(), true);
});

test('same URL main-frame navigation invalidates a pending native picker', async t => {
  const f = fixture(t); const opening = f.workspace.open();
  f.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: f.window.webContents.url });
  f.select(); assert.equal(await opening, 'cancelled');
  assert.equal(f.factoryCalls(), 0);
  assert.equal(f.request(), undefined);
});

test('catalogue generation drift discards a late picker result before pausing', async t => {
  const f = fixture(t); const opening = f.workspace.open();
  f.state.catalogueSessionGeneration++;
  f.select(); assert.equal(await opening, 'cancelled');
  assert.equal(f.normal.status.state, 'normal');
  assert.equal(f.factoryCalls(), 0);
});

test('quit during snapshot wait thaws the original page then delegates normal settings shutdown once', async t => {
  const f = fixture(t); const opening = f.workspace.open(); f.select();
  await until(() => !!f.request());
  let prevented = 0;
  app.emit('before-quit', { preventDefault: () => { prevented++; } });
  app.emit('before-quit', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2); assert.equal(app.quits, 0);
  assert.equal(await opening, 'cancelled');
  await until(() => app.quits === 1);
  assert.equal(f.factoryCalls(), 0);
  assert.equal(f.operations.accepting, true);
  assert.equal(f.workspace.isActive, false);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal(f.window.webContents.mainFrame.messages.at(-1)![0], channels.release);
  assert.equal(await f.workspace.open(), 'unavailable');
  assert.equal(f.workspace.acknowledgeQuitCancelled(), true);
  assert.equal(f.workspace.status.quitRequested, false);
  assert.equal(f.workspace.acknowledgeQuitCancelled(), false);
});

test('natural private window closure restores normal only after full private settlement', async t => {
  const f = fixture(t); f.holdPrivate();
  const opening = f.workspace.open(); f.select(); await until(() => !!f.request()); f.snapshot();
  assert.equal(await opening, 'opened');
  assert.equal(f.operations.accepting, false);
  assert.equal(f.window.visible, false);
  f.retire(); await f.workspace.settled;
  assert.equal(f.operations.accepting, true);
  assert.equal(f.window.visible, true);
  assert.equal(f.window.restoredWhilePaused, true);
  assert.equal(f.workspace.isActive, false);
  assert.equal(app.quits, 0);
});

test('saved main-authority drift revokes private admission even when window and catalogue generation match', async t => {
  const f = fixture(t);
  const opening = f.workspace.open(); f.select(); await until(() => !!f.request()); f.snapshot();
  assert.equal(await opening, 'opened');
  f.state.authorizedSourceFolderPaths = new Set(['/Users/sm/Workspace/synthetic-new-source']);
  assert.equal(f.nativeOptions()!.isAuthorized(), false);
  assert.equal(f.nativeOptions()!.signal!.aborted, true);
  await f.workspace.settled;
  assert.equal(f.operations.accepting, true);
  assert.equal(app.quits, 0);
});

for (const event of ['suspend', 'lock-screen']) {
  test(event + ' immediately revokes the parent private lifetime while keeping normal frozen through drain', async t => {
    const f = fixture(t); f.holdPrivate();
    const opening = f.workspace.open(); f.select(); await until(() => !!f.request()); f.snapshot();
    assert.equal(await opening, 'opened');
    powerMonitor.emit(event);
    assert.equal(f.nativeOptions()!.signal!.aborted, true);
    await turn();
    assert.equal(f.operations.accepting, false);
    assert.equal(f.window.visible, false);
    assert.equal(f.window.webContents.mainFrame.messages.some(message => message[0] === channels.release), false);
    f.retire(); await f.workspace.settled;
    assert.equal(f.operations.accepting, true);
    assert.equal(app.quits, 0);
  });
}

test('shutdown during the native picker waits for its completion before retrying normal application quit', async t => {
  const f = fixture(t);
  const opening = f.workspace.open();
  let prevented = 0;
  powerMonitor.emit('shutdown', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
  await turn(); assert.equal(app.quits, 0);
  f.select(); assert.equal(await opening, 'cancelled');
  await until(() => app.quits === 1);
  assert.equal(f.factoryCalls(), 0);
  assert.equal(f.operations.accepting, true);
});

test('quit waits private opening and disposal before thaw, window restore, normal resume or app.quit', async t => {
  const f = fixture(t); f.holdOpening(); f.holdPrivate();
  const opening = f.workspace.open(); f.select(); await until(() => !!f.request()); f.snapshot();
  await until(() => f.factoryCalls() === 1);
  let prevented = 0;
  f.window.emit('close', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(f.nativeOptions()!.signal!.aborted, true);
  f.opening.resolve('cancelled');
  await turn();
  assert.equal(app.quits, 0);
  assert.equal(f.window.visible, false);
  assert.equal(f.operations.accepting, false);
  assert.equal(f.window.webContents.mainFrame.messages.some(message => message[0] === channels.release), false);
  f.retire();
  assert.equal(await opening, 'cancelled');
  await until(() => app.quits === 1);
  assert.equal(f.window.restoredWhilePaused, true);
  assert.equal(f.operations.accepting, true);
});

test('private cleanup failure keeps normal IPC sealed, renderer frozen and lifecycle observers installed', async t => {
  const f = fixture(t); f.holdPrivate();
  const opening = f.workspace.open(); f.select(); await until(() => !!f.request()); f.snapshot();
  assert.equal(await opening, 'opened');
  f.failPrivate();
  const quitting = f.workspace.requestQuit(); f.retire(); await quitting;
  assert.equal(f.workspace.status.cleanupFailed, true);
  assert.equal(f.workspace.isActive, true);
  assert.equal(f.operations.accepting, false);
  assert.equal(f.window.visible, false);
  assert.equal(f.window.webContents.mainFrame.messages.some(message => message[0] === channels.release), false);
  assert.equal(app.listenerCount('before-quit'), 1);
  assert.equal(app.quits, 0);
  assert.equal(await f.workspace.open(), 'unavailable');
});

test('window restoration failure cannot reopen normal admission', async t => {
  const f = fixture(t);
  const opening = f.workspace.open(); f.select(); await until(() => !!f.request()); f.snapshot();
  assert.equal(await opening, 'opened');
  f.window.restoreFails = true;
  await f.workspace.cancel();
  assert.equal(f.workspace.status.cleanupFailed, true);
  assert.equal(f.operations.accepting, false);
  assert.equal(f.window.visible, false);
  assert.equal(f.window.webContents.mainFrame.messages.some(message => message[0] === channels.release), false);
  assert.equal(app.quits, 0);
});


test('renderer release is sent only after the restored normal window can accept ordinary requests', async t => {
  const f = fixture(t);
  let releases = 0;
  f.window.webContents.mainFrame.onSend = (channel) => {
    if (channel !== channels.release) { return; }
    releases++;
    assert.equal(f.window.visible, true);
    assert.equal(f.operations.accepting, true);
    assert.equal(f.operations.isCurrent(), true);
    assert.equal(f.state.catalogueTransitionActive, false);
  };
  f.window.onShow = () => {
    assert.equal(f.operations.accepting, false, 'normal window must still restore under its pause proof');
    assert.equal(releases, 0, 'renderer must remain frozen until normal admission is restored');
  };
  const opening = f.workspace.open(); f.select(); await until(() => !!f.request()); f.snapshot();
  assert.equal(await opening, 'opened');
  assert.equal(releases, 0);
  await f.workspace.cancel();
  assert.equal(releases, 1);
  assert.equal(f.workspace.status.cleanupFailed, false);
});

test('a failed renderer release reseals main admission and cannot be retried by later close requests', async t => {
  const f = fixture(t);
  let releases = 0;
  f.window.webContents.mainFrame.onSend = (channel) => {
    if (channel !== channels.release) { return; }
    releases++;
    assert.equal(f.operations.accepting, true, 'release is attempted inside guarded resumed admission');
    throw new Error('Synthetic renderer release send failure.');
  };
  const opening = f.workspace.open(); f.select(); await until(() => !!f.request()); f.snapshot();
  assert.equal(await opening, 'opened');
  await f.workspace.cancel();
  assert.equal(releases, 1);
  assert.equal(f.workspace.status.cleanupFailed, true);
  assert.equal(f.operations.accepting, false);
  assert.equal(f.workspace.isActive, true);
  assert.equal(f.afterResumes(), 0);
  assert.equal(await f.workspace.open(), 'unavailable');
  await f.workspace.requestQuit();
  await f.workspace.cancel();
  assert.equal(releases, 1, 'an attempted release must not survive for later retry');
  assert.equal(app.quits, 0);
});


async function conversionSource(t: TestContext, f: ReturnType<typeof fixture>) {
  const temporary = path.resolve(__dirname, '..', 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-conversion-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cataloguePath = path.join(root, 'Synthetic.scaena');
  const sourcePath = path.join(root, 'unopened-originals');
  const images = [{ ...NewImageElement(), hash: 'synthetic-video', fileName: 'synthetic.mp4', cleanName: 'synthetic', inputSource: 0, notes: 'original notes' }];
  const catalogue: FinalObject = { hubName: 'Synthetic', images, inputDirs: { 0: { path: sourcePath, watch: false } },
    addTags: [], removeTags: [], numOfFolders: 1, version: 3,
    screenshotSettings: { n: 5, height: 144, fixed: true, clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0 } };
  await fs.writeFile(cataloguePath, JSON.stringify(catalogue));
  Object.assign(f.state, { currentlyOpenVhaFile: cataloguePath, selectedOutputFolder: root, hubName: 'Synthetic',
    catalogueAccessMode: 'read-write', vhaFileVersion: 3,
    selectedSourceFolders: structuredClone(catalogue.inputDirs), screenshotSettings: structuredClone(catalogue.screenshotSettings),
    authorizedCataloguePaths: new Set([cataloguePath]), authorizedCatalogueImageHashes: new Set(['synthetic-video']),
    authorizedCatalogueMediaLocations: buildCatalogueMediaLocationAuthority(images),
    authorizedSourceFolderPaths: new Set([sourcePath]), authorizedSourceFolderRealPaths: new Map([[sourcePath, sourcePath]]),
    authorizedSourceWatchPaths: new Set(),
  });
  return { root, cataloguePath, catalogue };
}

test('conversion refuses an absent, read-only or unowned normal catalogue before pausing', async t => {
  const f = fixture(t);
  assert.equal(await f.workspace.convert(), 'unavailable');
  const source = await conversionSource(t, f);
  f.state.catalogueAccessMode = 'read-only';
  assert.equal(await f.workspace.convert(), 'unavailable');
  f.state.catalogueAccessMode = 'read-write'; f.state.authorizedCataloguePaths = new Set();
  assert.equal(await f.workspace.convert(), 'unavailable');
  assert.equal(f.state.currentlyOpenVhaFile, source.cataloguePath);
  assert.equal(f.pickerCalls(), 0); assert.equal(f.factoryCalls(), 0); assert.equal(f.operations.accepting, true);
});

test('conversion captures main-owned source and saves drafts before creating its isolated workspace', async t => {
  const f = fixture(t);
  const source = await conversionSource(t, f);
  const opening = f.workspace.convert();
  assert.equal(await f.workspace.open(), 'busy');
  await until(() => !!f.request());
  assert.equal(f.operations.accepting, false); assert.equal(f.factoryCalls(), 0); assert.equal(f.pickerCalls(), 0);
  source.catalogue.images[0].notes = 'Saved before private copy';
  f.snapshot({ document: source.catalogue });
  assert.equal(await opening, 'opened');
  assert.equal(f.conversionFactoryCalls(), 1); assert.equal(f.window.visible, false);
  assert.equal(f.nativeOptions()!.directory, source.cataloguePath);
  assert.equal(f.nativeOptions()!.isAuthorized(), true);
  assert.equal(JSON.parse(await fs.readFile(source.cataloguePath, 'utf8')).images[0].notes, 'Saved before private copy');
  assert.equal(JSON.stringify(f.window.webContents.mainFrame.messages).includes(source.cataloguePath), false);
  await f.workspace.cancel(); await f.workspace.settled;
  assert.equal(f.window.visible, true); assert.equal(f.operations.accepting, true);
  assert.equal(f.nativeOptions()!.isAuthorized(), false);
});

test('conversion cancellation holds the source freeze until pending preparation is drained', async t => {
  const f = fixture(t); const source = await conversionSource(t, f);
  f.holdOpening(); f.holdPrivate();
  const opening = f.workspace.convert();
  await until(() => !!f.request()); f.snapshot({ document: source.catalogue });
  await until(() => f.factoryCalls() === 1);
  const cancelling = f.workspace.cancel();
  assert.equal(f.operations.accepting, false); assert.equal(f.window.visible, false);
  assert.equal(f.nativeOptions()!.signal!.aborted, true);
  f.opening.resolve('cancelled'); await turn();
  assert.equal(f.operations.accepting, false);
  f.retire(); await cancelling;
  assert.equal(await opening, 'cancelled'); assert.equal(f.operations.accepting, true);
});
