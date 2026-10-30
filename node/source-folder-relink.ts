import * as fs from 'node:fs';
import * as path from 'node:path';

import type { InputSources } from '../interfaces/final-object.interface';
import type { CatalogueAccessMode } from '../interfaces/catalogue-session';
import { normalizeAbsolutePath } from './local-operation-safety';

export interface SourceFolderRelinkState {
  catalogueAccessMode: CatalogueAccessMode;
  cataloguePersistenceActive: boolean;
  catalogueSessionGeneration: number;
  catalogueTransitionActive: boolean;
  currentlyOpenVhaFile: string;
  selectedSourceFolders: InputSources;
  authorizedCatalogueImageHashes: Set<string>;
  authorizedCatalogueMediaLocations: Set<string>;
  authorizedSourceFolderPaths: Set<string>;
  authorizedSourceFolderRealPaths: Map<string, string>;
  authorizedSourceWatchPaths: Set<string>;
}

export interface SourceFolderRelinkOperations {
  chooseDirectory(): Promise<string | undefined>;
  resolveRoot?(selectedPath: string): Promise<string>;
  resolveCatalogueIdentity?(cataloguePath: string): Promise<string>;
  rememberAccess(canonicalCataloguePath: string, canonicalRoot: string): void;
  stopSource(sourceIndex: number): void;
  rebaseSource(sourceIndex: number, oldRoot: string, newRoot: string): void;
  isBusy?(): boolean;
  operationTimeoutMs?: number;
}

export type SourceFolderRelinkResult = { status: 'cancelled' } | {
  status: 'reconnected';
  sourceIndex: number;
  oldPath: string;
  newPath: string;
  cataloguePath: string;
};

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function nonRootAbsolutePath(value: unknown, label: string): string {
  const normalized = normalizeAbsolutePath(value, label);
  if (samePath(normalized, path.parse(normalized).root)) {
    throw new Error(`${label} cannot be a filesystem root.`);
  }
  return normalized;
}

/** Check only the user-selected directory; never enumerate or read its media. */
export async function resolveReconnectSourceRoot(
  selectedPath: string,
  assertCurrent: () => void = () => undefined,
): Promise<string> {
  assertCurrent();
  const normalized = nonRootAbsolutePath(selectedPath, 'Source folder');
  const canonical = nonRootAbsolutePath(await fs.promises.realpath(normalized), 'Source folder');
  assertCurrent();
  const stats = await fs.promises.stat(canonical);
  assertCurrent();
  if (!stats.isDirectory()) {
    throw new Error('The source folder is not a directory.');
  }
  await fs.promises.access(canonical, fs.constants.R_OK);
  assertCurrent();
  return canonical;
}

/**
 * Relink an existing source after a native folder choice. Exact catalogue media
 * authority is root-relative, so changing the root preserves it without probing
 * files or permitting a renderer to invent catalogue entries. The caller owns
 * source-specific cancellation/cache rebasing and acknowledges only this result.
 */
