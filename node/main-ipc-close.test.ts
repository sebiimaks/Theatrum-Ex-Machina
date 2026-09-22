import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { normalOperationScope } from './normal-operation-scope';
import { NORMAL_CATALOGUE_STORAGE } from './catalogue-storage';

type IpcListener = (event: any, ...args: any[]) => unknown;

let nativeMessageBox: (...args: any[]) => Promise<{ response: number }> = async () => ({ response: 0 });
let thumbnailRegenerationActive = false;
let cancelledThumbnailRegenerations = 0;
let catalogueWriteFailure: Error | undefined;

/**
 * `main-ipc.ts` imports Electron at module load time. The production close
 * handler itself only needs a very small part of that API in this scenario,
 * so intercept the import long enough to load the real handler under Node.
 */
function loadMainIpcWithElectronStub(): {
  GLOBALS: any;
  setUpIpcMessages: (...args: any[]) => void;
} {
  const NodeModule = require('node:module');
  const originalLoad = NodeModule._load;
  const image = {
    isEmpty: () => false,
    resize() {
      return this;
    },
    toPNG: () => Buffer.alloc(0),
  };
  const electronStub = {
    app: {},
    BrowserWindow: {
      getFocusedWindow: () => undefined,
    },
    dialog: {
      showMessageBox: (...args: any[]) => nativeMessageBox(...args),
    },
    nativeImage: {
      createFromBuffer: () => image,
      createFromPath: () => image,
    },
    powerSaveBlocker: {
      start: () => 1,
      stop: () => undefined,
    },
    shell: {},
  };

  try {
    NodeModule._load = function loadWithElectronStub(request: string, ...args: any[]) {
      if (request === 'electron') {
        return electronStub;
      }
      if (request === './main-extract-async') {
        return {
          ...originalLoad.call(this, request, ...args),
          isThumbnailRegenerationActive: () => thumbnailRegenerationActive,
          cancelThumbnailRegeneration: () => { cancelledThumbnailRegenerations++; },
        };
      }
      if (request === './main-support') {
        const support = originalLoad.call(this, request, ...args);
        return {
          ...support,
          writeVhaFileToDisk: (document: unknown, destination: string, done: (error?: Error) => unknown) => (
            catalogueWriteFailure
              ? Promise.resolve(done(catalogueWriteFailure))
              : support.writeVhaFileToDisk(document, destination, done)
          ),
        };
      }
      return originalLoad.call(this, request, ...args);
    };
    const { GLOBALS } = require('./main-globals.ts');
    const { setUpIpcMessages } = require('./main-ipc.ts');
    return { GLOBALS, setUpIpcMessages };
  } finally {
    NodeModule._load = originalLoad;
  }
}

