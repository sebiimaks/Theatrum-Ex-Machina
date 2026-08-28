// async & chokidar Code written by Cal2195
// Was originally added to `main-extract.ts` but was moved here for clarity

const { nativeImage, powerSaveBlocker } = require('electron');
const async = require('async');
const chokidar = require('chokidar');
import * as path from 'path';
import type { Dirent, PathLike } from 'fs';
import type { FSWatcher } from 'chokidar'; // probably the correct type for chokidar.watch() object
const fs = require('fs');
import { fdir } from 'fdir';

import { GLOBALS } from './main-globals';

import type {
  ImageElement,
  ImageElementPlus,
  InputSources,
  ScreenshotSettings,
} from '../interfaces/final-object.interface';
import { isMetadataImportFailure } from '../interfaces/final-object.interface';
import { getImageLocations } from '../interfaces/media-locations';
import { configuredMediaFileExtensions } from './main-filenames';
import {
  addCatalogueMediaLocationAuthority,
  requireCatalogueMediaLocationAuthority,
} from './catalogue-media-authority';
import {
  cancelActiveMediaProcesses,
  capturePreviewPublicationEpoch,
  extractAll,
  isExpectedJpeg,
  previewPublicationIsAllowed,
} from './main-extract';
import type { PreviewOutputPathResolver, SystemThumbnailCreator } from './main-extract';
import { sendCurrentProgress, insertTemporaryFieldsSingle, extractMetadataAsync, cleanUpFileName } from './main-support';
import {
  createImportErrorElement,
  runProbeWithOneRetry,
  shouldExtractThumbnails,
  shouldQueueAutomaticPreviews,
} from './media-import-resilience';
import {
  isActiveThumbnailRegenerationJob,
  planFolderThumbnailRegeneration,
  prepareThumbnailRegeneration,
} from './thumbnail-count';
import type {
  FolderThumbnailRegenerationProgress,
  FolderThumbnailRegenerationResult,
  ThumbnailCoreStatus,
} from '../interfaces/thumbnail-regeneration';
export type {
  FolderThumbnailRegenerationProgress,
  FolderThumbnailRegenerationResult,
} from '../interfaces/thumbnail-regeneration';
import { runSequentialBatch } from './sequential-batch';
import {
  requireAuthorizedSourceRoot,
  resolveExistingMediaPath,
  resolveExistingSourceSubfolder,
} from './local-operation-safety';
import {
  beginPreviewTransaction,
  markPreviewTransactionCommitted,
} from './thumbnail-transaction';
import {
  resolveCanonicalTheatrumAssetDirectory,
  resolveCanonicalTheatrumExistingAssetPath,
  resolveCanonicalTheatrumMediaWriteTarget,
  resolveTheatrumAssetDirectory,
} from './theatrum-protocol-paths';
import {
  buildKnownSuccessfulMediaPathCounts,
  FolderScanCoordinator,
  forgetMissingKnownPaths,
  forgetMissingKnownPathsInScope,
  physicalMediaPathKey,
} from '../interfaces/folder-rescan';
import type {
  FolderFileSnapshot,
  FolderScanSession,
} from '../interfaces/folder-rescan';
import {
  configuredSourceRootsEqual,
  compileIgnoredSubdirectories,
  normalizeIgnoredSubdirectories,
  normalizeSourceFolderRelativePath,
  sourceFolderPathIsIgnored,
} from '../interfaces/source-folder-path';
import type { CompiledIgnoredSubdirectories } from '../interfaces/source-folder-path';

export interface TempMetadataQueueObject {
  dateAdded: number;
  fullPath: string;
  generateAutomaticPreviews?: boolean;
  inputSource: number;
  name: string;
  partialPath: string;
  scanSession?: FolderScanSession;
}

// ONLY FOR LOGGING
const { performance } = require('perf_hooks');

// =====================================================================================================================
// The three queues will be `QueueObject` - https://caolan.github.io/async/v3/docs.html#QueueObject

// meta queue
let metadataQueue;      // QueueObject - accepts a `.push(TempMetadataQueueObject)`
let metaDone = 0;
let metaExtractionStartTime = 0;

// thumb queue
let thumbQueue;         // QueueObject
let thumbsDone = 0;
let thumbExtractionStartTime = 0;
let nextThumbnailRegenerationJobId = 1;
let activeThumbnailQueueRegenerationJobId: number | undefined;

interface ThumbnailQueueElement extends ImageElement {
  thumbnailRegenerationJobId?: number;
}

interface SafeThumbnailQueueElement {
  authorizedSourcePath: string;
  canonicalMediaPath: string;
  device: number;
  inode: number;
}

function canonicalMediaStillMatches(safeElement: SafeThumbnailQueueElement): boolean {
  try {
    const currentCanonicalPath = fs.realpathSync.native(safeElement.canonicalMediaPath);
    if (!sameFilesystemPath(currentCanonicalPath, safeElement.canonicalMediaPath)) {
      return false;
    }
    const currentStat = fs.statSync(currentCanonicalPath);
    return currentStat.isFile()
      && currentStat.dev === safeElement.device
      && currentStat.ino === safeElement.inode;
  } catch {
    return false;
  }
}

function requireSafeThumbnailQueueElement(element: ImageElement): SafeThumbnailQueueElement {
  if (
    !element
    || !Number.isSafeInteger(element.inputSource)
    || typeof element.hash !== 'string'
    || element.hash.length === 0
    || element.hash.length > 200
    || !/^[a-zA-Z0-9_-]+$/.test(element.hash)
    || !GLOBALS.authorizedCatalogueImageHashes.has(element.hash)
  ) {
    throw new Error('The preview item identifier is invalid.');
  }
  requireCatalogueMediaLocationAuthority(
    GLOBALS.authorizedCatalogueMediaLocations,
    element,
  );
  const extension = path.extname(element.fileName).slice(1).toLocaleLowerCase('en-US');
  const allowedExtensions = new Set(
    configuredMediaFileExtensions(GLOBALS.additionalExtensions),
  );
  if (!extension || !allowedExtensions.has(extension)) {
    throw new Error('The preview item is not a configured media type.');
  }
  const sourceFolder = GLOBALS.selectedSourceFolders[element.inputSource];
  if (!sourceFolder?.path) {
    throw new Error('The preview source folder is unavailable.');
  }
  const authorizedSourcePath = requireAuthorizedSourceRoot(
    sourceFolder.path,
    Array.from(GLOBALS.authorizedSourceFolderPaths),
    GLOBALS.authorizedSourceFolderRealPaths,
  );
  const mediaPath = resolveExistingMediaPath(
    authorizedSourcePath,
    element.partialPath,
    element.fileName,
  );
  const canonicalMediaPath = fs.realpathSync.native(mediaPath);
  const canonicalExtension = path.extname(canonicalMediaPath).slice(1).toLocaleLowerCase('en-US');
  const canonicalStat = fs.statSync(canonicalMediaPath);
  if (
    !canonicalStat.isFile()
    || canonicalExtension !== extension
    || !allowedExtensions.has(canonicalExtension)
  ) {
    throw new Error('The preview media path is not a file.');
  }
  return {
    authorizedSourcePath,
    canonicalMediaPath,
    device: canonicalStat.dev,
    inode: canonicalStat.ino,
  };
}

interface ThumbnailRegenerationState {
  assetDirectory: string;
  cancelRunner?: () => void;
  folderBatchJobId?: number;
  generation: number;
  installing: boolean;
  jobId: number;
  outputDirectory: string;
  screenshotCount: number;
  screenshotOutputFolder: string;
  screenshotSettings: ScreenshotSettings;
  sourcePath: string;
  stillOwned?: () => boolean;
  waiters: {
    reject: (reason?: Error) => void;
    resolve: (screenshotCount: number) => void;
  }[];
}

interface CanonicalPreviewAssetRoot {
  assetDirectory: string;
  canonicalAssetDirectory: string;
  outputDirectory: string;
}

const PREVIEW_ASSET_DIRECTORIES = new Set(['thumbnails', 'filmstrips', 'clips']);

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

function isInsideDirectory(rootDirectory: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDirectory, candidatePath);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

/** Resolve and pin the physical generated-assets root for an active hub. */
function requireCurrentCanonicalPreviewAssetRoot(): CanonicalPreviewAssetRoot {
  const outputDirectory = GLOBALS.selectedOutputFolder;
  const assetDirectory = resolveTheatrumAssetDirectory(outputDirectory, GLOBALS.hubName);
  const canonicalAssetDirectory = assetDirectory && resolveCanonicalTheatrumAssetDirectory(
    outputDirectory,
    assetDirectory,
  );
  if (!assetDirectory || !canonicalAssetDirectory) {
    throw new Error('The catalogue preview asset directory is outside the selected output folder.');
  }
  return { assetDirectory, canonicalAssetDirectory, outputDirectory };
}

/** Revalidate a running regeneration before it changes any generated preview. */
function requireActiveCanonicalPreviewAssetRoot(
  state: ThumbnailRegenerationState,
): CanonicalPreviewAssetRoot {
  const current = requireCurrentCanonicalPreviewAssetRoot();
  if (
    !sameFilesystemPath(current.outputDirectory, state.outputDirectory)
    || !sameFilesystemPath(current.assetDirectory, state.assetDirectory)
    || !sameFilesystemPath(current.canonicalAssetDirectory, state.screenshotOutputFolder)
  ) {
    throw new Error('The catalogue preview asset directory changed during thumbnail regeneration.');
  }
  return current;
}

function requireCanonicalPreviewWriteTarget(
  filePath: string,
  assetRoot: CanonicalPreviewAssetRoot,
): string {
  const target = resolveCanonicalTheatrumMediaWriteTarget(
    filePath,
    assetRoot.outputDirectory,
    assetRoot.assetDirectory,
  );
  if (!target) {
    throw new Error('A thumbnail regeneration target is outside the active catalogue assets.');
  }
  return target;
}

function requireCanonicalExistingPreviewPath(
  filePath: string,
  assetRoot: CanonicalPreviewAssetRoot,
): string {
  const target = resolveCanonicalTheatrumExistingAssetPath(
    filePath,
    assetRoot.outputDirectory,
    assetRoot.assetDirectory,
  );
  if (!target) {
    throw new Error('A generated thumbnail file is outside the active catalogue assets.');
  }
  return target;
}

function requireSameCanonicalPreviewAssetRoot(
  current: CanonicalPreviewAssetRoot,
  expected: CanonicalPreviewAssetRoot,
): void {
  if (
    !sameFilesystemPath(current.outputDirectory, expected.outputDirectory)
    || !sameFilesystemPath(current.assetDirectory, expected.assetDirectory)
    || !sameFilesystemPath(current.canonicalAssetDirectory, expected.canonicalAssetDirectory)
  ) {
    throw new Error('The catalogue preview asset directory changed during thumbnail extraction.');
  }
}

/** Return a canonical live or staging preview folder within the active hub. */
function requireCanonicalPreviewDirectory(
  directory: string,
  assetRoot: CanonicalPreviewAssetRoot,
): string {
  if (sameFilesystemPath(path.resolve(directory), assetRoot.canonicalAssetDirectory)) {
    return assetRoot.canonicalAssetDirectory;
  }
  const canonicalDirectory = requireCanonicalExistingPreviewPath(directory, assetRoot);
  if (
    !isInsideDirectory(assetRoot.canonicalAssetDirectory, canonicalDirectory)
    || !fs.statSync(canonicalDirectory).isDirectory()
  ) {
    throw new Error('The generated preview directory is outside the active catalogue assets.');
  }
  return canonicalDirectory;
}

/**
 * Create and verify only the three approved direct preview directories. This
 * closes the child-directory symlink escape before FFmpeg receives a target.
 */
async function prepareCanonicalPreviewAssetDirectories(
  assetRoot: CanonicalPreviewAssetRoot,
  directory: string,
): Promise<string> {
  const currentAssetRoot = requireCurrentCanonicalPreviewAssetRoot();
  requireSameCanonicalPreviewAssetRoot(currentAssetRoot, assetRoot);
  const canonicalDirectory = requireCanonicalPreviewDirectory(directory, assetRoot);
  await Promise.all(Array.from(PREVIEW_ASSET_DIRECTORIES).map(async (subdirectory: string) => {
    const candidateDirectory = path.join(canonicalDirectory, subdirectory);
    if (!fs.existsSync(candidateDirectory)) {
      await fs.promises.mkdir(candidateDirectory, { recursive: true });
    }
    const canonicalSubdirectory = requireCanonicalExistingPreviewPath(candidateDirectory, assetRoot);
    if (
      !isInsideDirectory(canonicalDirectory, canonicalSubdirectory)
      || !fs.statSync(canonicalSubdirectory).isDirectory()
    ) {
      throw new Error('The generated preview directory is outside the active catalogue assets.');
    }
  }));
  return canonicalDirectory;
}

