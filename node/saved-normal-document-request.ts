import { randomUUID } from 'node:crypto';
import type { FinalObject } from '../interfaces/final-object.interface';
import type { SavedNormalDocumentRelease, SavedNormalDocumentSnapshot } from '../interfaces/saved-normal-document';

/** Main-owned identities, never IDs or paths accepted from the renderer. */
export interface SavedNormalDocumentOwner {
  readonly contents: object;
  readonly frame: object;
  /** Includes frame/navigation identity and the captured catalogue session. */
  readonly isCurrent: () => boolean;
  /** Used only to thaw the original page after session invalidation. */
  readonly isFrameCurrent: () => boolean;
}

export interface SavedNormalDocumentProof { readonly saved: true; }

export interface SavedNormalDocumentRequestOptions {
  readonly captureOwner: () => SavedNormalDocumentOwner;
  /** Synchronously prevent normal catalogue transitions/mutations; retain through private disposal. */
  readonly acquireMutationHold: () => (() => void);
  /** Validate the full writable-hub snapshot (null only for no hub/read-only) and await the actual atomic write. */
  readonly saveSnapshot: (owner: SavedNormalDocumentOwner, document: FinalObject | null) => Promise<void>;
  readonly sendRequest: (owner: SavedNormalDocumentOwner, requestId: string) => void;
  /** Send only to owner.frame, never to a replacement main frame. */
  readonly sendRelease: (owner: SavedNormalDocumentOwner, requestId: string, result: SavedNormalDocumentRelease) => void;
  readonly timeoutMs?: number;
}

interface PendingRequest {
  readonly id: string;
  readonly response: Promise<SavedNormalDocumentSnapshot>;
  readonly respond: (response: SavedNormalDocumentSnapshot) => void;
  readonly result: Promise<SavedNormalDocumentProof>;
  readonly resolve: (proof: SavedNormalDocumentProof) => void;
  readonly reject: (error: Error) => void;
  readonly released: Promise<void>;
  readonly releaseDone: () => void;
  readonly releaseFailed: (error: Error) => void;
  owner?: SavedNormalDocumentOwner;
  releaseHold?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
  requested: boolean;
  accepted: boolean;
  cancelled: boolean;
  saved: boolean;
  proof?: SavedNormalDocumentProof;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/**
 * Keeps the renderer frozen from snapshot collection through normal application
 * pause and private workspace disposal. Generic save acknowledgements confer no
 * authority. Cancelling an in-flight write waits for its real completion before
 * allowing edits again; cleanup failure deliberately leaves the boundary closed.
 */
export class SavedNormalDocumentRequest {
  readonly #options: SavedNormalDocumentRequestOptions;
  #active?: PendingRequest;
  #state: 'idle' | 'requesting' | 'saving' | 'saved' | 'releasing' | 'failed' = 'idle';

