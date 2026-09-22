import { app, BrowserWindow, dialog, powerMonitor, session, type Session, type Event } from 'electron';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PrivateHubSession } from './private-hub-session';
import { THEATRUM_APP_PROTOCOL } from '../interfaces/theatrum-protocol';
import { createPrivateBrowserProtocolHandler, createPrivateUnlockProtocolHandler, isPrivateBrowserRequestAllowed,
  isPrivateUnlockRequestAllowed, PRIVATE_BROWSER_ENTRY_URL } from './private-browser-protocol';
import { registerPrivatePasswordRequest } from './private-password-request';
import { registerPrivateGalleryRequest } from './private-gallery-request';
import { PrivateHubIdleLock } from './private-hub-idle-lock';
import { acquirePrivateNativeMenu, isPrivateNativeMenuCleanupFailure } from './private-native-menu';
import type { PrivateHubUnlockChoice } from './private-hub-open';
import { privateNativeInputAction } from './private-native-input';

/** External ownership is main-only and requires a caller-owned abort lifetime. */
export type PrivateHubLifecycle = 'standalone' | 'external';

export interface PrivateHubBrowserOptions {
  readonly hub: PrivateHubSession;
  readonly generation: number;
  /** Main-owned packaged application assets, never a hub or source directory. */
  readonly appDirectory: string;
  /** Additional main-owned transition lifetime, never renderer supplied. */
  readonly signal?: AbortSignal;
  readonly isAuthorized?: () => boolean;
  /** An outer main coordinator may own all system events and the final quit. */
  readonly lifecycle?: PrivateHubLifecycle;
}

export interface PrivatePasswordPromptOptions {
  /** Main-only no-prompt query, exposing only availability to this private frame. */
  readonly touchIdAvailable?: () => Promise<boolean>;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  /** Native synthetic verification may keep the window hidden. */
  readonly visible?: boolean;
  /** An outer main coordinator may own all system events and the final quit. */
  readonly lifecycle?: PrivateHubLifecycle;
}

type BrowserAuthority = { kind: 'hub'; options: PrivateHubBrowserOptions }
  | { kind: 'password'; options: PrivatePasswordPromptOptions; submitted: (password: PrivateHubUnlockChoice) => void };

let activeBrowser: PrivateHubBrowser | undefined;
const disposedFailures = new WeakSet<Error>();
function unavailable(disposed = false): Error {
  const error = new Error('The private browser is unavailable.');
  if (disposed) { disposedFailures.add(error); }
  return error;
}

/** Main-only factory result classification; never inferred from renderer-controlled error text. */
export function isPrivateBrowserDisposedFailure(error: unknown): boolean {
  return error instanceof Error && disposedFailures.has(error);
}

/**
 * Main-only, single-use browser capsule. No ordinary preload, mutable Electron
 * session, window, key, or source path is exposed to the renderer or caller.
 * Dedicated gallery and password bridges never grant ordinary renderer access.
 */
export class PrivateHubBrowser {
  readonly #hub: PrivateHubSession | undefined;
  readonly #generation: number | undefined;
  readonly #hubRevokedDrain: Promise<void> | undefined;
  readonly #signal: AbortSignal;
  readonly #transitionSignal: AbortSignal | undefined;
  readonly #isAuthorized: () => boolean;
  readonly #appDirectory: string;
  readonly #submitted: ((password: PrivateHubUnlockChoice) => void) | undefined;
  readonly #touchIdAvailable: (() => Promise<boolean>) | undefined;
  readonly #observesSystemLifecycle: boolean;
  #disposePasswordRequest: (() => Promise<void>) | undefined;
  #disposeGalleryRequest: (() => Promise<void>) | undefined;
  #idleLock: PrivateHubIdleLock | undefined;
  #nativeMenu: ReturnType<typeof acquirePrivateNativeMenu> | undefined;
  #session: Session | undefined;
  #window: BrowserWindow | undefined;
  #state: 'opening' | 'open' | 'closed' = 'opening';
  #retiring = false;
  #cleanupFailed = false;
  #cleanupComplete = false;
  #quitRequested = false;
  #resolveClosed: () => void;
  readonly #closed: Promise<void>;

