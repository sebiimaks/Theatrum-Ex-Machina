import { app, powerMonitor, type Event } from 'electron';
import { PrivateHubOpenCoordinator, type PrivateHubOpenOptions, type PrivateHubOpenOutcome } from './private-hub-open';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubBrowser, isPrivateBrowserDisposedFailure, type PrivateHubLifecycle } from './private-hub-browser';

import { createPrivateTouchIdProvider } from './private-touch-id';
import { PrivateHubStore } from './private-hub-store';

export interface PrivateHubWorkspaceOptions {
  /** Main-owned packaged private UI assets. Never accepted from ordinary IPC. */
  readonly appDirectory: string;
  /** Native synthetic verification can keep the credential prompt hidden. */
  readonly promptVisible?: boolean;
  /** Main transition owns lock/suspend/shutdown/quit from before directory selection. */
  readonly lifecycle?: PrivateHubLifecycle;
}

/**
 * Compose the real private opening path without handing credentials, catalogue
 * data, paths, or mutable browser/session objects back to the ordinary UI.
 * The caller must first drain normal-mode work and supply its transition lifetime
 * to open(). This factory is deliberately not registered on ordinary IPC.
 */
export function createPrivateHubWorkspace(options: PrivateHubWorkspaceOptions): PrivateHubWorkspace {
  const { appDirectory, lifecycle } = options;
  const promptVisible = options.promptVisible !== false;
  const touchId = createPrivateTouchIdProvider();
  return new PrivateHubWorkspace(new PrivateHubOpenCoordinator({
    createSession: () => new PrivateHubSession({ touchId }),
    touchIdAvailable: (directory, lifetime) => PrivateHubStore.touchIdAvailable(directory, touchId, lifetime.signal),
    requestPassword: lifetime => PrivateHubBrowser.requestPassword({ ...lifetime, visible: promptVisible, lifecycle }),
    createBrowser: ({ hub, generation, signal, isCurrent }) => PrivateHubBrowser.create({
      hub, generation, signal, isAuthorized: isCurrent, appDirectory, lifecycle,
    }),
    isDisposedFailure: isPrivateBrowserDisposedFailure,
  }), { lifecycle });
}

/** Own the system lifecycle unless a main transition supplies the outer lifetime. */
export class PrivateHubWorkspace {
  readonly #coordinator: Pick<PrivateHubOpenCoordinator, 'status' | 'open' | 'cancel' | 'settled'>;
  readonly #observesSystemLifecycle: boolean;
  #observing = false;
  #quitRequested = false;

  constructor(
    coordinator: Pick<PrivateHubOpenCoordinator, 'status' | 'open' | 'cancel' | 'settled'>,
    options: Readonly<{ lifecycle?: PrivateHubLifecycle }> = {},
  ) {
    this.#coordinator = coordinator;
    this.#observesSystemLifecycle = options.lifecycle !== 'external';
  }

  get status(): PrivateHubOpenCoordinator['status'] { return this.#coordinator.status; }

  /** Capture after open(); cleanup failure still requires caller-owned quarantine. */
  get settled(): Promise<void> { return this.#coordinator.settled; }

  open(options: PrivateHubOpenOptions): Promise<PrivateHubOpenOutcome> {
    if (!app.isReady() || this.#quitRequested) { return Promise.resolve('unavailable'); }
    if (this.#observing) { return Promise.resolve('busy'); }
    if (!this.#observesSystemLifecycle && !(options?.signal instanceof AbortSignal)) { return Promise.resolve('unavailable'); }
    // Standalone observers precede even the first prompt adapter. An external
    // transition already owns these events through its supplied abort signal.
    this.#observing = true;
    if (this.#observesSystemLifecycle) {
      powerMonitor.on('suspend', this.onSystemLock);
      powerMonitor.on('lock-screen', this.onSystemLock);
      powerMonitor.on('shutdown', this.onSystemLock);
      app.on('before-quit', this.onQuit);
    }
    const opening = this.#coordinator.open(options);
    void this.#coordinator.settled.then(() => this.stopObserving());
    return opening;
  }

  cancel(): Promise<void> { return this.#coordinator.cancel(); }

  private readonly onSystemLock = (): void => { void this.cancel(); };

  private readonly onQuit = (event: Event): void => {
    event.preventDefault();
    if (this.#quitRequested) { return; }
    this.#quitRequested = true;
    void this.cancel().then(() => {
      this.stopObserving();
      app.quit();
    });
  };

  private stopObserving(): void {
    if (!this.#observing) { return; }
    this.#observing = false;
    powerMonitor.removeListener('suspend', this.onSystemLock);
    powerMonitor.removeListener('lock-screen', this.onSystemLock);
    powerMonitor.removeListener('shutdown', this.onSystemLock);
    app.removeListener('before-quit', this.onQuit);
  }
}