test('close-window saves settings and closes before a catalogue has committed', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-no-catalogue-close-'));
  const staleCataloguePath = path.join(temporaryDirectory, 'Legacy Read Only.vha2');
  const originalCatalogue = '{"legacy":"unchanged"}\n';
  fs.writeFileSync(staleCataloguePath, originalCatalogue);

  const { GLOBALS, setUpIpcMessages } = loadMainIpcWithElectronStub();
  const previousGlobals = {
    authorizedCatalogueMediaLocations: GLOBALS.authorizedCatalogueMediaLocations,
    authorizedCataloguePaths: GLOBALS.authorizedCataloguePaths,
    catalogueAccessMode: GLOBALS.catalogueAccessMode,
    cataloguePersistenceActive: GLOBALS.cataloguePersistenceActive,
    catalogueSessionGeneration: GLOBALS.catalogueSessionGeneration,
    catalogueTransitionActive: GLOBALS.catalogueTransitionActive,
    currentlyOpenVhaFile: GLOBALS.currentlyOpenVhaFile,
    preferredVideoPlayer: GLOBALS.preferredVideoPlayer,
    preferredVideoPlayerArguments: GLOBALS.preferredVideoPlayerArguments,
    readyToQuit: GLOBALS.readyToQuit,
    requestCatalogueOpenDispatch: GLOBALS.requestCatalogueOpenDispatch,
    settingsPath: GLOBALS.settingsPath,
    winRef: GLOBALS.winRef,
  };

  try {
    const listeners = new Map<string, IpcListener>();
    const ipc = {
      handle: () => undefined,
      on: (channel: string, listener: IpcListener): void => {
        listeners.set(channel, listener);
      },
    };
    let closeCalls = 0;
    let resolveClosed: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const windowStub = {
      close: (): void => {
        closeCalls += 1;
        resolveClosed();
      },
      isDestroyed: () => false,
      webContents: { id: 1 },
    };

    Object.assign(GLOBALS, {
      authorizedCatalogueMediaLocations: new Set<string>(),
      authorizedCataloguePaths: new Set<string>([staleCataloguePath]),
      catalogueAccessMode: 'read-write',
      cataloguePersistenceActive: false,
      catalogueSessionGeneration: 0,
      catalogueTransitionActive: false,
      currentlyOpenVhaFile: '',
      preferredVideoPlayer: '',
      preferredVideoPlayerArguments: '',
      readyToQuit: false,
      requestCatalogueOpenDispatch: undefined,
      settingsPath: temporaryDirectory,
      winRef: windowStub,
    });

    setUpIpcMessages(ipc, windowStub, temporaryDirectory, {}, () => true);
    const closeWindow = listeners.get('close-window');
    assert.ok(closeWindow, 'The close-window IPC handler was not registered.');

    const rendererMessages: any[][] = [];
    const event = {
      sender: {
        id: 1,
        isDestroyed: () => false,
        send: (...args: any[]): void => {
          rendererMessages.push(args);
        },
      },
    };
    const settings = {
      appState: {
        currentVhaFile: staleCataloguePath,
        preferredVideoPlayer: '',
        videoPlayerArgs: '',
      },
      shortcuts: new Map(),
      vhaFileHistory: [{
        hubName: 'Legacy Read Only',
        vhaFilePath: staleCataloguePath,
      }],
    };

    closeWindow(event, settings, null);

    let timeout: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('The window did not close.')), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    const savedSettings = JSON.parse(
      fs.readFileSync(path.join(temporaryDirectory, 'settings.json'), 'utf8'),
    );
    assert.equal(savedSettings.appState.currentVhaFile, '');
    assert.equal(closeCalls, 1);
    assert.equal(GLOBALS.readyToQuit, true);
    assert.equal(GLOBALS.cataloguePersistenceActive, false);
    assert.deepEqual(rendererMessages, []);
    assert.equal(fs.readFileSync(staleCataloguePath, 'utf8'), originalCatalogue);
  } finally {
    Object.assign(GLOBALS, previousGlobals);
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function closeFixture(t: TestContext) {
  const { GLOBALS, setUpIpcMessages } = loadMainIpcWithElectronStub();
  const previous = { ...GLOBALS };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-close-lifecycle-'));
  const listeners = new Map<string, IpcListener>();
  const messages: unknown[][] = [];
  const dialogs: any[] = [];
  let closeCalls = 0;
  let abandoned = 0;
  let trusted = true;
  const url = 'theatrum://app/index.html';
  const frame = { url, parent: null, detached: false, isDestroyed: () => false };
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    getURL: () => url,
    mainFrame: frame,
    send: (...args: unknown[]) => { messages.push(args); },
  });
  const window = { webContents: contents, isDestroyed: () => false, close: () => { closeCalls++; } };
  const event = { sender: contents, senderFrame: frame };
  nativeMessageBox = async (...args) => { dialogs.push(args.at(-1)); return { response: 0 }; };
  thumbnailRegenerationActive = false;
  cancelledThumbnailRegenerations = 0;
  catalogueWriteFailure = undefined;
  Object.assign(GLOBALS, {
    catalogueStorage: NORMAL_CATALOGUE_STORAGE, catalogueSessionGeneration: 7,
    catalogueAccessMode: 'read-write', cataloguePersistenceActive: false, catalogueTransitionActive: false,
    currentlyOpenVhaFile: '', hubName: 'Synthetic', settingsPath: directory,
    authorizedCataloguePaths: new Set(), authorizedCatalogueMediaLocations: new Set(),
    authorizedCatalogueImageHashes: new Set(), selectedSourceFolders: {},
    readyToQuit: false, preferredVideoPlayer: '', preferredVideoPlayerArguments: '',
    requestCatalogueOpenDispatch: undefined, winRef: window,
  });
  const settings = () => ({
    appState: { currentVhaFile: '', preferredVideoPlayer: '', videoPlayerArgs: '' },
    shortcuts: new Map(), vhaFileHistory: [],
  });
  const catalogue = () => {
    const filePath = path.join(directory, 'Synthetic.scaena');
    fs.writeFileSync(filePath, '{}');
    GLOBALS.currentlyOpenVhaFile = filePath;
    GLOBALS.authorizedCataloguePaths.add(filePath);
    return {
      hubName: 'Synthetic', images: [], inputDirs: {}, addTags: [], removeTags: [],
      numOfFolders: 0, screenshotSettings: GLOBALS.screenshotSettings, version: 3,
    };
  };
  setUpIpcMessages({
    on: (channel: string, listener: IpcListener) => listeners.set(channel, listener),
    handle: () => undefined,
  }, window, directory, {}, () => trusted, { onCloseAbandoned: () => { abandoned++; } });
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  t.after(async () => {
    normalOperationScope.resume(await normalOperationScope.seal());
    assert.equal(contents.listenerCount('did-start-navigation'), 0);
    assert.equal(contents.listenerCount('render-process-gone'), 0);
    Object.assign(GLOBALS, previous);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    GLOBALS, directory, contents, frame, window, event, settings, catalogue, dialogs, messages,
    abandoned: () => abandoned, closeCalls: () => closeCalls, untrust: () => { trusted = false; },
    close: (savedSettings: unknown = settings(), document: unknown = null, source = event) => (
      listeners.get('close-window')!(source, savedSettings, document)
    ),
  };
}

