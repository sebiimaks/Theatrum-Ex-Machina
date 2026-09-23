import * as path from 'node:path';
import { PRIVATE_HUB_MAX_PASSWORD_BYTES } from './private-hub-crypto';
import type { PrivateHubSession } from './private-hub-session';

export type PrivateHubUnlockChoice = string | Readonly<{ method: 'touch-id' }>;

export type PrivateHubOpenOutcome = 'opened' | 'cancelled' | 'unavailable' | 'busy';
export type PrivateHubOpenState = 'idle' | 'opening' | 'open' | 'closing' | 'failed';

/** Main-only lifetime interfaces. No renderer, catalogue, key, or mutable session accessor. */
export interface PrivateHubOpenSession {
  unlock(directory: string, password: string): Promise<{ generation: number }>;
  unlockWithTouchId?(directory: string): Promise<{ generation: number }>;
  isCurrent(generation: number): boolean;
  revocationSignal(generation: number): AbortSignal;
  lock(): Promise<void>;
  close(): Promise<void>;
}

export interface PrivateHubOpenBrowser {
  readonly status: Readonly<{ state: 'opening' | 'open' | 'closed'; cleanupFailed: boolean }>;
  readonly closed: Promise<void>;
  show(): void;
  close(): Promise<void>;
}

export interface PrivateHubOpenLifetime {
  readonly signal: AbortSignal;
  /** Main-owned authority; must guard every async handoff inside the dependency too. */
  readonly isCurrent: () => boolean;
}

/** Main-only, one-use credentials for a prepared destination; never renderer input. */
export interface PrivateHubPreparedOpen {
  readonly directory: string;
  readonly password: string;
}

export interface PrivateHubOpenDependencies<Hub extends PrivateHubOpenSession = PrivateHubSession> {
  readonly createSession: () => Hub;
  /** Settle only after prompt destruction and cleanup. Reject on cleanup failure. */
  readonly requestPassword: (lifetime: PrivateHubOpenLifetime & { touchIdAvailable?: () => Promise<boolean> }) => Promise<PrivateHubUnlockChoice | undefined>;
  /**
   * Replaces the unlock prompt for main-owned conversion. Settle only after all
   * preparation resources drain; cancellation must retain late preparation.
   * The returned destination is activated through the ordinary session unlock.
   */
  readonly prepareHub?: (directory: string, lifetime: PrivateHubOpenLifetime) => Promise<PrivateHubPreparedOpen | undefined>;
  /** Read-only native capability/enrollment query; never a biometric prompt. */
  readonly touchIdAvailable?: (directory: string, lifetime: PrivateHubOpenLifetime) => Promise<boolean>;
  /** Resolve only with a hidden isolated browser; retain and enforce the lifetime. */
  readonly createBrowser: (options: PrivateHubOpenLifetime & { readonly hub: Hub; readonly generation: number }) => Promise<PrivateHubOpenBrowser>;
  /** Main-owned recognition of factory errors whose native resources were proven disposed. */
  readonly isDisposedFailure?: (error: unknown) => boolean;
}

export interface PrivateHubOpenOptions {
  /** Selected by main, never accepted from ordinary renderer IPC. */
  readonly directory: string;
  /** Captures the caller's drained normal-to-private transition authority. */
  readonly isAuthorized: () => boolean;
  /** Caller must abort synchronously when its authority is revoked. */
  readonly signal?: AbortSignal;
}

interface Attempt<Hub extends PrivateHubOpenSession> {
  readonly controller: AbortController;
  readonly authorized: () => boolean;
  readonly externalSignal?: AbortSignal;
  readonly stageDone: Promise<void>;
  readonly resolveStage: () => void;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
  readonly drains: Promise<void>[];
  externalAbort?: () => void;
  sessionSignal?: AbortSignal;
  sessionAbort?: () => void;
  hub?: Hub;
  browser?: PrivateHubOpenBrowser;
  generation?: number;
  invalidated: boolean;
  cancelled: boolean;
  cleanupFailed: boolean;
  hubLockStarted: boolean;
  browserCloseStarted: boolean;
  disposal?: Promise<void>;
}

