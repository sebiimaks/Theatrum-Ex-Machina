import * as path from 'node:path';
import type { NormalApplicationPause, NormalApplicationPauseProof } from './normal-application-pause';
import type { PrivateHubOpenOptions, PrivateHubOpenOutcome } from './private-hub-open';

export interface NormalTransitionOwner {
  /** Captured main window/frame, catalogue path, storage identity and generation. */
  isCurrent(): boolean;
}

export interface ApplicationTransitionLifetime {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export interface TransitionPrivateWorkspace {
  readonly status: Readonly<{ state: string; cleanupFailed: boolean }>;
  readonly settled: Promise<void>;
  open(options: PrivateHubOpenOptions): Promise<PrivateHubOpenOutcome>;
  cancel(): Promise<void>;
}

export interface PrivateApplicationTransitionDependencies<Owner extends NormalTransitionOwner, Saved extends object> {
  readonly captureNormal: () => Owner | undefined;
  /** A native picker; never a renderer-provided directory or a recent-history write. */
  readonly selectDirectory: (owner: Owner, lifetime: ApplicationTransitionLifetime) => Promise<string | undefined>;
  readonly normal: Pick<NormalApplicationPause, 'pause' | 'assertPaused' | 'resume' | 'status'>;
  readonly document: {
    /** Called after normal callbacks drain; freeze the renderer before collecting its snapshot. */
    prepare(owner: Owner, pause: NormalApplicationPauseProof, lifetime: ApplicationTransitionLifetime): Promise<Saved>;
    assertSaved(proof: Saved): void;
    /** Retain any pending save until settled, then prepare its release. Idempotent. */
    cancel(): Promise<void>;
  };
  /** Synchronous allocation-free factory; native resources begin in open(). Use external lifecycle ownership. */
  readonly createWorkspace: () => TransitionPrivateWorkspace;
  readonly hideNormal: (owner: Owner) => void;
  /** Restore the window while still paused; a failure must not reopen normal admission. */
  readonly restoreNormal: (owner: Owner) => void;
  /** Deliver a prepared renderer release after main admission; failure re-seals normal work. */
  readonly releaseRenderer?: (owner: Owner) => void;
  /** Best-effort main dispatch/monitoring after resume; must handle its own asynchronous failures. */
  readonly afterResume?: (owner: Owner) => void;
  /** Retry the existing normal settings/catalogue close handshake, only after clean restoration. */
  readonly quit: () => void;
}

type TransitionState = 'idle' | 'selecting' | 'pausing' | 'saving' | 'opening' | 'open' | 'restoring' | 'failed';
interface Attempt<Owner, Saved> {
  readonly controller: AbortController;
  readonly stageDone: Promise<void>;
  readonly resolveStage: () => void;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
  owner?: Owner;
  pause?: NormalApplicationPauseProof;
  saved?: Saved;
  workspace?: TransitionPrivateWorkspace;
  workspaceSettled?: Promise<void>;
  documentStarted: boolean;
  invalidated: boolean;
  cancelled: boolean;
  cleanupFailed: boolean;
  disposal?: Promise<void>;
  privateDrain?: Promise<void>;
}

/**
 * One main-owned transition instance. Entry and restoration must run outside
 * normal IPC's async scope. The host owns sleep/lock/quit/window observers from
 * before open() until settled; no private picker path enters the normal renderer.
 */
export class PrivateApplicationTransition<Owner extends NormalTransitionOwner, Saved extends object> {
  readonly #dependencies: PrivateApplicationTransitionDependencies<Owner, Saved>;
  #attempt?: Attempt<Owner, Saved>;
  #state: TransitionState = 'idle';
  #cleanupFailed = false;
  #quitRequested = false;
  #quitRetried = false;

  constructor(dependencies: PrivateApplicationTransitionDependencies<Owner, Saved>) {
    this.#dependencies = Object.freeze({ ...dependencies, document: Object.freeze({ ...dependencies.document }) });
  }