/**
 * Resolve every FFmpeg/publish target at the point it is handed to extraction.
 * A staging run is also limited to its own transaction directory, rather than
 * merely to the broader asset root.
 */
function createCanonicalPreviewOutputPathResolver(
  assetRoot: CanonicalPreviewAssetRoot,
  outputDirectory: string,
): PreviewOutputPathResolver {
  const canonicalOutputDirectory = requireCanonicalPreviewDirectory(outputDirectory, assetRoot);
  return (candidatePath: string): string => {
    const currentAssetRoot = requireCurrentCanonicalPreviewAssetRoot();
    requireSameCanonicalPreviewAssetRoot(currentAssetRoot, assetRoot);
    const target = requireCanonicalPreviewWriteTarget(candidatePath, currentAssetRoot);
    if (!isInsideDirectory(canonicalOutputDirectory, target)) {
      throw new Error('A generated preview target is outside the active catalogue assets.');
    }
    const targetSegments = path.relative(canonicalOutputDirectory, target).split(path.sep);
    const [assetDirectory, fileName] = targetSegments;
    const extension = path.extname(fileName || '').toLowerCase();
    if (
      targetSegments.length !== 2
      || !PREVIEW_ASSET_DIRECTORIES.has(assetDirectory)
      || !fileName
      || path.basename(fileName) !== fileName
      || (assetDirectory === 'clips' ? !['.jpg', '.mp4'].includes(extension) : extension !== '.jpg')
    ) {
      throw new Error('The generated preview target is invalid.');
    }
    return target;
  };
}

const thumbnailRegenerationStates: Map<string, ThumbnailRegenerationState> = new Map();
const automaticThumbnailHashesQueued: Set<string> = new Set();
const lingeringThumbnailInstallations: Set<string> = new Set();
let pendingSystemThumbnail: Promise<Buffer> | undefined;
const SYSTEM_THUMBNAIL_SINGLE_FLIGHT_LEASE_MS = 30 * 1000;

export class ThumbnailRegenerationError extends Error {
  constructor(message: string, public readonly coreStatus: ThumbnailCoreStatus) {
    super(message);
    Object.setPrototypeOf(this, ThumbnailRegenerationError.prototype);
    this.name = 'ThumbnailRegenerationError';
  }
}

const createSystemThumbnail: SystemThumbnailCreator = async (
  videoPath: string,
  width: number,
  height: number,
): Promise<Buffer> => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('System video thumbnails are not supported on this platform.');
  }
  if (pendingSystemThumbnail) {
    throw new Error('A previous system thumbnail request is still running.');
  }

  const request = nativeImage.createThumbnailFromPath(videoPath, { width, height })
    .then((thumbnail) => {
      if (!thumbnail || thumbnail.isEmpty()) {
        throw new Error('The operating system could not create a video thumbnail.');
      }
      const jpegData = thumbnail.toJPEG(100);
      if (!jpegData.length) {
        throw new Error('The operating system returned an empty video thumbnail.');
      }
      return jpegData;
    });
  pendingSystemThumbnail = request;
  const singleFlightLease = setTimeout(() => {
    if (pendingSystemThumbnail === request) {
      pendingSystemThumbnail = undefined;
    }
  }, SYSTEM_THUMBNAIL_SINGLE_FLIGHT_LEASE_MS);
  singleFlightLease.unref();

  try {
    return await request;
  } finally {
    clearTimeout(singleFlightLease);
    if (pendingSystemThumbnail === request) {
      pendingSystemThumbnail = undefined;
    }
  }
};
let activeFolderThumbnailRegenerationJobId: number | undefined;
const folderThumbnailCancellationWaiters: Set<() => void> = new Set();
let folderThumbnailRegenerationGeneration = 0;
let nextFolderThumbnailRegenerationJobId = 1;
let thumbnailRegenerationBlocked = false;
let initialScanQueueGeneration = 0;
const activeInitialScanQueueTokens: Set<symbol> = new Set();
const INITIAL_SCAN_QUEUE_PAUSE_LIMIT_MS = 5 * 60 * 1000;

interface PreviewDeletionTask {
  assetDirectory: string;
  canonicalAssetDirectory: string;
  outputDirectory: string;
  pathToFile: string;
}

// =====================================================================================================================

// Track known catalogue paths per source so nested or duplicate source folders
// cannot suppress one another during a rescan.
let knownPathsBySource: Map<number, Set<string>> = new Map();
let knownSuccessfulPhysicalPathCounts: Map<string, number> = new Map();
let failedMetadataPaths: Set<string> = new Set();
let pendingMetadataPaths: Set<string> = new Set();

const watcherMap: Map<number, FSWatcher> = new Map();
const folderScanCoordinator = new FolderScanCoordinator();
const activeCrawlerScans = new Map<number, FolderScanSession>();
const activeCrawlerAbortControllers = new Map<number, AbortController>();
const MAX_SOURCE_SCAN_MEDIA_FILES = 50_000;
const MAX_PENDING_SOURCE_DIRECTORIES = 25_000;
const SOURCE_SCAN_DIRECTORY_CONCURRENCY = 4;
const METADATA_EXTRACTION_CONCURRENCY = 2;

interface BoundedReaddirTask {
  callback: (error: NodeJS.ErrnoException | null, entries?: Dirent[]) => void;
  directoryPath: PathLike;
  options: { withFileTypes: true };
}

/** Keep broad/network source scans from issuing unbounded parallel readdir calls. */
export function createBoundedCrawlerFileSystem(
  concurrency = SOURCE_SCAN_DIRECTORY_CONCURRENCY,
  maxPending = MAX_PENDING_SOURCE_DIRECTORIES,
  signal?: AbortSignal,
): any {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error('The source scanner concurrency is invalid.');
  }
  const pending: BoundedReaddirTask[] = [];
  let active = 0;
  let requestedDirectories = 0;

  const scanError = (message: string, code: string): NodeJS.ErrnoException => {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };

  const failPending = (error: NodeJS.ErrnoException): void => {
    pending.splice(0).forEach((task: BoundedReaddirTask) => {
      queueMicrotask(() => task.callback(error));
    });
  };

  const runNext = (): void => {
    if (signal?.aborted) {
      failPending(scanError('The source scan was cancelled.', 'ABORT_ERR'));
      return;
    }
    while (active < concurrency && pending.length > 0) {
      const task = pending.shift();
      if (!task) {
        return;
      }
      active++;
      fs.readdir(task.directoryPath, task.options, (
        error: NodeJS.ErrnoException | null,
        entries: Dirent[],
      ) => {
        active--;
        task.callback(error, entries);
        runNext();
      });
    }
  };

  return {
    readdir: (
      directoryPath: PathLike,
      options: { withFileTypes: true },
      callback: (error: NodeJS.ErrnoException | null, entries?: Dirent[]) => void,
    ): void => {
      if (signal?.aborted) {
        queueMicrotask(() => callback(scanError('The source scan was cancelled.', 'ABORT_ERR')));
        return;
      }
      // This is a total-operation ceiling, not merely a queue-length ceiling.
      // A broad tree can otherwise drain and refill the bounded queue forever,
      // eventually retaining an enormous result set in the crawler.
      if (requestedDirectories >= maxPending) {
        queueMicrotask(() => callback(scanError(
          'The source contains too many folders to scan safely in one operation.',
          'ERR_SOURCE_SCAN_LIMIT',
        )));
        return;
      }
      requestedDirectories++;
      pending.push({ callback, directoryPath, options });
      runNext();
    },
    readdirSync: fs.readdirSync.bind(fs),
    realpath: fs.realpath.bind(fs),
    realpathSync: fs.realpathSync.bind(fs),
    stat: fs.stat.bind(fs),
    statSync: fs.statSync.bind(fs),
  };
}

function knownPathsForSource(inputSource: number): Set<string> {
  let sourcePaths = knownPathsBySource.get(inputSource);
  if (!sourcePaths) {
    sourcePaths = new Set();
    knownPathsBySource.set(inputSource, sourcePaths);
  }
  return sourcePaths;
}

const compiledIgnoredScopesBySource = new WeakMap<object, CompiledIgnoredSubdirectories>();

function compiledIgnoredScopesForSource(
  sourceFolder: object & { ignoredSubdirectories?: string[] },
): CompiledIgnoredSubdirectories {
  let compiled = compiledIgnoredScopesBySource.get(sourceFolder);
  if (!compiled) {
    compiled = compileIgnoredSubdirectories(sourceFolder.ignoredSubdirectories);
    compiledIgnoredScopesBySource.set(sourceFolder, compiled);
  }
  return compiled;
}

/** Match one catalogue-relative path against the current source exclusions. */
function sourcePathIsCurrentlyIgnored(inputSource: number, relativePath: unknown): boolean {
  const sourceFolder = GLOBALS.selectedSourceFolders[inputSource];
  return Boolean(sourceFolder) && sourceFolderPathIsIgnored(
    relativePath,
    compiledIgnoredScopesForSource(sourceFolder),
  );
}

/** Resolve an absolute path to one configured source without prefix matching. */
function sourceRelativePathForAbsolutePath(
  sourceRoot: string,
  absolutePath: string,
): string | undefined {
  const relativePath = path.relative(path.resolve(sourceRoot), path.resolve(absolutePath));
  if (
    relativePath === '..'
    || relativePath.startsWith('..' + path.sep)
    || path.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return normalizeSourceFolderRelativePath(relativePath);
}

// =====================================================================================================================

// Miscellaneous
let preventSleepIds: number[] = []; // prevent and allow sleep
let importCompletionSent = false;

// =====================================================================================================================

resetAllQueues();

/**
 * Reset both extraction queues:
 *  - Meta queue
 *  - Thumb queue
 */
export function resetAllQueues(): void {

  allowSleep();
  cancelActiveMediaProcesses();
  initialScanQueueGeneration++;
  activeCrawlerAbortControllers.forEach((controller: AbortController) => controller.abort());
  activeCrawlerAbortControllers.clear();
  activeCrawlerScans.clear();
  folderScanCoordinator.reset();
  activeInitialScanQueueTokens.clear();
  cancelThumbnailRegeneration();

  // kill all previeous
  if (thumbQueue && typeof thumbQueue.kill === 'function') {
    thumbQueue.kill();
  }
  if (metadataQueue && typeof metadataQueue.kill === 'function') {
    metadataQueue.kill();
  }
  // Meta queue ========================================================================================================
  metaDone = 0;
  metaExtractionStartTime = 0;
  pendingMetadataPaths = new Set();
  failedMetadataPaths = new Set();
  automaticThumbnailHashesQueued.clear();
  importCompletionSent = false;

  metadataQueue = async.queue(metadataQueueRunner, METADATA_EXTRACTION_CONCURRENCY);

  metadataQueue.drain(() => {

    if (activeInitialScanQueueTokens.size === 0) {
      thumbQueue.resume();
    }

    if (thumbQueue.idle()) {
      finishImport();
    }

    logPerformance('META QUEUE took ', metaExtractionStartTime);
  });

  // Thumbs queue ======================================================================================================
  thumbsDone = 0;
  thumbExtractionStartTime = 0;

  thumbQueue = async.queue(thumbQueueRunner, 1); // 1 is the number of threads

  thumbQueue.drain(() => {

    logPerformance('THUMB QUEUE took ', thumbExtractionStartTime);
    finishImport();
  });

}

function finishImport(): void {
  if (importCompletionSent) {
    return;
  }
  importCompletionSent = true;
  thumbsDone = 0;
  sendCurrentProgress(1, 1, 'done');
  console.log('media import complete!');
  allowSleep();
}

function enqueueMetadata(file: TempMetadataQueueObject): void {
  if (
    pendingMetadataPaths.has(file.fullPath)
    || sourcePathIsCurrentlyIgnored(file.inputSource, file.partialPath)
  ) {
    return;
  }
  pendingMetadataPaths.add(file.fullPath);
  importCompletionSent = false;
  metadataQueue.push(file);
}

/**
 * Pause import work while an initial folder scan is enumerating files, but
 * always provide a bounded release path. Network watchers and crawlers can
 * fail without emitting their normal completion event; without this lease the
 * shared thumbnail queue would remain paused indefinitely.
 */
function pauseQueuesForInitialScan(description: string): () => void {
  const token = Symbol(description);
  const generation = initialScanQueueGeneration;
  let released = false;

  activeInitialScanQueueTokens.add(token);
  metadataQueue.pause();
  thumbQueue.pause();

  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(pauseLimit);
    if (generation !== initialScanQueueGeneration) {
      return;
    }
    activeInitialScanQueueTokens.delete(token);
    if (activeInitialScanQueueTokens.size > 0) {
      return;
    }
    metadataQueue.resume();
    if (metadataQueue.idle()) {
      thumbQueue.resume();
    }
  };

  const pauseLimit = setTimeout(() => {
    console.warn(`Initial folder scan exceeded its queue-pause limit: ${description}. Import work will continue.`);
    release();
  }, INITIAL_SCAN_QUEUE_PAUSE_LIMIT_MS);
  pauseLimit.unref?.();

  return release;
}