// Admission includes pending prompts, late unlocks, live windows, and draining
// failures across coordinator instances, not just one UI button's instance.
let admitted: object | undefined;
const alreadySettled = Promise.resolve();

function validPassword(password: unknown): password is string {
  if (typeof password !== 'string' || password.length === 0 || password.length > PRIVATE_HUB_MAX_PASSWORD_BYTES
    || Buffer.byteLength(password, 'utf8') > PRIVATE_HUB_MAX_PASSWORD_BYTES) { return false; }
  for (let index = 0; index < password.length; index++) {
    const code = password.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = password.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) { return false; }
    } else if (code >= 0xdc00 && code <= 0xdfff) { return false; }
  }
  return true;
}

function preparedOpen(value: unknown): PrivateHubPreparedOpen | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 2) { return undefined; }
  // Snapshot data properties only; a mutable result cannot change the selected
  // destination or credentials after this validation and before unlock.
  const directory: unknown = Object.getOwnPropertyDescriptor(value, 'directory')?.value;
  const password: unknown = Object.getOwnPropertyDescriptor(value, 'password')?.value;
  if (typeof directory !== 'string' || directory.length > 4096 || Buffer.byteLength(directory) > 4096
    || !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory.includes('\0')
    || !validPassword(password)) { return undefined; }
  return { directory, password };
}

/**
 * Main-only opening coordinator, deliberately not connected to normal IPC.
 * Directory selection and draining the normal application's callbacks remain
 * caller-owned. Losing that authority requires a synchronous cancel()/abort;
 * a predicate alone cannot notify an already idle, displayed window.
 */
export class PrivateHubOpenCoordinator<Hub extends PrivateHubOpenSession = PrivateHubSession> {
  readonly #dependencies: PrivateHubOpenDependencies<Hub>;
  #attempt?: Attempt<Hub>;
  #state: PrivateHubOpenState = 'idle';
  #cleanupFailed = false;