  get status(): Readonly<{ state: TransitionState; cleanupFailed: boolean; quitRequested: boolean }> {
    return Object.freeze({ state: this.#state, cleanupFailed: this.#cleanupFailed, quitRequested: this.#quitRequested });
  }
  get settled(): Promise<void> { return this.#attempt?.finished ?? Promise.resolve(); }

  open(): Promise<PrivateHubOpenOutcome> {
    if (this.#quitRequested || this.#cleanupFailed) { return Promise.resolve('unavailable'); }
    if (this.#attempt) { return Promise.resolve('busy'); }
    let resolveStage!: () => void;
    let resolveFinished!: () => void;
    const attempt: Attempt<Owner, Saved> = {
      controller: new AbortController(), stageDone: new Promise(resolve => { resolveStage = resolve; }),
      resolveStage: () => resolveStage(), finished: new Promise(resolve => { resolveFinished = resolve; }),
      resolveFinished: () => resolveFinished(), documentStarted: false,
      invalidated: false, cancelled: false, cleanupFailed: false,
    };
    this.#attempt = attempt;
    this.#state = 'selecting';
    // Reserve before invoking any main adapter, including owner capture.
    return this.run(attempt).then(async outcome => {
      attempt.resolveStage();
      if (outcome === 'opened' && this.current(attempt)) { return outcome; }
      await this.dispose(attempt);
      return attempt.cleanupFailed ? 'unavailable' : attempt.cancelled ? 'cancelled' : 'unavailable';
    });
  }

  cancel(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt) { return Promise.resolve(); }
    this.invalidate(attempt, true);
    return this.dispose(attempt);
  }

  /** Caller prevents native quit until this clean handback retries it once. */
  requestQuit(): Promise<void> {
    this.#quitRequested = true;
    const draining = this.cancel();
    return draining.then(() => {
      if (this.#quitRequested && !this.#cleanupFailed && !this.#attempt && !this.#quitRetried) {
        this.#quitRetried = true;
        this.#dependencies.quit();
      }
    });
  }

  /** Host-only acknowledgement of Keep Working/save failure, never app.quit() merely returning. */
  acknowledgeQuitCancelled(): boolean {
    if (!this.#quitRequested || !this.#quitRetried || this.#attempt || this.#cleanupFailed
      || this.#state !== 'idle' || this.#dependencies.normal.status.state !== 'normal') { return false; }
    this.#quitRequested = false;
    this.#quitRetried = false;
    return true;
  }

  private current(attempt: Attempt<Owner, Saved>): boolean {
    if (this.#attempt !== attempt || attempt.invalidated || attempt.controller.signal.aborted) { return false; }
    try {
      if (attempt.owner && attempt.owner.isCurrent() !== true) { this.invalidate(attempt, true); return false; }
      return this.#attempt === attempt && !attempt.invalidated && !attempt.controller.signal.aborted;
    } catch { this.invalidate(attempt, true); return false; }
  }

  private async run(attempt: Attempt<Owner, Saved>): Promise<PrivateHubOpenOutcome> {
    let directory: string | undefined;
    try {
      attempt.owner = this.#dependencies.captureNormal();
      if (!attempt.owner || !this.current(attempt)) { return 'unavailable'; }
      const lifetime = Object.freeze({ signal: attempt.controller.signal, isCurrent: () => this.current(attempt) });
      directory = await this.#dependencies.selectDirectory(attempt.owner, lifetime);
      if (!this.current(attempt)) { return 'cancelled'; }
      if (directory === undefined) { this.invalidate(attempt, true); return 'cancelled'; }
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')
        || Buffer.byteLength(directory, 'utf8') > 4096) { return 'unavailable'; }
      this.#state = 'pausing';
      attempt.pause = await this.#dependencies.normal.pause();
      if (!this.current(attempt)) { return 'cancelled'; }
      this.#dependencies.normal.assertPaused(attempt.pause);
      this.#state = 'saving';
      attempt.documentStarted = true;
      attempt.saved = await this.#dependencies.document.prepare(attempt.owner, attempt.pause, lifetime);
      if (!this.current(attempt)) { return 'cancelled'; }
      this.#dependencies.normal.assertPaused(attempt.pause);
      this.#dependencies.document.assertSaved(attempt.saved);
      if (!this.current(attempt)) { return 'cancelled'; }
      this.#dependencies.hideNormal(attempt.owner);
      if (!this.current(attempt)) { return 'cancelled'; }
      attempt.workspace = this.#dependencies.createWorkspace();
      if (!this.current(attempt)) { return 'cancelled'; }
      this.#state = 'opening';
      const opening = attempt.workspace.open({
        directory, signal: attempt.controller.signal,
        isAuthorized: () => {
          if (!this.current(attempt)) { return false; }
          try {
            this.#dependencies.normal.assertPaused(attempt.pause!);
            this.#dependencies.document.assertSaved(attempt.saved!);
            return this.current(attempt);
          } catch { this.invalidate(attempt, true); return false; }
        },
      });
      directory = undefined;
      attempt.workspaceSettled = attempt.workspace.settled;
      void attempt.workspaceSettled.then(() => {
        this.invalidate(attempt, false);
        void this.dispose(attempt);
      }, () => {
        attempt.cleanupFailed = true;
        this.invalidate(attempt, false);
        void this.dispose(attempt);
      });
      const outcome = await opening;
      if (outcome !== 'opened' || !this.current(attempt)) {
        if (outcome === 'cancelled') { attempt.cancelled = true; }
        return outcome;
      }
      if (attempt.workspace.status.state !== 'open' || attempt.workspace.status.cleanupFailed) { return 'unavailable'; }
      this.#state = 'open';
      return 'opened';
    } catch { return 'unavailable'; }
    finally { directory = undefined; }
  }

  private stopPrivate(attempt: Attempt<Owner, Saved>): void {
    if (!attempt.workspace || attempt.privateDrain) { return; }
    // Reserve before cancellation can synchronously reenter this coordinator.
    let resolve!: () => void;
    attempt.privateDrain = new Promise<void>(yes => { resolve = yes; });
    try {
      void Promise.resolve(attempt.workspace.cancel()).catch(() => { attempt.cleanupFailed = true; }).finally(resolve);
    } catch { attempt.cleanupFailed = true; resolve(); }
  }

  private invalidate(attempt: Attempt<Owner, Saved>, cancelled: boolean): void {
    attempt.cancelled ||= cancelled;
    if (!attempt.invalidated) {
      attempt.invalidated = true;
      attempt.controller.abort();
    }
    this.stopPrivate(attempt);
  }

  private dispose(attempt: Attempt<Owner, Saved>): Promise<void> {
    if (attempt.disposal) { return attempt.disposal; }
    attempt.disposal = attempt.finished;
    this.invalidate(attempt, false);
    void (async () => {
      await attempt.stageDone;
      this.stopPrivate(attempt);
      if (attempt.privateDrain) { await attempt.privateDrain; }
      if (attempt.workspace) {
        try {
          await (attempt.workspaceSettled ?? attempt.workspace.settled);
          if (attempt.workspace.status.state !== 'idle' || attempt.workspace.status.cleanupFailed) { attempt.cleanupFailed = true; }
        } catch { attempt.cleanupFailed = true; }
      }
      // A prepared normal renderer must remain frozen if private disposal is
      // unproven, even though its ordinary IPC scope is still sealed.
      if (attempt.documentStarted && !attempt.cleanupFailed) {
        try { await this.#dependencies.document.cancel(); } catch { attempt.cleanupFailed = true; }
      }
      if (this.#dependencies.normal.status.state === 'failed') { attempt.cleanupFailed = true; }
      if (!attempt.cleanupFailed && attempt.pause && attempt.owner) {
        this.#state = 'restoring';
        try {
          if (attempt.owner.isCurrent() !== true) { throw new Error(); }
          this.#dependencies.normal.assertPaused(attempt.pause);
          this.#dependencies.restoreNormal(attempt.owner);
          if (attempt.owner.isCurrent() !== true) { throw new Error(); }
          this.#dependencies.normal.assertPaused(attempt.pause);
          this.#dependencies.normal.resume(attempt.pause, () => this.#dependencies.releaseRenderer?.(attempt.owner!));
          try { this.#dependencies.afterResume?.(attempt.owner); }
          catch { /* The restored normal window can retry ordinary refresh on focus. */ }
        } catch { attempt.cleanupFailed = true; }
      }
      if (attempt.cleanupFailed) {
        this.#cleanupFailed = true;
        this.#state = 'failed';
      } else {
        this.#attempt = undefined;
        this.#state = 'idle';
      }
      attempt.resolveFinished();
    })().catch(() => {
      attempt.cleanupFailed = true;
      this.#cleanupFailed = true;
      this.#state = 'failed';
      attempt.resolveFinished();
    });
    return attempt.disposal;
  }
}