function finishInitialFolderScan(releaseScanQueues: () => void): void {
  releaseScanQueues();
  if (
    activeInitialScanQueueTokens.size === 0
    && metadataQueue.idle()
    && thumbQueue.idle()
  ) {
    finishImport();
  }
}

function reportFolderScanFailure(
  session: FolderScanSession,
  inputDir: string,
  error: unknown,
  relativeScope = '',
): void {
  if (!folderScanCoordinator.fail(session)) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('Folder scan failed:', inputDir, error);
  GLOBALS.angularApp.sender.send(
    'folder-scan-failed',
    session.inputSource,
    message,
    relativeScope,
  );
}

/**
 * Extraction queue runner
 * Runs for every element in the `thumbQueue`
 * @param element -- ImageElement to extract screenshots for
 * @param done    -- callback to indicate the current extraction finished
 */
function thumbQueueRunner(element: ThumbnailQueueElement, done): void {
  const previewPublicationEpoch = capturePreviewPublicationEpoch(element?.hash);
  let safeQueueElement: SafeThumbnailQueueElement;
  try {
    if (!previewPublicationIsAllowed(element?.hash, previewPublicationEpoch)) {
      throw new Error('Generated-preview cleanup is in progress for this item.');
    }
    safeQueueElement = requireSafeThumbnailQueueElement(element);
  } catch (error) {
    console.warn('Skipped an unsafe thumbnail queue item:', error);
    automaticThumbnailHashesQueued.delete(element?.hash);
    done();
    return;
  }
  const regenerationState = thumbnailRegenerationStates.get(element.hash);
  const hasRegenerationMarker = element.thumbnailRegenerationJobId !== undefined;
  const isRegenerationJob: boolean = Boolean(regenerationState && isActiveThumbnailRegenerationJob(
    element.thumbnailRegenerationJobId,
    regenerationState.jobId,
  ));
  if (
    !hasRegenerationMarker
    && sourcePathIsCurrentlyIgnored(element.inputSource, element.partialPath)
  ) {
    automaticThumbnailHashesQueued.delete(element.hash);
    done();
    return;
  }
  if (hasRegenerationMarker && !isRegenerationJob) {
    done();
    return;
  }
  let previewAssetRoot: CanonicalPreviewAssetRoot;
  if (isRegenerationJob) {
    try {
      previewAssetRoot = requireActiveCanonicalPreviewAssetRoot(regenerationState);
    } catch (error) {
      settleThumbnailRegeneration(
        element.hash,
        regenerationState.jobId,
        error instanceof Error ? error : new Error('The preview asset directory is invalid.'),
      );
      done();
      return;
    }
  } else {
    try {
      previewAssetRoot = requireCurrentCanonicalPreviewAssetRoot();
    } catch (error) {
      console.warn('Skipped preview extraction outside the active catalogue assets:', error);
      automaticThumbnailHashesQueued.delete(element.hash);
      done();
      return;
    }
  }
  const screenshotOutputFolder: string = isRegenerationJob
    ? regenerationState.screenshotOutputFolder
    : previewAssetRoot.canonicalAssetDirectory;
  const screenshotSettings: ScreenshotSettings = isRegenerationJob
    ? regenerationState.screenshotSettings
    : GLOBALS.screenshotSettings;
  const sourcePath: string = safeQueueElement.authorizedSourcePath;
  const extractionQueueGeneration = initialScanQueueGeneration;
  const extractionCataloguePath = GLOBALS.currentlyOpenVhaFile;
  const shouldExtractClips: boolean = screenshotSettings.clipSnippets > 0;
  if (isRegenerationJob) {
    activeThumbnailQueueRegenerationJobId = regenerationState.jobId;
  }

  let runnerFinished = false;
  const finishRunner = (): void => {
    if (runnerFinished) {
      return;
    }
    runnerFinished = true;
    if (!isRegenerationJob && extractionQueueGeneration === initialScanQueueGeneration) {
      automaticThumbnailHashesQueued.delete(element.hash);
    }
    if (isRegenerationJob && regenerationState.cancelRunner === finishRunner) {
      regenerationState.cancelRunner = undefined;
    }
    if (isRegenerationJob && activeThumbnailQueueRegenerationJobId === regenerationState.jobId) {
      activeThumbnailQueueRegenerationJobId = undefined;
    }
    done();
  };
  if (isRegenerationJob) {
    regenerationState.cancelRunner = finishRunner;
  }

  const regenerationStillCurrent = (): boolean => {
    if (!isRegenerationJob) {
      return true;
    }
    const currentState = thumbnailRegenerationStates.get(element.hash);
    return currentState?.jobId === regenerationState.jobId
      && regenerationState.generation === folderThumbnailRegenerationGeneration
      && (!regenerationState.stillOwned || regenerationState.stillOwned());
  };

  const previewExtractionStillCurrent = (): boolean => {
    if (
      isRegenerationJob
        ? !regenerationStillCurrent()
        : extractionQueueGeneration !== initialScanQueueGeneration
          || extractionCataloguePath !== GLOBALS.currentlyOpenVhaFile
    ) {
      return false;
    }
    const currentSource = GLOBALS.selectedSourceFolders[element.inputSource];
    if (
      !currentSource
      || !configuredSourceRootsEqual(currentSource.path, sourcePath)
      || !GLOBALS.authorizedCatalogueImageHashes.has(element.hash)
      || !previewPublicationIsAllowed(element.hash, previewPublicationEpoch)
      || !canonicalMediaStillMatches(safeQueueElement)
    ) {
      return false;
    }
    try {
      requireCatalogueMediaLocationAuthority(
        GLOBALS.authorizedCatalogueMediaLocations,
        element,
      );
      requireSameCanonicalPreviewAssetRoot(
        requireCurrentCanonicalPreviewAssetRoot(),
        previewAssetRoot,
      );
      return true;
    } catch {
      return false;
    }
  };

  const finishQueueItem = (
    generatedOutputFolder: string,
    extractionSucceeded: boolean,
    extractionError?: Error,
  ): void => {
    if (!isRegenerationJob) {
      finishRunner();
      return;
    }

    const completeRegeneration = async (): Promise<void> => {
      try {
        if (!previewExtractionStillCurrent()) {
          throw new Error('Thumbnail regeneration was cancelled.');
        }
        await hasAllThumbs(element, generatedOutputFolder, screenshotSettings, false);
        if (!extractionSucceeded && extractionError && GLOBALS.debug) {
          console.warn('Core previews recovered, but optional preview extraction was incomplete:', extractionError);
        }
        if (!regenerationStillCurrent()) {
          throw new Error('Thumbnail regeneration was cancelled.');
        }
        const includeGeneratedClips = shouldExtractClips
          && await hasCompleteClipPair(element.hash, generatedOutputFolder);
        regenerationState.installing = true;
        await commitRegeneratedPreviewFiles(
          element.hash,
          regenerationState.jobId,
          generatedOutputFolder,
          screenshotOutputFolder,
          previewAssetRoot,
          includeGeneratedClips,
          regenerationStillCurrent,
        );
        settleThumbnailRegeneration(element.hash, regenerationState.jobId);
      } catch (error) {
        // Regeneration is transactional, so failure status from the staging
        // folder must not be applied to the preserved live previews.
        const reportedError = error instanceof ThumbnailRegenerationError
          ? new Error(error.message)
          : error instanceof Error
            ? error
            : new Error('The generated preview files could not be recreated.');
        settleThumbnailRegeneration(
          element.hash,
          regenerationState.jobId,
          reportedError,
        );
      } finally {
        finishRunner();
        lingeringThumbnailInstallations.delete(element.hash);
        void removeRegenerationStagingFolder(
          generatedOutputFolder,
          previewAssetRoot,
        );
      }
    };

    void completeRegeneration();
  };

  const extractQueueItem = (generatedOutputFolder: string = screenshotOutputFolder): void => {
    if (!previewExtractionStillCurrent()) {
      finishQueueItem(
        generatedOutputFolder,
        false,
        new Error('Preview extraction was cancelled.'),
      );
      return;
    }
    void prepareCanonicalPreviewAssetDirectories(previewAssetRoot, generatedOutputFolder)
      .then((canonicalGeneratedOutputFolder: string) => {
        if (!previewExtractionStillCurrent()) {
          throw new Error('Preview extraction was cancelled.');
        }
        sendCurrentProgress( // TODO check whether sending data off by 1
          thumbsDone,
          thumbsDone + thumbQueue.length() + 1,
          'importingScreenshots'
        );
        thumbsDone++;

        try {
          extractAll(
            element,
            sourcePath,
            canonicalGeneratedOutputFolder,
            screenshotSettings,
            (success: boolean, error?: Error) => {
              finishQueueItem(canonicalGeneratedOutputFolder, success, error);
            },
            createSystemThumbnail,
            createCanonicalPreviewOutputPathResolver(
              previewAssetRoot,
              canonicalGeneratedOutputFolder,
            ),
            {
              canonicalMediaPath: safeQueueElement.canonicalMediaPath,
              shouldContinue: previewExtractionStillCurrent,
            },
          );
        } catch (error) {
          finishQueueItem(
            canonicalGeneratedOutputFolder,
            false,
            error instanceof Error ? error : new Error('The preview item could not be validated.'),
          );
        }
      })
      .catch((error: Error) => {
        finishQueueItem(
          generatedOutputFolder,
          false,
          error instanceof Error ? error : new Error('The preview output directory is invalid.'),
        );
      });
  };

  if (isRegenerationJob) {
    const stagingName = `${element.hash}-${process.pid}-${Date.now()}-${regenerationState.jobId}`;
    let stagingFolder = '';
    prepareRegenerationStagingFolder(
      previewAssetRoot,
      stagingName,
    )
      .then((preparedStagingFolder: string) => {
        stagingFolder = preparedStagingFolder;
        if (!previewExtractionStillCurrent()) {
          throw new Error('Thumbnail regeneration was cancelled.');
        }
        extractQueueItem(stagingFolder);
      })
      .catch((error: Error) => {
        settleThumbnailRegeneration(element.hash, regenerationState.jobId, error);
        finishRunner();
        if (stagingFolder) {
          void removeRegenerationStagingFolder(
            stagingFolder,
            previewAssetRoot,
          );
        }
      });
    return;
  }

  void prepareCanonicalPreviewAssetDirectories(previewAssetRoot, screenshotOutputFolder)
    .then((canonicalScreenshotOutputFolder: string) => {
      if (!previewExtractionStillCurrent()) {
        throw new Error('Preview extraction was cancelled.');
      }
      return hasAllThumbs(
        element,
        canonicalScreenshotOutputFolder,
        screenshotSettings,
        shouldExtractClips,
      )
        .then(() => {
          finishQueueItem(canonicalScreenshotOutputFolder, true);
        })
        .catch(() => {
          extractQueueItem(canonicalScreenshotOutputFolder);
        });
    })
    .catch((error: Error) => {
      console.warn('Skipped preview extraction outside the active catalogue assets:', error);
      finishQueueItem(
        screenshotOutputFolder,
        false,
        error instanceof Error ? error : new Error('The preview output directory is invalid.'),
      );
    });
}

function settleThumbnailRegeneration(
  fileHash: string,
  jobId: number,
  error?: Error,
): void {
  const state = thumbnailRegenerationStates.get(fileHash);
  if (!state || state.jobId !== jobId) {
    return;
  }
  thumbnailRegenerationStates.delete(fileHash);

  state.waiters.forEach((waiter) => {
    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve(state.screenshotCount);
    }
  });
}

function generatedPreviewRelativePaths(fileHash: string): string[] {
  return [
    path.join('thumbnails', fileHash + '.jpg'),
    path.join('filmstrips', fileHash + '.jpg'),
    path.join('clips', fileHash + '.mp4'),
    path.join('clips', fileHash + '.jpg'),
  ];
}

