import { Injectable } from '@angular/core';

import type { InputSources } from '../../../../interfaces/final-object.interface';
import {
  isSourceFolderWithinScope,
  normalizeSourceFolderRelativePath,
} from '../../../../interfaces/source-folder-tree';

export type InputSourceConnected = Record<number, boolean>; // matches InputSources number, boolean represents if folder is connected

@Injectable()
export class SourceFolderService {

  selectedSourceFolder: InputSources = {};

  sourceFolderConnected: InputSourceConnected = {};

  currentlyScanning: Map<number, boolean> = new Map();

  private readonly activeRelativeScanScopes = new Map<number, string>();
  private readonly discoveredDirectoryPaths = new Map<number, Set<string>>();
  private discoveredDirectoryRevision = 0;

  getDiscoveredDirectoryRevision(): number {
    return this.discoveredDirectoryRevision;
  }

  /** Return a stable copy so callers cannot mutate the transient cache. */
  getDiscoveredDirectories(sourceIndex: number): readonly string[] {
    if (!this.isValidSourceIndex(sourceIndex)) {
      return [];
    }

    return Array.from(this.discoveredDirectoryPaths.get(sourceIndex) || [])
      .sort((left: string, right: string) => left.localeCompare(right, 'en-US'));
  }

  /**
   * Replace only the successfully scanned subtree. Paths in sibling branches
   * remain intact, and an invalid update leaves the existing cache unchanged.
   */
  replaceDiscoveredDirectoriesInScope(
    sourceIndex: number,
    relativeScope: unknown,
    discoveredPaths: readonly unknown[],
  ): boolean {
    if (!this.isValidSourceIndex(sourceIndex) || !Array.isArray(discoveredPaths)) {
      return false;
    }

    let normalizedScope: string;
    const normalizedPaths = new Set<string>();
    try {
      normalizedScope = normalizeSourceFolderRelativePath(relativeScope);
      discoveredPaths.forEach((relativePath: unknown) => {
        const normalizedPath = normalizeSourceFolderRelativePath(relativePath);
        if (isSourceFolderWithinScope(normalizedPath, normalizedScope)) {
          normalizedPaths.add(normalizedPath);
        }
      });
    } catch {
      return false;
    }

    if (normalizedScope !== '') {
      normalizedPaths.add(normalizedScope);
    }

    const nextPaths = new Set(this.discoveredDirectoryPaths.get(sourceIndex) || []);
    Array.from(nextPaths).forEach((existingPath: string) => {
      if (isSourceFolderWithinScope(existingPath, normalizedScope)) {
        nextPaths.delete(existingPath);
      }
    });
    normalizedPaths.forEach((relativePath: string) => nextPaths.add(relativePath));
    const previousPaths = this.discoveredDirectoryPaths.get(sourceIndex) || new Set<string>();
    const pathsChanged = previousPaths.size !== nextPaths.size
      || Array.from(previousPaths).some((existingPath: string) => !nextPaths.has(existingPath));
    if (pathsChanged) {
      this.discoveredDirectoryPaths.set(sourceIndex, nextPaths);
      this.discoveredDirectoryRevision++;
    }
    return true;
  }

  setActiveScanScope(sourceIndex: number, relativeScope: unknown): boolean {
    if (!this.isValidSourceIndex(sourceIndex)) {
      return false;
    }

    try {
      this.activeRelativeScanScopes.set(
        sourceIndex,
        normalizeSourceFolderRelativePath(relativeScope),
      );
      return true;
    } catch {
      return false;
    }
  }

  getActiveScanScope(sourceIndex: number): string | undefined {
    if (!this.isValidSourceIndex(sourceIndex)) {
      return undefined;
    }
    return this.activeRelativeScanScopes.get(sourceIndex);
  }

  clearActiveScanScope(sourceIndex: number): void {
    if (this.isValidSourceIndex(sourceIndex)) {
      this.activeRelativeScanScopes.delete(sourceIndex);
    }
  }

  /** Clear transient directory and scan state for one configured source. */
  clearSourceState(sourceIndex: number): void {
    if (!this.isValidSourceIndex(sourceIndex)) {
      return;
    }
    if (this.discoveredDirectoryPaths.delete(sourceIndex)) {
      this.discoveredDirectoryRevision++;
    }
    this.activeRelativeScanScopes.delete(sourceIndex);
    this.currentlyScanning.delete(sourceIndex);
  }

  /** Clear transient state when switching catalogues or starting over. */
  resetTransientState(): void {
    if (this.discoveredDirectoryPaths.size > 0) {
      this.discoveredDirectoryRevision++;
    }
    this.discoveredDirectoryPaths.clear();
    this.activeRelativeScanScopes.clear();
    this.currentlyScanning.clear();
  }

  /**
   * Set all source folders to `NOT connected'
   */
  resetConnected(): void {
    this.sourceFolderConnected = {};
    Object.keys(this.selectedSourceFolder).forEach((key: string) => {
      this.sourceFolderConnected[key] = false;
    });
  }

  addCurrentScanning(sourceIndex: number): void {
    console.log('starting', sourceIndex);
    this.currentlyScanning.set(sourceIndex, true);
  }

  removeCurrentScanning(sourceIndex: number): void {
    console.log('stopping', sourceIndex);
    this.currentlyScanning.set(sourceIndex, false);
  }

  areAllFinishedScanning(): boolean {
    // Array.from returns something like `[[0, true], [5, false]]`
    const allStates: boolean[] = Array.from(this.currentlyScanning).map((element) => {
      return element[1];
    });

    return allStates.every(element => element === false);
  }

  private isValidSourceIndex(sourceIndex: number): boolean {
    return Number.isInteger(sourceIndex) && sourceIndex >= 0;
  }

}
