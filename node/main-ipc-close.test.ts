import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

type IpcListener = (event: any, ...args: any[]) => void;

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
      showMessageBox: async () => ({ response: 0 }),
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