async function prepareRegenerationStagingFolder(
  assetRoot: CanonicalPreviewAssetRoot,
  stagingName: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(stagingName)) {
    throw new Error('The thumbnail regeneration staging path is invalid.');
  }
  const currentAssetRoot = requireCurrentCanonicalPreviewAssetRoot();
  if (
    !sameFilesystemPath(currentAssetRoot.outputDirectory, assetRoot.outputDirectory)
    || !sameFilesystemPath(currentAssetRoot.assetDirectory, assetRoot.assetDirectory)
    || !sameFilesystemPath(currentAssetRoot.canonicalAssetDirectory, assetRoot.canonicalAssetDirectory)
  ) {
    throw new Error('The catalogue preview asset directory changed during thumbnail regeneration.');
  }

  const transactionRoot = path.join(assetRoot.canonicalAssetDirectory, '.thumbnail-regeneration');
  let canonicalTransactionRoot = resolveCanonicalTheatrumExistingAssetPath(
    transactionRoot,
    assetRoot.outputDirectory,
    assetRoot.assetDirectory,
  );
  if (!canonicalTransactionRoot) {
    await fs.promises.mkdir(transactionRoot, { recursive: true });
    canonicalTransactionRoot = requireCanonicalExistingPreviewPath(transactionRoot, assetRoot);
  }
  if (
    !isInsideDirectory(assetRoot.canonicalAssetDirectory, canonicalTransactionRoot)
    || !fs.statSync(canonicalTransactionRoot).isDirectory()
  ) {
    throw new Error('The thumbnail regeneration transaction directory is invalid.');
  }

  const stagingFolder = path.join(canonicalTransactionRoot, stagingName);
  if (fs.existsSync(stagingFolder)) {
    const existingStagingFolder = requireCanonicalExistingPreviewPath(stagingFolder, assetRoot);
    if (!isInsideDirectory(canonicalTransactionRoot, existingStagingFolder)) {
      throw new Error('The thumbnail regeneration staging directory is invalid.');
    }
    await fs.promises.rm(existingStagingFolder, { force: true, recursive: true });
  }

  await fs.promises.mkdir(stagingFolder);
  const canonicalStagingFolder = requireCanonicalExistingPreviewPath(stagingFolder, assetRoot);
  if (
    !isInsideDirectory(canonicalTransactionRoot, canonicalStagingFolder)
    || !fs.statSync(canonicalStagingFolder).isDirectory()
  ) {
    throw new Error('The thumbnail regeneration staging directory is invalid.');
  }
  await Promise.all(['thumbnails', 'filmstrips', 'clips'].map(async (subdirectory: string) => {
    const directory = path.join(canonicalStagingFolder, subdirectory);
    await fs.promises.mkdir(directory);
    const canonicalDirectory = requireCanonicalExistingPreviewPath(directory, assetRoot);
    if (!isInsideDirectory(canonicalStagingFolder, canonicalDirectory)) {
      throw new Error('The thumbnail regeneration staging directory is invalid.');
    }
  }));
  return canonicalStagingFolder;
}

async function removeRegenerationStagingFolder(
  stagingFolder: string,
  assetRoot: CanonicalPreviewAssetRoot,
): Promise<void> {
  try {
    const currentAssetRoot = requireCurrentCanonicalPreviewAssetRoot();
    if (
      !sameFilesystemPath(currentAssetRoot.outputDirectory, assetRoot.outputDirectory)
      || !sameFilesystemPath(currentAssetRoot.assetDirectory, assetRoot.assetDirectory)
      || !sameFilesystemPath(currentAssetRoot.canonicalAssetDirectory, assetRoot.canonicalAssetDirectory)
    ) {
      return;
    }
    const canonicalStagingFolder = resolveCanonicalTheatrumExistingAssetPath(
      stagingFolder,
      assetRoot.outputDirectory,
      assetRoot.assetDirectory,
    );
    const transactionRoot = resolveCanonicalTheatrumExistingAssetPath(
      path.join(assetRoot.canonicalAssetDirectory, '.thumbnail-regeneration'),
      assetRoot.outputDirectory,
      assetRoot.assetDirectory,
    );
    if (!canonicalStagingFolder || !transactionRoot || !isInsideDirectory(transactionRoot, canonicalStagingFolder)) {
      return;
    }
    await fs.promises.rm(canonicalStagingFolder, { force: true, recursive: true });
  } catch (error) {
    console.warn('Unable to remove thumbnail regeneration staging folder:', stagingFolder, error);
  }
}

/**
 * Replace previews only after a complete new set has been generated. Existing
 * files are moved aside during the short commit step and restored if any move
 * fails, so extraction failures and disconnected shares leave them untouched.
 */
