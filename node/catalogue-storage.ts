import * as path from 'node:path';
import type { FinalObject } from '../interfaces/final-object.interface';
import type { PrivateHubSession } from './private-hub-session';
import {
  readVhaFileWithBackup, recoverVhaFileFromBackup, writeVhaJsonAtomically,
  type VhaFileReadResult, type VhaFileRecoveryResult,
} from './vha-file-persistence';

/** Main-owned mode. Neither filenames nor renderer data select encryption. */
export type CatalogueStorage = Readonly<{ kind: 'normal' }> | Readonly<{
  kind: 'private';
  cataloguePath: string;
  session: PrivateHubSession;
  generation: number;
}>;

export const NORMAL_CATALOGUE_STORAGE: CatalogueStorage = Object.freeze({ kind: 'normal' });

export type CatalogueStorageTarget = Readonly<{ kind: 'normal'; filePath: string }> | Extract<CatalogueStorage, { kind: 'private' }>;

/** Capture before asynchronous work; a later mode change cannot retarget a save. */
export function captureCatalogueStorageTarget(storage: CatalogueStorage, filePath: string): CatalogueStorageTarget {
  if (storage?.kind === 'normal') {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
      throw new Error('The catalogue destination is invalid.');
    }
    return Object.freeze({ kind: 'normal', filePath });
  }
  if (storage?.kind === 'private'
    && typeof storage.cataloguePath === 'string' && path.isAbsolute(storage.cataloguePath)
    && typeof filePath === 'string' && path.isAbsolute(filePath) && !filePath.includes('\0')
    && path.normalize(filePath) === path.normalize(storage.cataloguePath)
    && storage.session.isCurrent(storage.generation)) {
    return Object.freeze({ kind: 'private', cataloguePath: storage.cataloguePath, session: storage.session, generation: storage.generation });
  }
  throw new Error('The catalogue storage session is unavailable.');
}

export function requireNormalCatalogueStorage(storage: CatalogueStorage): void {
  if (storage?.kind !== 'normal') {
    throw new Error('This operation is not available for private hubs yet.');
  }
}

export async function readCatalogueStorage(target: CatalogueStorageTarget): Promise<VhaFileReadResult> {
  if (target?.kind === 'normal') {
    return readVhaFileWithBackup(target.filePath);
  }
  if (target?.kind === 'private') {
    // No legacy backup, JSON recovery, or plaintext fallback on any failure.
    return { source: 'primary', finalObject: await target.session.readCatalogue(target.generation) };
  }
  throw new Error('The catalogue storage target is invalid.');
}

export async function writeCatalogueStorage(target: CatalogueStorageTarget, catalogue: FinalObject): Promise<void> {
  if (target?.kind === 'private') {
    await target.session.writeCatalogue(target.generation, catalogue);
    return;
  }
  if (target?.kind === 'normal') {
    await writeVhaJsonAtomically(target.filePath, JSON.stringify(catalogue));
    return;
  }
  throw new Error('The catalogue storage target is invalid.');
}

export function recoverCatalogueStorage(target: CatalogueStorageTarget): Promise<VhaFileRecoveryResult> {
  if (target?.kind !== 'normal') {
    return Promise.reject(new Error('Private hub recovery requires its encrypted storage session.'));
  }
  return recoverVhaFileFromBackup(target.filePath);
}