  constructor(options: SavedNormalDocumentRequestOptions) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error('Invalid normal document request timeout.');
    }
    this.#options = Object.freeze({ ...options, timeoutMs });
  }

  get status(): Readonly<{ state: 'idle' | 'requesting' | 'saving' | 'saved' | 'releasing' | 'failed' }> {
    return Object.freeze({ state: this.#state });
  }

  request(signal?: AbortSignal): Promise<SavedNormalDocumentProof> {
    if (this.#active || this.#state !== 'idle') {
      return Promise.reject(new Error('The normal document is already being prepared.'));
    }
    if (signal?.aborted) { return Promise.reject(new Error('The normal document preparation was cancelled.')); }
    const response = deferred<SavedNormalDocumentSnapshot>();
    const result = deferred<SavedNormalDocumentProof>();
    const released = deferred<void>();
    // Cleanup failure is observed by request/release/cancel callers, even when
    // no explicit cancel waiter exists yet.
    void released.promise.catch(() => undefined);
    const active: PendingRequest = {
      id: randomUUID(), response: response.promise, respond: response.resolve,
      result: result.promise, resolve: result.resolve, reject: result.reject,
      released: released.promise, releaseDone: () => released.resolve(), releaseFailed: released.reject,
      requested: false, accepted: false, cancelled: false, saved: false,
    };
    this.#active = active;
    this.#state = 'requesting';
    if (signal) {
      const abort = (): void => { if (this.#active === active) { void this.cancel().catch(() => undefined); } };
      signal.addEventListener('abort', abort, { once: true });
      active.removeAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) { abort(); }
    }
    void this.#prepare(active);
    return result.promise;
  }

  acceptSnapshot(event: { sender: unknown; senderFrame: unknown }, requestId: unknown, response: unknown): boolean {
    const active = this.#active;
    try {
      if (!active || this.#state !== 'requesting' || !active.requested || active.accepted || active.cancelled ||
          requestId !== active.id || !active.owner || event.sender !== active.owner.contents ||
          event.senderFrame !== active.owner.frame || !active.owner.isFrameCurrent() || !active.owner.isCurrent()) { return false; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) { return false; }
      const snapshot = response as SavedNormalDocumentSnapshot;
      if (snapshot.status !== 'cancelled' && (snapshot.status !== 'snapshot' ||
          (snapshot.document !== null && (typeof snapshot.document !== 'object' || Array.isArray(snapshot.document))))) { return false; }
      const accepted: SavedNormalDocumentSnapshot = snapshot.status === 'cancelled'
        ? { status: 'cancelled' }
        : { status: 'snapshot', document: structuredClone(snapshot.document) };
      if (this.#active !== active || active.cancelled || active.accepted || this.#state !== 'requesting') { return false; }
      active.accepted = true;
      active.respond(accepted);
      return true;
    } catch { return false; }
  }

  assertSaved(proof: SavedNormalDocumentProof): void {
    const active = this.#active;
    try {
      if (!active || this.#state !== 'saved' || !proof || proof !== active.proof || active.cancelled ||
          !active.owner?.isFrameCurrent() || !active.owner.isCurrent()) { throw new Error(); }
      if (this.#active !== active || this.#state !== 'saved' || active.cancelled || proof !== active.proof) { throw new Error(); }
    } catch { throw new Error('The normal document has not been prepared.'); }
  }

  /** Called only after normal work may safely resume. Consumes the proof. */
  release(proof: SavedNormalDocumentProof): Promise<void> {
    this.assertSaved(proof);
    const active = this.#active!;
    this.#finish(active);
    return active.released;
  }

  /**
   * Never races a still-running save. After proof issuance the caller MUST wait
   * for clean private workspace disposal before cancelling this retained lease.
   */
  cancel(): Promise<void> {
    const active = this.#active;
    if (!active) { return Promise.resolve(); }
    active.cancelled = true;
    active.respond({ status: 'cancelled' });
    if (this.#state === 'saved') { this.#finish(active); }
    return active.released;
  }

  async #prepare(active: PendingRequest): Promise<void> {
    try {
      active.releaseHold = this.#options.acquireMutationHold();
      if (typeof active.releaseHold !== 'function' || active.cancelled) { throw new Error(); }
      const owner = this.#options.captureOwner();
      active.owner = Object.freeze({ ...owner });
      if (!this.#ownerCurrent(active)) { throw new Error(); }
      active.timer = setTimeout(() => { void this.cancel().catch(() => undefined); }, this.#options.timeoutMs);
      active.requested = true;
      this.#options.sendRequest(active.owner, active.id);
      const response = await active.response;
      if (response.status !== 'snapshot' || !this.#ownerCurrent(active)) {
        throw new Error();
      }
      this.#state = 'saving';
      await this.#options.saveSnapshot(active.owner, response.document);
      active.saved = true;
      if (!this.#ownerCurrent(active)) { throw new Error(); }
      clearTimeout(active.timer);
      active.timer = undefined;
      // Once issued, this proof belongs to the private transition coordinator.
      // Its later cancellation must drain the private workspace before release.
      active.removeAbort?.();
      active.removeAbort = undefined;
      active.proof = Object.freeze({ saved: true });
      this.#state = 'saved';
      active.resolve(active.proof);
    } catch {
      this.#finish(active);
      active.reject(new Error(this.#state === 'failed'
        ? 'The normal document could not be restored after preparation.'
        : 'The normal document could not be prepared.'));
    }
  }

  #ownerCurrent(active: PendingRequest): boolean {
    return !!active.owner?.isFrameCurrent() && active.owner.isCurrent() &&
      this.#active === active && !active.cancelled;
  }

  #finish(active: PendingRequest): void {
    if (this.#active !== active || this.#state === 'releasing' || this.#state === 'failed') { return; }
    this.#state = 'releasing';
    clearTimeout(active.timer);
    active.removeAbort?.();
    active.removeAbort = undefined;
    active.proof = undefined;
    try {
      if (active.requested && active.owner?.isFrameCurrent()) {
        this.#options.sendRelease(active.owner, active.id, { saved: active.saved && active.owner.isCurrent() });
      }
      active.releaseHold?.();
      this.#active = undefined;
      this.#state = 'idle';
      active.releaseDone();
    } catch {
      this.#state = 'failed';
      active.releaseFailed(new Error('The normal document could not be restored after preparation.'));
    }
  }
}
