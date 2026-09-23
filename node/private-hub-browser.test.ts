import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { NewImageElement } from '../interfaces/final-object.interface';
import { test, type TestContext } from 'node:test';
import type { PrivateHubSession } from './private-hub-session';
import type { PrivateHubBrowser as PrivateHubBrowserInstance, PrivateHubLifecycle } from './private-hub-browser';
import * as conversionDestination from './private-conversion-destination';

const app = Object.assign(new EventEmitter(), { isReady: () => true, quits: 0, quit() { this.quits++; } });
const powerMonitor = new EventEmitter();
const dialog = { showOpenDialog: async (_window: unknown, _options: unknown) => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async (_window: unknown, _options: unknown) => ({ canceled: true, filePath: undefined as string | undefined }) };
const invokeHandlers = new Map<string, (...args: any[]) => unknown>();
const ipcMain = Object.assign(new EventEmitter(), {
  handle: (channel: string, handler: (...args: any[]) => unknown) => {
    assert.equal(invokeHandlers.has(channel), false); invokeHandlers.set(channel, handler);
  },
  removeHandler: (channel: string) => { invokeHandlers.delete(channel); },
});
let load: () => Promise<void> = async () => undefined;
let createError = false;
let persistent = false;
let cleanupError = false;
let proxyRoute = 'PROXY 127.0.0.1:0';
const sessions: MockSession[] = [];
const windows: MockWindow[] = [];
const partitions: string[] = [];

