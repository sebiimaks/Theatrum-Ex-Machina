import { parsePrivateHubProtection } from './private-hub-protection';
import { isPrivateHubStoreCleanupFailure, type PrivateHubStore } from './private-hub-store';
import { CATALOGUE_FILE_MAX_BYTES, parseVhaJson } from './vha-file-persistence';

const MAX_CATALOGUE_HASHES = 100_000;
const HASH_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;

export interface PrivateHubCatalogueRecoveryReview { videoCount: number; }
export type PrivateHubCatalogueRecoveryResult = 'not-needed' | 'cancelled' | 'recovered';
export interface PrivateHubCatalogueRecoveryOptions {
  /** Main-owned lifetime, not renderer-supplied authority. */
  isCurrent: () => boolean;
  /**
   * Confirmation receives no source paths, catalogue text or encryption data.
   * It runs within the store queue; never call or await queued APIs on this
   * same store from the callback. An owner may synchronously revoke or lock,
   * but must await the resulting drain outside this callback.
   */
  confirm: (review: Readonly<PrivateHubCatalogueRecoveryReview>) => Promise<boolean>;
}

function unavailable(): Error { return new Error('Private hub catalogue recovery is unavailable.'); }

/** Match the normal private-session catalogue and active-video hash limits. */
export function reviewPrivateHubCatalogueRecovery(plaintext: Buffer): Readonly<PrivateHubCatalogueRecoveryReview> {
  if (!Buffer.isBuffer(plaintext) || plaintext.length > CATALOGUE_FILE_MAX_BYTES) { throw unavailable(); }
  const catalogue = parseVhaJson(plaintext);
  const hashes = new Set<string>();
  let videoCount = 0;
  for (const image of catalogue.images) {
    if (image.deleted === true || image.cleanName === '*FOLDER*') { continue; }
    if (typeof image.hash !== 'string' || !HASH_PATTERN.test(image.hash)) { throw unavailable(); }
    hashes.add(image.hash);
    if (hashes.size > MAX_CATALOGUE_HASHES) { throw unavailable(); }
    videoCount++;
  }
  // Parsing is a projection for validation and this count only. Never serialize
  // it back: recovery preserves the exact authenticated backup record bytes.
  return Object.freeze({ videoCount });
}

function validActivation(plaintext: Buffer | undefined, hubId: string): boolean {
  if (!plaintext) { return false; }
  try {
    const value: unknown = JSON.parse(plaintext.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const marker = value as Record<string, unknown>;
    return Object.keys(marker).sort().join(',') === 'format,hubId,version'
      && marker.format === 'theatrum-private-hub-activation' && marker.version === 1 && marker.hubId === hubId;
  } catch { return false; }
}

function validProtection(plaintext: Buffer | undefined): boolean {
  // The store supplies undefined only if primary AND backup are absent. This
  // preserves the existing default policy without creating a settings record.
  if (plaintext === undefined) { return true; }
  try { parsePrivateHubProtection(plaintext); return true; }
  catch { return false; }
}

/**
 * Main-only recovery foundation for an already-activated, password-opened store.
 * No activation, conversion verification, preview or source file is created or
 * accessed here. Callers must exclusively own this store and drain it on lock.
 */
export async function recoverPrivateHubCatalogue(
  store: PrivateHubStore, options: PrivateHubCatalogueRecoveryOptions,
): Promise<PrivateHubCatalogueRecoveryResult> {
  let review: Readonly<PrivateHubCatalogueRecoveryReview> | undefined;
  try {
    const { isCurrent, confirm } = options;
    if (typeof isCurrent !== 'function' || typeof confirm !== 'function') { throw unavailable(); }
    return await store.recoverRecordWithReview('catalogue', {
      maximumBytes: CATALOGUE_FILE_MAX_BYTES,
      isCurrent,
      guards: [
        { recordId: 'session:activation', maximumBytes: 512, validate: bytes => validActivation(bytes, store.hubId) },
        { recordId: 'settings:protection', maximumBytes: 256, validate: validProtection },
      ],
      validate: bytes => {
        try { review = reviewPrivateHubCatalogueRecovery(bytes); return true; }
        catch { review = undefined; return false; }
      },
      confirm: async () => {
        if (!review) { throw unavailable(); }
        return (await confirm(review)) === true;
      },
    });
  } catch (error) {
    // Cleanup failures retain their process quarantine identity for the owner.
    if (isPrivateHubStoreCleanupFailure(error)) { throw error; }
    throw unavailable();
  }
}
