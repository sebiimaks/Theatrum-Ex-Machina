import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, dialog, ipcMain, powerMonitor, type BrowserWindow, type Event, type IpcMainEvent, type WebContents,
  type WebFrameMain } from 'electron';
import { SAVED_NORMAL_DOCUMENT_CHANNELS } from '../interfaces/saved-normal-document';
import { GLOBALS, type VhaGlobals } from './main-globals';
import { captureNormalDocumentSnapshot, type NormalDocumentSnapshot } from './normal-document-snapshot';
import { type NormalApplicationPause } from './normal-application-pause';
import { normalOperationScope, type NormalOperationScope } from './normal-operation-scope';
import { PrivateApplicationTransition } from './private-application-transition';
import { createPrivateHubWorkspace } from './private-hub-workspace';
import { createPrivateConversionWorkspace } from './private-conversion-workspace';
import { SavedNormalDocumentRequest, type SavedNormalDocumentOwner, type SavedNormalDocumentProof } from './saved-normal-document-request';
import type { PrivateHubOpenOutcome } from './private-hub-open';

export interface PrivateApplicationWorkspaceOptions {
  readonly appDirectory: string;
  readonly normal: NormalApplicationPause;
  readonly getNormalWindow: () => BrowserWindow | null | undefined;
  /** Require ready renderer freeze/revision/draft integration and the host's normal-close guard. */
  readonly canStart: () => boolean;
  readonly isAllowedRendererUrl: (url: string) => boolean;
  readonly afterResume?: () => void | Promise<void>;
  /** Main-owned application state; injectable for bounded native integration tests. */
  readonly state?: VhaGlobals;
  readonly operations?: NormalOperationScope;
}

interface Owner extends SavedNormalDocumentOwner {
  readonly window: BrowserWindow;
  readonly contents: WebContents;
  readonly frame: WebFrameMain;
  readonly wasVisible: boolean;
  readonly cataloguePath?: string;
}

/** Construction is allocation-free. No listeners, picker or private session exist until open(). */
export function createPrivateApplicationWorkspace(options: PrivateApplicationWorkspaceOptions): PrivateApplicationWorkspace {
  return new PrivateApplicationWorkspace(options);
}

/**
 * Main-only native composition; deliberately absent from normal IPC and preload.
 * Before enabling it, the host's normal close/settings handshake must consult
 * isActive before sending a shutdown request. The renderer must also implement
 * the saved-document mutation freeze; this factory alone does not provide it.
 */
export class PrivateApplicationWorkspace {
  readonly #options: PrivateApplicationWorkspaceOptions;
  readonly #state: VhaGlobals;
  readonly #operations: NormalOperationScope;
  readonly #transition: PrivateApplicationTransition<Owner, SavedNormalDocumentProof>;
  readonly #observers: (() => void)[] = [];
  #document?: SavedNormalDocumentRequest;
  #snapshot?: NormalDocumentSnapshot;
  #snapshotListener?: (event: IpcMainEvent, ...args: unknown[]) => void;
  #active = false;
  #operation: 'open' | 'convert' = 'open';
  #releaseRenderer?: () => void;