  constructor(dependencies: PrivateHubOpenDependencies<Hub>) {
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  get status(): Readonly<{ state: PrivateHubOpenState; cleanupFailed: boolean }> {
    return Object.freeze({ state: this.#state, cleanupFailed: this.#cleanupFailed });
  }

  /**
   * Capture immediately after open(). Resolves when that attempt's disposal
   * finishes, including quarantine; inspect status before resuming normal mode.
   * An idle coordinator has an already resolved promise.
   */
  get settled(): Promise<void> { return this.#attempt?.finished ?? alreadySettled; }

  open(options: PrivateHubOpenOptions): Promise<PrivateHubOpenOutcome> {
    if (this.#attempt || admitted) { return Promise.resolve('busy'); }
    let directory: string;
    let authorized: () => boolean;
    let externalSignal: AbortSignal | undefined;
    try {
      ({ directory, isAuthorized: authorized, signal: externalSignal } = options);
      if (typeof directory !== 'string' || directory.length > 4096 || Buffer.byteLength(directory) > 4096
        || !path.isAbsolute(directory) || directory.includes('\0') || typeof authorized !== 'function'
        || (externalSignal !== undefined && !(externalSignal instanceof AbortSignal))) { return Promise.resolve('unavailable'); }
      if (externalSignal?.aborted) { return Promise.resolve('cancelled'); }
    } catch { return Promise.resolve('unavailable'); }
    let resolveStage: () => void;
    const stageDone = new Promise<void>(resolve => { resolveStage = resolve; });
    let resolveFinished: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    const attempt: Attempt<Hub> = {
      controller: new AbortController(), authorized, externalSignal, stageDone, resolveStage: resolveStage!,
      finished, resolveFinished: resolveFinished!, drains: [],
      invalidated: false, cancelled: false, cleanupFailed: false, hubLockStarted: false, browserCloseStarted: false,
    };
    this.#attempt = attempt;
    admitted = attempt;
    this.#state = 'opening';
    attempt.externalAbort = () => { this.invalidate(attempt, true); void this.dispose(attempt); };
    externalSignal?.addEventListener('abort', attempt.externalAbort, { once: true });
    // Invoke only after admission, so even a reentrant native adapter is bounded.
    const opening = this.run(attempt, directory);
    directory = '';
    return opening.then(async result => {
      attempt.resolveStage();
      if (result === 'opened' && this.current(attempt)) { return result; }
      const outcome = attempt.cancelled ? 'cancelled' : 'unavailable';
      await this.dispose(attempt);
      return attempt.cleanupFailed ? 'unavailable' : outcome;
    });
  }

  /** Invalidate the lifetime and lock keys before returning the cleanup promise. */
  cancel(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt) { return Promise.resolve(); }
    this.invalidate(attempt, true);
    return this.dispose(attempt);
  }

  private current(attempt: Attempt<Hub>): boolean {
    let current = this.#attempt === attempt && !attempt.invalidated && !attempt.controller.signal.aborted
      && !attempt.externalSignal?.aborted;
    try {
      if (current) {
        current = attempt.authorized() === true
          && (attempt.generation === undefined || attempt.hub?.isCurrent(attempt.generation) === true)
          && this.#attempt === attempt && !attempt.invalidated && !attempt.controller.signal.aborted
          && !attempt.externalSignal?.aborted;
      }
    } catch { current = false; }
    if (!current && !attempt.invalidated) {
      this.invalidate(attempt, true);
      void this.dispose(attempt);
    }
    return current;
  }

  private async run(attempt: Attempt<Hub>, directory: string): Promise<PrivateHubOpenOutcome> {
    let password: PrivateHubUnlockChoice | undefined;
    let prepared: PrivateHubPreparedOpen | undefined;
    try {
      if (!this.current(attempt)) { return 'cancelled'; }
      const lifetime = Object.freeze({ signal: attempt.controller.signal, isCurrent: () => this.current(attempt) });
      let touchId = false;
      if (this.#dependencies.prepareHub) {
        try { prepared = await this.#dependencies.prepareHub(directory, lifetime); }
        catch (error) { this.factoryFailed(attempt, error); return 'unavailable'; }
        if (!this.current(attempt)) { return 'cancelled'; }
        if (prepared === undefined) { this.invalidate(attempt, true); return 'cancelled'; }
        prepared = preparedOpen(prepared);
        if (!prepared) { return 'unavailable'; }
        directory = prepared.directory;
        password = prepared.password;
      } else {
        try { password = await this.#dependencies.requestPassword(Object.freeze({ ...lifetime,
          touchIdAvailable: this.#dependencies.touchIdAvailable ? async () => {
            if (!this.current(attempt)) { return false; }
            const available = await this.#dependencies.touchIdAvailable(directory, lifetime);
            return this.current(attempt) && available === true;
          } : undefined,
        })); }
        catch (error) { this.factoryFailed(attempt, error); return 'unavailable'; }
        if (!this.current(attempt)) { return 'cancelled'; }
        if (password === undefined) { this.invalidate(attempt, true); return 'cancelled'; }
        touchId = typeof password === 'object' && password !== null && Reflect.ownKeys(password).length === 1
          && Object.getOwnPropertyDescriptor(password, 'method')?.value === 'touch-id';
        if (!touchId && !validPassword(password)) { return 'unavailable'; }
      }
      if (!this.current(attempt)) { return 'cancelled'; }
      attempt.hub = this.#dependencies.createSession();
      if (!this.current(attempt)) { return 'cancelled'; }
      let unlocking: Promise<{ generation: number }> | undefined;
      try {
        if (touchId) {
          if (!this.#dependencies.touchIdAvailable || !attempt.hub.unlockWithTouchId) { return 'unavailable'; }
          unlocking = attempt.hub.unlockWithTouchId(directory);
        } else { unlocking = attempt.hub.unlock(directory, password as string); }
      }
      finally { password = undefined; prepared = undefined; directory = ''; }
      const generation = (await unlocking).generation;
      unlocking = undefined;
      attempt.generation = generation;
      if (!Number.isSafeInteger(generation) || generation < 0 || !this.current(attempt)) { return 'cancelled'; }
      const signal = attempt.hub.revocationSignal(generation);
      if (!(signal instanceof AbortSignal)) { return 'unavailable'; }
      attempt.sessionSignal = signal;
      attempt.sessionAbort = () => { this.invalidate(attempt, true); void this.dispose(attempt); };
      signal.addEventListener('abort', attempt.sessionAbort, { once: true });
      if (signal.aborted || !this.current(attempt)) { return 'cancelled'; }
      try {
        attempt.browser = await this.#dependencies.createBrowser(Object.freeze({ ...lifetime, hub: attempt.hub, generation }));
      } catch (error) { this.factoryFailed(attempt, error); return 'unavailable'; }
      // Adopt even a late window so cancellation cannot strand decrypted state.
      if (!this.current(attempt)) { return 'cancelled'; }
      if (attempt.browser.status.state !== 'open' || attempt.browser.status.cleanupFailed) { return 'unavailable'; }
      void attempt.browser.closed.then(() => {
        this.invalidate(attempt, true);
        void this.dispose(attempt);
      }, () => {
        attempt.cleanupFailed = true;
        this.invalidate(attempt, true);
        void this.dispose(attempt);
      });
      if (!this.current(attempt)) { return 'cancelled'; }
      attempt.browser.show();
      if (!this.current(attempt)) { return 'cancelled'; }
      this.#state = 'open';
      return 'opened';
    } catch { return attempt.cancelled ? 'cancelled' : 'unavailable'; }
    finally { password = undefined; prepared = undefined; directory = ''; }
  }

  private factoryFailed(attempt: Attempt<Hub>, error: unknown): void {
    let disposed = false;
    try { disposed = this.#dependencies.isDisposedFailure?.(error) === true; }
    catch { /* Unproven cleanup is never an admission reset. */ }
    if (!disposed) { attempt.cleanupFailed = true; }
  }

  private collect(attempt: Attempt<Hub>, operation: () => Promise<void>): void {
    try {
      attempt.drains.push(Promise.resolve(operation()).catch(() => { attempt.cleanupFailed = true; }));
    } catch { attempt.cleanupFailed = true; }
  }

  private closeOwned(attempt: Attempt<Hub>): void {
    if (attempt.hub && !attempt.hubLockStarted) {
      attempt.hubLockStarted = true;
      this.collect(attempt, () => attempt.hub!.lock());
    }
    if (attempt.browser && !attempt.browserCloseStarted) {
      attempt.browserCloseStarted = true;
      this.collect(attempt, () => attempt.browser!.close());
    }
  }

  private invalidate(attempt: Attempt<Hub>, cancelled: boolean): void {
    attempt.cancelled ||= cancelled;
    if (!attempt.invalidated) {
      attempt.invalidated = true;
      if (this.#attempt === attempt) { this.#state = 'closing'; }
      // Mark invalid first: synchronous abort observers may reenter cancel().
      attempt.controller.abort();
    }
    this.closeOwned(attempt);
  }

  private dispose(attempt: Attempt<Hub>): Promise<void> {
    if (attempt.disposal) { return attempt.disposal; }
    // Install the shared promise before calling adapters that may reenter.
    attempt.disposal = attempt.finished;
    this.invalidate(attempt, false);
    void (async () => {
      await attempt.stageDone;
      this.closeOwned(attempt);
      await Promise.all(attempt.drains);
      // close() is deliberately last: no late unlock or browser may reactivate
      // an idle session or race a storage drain after admission is released.
      if (attempt.hub) {
        try { await attempt.hub.close(); } catch { attempt.cleanupFailed = true; }
      }
      if (attempt.browser) {
        try {
          await attempt.browser.closed;
          if (attempt.browser.status.state !== 'closed' || attempt.browser.status.cleanupFailed) { attempt.cleanupFailed = true; }
        } catch { attempt.cleanupFailed = true; }
      }
      attempt.externalSignal?.removeEventListener('abort', attempt.externalAbort!);
      attempt.sessionSignal?.removeEventListener('abort', attempt.sessionAbort!);
      if (this.#attempt === attempt) {
        this.#cleanupFailed = attempt.cleanupFailed;
        this.#state = attempt.cleanupFailed ? 'failed' : 'idle';
        // Failed cleanup remains quarantined; never silently resume normal
        // mode or admit another private hub over potentially live state.
        if (!attempt.cleanupFailed) {
          this.#attempt = undefined;
          if (admitted === attempt) { admitted = undefined; }
        }
      }
      attempt.resolveFinished();
    })();
    return attempt.disposal;
  }
}
