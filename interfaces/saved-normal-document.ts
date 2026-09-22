import type { FinalObject } from './final-object.interface';

/** Separate from ordinary save notifications; every message belongs to one main-owned request. */
export type SavedNormalDocumentSnapshot =
  /** Active writable hubs always supply the full document, independently of dirty flags. */
  | { readonly status: 'snapshot'; readonly document: FinalObject | null }
  | { readonly status: 'cancelled' };

export interface SavedNormalDocumentRelease {
  readonly saved: boolean;
}

export const SAVED_NORMAL_DOCUMENT_CHANNELS = Object.freeze({
  request: 'prepare-normal-document-for-private-open',
  snapshot: 'normal-document-for-private-open',
  release: 'release-normal-document-after-private-open',
});

export function isSavedNormalDocumentRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