  constructor(options: PrivateApplicationWorkspaceOptions) {
    this.#options = Object.freeze({ ...options });
    this.#state = options.state ?? GLOBALS;
    this.#operations = options.operations ?? normalOperationScope;
    const normal = this.#options.normal;
    this.#transition = new PrivateApplicationTransition({
      captureNormal: () => this.captureNormal(),
      normal,
      selectDirectory: async (owner, lifetime) => {
        // Conversion captures the already-open catalogue in main. Inventory
        // review and native destination selection occur only after save/freeze.
        if (this.#operation === 'convert') { return owner.cataloguePath; }
        // The app does not retain this path in history. Native dialogs/the OS
        // may still remember the location; dontAddToRecent is platform-specific.
        const result = await dialog.showOpenDialog(owner.window, {
          title: 'Open private hub', buttonLabel: 'Open private hub', properties: ['openDirectory', 'dontAddToRecent'],
        });
        if (lifetime.signal.aborted || !lifetime.isCurrent() || result.canceled || result.filePaths.length !== 1) { return undefined; }
        return result.filePaths[0];
      },
      document: {
        prepare: (owner, pause, lifetime) => {
          normal.assertPaused(pause);
          const snapshot = captureNormalDocumentSnapshot({
            state: this.#state, assertPaused: () => normal.assertPaused(pause), isCurrent: owner.isCurrent,
          });
          this.#snapshot = snapshot;
          const document = new SavedNormalDocumentRequest({
            captureOwner: () => owner,
            acquireMutationHold: () => {
              normal.assertPaused(pause);
              return () => normal.assertPaused(pause);
            },
            saveSnapshot: (_owner, value) => snapshot.saveSnapshot(value),
            sendRequest: (_owner, requestId) => {
              snapshot.assertCurrent();
              if (!owner.isFrameCurrent()) { throw new Error('The normal window is unavailable.'); }
              owner.frame.send(SAVED_NORMAL_DOCUMENT_CHANNELS.request, requestId);
            },
            sendRelease: (_owner, requestId, result) => {
              if (!owner.isFrameCurrent()) { throw new Error('The normal window is unavailable.'); }
              // document.cancel() precedes window restoration and main resume.
              // Releasing here would allow queued renderer callbacks to send
              // requests while ordinary main admission is still sealed.
              this.#releaseRenderer = () => {
                if (!owner.isCurrent()) { throw new Error('The normal window is unavailable.'); }
                owner.frame.send(SAVED_NORMAL_DOCUMENT_CHANNELS.release, requestId, result);
              };
            },
          });
          this.#document = document;
          this.#snapshotListener = (event, ...args) => {
            if (args.length === 2) { document.acceptSnapshot(event, args[0], args[1]); }
          };
          ipcMain.on(SAVED_NORMAL_DOCUMENT_CHANNELS.snapshot, this.#snapshotListener);
          return document.request(lifetime.signal);
        },
        assertSaved: proof => {
          if (!this.#document || !this.#snapshot) { throw new Error('The normal document is unavailable.'); }
          this.#snapshot.assertCurrent();
          this.#document.assertSaved(proof);
        },
        cancel: async () => {
          await this.#document?.cancel();
          if (this.#snapshotListener) { ipcMain.removeListener(SAVED_NORMAL_DOCUMENT_CHANNELS.snapshot, this.#snapshotListener); }
          this.#snapshotListener = undefined;
          this.#document = undefined;
          this.#snapshot = undefined;
        },
      },
      createWorkspace: () => (this.#operation === 'convert' ? createPrivateConversionWorkspace : createPrivateHubWorkspace)({
        appDirectory: this.#options.appDirectory, lifecycle: 'external',
      }),
      hideNormal: owner => owner.window.hide(),
      restoreNormal: owner => { if (owner.wasVisible) { owner.window.show(); } },
      releaseRenderer: () => {
        const release = this.#releaseRenderer;
        this.#releaseRenderer = undefined;
        release?.();
      },
      afterResume: () => { void this.#operations.run(() => this.#options.afterResume?.()).catch(() => undefined); },
      quit: () => { this.stopObserving(); app.quit(); },
    });
  }