  private constructor(authority: BrowserAuthority) {
    this.#observesSystemLifecycle = authority.options.lifecycle !== 'external';
    if (authority.kind === 'hub') {
      const options = authority.options;
      this.#hub = options.hub;
      this.#generation = options.generation;
      this.#appDirectory = options.appDirectory;
      this.#signal = options.hub.revocationSignal(options.generation);
      this.#hubRevokedDrain = options.hub.revocationDrained(options.generation);
      this.#transitionSignal = options.signal;
      this.#isAuthorized = options.isAuthorized ?? (() => true);
    } else {
      this.#appDirectory = path.resolve(__dirname, '../private-unlock');
      this.#signal = authority.options.signal;
      this.#isAuthorized = authority.options.isCurrent;
      this.#submitted = authority.submitted;
      this.#touchIdAvailable = authority.options.touchIdAvailable;
    }
    this.#closed = new Promise(resolve => { this.#resolveClosed = resolve; });
  }

  static async create(options: PrivateHubBrowserOptions): Promise<PrivateHubBrowser> {
    let browser: PrivateHubBrowser | undefined;
    try {
      if (!app.isReady() || activeBrowser || !options?.hub?.isCurrent(options.generation)) { throw unavailable(); }
      if (options.lifecycle === 'external' && !(options.signal instanceof AbortSignal)) { throw unavailable(); }
      browser = new PrivateHubBrowser({ kind: 'hub', options });
      activeBrowser = browser;
      await browser.initialize();
      browser.assertCurrent();
      return browser;
    } catch {
      await browser?.close().catch(() => undefined);
      throw unavailable(browser ? browser.#cleanupComplete && !browser.#cleanupFailed && !browser.#window : !activeBrowser);
    }
  }

  /** A one-use credential window. Never returns a password until its browser has been destroyed and cleared. */
  static async requestPassword(options: PrivatePasswordPromptOptions): Promise<PrivateHubUnlockChoice | undefined> {
    let browser: PrivateHubBrowser | undefined;
    let password: PrivateHubUnlockChoice | undefined;
    try {
      const signal = options.signal;
      const isCurrent = options.isCurrent;
      const visible = options.visible !== false;
      const lifecycle = options.lifecycle;
      if (lifecycle === 'external' && !(signal instanceof AbortSignal)) { throw unavailable(); }
      if (!app.isReady() || activeBrowser || signal.aborted || isCurrent() !== true) { throw unavailable(); }
      browser = new PrivateHubBrowser({ kind: 'password', options: { signal, isCurrent, lifecycle, touchIdAvailable: options.touchIdAvailable }, submitted: value => {
        password = value;
        browser!.retire();
      } });
      activeBrowser = browser;
      await browser.initialize();
      if (visible) { browser.show(); }
      await browser.closed;
      if (browser.status.cleanupFailed) { throw unavailable(); }
      const authorized = !signal.aborted && isCurrent() === true;
      return authorized && !signal.aborted ? password : undefined;
    } catch {
      await browser?.close().catch(() => undefined);
      throw unavailable(browser ? browser.#cleanupComplete && !browser.#cleanupFailed && !browser.#window : !activeBrowser);
    } finally { password = undefined; }
  }

  get status(): Readonly<{ state: 'opening' | 'open' | 'closed'; cleanupFailed: boolean }> {
    return Object.freeze({ state: this.#state, cleanupFailed: this.#cleanupFailed });
  }

  /** Resolves after renderer, browser and captured hub-generation cleanup attempts; inspect cleanupFailed. */
  get closed(): Promise<void> { return this.#closed; }

  private active = (): boolean => this.#state !== 'closed' && !this.#signal.aborted && !this.#transitionSignal?.aborted;
  private lifetimeCurrent = (): boolean => {
    try {
      return this.active() && this.#isAuthorized() === true
        && (!this.#hub || this.#hub.isCurrent(this.#generation!)) && this.active();
    } catch { return false; }
  };
  private currentLifetimeOrRetire = (): boolean => {
    if (!this.active()) { this.retire(); return false; }
    try {
      if (this.#nativeMenu && !this.#nativeMenu.check()) { this.#cleanupFailed = true; this.retire(); return false; }
    } catch { this.#cleanupFailed = true; this.retire(); return false; }
    if (this.lifetimeCurrent()) { return true; }
    // Main authority can disappear without an AbortSignal notification. Any
    // observation must destroy decoded state, not merely stop future delivery.
    this.retire();
    return false;
  };
  private current = (): boolean => this.currentLifetimeOrRetire() && (!this.#idleLock || this.#idleLock.check());

  private assertCurrent(): void { if (!this.current()) { throw unavailable(); } }

  private readonly onRevoked = (): void => {
    if (this.#retiring && this.#cleanupComplete) { this.releaseAdmission(); }
    else { this.retire(); }
  };
  private readonly onSystemLock = (): void => { this.retire(); };
  private readonly onQuit = (event: Event): void => {
    event.preventDefault();
    if (this.#quitRequested) { return; }
    this.#quitRequested = true;
    this.retire();
    void this.#closed.then(() => app.quit());
  };

  private nativeEdit(action: 'paste' | 'select-all'): void {
    if (!this.current()) { return; }
    // A deliberate native action only. DOM policy limits incoming paste to
    // enabled credential fields. Main never reads or retains clipboard data.
    try {
      const window = this.#window;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !window.webContents.isFocused()) { return; }
      if (action === 'paste') { window.webContents.paste(); }
      else { window.webContents.selectAll(); }
      this.current();
    } catch { this.#cleanupFailed = true; this.retire(); throw unavailable(); }
  }

  private async initialize(): Promise<void> {
    try {
      this.#nativeMenu = acquirePrivateNativeMenu({ kind: this.#submitted ? 'password' : 'hub',
        onClose: () => this.retire(), onPaste: () => this.nativeEdit('paste'), onSelectAll: () => this.nativeEdit('select-all') });
    } catch (error) {
      if (isPrivateNativeMenuCleanupFailure(error)) { this.#cleanupFailed = true; }
      throw error;
    }
    this.#signal.addEventListener('abort', this.onRevoked, { once: true });
    this.#transitionSignal?.addEventListener('abort', this.onRevoked, { once: true });
    if (this.#observesSystemLifecycle) {
      powerMonitor.on('suspend', this.onSystemLock);
      powerMonitor.on('lock-screen', this.onSystemLock);
      powerMonitor.on('shutdown', this.onSystemLock);
      app.on('before-quit', this.onQuit);
    }
    this.assertCurrent();
    if (this.#hub) {
      const protection = await this.#hub.readProtection(this.#generation!);
      this.assertCurrent();
      this.#idleLock = new PrivateHubIdleLock({ minutes: protection.autoLockMinutes,
        isCurrent: this.currentLifetimeOrRetire, onLock: () => this.retire() });
      this.assertCurrent();
    }
    // Never reuse a partition, including after failed setup or failed cleanup.
    const partition = 'private-hub-' + randomBytes(24).toString('hex');
    const isolated = session.fromPartition(partition, { cache: false });
    if (isolated === session.defaultSession || isolated.isPersistent() || isolated.storagePath !== null) { throw unavailable(); }
    // Never adopt or clear an unexpectedly persistent/default session.
    this.#session = isolated;
    isolated.setPreloads([]);
    isolated.setSpellCheckerEnabled(false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: false });
    isolated.on('will-download', event => event.preventDefault());
    // No filter: this also covers custom schemes and websocket requests.
    // This handler remains installed on retired sessions and denies everything.
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        const routeAllowed = this.#submitted ? isPrivateUnlockRequestAllowed : isPrivateBrowserRequestAllowed;
        allowed = this.current() && routeAllowed(details.url, details.method)
          && !!this.#window && !this.#window.isDestroyed() && details.webContentsId === this.#window.webContents.id
          && details.resourceType !== 'subFrame'
          && (details.resourceType !== 'mainFrame' || details.url === PRIVATE_BROWSER_ENTRY_URL);
      } catch { /* no diagnostic URL is logged */ }
      callback({ cancel: !allowed });
    });
    isolated.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) {
        if (['cookie', 'authorization', 'proxy-authorization', 'referer'].includes(name.toLowerCase())) { delete headers[name]; }
      }
      callback({ requestHeaders: headers, cancel: !this.current() });
    });
    // Additional defense for network APIs outside ordinary resource loads.
    // Offline emulation and WebRTC IP policy are not an OS network sandbox.
    isolated.enableNetworkEmulation({ offline: true });
    // WebRTC can attempt direct TCP even with offline emulation and UDP
    // disabled. A fixed, unusable loopback proxy supplies no DIRECT fallback;
    // disable Chromium's implicit localhost bypass as well. Verify adoption
    // before any renderer exists instead of assuming proxy parsing succeeded.
    await isolated.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:0', proxyBypassRules: '<-loopback>' });
    this.assertCurrent();
    const routes = await Promise.all(['http://127.0.0.1/', 'https://theatrum.invalid/', 'ws://[::1]/', 'wss://theatrum.invalid/']
      .map(url => isolated.resolveProxy(url)));
    if (routes.some(route => route !== 'PROXY 127.0.0.1:0')) { throw unavailable(); }
    this.assertCurrent();
    const handler = this.#hub
      ? createPrivateBrowserProtocolHandler({
        hub: this.#hub, generation: this.#generation!, appDirectory: this.#appDirectory, isCurrent: this.current,
      })
      : createPrivateUnlockProtocolHandler({ appDirectory: this.#appDirectory, isCurrent: this.current });
    // A generic 404 document can otherwise count as a successful navigation.
    // Validate the app entry before creating a renderer or allowing show().
    const entry = await handler(new Request(PRIVATE_BROWSER_ENTRY_URL, { method: 'HEAD' }));
    if (entry.status !== 200 || entry.headers.get('content-type') !== 'text/html; charset=utf-8') { throw unavailable(); }
    this.assertCurrent();
    await isolated.protocol.handle(THEATRUM_APP_PROTOCOL, handler);
    this.assertCurrent();
    const preload = path.resolve(__dirname, this.#submitted ? '../private-password-preload.cjs' : '../private-gallery-preload.cjs');
    const stat = fs.lstatSync(preload);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync.native(preload) !== preload) { throw unavailable(); }
    const window = new BrowserWindow({
      title: this.#submitted ? 'Unlock private hub — Theatrum Ex Machina' : 'Private hub — Theatrum Ex Machina',
      show: false, width: this.#submitted ? 540 : 1200, height: this.#submitted ? 620 : 800,
      minWidth: this.#submitted ? 400 : 600, minHeight: 400,
      webPreferences: {
        session: isolated,
        nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
        contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
        allowRunningInsecureContent: false, navigateOnDragDrop: false,
        spellcheck: false, devTools: false, disableDialogs: true, enableWebSQL: false,
        v8CacheOptions: 'none', safeDialogs: true,
        preload,
      },
    });
    this.#window = window;
    if (!this.current()) { window.destroy(); throw unavailable(); }
    window.setMenu(null);
    const contents = window.webContents;
    contents.setIgnoreMenuShortcuts(true);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('page-title-updated', event => event.preventDefault());
    contents.on('render-process-gone', this.onRevoked);
    contents.on('preload-error', this.onRevoked);
    contents.on('unresponsive', this.onRevoked);
    contents.on('destroyed', this.onRevoked);
    contents.on('context-menu', event => event.preventDefault());
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp') { return; }
      // The guard also covers the password prompt, before there is an idle timer.
      if (!this.current() || (this.#idleLock && !this.#idleLock.activity())) { event.preventDefault(); return; }
      const action = privateNativeInputAction(input);
      if (!action) { return; }
      event.preventDefault();
      try {
        if (action === 'paste' || action === 'select-all') { this.nativeEdit(action); }
        else if (action === 'close') { this.retire(); }
        else if (action === 'quit') { app.quit(); }
      } catch { this.retire(); }
    });
    if (this.#hub) {
      // Only native keyboard/mouse activity renews the hub's idle deadline.
      contents.on('before-mouse-event', (event, mouse) => {
        if (!['mouseDown', 'mouseUp', 'mouseWheel'].includes(mouse.type)) { return; }
        if (!this.#idleLock?.activity()) { event.preventDefault(); }
      });
    }
    window.on('closed', this.onRevoked);
    window.on('close', event => {
      if (!this.#retiring) { event.preventDefault(); this.retire(); }
    });
    if (this.#submitted) {
      this.#disposePasswordRequest = registerPrivatePasswordRequest({
        contents, isCurrent: this.current, onSubmit: this.#submitted, onCancel: () => this.retire(),
        touchIdAvailable: this.#touchIdAvailable, onTouchId: () => this.#submitted!({ method: 'touch-id' }),
      });
    } else {
      this.#disposeGalleryRequest = registerPrivateGalleryRequest({
        contents, hub: this.#hub!, generation: this.#generation!, isCurrent: this.current, onLock: () => this.retire(),
        onProtectionChanged: settings => this.#idleLock?.setMinutes(settings.autoLockMinutes) === true,
        chooseUnprotectedCopyDestination: async () => {
          this.assertCurrent();
          if (window.isDestroyed()) { throw unavailable(); }
          const result = await dialog.showSaveDialog(window, {
            title: 'Create unprotected copy',
            message: 'Choose a new folder for the unencrypted catalogue and previews. Existing folders cannot be replaced.',
            defaultPath: 'Unprotected hub', buttonLabel: 'Create copy',
            properties: ['createDirectory', 'dontAddToRecent'], securityScopedBookmarks: false,
          });
          this.assertCurrent();
          if (window.isDestroyed() || result.canceled) { return undefined; }
          return result.filePath || undefined;
        },
        chooseSourceDirectory: async root => {
          this.assertCurrent();
          if (window.isDestroyed()) { throw unavailable(); }
          const result = await dialog.showOpenDialog(window, {
            title: 'Allow source folder access',
            message: 'Select this video’s saved source folder to regenerate its encrypted previews. This hub uses the selection only until it closes.',
            defaultPath: root, buttonLabel: 'Allow access',
            properties: ['openDirectory', 'noResolveAliases', 'dontAddToRecent'],
            securityScopedBookmarks: false,
          });
          this.assertCurrent();
          if (window.isDestroyed() || result.canceled) { return undefined; }
          return result.filePaths.length === 1 ? result.filePaths[0] : undefined;
        },
      });
    }
    await window.loadURL(PRIVATE_BROWSER_ENTRY_URL);
    this.assertCurrent();
    this.#state = 'open';
  }

  show(): void {
    this.assertCurrent();
    if (this.#state !== 'open' || !this.#window || this.#window.isDestroyed()) { throw unavailable(); }
    this.#window.show();
  }

  close(): Promise<void> { this.retire(); return this.#closed; }

  /** Revoke delivery and destroy decoded renderer state before any await. */
  private retire(): void {
    if (this.#retiring) { return; }
    this.#retiring = true;
    this.#state = 'closed';
    this.#idleLock?.dispose();
    this.#idleLock = undefined;
    this.#signal.removeEventListener('abort', this.onRevoked);
    this.#transitionSignal?.removeEventListener('abort', this.onRevoked);
    powerMonitor.removeListener('suspend', this.onSystemLock);
    powerMonitor.removeListener('lock-screen', this.onSystemLock);
    powerMonitor.removeListener('shutdown', this.onSystemLock);
    let passwordDrain: Promise<void> | undefined;
    try { passwordDrain = this.#disposePasswordRequest?.(); } catch { this.#cleanupFailed = true; }
    this.#disposePasswordRequest = undefined;
    let galleryDrain: Promise<void> | undefined;
    try { galleryDrain = this.#disposeGalleryRequest?.(); } catch { this.#cleanupFailed = true; }
    this.#disposeGalleryRequest = undefined;
    let hubDrain: Promise<void> | undefined;
    try { if (this.#hub?.isCurrent(this.#generation!)) { hubDrain = this.#hub.lock(); } }
    catch { this.#cleanupFailed = true; }
    const window = this.#window;
    if (window && !window.isDestroyed()) {
      try { window.hide(); } catch { this.#cleanupFailed = true; }
      // destroy() bypasses beforeunload and never asks the renderer to cooperate.
      try { window.destroy(); } catch { this.#cleanupFailed = true; }
    }
    const isolated = this.#session;
    const cleanup: (() => Promise<unknown>)[] = [() => hubDrain ?? Promise.resolve(),
      () => this.#hubRevokedDrain ?? Promise.resolve(), () => galleryDrain ?? Promise.resolve(),
      () => passwordDrain ?? Promise.resolve()];
    if (isolated) {
      cleanup.push(() => isolated.closeAllConnections(), () => isolated.clearData(),
        () => isolated.clearCache(), () => isolated.clearCodeCaches({}),
        () => isolated.clearAuthCache(), () => isolated.clearHostResolverCache());
    }
    // Invoke each independently: a synchronous throw or rejected cleanup cannot
    // skip the remaining work. Never reuse even a successfully cleared session.
    void Promise.allSettled(cleanup.map(operation => Promise.resolve().then(operation))).then(results => {
      if (results.some(result => result.status === 'rejected')) { this.#cleanupFailed = true; }
      this.#cleanupComplete = true;
      app.removeListener('before-quit', this.onQuit);
      this.releaseAdmission();
      this.#resolveClosed();
    });
  }

  private releaseAdmission(): void {
    // A native destroy failure must not permit another private hub alongside a
    // renderer that may still hold decrypted content. Retain the global slot
    // until a later destroyed/closed event proves that renderer is gone.
    if (!this.#cleanupComplete || (this.#window && !this.#window.isDestroyed())) { return; }
    this.#window = undefined;
    if (this.#nativeMenu) {
      try {
        if (this.#cleanupFailed) { this.#nativeMenu.quarantine(); }
        else { this.#nativeMenu.release(); }
      } catch { this.#cleanupFailed = true; }
      this.#nativeMenu = undefined;
    }
    if (activeBrowser === this) { activeBrowser = undefined; }
  }
}
