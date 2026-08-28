import * as path from 'path';

import type { ImageElement, ImageLocation, InputSources } from './final-object.interface';
import { isMetadataImportFailure } from './final-object.interface';
import { inheritDateAdded } from './date-added';
import {
  attachImageLocation,
  getImageLocations,
  markImageLocationsMissingInScope,
} from './media-locations';
import { normalizeSourceFolderRelativePath } from './source-folder-tree';

export type FolderFileSnapshot = Map<string, 1>;

export interface MissingFolderEntriesResult {
  changedEntries: number;
  newlyMissing: number;
}

export interface KnownLocationAttachmentResult {
  ambiguousPaths: number;
  attachedLocations: number;
  changedEntries: number;
}

/** Compare physical paths consistently without treating name prefixes as matches. */
export function physicalMediaPathKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return typeof process !== 'undefined' && process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

/**
 * Index successful logical catalogue entries by their exact resolved paths.
 * Multiple locations on one logical entry count once; genuinely ambiguous
 * duplicate catalogue rows count separately and are deliberately not merged.
 */
export function buildKnownSuccessfulMediaPathCounts(
  catalogue: ImageElement[],
  inputSources: InputSources,
): Map<string, number> {
  const counts = new Map<string, number>();

  catalogue.forEach((element: ImageElement) => {
    if (element.deleted === true || isMetadataImportFailure(element)) {
      return;
    }

    const elementPaths = new Set<string>();
    try {
      getImageLocations(element).forEach((location: ImageLocation) => {
        const sourceRoot = inputSources[location.inputSource]?.path;
        if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) {
          return;
        }
        const relativeFolder = normalizeSourceFolderRelativePath(location.partialPath);
        elementPaths.add(physicalMediaPathKey(
          path.resolve(sourceRoot, relativeFolder, location.fileName),
        ));
      });
    } catch {
      return;
    }

    elementPaths.forEach((physicalPath: string) => {
      counts.set(physicalPath, (counts.get(physicalPath) || 0) + 1);
    });
  });

  return counts;
}

/**
 * A completed source scan can prove that an existing logical video is also
 * reachable through a newly-added parent source. Attach that exact path as a
 * second location without probing the file again or changing user metadata.
 */
export function attachKnownLocationsFromSnapshot(
  catalogue: ImageElement[],
  targetSourceIndex: number,
  inputSources: InputSources,
  snapshot: FolderFileSnapshot,
): KnownLocationAttachmentResult {
  const targetRoot = inputSources[targetSourceIndex]?.path;
  if (
    !Number.isSafeInteger(targetSourceIndex)
    || targetSourceIndex < 0
    || typeof targetRoot !== 'string'
    || targetRoot.length === 0
    || !(snapshot instanceof Map)
  ) {
    return { ambiguousPaths: 0, attachedLocations: 0, changedEntries: 0 };
  }

  const scannedPathByKey = new Map<string, string>();
  snapshot.forEach((_present: 1, scannedPath: string) => {
    if (typeof scannedPath === 'string' && scannedPath.length > 0) {
      scannedPathByKey.set(physicalMediaPathKey(scannedPath), scannedPath);
    }
  });

  const candidatesByPath = new Map<string, Set<ImageElement>>();
  catalogue.forEach((element: ImageElement) => {
    if (element.deleted === true || isMetadataImportFailure(element)) {
      return;
    }
    try {
      const matchingPaths = new Set<string>();
      getImageLocations(element).forEach((location: ImageLocation) => {
        const sourceRoot = inputSources[location.inputSource]?.path;
        if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) {
          return;
        }
        const relativeFolder = normalizeSourceFolderRelativePath(location.partialPath);
        const physicalPath = physicalMediaPathKey(
          path.resolve(sourceRoot, relativeFolder, location.fileName),
        );
        if (scannedPathByKey.has(physicalPath)) {
          matchingPaths.add(physicalPath);
        }
      });
      matchingPaths.forEach((physicalPath: string) => {
        let candidates = candidatesByPath.get(physicalPath);
        if (!candidates) {
          candidates = new Set<ImageElement>();
          candidatesByPath.set(physicalPath, candidates);
        }
        candidates.add(element);
      });
    } catch {
      return;
    }
  });

  const changedElements = new Set<ImageElement>();
  let ambiguousPaths = 0;
  let attachedLocations = 0;

  candidatesByPath.forEach((candidates: Set<ImageElement>, physicalPath: string) => {
    if (candidates.size !== 1) {
      ambiguousPaths++;
      return;
    }
    const scannedPath = scannedPathByKey.get(physicalPath);
    if (!scannedPath) {
      return;
    }
    const relativeFilePath = path.relative(path.resolve(targetRoot), path.resolve(scannedPath));
    if (
      relativeFilePath === ''
      || relativeFilePath === '..'
      || relativeFilePath.startsWith('..' + path.sep)
      || path.isAbsolute(relativeFilePath)
    ) {
      return;
    }
    const parsedRelativePath = path.parse(relativeFilePath);
    const targetLocation: ImageLocation = {
      fileName: parsedRelativePath.base,
      inputSource: targetSourceIndex,
      partialPath: parsedRelativePath.dir,
    };
    const target = Array.from(candidates)[0];
    try {
      if (attachImageLocation(target, targetLocation)) {
        attachedLocations++;
        changedElements.add(target);
      }
    } catch {
      return;
    }
  });

  return {
    ambiguousPaths,
    attachedLocations,
    changedEntries: changedElements.size,
  };
}