  get status(): PrivateApplicationTransition<Owner, SavedNormalDocumentProof>['status'] { return this.#transition.status; }
  get settled(): Promise<void> { return this.#transition.settled; }
  get isActive(): boolean { return this.#active; }

  open(): Promise<PrivateHubOpenOutcome> { return this.start('open'); }

  /** Native-only action on the current ordinary catalogue; never accepts renderer paths. */
  convert(): Promise<PrivateHubOpenOutcome> { return this.start('convert'); }

  private start(operation: 'open' | 'convert'): Promise<PrivateHubOpenOutcome> {
    if (this.#active) { return Promise.resolve(this.status.cleanupFailed ? 'unavailable' : 'busy'); }
    if (!app.isReady() || this.#operations.inOperation || !this.#operations.isCurrent() || this.status.quitRequested) {
      return Promise.resolve('unavailable');
    }
    this.#operation = operation;
    this.#active = true;
    this.observeSystem();
    const opening = this.#transition.open();
    const settled = this.#transition.settled;
    void settled.then(() => { if (!this.status.cleanupFailed) { this.stopObserving(); } });
    return opening;
  }

  cancel(): Promise<void> { return this.#transition.cancel(); }
  requestQuit(): Promise<void> { return this.#transition.requestQuit(); }
  /** Host calls only after a proven Keep Working choice or normal close-save failure. */
  acknowledgeQuitCancelled(): boolean { return this.#transition.acknowledgeQuitCancelled(); }

  private captureNormal(): Owner | undefined {
    if (!this.#options.canStart()) { return undefined; }
    const window = this.#options.getNormalWindow();
    if (!window || window.isDestroyed()) { return undefined; }
    const contents = window.webContents;
    if (contents.isDestroyed()) { return undefined; }
    const frame = contents.mainFrame;
    const url = contents.getURL();
    if (!frame || frame.isDestroyed() || frame.detached || frame.parent !== null || frame.url !== url ||
      !this.#options.isAllowedRendererUrl(url) || this.#state.catalogueStorage.kind !== 'normal') { return undefined; }
    const storage = this.#state.catalogueStorage;
    const catalogue = this.#state.currentlyOpenVhaFile;
    const generation = this.#state.catalogueSessionGeneration;
    let cataloguePath: string | undefined;
    if (this.#operation === 'convert') {
      try {
        // Do not resolve or probe any renderer-provided source. Only the current
        // main-owned, explicitly authorized writable catalogue may be converted.
        if (this.#state.catalogueAccessMode !== 'read-write' || !catalogue || !path.isAbsolute(catalogue)
          || !this.#state.authorizedCataloguePaths.has(catalogue)) { return undefined; }
        const stats = fs.lstatSync(catalogue);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || fs.realpathSync.native(catalogue) !== catalogue) { return undefined; }
        cataloguePath = catalogue;
      } catch { return undefined; }
    }
    let navigationChanged = false;
    const isFrameCurrent = (): boolean => {
      try {
        return !navigationChanged && this.#options.getNormalWindow() === window && !window.isDestroyed() &&
          !contents.isDestroyed() && contents.mainFrame === frame && !frame.isDestroyed() && !frame.detached &&
          frame.parent === null && frame.url === url && contents.getURL() === url;
      } catch { return false; }
    };
    const invalidate = (): void => { navigationChanged = true; void this.cancel().catch(() => undefined); };
    const navigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (details.isMainFrame !== false) { invalidate(); }
    };
    const close = (event: Event): void => { event.preventDefault(); void this.requestQuit().catch(() => undefined); };
    contents.on('did-start-navigation', navigate);
    contents.on('render-process-gone', invalidate);
    contents.on('unresponsive', invalidate);
    contents.on('destroyed', invalidate);
    window.on('closed', invalidate);
    window.on('close', close);
    this.#observers.push(() => {
      contents.removeListener('did-start-navigation', navigate);
      contents.removeListener('render-process-gone', invalidate);
      contents.removeListener('unresponsive', invalidate);
      contents.removeListener('destroyed', invalidate);
      window.removeListener('closed', invalidate);
      window.removeListener('close', close);
    });
    return Object.freeze({ window, contents, frame, cataloguePath, wasVisible: window.isVisible(), isFrameCurrent,
      isCurrent: () => isFrameCurrent() && this.#state.catalogueStorage === storage &&
        this.#state.currentlyOpenVhaFile === catalogue && this.#state.catalogueSessionGeneration === generation,
    });
  }

  private observeSystem(): void {
    const cancel = (): void => { void this.cancel().catch(() => undefined); };
    const quit = (event: Event): void => { event.preventDefault(); void this.requestQuit().catch(() => undefined); };
    const shutdown = (event?: Event): void => { event?.preventDefault(); void this.requestQuit().catch(() => undefined); };
    powerMonitor.on('suspend', cancel);
    powerMonitor.on('lock-screen', cancel);
    powerMonitor.on('shutdown', shutdown);
    app.on('before-quit', quit);
    this.#observers.push(() => {
      powerMonitor.removeListener('suspend', cancel);
      powerMonitor.removeListener('lock-screen', cancel);
      powerMonitor.removeListener('shutdown', shutdown);
      app.removeListener('before-quit', quit);
    });
  }

  private stopObserving(): void {
    for (const remove of this.#observers.splice(0)) { remove(); }
    this.#active = false;
  }
}