class MockSession extends EventEmitter {
  storagePath: string | null = null;
  cleanups: string[] = [];
  preloads: string[];
  spellcheck: boolean;
  offline: boolean;
  permissions: (...args: any[]) => void;
  permissionCheck: () => boolean;
  devicePermission: () => boolean;
  display: (...args: any[]) => void;
  request: (...args: any[]) => void;
  headers: (...args: any[]) => void;
  handler: (request: Request) => Promise<Response>;
  protocol = { handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => { this.handler = handler; } };
  webRequest = {
    onBeforeRequest: (handler: (...args: any[]) => void) => { this.request = handler; },
    onBeforeSendHeaders: (handler: (...args: any[]) => void) => { this.headers = handler; },
  };
  isPersistent(): boolean { return persistent; }
  setPreloads(value: string[]): void { this.preloads = value; }
  setSpellCheckerEnabled(value: boolean): void { this.spellcheck = value; }
  setPermissionRequestHandler(value: (...args: any[]) => void): void { this.permissions = value; }
  setPermissionCheckHandler(value: () => boolean): void { this.permissionCheck = value; }
  setDevicePermissionHandler(value: () => boolean): void { this.devicePermission = value; }
  setDisplayMediaRequestHandler(value: (...args: any[]) => void): void { this.display = value; }
  enableNetworkEmulation(value: { offline: boolean }): void { this.offline = value.offline; }
  async setProxy(value: unknown): Promise<void> { assert.deepEqual(value, { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:0', proxyBypassRules: '<-loopback>' }); }
  async resolveProxy(): Promise<string> { return proxyRoute; }
  async clear(name: string): Promise<void> { this.cleanups.push(name); if (cleanupError && name === 'data') { throw new Error('secret diagnostics'); } }
  closeAllConnections(): Promise<void> { return this.clear('connections'); }
  clearData(): Promise<void> { return this.clear('data'); }
  clearCache(): Promise<void> { return this.clear('cache'); }
  clearCodeCaches(): Promise<void> { return this.clear('code'); }
  clearAuthCache(): Promise<void> { return this.clear('auth'); }
  clearHostResolverCache(): Promise<void> { return this.clear('dns'); }
}

class MockContents extends EventEmitter {
  id = windows.length + 1;
  popup: () => { action: string };
  rtc: string;
  destroyed = false;
  url = '';
  focused = true;
  ignoredMenuShortcuts = false;
  pastes = 0;
  selections = 0;
  isFocused(): boolean { return this.focused; }
  setIgnoreMenuShortcuts(value: boolean): void { this.ignoredMenuShortcuts = value; }
  paste(): void { this.pastes++; }
  selectAll(): void { this.selections++; }
  mainFrame = { url: '', parent: null, detached: false, isDestroyed: () => this.destroyed };
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
  setWindowOpenHandler(value: () => { action: string }): void { this.popup = value; }
  setWebRTCIPHandlingPolicy(value: string): void { this.rtc = value; }
}
class MockWindow extends EventEmitter {
  webContents = new MockContents();
  destroyed = false;
  hidden = false;
  shown = false;
  menu: unknown;
  constructor(readonly options: Record<string, any>) { super(); if (createError) { throw new Error('private constructor diagnostics'); } windows.push(this); }
  isDestroyed(): boolean { return this.destroyed; }
  hide(): void { this.hidden = true; }
  show(): void { this.shown = true; }
  destroy(): void { this.destroyed = true; this.webContents.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
  setMenu(menu: unknown): void { this.menu = menu; }
  loadURL(url: string): Promise<void> {
    assert.equal(url, 'theatrum://app/index.html');
    this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    this.webContents.url = url; this.webContents.mainFrame.url = url;
    return load();
  }
}
const defaultSession = {};
const session = {
  defaultSession,
  fromPartition: (partition: string, options: { cache: boolean }) => {
    assert.deepEqual(options, { cache: false }); partitions.push(partition);
    const value = new MockSession(); sessions.push(value); return value;
  },
};

const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let PrivateHubBrowser: typeof import('./private-hub-browser').PrivateHubBrowser;
let nativeMenus: typeof import('./private-native-menu');
let isPrivateBrowserDisposedFailure: typeof import('./private-hub-browser').isPrivateBrowserDisposedFailure;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') { return { app, powerMonitor, BrowserWindow: MockWindow, session, ipcMain, dialog }; }
    return originalLoad.call(this, request, ...args);
  };
  nativeMenus = require('./private-native-menu');
  PrivateHubBrowser = require('./private-hub-browser').PrivateHubBrowser;
  isPrivateBrowserDisposedFailure = require('./private-hub-browser').isPrivateBrowserDisposedFailure;
} finally { NodeModule._load = originalLoad; }

function fixture(t: TestContext) {
  load = async () => undefined; createError = false; persistent = false; cleanupError = false;
  proxyRoute = 'PROXY 127.0.0.1:0';
  sessions.length = 0; windows.length = 0; app.quits = 0;
  const menu = { active: false, owned: true, releases: 0, quarantines: 0, releaseError: false,
    callbacks: undefined as import('./private-native-menu').PrivateNativeMenuOptions | undefined };
  t.mock.method(nativeMenus, 'acquirePrivateNativeMenu', (options: import('./private-native-menu').PrivateNativeMenuOptions) => {
    assert.equal(menu.active, false); menu.active = true; menu.callbacks = options;
    return { check: () => menu.owned,
      release: () => { if (menu.releaseError) { throw new Error('Synthetic menu restore failure'); }
        assert.equal(windows.length === 0 || windows.at(-1).destroyed, true); menu.active = false; menu.releases++; },
      quarantine: () => { menu.quarantines++; } };
  });
  const controller = new AbortController();
  let current = true;
  let lockCompletion: Promise<void> = Promise.resolve();
  let resolveRevocation!: () => void; let rejectRevocation!: (error: unknown) => void;
  const revocationDrain = new Promise<void>((resolve, reject) => { resolveRevocation = resolve; rejectRevocation = reject; });
  void revocationDrain.catch(() => undefined);
  let locks = 0;
  let catalogueReads = 0;
  const bridgeAtLock: string[][] = [];
  const hub = {
    isCurrent: (generation: number) => current && generation === 1,
    revocationSignal: (generation: number) => { assert.equal(generation, 1); return controller.signal; },
    revocationDrained: (generation: number) => { assert.equal(generation, 1); return revocationDrain; },
    readCatalogue: async (generation: number) => { assert.equal(generation, 1); catalogueReads++; return { images: [] }; },
    readProtection: async () => ({ autoLockMinutes: 5 }),
    updateProtection: async (_generation: number, value: unknown) => value,
    lock: () => {
      bridgeAtLock.push([...invokeHandlers.keys(), ...ipcMain.eventNames().map(String)]);
      locks++; current = false; controller.abort();
      void lockCompletion.then(resolveRevocation, rejectRevocation);
      return lockCompletion;
    },
  } as unknown as PrivateHubSession;
  let browser: PrivateHubBrowserInstance | undefined;
  const create = async (overrides: Partial<import('./private-hub-browser').PrivateHubBrowserOptions> = {}) => {
    browser = await PrivateHubBrowser.create({ hub, generation: 1, appDirectory: path.resolve(__dirname, '../src'), ...overrides }); return browser;
  };
  t.after(async () => {
    await browser?.close(); assert.equal(powerMonitor.listenerCount('suspend'), 0); assert.equal(app.listenerCount('before-quit'), 0);
    assert.equal(invokeHandlers.size, 0); assert.equal(ipcMain.listenerCount('private-password-cancel'), 0);
    assert.equal(ipcMain.listenerCount('private-gallery-lock'), 0);
  });
  return { hub, create, menu, bridgeAtLock, catalogueReads: () => catalogueReads, locks: () => locks,
    delayLock: (completion: Promise<void>) => { lockCompletion = completion; } };
}

test('creates only a fresh memory session with restrictive window preferences and no ordinary preload', async t => {
  const { create } = fixture(t);
  const browser = await create();
  const isolated = sessions[0];
  const window = windows[0];
  assert.match(partitions.at(-1)!, /^private-hub-[0-9a-f]{48}$/);
  assert.equal(isolated.storagePath, null);
  assert.deepEqual(isolated.preloads, []);
  assert.equal(isolated.spellcheck, false);
  assert.equal(isolated.offline, true);
  const preferences = window.options.webPreferences;
  assert.equal(preferences.session, isolated);
  assert.equal(preferences.preload, path.resolve(__dirname, '../private-gallery-preload.cjs'));
  for (const key of ['nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker', 'allowRunningInsecureContent',
    'webviewTag', 'spellcheck', 'devTools', 'enableWebSQL', 'navigateOnDragDrop']) { assert.equal(preferences[key], false, key); }
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity', 'disableDialogs']) { assert.equal(preferences[key], true, key); }
  assert.equal(preferences.v8CacheOptions, 'none');
  assert.equal(window.options.show, false);
  assert.equal(window.menu, null);
  assert.equal(window.webContents.ignoredMenuShortcuts, true);
  assert.equal(window.webContents.rtc, 'disable_non_proxied_udp');
  browser.show();
  assert.equal(window.shown, true);
  assert.deepEqual(browser.status, { state: 'open', cleanupFailed: false });
});

test('gallery bridge exists before initial navigation and reads the catalogue only for an authorized list request', async t => {
  const { create, catalogueReads } = fixture(t);
  load = async () => {
    assert.deepEqual([...invokeHandlers.keys()].sort(), ['private-credentials-change-password', 'private-credentials-create-unprotected-copy',
      'private-credentials-touch-id-disable', 'private-credentials-touch-id-enable', 'private-credentials-touch-id-status', 'private-gallery-detail', 'private-gallery-list', 'private-gallery-protection',
      'private-gallery-regenerate', 'private-gallery-save', 'private-gallery-set-protection']);
    assert.equal(ipcMain.listenerCount('private-gallery-lock'), 1);
    assert.equal(ipcMain.listenerCount('private-password-cancel'), 0);
    assert.equal(catalogueReads(), 0);
    const contents = windows[0].webContents;
    const page = await invokeHandlers.get('private-gallery-list')!(
      { sender: contents, senderFrame: contents.mainFrame }, { query: '', offset: 0 });
    assert.deepEqual(page, { status: 'ready', total: 0, offset: 0, items: [] });
  };
  await create();
  assert.equal(catalogueReads(), 1);
});

test('private source picker belongs to its window and close waits for its stale native result', async t => {
  const f = fixture(t);
  const sourceRoot = path.resolve(__dirname, '../tmp/synthetic-private-folder');
  t.mock.method(f.hub, 'readCatalogue', async () => ({ images: [{ ...NewImageElement(),
    hash: 'source-video', cleanName: 'Synthetic video', fileName: 'synthetic.mp4', screens: 3 }],
    inputDirs: { 0: { path: sourceRoot } } }));
  const browser = await f.create(); const window = windows[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const page = await invokeHandlers.get('private-gallery-list')!(event, { query: '', offset: 0 }) as any;
  const selected = await invokeHandlers.get('private-gallery-detail')!(event, page.items[0].id) as any;
  let finish!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(dialog, 'showOpenDialog', async (owner: unknown, options: any) => {
    assert.equal(owner, window); assert.equal(options.defaultPath, sourceRoot);
    assert.deepEqual(options.properties, ['openDirectory', 'noResolveAliases', 'dontAddToRecent']);
    assert.equal(options.securityScopedBookmarks, false); started();
    await new Promise<void>(resolve => { finish = resolve; });
    return { canceled: false, filePaths: [sourceRoot] };
  });
  const generating = invokeHandlers.get('private-gallery-regenerate')!(event, {
    id: selected.item.id, revision: selected.item.revision });
  await ready;
  let closed = false; const closing = browser.close().then(() => { closed = true; });
  assert.equal(window.destroyed, true); assert.equal(invokeHandlers.size, 0);
  await Promise.resolve(); await Promise.resolve(); assert.equal(closed, false);
  finish();
  assert.deepEqual(await generating, { status: 'unavailable' }); await closing;
  assert.equal(browser.status.cleanupFailed, false);
});

test('gallery lock removes its bridge before locking storage or destroying the renderer', async t => {
  const { create, bridgeAtLock, locks } = fixture(t);
  const browser = await create();
  const window = windows[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const lock = ipcMain.listeners('private-gallery-lock')[0];
  let bridgeAtDestroy: string[] | undefined;
  const destroy = window.destroy.bind(window);
  window.destroy = () => {
    bridgeAtDestroy = [...invokeHandlers.keys(), ...ipcMain.eventNames().map(String)];
    destroy();
  };
  ipcMain.emit('private-gallery-lock', event);
  assert.equal(window.destroyed, true);
  assert.deepEqual(bridgeAtLock, [[]]);
  assert.deepEqual(bridgeAtDestroy, []);
  assert.equal(locks(), 1);
  lock(event);
  assert.equal(locks(), 1, 'retained callbacks cannot reenter a retired gallery');
  await browser.closed;
});

test('an unsafe gallery preload is refused before a window or bridge is created', async t => {
  const filesystem = require('node:fs');
  const originalStat = filesystem.lstatSync;
  const originalRealpath = filesystem.realpathSync.native;
  const preload = path.resolve(__dirname, '../private-gallery-preload.cjs');
  for (const unsafe of ['symlink', 'non-file', 'hard-link', 'non-canonical']) {
    const { create, locks } = fixture(t);
    try {
      filesystem.lstatSync = (file: unknown, ...args: unknown[]) => file === preload
        ? { isFile: () => unsafe !== 'non-file', isSymbolicLink: () => unsafe === 'symlink', nlink: unsafe === 'hard-link' ? 2 : 1 }
        : originalStat(file, ...args);
      filesystem.realpathSync.native = (file: unknown, ...args: unknown[]) => file === preload && unsafe === 'non-canonical'
        ? preload + '.unexpected' : originalRealpath(file, ...args);
      await assert.rejects(create(), { message: 'The private browser is unavailable.' });
      assert.equal(windows.length, 0, unsafe);
      assert.equal(invokeHandlers.size, 0, unsafe);
      assert.equal(ipcMain.listenerCount('private-gallery-lock'), 0, unsafe);
      assert.equal(locks(), 1, unsafe);
    } finally {
      filesystem.lstatSync = originalStat;
      filesystem.realpathSync.native = originalRealpath;
    }
  }
});

test('gallery preload failure synchronously retires the bridge and locks the hub', async t => {
  const { create, locks, bridgeAtLock } = fixture(t);
  const browser = await create();
  windows[0].webContents.emit('preload-error');
  assert.equal(windows[0].destroyed, true);
  assert.equal(locks(), 1);
  assert.deepEqual(bridgeAtLock, [[]]);
  await browser.closed;
});

test('network gate binds requests to this window, its exact entry page, and valid app/media routes', async t => {
  const { create } = fixture(t);
  const browser = await create();
  const isolated = sessions[0];
  const allowed = (url: string, changes: Record<string, unknown> = {}) => {
    let result: { cancel: boolean };
    isolated.request({ url, method: 'GET', webContentsId: windows[0].webContents.id, resourceType: 'image', ...changes }, (value: { cancel: boolean }) => { result = value; });
    return !result!.cancel;
  };
  assert.equal(allowed('theatrum://app/media/thumbnails/video.jpg'), true);
  assert.equal(allowed('theatrum://app/index.html', { resourceType: 'mainFrame' }), true);
  assert.equal(allowed('theatrum://app/app.js', { resourceType: 'mainFrame' }), false);
  assert.equal(allowed('theatrum://app/index.html', { webContentsId: 999 }), false);
  assert.equal(allowed('theatrum://app/index.html', { method: 'POST' }), false);
  for (const url of ['http://localhost:4200/', 'https://example.invalid/', 'ws://localhost:4200/', 'file:///private/source.mp4',
    'theatrum://other/index.html', 'theatrum://app/media/clips/secret.json']) { assert.equal(allowed(url), false); }
  await browser.close();
  assert.equal(allowed('theatrum://app/index.html'), false, 'retired session keeps denying requests');
});

test('denies permissions, devices, capture, downloads, navigation, popup, and title changes', async t => {
  const { create } = fixture(t); await create();
  const isolated = sessions[0]; const contents = windows[0].webContents;
  assert.equal(isolated.permissionCheck(), false);
  assert.equal(isolated.devicePermission(), false);
  isolated.permissions(null, 'media', (allowed: boolean) => assert.equal(allowed, false));
  isolated.display({}, (streams: unknown) => assert.deepEqual(streams, {}));
  let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  isolated.emit('will-download', event);
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview', 'page-title-updated']) { contents.emit(name, event); }
  assert.equal(prevented, 6);
  assert.deepEqual(contents.popup(), { action: 'deny' });
  isolated.headers({ requestHeaders: { Cookie: 'private-cookie', Authorization: 'private-auth', Referer: 'private-title', Range: 'bytes=1-2' } },
    (value: { requestHeaders: unknown }) => assert.deepEqual(value.requestHeaders, { Range: 'bytes=1-2' }));
});

test('lock synchronously destroys the private renderer without waiting for storage or renderer acknowledgement', async t => {
  const { create, delayLock, locks } = fixture(t);
  let release: () => void;
  delayLock(new Promise(resolve => { release = resolve; }));
  const browser = await create();
  let closed = false;
  const pending = browser.close().then(() => { closed = true; });
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows[0].hidden, true);
  assert.equal(browser.status.state, 'closed');
  assert.equal(locks(), 1);
  assert.throws(() => browser.show());
  await Promise.resolve(); assert.equal(closed, false);
  release!(); await pending;
  await browser.close(); assert.equal(locks(), 1);
  assert.deepEqual(sessions[0].cleanups.sort(), ['auth', 'cache', 'code', 'connections', 'data', 'dns']);
});

test('external store/session revocation destroys immediately without recursively locking the hub', async t => {
  const { create, hub, locks } = fixture(t); const browser = await create();
  await hub.lock();
  assert.equal(windows[0].destroyed, true);
  await browser.closed;
  assert.equal(locks(), 1);
});

for (const event of ['suspend', 'lock-screen', 'shutdown', 'render-process-gone', 'unresponsive', 'closed']) {
  test(`${event} revokes hub access and destroys private content`, async t => {
    const { create, locks } = fixture(t); const browser = await create();
    if (['suspend', 'lock-screen', 'shutdown'].includes(event)) { powerMonitor.emit(event); }
    else if (event === 'closed') { windows[0].emit(event); }
    else { windows[0].webContents.emit(event); }
    assert.equal(windows[0].destroyed, true); assert.equal(locks(), 1);
    await browser.closed;
  });
}

test('quit waits for owned storage drain after immediate revocation', async t => {
  const { create, delayLock } = fixture(t);
  let release: () => void; delayLock(new Promise(resolve => { release = resolve; }));
  const browser = await create(); let prevented = false;
  app.emit('before-quit', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(windows[0].destroyed, true); assert.equal(app.quits, 0);
  release!(); await browser.closed; await Promise.resolve();
  assert.equal(app.quits, 1);
});

test('externally owned gallery revokes immediately and drains without a competing system or quit observer', async t => {
  const { create, delayLock } = fixture(t);
  let release!: () => void;
  delayLock(new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const browser = await create({ lifecycle: 'external', signal: controller.signal });
  for (const event of ['suspend', 'lock-screen', 'shutdown']) {
    assert.equal(powerMonitor.listenerCount(event), 0);
  }
  assert.equal(app.listenerCount('before-quit'), 0);
  let complete = false;
  void browser.closed.then(() => { complete = true; });
  controller.abort();
  assert.equal(windows[0].destroyed, true);
  await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(app.quits, 0);
  release(); await browser.closed;
  assert.equal(complete, true);
  assert.equal(app.quits, 0);
});

test('externally owned gallery requires a real abort lifetime before creating native resources', async t => {
  const { create, locks } = fixture(t);
  await assert.rejects(create({ lifecycle: 'external' }));
  assert.equal(sessions.length, 0);
  assert.equal(windows.length, 0);
  assert.equal(locks(), 0);
});

test('failed cleanup attempts all other clearing steps and never reuses the retired partition', async t => {
  const first = fixture(t); const browser = await first.create(); const partition = partitions.at(-1);
  cleanupError = true; await browser.close();
  assert.deepEqual(browser.status, { state: 'closed', cleanupFailed: true });
  assert.equal(sessions[0].cleanups.length, 6);
  const second = fixture(t); const replacement = await second.create();
  assert.notEqual(partitions.at(-1), partition); await replacement.close();
});

test('unexpected persistent session is neither adopted nor cleared and the private hub locks', async t => {
  const { create, locks } = fixture(t); persistent = true;
  await assert.rejects(create(), { message: 'The private browser is unavailable.' });
  assert.equal(locks(), 1); assert.equal(windows.length, 0); assert.equal(sessions[0].cleanups.length, 0);
  assert.equal(sessions[0].preloads, undefined);
});

test('window creation or entry loading failure locks and disposes partial state', async t => {
  const first = fixture(t); createError = true; await assert.rejects(first.create()); assert.equal(first.locks(), 1);
  const second = fixture(t); load = async () => { throw new Error('private source details'); };
  await assert.rejects(second.create(), { message: 'The private browser is unavailable.' });
  assert.equal(windows[0].destroyed, true); assert.equal(second.locks(), 1);
});

test('revocation while entry loading is pending prevents late startup from restoring the window', async t => {
  const { create, hub } = fixture(t);
  let release: () => void; load = () => new Promise(resolve => { release = resolve; });
  const opening = create(); const rejected = assert.rejects(opening);
  while (windows.length === 0) { await new Promise(resolve => setImmediate(resolve)); }
  await hub.lock(); assert.equal(windows[0].destroyed, true); release!(); await rejected;
});

test('an invalid entry directory is refused before creating a private renderer', async t => {
  const { hub, locks } = fixture(t);
  await assert.rejects(PrivateHubBrowser.create({ hub, generation: 1, appDirectory: path.join(__dirname, 'absent-private-app') }));
  assert.equal(windows.length, 0);
  assert.equal(locks(), 1);
});

test('repeated quit requests cannot bypass pending storage cleanup or resume quit twice', async t => {
  const { create, delayLock } = fixture(t);
  let release: () => void; delayLock(new Promise(resolve => { release = resolve; }));
  const browser = await create(); let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  app.emit('before-quit', event); app.emit('before-quit', event);
  assert.equal(prevented, 2); assert.equal(app.quits, 0);
  release!(); await browser.closed; await Promise.resolve();
  assert.equal(app.quits, 1); assert.equal(app.listenerCount('before-quit'), 0);
});

test('quit during an already-started close still waits for its storage drain', async t => {
  const { create, delayLock } = fixture(t);
  let release: () => void; delayLock(new Promise(resolve => { release = resolve; }));
  const browser = await create(); const pending = browser.close(); let prevented = false;
  app.emit('before-quit', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(app.quits, 0);
  release!(); await pending; await Promise.resolve(); assert.equal(app.quits, 1);
});

test('failed native destruction retains admission until the old renderer is actually destroyed', async t => {
  const { create, hub } = fixture(t); const browser = await create(); const window = windows[0];
  const destroy = window.destroy.bind(window);
  window.destroy = () => { throw new Error('Synthetic native destruction failure'); };
  await browser.close();
  assert.equal(window.hidden, true); assert.equal(window.destroyed, false);
  assert.equal(browser.status.cleanupFailed, true); assert.equal(hub.isCurrent(1), false);
  const replacement = { isCurrent: () => true } as unknown as PrivateHubSession;
  await assert.rejects(PrivateHubBrowser.create({ hub: replacement, generation: 1, appDirectory: path.resolve(__dirname, '../src') }));
  window.destroy = destroy; window.destroy();
});

test('a proxy configuration that permits direct fallback prevents private renderer creation', async t => {
  const { create, locks } = fixture(t); proxyRoute = 'DIRECT';
  await assert.rejects(create());
  assert.equal(windows.length, 0); assert.equal(locks(), 1);
});

async function passwordPrompt(lifecycle: PrivateHubLifecycle = 'standalone') {
  const controller = new AbortController();
  let failed: unknown;
  const pending = PrivateHubBrowser.requestPassword({ signal: controller.signal, isCurrent: () => true, lifecycle });
  void pending.catch(error => { failed = error; });
  while (!windows[0]?.shown) {
    if (failed) { throw failed; }
    await new Promise(resolve => setImmediate(resolve));
  }
  const window = windows[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { controller, pending, window, event, isolated: sessions[0] };
}

test('password submission destroys the prompt and removes IPC before releasing credentials after cleanup', async t => {
  fixture(t);
  const { pending, window, event, isolated } = await passwordPrompt();
  assert.equal(window.options.webPreferences.preload, path.resolve(__dirname, '../private-password-preload.cjs'));
  assert.deepEqual([...invokeHandlers.keys()], ['private-password-submit', 'private-password-touch-id-available', 'private-password-touch-id']);
  assert.equal(ipcMain.listenerCount('private-gallery-lock'), 0);
  assert.deepEqual(isolated.preloads, []);
  assert.equal((await isolated.handler(new Request('theatrum://app/media/thumbnails/video.jpg'))).status, 404);
  let release: () => void;
  isolated.clearData = () => new Promise(resolve => { release = resolve; });
  let returned = false; void pending.then(() => { returned = true; });
  assert.equal(invokeHandlers.get('private-password-submit')!(event, '  synthetic password  '), true);
  assert.equal(window.destroyed, true);
  assert.equal(invokeHandlers.size, 0);
  assert.equal(ipcMain.listenerCount('private-password-cancel'), 0);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(returned, false);
  release!();
  assert.equal(await pending, '  synthetic password  ');
});

test('externally owned password prompt clears on parent abort without retrying application quit', async t => {
  fixture(t);
  const { pending, window, controller, isolated } = await passwordPrompt('external');
  for (const event of ['suspend', 'lock-screen', 'shutdown']) {
    assert.equal(powerMonitor.listenerCount(event), 0);
  }
  assert.equal(app.listenerCount('before-quit'), 0);
  let release!: () => void;
  isolated.clearData = () => new Promise(resolve => { release = resolve; });
  let complete = false;
  void pending.then(() => { complete = true; });
  controller.abort();
  assert.equal(window.destroyed, true);
  assert.equal(invokeHandlers.size, 0);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(app.quits, 0);
  release();
  assert.equal(await pending, undefined);
  assert.equal(app.quits, 0);
});

test('prompt cancel, system lock, and external cancellation clear the window without a credential result', async t => {
  for (const action of ['cancel', 'lock', 'abort']) {
    fixture(t);
    const { pending, window, event, controller } = await passwordPrompt();
    if (action === 'cancel') { ipcMain.emit('private-password-cancel', event); }
    else if (action === 'lock') { powerMonitor.emit('lock-screen'); }
    else { controller.abort(); }
    assert.equal(window.destroyed, true, action);
    assert.equal(await pending, undefined, action);
  }
});

test('failed prompt cleanup never releases a submitted password', async t => {
  fixture(t);
  const { pending, window, event } = await passwordPrompt();
  const rejected = assert.rejects(pending, (error: Error) => {
    assert.equal(error.message, 'The private browser is unavailable.');
    assert.equal(isPrivateBrowserDisposedFailure(error), false); return true;
  });
  cleanupError = true;
  invokeHandlers.get('private-password-submit')!(event, 'synthetic secret');
  await rejected;
  assert.equal(window.destroyed, true);
});

test('final credential handoff rechecks abort after a reentrant authority callback', async t => {
  fixture(t);
  const controller = new AbortController();
  const pending = PrivateHubBrowser.requestPassword({ signal: controller.signal, isCurrent: () => {
    if (windows[0]?.destroyed) { controller.abort(); }
    return true;
  } });
  while (!windows[0]?.shown) { await new Promise(resolve => setImmediate(resolve)); }
  const contents = windows[0].webContents;
  invokeHandlers.get('private-password-submit')!({ sender: contents, senderFrame: contents.mainFrame }, 'synthetic password');
  assert.equal(await pending, undefined);
});

test('only proven-clean factory failures receive the main-only disposed classification', async t => {
  const { create } = fixture(t);
  load = async () => { throw new Error('synthetic startup failure'); };
  await assert.rejects(create(), (error: Error) => {
    assert.equal(isPrivateBrowserDisposedFailure(error), true); return true;
  });
  assert.equal(isPrivateBrowserDisposedFailure(new Error('The private browser is unavailable.')), false);
});

test('preload failure retires the credential window and revokes its IPC', async t => {
  fixture(t);
  const { pending, window } = await passwordPrompt();
  window.webContents.emit('preload-error');
  assert.equal(window.destroyed, true);
  assert.equal(await pending, undefined);
  assert.equal(invokeHandlers.size, 0);
});

test('additional main transition cancellation synchronously destroys an unlocked capsule', async t => {
  const { create, locks } = fixture(t);
  const controller = new AbortController();
  const browser = await create({ signal: controller.signal, isAuthorized: () => true });
  controller.abort();
  assert.equal(windows[0].destroyed, true);
  assert.equal(locks(), 1);
  await browser.closed;
});

test('main authority denial or failure blocks late entry delivery and showing a capsule', async t => {
  const { create } = fixture(t);
  let allowed = true;
  const browser = await create({ isAuthorized: () => { if (!allowed) { throw new Error('private diagnostics'); } return true; } });
  allowed = false;
  assert.throws(() => browser.show(), { message: 'The private browser is unavailable.' });
  assert.equal((await sessions[0].handler(new Request('theatrum://app/index.html'))).status, 404);
  await browser.close();
});

for (const failure of ['false', 'throw'] as const) {
  for (const observation of ['timer', 'native-input', 'request'] as const) {
    test(`${observation} retires the complete browser when main authority becomes ${failure} without an abort`, async t => {
      const { performance } = await import('node:perf_hooks');
      let now = 0;
      t.mock.method(performance, 'now', () => now);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture(t);
      const transition = new AbortController();
      let authorized = true;
      t.mock.method(f.hub, 'readProtection', async () => ({ autoLockMinutes: observation === 'timer' ? 1 : 0 }));
      const browser = await f.create({ signal: transition.signal, isAuthorized: () => {
        if (authorized) { return true; }
        if (failure === 'throw') { throw new Error('Synthetic private authority diagnostics'); }
        return false;
      } });
      browser.show();
      const window = windows[0];
      const isolated = sessions[0];
      const sourceSignal = f.hub.revocationSignal(1);
      authorized = false;
      assert.equal(transition.signal.aborted, false);
      assert.equal(sourceSignal.aborted, false);
      now = 30_000;
      if (observation === 'timer') {
        // Fire early to prove authority loss itself, not deadline expiry, locks.
        t.mock.timers.tick(60_000);
      } else if (observation === 'native-input') {
        let prevented = false;
        window.webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown' });
        assert.equal(prevented, true);
      } else {
        let cancelled = false;
        isolated.request({ url: 'theatrum://app/index.html', method: 'GET',
          webContentsId: window.webContents.id, resourceType: 'mainFrame' }, (result: { cancel: boolean }) => { cancelled = result.cancel; });
        assert.equal(cancelled, true);
      }
      assert.equal(window.destroyed, true);
      assert.equal(window.hidden, true);
      assert.equal(f.locks(), 1);
      assert.equal(sourceSignal.aborted, true);
      assert.equal(transition.signal.aborted, false, 'The browser owns revocation; it does not mutate its caller signal');
      assert.equal(invokeHandlers.size, 0);
      assert.deepEqual(f.bridgeAtLock, [[]]);
      await browser.closed;
      assert.deepEqual(browser.status, { state: 'closed', cleanupFailed: false });
      assert.deepEqual(isolated.cleanups.sort(), ['auth', 'cache', 'code', 'connections', 'data', 'dns']);
      authorized = true;
      assert.throws(() => browser.show(), { message: 'The private browser is unavailable.' });
      assert.equal((await isolated.handler(new Request('theatrum://app/index.html'))).status, 404);
      t.mock.timers.tick(120_000);
      assert.equal(f.locks(), 1);
    });
  }
}

test('loads encrypted protection before creating a renderer and fails closed on damaged settings', async t => {
  const f = fixture(t);
  t.mock.method(f.hub, 'readProtection', async () => {
    assert.equal(windows.length, 0);
    throw new Error('private settings diagnostics');
  });
  await assert.rejects(f.create(), /private browser is unavailable/);
  assert.equal(windows.length, 0);
  assert.equal(f.locks(), 1);
});

test('a revoked slow protection read cannot create a late private window', async t => {
  const f = fixture(t);
  let finish!: () => void;
  t.mock.method(f.hub, 'readProtection', async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { autoLockMinutes: 1 };
  });
  const pending = f.create();
  const rejected = assert.rejects(pending);
  await f.hub.lock();
  finish(); await rejected;
  assert.equal(windows.length, 0);
});

test('native key and deliberate mouse activity renews the timer while requests and mouse movement do not', async t => {
  const { performance } = await import('node:perf_hooks');
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  t.mock.method(f.hub, 'readProtection', async () => ({ autoLockMinutes: 1 }));
  const browser = await f.create();
  const contents = windows[0].webContents;
  const event = { preventDefault: () => assert.fail('current input must be accepted') };
  now = 40_000;
  contents.emit('before-input-event', event, { type: 'keyDown' });
  now = 80_000;
  contents.emit('before-mouse-event', event, { type: 'mouseDown' });
  now = 120_000;
  contents.emit('before-mouse-event', event, { type: 'mouseWheel' });
  now = 175_000;
  contents.emit('before-mouse-event', event, { type: 'mouseMove' });
  const ipcEvent = { sender: contents, senderFrame: contents.mainFrame };
  assert.deepEqual(await invokeHandlers.get('private-gallery-protection')!(ipcEvent), { status: 'ready', autoLockMinutes: 1 });
  now = 180_000;
  t.mock.timers.tick(60_000);
  assert.equal(windows[0].destroyed, true);
  assert.equal(f.locks(), 1);
  await browser.closed;
});

test('an overdue setting change or native input cannot revive an unlocked hub', async t => {
  const { performance } = await import('node:perf_hooks');
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = fixture(t);
  t.mock.method(f.hub, 'readProtection', async () => ({ autoLockMinutes: 1 }));
  const browser = await f.create();
  const contents = windows[0].webContents;
  const change = invokeHandlers.get('private-gallery-set-protection')!;
  now = 60_001;
  let prevented = false;
  contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown' });
  assert.equal(prevented, true);
  assert.deepEqual(await change({ sender: contents, senderFrame: contents.mainFrame }, { autoLockMinutes: 0 }), { status: 'unavailable' });
  assert.equal(windows[0].destroyed, true);
  await browser.closed;
});

test('saved Off and timeout changes apply to the live main timer without resetting elapsed activity', async t => {
  const { performance } = await import('node:perf_hooks');
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = fixture(t);
  const browser = await f.create();
  const contents = windows[0].webContents;
  const ipcEvent = { sender: contents, senderFrame: contents.mainFrame };
  const change = invokeHandlers.get('private-gallery-set-protection')!;
  now = 100_000;
  assert.deepEqual(await change(ipcEvent, { autoLockMinutes: 0 }), { status: 'saved', autoLockMinutes: 0 });
  now = 600_000;
  assert.equal((await invokeHandlers.get('private-gallery-protection')!(ipcEvent) as any).status, 'ready');
  // Turning on a shorter timeout after inactivity locks immediately unless the
  // change was preceded by genuine input (as it is during ordinary UI use).
  assert.deepEqual(await change(ipcEvent, { autoLockMinutes: 1 }), { status: 'unavailable' });
  assert.equal(windows[0].destroyed, true);
  await browser.closed;
});


test('unprotected copy picker is window-owned, avoids recent documents, and drains a stale selection on close', async t => {
  const f = fixture(t);
  let finish!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let receivedSignal!: AbortSignal;
  Object.assign(f.hub, { createUnprotectedCopy: async (_generation: number, _value: unknown, _current: () => boolean,
    options: { chooseDestination: () => Promise<string | undefined>; signal: AbortSignal }) => {
    receivedSignal = options.signal; await options.chooseDestination(); return 'copied';
  } });
  const browser = await f.create(); const window = windows[0];
  const destination = path.resolve(__dirname, '../tmp/synthetic-unprotected-copy');
  t.mock.method(dialog, 'showSaveDialog', async (owner: unknown, options: any) => {
    assert.equal(owner, window); assert.equal(options.title, 'Create unprotected copy');
    assert.equal(options.defaultPath, 'Unprotected hub');
    assert.deepEqual(options.properties, ['createDirectory', 'dontAddToRecent']);
    assert.equal(options.securityScopedBookmarks, false); started();
    await new Promise<void>(resolve => { finish = resolve; });
    return { canceled: false, filePath: destination };
  });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const copying = invokeHandlers.get('private-credentials-create-unprotected-copy')!(event, { password: 'Synthetic', acknowledge: true });
  await ready;
  let closed = false; const closing = browser.close().then(() => { closed = true; });
  assert.equal(window.destroyed, true); assert.equal(receivedSignal.aborted, true);
  await Promise.resolve(); await Promise.resolve(); assert.equal(closed, false);
  finish(); assert.deepEqual(await copying, { status: 'unavailable' }); await closing;
  assert.equal(browser.status.cleanupFailed, false);
});


test('private native controls precede renderer allocation and restore only after renderer and storage drainage', async t => {
  const f = fixture(t); let finish!: () => void;
  f.delayLock(new Promise<void>(resolve => { finish = resolve; }));
  t.mock.method(f.hub, 'readProtection', async () => {
    assert.equal(f.menu.active, true); assert.equal(windows.length, 0); return { autoLockMinutes: 5 };
  });
  const browser = await f.create(); const closing = browser.close();
  assert.equal(windows[0].destroyed, true); assert.equal(f.menu.active, true); assert.equal(f.menu.releases, 0);
  finish(); await closing; assert.equal(f.menu.releases, 1); assert.equal(f.menu.active, false);
});

test('clipboard shortcuts and context menus are blocked natively while explicit paste and selection stay scoped', async t => {
  const f = fixture(t); await f.create(); const contents = windows[0].webContents;
  const primary = process.platform === 'darwin' ? { meta: true } : { control: true };
  let prevented = 0; const event = { preventDefault: () => { prevented++; } };
  for (const key of ['c', 'x', 'e', 's', 'p']) { contents.emit('before-input-event', event, { type: 'keyDown', key, ...primary }); }
  contents.emit('context-menu', event); assert.equal(prevented, 6);
  contents.emit('before-input-event', event, { type: 'keyDown', key: 'v', ...primary });
  contents.emit('before-input-event', event, { type: 'keyUp', key: 'v', ...primary });
  contents.emit('before-input-event', event, { type: 'keyDown', key: 'a', ...primary });
  assert.equal(contents.pastes, 1); assert.equal(contents.selections, 1);
  contents.focused = false;
  f.menu.callbacks.onPaste(); f.menu.callbacks.onSelectAll();
  assert.equal(contents.pastes, 1); assert.equal(contents.selections, 1);
  contents.focused = true; f.menu.callbacks.onPaste(); f.menu.callbacks.onSelectAll();
  assert.equal(contents.pastes, 2); assert.equal(contents.selections, 2);
});

test('close shortcut and private menu action use the owned browser lock lifecycle', async t => {
  const f = fixture(t); const browser = await f.create(); const contents = windows[0].webContents;
  const primary = process.platform === 'darwin' ? { meta: true } : { control: true };
  let prevented = false;
  contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'w', ...primary });
  assert.equal(prevented, true); assert.equal(windows[0].destroyed, true); await browser.closed;
  assert.equal(f.locks(), 1); assert.equal(f.menu.releases, 1);
});

test('observing replacement of the private application menu retires and quarantines the browser', async t => {
  const f = fixture(t); const browser = await f.create(); f.menu.owned = false;
  assert.throws(() => browser.show(), /unavailable/); await browser.closed;
  assert.equal(windows[0].destroyed, true); assert.equal(browser.status.cleanupFailed, true);
  assert.equal(f.menu.releases, 0); assert.equal(f.menu.quarantines, 1);
});

test('failed private cleanup never restores the ordinary application menu', async t => {
  const f = fixture(t); const browser = await f.create(); cleanupError = true; await browser.close();
  assert.equal(browser.status.cleanupFailed, true); assert.equal(f.menu.releases, 0); assert.equal(f.menu.quarantines, 1);
});

test('menu restoration failure is part of private cleanup failure', async t => {
  const f = fixture(t); const browser = await f.create(); f.menu.releaseError = true; await browser.close();
  assert.equal(browser.status.cleanupFailed, true);
});

test('password prompt uses the same native copy protections and restores its menu after cancellation', async t => {
  const f = fixture(t); const controller = new AbortController();
  const prompting = PrivateHubBrowser.requestPassword({ signal: controller.signal, isCurrent: () => true });
  while (windows.length === 0) { await new Promise(resolve => setImmediate(resolve)); }
  const contents = windows[0].webContents; let prevented = false;
  const primary = process.platform === 'darwin' ? { meta: true } : { control: true };
  contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'c', ...primary });
  assert.equal(contents.ignoredMenuShortcuts, true); assert.equal(prevented, true); assert.equal(f.menu.callbacks.kind, 'password');
  f.menu.callbacks.onClose(); assert.equal(await prompting, undefined); assert.equal(f.menu.releases, 1);
});


test('closed browser callbacks cannot paste, select or falsely quarantine menu restoration', async t => {
  const f = fixture(t); let finish!: () => void;
  f.delayLock(new Promise<void>(resolve => { finish = resolve; }));
  const browser = await f.create(); const contents = windows[0].webContents; const closing = browser.close();
  f.menu.callbacks.onPaste(); f.menu.callbacks.onSelectAll();
  // A late retired-session resource callback must deny access without reading a restoring menu.
  f.menu.owned = false;
  assert.equal((await sessions[0].handler(new Request('theatrum://app/index.html'))).status, 404);
  assert.equal(contents.pastes, 0); assert.equal(contents.selections, 0);
  f.menu.owned = true; finish(); await closing;
  assert.equal(browser.status.cleanupFailed, false); assert.equal(f.menu.releases, 1);
});

test('native edit failures retire and quarantine the private browser', async t => {
  const f = fixture(t); const browser = await f.create();
  t.mock.method(windows[0].webContents, 'paste', () => { throw new Error('Synthetic native edit failure'); });
  assert.throws(() => f.menu.callbacks.onPaste()); await browser.closed;
  assert.equal(windows[0].destroyed, true); assert.equal(browser.status.cleanupFailed, true); assert.equal(f.menu.quarantines, 1);
});

for (const ambiguous of [false, true]) {
  test('native menu installation failure is ' + (ambiguous ? 'quarantined' : 'safely disposed before mutation'), async t => {
    const f = fixture(t); const error = new Error('Synthetic menu installation failure');
    t.mock.method(nativeMenus, 'acquirePrivateNativeMenu', () => { throw error; });
    t.mock.method(nativeMenus, 'isPrivateNativeMenuCleanupFailure', value => value === error && ambiguous);
    await assert.rejects(f.create(), value => isPrivateBrowserDisposedFailure(value) === !ambiguous);
    assert.equal(windows.length, 0); assert.equal(f.menu.releases, 0);
  });
}


test('externally initiated lock retains the private menu until captured generation storage drainage completes', async t => {
  const f = fixture(t); let finish!: () => void;
  f.delayLock(new Promise<void>(resolve => { finish = resolve; }));
  const browser = await f.create(); let closed = false;
  void browser.closed.then(() => { closed = true; });
  const locking = f.hub.lock(); assert.equal(windows[0].destroyed, true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, false); assert.equal(f.menu.releases, 0); assert.equal(f.locks(), 1);
  finish(); await Promise.all([locking, browser.closed]);
  assert.equal(f.menu.releases, 1); assert.equal(browser.status.cleanupFailed, false);
});

test('late external storage cleanup failure quarantines rather than restores the application menu', async t => {
  const f = fixture(t); let fail!: (error: Error) => void;
  f.delayLock(new Promise<void>((_resolve, reject) => { fail = reject; }));
  const browser = await f.create(); const locking = assert.rejects(f.hub.lock(), /Synthetic/);
  assert.equal(windows[0].destroyed, true); assert.equal(f.menu.releases, 0);
  fail(new Error('Synthetic external storage failure')); await Promise.all([locking, browser.closed]);
  assert.equal(browser.status.cleanupFailed, true); assert.equal(f.menu.releases, 0); assert.equal(f.menu.quarantines, 1);
});


const conversionReview = { videos: 2, availablePreviews: 4, previewBytes: 2048,
  missingPreviews: { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 } };

async function conversionPrompt(options: Partial<import('./private-hub-browser').PrivateConversionPromptOptions> = {}) {
  const controller = new AbortController();
  let retirements = 0;
  const pending = PrivateHubBrowser.requestConversion({
    review: conversionReview, signal: controller.signal, isCurrent: () => true,
    onRetire: () => { retirements++; }, start: async () => undefined, ...options,
  });
  for (let turn = 0; !windows[0]?.shown && turn < 100; turn++) { await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(windows[0]?.shown, true);
  const window = windows[0];
  const contents = window.webContents;
  return { pending, window, controller, event: { sender: contents, senderFrame: contents.mainFrame }, retirements: () => retirements };
}

test('creation uses isolated form-only routes and returns credentials only after browser cleanup', async t => {
  const f = fixture(t);
  const prepared = { directory: '/Users/sm/Workspace/synthetic-created-hub', password: 'synthetic creation password' };
  let pickerCalls = 0;
  t.mock.method(dialog, 'showOpenDialog', async (window, options) => {
    pickerCalls++;
    assert.equal(window, windows[0]);
    assert.deepEqual(options, { title: 'Create private copy',
      message: 'Choose a folder to contain the encrypted copy. A new “Private hub” subfolder will be created; existing files will not be replaced.',
      buttonLabel: 'Create private copy here',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'], securityScopedBookmarks: false });
    return { canceled: false, filePaths: ['/Users/sm/Workspace/selected-parent'] };
  });
  t.mock.method(conversionDestination, 'privateConversionDestination', async parent => {
    assert.equal(parent, '/Users/sm/Workspace/selected-parent'); return prepared.directory;
  });
  const prompt = await conversionPrompt({ start: async (password, allowMissing, progress, select) => {
    assert.equal(password, prepared.password); assert.equal(allowMissing, false);
    assert.equal(await select(), prepared.directory);
    progress({ stage: 'verifying', completed: 4, total: 5 });
    return prepared;
  } });
  assert.equal(f.menu.callbacks.kind, 'conversion');
  assert.match(prompt.window.options.webPreferences.preload, /private-conversion-preload.cjs$/);
  assert.deepEqual([...invokeHandlers.keys()].sort(), ['private-conversion-state', 'private-conversion-submit']);
  assert.deepEqual((invokeHandlers.get('private-conversion-state')!(prompt.event) as import('../interfaces/private-conversion').PrivateConversionState).review, conversionReview);
  assert.equal((await sessions[0].handler(new Request('theatrum://app/unlock.js'))).status, 404);
  assert.equal((await sessions[0].handler(new Request('theatrum://app/conversion.js'))).status, 200);
  let release!: () => void;
  sessions[0].clearData = () => new Promise(resolve => { release = resolve; });
  let handedBack = false;
  void prompt.pending.then(() => { handedBack = true; });
  const submit = invokeHandlers.get('private-conversion-submit')!(prompt.event, prepared.password, false, true);
  await submit;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(prompt.window.destroyed, true); assert.equal(prompt.retirements(), 1);
  assert.equal(pickerCalls, 1); assert.equal(handedBack, false); assert.equal(f.menu.releases, 0);
  release();
  assert.deepEqual(await prompt.pending, prepared);
  assert.equal(f.menu.releases, 1);
});

test('cancelling creation destroys its form immediately but drains a pending destination dialog', async t => {
  const f = fixture(t);
  let release!: (value: { canceled: boolean; filePaths: string[] }) => void;
  let selected = false;
  t.mock.method(dialog, 'showOpenDialog', () => { selected = true; return new Promise(resolve => { release = resolve; }); });
  t.mock.method(conversionDestination, 'privateConversionDestination', async () => { assert.fail('Retired pickers cannot choose a new destination.'); });
  const prompt = await conversionPrompt({ start: async (password, _missing, _progress, select) => {
    const directory = await select();
    return directory ? { directory, password } : undefined;
  } });
  const submit = invokeHandlers.get('private-conversion-submit')!(prompt.event, 'synthetic creation password', false, true);
  while (!selected) { await new Promise(resolve => setImmediate(resolve)); }
  let settled = false;
  void prompt.pending.then(() => { settled = true; });
  ipcMain.emit('private-conversion-cancel', prompt.event);
  assert.equal(prompt.window.destroyed, true); assert.equal(prompt.retirements(), 1);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.menu.releases, 0);
  release({ canceled: false, filePaths: ['/Users/sm/Workspace/late-destination'] });
  await submit;
  assert.equal(await prompt.pending, undefined); assert.equal(f.menu.releases, 1);
});

test('ordinary copy failure retains a generic close-only form and refuses another submission', async t => {
  fixture(t);
  let starts = 0;
  const prompt = await conversionPrompt({ start: async () => { starts++; throw new Error('Sensitive synthetic path diagnostics'); } });
  const submit = invokeHandlers.get('private-conversion-submit')!;
  assert.equal(await submit(prompt.event, 'synthetic creation password', false, true), false);
  const state = invokeHandlers.get('private-conversion-state')!(prompt.event) as import('../interfaces/private-conversion').PrivateConversionState;
  assert.equal(state.phase, 'failed'); assert.equal(JSON.stringify(state).includes('Sensitive'), false);
  assert.equal(prompt.window.destroyed, false);
  assert.equal(await submit(prompt.event, 'synthetic creation password', false, true), false);
  assert.equal(starts, 1);
  ipcMain.emit('private-conversion-cancel', prompt.event);
  assert.equal(await prompt.pending, undefined);
});

test('failed creation browser cleanup never releases prepared credentials', async t => {
  fixture(t);
  const prompt = await conversionPrompt({ start: async () => ({ directory: '/Users/sm/Workspace/synthetic-created-hub', password: 'synthetic password' }) });
  const rejection = assert.rejects(prompt.pending, error => !isPrivateBrowserDisposedFailure(error));
  cleanupError = true;
  await invokeHandlers.get('private-conversion-submit')!(prompt.event, 'synthetic password', false, true);
  await rejection;
  assert.equal(prompt.window.destroyed, true);
});