export async function reconnectSourceFolder(
  sourceIndex: number,
  state: SourceFolderRelinkState,
  operations: SourceFolderRelinkOperations,
): Promise<SourceFolderRelinkResult> {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error('The source folder index is invalid.');
  }
  const source = state.selectedSourceFolders[sourceIndex];
  if (!source || typeof source.path !== 'string' || !source.path || source.path.includes('\0')) {
    throw new Error('The source folder is no longer part of the catalogue.');
  }
  const cataloguePath = state.currentlyOpenVhaFile;
  nonRootAbsolutePath(cataloguePath, 'Catalogue');
  const generation = state.catalogueSessionGeneration;
  const mediaAuthority = state.authorizedCatalogueMediaLocations;
  const imageHashes = state.authorizedCatalogueImageHashes;
  const oldPath = source.path;
  const assertCurrent = (): void => {
    if (state.catalogueAccessMode !== 'read-write') {
      throw new Error('This catalogue is read-only.');
    }
    if (state.cataloguePersistenceActive || state.catalogueTransitionActive || operations.isBusy?.()) {
      throw new Error('The catalogue is busy. Try reconnecting when the current operation has finished.');
    }
    if (
      state.catalogueSessionGeneration !== generation
      || state.currentlyOpenVhaFile !== cataloguePath
      || state.authorizedCatalogueMediaLocations !== mediaAuthority
      || state.authorizedCatalogueImageHashes !== imageHashes
      || state.selectedSourceFolders[sourceIndex] !== source
      || source.path !== oldPath
    ) {
      throw new Error('The catalogue or source folder changed while reconnecting.');
    }
  };
  assertCurrent();

  const timeoutMs = operations.operationTimeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('The reconnect filesystem timeout is invalid.');
  }
  const boundedIdentityCheck = async <T>(operation: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          'The network or filesystem did not respond in time. The source folder was not changed.',
        )), timeoutMs);
      });
      // A late filesystem completion settles only this abandoned race; it cannot
      // resume the transaction or commit a source path after a timeout.
      return await Promise.race([operation(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  const resolveCatalogue = operations.resolveCatalogueIdentity ?? fs.promises.realpath;
  const resolveRoot = operations.resolveRoot ?? resolveReconnectSourceRoot;
  const canonicalCatalogue = nonRootAbsolutePath(
    await boundedIdentityCheck(() => resolveCatalogue(cataloguePath)),
    'Catalogue',
  );
  assertCurrent();
  const selectedPath = await operations.chooseDirectory();
  assertCurrent();
  if (selectedPath === undefined) {
    return { status: 'cancelled' };
  }
  const selectedRoot = nonRootAbsolutePath(selectedPath, 'Source folder');
  const newPath = nonRootAbsolutePath(await boundedIdentityCheck(() => resolveRoot(selectedRoot)), 'Source folder');
  assertCurrent();
  const confirmedCatalogue = nonRootAbsolutePath(await boundedIdentityCheck(() => resolveCatalogue(cataloguePath)), 'Catalogue');
  assertCurrent();
  if (!samePath(canonicalCatalogue, confirmedCatalogue)) {
    throw new Error('The catalogue location changed while reconnecting.');
  }
  // A mount or symlink can change during the other asynchronous checks.
  const confirmedRoot = nonRootAbsolutePath(await boundedIdentityCheck(() => resolveRoot(selectedRoot)), 'Source folder');
  assertCurrent();
  if (!samePath(newPath, confirmedRoot)) {
    throw new Error('The source folder location changed while reconnecting.');
  }

  const nextSources: InputSources = {
    ...state.selectedSourceFolders,
    [sourceIndex]: { ...source, path: newPath, watch: false },
  };
  const oldRootStillUsed = Object.values(nextSources).some(candidate => (
    typeof candidate?.path === 'string' && samePath(candidate.path, oldPath)
  ));
  // Complete all fallible I/O before the synchronous in-memory commit. These
  // callbacks must not start a scan or yield between cancellation and rebasing.
  operations.rememberAccess(canonicalCatalogue, newPath);
  assertCurrent();
  operations.stopSource(sourceIndex);
  operations.rebaseSource(sourceIndex, oldPath, newPath);

  if (!oldRootStillUsed) {
    state.authorizedSourceFolderPaths.delete(oldPath);
    state.authorizedSourceFolderRealPaths.delete(oldPath);
    state.authorizedSourceWatchPaths.delete(oldPath);
  }
  state.authorizedSourceFolderPaths.add(newPath);
  state.authorizedSourceFolderRealPaths.set(newPath, newPath);
  state.selectedSourceFolders = nextSources;
  // Invalidate pending operations captured before the relink, without changing
  // the authorized hash/location pairs or interrupting cached preview requests.
  state.authorizedCatalogueMediaLocations = new Set(mediaAuthority);

  return { status: 'reconnected', sourceIndex, oldPath, newPath, cataloguePath };
}