test('a main-proven settings preparation failure acknowledges an abandoned close once', async t => {
  const f = closeFixture(t);
  await f.close(null);
  assert.equal(f.abandoned(), 1);
  assert.equal(f.closeCalls(), 0);
  assert.equal(f.GLOBALS.readyToQuit, false);
  assert.equal(f.GLOBALS.cataloguePersistenceActive, false);
  assert.deepEqual(f.dialogs[0].buttons, ['OK']);
  assert.equal(f.messages[0][0], 'close-window-save-failed');
});

test('an atomic settings write failure acknowledges the current normal close', async t => {
  const f = closeFixture(t);
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === path.join(f.directory, 'settings.json')) { throw new Error('Synthetic settings failure'); }
    return rename(source, destination);
  });
  await f.close();
  assert.equal(f.abandoned(), 1);
  assert.equal(f.closeCalls(), 0);
  assert.equal(f.GLOBALS.cataloguePersistenceActive, false);
});

test('a failed close capture acknowledges the same current normal document', async t => {
  const f = closeFixture(t);
  f.GLOBALS.currentlyOpenVhaFile = path.join(f.directory, 'missing.scaena');
  await f.close();
  assert.equal(f.abandoned(), 1);
  assert.equal(f.closeCalls(), 0);
});

test('a successful ordinary close never acknowledges cancellation', async t => {
  const f = closeFixture(t);
  await f.close();
  assert.equal(f.closeCalls(), 1);
  assert.equal(f.abandoned(), 0);
});

test('main rejection of a close during an existing normal save acknowledges the abandoned retry', async t => {
  const f = closeFixture(t);
  f.GLOBALS.cataloguePersistenceActive = true;
  await f.close();
  assert.equal(f.abandoned(), 1);
  assert.equal(f.GLOBALS.cataloguePersistenceActive, true);
  assert.equal(f.closeCalls(), 0);
});

for (const response of [0, 1]) {
  test(`catalogue write failure ${response === 0 ? 'Keep Working acknowledges cancellation' : 'Quit Without Saving completes without acknowledgement'}`, async t => {
    const f = closeFixture(t);
    const document = f.catalogue();
    catalogueWriteFailure = new Error('Synthetic catalogue failure');
    nativeMessageBox = async () => ({ response });
    await f.close(f.settings(), document);
    assert.equal(f.abandoned(), response === 0 ? 1 : 0);
    assert.equal(f.closeCalls(), response === 0 ? 0 : 1);
    assert.equal(f.GLOBALS.cataloguePersistenceActive, false);
  });

  test(`thumbnail generation ${response === 0 ? 'Keep Working acknowledges cancellation' : 'Cancel and Quit completes without acknowledgement'}`, async t => {
    const f = closeFixture(t);
    thumbnailRegenerationActive = true;
    nativeMessageBox = async () => ({ response });
    await f.close();
    assert.equal(f.abandoned(), response === 0 ? 1 : 0);
    assert.equal(f.closeCalls(), response === 0 ? 0 : 1);
    assert.equal(cancelledThumbnailRegenerations, response === 0 ? 0 : 1);
  });
}

