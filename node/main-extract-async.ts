// async & chokidar Code written by Cal2195
// Was originally added to `main-extract.ts` but was moved here for clarity

const { nativeImage, powerSaveBlocker } = require('electron');
const async = require('async');
const chokidar = require('chokidar');
import * as path from 'path';
import type { FSWatcher } from 'chokidar'; // probably the correct type for chokidar.watch() object
const fs = require('fs');
import { fdir } from 'fdir';

import { GLOBALS } from './main-globals';

import type {
  ImageElement,
  ImageElementPlus,
  ScreenshotSettings,
} from '../interfaces/final-object.interface';
import { acceptableFiles } from './main-filenames';
import { extractAll, isExpectedJpeg } from './main-extract';
import type { SystemThumbnailCreator } from './main-extract';
import { sendCurrentProgress, insertTemporaryFieldsSingle, extractMetadataAsync, cleanUpFileName } from './main-support';
import {
  createImportErrorElement,
  runProbeWithOneRetry,
  shouldExtractThumbnails,
} from './media-import-resilience';
import {
  isActiveThumbnailRegenerationJob,
  planFolderThumbnailRegeneration,
  prepareThumbnailRegeneration,
} from './thumbnail-count';
import type { ThumbnailCoreStatus } from './thumbnail-count';
import { runSequentialBatch } from './sequential-batch';
import { resolveExistingMediaPath } from './local-operation-safety';
import {
  beginPreviewTransaction,
  markPreviewTransactionCommitted,
} from './thumbnail-transaction';

