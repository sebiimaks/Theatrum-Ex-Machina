import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FolderFileSnapshot } from '../interfaces/folder-rescan';
import {
  configuredSourceRootsEqual,
  normalizeSourceFolderRelativePath,
  sourceFolderPathIsIgnored,
} from '../interfaces/source-folder-path';
import type { CompiledIgnoredSubdirectories } from '../interfaces/source-folder-path';
import { normalizeAbsolutePath, resolveMediaPath } from './local-operation-safety';
import { sourceScanIo } from './source-scan-io';
import type { SourceScanOperationGuard } from './source-scan-io';

export interface SourceScanFileSystem {
  realpath: (value: string) => Promise<string>;
  stat: (value: string) => Promise<Pick<fs.Stats, 'isDirectory' | 'isFile' | 'dev' | 'ino'>>;
}

export interface SourceScanGuard extends SourceScanOperationGuard {
  readonly configuredRoot: string;
  readonly canonicalRoot: string;
  readonly fileSystem?: SourceScanFileSystem;
}

const nativeFileSystem: SourceScanFileSystem = {
  realpath: value => fs.promises.realpath(value),
  stat: value => fs.promises.stat(value),
};

export function assertSourceScanCurrent(guard: SourceScanGuard): void {
  if (guard.signal?.aborted || !guard.isCurrent()) {
    const error = new Error('The source scan was cancelled or its authorization changed.');
    error.name = 'AbortError';
    throw error;
  }
}

/** Global admission remains held until native IO settles, even after cancellation. */
async function guardedOperation<T>(guard: SourceScanGuard, operation: () => Promise<T>): Promise<T> {
  assertSourceScanCurrent(guard);
  const result = await sourceScanIo.run(guard, operation);
  assertSourceScanCurrent(guard);
  return result;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function normalizeSourceScanScope(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')
    || path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error('The source subfolder scope must be root-relative.');
  }
  return normalizeSourceFolderRelativePath(value);
}

export async function readSourceScanStats(guard: SourceScanGuard, filePath: string): Promise<Pick<fs.Stats, 'isDirectory' | 'isFile' | 'dev' | 'ino'>> {
  return guardedOperation(guard, () => (guard.fileSystem || nativeFileSystem).stat(filePath));
}

/** Resolve a requested subtree without synchronously blocking the main process. */
export async function resolveSourceScanScope(guard: SourceScanGuard, requestedScope: string): Promise<string> {
  const scope = normalizeSourceScanScope(requestedScope);
  const configuredRoot = normalizeAbsolutePath(guard.configuredRoot, 'Source folder');
  const candidate = path.resolve(configuredRoot, scope);
  if (candidate !== configuredRoot && !isWithin(configuredRoot, candidate)) {
    throw new Error('The source subfolder is outside its source folder.');
  }
  await verifySourceScanRoot(guard);
  const fileSystem = guard.fileSystem || nativeFileSystem;
  const canonicalCandidate = await guardedOperation(guard, () => fileSystem.realpath(candidate));
  if (!configuredSourceRootsEqual(canonicalCandidate, guard.canonicalRoot)
    && !isWithin(guard.canonicalRoot, canonicalCandidate)) {
    throw new Error('The source subfolder resolves outside its authorized source folder.');
  }
  const candidateStats = await readSourceScanStats(guard, candidate);
  if (!candidateStats.isDirectory()) {
    throw new Error('The source subfolder is no longer an existing directory.');
  }
  await verifySourceScanRoot(guard);
  return candidate;
}

/** Revalidate canonical identity rather than trusting a cached root during a scan. */
export async function verifySourceScanRoot(guard: SourceScanGuard): Promise<void> {
  const fileSystem = guard.fileSystem || nativeFileSystem;
  const configuredRoot = normalizeAbsolutePath(guard.configuredRoot, 'Source folder');
  const expectedRoot = normalizeAbsolutePath(guard.canonicalRoot, 'Authorized source folder');
  if (expectedRoot === path.parse(expectedRoot).root) {
    throw new Error('A filesystem root cannot be used as a media source.');
  }
  const canonicalRoot = await guardedOperation(guard, () => fileSystem.realpath(configuredRoot));
  if (!configuredSourceRootsEqual(canonicalRoot, expectedRoot)) {
    throw new Error('The source folder identity changed since it was authorized.');
  }
  const stats = await guardedOperation(guard, () => fileSystem.stat(configuredRoot));
  if (!stats.isDirectory()) {
    throw new Error('The source folder is no longer an existing directory.');
  }
}