export interface FolderScanSession {
  readonly generateAutomaticPreviews: boolean;
  readonly generation: number;
  readonly inputSource: number;
  snapshot: FolderFileSnapshot;
  readonly sourcePath: string;
}

/**
 * Owns per-source scan generations and scan-local file snapshots. A snapshot
 * is never reused by a later scan, and an older overlapping scan cannot
 * become authoritative after a newer one starts.
 */
export class FolderScanCoordinator {
  private currentSessionBySource: Map<number, FolderScanSession> = new Map();
  private nextGeneration = 1;

  begin(
    inputSource: number,
    sourcePath = '',
    generateAutomaticPreviews = true,
  ): FolderScanSession {
    const session: FolderScanSession = {
      generateAutomaticPreviews,
      generation: this.nextGeneration++,
      inputSource,
      snapshot: new Map(),
      sourcePath,
    };
    this.currentSessionBySource.set(inputSource, session);
    return session;
  }

  record(session: FolderScanSession, filePath: string): boolean {
    if (!this.isCurrent(session)) {
      return false;
    }
    session.snapshot.set(filePath, 1);
    return true;
  }

  remove(session: FolderScanSession, filePath: string): boolean {
    return this.isCurrent(session) && session.snapshot.delete(filePath);
  }

  complete(session: FolderScanSession): FolderFileSnapshot | undefined {
    return this.isCurrent(session) ? new Map(session.snapshot) : undefined;
  }

  /**
   * Transfer a completed one-shot crawler snapshot without retaining a second
   * full Map in the coordinator while queued metadata finishes.
   */
  completeAndReleaseSnapshot(session: FolderScanSession): FolderFileSnapshot | undefined {
    if (!this.isCurrent(session)) {
      return undefined;
    }
    const completedSnapshot = session.snapshot;
    session.snapshot = new Map();
    return completedSnapshot;
  }

  fail(session: FolderScanSession): boolean {
    if (!this.isCurrent(session)) {
      return false;
    }
    this.invalidate(session.inputSource);
    return true;
  }

  invalidate(inputSource: number): void {
    this.currentSessionBySource.delete(inputSource);
  }

  isCurrent(session: FolderScanSession): boolean {
    return this.currentSessionBySource.get(session.inputSource) === session;
  }

  reset(): void {
    this.currentSessionBySource.clear();
  }
}

/** Remove cache entries that a successful, complete scan proved are absent. */
export function forgetMissingKnownPaths(
  knownPaths: Set<string>,
  snapshot: FolderFileSnapshot,
  failedMetadataPaths: Set<string>,
  pendingMetadataPaths: Set<string>,
): number {
  let removed = 0;

  Array.from(knownPaths).forEach((knownPath: string) => {
    if (snapshot.has(knownPath)) {
      return;
    }
    knownPaths.delete(knownPath);
    failedMetadataPaths.delete(knownPath);
    pendingMetadataPaths.delete(knownPath);
    removed++;
  });

  return removed;
}

function absolutePathIsWithinFolderScope(
  rootFolder: string,
  relativeScope: string,
  candidatePath: string,
): boolean {
  const scopeFolder = path.resolve(rootFolder, relativeScope);
  const relativeCandidate = path.relative(scopeFolder, path.resolve(candidatePath));
  return relativeCandidate === ''
    || (
      relativeCandidate !== '..'
      && !relativeCandidate.startsWith('..' + path.sep)
      && !path.isAbsolute(relativeCandidate)
    );
}

/**
 * Remove stale cache entries only inside a successfully scanned subtree.
 * Paths belonging to sibling folders remain authoritative.
 */