export interface TempMetadataQueueObject {
  fullPath: string;
  inputSource: number;
  name: string;
  partialPath: string;
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

interface ThumbnailRegenerationState {
  folderBatchJobId?: number;
  generation: number;
  installing: boolean;
  jobId: number;
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

const thumbnailRegenerationStates: Map<string, ThumbnailRegenerationState> = new Map();
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
let folderThumbnailRegenerationGeneration = 0;
let nextFolderThumbnailRegenerationJobId = 1;
let thumbnailRegenerationBlocked = false;

export interface FolderThumbnailRegenerationProgress {
  completed: number;
  failed: number;
  fileHash: string;
  screenshotCount?: number;
  succeeded: number;
  success: boolean;
  total: number;
}

export interface FolderThumbnailRegenerationResult {
  cancelled: boolean;
  completed: number;
  failed: number;
  skippedVideos: number;
  succeeded: number;
  total: number;
  videoCount: number;
}

// delete queue
let deleteThumbQueue;   // QueueObject
let numberOfThumbsDeleted = 0;

// =====================================================================================================================

// Create maps where the value = 1 always.
// It is faster to check if key exists than searching through an array.
let alreadyInAngular: Map<string, 1> = new Map(); // full paths to videos we have metadata for in Angular
let failedMetadataPaths: Set<string> = new Set();
let pendingMetadataPaths: Set<string> = new Set();

// These two are together:
const watcherMap:       Map<number, FSWatcher> = new Map();
let allFoundFilesMap: Map<number, Map<string, 1>> = new Map();
// both these numbers     ^^^^^^ match up - they refer to the same `inputSource`

// =====================================================================================================================

// Miscellaneous
let preventSleepIds: number[] = []; // prevent and allow sleep
let importCompletionSent = false;

// =====================================================================================================================

resetAllQueues();

/**
 * Reset all three queues:
 *  - Meta queue
 *  - Thumb queue
 *  - Delet queue
 */
export function resetAllQueues(): void {

  allowSleep();
  folderThumbnailRegenerationGeneration++;

  Array.from(thumbnailRegenerationStates.entries()).forEach(([fileHash, state]) => {
    if (state.jobId === activeThumbnailQueueRegenerationJobId) {
      return;
    }
    settleThumbnailRegeneration(
      fileHash,
      state.jobId,
      new Error('Thumbnail regeneration was cancelled.'),
    );
  });

  // kill all previeous
  if (thumbQueue && typeof thumbQueue.kill === 'function') {
    thumbQueue.kill();
  }
  if (metadataQueue && typeof metadataQueue.kill === 'function') {
    metadataQueue.kill();
  }
  if (deleteThumbQueue && typeof deleteThumbQueue.kill === 'function') {
    deleteThumbQueue.kill();
  }

  // Meta queue ========================================================================================================
  metaDone = 0;
  metaExtractionStartTime = 0;
  pendingMetadataPaths = new Set();
  failedMetadataPaths = new Set();
  importCompletionSent = false;

  metadataQueue = async.queue(metadataQueueRunner, 1); // 1 is the number of parallel worker functions
                                                       // ^--- experiment with numbers to see what is fastest (try 8)

  metadataQueue.drain(() => {

    thumbQueue.resume();

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

  // Delete queue ======================================================================================================
  deleteThumbQueue = async.queue(deleteThumbQueueRunner, 1);

  deleteThumbQueue.drain(() => {
    console.log('all screenshots now deleted');
    GLOBALS.angularApp.sender.send('number-of-screenshots-deleted', numberOfThumbsDeleted);
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
  if (pendingMetadataPaths.has(file.fullPath)) {
    return;
  }
  pendingMetadataPaths.add(file.fullPath);
  importCompletionSent = false;
  metadataQueue.push(file);
}

/**
 * Extraction queue runner
 * Runs for every element in the `thumbQueue`
 * @param element -- ImageElement to extract screenshots for
 * @param done    -- callback to indicate the current extraction finished
 */
function thumbQueueRunner(element: ThumbnailQueueElement, done): void {
  const regenerationState = thumbnailRegenerationStates.get(element.hash);
  const hasRegenerationMarker = element.thumbnailRegenerationJobId !== undefined;
  const isRegenerationJob: boolean = Boolean(regenerationState && isActiveThumbnailRegenerationJob(
    element.thumbnailRegenerationJobId,
    regenerationState.jobId,
  ));
  if (hasRegenerationMarker && !isRegenerationJob) {
    done();
    return;
  }
  const screenshotOutputFolder: string = isRegenerationJob
    ? regenerationState.screenshotOutputFolder
    : path.join(GLOBALS.selectedOutputFolder, 'vha-' + GLOBALS.hubName);
  const screenshotSettings: ScreenshotSettings = isRegenerationJob
    ? regenerationState.screenshotSettings
    : GLOBALS.screenshotSettings;
  const sourcePath: string = isRegenerationJob
    ? regenerationState.sourcePath
    : GLOBALS.selectedSourceFolders[element.inputSource].path;
  const shouldExtractClips: boolean = screenshotSettings.clipSnippets > 0;
  if (isRegenerationJob) {
    activeThumbnailQueueRegenerationJobId = regenerationState.jobId;
  }

  const finishRunner = (): void => {
    if (isRegenerationJob && activeThumbnailQueueRegenerationJobId === regenerationState.jobId) {
      activeThumbnailQueueRegenerationJobId = undefined;
    }
    done();
  };

  const regenerationStillCurrent = (): boolean => {
    if (!isRegenerationJob) {
      return true;
    }
    const currentState = thumbnailRegenerationStates.get(element.hash);
    return currentState?.jobId === regenerationState.jobId
      && regenerationState.generation === folderThumbnailRegenerationGeneration
      && (!regenerationState.stillOwned || regenerationState.stillOwned());
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
        await removeRegenerationStagingFolder(generatedOutputFolder);
        finishRunner();
      }
    };

    void completeRegeneration();
  };

  const extractQueueItem = (generatedOutputFolder: string = screenshotOutputFolder): void => {
    sendCurrentProgress( // TODO check whether sending data off by 1
      thumbsDone,
      thumbsDone + thumbQueue.length() + 1,
      'importingScreenshots'
    );
    thumbsDone++;

    extractAll(
      element,
      sourcePath,
      generatedOutputFolder,
      screenshotSettings,
      (success: boolean, error?: Error) => finishQueueItem(generatedOutputFolder, success, error),
      createSystemThumbnail,
    );
  };

  if (isRegenerationJob) {
    const stagingFolder = path.join(
      screenshotOutputFolder,
      '.thumbnail-regeneration',
      `${element.hash}-${process.pid}-${Date.now()}-${regenerationState.jobId}`,
    );
    prepareRegenerationStagingFolder(stagingFolder)
      .then(() => {
        if (!regenerationStillCurrent()) {
          throw new Error('Thumbnail regeneration was cancelled.');
        }
        extractQueueItem(stagingFolder);
      })
      .catch((error: Error) => {
        settleThumbnailRegeneration(element.hash, regenerationState.jobId, error);
        void removeRegenerationStagingFolder(stagingFolder).finally(finishRunner);
      });
    return;
  }

  hasAllThumbs(element, screenshotOutputFolder, screenshotSettings, shouldExtractClips)
    .then(() => {
      finishQueueItem(screenshotOutputFolder, true);
    })
    .catch(() => {
      extractQueueItem();
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

async function prepareRegenerationStagingFolder(stagingFolder: string): Promise<void> {
  await fs.promises.rm(stagingFolder, { force: true, recursive: true });
  await Promise.all([
    fs.promises.mkdir(path.join(stagingFolder, 'thumbnails'), { recursive: true }),
    fs.promises.mkdir(path.join(stagingFolder, 'filmstrips'), { recursive: true }),
    fs.promises.mkdir(path.join(stagingFolder, 'clips'), { recursive: true }),
  ]);
}

async function removeRegenerationStagingFolder(stagingFolder: string): Promise<void> {
  try {
    await fs.promises.rm(stagingFolder, { force: true, recursive: true });
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
  includeGeneratedClips: boolean,
  shouldContinue: () => boolean,
): Promise<void> {
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
    stagingFolder,
    screenshotOutputFolder,
    desiredRelativePaths,
    backupSuffix,
  );

  try {
    requireCurrentJob();
    for (const relativePath of desiredRelativePaths) {
      const original = path.join(screenshotOutputFolder, relativePath);
      const backup = original + backupSuffix;
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
      const generated = path.join(stagingFolder, relativePath);
      const original = path.join(screenshotOutputFolder, relativePath);
      await fs.promises.rename(generated, original);
      installed.push(original);
      requireCurrentJob();
    }
    requireCurrentJob();
    await markPreviewTransactionCommitted(stagingFolder, transactionManifest);
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
function sendNewVideoMetadata(imageElement: ImageElementPlus): void {

  alreadyInAngular.set(imageElement.fullPath, 1);

  if (shouldExtractThumbnails(imageElement)) {
    failedMetadataPaths.delete(imageElement.fullPath);
  } else {
    failedMetadataPaths.add(imageElement.fullPath);
  }

  delete imageElement.fullPath; // downgrade to `ImageElement` from `ImageElementPlus`

  const elementForAngular = insertTemporaryFieldsSingle(imageElement);
  GLOBALS.angularApp.sender.send('new-video-meta', elementForAngular);

  if (shouldExtractThumbnails(imageElement)) {
    if (thumbExtractionStartTime === 0) {
      thumbExtractionStartTime = performance.now();
    }
    thumbQueue.push(imageElement);
  }
}

/**
 * Create empty element, extract and update metadata, send over to Angular
 * @param fileInfo - various stat metadata about the file
 * @param done
 */
export function metadataQueueRunner(file: TempMetadataQueueObject, done): void {

  if (metaExtractionStartTime === 0) {
    metaExtractionStartTime = performance.now();
  }

  if (GLOBALS.demo && alreadyInAngular.size >= 50) {
    console.log(' - DEMO LIMIT REACHED - CANCELING SCAN !!!');
    sendCurrentProgress(50, 50, 'done');
    metadataQueue.kill();
    thumbQueue.resume();
    return;
  }

  sendCurrentProgress(metaDone, metaDone + metadataQueue.length() + 1, 'importingMeta');
  metaDone++;

  runProbeWithOneRetry(
    file.fullPath,
    () => extractMetadataAsync(file.fullPath, GLOBALS.screenshotSettings),
  )
    .catch((probeError) => {
      console.warn('Metadata probe failed; adding path-only catalogue entry:', file.fullPath, probeError);
      return createImportErrorElement(file.fullPath);
    })
    .then((imageElement: ImageElementPlus) => {
      imageElement.cleanName = cleanUpFileName(file.name);
      imageElement.fileName = file.name;
      imageElement.fullPath = file.fullPath; // insert this converting `ImageElement` to `ImageElementPlus`
      imageElement.inputSource = file.inputSource;
      imageElement.partialPath = file.partialPath;
      sendNewVideoMetadata(imageElement);
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
 * Use `fdir` to quickly generate file list and add it to `metadataQueue`
 * @param inputDir    -- full path to the input folder
 * @param inputSource -- the number corresponding to the `inputSource` in ImageElement -- must be set!
 */
function superFastSystemScan(inputDir: string, inputSource: number): void {

  GLOBALS.angularApp.sender.send('started-watching-this-dir', inputSource);

  metadataQueue.pause();
  thumbQueue.pause();

  const crawler = new fdir()
    .exclude((dir: string) => dir.startsWith('vha-')) // .exclude `dir` is the folder name, not full path
    .withFullPaths()
    .crawl(inputDir);

  const t0 = performance.now(); // LOGGING

  crawler.withPromise().then((files: string[]) => {

    // LOGGING =====================================================================================
    logPerformance('scan took ', t0);
    console.log('Found ', files.length, ' files in given directory');
    // =============================================================================================

    const allAcceptableFiles: string[] = [...acceptableFiles, ...GLOBALS.additionalExtensions];

    files.forEach((fullPath: string) => {

      const parsed = path.parse(fullPath);

      if (!allAcceptableFiles.includes(parsed.ext.substr(1).toLowerCase())) {
        return;
      }

      if (!allFoundFilesMap.has(inputSource)) {
        allFoundFilesMap.set(inputSource, new Map());
      }
      allFoundFilesMap.get(inputSource).set(fullPath, 1);

      if (alreadyInAngular.has(fullPath) && !failedMetadataPaths.has(fullPath)) {
        return;
      }

      const partial: string = path.relative(inputDir, parsed.dir).replace(/\\/g, '/');

      const newItem: TempMetadataQueueObject = {
        fullPath: fullPath,
        inputSource: inputSource,
        name: parsed.base,
        partialPath: '/' + partial,
      };

      enqueueMetadata(newItem);

    });

    GLOBALS.angularApp.sender.send('all-files-found-in-dir', inputSource, allFoundFilesMap.get(inputSource));

    metadataQueue.resume();

  });

}

/**
 * Create a new `chokidar` watcher for a particular directory
 * @param inputDir    -- full path to input folder
 * @param inputSource -- the number corresponding to the `inputSource` in ImageElement -- must be set!
 * @param persistent  -- whether to continue watching after the initial scan
 */
export function startFileSystemWatching(inputDir: string, inputSource: number, persistent: boolean): void {

  // only run `chokidar` if `persistent`
  if (!persistent) {
    superFastSystemScan(inputDir, inputSource);
    return;
  }

  const t0 = performance.now();

  console.log('================================================================');
  console.log('SHOULD ONLY RUN ON PERSISTENT SCAN !!!');

  console.log('starting watcher ', inputSource, typeof(inputSource), inputDir);

  GLOBALS.angularApp.sender.send('started-watching-this-dir', inputSource);

  // WARNING - there are other ways to have a network address that are not accounted here !!!
  const isNetworkAddress: boolean =    inputDir.startsWith('//')
                                    || inputDir.startsWith('\\\\');

  const watcherConfig = {
    awaitWriteFinish: {
      pollInterval: 1000,
      stabilityThreshold: 5000,
    },
    cwd: inputDir,
    disableGlobbing: true,
    ignored: 'vha-*', // WARNING - dangerously ignores any path that includes `vha-` anywhere!!!
    persistent: true, // NOTE: if `!persistent` we use `superFastSystemScan()` instead !!!
    usePolling: isNetworkAddress ? true : false,
  };

  const watcher: FSWatcher = chokidar.watch(inputDir, watcherConfig);

  const allAcceptableFiles: string[] = [...acceptableFiles, ...GLOBALS.additionalExtensions];

  metadataQueue.pause();
  thumbQueue.pause();

  watcher
    .on('add', (filePath: string) => {

      const ext = filePath.substring(filePath.lastIndexOf('.') + 1).toLowerCase();

      if (!allAcceptableFiles.includes(ext)) {
        return;
      }

      const subPath = ('/' + filePath.replace(/\\/g, '/')).replace('//', '/');
      const partialPath = subPath.substring(0, subPath.lastIndexOf('/'));
      const fileName = subPath.substring(subPath.lastIndexOf('/') + 1);
      const fullPath = path.join(inputDir, partialPath, fileName);

      if (!allFoundFilesMap.has(inputSource)) {
        allFoundFilesMap.set(inputSource, new Map());
      }
      allFoundFilesMap.get(inputSource).set(fullPath, 1);

      if (alreadyInAngular.has(fullPath) && !failedMetadataPaths.has(fullPath)) {
        return;
      }

      const newItem: TempMetadataQueueObject = {
        fullPath: fullPath,
        inputSource: inputSource,
        name: fileName,
        partialPath: partialPath,
      };

      enqueueMetadata(newItem);
    })
    .on('change', (filePath: string) => {
      const subPath = ('/' + filePath.replace(/\\/g, '/')).replace('//', '/');
      const partialPath = subPath.substring(0, subPath.lastIndexOf('/'));
      const fileName = subPath.substring(subPath.lastIndexOf('/') + 1);
      const fullPath = path.join(inputDir, partialPath, fileName);

      if (!failedMetadataPaths.has(fullPath)) {
        return;
      }

      enqueueMetadata({
        fullPath,
        inputSource,
        name: fileName,
        partialPath,
      });
    })
    .on('unlink', (partialFilePath: string) => {    // note: this happens even when file is renamed!
      console.log(' !!! FILE DELETED, updating Angular:', partialFilePath);
      GLOBALS.angularApp.sender.send('single-file-deleted', inputSource, partialFilePath);
      // remove element from `alreadyInAngular`
      const basePath: string = GLOBALS.selectedSourceFolders[inputSource].path;
      const fullPath = path.join(basePath, partialFilePath);
      alreadyInAngular.delete(fullPath);
      failedMetadataPaths.delete(fullPath);
      pendingMetadataPaths.delete(fullPath);
      // note: there is no need to watch for `unlinkDir` since `unlink` fires for every file anyway!
    })
    .on('ready', () => {
      console.log('Finished scanning', inputSource);

      metadataQueue.resume();

      GLOBALS.angularApp.sender.send('all-files-found-in-dir', inputSource, allFoundFilesMap.get(inputSource));

      if (persistent) {
        console.log('^^^^^^^^ - CONTINUING to watch this directory!');
      } else {
        console.log('^^^^^^^^ - stopping watching this directory');
        watcher.close();  // chokidar seems to disregard `persistent` when `fsevents` is not enabled
      }

      logPerformance('Chokidar took ', t0);
    });

  watcherMap.set(inputSource, watcher);
}

/**
 * Close out all the wathers
 * reset the alreadyInAngular
 * @param finalArray
 */
export function resetWatchers(finalArray: ImageElement[]): void {

  // close every old watcher
  Array.from(watcherMap.keys()).forEach((key: number) => {
    closeWatcher(key);
  });

  alreadyInAngular = new Map();
  failedMetadataPaths = new Set();
  pendingMetadataPaths = new Set();

  allFoundFilesMap = new Map();

  finalArray.forEach((element: ImageElement) => {
    const fullPath: string = path.join(
      GLOBALS.selectedSourceFolders[element.inputSource].path,
      element.partialPath,
      element.fileName
    );

    alreadyInAngular.set(fullPath, 1);
    if (!shouldExtractThumbnails(element)) {
      failedMetadataPaths.add(fullPath);
    }
  });
}

/**
 * Close the old watcher
 * happens when opening a new hub (or user toggles the `watch` near folder)
 * @param inputSource
 */
export function closeWatcher(inputSource: number): void {
  console.log('stop watching', inputSource);
  if (watcherMap.has(inputSource)) {
    console.log('closing ', inputSource);
    watcherMap.get(inputSource).close().then(() => {
      console.log(inputSource, ' closed!');
      // do nothing
    });
  }
}

/**
 * Start old watcher
 * happens when user toggles the `watch` near folder
 * @param inputSource
 * @param folderPath
 */
export function startWatcher(inputSource: number, folderPath: string, persistent: boolean): void {
  console.log('start watching !!!!', inputSource, typeof(inputSource), folderPath, persistent);

  GLOBALS.selectedSourceFolders[inputSource] = {
    path: folderPath,
    watch: persistent,
  };

  preventSleep();
  startFileSystemWatching(folderPath, inputSource, persistent);
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
  fullArray.forEach((element: ImageElement) => {
    if (shouldExtractThumbnails(element)) {
      importCompletionSent = false;
      thumbQueue.push(element);
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
      folderBatchJobId,
      generation: folderThumbnailRegenerationGeneration,
      installing: false,
      jobId,
      screenshotCount: regenerationElement.screens,
      screenshotOutputFolder: path.join(GLOBALS.selectedOutputFolder, 'vha-' + GLOBALS.hubName),
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
 * Stop scheduling folder jobs immediately. An in-flight extraction is left in
 * its isolated staging directory; the generation fence prevents it from ever
 * replacing live previews when it eventually exits.
 */
export function cancelFolderThumbnailRegeneration(): boolean {
  if (activeFolderThumbnailRegenerationJobId === undefined) {
    return false;
  }

  folderThumbnailRegenerationGeneration++;
  Array.from(thumbnailRegenerationStates.entries()).forEach(([fileHash, state]) => {
    if (
      state.folderBatchJobId !== activeFolderThumbnailRegenerationJobId
      || state.jobId === activeThumbnailQueueRegenerationJobId
      || state.installing
    ) {
      return;
    }
    settleThumbnailRegeneration(
      fileHash,
      state.jobId,
      new Error('Folder thumbnail regeneration was cancelled.'),
    );
  });
  return true;
}

/**
 * Recreate previews for every eligible video assigned to one configured
 * source folder. Jobs run sequentially to avoid overwhelming local or network
 * storage, and a queue reset cancels the batch before another item is queued.
 */
export async function regenerateFolderThumbnails(
  sourceIndex: number,
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
  if (
    !Number.isInteger(sourceIndex)
    || !sourceFolder
    || !sourceFolder.path
    || !Array.isArray(elements)
    || cataloguePath !== GLOBALS.currentlyOpenVhaFile
  ) {
    throw new Error('The selected source folder is not available.');
  }

  const plan = planFolderThumbnailRegeneration(elements, sourceIndex);
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
  const sourcePath = sourceFolder.path;
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
      await fs.promises.access(sourcePath, fs.constants.R_OK);
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
 * @param directory
 */
export function removeThumbnailsNotInHub(hashesPresent: Map<string, 1>, directory: string): void {

  deleteThumbQueue.pause();
  numberOfThumbsDeleted = 0;

  const crawler = new fdir()
    .withFullPaths()
    .filter((file: string) => {
      const  it: string = file.toLowerCase();
      return it.endsWith('.jpg') || it.endsWith('.mp4');
    })
    .crawl(directory);

  crawler.withPromise().then((files: string[]) => {

    files.forEach((file: string) => {
      const parsedPath = path.parse(file);
      const fileNameHash = parsedPath.name;

      if (!hashesPresent.has(fileNameHash)) {
        deleteThumbQueue.push(file);
        numberOfThumbsDeleted++;
      }
    });

    if (numberOfThumbsDeleted === 0) {
      GLOBALS.angularApp.sender.send('number-of-screenshots-deleted', 0);
    } else {
      deleteThumbQueue.resume(); // else only send message after the delete queue is finished
    }

  });

}

function deleteThumbQueueRunner(pathToFile: string, done): void {
  console.log('deleting:', pathToFile);

  fs.unlink(pathToFile, (err) => {
    done();
  });
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
