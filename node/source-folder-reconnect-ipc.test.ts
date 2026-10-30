import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { NewImageElement } from '../interfaces/final-object.interface';
import { buildCatalogueMediaLocationAuthority } from './catalogue-media-authority';

/** Exercise the real IPC path, with only the native dialog/window APIs replaced. */
test('reconnect acknowledges a path-only change and an explicit rescan reuses existing catalogue paths', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-reconnect-ipc-'));
  const newRoot = path.join(directory, 'new-source');
  const oldRoot = path.join(directory, 'disconnected-source');
  fs.mkdirSync(newRoot);
  fs.writeFileSync(path.join(newRoot, 'video.mp4'), 'synthetic media; must not be probed');
  const cataloguePath = path.join(directory, 'Fixture.scaena');
  const previewPath = path.join(directory, 'existing-filmstrip.jpg');
  const element = { ...NewImageElement(), inputSource: 0, fileName: 'video.mp4',
    partialPath: '/', hash: 'trusted-fixture-hash', screens: 12, notes: 'Preserve notes', tags: ['keep'] };
  const catalogueBytes = JSON.stringify({ images: [element], inputDirs: { 0: { path: oldRoot, watch: false } } });
  fs.writeFileSync(cataloguePath, catalogueBytes);
  fs.writeFileSync(previewPath, 'existing custom filmstrip bytes');
  const NodeModule = require('node:module');
  const originalLoad = NodeModule._load;
  const image = { isEmpty: () => false, resize() { return this; }, toPNG: () => Buffer.alloc(0) };
  let loaded: any;
  try {
    NodeModule._load = function(request: string, ...args: any[]) {
      if (request === 'electron') {
        return {
          app: {}, BrowserWindow: { getFocusedWindow: () => undefined },
          dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [newRoot] }) },
          nativeImage: { createFromBuffer: () => image, createFromPath: () => image },
          powerSaveBlocker: { start: () => 1, stop: () => undefined }, shell: {},
        };
      }
      return originalLoad.call(this, request, ...args);
    };
    loaded = {
      ...require('./main-globals.ts'), ...require('./main-ipc.ts'),
      ...require('./main-extract-async.ts'),
    };
  } finally {
    NodeModule._load = originalLoad;
  }
  const { GLOBALS, setUpIpcMessages, resetWatchers, closeAllWatchers } = loaded;
  const saved = { ...GLOBALS };
  const messages: any[][] = [];
  const waiters = new Map<string, (...args: any[]) => void>();
  const waitFor = (channel: string, accept: (args: any[]) => boolean = () => true): Promise<void> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No ${channel}: ${JSON.stringify(messages)}`)), 8_000);
    waiters.set(channel, (...args) => { if (accept(args)) { clearTimeout(timeout); resolve(); } });
  });
  const sender = {
    id: 1, isDestroyed: () => false,
    send: (...args: any[]) => { messages.push(args); waiters.get(args[0])?.(...args); },
  };
  try {
    const authority = buildCatalogueMediaLocationAuthority([element]);
    const hashes = new Set([element.hash]);
    const windowStub = { isDestroyed: () => false, webContents: { id: 1 }, setProgressBar: () => undefined };
    Object.assign(GLOBALS, {
      angularApp: { sender }, catalogueAccessMode: 'read-write', cataloguePersistenceActive: false,
      catalogueTransitionActive: false, catalogueSessionGeneration: 1, currentlyOpenVhaFile: cataloguePath,
      selectedSourceFolders: { 0: { path: oldRoot, watch: false, ignoredSubdirectories: ['/ignored'] } },
      authorizedCatalogueMediaLocations: authority, authorizedCatalogueImageHashes: hashes,
      authorizedSourceFolderPaths: new Set(), authorizedSourceFolderRealPaths: new Map(),
      authorizedSourceWatchPaths: new Set(), settingsPath: directory, winRef: windowStub,
    });
    resetWatchers([element]);
    const listeners = new Map<string, (...args: any[]) => void>();
    setUpIpcMessages({ on: (name: string, fn: any) => listeners.set(name, fn), handle: () => undefined },
      windowStub, directory, {}, () => true);
    const reconnected = waitFor('old-folder-reconnected');
    listeners.get('reconnect-this-folder')!({ sender }, 0);
    await reconnected;
    assert.equal(GLOBALS.selectedSourceFolders[0].path, fs.realpathSync(newRoot));
    assert.deepEqual(GLOBALS.selectedSourceFolders[0].ignoredSubdirectories, ['/ignored']);
    assert.deepEqual(GLOBALS.authorizedCatalogueMediaLocations, authority);
    assert.notEqual(GLOBALS.authorizedCatalogueMediaLocations, authority);
    assert.equal(GLOBALS.authorizedCatalogueImageHashes, hashes);
    assert.equal(messages.some(([name]) => ['started-watching-this-dir', 'new-video-meta', 'all-files-found-in-dir'].includes(name)), false);
    assert.deepEqual(messages.find(([name]) => name === 'old-folder-reconnected'),
      ['old-folder-reconnected', 0, fs.realpathSync(newRoot), oldRoot, cataloguePath]);
    const scanned = waitFor('all-files-found-in-dir');
    const imported = waitFor('import-progress-update', args => args[3] === 'done');
    listeners.get('rescan-source-folder-scope')!({ sender }, 0, '', true);
    await scanned;
    await imported;
    await new Promise<void>(resolve => setImmediate(resolve));
    const snapshot = messages.find(([name]) => name === 'all-files-found-in-dir')[2];
    assert.equal(snapshot.size, 1);
    assert.equal(snapshot.has(path.join(newRoot, 'video.mp4')), true);
    assert.equal(messages.some(([name]) => name === 'new-video-meta'), false, 'Known media must not be re-probed');
    assert.equal(fs.readFileSync(cataloguePath, 'utf8'), catalogueBytes);
    assert.equal(fs.readFileSync(previewPath, 'utf8'), 'existing custom filmstrip bytes');
  } finally {
    closeAllWatchers();
    await new Promise<void>(resolve => setImmediate(resolve));
    Object.assign(GLOBALS, saved);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