export function forgetMissingKnownPathsInScope(
  knownPaths: Set<string>,
  snapshot: FolderFileSnapshot,
  failedMetadataPaths: Set<string>,
  pendingMetadataPaths: Set<string>,
  rootFolder: string,
  relativeScope: string,
): number {
  const normalizedScope = normalizeSourceFolderRelativePath(relativeScope);
  let removed = 0;

  Array.from(knownPaths).forEach((knownPath: string) => {
    if (
      !absolutePathIsWithinFolderScope(rootFolder, normalizedScope, knownPath)
      || snapshot.has(knownPath)
    ) {
      return;
    }
    knownPaths.delete(knownPath);
    failedMetadataPaths.delete(knownPath);
    pendingMetadataPaths.delete(knownPath);
    removed++;
  });

  return removed;
}

/**
 * Mark entries absent from one successful folder snapshot as missing. Missing
 * entries remain in the saved catalogue so temporary storage outages cannot
 * discard their user metadata. Other sources are left untouched.
 */
export function markMissingFolderEntries(
  catalogue: ImageElement[],
  inputSource: number,
  rootFolder: string,
  snapshot: FolderFileSnapshot,
): number {
  const normalizedInputSource = Number(inputSource);
  let newlyMissing = 0;

  catalogue.forEach((element: ImageElement) => {
    if (element.deleted === true) {
      return;
    }

    try {
      const wasMissing = element.missing === true;
      markImageLocationsMissingInScope(
        element,
        normalizedInputSource,
        '',
        location => snapshot.has(
          path.join(rootFolder, location.partialPath, location.fileName),
        ),
      );
      if (!wasMissing && element.missing === true) {
        newlyMissing++;
      }
    } catch {
      return;
    }
  });

  return newlyMissing;
}

/**
 * Mark absent entries only within one successfully scanned subtree. Invalid
 * catalogue-relative paths are ignored rather than allowed to broaden scope.
 */
export function markMissingFolderEntriesInScope(
  catalogue: ImageElement[],
  inputSource: number,
  rootFolder: string,
  relativeScope: string,
  snapshot: FolderFileSnapshot,
): number {
  return reconcileMissingFolderEntriesInScope(
    catalogue,
    inputSource,
    rootFolder,
    relativeScope,
    snapshot,
  ).newlyMissing;
}

/** Report every per-location change, even if another alias keeps a video live. */
export function reconcileMissingFolderEntriesInScope(
  catalogue: ImageElement[],
  inputSource: number,
  rootFolder: string,
  relativeScope: string,
  snapshot: FolderFileSnapshot,
): MissingFolderEntriesResult {
  const normalizedInputSource = Number(inputSource);
  const normalizedScope = normalizeSourceFolderRelativePath(relativeScope);
  let changedEntries = 0;
  let newlyMissing = 0;

  catalogue.forEach((element: ImageElement) => {
    if (element.deleted === true) {
      return;
    }

    try {
      const wasMissing = element.missing === true;
      const didChange = markImageLocationsMissingInScope(
        element,
        normalizedInputSource,
        normalizedScope,
        location => snapshot.has(
          path.join(rootFolder, location.partialPath, location.fileName),
        ),
      );
      if (didChange) {
        changedEntries++;
      }
      if (!wasMissing && element.missing === true) {
        newlyMissing++;
      }
    } catch {
      return;
    }
  });

  return { changedEntries, newlyMissing };
}

/** Replace one confirmed rename/move origin without leaving a tombstone. */
export function replaceRecoveredFolderEntry(
  catalogue: ImageElement[],
  incoming: ImageElement,
  origin: ImageElement,
): number | undefined {
  const originIndex = catalogue.indexOf(origin);
  if (originIndex === -1) {
    return undefined;
  }

  delete incoming.deleted;
  delete incoming.missing;
  incoming.index = originIndex;
  catalogue[originIndex] = incoming;
  return originIndex;
}

/** Preserve every user-controlled field when filesystem metadata is refreshed. */
export function copyRecoveredEntryMetadata(
  destination: ImageElement,
  origin: ImageElement,
): void {
  inheritDateAdded(destination, origin);
  destination.defaultScreen = origin.defaultScreen;
  destination.lastPlayed = origin.lastPlayed;
  destination.notes = origin.notes;
  destination.playlist = origin.playlist;
  destination.stars = origin.stars;
  destination.tags = origin.tags ? origin.tags.slice() : undefined;
  destination.timesPlayed = origin.timesPlayed;
  destination.year = origin.year;
}