/** Async equivalent of media containment validation, fenced on both sides of IO. */
export async function resolveSourceScanMediaPath(
  guard: SourceScanGuard,
  partialPath: string,
  fileName: string,
): Promise<{ path: string; canonicalPath: string }> {
  const fileSystem = guard.fileSystem || nativeFileSystem;
  const candidate = resolveMediaPath(guard.configuredRoot, partialPath, fileName);
  await verifySourceScanRoot(guard);
  const canonicalPath = await guardedOperation(guard, () => fileSystem.realpath(candidate));
  if (!isWithin(guard.canonicalRoot, canonicalPath)) {
    throw new Error('The media path resolves outside its authorized source folder.');
  }
  // A mount/symlink change during the candidate lookup must fail the whole scan.
  await verifySourceScanRoot(guard);
  return { path: candidate, canonicalPath };
}

export async function yieldSourceScan(guard: SourceScanGuard): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  assertSourceScanCurrent(guard);
}

/** Validate discovery results without serial synchronous network IO on the main thread. */
export async function validateSourceScanEntries(
  entries: readonly string[],
  guard: SourceScanGuard,
  options: {
    allowedExtensions: readonly string[];
    ignoredSubdirectories: CompiledIgnoredSubdirectories;
    maxMediaFiles: number;
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<{ snapshot: FolderFileSnapshot; discoveredRelativeFolders: Set<string> }> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('The source scan validation concurrency is invalid.');
  }
  if (!Number.isSafeInteger(options.maxMediaFiles) || options.maxMediaFiles < 1) {
    throw new Error('The source scan media-file limit is invalid.');
  }
  await verifySourceScanRoot(guard);
  const snapshot: FolderFileSnapshot = new Map();
  const discoveredRelativeFolders = new Set<string>();
  const extensions = new Set(options.allowedExtensions);
  let nextIndex = 0;
  let completed = 0;
  let mediaCount = 0;
  let failed = false;
  const workerGuard: SourceScanGuard = {
    ...guard,
    isCurrent: () => !failed && guard.isCurrent(),
  };
  options.onProgress?.(0, entries.length);

  const worker = async (): Promise<void> => {
    while (nextIndex < entries.length) {
      assertSourceScanCurrent(workerGuard);
      const fullPath = entries[nextIndex++];
      if (/[\\/]$/.test(fullPath)) {
        const directoryPath = fullPath.replace(/[\\/]+$/, '');
        const relativeDirectory = normalizeSourceFolderRelativePath(
          path.relative(guard.configuredRoot, directoryPath),
        );
        if (relativeDirectory !== '' && !sourceFolderPathIsIgnored(
          relativeDirectory, options.ignoredSubdirectories,
        )) {
          discoveredRelativeFolders.add(relativeDirectory);
        }
      } else {
        const parsed = path.parse(fullPath);
        const relativeFolder = path.relative(guard.configuredRoot, parsed.dir);
        if (extensions.has(parsed.ext.slice(1).toLowerCase()) && !sourceFolderPathIsIgnored(
          relativeFolder, options.ignoredSubdirectories,
        )) {
          if (++mediaCount >= options.maxMediaFiles) {
            throw new Error(
              `The source contains at least ${options.maxMediaFiles.toLocaleString('en-US')} media files. `
              + 'Choose a narrower folder so the catalogue scan can remain within safe memory limits.',
            );
          }
          const validated = await resolveSourceScanMediaPath(workerGuard, relativeFolder, parsed.base);
          snapshot.set(validated.path, 1);
        }
      }
      completed++;
      if (completed % 64 === 0) {
        options.onProgress?.(completed, entries.length);
        await yieldSourceScan(workerGuard);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
    await verifySourceScanRoot(workerGuard);
    assertSourceScanCurrent(workerGuard);
    options.onProgress?.(entries.length, entries.length);
    return { snapshot, discoveredRelativeFolders };
  } catch (error) {
    failed = true;
    throw error;
  }
}