test('failure to display a native save error still acknowledges a current abandoned close', async t => {
  const f = closeFixture(t);
  nativeMessageBox = async () => { throw new Error('Synthetic native dialog failure'); };
  await f.close(null);
  assert.equal(f.abandoned(), 1);
  assert.equal(f.closeCalls(), 0);
});

test('untrusted, private and paused close messages cannot acknowledge quit cancellation', async t => {
  const f = closeFixture(t);
  f.GLOBALS.catalogueStorage = { kind: 'private' };
  await f.close();
  f.GLOBALS.catalogueStorage = NORMAL_CATALOGUE_STORAGE;
  const paused = await normalOperationScope.seal();
  await f.close();
  normalOperationScope.resume(paused);
  f.untrust();
  await f.close(null);
  assert.equal(f.abandoned(), 0);
  assert.equal(f.dialogs.length, 0);
});

for (const replaced of ['window', 'contents', 'frame', 'navigation', 'renderer crash', 'generation', 'path', 'authority', 'storage', 'access', 'transition', 'trust'] as const) {
  test(`a save error dialog from an old ${replaced} cannot acknowledge the replacement's quit state`, async t => {
    const f = closeFixture(t);
    const entered = deferred<void>();
    const response = deferred<{ response: number }>();
    nativeMessageBox = () => { entered.resolve(); return response.promise; };
    const running = f.close(null);
    await entered.promise;
    switch (replaced) {
      case 'window': f.GLOBALS.winRef = { ...f.window }; break;
      case 'contents': f.window.webContents = Object.assign(new EventEmitter(), f.contents); break;
      case 'frame': f.contents.mainFrame = { ...f.frame }; break;
      case 'navigation': f.contents.emit('did-start-navigation', {
        isMainFrame: true, isSameDocument: false, url: f.frame.url,
      }); break;
      case 'renderer crash': f.contents.emit('render-process-gone'); break;
      case 'generation': f.GLOBALS.catalogueSessionGeneration++; break;
      case 'path': f.GLOBALS.currentlyOpenVhaFile = path.join(f.directory, 'replacement.scaena'); break;
      case 'authority': f.GLOBALS.authorizedCatalogueMediaLocations = new Set(); break;
      case 'storage': f.GLOBALS.catalogueStorage = { kind: 'normal' }; break;
      case 'access': f.GLOBALS.catalogueAccessMode = 'read-only'; break;
      case 'transition': f.GLOBALS.catalogueTransitionActive = true; break;
      case 'trust': f.untrust(); break;
    }
    response.resolve({ response: 0 });
    await running;
    assert.equal(f.abandoned(), 0);
    assert.equal(f.closeCalls(), 0);
  });
}

test('normal-operation revocation during a native error dialog suppresses acknowledgement', async t => {
  const f = closeFixture(t);
  const entered = deferred<void>();
  const response = deferred<{ response: number }>();
  nativeMessageBox = () => { entered.resolve(); return response.promise; };
  const running = f.close(null);
  await entered.promise;
  const paused = normalOperationScope.seal();
  response.resolve({ response: 0 });
  await running;
  normalOperationScope.resume(await paused);
  assert.equal(f.abandoned(), 0);
});

test('a different frame with a trusted sender ID cannot invoke the main close hook', async t => {
  const f = closeFixture(t);
  await f.close(null, null, { sender: f.contents, senderFrame: { ...f.frame } });
  assert.equal(f.abandoned(), 0);
});

test('subframe navigation does not retire the unchanged main-frame close acknowledgement', async t => {
  const f = closeFixture(t);
  const entered = deferred<void>();
  const response = deferred<{ response: number }>();
  nativeMessageBox = () => { entered.resolve(); return response.promise; };
  const running = f.close(null);
  await entered.promise;
  f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: f.frame.url });
  response.resolve({ response: 0 });
  await running;
  assert.equal(f.abandoned(), 1);
});