async function commitRegeneratedPreviewFiles(
  fileHash: string,
  jobId: number,
  stagingFolder: string,
  screenshotOutputFolder: string,
  assetRoot: CanonicalPreviewAssetRoot,
  includeGeneratedClips: boolean,
  shouldContinue: () => boolean,
): Promise<void> {
  const currentAssetRoot = requireCurrentCanonicalPreviewAssetRoot();
  if (
    !sameFilesystemPath(currentAssetRoot.outputDirectory, assetRoot.outputDirectory)
    || !sameFilesystemPath(currentAssetRoot.assetDirectory, assetRoot.assetDirectory)
    || !sameFilesystemPath(currentAssetRoot.canonicalAssetDirectory, screenshotOutputFolder)
  ) {
    throw new Error('The catalogue preview asset directory changed during thumbnail regeneration.');
  }
  const canonicalStagingFolder = requireCanonicalExistingPreviewPath(stagingFolder, assetRoot);
  const allRelativePaths = generatedPreviewRelativePaths(fileHash);
  const desiredRelativePaths = includeGeneratedClips
    ? allRelativePaths
    : allRelativePaths.slice(0, 2);
  const backups: { backup: string; original: string }[] = [];
  const installed: string[] = [];
  const backupSuffix = `.regeneration-${process.pid}-${Date.now()}-${jobId}.bak`;
  const requireCurrentJob = (): void => {
    if (!shouldContinue()) {
      throw new Error('Thumbnail regeneration was cancelled.');
    }
  };
  const transactionManifest = await beginPreviewTransaction(
    canonicalStagingFolder,
    screenshotOutputFolder,
    desiredRelativePaths,
    backupSuffix,
  );

  try {
    requireCurrentJob();
    for (const relativePath of desiredRelativePaths) {
      const original = requireCanonicalPreviewWriteTarget(
        path.join(screenshotOutputFolder, relativePath),
        assetRoot,
      );
      const backup = requireCanonicalPreviewWriteTarget(
        path.join(screenshotOutputFolder, relativePath) + backupSuffix,
        assetRoot,
      );
      try {
        await fs.promises.rename(original, backup);
        backups.push({ backup, original });
        requireCurrentJob();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    for (const relativePath of desiredRelativePaths) {
      requireCurrentJob();
      const generated = requireCanonicalExistingPreviewPath(
        path.join(canonicalStagingFolder, relativePath),
        assetRoot,
      );
      const original = requireCanonicalPreviewWriteTarget(
        path.join(screenshotOutputFolder, relativePath),
        assetRoot,
      );
      await fs.promises.rename(generated, original);
      installed.push(original);
      requireCurrentJob();
    }
    requireCurrentJob();
    // The staging directory can outlive the extraction process. Re-resolve it
    // immediately before the final manifest write so a symlink replacement
    // cannot redirect the transaction marker outside this hub.
    const committedStagingFolder = requireCanonicalExistingPreviewPath(
      canonicalStagingFolder,
      assetRoot,
    );
    if (!sameFilesystemPath(committedStagingFolder, canonicalStagingFolder)) {
      throw new Error('The thumbnail regeneration staging directory changed during installation.');
    }
    await markPreviewTransactionCommitted(committedStagingFolder, transactionManifest);
  } catch (error) {
    await Promise.all(installed.map((installedPath: string) => {
      return fs.promises.unlink(installedPath).catch(() => undefined);
    }));
    for (const backup of backups.reverse()) {
      try {
        await fs.promises.rename(backup.backup, backup.original);
      } catch (restoreError) {
        console.error('Unable to restore a preview after regeneration failed:', backup.original, restoreError);
      }
    }
    throw error;
  }

  await Promise.all(backups.map((backup) => {
    return fs.promises.unlink(backup.backup).catch((error: NodeJS.ErrnoException) => {
      console.warn('Unable to remove a completed thumbnail backup:', backup.backup, error);
    });
  }));
}

/**
 * Send element back to Angular; if any screenshots missing, queue it for extraction
 * @param imageElement
 */
function sendNewVideoMetadata(
  imageElement: ImageElementPlus,
  scannedSourcePath?: string,
  generateAutomaticPreviews = true,
): void {

  knownPathsForSource(Number(imageElement.inputSource)).add(imageElement.fullPath);

  if (!isMetadataImportFailure(imageElement)) {
    const physicalPath = physicalMediaPathKey(imageElement.fullPath);
    if (!knownSuccessfulPhysicalPathCounts.has(physicalPath)) {
      knownSuccessfulPhysicalPathCounts.set(physicalPath, 1);
    }
  }

  if (shouldExtractThumbnails(imageElement)) {
    failedMetadataPaths.delete(imageElement.fullPath);
  } else {
    failedMetadataPaths.add(imageElement.fullPath);
  }

  delete imageElement.fullPath; // downgrade to `ImageElement` from `ImageElementPlus`

  const elementForAngular = insertTemporaryFieldsSingle(imageElement);
  GLOBALS.authorizedCatalogueImageHashes.add(imageElement.hash);
  addCatalogueMediaLocationAuthority(
    GLOBALS.authorizedCatalogueMediaLocations,
    imageElement,
  );
  GLOBALS.angularApp.sender.send('new-video-meta', elementForAngular, scannedSourcePath);

  if (
    shouldQueueAutomaticPreviews(imageElement, generateAutomaticPreviews)
    && !automaticThumbnailHashesQueued.has(imageElement.hash)
  ) {
    if (thumbExtractionStartTime === 0) {
      thumbExtractionStartTime = performance.now();
    }
    automaticThumbnailHashesQueued.add(imageElement.hash);
    thumbQueue.push(imageElement);
  }
}

/**
 * Create empty element, extract and update metadata, send over to Angular
 * @param fileInfo - various stat metadata about the file
 * @param done
 */
export function metadataQueueRunner(file: TempMetadataQueueObject, done): void {

  let authorizedFilePath: string | undefined;
  let authorizedFileDevice: number | undefined;
  let authorizedFileInode: number | undefined;
  const scanStillCurrent = (): boolean => {
    if (
      (file.scanSession && !folderScanCoordinator.isCurrent(file.scanSession))
      || sourcePathIsCurrentlyIgnored(file.inputSource, file.partialPath)
    ) {
      return false;
    }

    try {
      const sourceFolder = GLOBALS.selectedSourceFolders[file.inputSource];
      if (!sourceFolder?.path) {
        return false;
      }
      const authorizedSourcePath = requireAuthorizedSourceRoot(
        sourceFolder.path,
        Array.from(GLOBALS.authorizedSourceFolderPaths),
        GLOBALS.authorizedSourceFolderRealPaths,
      );
      if (
        file.scanSession
        && (
          file.scanSession.inputSource !== file.inputSource
          || !configuredSourceRootsEqual(file.scanSession.sourcePath, authorizedSourcePath)
        )
      ) {
        return false;
      }
      const resolvedPath = resolveExistingMediaPath(
        authorizedSourcePath,
        file.partialPath,
        file.name,
      );
      if (!sameFilesystemPath(path.resolve(resolvedPath), path.resolve(file.fullPath))) {
        return false;
      }
      const logicalExtension = path.extname(file.name).slice(1).toLocaleLowerCase('en-US');
      const allowedExtensions = new Set(
        configuredMediaFileExtensions(GLOBALS.additionalExtensions),
      );
      const canonicalPath = fs.realpathSync.native(resolvedPath);
      const canonicalExtension = path.extname(canonicalPath).slice(1).toLocaleLowerCase('en-US');
      const canonicalStat = fs.statSync(canonicalPath);
      if (
        !logicalExtension
        || !allowedExtensions.has(logicalExtension)
        || canonicalExtension !== logicalExtension
        || !allowedExtensions.has(canonicalExtension)
        || !canonicalStat.isFile()
      ) {
        return false;
      }
      if (authorizedFilePath === undefined) {
        authorizedFilePath = canonicalPath;
        authorizedFileDevice = canonicalStat.dev;
        authorizedFileInode = canonicalStat.ino;
      } else if (
        !sameFilesystemPath(canonicalPath, authorizedFilePath)
        || canonicalStat.dev !== authorizedFileDevice
        || canonicalStat.ino !== authorizedFileInode
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!scanStillCurrent()) {
    pendingMetadataPaths.delete(file.fullPath);
    done();
    return;
  }

  if (metaExtractionStartTime === 0) {
    metaExtractionStartTime = performance.now();
  }

  sendCurrentProgress(metaDone, metaDone + metadataQueue.length() + 1, 'importingMeta');
  metaDone++;

  const pathToProbe = authorizedFilePath as string;
  runProbeWithOneRetry(
    pathToProbe,
    () => {
      if (!scanStillCurrent()) {
        return Promise.reject(new Error('Metadata extraction was cancelled.'));
      }
      return extractMetadataAsync(pathToProbe, GLOBALS.screenshotSettings);
    },
  )
    .catch((probeError) => {
      console.warn('Metadata probe failed; adding path-only catalogue entry:', pathToProbe, probeError);
      return createImportErrorElement(pathToProbe);
    })
    .then((imageElement: ImageElementPlus) => {
      if (!scanStillCurrent()) {
        return;
      }
      imageElement.cleanName = cleanUpFileName(file.name);
      imageElement.dateAdded = file.dateAdded;
      imageElement.fileName = file.name;
      imageElement.fullPath = authorizedFilePath as string; // insert this converting `ImageElement` to `ImageElementPlus`
      imageElement.inputSource = file.inputSource;
      imageElement.partialPath = file.partialPath;
      sendNewVideoMetadata(
        imageElement,
        file.scanSession?.sourcePath,
        file.generateAutomaticPreviews
          ?? file.scanSession?.generateAutomaticPreviews
          ?? true,
      );
    })
    .catch((error) => {
      // If the file vanished or the share disconnected completely, skip this
      // entry while guaranteeing that the following queue item still runs.
      console.warn('Could not create an import-error catalogue entry:', file.fullPath, error);
    })
    .finally(() => {
      pendingMetadataPaths.delete(file.fullPath);
      done();
    });

}

/**
 * Recursively enumerate one root-relative scope while keeping every imported
 * item's `partialPath` relative to the configured source root. Discovered
 * directories are presentation metadata only and never become source roots.
 */
function scanConfiguredFolderScope(
  configuredRoot: string,
  scanRoot: string,
  inputSource: number,
  relativeScope: string,
  generateAutomaticPreviews = true,
): void {
  if (activeCrawlerScans.has(inputSource)) {
    GLOBALS.angularApp.sender.send(
      'folder-scan-request-rejected',
      inputSource,
      'Another scan is already running for this source folder.',
    );
    return;
  }

  const sourceFolder = GLOBALS.selectedSourceFolders[inputSource];
  if (!sourceFolder || !configuredSourceRootsEqual(sourceFolder.path, configuredRoot)) {
    throw new Error('The source folder is not configured for this catalogue.');
  }
  const ignoredSubdirectories = compileIgnoredSubdirectories(
    sourceFolder.ignoredSubdirectories,
  );
  if (sourceFolderPathIsIgnored(relativeScope, ignoredSubdirectories)) {
    throw new Error('This source subfolder is ignored. Include it before rescanning.');
  }

  const scanSession = folderScanCoordinator.begin(
    inputSource,
    configuredRoot,
    generateAutomaticPreviews,
  );
  const scanAbortController = new AbortController();
  activeCrawlerScans.set(inputSource, scanSession);
  activeCrawlerAbortControllers.set(inputSource, scanAbortController);
  preventSleep();
  GLOBALS.angularApp.sender.send('started-watching-this-dir', inputSource, relativeScope);
  const releaseScanQueues = pauseQueuesForInitialScan(scanRoot);
  const finishCrawlerScan = (): void => {
    if (activeCrawlerScans.get(inputSource) === scanSession) {
      activeCrawlerScans.delete(inputSource);
    }
    if (activeCrawlerAbortControllers.get(inputSource) === scanAbortController) {
      activeCrawlerAbortControllers.delete(inputSource);
    }
    finishInitialFolderScan(releaseScanQueues);
  };

  const allAcceptableFiles = configuredMediaFileExtensions(GLOBALS.additionalExtensions);
  let crawler;
  try {
    crawler = new fdir({
      fs: createBoundedCrawlerFileSystem(
        SOURCE_SCAN_DIRECTORY_CONCURRENCY,
        MAX_PENDING_SOURCE_DIRECTORIES,
        scanAbortController.signal,
      ),
    })
      .exclude((dir: string, dirPath: string) => (
        dir.startsWith('vha-')
        || sourceFolderPathIsIgnored(
          path.relative(configuredRoot, dirPath.replace(/[\\/]+$/, '')),
          ignoredSubdirectories,
        )
      ))
      // Do not retain unrelated files from a broad parent folder. Directories
      // remain so the Current Hub tree can still show empty subfolders.
      .filter((entryPath: string, isDirectory: boolean) => (
        isDirectory
        || allAcceptableFiles.includes(path.extname(entryPath).slice(1).toLowerCase())
      ))
      .withFullPaths()
      .withDirs()
      .withAbortSignal(scanAbortController.signal)
      // A partial network-volume traversal must fail rather than becoming an
      // authoritative snapshot that marks preserved catalogue entries absent.
      .withErrors()
      .crawl(scanRoot);
  } catch (error) {
    console.error('Unable to begin folder scan:', scanRoot, error);
    reportFolderScanFailure(scanSession, scanRoot, error, relativeScope);
    finishCrawlerScan();
    return;
  }

  const t0 = performance.now(); // LOGGING

  crawler.withPromise().then((entries: string[]) => {

    if (!folderScanCoordinator.isCurrent(scanSession)) {
      return;
    }

    // LOGGING =====================================================================================
    logPerformance('scan took ', t0);
    console.log('Found ', entries.length, ' filesystem entries in given directory');
    // =============================================================================================

    let acceptablePathCount = 0;
    const discoveredRelativeFolders = new Set<string>();

    entries.forEach((fullPath: string) => {
      if (/[\\/]$/.test(fullPath)) {
        const directoryPath = fullPath.replace(/[\\/]+$/, '');
        const relativeDirectory = normalizeSourceFolderRelativePath(
          path.relative(configuredRoot, directoryPath),
        );
        if (
          relativeDirectory !== ''
          && !sourceFolderPathIsIgnored(relativeDirectory, ignoredSubdirectories)
        ) {
          discoveredRelativeFolders.add(relativeDirectory);
        }
        return;
      }

      const parsed = path.parse(fullPath);

      if (!allAcceptableFiles.includes(parsed.ext.substr(1).toLowerCase())) {
        return;
      }

      const relativeFolder = path.relative(configuredRoot, parsed.dir);
      if (sourceFolderPathIsIgnored(relativeFolder, ignoredSubdirectories)) {
        return;
      }
      const containedPath = resolveExistingMediaPath(
        configuredRoot,
        relativeFolder,
        parsed.base,
      );
      acceptablePathCount++;
      folderScanCoordinator.record(scanSession, containedPath);
    });

    if (acceptablePathCount >= MAX_SOURCE_SCAN_MEDIA_FILES) {
      throw new Error(
        `The source contains at least ${MAX_SOURCE_SCAN_MEDIA_FILES.toLocaleString('en-US')} media files. `
        + 'Choose a narrower folder so the catalogue scan can remain within safe memory limits.',
      );
    }

    const scanSnapshot: FolderFileSnapshot | undefined = folderScanCoordinator
      .completeAndReleaseSnapshot(scanSession);
    if (!scanSnapshot) {
      return;
    }

    const knownPaths = knownPathsForSource(inputSource);
    forgetMissingKnownPathsInScope(
      knownPaths,
      scanSnapshot,
      failedMetadataPaths,
      pendingMetadataPaths,
      configuredRoot,
      relativeScope,
    );

    scanSnapshot.forEach((_present: 1, fullPath: string) => {
      if (knownPaths.has(fullPath) && !failedMetadataPaths.has(fullPath)) {
        return;
      }

      // An exact physical path already represented by one successful logical
      // entry is an overlapping source alias, not a new video. The renderer
      // attaches the new location from the completed snapshot in one batch.
      if (knownSuccessfulPhysicalPathCounts.get(physicalMediaPathKey(fullPath)) === 1) {
        knownPaths.add(fullPath);
        return;
      }

      const parsed = path.parse(fullPath);

      const partial: string = path.relative(configuredRoot, parsed.dir).replace(/\\/g, '/');

      const newItem: TempMetadataQueueObject = {
        dateAdded: Date.now(),
        fullPath: fullPath,
        inputSource: inputSource,
        name: parsed.base,
        partialPath: '/' + partial,
        scanSession,
      };

      enqueueMetadata(newItem);

    });

    GLOBALS.angularApp.sender.send(
      'all-files-found-in-dir',
      inputSource,
      scanSnapshot,
      configuredRoot,
      relativeScope,
      Array.from(discoveredRelativeFolders).sort(),
    );
  }).catch((error: Error) => {
    reportFolderScanFailure(scanSession, scanRoot, error, relativeScope);
  }).finally(finishCrawlerScan);

}

/** Use `fdir` to scan a complete configured source without watching it. */
function superFastSystemScan(
  inputDir: string,
  inputSource: number,
  generateAutomaticPreviews = true,
): void {
  let scanRoot: string;
  try {
    scanRoot = resolveExistingSourceSubfolder(inputDir, '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    GLOBALS.angularApp.sender.send('folder-scan-failed', inputSource, message, '');
    return;
  }
  scanConfiguredFolderScope(
    inputDir,
    scanRoot,
    inputSource,
    '',
    generateAutomaticPreviews,
  );
}

/**
 * Scan one configured source subtree without changing the source root or its
 * watcher configuration. A watched source already covers every descendant,
 * so a second manual crawler is deliberately rejected.
 */
export function rescanSourceFolderScope(
  inputSource: number,
  requestedScope: string,
  generateAutomaticPreviews = true,
): void {
  if (!Number.isSafeInteger(inputSource) || inputSource < 0) {
    throw new Error('The source folder index is invalid.');
  }
  if (watcherMap.has(inputSource)) {
    throw new Error('This source folder is already being watched recursively.');
  }
  if (activeCrawlerScans.has(inputSource)) {
    throw new Error('Another scan is already running for this source folder.');
  }

  const sourceFolder = GLOBALS.selectedSourceFolders[inputSource];
  if (!sourceFolder || typeof sourceFolder.path !== 'string') {
    throw new Error('The source folder is not configured for this catalogue.');
  }
  const authorizedSourcePath = requireAuthorizedSourceRoot(
    sourceFolder.path,
    Array.from(GLOBALS.authorizedSourceFolderPaths),
    GLOBALS.authorizedSourceFolderRealPaths,
  );

  // Resolve the renderer-supplied value before normalizing it. In particular,
  // this preserves the safety helper's rejection of leading path separators
  // instead of accidentally turning an absolute path into a relative one.
  const scanRoot = resolveExistingSourceSubfolder(authorizedSourcePath, requestedScope);
  const relativeScope = normalizeSourceFolderRelativePath(requestedScope);
  scanConfiguredFolderScope(
    authorizedSourcePath,
    scanRoot,
    inputSource,
    relativeScope,
    generateAutomaticPreviews,
  );
}

/**
 * Create a new `chokidar` watcher for a particular directory
 * @param inputDir    -- full path to input folder
 * @param inputSource -- the number corresponding to the `inputSource` in ImageElement -- must be set!
 * @param persistent  -- whether to continue watching after the initial scan
 */
export function startFileSystemWatching(
  inputDir: string,
  inputSource: number,
  persistent: boolean,
  generateAutomaticPreviews = true,
): void {

  if (!Number.isSafeInteger(inputSource) || inputSource < 0) {
    throw new Error('The source folder index is invalid.');
  }
  const sourceFolder = GLOBALS.selectedSourceFolders[inputSource];
  if (!sourceFolder || !configuredSourceRootsEqual(sourceFolder.path, inputDir)) {
    throw new Error('The source folder is not configured for this catalogue.');
  }
  const authorizedInputDir = requireAuthorizedSourceRoot(
    sourceFolder.path,
    Array.from(GLOBALS.authorizedSourceFolderPaths),
    GLOBALS.authorizedSourceFolderRealPaths,
  );
  if (!configuredSourceRootsEqual(authorizedInputDir, inputDir)) {
    throw new Error('The source folder does not match the configured catalogue entry.');
  }

  // only run `chokidar` if `persistent`
  if (!persistent) {
    superFastSystemScan(authorizedInputDir, inputSource, generateAutomaticPreviews);
    return;
  }

  const t0 = performance.now();

  console.log('================================================================');
  console.log('SHOULD ONLY RUN ON PERSISTENT SCAN !!!');

  console.log('starting watcher ', inputSource, typeof(inputSource), authorizedInputDir);

  const ignoredSubdirectories = compileIgnoredSubdirectories(
    sourceFolder.ignoredSubdirectories,
  );
  const scanSession = folderScanCoordinator.begin(
    inputSource,
    authorizedInputDir,
    generateAutomaticPreviews,
  );
  GLOBALS.angularApp.sender.send('started-watching-this-dir', inputSource, '');

  // WARNING - there are other ways to have a network address that are not accounted here !!!
  const isNetworkAddress: boolean =    authorizedInputDir.startsWith('//')
                                    || authorizedInputDir.startsWith('\\\\');

  const allAcceptableFiles = configuredMediaFileExtensions(GLOBALS.additionalExtensions);
  const generatedOutputRoot = physicalMediaPathKey(path.join(
    GLOBALS.selectedOutputFolder,
    'vha-' + GLOBALS.hubName,
  ));
  const ignoredWatcherPath = (
    candidatePath: string,
    stats?: { isFile: () => boolean },
  ): boolean => {
    const resolvedCandidate = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(authorizedInputDir, candidatePath);
    const relativeCandidate = sourceRelativePathForAbsolutePath(authorizedInputDir, resolvedCandidate);
    if (relativeCandidate === undefined) {
      return true;
    }
    if (sourceFolderPathIsIgnored(relativeCandidate, ignoredSubdirectories)) {
      return true;
    }
    const absoluteCandidate = physicalMediaPathKey(resolvedCandidate);
    const relativeToGeneratedOutput = path.relative(generatedOutputRoot, absoluteCandidate);
    if (
      relativeToGeneratedOutput === ''
      || (
        relativeToGeneratedOutput !== '..'
        && !relativeToGeneratedOutput.startsWith('..' + path.sep)
        && !path.isAbsolute(relativeToGeneratedOutput)
      )
    ) {
      return true;
    }
    if (stats?.isFile()) {
      const extension = path.extname(absoluteCandidate).slice(1).toLowerCase();
      return !allAcceptableFiles.includes(extension);
    }
    return false;
  };

  const watcherConfig = {
    awaitWriteFinish: {
      pollInterval: 1000,
      stabilityThreshold: 5000,
    },
    cwd: authorizedInputDir,
    disableGlobbing: true,
    // Chokidar 4 no longer treats string globs as patterns. Use an exact
    // descendant test so generated preview clips can never import themselves.
    ignored: ignoredWatcherPath,
    followSymlinks: false,
    persistent: true, // NOTE: if `!persistent` we use `superFastSystemScan()` instead !!!
    usePolling: isNetworkAddress ? true : false,
  };

  const watcher: FSWatcher = chokidar.watch(authorizedInputDir, watcherConfig);
  watcherMap.set(inputSource, watcher);

  const releaseScanQueues = pauseQueuesForInitialScan(authorizedInputDir);
  const discoveredRelativeFolders = new Set<string>();
  let initialScanReady = false;
  let initialScanFailed = false;
  let authorizationFailureReported = false;
  const sourceStillAuthorized = (): boolean => {
    const currentSourceFolder = GLOBALS.selectedSourceFolders[inputSource];
    if (!currentSourceFolder || !configuredSourceRootsEqual(currentSourceFolder.path, authorizedInputDir)) {
      return false;
    }
    try {
      const currentAuthorizedRoot = requireAuthorizedSourceRoot(
        currentSourceFolder.path,
        Array.from(GLOBALS.authorizedSourceFolderPaths),
        GLOBALS.authorizedSourceFolderRealPaths,
      );
      return configuredSourceRootsEqual(currentAuthorizedRoot, authorizedInputDir);
    } catch {
      return false;
    }
  };
  const failClosedForUnauthorizedSource = (): boolean => {
    if (!folderScanCoordinator.isCurrent(scanSession)) {
      return true;
    }
    if (sourceStillAuthorized()) {
      return false;
    }
    if (!authorizationFailureReported) {
      authorizationFailureReported = true;
      console.warn('Stopped a source watcher after its catalogue authorization changed:', inputSource);
      closeWatcher(inputSource);
      finishInitialFolderScan(releaseScanQueues);
      GLOBALS.angularApp.sender.send(
        'folder-scan-failed',
        inputSource,
        'The source folder is no longer authorized for this catalogue.',
        '',
      );
    }
    return true;
  };
  const sendDirectoryDiscoveryUpdate = (): void => {
    GLOBALS.angularApp.sender.send(
      'source-folder-directories-updated',
      inputSource,
      Array.from(discoveredRelativeFolders).sort(),
    );
  };

  watcher
    .on('addDir', (folderPath: string) => {
      if (failClosedForUnauthorizedSource()) {
        return;
      }

      try {
        const relativeFolder = normalizeSourceFolderRelativePath(
          path.isAbsolute(folderPath) ? path.relative(authorizedInputDir, folderPath) : folderPath,
        );
        if (relativeFolder !== '') {
          const directoryWasNew = !discoveredRelativeFolders.has(relativeFolder);
          discoveredRelativeFolders.add(relativeFolder);
          if (initialScanReady && directoryWasNew) {
            sendDirectoryDiscoveryUpdate();
          }
        }
      } catch (error) {
        console.warn('Ignored an invalid discovered source subfolder:', folderPath, error);
      }
    })
    .on('unlinkDir', (folderPath: string) => {
      if (failClosedForUnauthorizedSource()) {
        return;
      }

      try {
        const relativeFolder = normalizeSourceFolderRelativePath(
          path.isAbsolute(folderPath) ? path.relative(authorizedInputDir, folderPath) : folderPath,
        );
        if (relativeFolder === '') {
          return;
        }

        let directoriesChanged = false;
        Array.from(discoveredRelativeFolders).forEach((knownFolder: string) => {
          if (knownFolder === relativeFolder || knownFolder.startsWith(relativeFolder + '/')) {
            discoveredRelativeFolders.delete(knownFolder);
            directoriesChanged = true;
          }
        });
        if (initialScanReady && directoriesChanged) {
          sendDirectoryDiscoveryUpdate();
        }
      } catch (error) {
        console.warn('Ignored an invalid removed source subfolder:', folderPath, error);
      }
    })
    .on('add', (filePath: string) => {

      if (failClosedForUnauthorizedSource()) {
        return;
      }

      const ext = filePath.substring(filePath.lastIndexOf('.') + 1).toLowerCase();

      if (!allAcceptableFiles.includes(ext)) {
        return;
      }

      const subPath = ('/' + filePath.replace(/\\/g, '/')).replace('//', '/');
      const partialPath = subPath.substring(0, subPath.lastIndexOf('/'));
      const fileName = subPath.substring(subPath.lastIndexOf('/') + 1);
      let fullPath: string;
      try {
        fullPath = resolveExistingMediaPath(authorizedInputDir, partialPath, fileName);
      } catch (error) {
        console.warn('Ignored media outside the configured source folder:', filePath, error);
        return;
      }

      folderScanCoordinator.record(scanSession, fullPath);

      if (knownPathsForSource(inputSource).has(fullPath) && !failedMetadataPaths.has(fullPath)) {
        return;
      }

      if (knownSuccessfulPhysicalPathCounts.get(physicalMediaPathKey(fullPath)) === 1) {
        knownPathsForSource(inputSource).add(fullPath);
        if (initialScanReady) {
          GLOBALS.angularApp.sender.send(
            'known-source-location-found',
            inputSource,
            fullPath,
            authorizedInputDir,
          );
        }
        return;
      }

      const newItem: TempMetadataQueueObject = {
        dateAdded: Date.now(),
        fullPath: fullPath,
        // This preference governs only the explicit scan/restart. Files added
        // later by a live watcher retain the ordinary automatic behavior.
        generateAutomaticPreviews: initialScanReady ? true : generateAutomaticPreviews,
        inputSource: inputSource,
        name: fileName,
        partialPath: partialPath,
        scanSession,
      };

      enqueueMetadata(newItem);
    })
    .on('change', (filePath: string) => {
      if (failClosedForUnauthorizedSource()) {
        return;
      }
      const subPath = ('/' + filePath.replace(/\\/g, '/')).replace('//', '/');
      const partialPath = subPath.substring(0, subPath.lastIndexOf('/'));
      const fileName = subPath.substring(subPath.lastIndexOf('/') + 1);
      let fullPath: string;
      try {
        fullPath = resolveExistingMediaPath(authorizedInputDir, partialPath, fileName);
      } catch (error) {
        console.warn('Ignored changed media outside the configured source folder:', filePath, error);
        return;
      }

      if (!failedMetadataPaths.has(fullPath)) {
        return;
      }

      enqueueMetadata({
        dateAdded: Date.now(),
        fullPath,
        generateAutomaticPreviews: true,
        inputSource,
        name: fileName,
        partialPath,
        scanSession,
      });
    })
    .on('unlink', (partialFilePath: string) => {    // note: this happens even when file is renamed!
      if (failClosedForUnauthorizedSource()) {
        return;
      }
      console.log(' !!! FILE DELETED, updating Angular:', partialFilePath);
      GLOBALS.angularApp.sender.send('single-file-deleted', inputSource, partialFilePath);
      const fullPath = path.join(authorizedInputDir, partialFilePath);
      folderScanCoordinator.remove(scanSession, fullPath);
      knownPathsForSource(inputSource).delete(fullPath);
      knownSuccessfulPhysicalPathCounts.delete(physicalMediaPathKey(fullPath));
      failedMetadataPaths.delete(fullPath);
      pendingMetadataPaths.delete(fullPath);
      // note: there is no need to watch for `unlinkDir` since `unlink` fires for every file anyway!
    })
    .on('ready', () => {
      if (failClosedForUnauthorizedSource()) {
        return;
      }
      initialScanReady = true;
      console.log('Finished scanning', inputSource);
      const scanSnapshot = folderScanCoordinator.complete(scanSession);
      if (scanSnapshot) {
        forgetMissingKnownPaths(
          knownPathsForSource(inputSource),
          scanSnapshot,
          failedMetadataPaths,
          pendingMetadataPaths,
        );
        GLOBALS.angularApp.sender.send(
          'all-files-found-in-dir',
          inputSource,
          scanSnapshot,
          authorizedInputDir,
          '',
          Array.from(discoveredRelativeFolders).sort(),
        );
      }
      finishInitialFolderScan(releaseScanQueues);

      if (persistent) {
        console.log('^^^^^^^^ - CONTINUING to watch this directory!');
      } else {
        console.log('^^^^^^^^ - stopping watching this directory');
        watcher.close();  // chokidar seems to disregard `persistent` when `fsevents` is not enabled
      }

      logPerformance('Chokidar took ', t0);
    })
    .on('error', (error: Error) => {
      if (!initialScanReady) {
        if (initialScanFailed) {
          return;
        }
        initialScanFailed = true;
        reportFolderScanFailure(scanSession, authorizedInputDir, error, '');
        finishInitialFolderScan(releaseScanQueues);
        if (watcherMap.get(inputSource) === watcher) {
          watcherMap.delete(inputSource);
        }
        watcher.close().catch((closeError: Error) => {
          console.warn('Unable to close a failed source-folder watcher:', authorizedInputDir, closeError);
        });
        return;
      }

      console.error('Active folder watcher reported an error:', authorizedInputDir, error);
      GLOBALS.angularApp.sender.send(
        'folder-watch-error',
        inputSource,
        error instanceof Error ? error.message : String(error),
      );
    });

}

/**
 * Close out all the wathers
 * reset the known per-source catalogue paths
 * @param finalArray
 */
export function buildKnownCataloguePathsBySource(
  finalArray: ImageElement[],
  inputSources: InputSources,
): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  finalArray.forEach((element: ImageElement) => {
    try {
      getImageLocations(element).forEach((location) => {
        const sourceFolder = inputSources[location.inputSource];
        if (
          !sourceFolder?.path
          || location.missing === true
          || sourceFolderPathIsIgnored(
            location.partialPath,
            compiledIgnoredScopesForSource(sourceFolder),
          )
        ) {
          return;
        }
        let sourcePaths = result.get(location.inputSource);
        if (!sourcePaths) {
          sourcePaths = new Set<string>();
          result.set(location.inputSource, sourcePaths);
        }
        sourcePaths.add(path.join(
          sourceFolder.path,
          location.partialPath,
          location.fileName,
        ));
      });
    } catch (error) {
      console.warn('Ignored invalid media locations while restoring folder watchers:', error);
    }
  });
  return result;
}

export function resetWatchers(finalArray: ImageElement[]): void {

  // close every old watcher
  closeAllWatchers();

  knownPathsBySource = buildKnownCataloguePathsBySource(
    finalArray,
    GLOBALS.selectedSourceFolders,
  );
  knownSuccessfulPhysicalPathCounts = buildKnownSuccessfulMediaPathCounts(
    finalArray,
    GLOBALS.selectedSourceFolders,
  );
  failedMetadataPaths = new Set();
  pendingMetadataPaths = new Set();
  activeCrawlerScans.clear();
  folderScanCoordinator.reset();

  finalArray.forEach((element: ImageElement) => {
    if (shouldExtractThumbnails(element)) {
      return;
    }
    try {
      getImageLocations(element).forEach((location) => {
        const sourceFolder = GLOBALS.selectedSourceFolders[location.inputSource];
        if (
          sourceFolder?.path
          && !sourceFolderPathIsIgnored(
            location.partialPath,
            compiledIgnoredScopesForSource(sourceFolder),
          )
        ) {
          failedMetadataPaths.add(path.join(
            sourceFolder.path,
            location.partialPath,
            location.fileName,
          ));
        }
      });
    } catch (error) {
      console.warn('Ignored invalid media locations while restoring failed imports:', error);
    }
  });
}

/** Remove queued work that became excluded before its worker could start. */
function removeQueuedWorkInIgnoredScopes(inputSource: number): void {
  if (metadataQueue && typeof metadataQueue.remove === 'function') {
    metadataQueue.remove((task: { data?: TempMetadataQueueObject }): boolean => {
      const queued = task?.data;
      if (
        !queued
        || queued.inputSource !== inputSource
        || !sourcePathIsCurrentlyIgnored(inputSource, queued.partialPath)
      ) {
        return false;
      }
      pendingMetadataPaths.delete(queued.fullPath);
      return true;
    });
  }

  if (thumbQueue && typeof thumbQueue.remove === 'function') {
    thumbQueue.remove((task: { data?: ThumbnailQueueElement }): boolean => {
      const queued = task?.data;
      if (
        !queued
        || queued.thumbnailRegenerationJobId !== undefined
        || queued.inputSource !== inputSource
        || !sourcePathIsCurrentlyIgnored(inputSource, queued.partialPath)
      ) {
        return false;
      }
      automaticThumbnailHashesQueued.delete(queued.hash);
      return true;
    });
  }
}

/**
 * Apply one renderer-confirmed exclusion update, refresh path identity caches,
 * and safely restart only the affected source when needed.
 */
export function updateSourceFolderIgnoredSubdirectories(
  inputSource: number,
  ignoredSubdirectoriesValue: unknown,
  finalArray: ImageElement[],
): {
  applied: true;
  ignoredSubdirectories: string[];
  wasWatching: boolean;
} {
  if (!Number.isSafeInteger(inputSource) || inputSource < 0) {
    throw new Error('The source folder index is invalid.');
  }
  if (!Array.isArray(finalArray)) {
    throw new Error('The updated catalogue is invalid.');
  }
  const sourceFolder = GLOBALS.selectedSourceFolders[inputSource];
  if (!sourceFolder || typeof sourceFolder.path !== 'string') {
    throw new Error('The source folder is not configured for this catalogue.');
  }
  const compiledIgnoredSubdirectories = compileIgnoredSubdirectories(
    ignoredSubdirectoriesValue,
  );
  const ignoredSubdirectories = [...compiledIgnoredSubdirectories.scopes];
  const sourcePath = sourceFolder.path;
  const shouldWatch = sourceFolder.watch === true;
  finalArray.forEach((element: ImageElement) => getImageLocations(element));
  const nextSourceFolders: InputSources = {
    ...GLOBALS.selectedSourceFolders,
    [inputSource]: {
      ...(ignoredSubdirectories.length > 0 ? { ignoredSubdirectories } : {}),
      path: sourcePath,
      watch: shouldWatch,
    },
  };
  const nextKnownPaths = buildKnownCataloguePathsBySource(finalArray, nextSourceFolders);
  const nextSuccessfulPathCounts = buildKnownSuccessfulMediaPathCounts(
    finalArray,
    nextSourceFolders,
  );

  closeWatcher(inputSource);
  GLOBALS.selectedSourceFolders = nextSourceFolders;

  removeQueuedWorkInIgnoredScopes(inputSource);
  knownPathsBySource = nextKnownPaths;
  knownSuccessfulPhysicalPathCounts = nextSuccessfulPathCounts;

  // A running worker rechecks the live ignore list before it publishes
  // metadata. Remove stale retry markers as well so excluded paths cannot be
  // requeued by later watcher events.
  const removeIgnoredAbsolutePath = (absolutePath: string): boolean => {
    const relativePath = sourceRelativePathForAbsolutePath(sourcePath, absolutePath);
    return relativePath !== undefined
      && sourceFolderPathIsIgnored(relativePath, compiledIgnoredSubdirectories);
  };
  failedMetadataPaths = new Set(
    Array.from(failedMetadataPaths).filter(pathValue => !removeIgnoredAbsolutePath(pathValue)),
  );
  pendingMetadataPaths = new Set(
    Array.from(pendingMetadataPaths).filter(pathValue => !removeIgnoredAbsolutePath(pathValue)),
  );

  importCompletionSent = false;
  return {
    applied: true,
    ignoredSubdirectories,
    wasWatching: shouldWatch,
  };
}

/**
 * Close the old watcher
 * happens when opening a new hub (or user toggles the `watch` near folder)
 * @param inputSource
 */
export function closeWatcher(inputSource: number): void {
  console.log('stop watching', inputSource);
  activeCrawlerAbortControllers.get(inputSource)?.abort();
  activeCrawlerAbortControllers.delete(inputSource);
  folderScanCoordinator.invalidate(inputSource);
  activeCrawlerScans.delete(inputSource);
  const watcher = watcherMap.get(inputSource);
  watcherMap.delete(inputSource);
  if (watcher) {
    console.log('closing ', inputSource);
    watcher.close()
      .then(() => console.log(inputSource, ' closed!'))
      .catch((error: Error) => console.warn('Unable to close folder watcher:', inputSource, error));
  }
}

/** Close every active source watcher before a catalogue's capabilities change. */
export function closeAllWatchers(): void {
  const inputSources = new Set<number>([
    ...Array.from(watcherMap.keys()),
    ...Array.from(activeCrawlerAbortControllers.keys()),
    ...Array.from(activeCrawlerScans.keys()),
  ]);
  Array.from(inputSources).forEach((inputSource: number) => {
    closeWatcher(inputSource);
  });
}

/**
 * Start old watcher
 * happens when user toggles the `watch` near folder
 * @param inputSource
 * @param folderPath
 */
export function startWatcher(
  inputSource: number,
  folderPath: string,
  persistent: boolean,
  generateAutomaticPreviews = true,
): void {
  console.log('start watching !!!!', inputSource, typeof(inputSource), folderPath, persistent);

  if (!Number.isSafeInteger(inputSource) || inputSource < 0) {
    throw new Error('The source folder index is invalid.');
  }
  const configuredSource = GLOBALS.selectedSourceFolders[inputSource];
  if (!configuredSource || !configuredSourceRootsEqual(configuredSource.path, folderPath)) {
    throw new Error('The source folder is not configured for this catalogue.');
  }
  const authorizedSourcePath = requireAuthorizedSourceRoot(
    configuredSource.path,
    Array.from(GLOBALS.authorizedSourceFolderPaths),
    GLOBALS.authorizedSourceFolderRealPaths,
  );
  if (!configuredSourceRootsEqual(authorizedSourcePath, folderPath)) {
    throw new Error('The source folder does not match the configured catalogue entry.');
  }
  if (persistent && !GLOBALS.authorizedSourceWatchPaths.has(authorizedSourcePath)) {
    throw new Error('Automatic watching has not been authorized for this source folder.');
  }

  if (watcherMap.has(inputSource)) {
    closeWatcher(inputSource);
  }

  const ignoredSubdirectories = normalizeIgnoredSubdirectories(
    configuredSource.ignoredSubdirectories,
  );
  GLOBALS.selectedSourceFolders[inputSource] = {
    ...(ignoredSubdirectories.length > 0 ? { ignoredSubdirectories } : {}),
    path: authorizedSourcePath,
    watch: persistent,
  };

  importCompletionSent = false;
  preventSleep();
  startFileSystemWatching(
    authorizedSourcePath,
    inputSource,
    persistent,
    generateAutomaticPreviews,
  );
}

async function requireNonEmptyFile(filePath: string): Promise<void> {
  const fileStats = await fs.promises.stat(filePath);
  if (!fileStats.isFile() || fileStats.size === 0) {
    throw new Error('A generated preview file is empty.');
  }
}

async function hasCompleteClipPair(fileHash: string, screenshotFolder: string): Promise<boolean> {
  try {
    await Promise.all([
      requireNonEmptyFile(path.join(screenshotFolder, 'clips', fileHash + '.mp4')),
      requireNonEmptyFile(path.join(screenshotFolder, 'clips', fileHash + '.jpg')),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Validate the core JPEGs exactly; optionally require a non-empty clip pair. */
async function hasAllThumbs(
  element: ImageElement,
  screenshotFolder: string,
  screenshotSettings: ScreenshotSettings,
  requireClips: boolean,
): Promise<boolean> {
  const fileHash = element.hash;
  const thumb: string = path.join(screenshotFolder, 'thumbnails', fileHash + '.jpg');
  const filmstrip: string = path.join(screenshotFolder, 'filmstrips', fileHash + '.jpg');
  const screenshotHeight = screenshotSettings.height;
  const screenshotWidth = Math.round(screenshotHeight * (16 / 9));

  const [thumbIsValid, filmstripIsValid] = await Promise.all([
    isExpectedJpeg(thumb, screenshotWidth, screenshotHeight),
    isExpectedJpeg(filmstrip, screenshotWidth * element.screens, screenshotHeight),
  ]);
  const coreStatus: ThumbnailCoreStatus = {
    filmstrip: filmstripIsValid,
    thumbnail: thumbIsValid,
  };
  if (!thumbIsValid) {
    throw new ThumbnailRegenerationError(
      'No usable thumbnail frame could be decoded.',
      coreStatus,
    );
  }
  if (!filmstripIsValid) {
    throw new ThumbnailRegenerationError(
      'No usable filmstrip could be assembled.',
      coreStatus,
    );
  }

  if (requireClips && !await hasCompleteClipPair(fileHash, screenshotFolder)) {
    throw new Error('The generated preview clip pair is incomplete.');
  }

  return true;
}

/**
 * Send all `imageElements` to the `thumbQueue`
 * @param fullArray          - ImageElement array
 */
export function extractAnyMissingThumbs(fullArray: ImageElement[]): void {
  preventSleep();
  const requestHashes = new Set<string>();
  fullArray.forEach((element: ImageElement) => {
    if (
      !element.missing
      && shouldExtractThumbnails(element)
      && !requestHashes.has(element.hash)
      && !automaticThumbnailHashesQueued.has(element.hash)
    ) {
      try {
        requireSafeThumbnailQueueElement(element);
        requestHashes.add(element.hash);
        automaticThumbnailHashesQueued.add(element.hash);
        importCompletionSent = false;
        thumbQueue.push(element);
      } catch (error) {
        console.warn('Skipped an unsafe missing-thumbnail request:', error);
      }
    }
  });

  if (thumbQueue.idle()) {
    finishImport();
  }
}

/**
 * Remove and recreate all generated preview assets for one catalogue item.
 * Uses the same extraction queue and settings as normal imports.
 */
export function regenerateThumbnails(
  element: ImageElement,
  folderBatchJobId?: number,
  stillOwned?: () => boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (thumbnailRegenerationBlocked) {
      reject(new Error('The catalogue is changing. Wait before regenerating thumbnails.'));
      return;
    }
    const fileHash: string = element && element.hash;
    const sourceFolder = element && GLOBALS.selectedSourceFolders[element.inputSource];

    if (
      !fileHash
      || !/^[a-zA-Z0-9_-]+$/.test(fileHash)
      || !sourceFolder
      || !sourceFolder.path
      || !shouldExtractThumbnails(element)
    ) {
      reject(new Error('This item does not have enough metadata to regenerate its previews.'));
      return;
    }

    let previewAssetRoot: CanonicalPreviewAssetRoot;
    try {
      requireSafeThumbnailQueueElement(element);
      previewAssetRoot = requireCurrentCanonicalPreviewAssetRoot();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('The preview item is invalid.'));
      return;
    }

    if (lingeringThumbnailInstallations.has(fileHash)) {
      reject(new Error('The previous thumbnail installation for this item is still finishing.'));
      return;
    }

    const existingState = thumbnailRegenerationStates.get(fileHash);
    if (existingState) {
      existingState.waiters.push({ reject, resolve });
      return;
    }

    const jobId = nextThumbnailRegenerationJobId++;
    const screenshotSettings: ScreenshotSettings = { ...GLOBALS.screenshotSettings };
    const regenerationElement: ThumbnailQueueElement = {
      ...prepareThumbnailRegeneration(element, screenshotSettings),
      thumbnailRegenerationJobId: jobId,
    };
    thumbnailRegenerationStates.set(fileHash, {
      assetDirectory: previewAssetRoot.assetDirectory,
      folderBatchJobId,
      generation: folderThumbnailRegenerationGeneration,
      installing: false,
      jobId,
      outputDirectory: previewAssetRoot.outputDirectory,
      screenshotCount: regenerationElement.screens,
      screenshotOutputFolder: previewAssetRoot.canonicalAssetDirectory,
      screenshotSettings,
      sourcePath: sourceFolder.path,
      stillOwned,
      waiters: [{ reject, resolve }],
    });

    preventSleep();
    importCompletionSent = false;
    thumbQueue.push(regenerationElement);
  });
}

export function isFolderThumbnailRegenerationActive(): boolean {
  return activeFolderThumbnailRegenerationJobId !== undefined;
}

export function isThumbnailRegenerationActive(): boolean {
  return thumbnailRegenerationBlocked
    || activeFolderThumbnailRegenerationJobId !== undefined
    || activeThumbnailQueueRegenerationJobId !== undefined
    || thumbnailRegenerationStates.size > 0;
}

export function setThumbnailRegenerationBlocked(blocked: boolean): void {
  thumbnailRegenerationBlocked = blocked;
}

/**
 * Cancel every queued or active manual thumbnail-regeneration job. Active
 * extraction is released from the shared queue immediately and remains fenced
 * inside its unique staging folder, so a late callback cannot publish files.
 * If cancellation crosses the short transactional install phase, the hash is
 * held until rollback/commit handling finishes to prevent overlapping writes.
 */
export function cancelThumbnailRegeneration(): boolean {
  const hadRegeneration = activeFolderThumbnailRegenerationJobId !== undefined
    || activeThumbnailQueueRegenerationJobId !== undefined
    || thumbnailRegenerationStates.size > 0;
  if (!hadRegeneration) {
    return false;
  }

  folderThumbnailRegenerationGeneration++;
  activeFolderThumbnailRegenerationJobId = undefined;
  Array.from(folderThumbnailCancellationWaiters).forEach(cancel => cancel());
  folderThumbnailCancellationWaiters.clear();
  Array.from(thumbnailRegenerationStates.entries()).forEach(([fileHash, state]) => {
    if (state.installing) {
      lingeringThumbnailInstallations.add(fileHash);
    }
    settleThumbnailRegeneration(
      fileHash,
      state.jobId,
      new Error('Thumbnail regeneration was cancelled.'),
    );
    state.cancelRunner?.();
  });
  activeThumbnailQueueRegenerationJobId = undefined;
  return true;
}

/** Stop the current folder batch using the same safe cancellation path. */
export function cancelFolderThumbnailRegeneration(): boolean {
  if (activeFolderThumbnailRegenerationJobId === undefined) {
    return false;
  }
  return cancelThumbnailRegeneration();
}

function withFolderThumbnailCancellation<T>(operation: Promise<T>, jobId: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      folderThumbnailCancellationWaiters.delete(cancel);
      callback();
    };
    const cancel = (): void => finish(() => reject(new Error('Folder thumbnail regeneration was cancelled.')));

    if (activeFolderThumbnailRegenerationJobId !== jobId) {
      cancel();
      return;
    }
    folderThumbnailCancellationWaiters.add(cancel);
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

/**
 * Recreate previews for every eligible video assigned to one configured
 * source folder. Jobs run sequentially to avoid overwhelming local or network
 * storage, and a queue reset cancels the batch before another item is queued.
 */
export async function regenerateFolderThumbnails(
  sourceIndex: number,
  relativePath: string,
  elements: ImageElement[],
  cataloguePath: string,
  onProgress?: (progress: FolderThumbnailRegenerationProgress) => void,
  stillOwned?: () => boolean,
): Promise<FolderThumbnailRegenerationResult> {
  if (thumbnailRegenerationBlocked) {
    throw new Error('The catalogue is changing. Wait before regenerating thumbnails.');
  }
  if (activeFolderThumbnailRegenerationJobId !== undefined) {
    throw new Error('Another folder thumbnail regeneration is already in progress.');
  }
  if (thumbnailRegenerationStates.size > 0) {
    throw new Error('Wait for the current thumbnail regeneration to finish.');
  }

  const sourceFolder = GLOBALS.selectedSourceFolders[sourceIndex];
  const normalizedRelativePath = normalizeSourceFolderRelativePath(relativePath);
  if (
    !Number.isInteger(sourceIndex)
    || !sourceFolder
    || !sourceFolder.path
    || !Array.isArray(elements)
    || cataloguePath !== GLOBALS.currentlyOpenVhaFile
  ) {
    throw new Error('The selected source folder is not available.');
  }

  const authorizedSourcePath = requireAuthorizedSourceRoot(
    sourceFolder.path,
    Array.from(GLOBALS.authorizedSourceFolderPaths),
    GLOBALS.authorizedSourceFolderRealPaths,
  );

  const sourceScopePath = resolveExistingSourceSubfolder(
    authorizedSourcePath,
    normalizedRelativePath,
  );
  const plan = planFolderThumbnailRegeneration(
    elements,
    sourceIndex,
    normalizedRelativePath,
  );
  if (plan.targets.length === 0) {
    return {
      cancelled: false,
      completed: 0,
      failed: 0,
      skippedVideos: plan.skippedVideos,
      succeeded: 0,
      total: 0,
      videoCount: plan.videoCount,
    };
  }

  const batchGeneration = folderThumbnailRegenerationGeneration;
  const jobId = nextFolderThumbnailRegenerationJobId++;
  const sourcePath = authorizedSourcePath;
  let sourceUnavailable = false;
  activeFolderThumbnailRegenerationJobId = jobId;

  const shouldCancel = (): boolean => {
    const currentSourceFolder = GLOBALS.selectedSourceFolders[sourceIndex];
    return batchGeneration !== folderThumbnailRegenerationGeneration
      || activeFolderThumbnailRegenerationJobId !== jobId
      || sourceUnavailable
      || cataloguePath !== GLOBALS.currentlyOpenVhaFile
      || (stillOwned && !stillOwned())
      || !currentSourceFolder
      || currentSourceFolder.path !== sourcePath;
  };

  const regenerateFirstAvailableCandidate = async (candidates: ImageElement[]): Promise<number> => {
    try {
      await withFolderThumbnailCancellation(
        fs.promises.access(sourceScopePath, fs.constants.R_OK),
        jobId,
      );
    } catch (error) {
      sourceUnavailable = true;
      throw error;
    }

    let lastError: Error = new Error('No accessible media file was found for this preview hash.');
    for (const candidate of candidates) {
      if (shouldCancel()) {
        throw new Error('Folder thumbnail regeneration was cancelled.');
      }
      try {
        resolveExistingMediaPath(sourcePath, candidate.partialPath, candidate.fileName);
      } catch (error) {
        lastError = error instanceof Error ? error : lastError;
        continue;
      }

      try {
        return await regenerateThumbnails(candidate, jobId, stillOwned);
      } catch (error) {
        lastError = error instanceof Error ? error : lastError;
        if (shouldCancel()) {
          throw lastError;
        }
      }
    }
    throw lastError;
  };

  try {
    const candidateGroups = Array.from(plan.candidatesByHash.values());
    const result = await runSequentialBatch(
      candidateGroups,
      regenerateFirstAvailableCandidate,
      shouldCancel,
      progress => onProgress?.({
        completed: progress.completed,
        failed: progress.failed,
        fileHash: progress.outcome.item[0].hash,
        screenshotCount: progress.outcome.result,
        succeeded: progress.succeeded,
        success: progress.outcome.succeeded,
        total: progress.total,
      }),
    );

    return {
      cancelled: result.cancelled,
      completed: result.completed,
      failed: result.failed,
      skippedVideos: plan.skippedVideos,
      succeeded: result.succeeded,
      total: result.total,
      videoCount: plan.videoCount,
    };
  } finally {
    if (activeFolderThumbnailRegenerationJobId === jobId) {
      activeFolderThumbnailRegenerationJobId = undefined;
    }
  }
}

/**
 * !!! WARNING !!! THIS FUNCTION WILL DELETE STUFF !!!
 *
 * Scan the provided directory and delete any file not in `hashesPresent`
 * @param hashesPresent
 * @param outputDirectory
 * @param assetDirectory
 */
export async function removeThumbnailsNotInHub(
  hashesPresent: ReadonlyMap<string, 1>,
  outputDirectory: string,
  assetDirectory: string,
  shouldContinue: () => boolean = (): boolean => true,
  shouldDeleteHash: (hash: string) => boolean = (hash: string): boolean => !hashesPresent.has(hash),
): Promise<boolean> {
  const canonicalAssetDirectory = resolveCanonicalTheatrumAssetDirectory(
    outputDirectory,
    assetDirectory,
  );
  if (!canonicalAssetDirectory) {
    console.warn('Skipped preview cleanup outside the active catalogue assets.');
    return false;
  }
  let numberOfThumbsDeleted = 0;
  for (const previewDirectoryName of Array.from(PREVIEW_ASSET_DIRECTORIES)) {
    if (!shouldContinue()) {
      return false;
    }
    const previewDirectory = path.join(canonicalAssetDirectory, previewDirectoryName);
    let canonicalPreviewDirectory: string;
    try {
      await fs.promises.access(previewDirectory);
      canonicalPreviewDirectory = resolveCanonicalTheatrumExistingAssetPath(
        previewDirectory,
        outputDirectory,
        assetDirectory,
      ) as string;
      if (
        !canonicalPreviewDirectory
        || !sameFilesystemPath(canonicalPreviewDirectory, previewDirectory)
        || !fs.statSync(canonicalPreviewDirectory).isDirectory()
      ) {
        console.warn('Skipped an invalid generated-preview directory:', previewDirectory);
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      console.warn('Unable to open a generated-preview directory for cleanup:', error);
      return false;
    }

    try {
      const directory = await fs.promises.opendir(canonicalPreviewDirectory);
      for await (const entry of directory) {
        if (!shouldContinue()) {
          return false;
        }
        if (!entry.isFile() || path.basename(entry.name) !== entry.name) {
          continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (
          previewDirectoryName === 'clips'
            ? !['.jpg', '.mp4'].includes(extension)
            : extension !== '.jpg'
        ) {
          continue;
        }
        const fileNameHash = path.parse(entry.name).name;
        if (hashesPresent.has(fileNameHash)) {
          continue;
        }
        const task: PreviewDeletionTask = {
          assetDirectory,
          canonicalAssetDirectory,
          outputDirectory,
          pathToFile: path.join(canonicalPreviewDirectory, entry.name),
        };
        if (await deletePreviewCleanupTask(task, shouldDeleteHash)) {
          numberOfThumbsDeleted++;
        }
      }
    } catch (error) {
      console.warn('Unable to enumerate generated previews for cleanup:', error);
      return false;
    }
  }

  if (!shouldContinue()) {
    return false;
  }
  if (GLOBALS.angularApp?.sender && !GLOBALS.angularApp.sender.isDestroyed()) {
    GLOBALS.angularApp.sender.send('number-of-screenshots-deleted', numberOfThumbsDeleted);
  }
  return true;
}

async function deletePreviewCleanupTask(
  task: PreviewDeletionTask,
  shouldDeleteHash: (hash: string) => boolean,
): Promise<boolean> {
  const activeAssetDirectory = resolveTheatrumAssetDirectory(
    GLOBALS.selectedOutputFolder,
    GLOBALS.hubName,
  );
  const activeCanonicalAssetDirectory = activeAssetDirectory && resolveCanonicalTheatrumAssetDirectory(
    GLOBALS.selectedOutputFolder,
    activeAssetDirectory,
  );
  if (
    !activeCanonicalAssetDirectory
    || !sameFilesystemPath(activeCanonicalAssetDirectory, task.canonicalAssetDirectory)
  ) {
    return false;
  }

  const canonicalPathToFile = resolveCanonicalTheatrumExistingAssetPath(
    task.pathToFile,
    task.outputDirectory,
    task.assetDirectory,
  );
  if (!canonicalPathToFile || !isInsideDirectory(task.canonicalAssetDirectory, canonicalPathToFile)) {
    console.warn('Skipped a queued preview cleanup target outside the active catalogue assets.');
    return false;
  }
  const relativePath = path.relative(task.canonicalAssetDirectory, canonicalPathToFile);
  const pathSegments = relativePath.split(path.sep);
  const [assetDirectoryName, fileName] = pathSegments;
  const extension = path.extname(fileName || '').toLowerCase();
  if (
    pathSegments.length !== 2
    || !PREVIEW_ASSET_DIRECTORIES.has(assetDirectoryName)
    || !fileName
    || path.basename(fileName) !== fileName
    || (assetDirectoryName === 'clips' ? !['.jpg', '.mp4'].includes(extension) : extension !== '.jpg')
  ) {
    return false;
  }
  const fileNameHash = path.parse(fileName).name;
  if (!shouldDeleteHash(fileNameHash)) {
    return false;
  }

  console.log('deleting:', canonicalPathToFile);
  try {
    await fs.promises.unlink(canonicalPathToFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Unable to delete a stale generated preview:', error);
    }
    return false;
  }
}

/**
 * Prevent PC from going to sleep during screenshot extraction
 */
export function preventSleep(): void {
  console.log('preventing sleep');
  if (preventSleepIds.length > 0) {
    return;
  }
  preventSleepIds.push(powerSaveBlocker.start('prevent-app-suspension'));
}

/**
 * Allow PC to go to sleep after screenshots were extracted
 */
function allowSleep(): void {
  console.log('allowing sleep');
  if (preventSleepIds.length) {
    preventSleepIds.forEach((id: number) => {
      powerSaveBlocker.stop(id);
    });
  }
  preventSleepIds = [];
}

function logPerformance(message: string, initial: number): void {
  console.log(message + Math.round((performance.now() - initial) / 100) / 10 + ' seconds.');
}
