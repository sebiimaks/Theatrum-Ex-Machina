import type { FinalObject } from '../../../interfaces/final-object.interface';
import { isSavedNormalDocumentRequestId } from '../../../interfaces/saved-normal-document';
import type { SavedNormalDocumentRelease, SavedNormalDocumentSnapshot } from '../../../interfaces/saved-normal-document';

export interface SavedNormalDocumentRendererHooks {
  /**
   * Finish input composition and block edits, keyboard actions and pending
   * mutation callbacks synchronously. If this throws, it must undo partial
   * changes itself because no thaw function has been transferred yet.
   */
  freeze(): () => void;
  sessionIdentity(): unknown;
  /** Changes for every persisted mutation, including late async callbacks; never reuse an earlier revision. */
  revisionIdentity(): unknown;
  /** Full current document for every writable hub, even when clean; null only for no hub or read-only access. */
  snapshot(): FinalObject | null;
  /** Mark only the frozen snapshot saved, never a later editing session. */
  markSaved(): void;
}

export interface SavedNormalDocumentRendererTransport {
  sendSnapshot(requestId: string, snapshot: SavedNormalDocumentSnapshot): void;
}

/** Renderer half of the main-owned snapshot handshake; ordinary save IPC is independent. */
export class SavedNormalDocumentCoordinator {
  #active?: { id: string; session: unknown; revision: unknown; thaw?: () => void; snapshotSent: boolean; preparing: boolean };
  #retiredIds = new Set<string>();
  #failed = false;

  constructor(
    private readonly hooks: SavedNormalDocumentRendererHooks,
    private readonly transport: SavedNormalDocumentRendererTransport,
  ) {}

  get frozen(): boolean { return !!this.#active || this.#failed; }

  prepare(requestId: unknown): boolean {
    if (this.frozen || !isSavedNormalDocumentRequestId(requestId) || this.#retiredIds.has(requestId)) { return false; }
    const active = {
      id: requestId, session: undefined as unknown, revision: undefined as unknown,
      thaw: undefined as (() => void) | undefined, snapshotSent: false, preparing: true,
    };
    this.#active = active;
    try {
      active.session = this.hooks.sessionIdentity();
      active.thaw = this.hooks.freeze();
      if (typeof active.thaw !== 'function' || this.#active !== active || this.hooks.sessionIdentity() !== active.session) {
        throw new Error();
      }
      active.revision = this.hooks.revisionIdentity();
      const document = this.hooks.snapshot();
      if (this.hooks.sessionIdentity() !== active.session || this.hooks.revisionIdentity() !== active.revision) { throw new Error(); }
      active.snapshotSent = true;
      active.preparing = false;
      this.transport.sendSnapshot(requestId, { status: 'snapshot', document });
      return true;
    } catch {
      // Retain the editing freeze until main confirms that no write is still
      // active. A failed send must not restore editing beneath a pending save.
      active.preparing = false;
      try { this.transport.sendSnapshot(requestId, { status: 'cancelled' }); } catch { /* Main timeout releases this page. */ }
      return false;
    }
  }

  release(requestId: unknown, result: SavedNormalDocumentRelease): boolean {
    const active = this.#active;
    if (!active || active.preparing || requestId !== active.id || !result || typeof result.saved !== 'boolean' || this.#failed) { return false; }
    // Retire before adapter callbacks, which may reenter via a synchronous test
    // transport or application observer.
    this.#retiredIds.add(active.id);
    if (this.#retiredIds.size > 128) { this.#retiredIds.delete(this.#retiredIds.values().next().value!); }
    this.#active = undefined;
    this.#failed = true;
    try {
      if (result.saved && active.snapshotSent && this.hooks.sessionIdentity() === active.session &&
          this.hooks.revisionIdentity() === active.revision) { this.hooks.markSaved(); }
      active.thaw?.();
      this.#failed = false;
      return true;
    } catch { return false; }
  }
}
