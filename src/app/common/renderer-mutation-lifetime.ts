/** A callback authority valid only for one uninterrupted editing lifetime. */
export interface RendererMutationToken {
  readonly rendererMutationToken: unique symbol;
}

/**
 * Coordinates synchronous drafts, outstanding native requests and saved revisions.
 * DOM blocking is a separate concern: callers must also check callback authorities.
 */
export class RendererMutationLifetime {
  private phase: 'editing' | 'flushing' | 'frozen' | 'quarantined' = 'editing';
  private epoch = Object.freeze({}) as RendererMutationToken;
  private currentRevision = 0;
  private readonly pending = new Set<object>();
  private readonly draftFlushers = new Set<{ flush: () => void }>();

  /** Draft flushers may make synchronous edits before the snapshot is sealed. */
  get accepting(): boolean {
    return this.phase === 'editing' || this.phase === 'flushing';
  }

  get revision(): number {
    return this.currentRevision;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  capture(): RendererMutationToken | undefined {
    return this.phase === 'editing' ? this.epoch : undefined;
  }

  isCurrent(token: RendererMutationToken | undefined): boolean {
    return this.phase === 'editing' && token !== undefined && token === this.epoch;
  }

  assertAccepting(): void {
    if (!this.accepting) {
      throw new Error('Catalogue editing is paused.');
    }
  }

  /** A failed restoration cannot be reopened by an older saved release callback. */
  quarantine(): void {
    this.phase = 'quarantined';
    this.epoch = Object.freeze({}) as RendererMutationToken;
  }

  /**
   * Record every persisted mutation, even when a dirty flag was already true.
   * Keep detecting unexpected writes while frozen so an old snapshot cannot mark
   * newer data clean. Mutation entry points must separately call assertAccepting.
   */
  changed(): void {
    if (this.currentRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Catalogue revision limit reached.');
    }
    this.currentRevision += 1;
  }

  registerDraftFlusher(flush: () => void): () => void {
    if (this.phase !== 'editing') {
      throw new Error('Cannot register an editor while catalogue editing is paused.');
    }
    const registration = { flush };
    this.draftFlushers.add(registration);
    return () => { this.draftFlushers.delete(registration); };
  }

  /**
   * Retain until both the request and its renderer state update have settled.
   * A freeze is refused while these exist; durable native results are never
   * invalidated and silently discarded by a competing snapshot request.
   */
  holdPending(): () => void {
    if (this.phase !== 'editing') {
      throw new Error('Cannot start a request while catalogue editing is paused.');
    }
    const pending = {};
    this.pending.add(pending);
    return () => { this.pending.delete(pending); };
  }

  freeze(): () => void {
    if (this.phase !== 'editing') {
      throw new Error('Catalogue editing is already paused.');
    }
    if (this.pending.size !== 0) {
      throw new Error('Catalogue requests are still completing.');
    }

    // An old dialog callback must not become valid after either thaw or a failed
    // flush. Pending durable requests were checked before retiring their epoch.
    this.epoch = Object.freeze({}) as RendererMutationToken;
    this.phase = 'flushing';
    try {
      for (const registration of Array.from(this.draftFlushers)) {
        if (this.draftFlushers.has(registration)) {
          const result: unknown = registration.flush();
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            // This API cannot wait for asynchronous drafts. Observe any rejection
            // but refuse the snapshot rather than claiming its drafts were saved.
            void Promise.resolve(result).catch(() => undefined);
            throw new Error('Editor drafts must finish synchronously.');
          }
        }
        this.assertAccepting();
      }
      this.phase = 'frozen';
    } catch (error) {
      if (this.accepting) { this.phase = 'editing'; }
      throw error;
    }

    let released = false;
    return () => {
      if (released) { return; }
      released = true;
      if (this.phase === 'frozen') { this.phase = 'editing'; }
    };
  }
}
