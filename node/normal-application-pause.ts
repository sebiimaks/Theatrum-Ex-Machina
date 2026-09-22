import { NormalOperationScope, type NormalOperationDrain } from './normal-operation-scope';

export interface NormalApplicationPauseProof { readonly paused: true; }

export interface NormalApplicationPauseOptions {
  readonly operations: NormalOperationScope;
  /** Main-owned save/transition state; never supplied by the renderer. */
  readonly canPause: () => boolean;
  readonly pauseSources: () => Promise<void>;
  readonly drainMedia: () => Promise<void>;
  readonly resumeSources: () => void;
  readonly resumeMedia: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
}

/**
 * One admission boundary for the normal window's IPC, native dialogs, source
 * monitor and media work. This does not save renderer edits or grant authority
 * to open a private hub; the caller must complete that workflow first.
 */
export class NormalApplicationPause {
  readonly #options: NormalApplicationPauseOptions;
  #state: 'normal' | 'pausing' | 'paused' | 'resuming' | 'failed' = 'normal';
  #checking = false;
  #pausing?: Promise<NormalApplicationPauseProof>;
  #proof?: NormalApplicationPauseProof;
  #operationProof?: NormalOperationDrain;

  constructor(options: NormalApplicationPauseOptions) { this.#options = Object.freeze({ ...options }); }

  get status(): Readonly<{ state: 'normal' | 'pausing' | 'paused' | 'resuming' | 'failed' }> {
    return Object.freeze({ state: this.#state });
  }

  pause(): Promise<NormalApplicationPauseProof> {
    if (this.#checking || this.#state === 'resuming' || this.#options.operations.inOperation) {
      return Promise.reject(new Error('The normal application cannot be paused.'));
    }
    if (this.#pausing) { return this.#pausing; }
    const options = this.#options;
    this.#checking = true;
    try {
      if (this.#state !== 'normal' || options.operations.inOperation || !options.operations.accepting || options.canPause() !== true) {
        throw new Error();
      }
      options.operations.assertCurrent();
    } catch { return Promise.reject(new Error('The normal application cannot be paused.')); }
    finally { this.#checking = false; }
    this.#state = 'pausing';
    let resolve: (proof: NormalApplicationPauseProof) => void;
    let reject: (error: Error) => void;
    this.#pausing = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Install the shared promise before any abort observer or adapter can
    // reenter. Invoke every drain even if a sibling fails synchronously.
    const pending: Promise<unknown>[] = [];
    const invoke = (operation: () => unknown): void => {
      try { pending.push(Promise.resolve(operation())); }
      catch (error) { pending.push(Promise.reject(error)); }
    };
    invoke(() => options.operations.seal().then(proof => { this.#operationProof = proof; }));
    invoke(options.onPause);
    invoke(options.pauseSources);
    invoke(options.drainMedia);
    void Promise.allSettled(pending).then(results => {
      try {
        if (results.some(result => result.status === 'rejected') || !this.#operationProof) { throw new Error(); }
        options.operations.assertDrained(this.#operationProof);
        this.#proof = Object.freeze({ paused: true });
        this.#state = 'paused';
        resolve!(this.#proof);
      } catch {
        this.#state = 'failed';
        reject!(new Error('The normal application could not finish pausing.'));
      }
    });
    return this.#pausing;
  }

  assertPaused(proof: NormalApplicationPauseProof): void {
    if (this.#state !== 'paused' || !proof || proof !== this.#proof || !this.#operationProof) {
      throw new Error('The normal application is not paused.');
    }
    this.#options.operations.assertDrained(this.#operationProof);
  }

  /** Call only after the private workspace has completely settled without cleanup failure. */
  resume(proof: NormalApplicationPauseProof, afterAdmission?: () => void): void {
    this.assertPaused(proof);
    const options = this.#options;
    this.#state = 'resuming';
    this.#pausing = undefined;
    try {
      options.resumeMedia();
      options.resumeSources();
      options.onResume();
      options.operations.resume(this.#operationProof!);
      this.#proof = undefined;
      this.#operationProof = undefined;
      this.#state = 'normal';
      // Critical renderer handback must happen after ordinary IPC admission.
      // A failed notification re-seals all subsystems through the same failure
      // path as a failed source/media restore.
      afterAdmission?.();
    } catch {
      // A partially resumed subsystem cannot make normal IPC available. Freeze
      // every subsystem again; failed restoration requires application restart.
      this.#state = 'failed';
      this.#proof = undefined;
      const stop = [() => options.operations.seal(), options.pauseSources, options.drainMedia];
      for (const operation of stop) {
        try { void Promise.resolve(operation()).catch(() => undefined); } catch { /* Remain failed and sealed. */ }
      }
      throw new Error('The normal application could not resume.');
    }
  }
}
