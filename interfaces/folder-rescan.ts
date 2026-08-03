import * as path from 'path';

import type { ImageElement } from './final-object.interface';
import { inheritDateAdded } from './date-added';

export type FolderFileSnapshot = Map<string, 1>;

export interface FolderScanSession {
  readonly generation: number;
  readonly inputSource: number;
  readonly snapshot: FolderFileSnapshot;
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

  begin(inputSource: number, sourcePath = ''): FolderScanSession {
    const session: FolderScanSession = {
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
  let newlyMissing = 0;

  catalogue.forEach((element: ImageElement) => {
    if (Number(element.inputSource) !== Number(inputSource) || element.deleted === true) {
      return;
    }

    const fullPath = path.join(rootFolder, element.partialPath, element.fileName);
    if (!snapshot.has(fullPath) && element.missing !== true) {
      element.missing = true;
      newlyMissing++;
    }
  });

  return newlyMissing;
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
