/**
 * This file contains all the logic for extracting:
 * first thumbnail,
 * full filmstrip,
 * the preview clip
 * the clip's first thumbnail
 *
 * All functions are PURE
 *
 * Huge thank you to cal2195 for the code contribution
 * He implemented the efficient filmstrip and clip extraction!
 */

// ========================================================================================
//          Imports
// ========================================================================================

// cool method to disable all console.log statements!
// console.log('console.log disabled in main-extract.ts');
// console.log = function() {};

// const { performance } = require('perf_hooks');  // for logging time taken during debug

const fs = require('fs');
import * as os from 'os';
import * as path from 'path';
const spawn = require('child_process').spawn;

const CUSTOM_THUMBNAIL_TIMEOUT_MS = 30 * 1000;
// Two independent seeks are enough to approach the measured QD1-QD8 gain on
// the user's network volume without returning to the former one-decoder-per-
// frame allocation spike.
export const FILMSTRIP_FRAME_CONCURRENCY = 2;
const FORCE_KILL_DELAY_MS = 250;
const FORCE_SETTLE_DELAY_MS = 1000;
const FILMSTRIP_ASSEMBLY_RESERVE_MS = 15 * 1000;
const FILMSTRIP_RECOVERY_BUDGET_MS = 60 * 1000;
const MAX_FILMSTRIP_RECOVERY_FRAMES = 30;
const MAX_RECOVERY_FRAME_TIMEOUT_MS = 10 * 1000;
const MIN_FILMSTRIP_TIMEOUT_MS = 30 * 1000;
const MIN_THUMBNAIL_TIMEOUT_MS = 15 * 1000;
const SYSTEM_THUMBNAIL_REQUEST_TIMEOUT_MS = 15 * 1000;
const SYSTEM_THUMBNAIL_SCALE_TIMEOUT_MS = 10 * 1000;
const THUMBNAIL_RECOVERY_BUDGET_MS = 30 * 1000;

interface ActiveCustomImage {
  release: () => void;
  settled: Promise<void>;
}

const activeCustomImages = new Map<string, ActiveCustomImage>();
const activeMediaProcesses = new Set<any>();
let mediaProcessCancellationGeneration = 0;
const generatedImageVersions = new Map<string, number>();
const imagePublicationLocks = new Map<string, Promise<void>>();
let temporaryImageSequence = 0;

import { ffmpegPath } from './media-tool-paths';

import { GLOBALS } from './main-globals';

import type { ImageElement, ScreenshotSettings } from '../interfaces/final-object.interface';


// ========================================================================================
//          FFMPEG arg generating functions
// ========================================================================================

/**
 * Generate the ffmpeg args to extract a single frame according to settings
 * @param pathToVideo
 * @param screenshotHeight
 * @param duration
 * @param savePath
 */
export const extractSingleFrameArgs = (
  pathToVideo: string,
  screenshotHeight: number,
  duration: number,
  savePath: string,
): string[] => {

  const ssWidth: number = screenshotHeight * (16 / 9);

  const args: string[] = [
    '-ss', (duration / 10).toString(),
    '-i', pathToVideo,
    '-map', '0:V:0',
    '-frames', '1',
    '-q:v', '2',
    '-vf', scaleAndPadString(ssWidth, screenshotHeight),
    savePath,
  ];

  return args;
};

type RecoverySeekMode = 'fast' | 'scan';
export type SystemThumbnailCreator = (
  videoPath: string,
  width: number,
  height: number,
) => Promise<Buffer>;

export interface ThumbnailRecoveryOptions {
  createSystemThumbnail?: SystemThumbnailCreator;
  generationVersion?: number | null;
}

/**
 * Retry one frame with options that tolerate damaged packets and timestamps.
 * `scan` deliberately seeks after opening the input so a broken index cannot
 * prevent recovery; `fast` remains bounded for later points in long videos.
 */
export const extractRecoveryFrameArgs = (
  pathToVideo: string,
  screenshotHeight: number,
  timestamp: number,
  savePath: string,
  seekMode: RecoverySeekMode,
): string[] => {
  const ssWidth: number = screenshotHeight * (16 / 9);
  const args: string[] = [
    '-fflags', seekMode === 'scan' ? '+ignidx+genpts+discardcorrupt' : '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
  ];

  if (seekMode === 'fast') {
    args.push('-ss', timestamp.toString());
  }

  args.push('-i', pathToVideo);

  if (seekMode === 'scan') {
    args.push('-ss', timestamp.toString());
  }

  args.push(
    '-map', '0:V:0',
    '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-max_error_rate', '1.0',
    '-q:v', '2',
    '-vf', scaleAndPadString(ssWidth, screenshotHeight),
    '-y',
    savePath,
  );

  return args;
};

/**
 * Last FFmpeg fallback: allow the decoder to emit a concealed/damaged frame
 * that ordinary recovery would discard. The JPEG is still validated before
 * it can become a user-visible thumbnail.
 */
export const extractConcealedFrameArgs = (
  pathToVideo: string,
  screenshotHeight: number,
  savePath: string,
): string[] => {
  const ssWidth: number = screenshotHeight * (16 / 9);

  return [
    '-fflags', '+ignidx+genpts',
    '-err_detect', 'ignore_err',
    '-flags', '+output_corrupt',
    '-i', pathToVideo,
    '-map', '0:V:0',
    '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-max_error_rate', '1.0',
    '-q:v', '2',
    '-vf', scaleAndPadString(ssWidth, screenshotHeight),
    '-y',
    savePath,
  ];
};

/** Build one fixed-width strip from individually recovered JPEG frames. */
export const stackRecoveredFramesArgs = (
  framePaths: string[],
  savePath: string,
): string[] => {
  const args: string[] = [];
  let inputs = '';

  framePaths.forEach((framePath: string, index: number) => {
    args.push('-i', framePath);
    inputs += `[${index}:v]`;
  });

  args.push(
    '-frames:v', '1',
    '-filter_complex', `${inputs}hstack=inputs=${framePaths.length}`,
    '-q:v', '2',
    '-y',
    savePath,
  );

  return args;
};

/**
 * Take N screenshots of a particular file
 * at particular file size
 * save as particular fileHash
 * (if filmstrip not already present)
 *
 * @param pathToVideo          -- full path to the video file
 * @param duration             -- duration of clip
 * @param screenshotHeight     -- height of screenshot in pixels
 * @param numberOfScreenshots  -- number of screenshots to extract
 * @param savePath             -- full path to file name and extension
 */
export const generateScreenshotStripArgs = (
  pathToVideo: string,
  duration: number,
  screenshotHeight: number,
  numberOfScreenshots: number,
  savePath: string,
): string[] => {

  let current = 0;
  const totalCount = numberOfScreenshots;
  const step: number = duration / (totalCount + 1);
  const args: string[] = [];
  let allFramesFiltered = '';
  let outputFrames = '';

  // Hardcode a specific 16:9 ratio
  const ssWidth: number = screenshotHeight * (16 / 9);

  const fancyScaleFilter: string = scaleAndPadString(ssWidth, screenshotHeight);

  // make the magic filter
  while (current < totalCount) {
    const time = (current + 1) * step; // +1 so we don't pick the 0th frame
    args.push('-ss', time.toString(), '-i', pathToVideo);
    allFramesFiltered += '[' + current + ':V]' + fancyScaleFilter + '[' + current + '];';
    outputFrames += '[' + current + ']';
    current++;
  }
  args.push(
    '-frames', '1',
    '-filter_complex', allFramesFiltered + outputFrames + 'hstack=inputs=' + totalCount,
    savePath
  );

  return args;
};

/**
 * Generate the mp4 preview clip of the video file
 * (if clip is not already present)
 *
 * @param pathToVideo   -- full path to the video file
 * @param duration      -- duration of the original video file
 * @param clipHeight    -- height of clip
 * @param clipSnippets  -- number of clip snippets to extract
 * @param snippetLength -- length in seconds of each snippet
 * @param savePath      -- full path to file name and extension
 */
export const generatePreviewClipArgs = (
  pathToVideo: string,
  duration: number,
  clipHeight: number,
  clipSnippets: number,
  snippetLength: number,
  savePath: string,
): string[] => {

  let current = 1;
  const totalCount = clipSnippets;
  const step: number = duration / (totalCount + 1);
  const args: string[] = [];
  let concat = '';

  // make the magic filter
  while (current <= totalCount) {
    const time = current * step;
    const preview_duration = snippetLength;
    args.push('-ss', time.toString(), '-t', preview_duration.toString(), '-i', pathToVideo);
    concat += '[' + (current - 1) + ':V]' + '[' + (current - 1) + ':a]';
    current++;
  }

  concat += 'concat=n=' + totalCount + ':v=1:a=1[v][a];[v]scale=-2:' + clipHeight + '[v2]';
  args.push('-filter_complex',
            concat,
            '-map',
            '[v2]',
            '-map',
            '[a]',
            savePath);
  // phfff glad that's over

  return args;
};

/**
 * Extract the first frame from the preview clip
 *
 * @param pathToClip -- full path to where the .mp4 clip is located
 * @param fileHash   -- full path to where the .jpg should be saved
 */
export const extractFirstFrameArgs = (
  pathToClip: string,
  pathToThumb: string
): string[] => {

  const args: string[] = [
    '-ss', '0',
    '-i', pathToClip,
    '-frames', '1',
    '-f', 'image2',
    pathToThumb,
  ];

  return args;
};

// ========================================================================================
//          Extraction engine
// ========================================================================================

/**
 * Extract thumbnail, filmstrip, and possibly clip
 *
 * Extract following this order. Each stage returns a boolean
 * (^) means RESTART -- go back to (1) with the next item-to-extract on the list
 *
 * SOURCE FILE ============================
 *   (1) check if input file exists
 *         T:                           (2)
 *         F:                           (^) restart
 * THUMB ==================================
 *   (2) check thumb exists
 *         T:                           (4)
 *         F:                           (3)
 *   (3) extract the SINGLE screenshot
 *         T:                           (4)
 *         F:                           (^) restart - assume corrupt
 * FILMSTRIP ==============================
 *   (4) check filmstrip exists
 *         T:                           (6)
 *         F:                           (5)
 *   (5) extract the FILMSTRIP
 *         T: (clipSnippets === 0) ?
 *             T:   nothing to do       (^) restart
 *             F:                       (6)
 *         F:                           (^) restart - assume corrupt
 * CLIP ===================================
 *   (6) check clip exists
 *         T:                           (8)
 *         F:                           (7)
 *   (7) extract the CLIP
 *         T:                           (8)
 *         F:                           (^) restart - assume corrupt
 * CLIP THUMB =============================
 *   (8) check clip thumb exists
 *         T:                           (^) restart
 *         F:                           (9)
 *   (9) extract the CLIP preview
 *         T:                           (^) restart
 *         F:                           (^) restart
 *
 * @param currentElement     -- ImageElement to extract thumbs
 * @param videoFolderPath    -- path to base folder where videos are
 * @param screenshotFolder   -- path to folder where .jpg files will be saved
 * @param screenshotSettings -- ScreenshotSettings object
 * @param done               -- execute this method when done extracting
 */
export function extractAll(
  currentElement: ImageElement,
  videoFolderPath: string,
  screenshotFolder: string,
  screenshotSettings: ScreenshotSettings,
  done: (success: boolean, error?: Error) => void,
  createSystemThumbnail?: SystemThumbnailCreator,
): void {

  const clipHeight:       number = screenshotSettings.clipHeight;        // -- number in px how tall each clip should be
  const clipSnippets:     number = screenshotSettings.clipSnippets;      // -- number of clip snippets to extract; 0 == do not extract clip
  const screenshotHeight: number = screenshotSettings.height;            // -- number in px how tall each screenshot should be
  const snippetLength:    number = screenshotSettings.clipSnippetLength; // -- length of each snippet in the clip

  const pathToVideo: string = path.join(videoFolderPath, currentElement.partialPath, currentElement.fileName);

  const duration:     number = currentElement.duration;
  const fileHash:     string = currentElement.hash;
  const numOfScreens: number = currentElement.screens;
  const sourceHeight: number = currentElement.height;

  const thumbnailSavePath: string = path.normalize(screenshotFolder + '/thumbnails/' + fileHash + '.jpg');
  const filmstripSavePath: string = path.normalize(screenshotFolder + '/filmstrips/' + fileHash + '.jpg');
  const clipSavePath:      string = path.normalize(screenshotFolder + '/clips/' +      fileHash + '.mp4');
  const clipThumbSavePath: string = path.normalize(screenshotFolder + '/clips/' +      fileHash + '.jpg');
  const screenshotWidth: number = Math.round(screenshotHeight * (16 / 9));
  const thumbnailGenerationVersion = activeCustomImages.has(thumbnailSavePath)
    ? null
    : currentGeneratedImageVersion(thumbnailSavePath);

  const maxRunTime: ExtractionDurations = setExtractionDurations(
    sourceHeight, numOfScreens, screenshotHeight, clipSnippets, snippetLength, clipHeight
  );

  checkFileExists(pathToVideo)                                                            // (1)
    .then((videoFileExists: boolean) => {
      // console.log('01 - video file live = ' + videoFileExists);

      if (!videoFileExists) {
        throw new Error('VIDEO FILE NOT PRESENT');
      } else {
        return isExpectedJpeg(thumbnailSavePath, screenshotWidth, screenshotHeight);      // (2)
      }
    })
    .then((thumbExists: boolean) => {
      // console.log('02 - thumbnail already present = ' + thumbExists);

      if (thumbExists) {
        return true;
      } else {
        return extractThumbnailWithRecovery(
          pathToVideo,
          screenshotHeight,
          duration,
          thumbnailSavePath,
          maxRunTime.thumb,
          {
            createSystemThumbnail,
            generationVersion: thumbnailGenerationVersion,
          },
        );
      }
    })
    .then((thumbSuccess: boolean) => {
      // console.log('03 - single screenshot now present = ' + thumbSuccess);

      if (!thumbSuccess) {
        throw new Error('SINGLE SCREENSHOT EXTRACTION FAILED AFTER RECOVERY');
      } else {
        return isExpectedJpeg(
          filmstripSavePath,
          screenshotWidth * numOfScreens,
          screenshotHeight,
        );                                                                                // (4)
      }
    })
    .then((filmstripExists: boolean) => {
      // console.log('04 - filmstrip already present = ' + filmstripExists);

      if (filmstripExists) {
        return true;
      } else {
        return extractFilmstripWithRecovery(
          pathToVideo,
          duration,
          screenshotHeight,
          numOfScreens,
          thumbnailSavePath,
          filmstripSavePath,
          maxRunTime.filmstrip,
        );
      }
    })
    .then((filmstripSuccess: boolean) => {
      // console.log('05 - filmstrip now present = ' + filmstripSuccess);

      if (!filmstripSuccess) {
        throw new Error('FILMSTRIP GENERATION FAILED AFTER RECOVERY');
      } else if (clipSnippets === 0) {
        throw new Error('USER DOES NOT WANT CLIPS');
      } else {
        return checkFileExists(clipSavePath);                                             // (6)
      }
    })
    .then((clipExists: boolean) => {
      // console.log('04 - preview clip already present = ' + clipExists);

      if (clipExists) {
        return true;
      } else {

        const ffmpegArgs: string[] = generatePreviewClipArgs(
          pathToVideo, duration, clipHeight, clipSnippets, snippetLength, clipSavePath
        );

        return spawn_ffmpeg_and_run(ffmpegArgs, maxRunTime.clip, 'clip');                 // (7)
      }

    })
    .then((clipGenerationSuccess: boolean) => {
      // console.log('07 - preview clip now present = ' + clipGenerationSuccess);

      if (clipGenerationSuccess) {
        return checkFileExists(clipThumbSavePath);                                        // (8)
      } else {
        throw new Error('ERROR GENERATING CLIP');
      }
    })
    .then((clipThumbExists: boolean) => {
      // console.log('05 - preview clip thumb already present = ' + clipThumbExists);

      if (clipThumbExists) {
        return true;
      } else {
        const ffmpegArgs: string[] = extractFirstFrameArgs(clipSavePath, clipThumbSavePath);

        return spawn_ffmpeg_and_run(ffmpegArgs, maxRunTime.clipThumb, 'clip thumb');      // (9)
      }
    })
    .then((success: boolean) => {
      // console.log('09 - preview clip thumb now exists = ' + success);

      if (success) {
        // console.log('======= ALL STEPS SUCCESSFUL ==========');
      }
      if (success) {
        done(true);
      } else {
        done(false, new Error('CLIP THUMBNAIL GENERATION FAILED'));
      }
    })
    .catch((err) => {
      if (err instanceof Error && err.message === 'USER DOES NOT WANT CLIPS') {
        done(true);
      } else {
        if (GLOBALS.debug) {
          console.error('Preview extraction stopped:', err);
        }
        done(false, err instanceof Error ? err : new Error(String(err)));
      }
    });
}

// ========================================================================================
//         Helper methods
// ========================================================================================

interface ExtractionDurations {
  thumb: number;
  filmstrip: number;
  clip: number;
  clipThumb: number;
}

/**
 * Set the ExtractionDurations - the maximum running time per extraction type
 * if ffmpeg takes longer, it is taken out the back and shot - killed with no mercy
 *
 * These computations are not exact, they are meant meant to give a rough timeout window
 * to prevent corrupt files from slowing down the extraction too much
 *
 * @param sourceHeight - height of the original video
 * @param numOfScreens
 * @param screenshotHeight
 * @param clipSnippets
 * @param snippetLength
 * @param clipHeight
 */
export function setExtractionDurations(
  sourceHeight: number,
  numOfScreens: number,
  screenshotHeight: number,
  clipSnippets: number,
  snippetLength: number,
  clipHeight: number
): ExtractionDurations {

  // screenshot heights range from 144px to 504px
  // we'll call 144 the baseline and increase duration based on this
  // number of pixels grows ~ as square of height, so we square below
  // this means at highest resolution we multyply by 12.5 the time we wait
  const thumbHeightRatio = screenshotHeight / 144; // max 3.5 or 12.25 when squared
  const thumbHeightFactor = 1 + (thumbHeightRatio * thumbHeightRatio / 4); // square of ratio
  // not using Math.pow(n,2) because this is apparently faster https://stackoverflow.com/a/26594370/5017391

  const clipHeightRatio = clipHeight / 144; // max 3.5 or 12.25 when squared
  const clipHeightFactor = 1 + (clipHeightRatio * clipHeightRatio / 4); // square of ratio

  const sourceRatio = (sourceHeight === 0) ? 1 : (sourceHeight / 720); // 3 when source is 4k
  const sourceFactor = 1 + (sourceRatio * sourceRatio / 3); // square of ratio

  return {                                                                           // for me:
    thumb:    Math.max(                                                              // original coefficient was 500; now 4x
      MIN_THUMBNAIL_TIMEOUT_MS,
      2000 * sourceFactor * thumbHeightFactor,
    ),
    filmstrip: Math.max(                                                             // original coefficient was 350; now 4x
      MIN_FILMSTRIP_TIMEOUT_MS,
      1400 * sourceFactor * thumbHeightFactor * numOfScreens,
    ),
    clip:      350 * sourceFactor * clipHeightFactor * clipSnippets * snippetLength, // rarely above 15s
    clipThumb: 400 * clipHeightRatio,                                                // never above 600ms
  };
}

/**
 * Return promise for whether file exists
 * @param pathToFile string
 */
function checkFileExists(pathToFile: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    fs.access(pathToFile, fs.constants.F_OK, (err: any) => {
      return(resolve(!err));
    });
  });
}

interface JpegDimensions {
  height: number;
  width: number;
}

interface RecoveryAttempt {
  seekMode: RecoverySeekMode;
  timestamp: number;
}

/** Read dimensions from a complete JPEG without trusting its filename. */
export function readJpegDimensions(contents: Buffer): JpegDimensions | undefined {
  if (
    contents.length < 4
    || contents[0] !== 0xff
    || contents[1] !== 0xd8
    || contents[contents.length - 2] !== 0xff
    || contents[contents.length - 1] !== 0xd9
  ) {
    return undefined;
  }

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;

  while (offset + 3 < contents.length) {
    if (contents[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (contents[offset] === 0xff) {
      offset++;
    }
    if (offset >= contents.length) {
      return undefined;
    }

    const marker = contents[offset++];
    if (marker === 0xd9) {
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > contents.length) {
      return undefined;
    }

    const segmentLength = contents.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > contents.length) {
      return undefined;
    }
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) {
        return undefined;
      }
      return {
        height: contents.readUInt16BE(offset + 3),
        width: contents.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }

  return undefined;
}

export async function isExpectedJpeg(
  filePath: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<boolean> {
  try {
    const dimensions = readJpegDimensions(await fs.promises.readFile(filePath));
    return Boolean(
      dimensions
      && dimensions.width === expectedWidth
      && dimensions.height === expectedHeight,
    );
  } catch {
    return false;
  }
}

function createTemporaryImagePath(finalPath: string): string {
  temporaryImageSequence++;
  return path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${process.pid}-${Date.now()}-${temporaryImageSequence}.tmp.jpg`,
  );
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && GLOBALS.debug) {
      console.error('Unable to remove incomplete preview image:', filePath, error);
    }
  }
}

function currentGeneratedImageVersion(filePath: string): number {
  return generatedImageVersions.get(filePath) ?? 0;
}

function invalidateGeneratedImage(filePath: string): void {
  generatedImageVersions.set(filePath, currentGeneratedImageVersion(filePath) + 1);
}

async function waitForActiveCustomImage(filePath: string): Promise<void> {
  let activeCustomImage = activeCustomImages.get(filePath);
  while (activeCustomImage) {
    await activeCustomImage.settled;
    activeCustomImage = activeCustomImages.get(filePath);
  }
}

async function withImagePublicationLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousOperation = imagePublicationLocks.get(filePath) ?? Promise.resolve();
  let releaseCurrentOperation: () => void;
  const currentOperation = new Promise<void>((resolve) => {
    releaseCurrentOperation = resolve;
  });
  const queuedOperations = previousOperation.then(() => currentOperation);
  imagePublicationLocks.set(filePath, queuedOperations);

  await previousOperation;
  try {
    return await operation();
  } finally {
    releaseCurrentOperation();
    if (imagePublicationLocks.get(filePath) === queuedOperations) {
      imagePublicationLocks.delete(filePath);
    }
  }
}

async function publishImage(candidatePath: string, finalPath: string): Promise<void> {
  try {
    await fs.promises.rename(candidatePath, finalPath);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== 'EEXIST' && errorCode !== 'EPERM') {
      throw error;
    }
    await fs.promises.unlink(finalPath);
    await fs.promises.rename(candidatePath, finalPath);
  }
}

/**
 * A warning-only FFmpeg exit can still leave a complete JPEG. Accept only a
 * fresh candidate with the exact expected dimensions, then publish it with an
 * atomic same-directory rename. Timed-out writers never touch the final path.
 */
async function generateValidatedJpeg(
  finalPath: string,
  expectedWidth: number,
  expectedHeight: number,
  maxRunningTime: number,
  description: string,
  buildArgs: (candidatePath: string) => string[],
  canPublish: () => boolean = () => true,
  preserveValidDestination = false,
): Promise<boolean> {
  const candidatePath = createTemporaryImagePath(finalPath);
  let published = false;

  try {
    const processResult = await spawn_ffmpeg_and_run_detailed(
      buildArgs(candidatePath),
      maxRunningTime,
      description,
    );
    const candidateIsValid = await isExpectedJpeg(candidatePath, expectedWidth, expectedHeight);

    if (!candidateIsValid || processResult.timedOut || processResult.processError) {
      return false;
    }
    if (!processResult.success && GLOBALS.debug) {
      console.warn(`${description} produced a valid image despite FFmpeg warnings`);
    }

    return await withImagePublicationLock(finalPath, async () => {
      if (!canPublish()) {
        return false;
      }
      if (
        preserveValidDestination
        && await isExpectedJpeg(finalPath, expectedWidth, expectedHeight)
      ) {
        return true;
      }
      await publishImage(candidatePath, finalPath);
      published = true;
      return true;
    });
  } catch (error) {
    if (GLOBALS.debug) {
      console.error(`${description} failed`, error);
    }
    return false;
  } finally {
    if (!published) {
      await removeFileIfPresent(candidatePath);
    }
  }
}

function thumbnailRecoveryAttempts(duration: number): RecoveryAttempt[] {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const attempts: RecoveryAttempt[] = [
    { seekMode: 'scan', timestamp: 0 },
    { seekMode: 'scan', timestamp: Math.min(5, safeDuration * 0.02) },
    { seekMode: 'fast', timestamp: safeDuration * 0.5 },
    { seekMode: 'fast', timestamp: safeDuration * 0.9 },
  ];
  const seen = new Set<string>();

  return attempts.filter((attempt: RecoveryAttempt) => {
    const key = `${attempt.seekMode}:${attempt.timestamp.toFixed(3)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('System thumbnail request timed out.')), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function extractSystemThumbnail(
  pathToVideo: string,
  screenshotHeight: number,
  savePath: string,
  createSystemThumbnail: SystemThumbnailCreator,
  canPublish: () => boolean,
): Promise<boolean> {
  const expectedWidth = Math.round(screenshotHeight * (16 / 9));
  let temporaryDirectory: string | undefined;

  try {
    const jpegData = await promiseWithTimeout(
      Promise.resolve().then(() => createSystemThumbnail(
        pathToVideo,
        expectedWidth,
        screenshotHeight,
      )),
      SYSTEM_THUMBNAIL_REQUEST_TIMEOUT_MS,
    );
    if (!jpegData.length || !canPublish()) {
      return false;
    }

    temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vha-system-thumbnail-'));
    const sourcePath = path.join(temporaryDirectory, 'system-thumbnail.jpg');
    await fs.promises.writeFile(sourcePath, jpegData);

    return await generateValidatedJpeg(
      savePath,
      expectedWidth,
      screenshotHeight,
      SYSTEM_THUMBNAIL_SCALE_TIMEOUT_MS,
      'system thumbnail recovery',
      (candidatePath: string) => [
        '-y', '-i', sourcePath,
        '-map', '0:v:0',
        '-frames:v', '1',
        '-vf', scaleAndPadString(expectedWidth, screenshotHeight),
        candidatePath,
      ],
      canPublish,
      true,
    );
  } catch (error) {
    if (GLOBALS.debug) {
      console.error('System thumbnail recovery failed', error);
    }
    return false;
  } finally {
    if (temporaryDirectory) {
      try {
        await fs.promises.rm(temporaryDirectory, { force: true, recursive: true });
      } catch (error) {
        if (GLOBALS.debug) {
          console.error('System thumbnail recovery files could not be removed', error);
        }
      }
    }
  }
}

export async function extractThumbnailWithRecovery(
  pathToVideo: string,
  screenshotHeight: number,
  duration: number,
  savePath: string,
  maxRunningTime: number,
  options: ThumbnailRecoveryOptions = {},
): Promise<boolean> {
  const expectedWidth = Math.round(screenshotHeight * (16 / 9));
  const generationVersion = options.generationVersion === undefined
    ? currentGeneratedImageVersion(savePath)
    : options.generationVersion;
  const canPublish = (): boolean => {
    return generationVersion !== null
      && currentGeneratedImageVersion(savePath) === generationVersion
      && !activeCustomImages.has(savePath);
  };

  if (!canPublish()) {
    await waitForActiveCustomImage(savePath);
    return isExpectedJpeg(savePath, expectedWidth, screenshotHeight);
  }

  const normalSucceeded = await generateValidatedJpeg(
    savePath,
    expectedWidth,
    screenshotHeight,
    maxRunningTime,
    'thumb',
    (candidatePath: string) => extractSingleFrameArgs(
      pathToVideo,
      screenshotHeight,
      duration,
      candidatePath,
    ),
    canPublish,
    true,
  );
  if (normalSucceeded) {
    return true;
  }
  if (!canPublish()) {
    await waitForActiveCustomImage(savePath);
    return isExpectedJpeg(savePath, expectedWidth, screenshotHeight);
  }

  const recoveryDeadline = Date.now() + THUMBNAIL_RECOVERY_BUDGET_MS;
  const attempts = thumbnailRecoveryAttempts(duration);

  for (let index = 0; index < attempts.length; index++) {
    const remainingRecoveryTime = recoveryDeadline - Date.now();
    if (remainingRecoveryTime <= 0 || !canPublish()) {
      break;
    }
    const attempt = attempts[index];
    const recovered = await generateValidatedJpeg(
      savePath,
      expectedWidth,
      screenshotHeight,
      Math.min(MAX_RECOVERY_FRAME_TIMEOUT_MS, remainingRecoveryTime),
      `thumb recovery ${index + 1}`,
      (candidatePath: string) => extractRecoveryFrameArgs(
        pathToVideo,
        screenshotHeight,
        attempt.timestamp,
        candidatePath,
        attempt.seekMode,
      ),
      canPublish,
      true,
    );
    if (recovered) {
      return true;
    }

    if (index === 0) {
      const remainingConcealedRecoveryTime = recoveryDeadline - Date.now();
      if (remainingConcealedRecoveryTime > 0 && canPublish()) {
        const concealedFrameRecovered = await generateValidatedJpeg(
          savePath,
          expectedWidth,
          screenshotHeight,
          Math.min(MAX_RECOVERY_FRAME_TIMEOUT_MS, remainingConcealedRecoveryTime),
          'concealed frame recovery',
          (candidatePath: string) => extractConcealedFrameArgs(
            pathToVideo,
            screenshotHeight,
            candidatePath,
          ),
          canPublish,
          true,
        );
        if (concealedFrameRecovered) {
          return true;
        }
      }
    }
  }

  if (!canPublish()) {
    await waitForActiveCustomImage(savePath);
    return isExpectedJpeg(savePath, expectedWidth, screenshotHeight);
  }
  if (options.createSystemThumbnail) {
    const systemThumbnailRecovered = await extractSystemThumbnail(
      pathToVideo,
      screenshotHeight,
      savePath,
      options.createSystemThumbnail,
      canPublish,
    );
    if (systemThumbnailRecovered) {
      return true;
    }
    if (!canPublish()) {
      await waitForActiveCustomImage(savePath);
      return isExpectedJpeg(savePath, expectedWidth, screenshotHeight);
    }
  }
  return false;
}

export function selectRecoveryFrameIndexes(
  totalFrames: number,
  maximumFrames = MAX_FILMSTRIP_RECOVERY_FRAMES,
): number[] {
  if (totalFrames <= 0 || maximumFrames <= 0) {
    return [];
  }
  if (totalFrames <= maximumFrames) {
    return Array.from({ length: totalFrames }, (_value, index) => index);
  }
  if (maximumFrames === 1) {
    return [0];
  }

  const indexes = new Set<number>();
  for (let index = 0; index < maximumFrames; index++) {
    indexes.add(Math.round(index * (totalFrames - 1) / (maximumFrames - 1)));
  }
  return Array.from(indexes).sort((left, right) => left - right);
}

export function fillMissingRecoveryFrames(
  totalFrames: number,
  recoveredFrames: Map<number, string>,
  fallbackPath: string,
): string[] {
  const recoveredIndexes = Array.from(recoveredFrames.keys()).sort((left, right) => left - right);
  if (!recoveredIndexes.length) {
    return Array(totalFrames).fill(fallbackPath);
  }

  return Array.from({ length: totalFrames }, (_value, index) => {
    const nearestIndex = recoveredIndexes.reduce((nearest, candidate) => {
      return Math.abs(candidate - index) < Math.abs(nearest - index) ? candidate : nearest;
    }, recoveredIndexes[0]);
    return recoveredFrames.get(nearestIndex) as string;
  });
}

/** Run media work with a fixed upper bound regardless of the item count. */
export async function runBoundedMediaWork<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error('The media-work concurrency is invalid.');
  }

  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (!failed && shouldContinue() && nextIndex < items.length) {
        const itemIndex = nextIndex++;
        try {
          await worker(items[itemIndex]);
        } catch (error) {
          failed = true;
          firstError = error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) {
    throw firstError;
  }
}

export async function extractFilmstripWithRecovery(
  pathToVideo: string,
  duration: number,
  screenshotHeight: number,
  numberOfScreenshots: number,
  thumbnailPath: string,
  savePath: string,
  maxRunningTime: number,
): Promise<boolean> {
  if (!Number.isInteger(numberOfScreenshots) || numberOfScreenshots <= 0) {
    return false;
  }

  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const frameWidth = Math.round(screenshotHeight * (16 / 9));
  const stripWidth = frameWidth * numberOfScreenshots;

  const recoveryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vha-filmstrip-recovery-'));
  const cancellationGeneration = mediaProcessCancellationGeneration;
  const extractionStillCurrent = (): boolean => (
    cancellationGeneration === mediaProcessCancellationGeneration
  );
  const recoveredFrames = new Map<number, string>();
  const step = safeDuration / (numberOfScreenshots + 1);
  const thumbnailIndex = Math.max(
    0,
    Math.min(numberOfScreenshots - 1, Math.round((numberOfScreenshots + 1) / 10 - 1)),
  );
  recoveredFrames.set(thumbnailIndex, thumbnailPath);
  // The former fast path opened the source once per screenshot inside one
  // FFmpeg process. Thirty simultaneous 4K/HEVC decoders can consume tens of
  // gigabytes. Use a small fixed decoder pool instead, then stack only the
  // small JPEGs. Preserve the extended timeout for slow/network media.
  const recoveryDeadline = Date.now() + Math.max(
    FILMSTRIP_RECOVERY_BUDGET_MS,
    maxRunningTime,
  );

  try {
    const indexesToRecover = selectRecoveryFrameIndexes(numberOfScreenshots)
      .filter((index: number) => index !== thumbnailIndex);

    await runBoundedMediaWork(
      indexesToRecover,
      FILMSTRIP_FRAME_CONCURRENCY,
      async (frameIndex: number) => {
        const remainingFrameRecoveryTime = recoveryDeadline
          - FILMSTRIP_ASSEMBLY_RESERVE_MS
          - Date.now();
        if (remainingFrameRecoveryTime <= 0 || !extractionStillCurrent()) {
          return;
        }

        const recoveredPath = path.join(recoveryDirectory, `frame-${frameIndex}.jpg`);
        const recovered = await generateValidatedJpeg(
          recoveredPath,
          frameWidth,
          screenshotHeight,
          Math.min(MAX_RECOVERY_FRAME_TIMEOUT_MS, remainingFrameRecoveryTime),
          `filmstrip frame ${frameIndex + 1}`,
          (candidatePath: string) => extractRecoveryFrameArgs(
            pathToVideo,
            screenshotHeight,
            (frameIndex + 1) * step,
            candidatePath,
            'fast',
          ),
        );
        if (recovered && extractionStillCurrent()) {
          recoveredFrames.set(frameIndex, recoveredPath);
        }
      },
      extractionStillCurrent,
    );

    if (!extractionStillCurrent()) {
      return false;
    }

    const framePaths = fillMissingRecoveryFrames(
      numberOfScreenshots,
      recoveredFrames,
      thumbnailPath,
    );
    const remainingAssemblyTime = recoveryDeadline - Date.now();
    if (remainingAssemblyTime <= 0) {
      return false;
    }
    return await generateValidatedJpeg(
      savePath,
      stripWidth,
      screenshotHeight,
      remainingAssemblyTime,
      'filmstrip assembly',
      (candidatePath: string) => stackRecoveredFramesArgs(framePaths, candidatePath),
    );
  } finally {
    try {
      await fs.promises.rm(recoveryDirectory, { force: true, recursive: true });
    } catch (error) {
      if (GLOBALS.debug) {
        console.error('Filmstrip recovery files could not be removed', error);
      }
    }
  }
}

/**
 * Replace original file with new file
 * use ffmpeg to convert and letterbox to fit width and height
 *
 * @param oldFile full path to thumbnail to replace
 * @param newFile full path to sounce image to use as replacement
 * @param height
 */
export async function replaceThumbnailWithNewImage(
  oldFile: string,
  newFile: string,
  height: number,
  convertPngToJpeg?: (imagePath: string) => Buffer | Promise<Buffer>,
): Promise<boolean> {

  console.log('Resizing new image and replacing old thumbnail');

  const width: number = Math.floor(height * (16 / 9));
  let sourceFile = newFile;
  let temporaryDirectory: string | undefined;
  invalidateGeneratedImage(oldFile);
  const replacementVersion = currentGeneratedImageVersion(oldFile);
  const canPublish = (): boolean => currentGeneratedImageVersion(oldFile) === replacementVersion;
  let releaseCustomImage: () => void = () => undefined;
  const activeCustomImage: ActiveCustomImage = {
    release: () => releaseCustomImage(),
    settled: new Promise<void>((resolve) => {
      releaseCustomImage = resolve;
    }),
  };
  activeCustomImages.set(oldFile, activeCustomImage);

  try {
    if (path.extname(newFile).toLowerCase() === '.png') {
      if (!convertPngToJpeg) {
        throw new Error('PNG custom thumbnails require an image decoder.');
      }

      const jpegData = await convertPngToJpeg(newFile);
      if (!jpegData.length) {
        throw new Error('The dropped PNG could not be decoded.');
      }
      temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vha-custom-thumbnail-'));
      sourceFile = path.join(temporaryDirectory, 'decoded-image.jpg');
      await fs.promises.writeFile(sourceFile, jpegData);
    }

    return await generateValidatedJpeg(
      oldFile,
      width,
      height,
      CUSTOM_THUMBNAIL_TIMEOUT_MS,
      'replacing thumbnail',
      (candidatePath: string) => [
        '-y', '-i', sourceFile,
        '-vf', scaleAndPadString(width, height),
        candidatePath,
      ],
      canPublish,
    );
  } finally {
    activeCustomImage.release();
    if (activeCustomImages.get(oldFile) === activeCustomImage) {
      activeCustomImages.delete(oldFile);
    }
    if (temporaryDirectory) {
      try {
        await fs.promises.rm(temporaryDirectory, { force: true, recursive: true });
      } catch (error) {
        if (GLOBALS.debug) {
          console.error('Temporary custom thumbnail files could not be removed', error);
        }
      }
    }
  }
}

/**
 * Generate the correct `scale=` & `pad=` string for ffmpeg
 * @param width
 * @param height
 */
function scaleAndPadString(width: number, height: number): string {
  // sweet thanks to StackExchange!
  // https://superuser.com/questions/547296/resizing-videos-with-ffmpeg-avconv-to-fit-into-static-sized-player

  return 'scale=w=' + width + ':h=' + height + ':force_original_aspect_ratio=decrease,' +
         'pad='     + width + ':'   + height + ':(ow-iw)/2:(oh-ih)/2';

}

/**
 * Spawn ffmpeg and run the appropriate arguments
 * Kill the process after maxRunningTime
 * @param args            args to pass into ffmpeg
 * @param maxRunningTime  maximum time to run ffmpeg
 * @param description     log for console.log
 */
type SpawnMediaProcess = (
  executablePath: string,
  args: string[],
  options: { windowsHide: boolean },
) => any;

export interface MediaProcessResult {
  exitCode: number | null;
  processError: boolean;
  success: boolean;
  timedOut: boolean;
}

/** Stop decoder processes owned by an import that has been cancelled/reset. */
export function cancelActiveMediaProcesses(): void {
  mediaProcessCancellationGeneration++;
  activeMediaProcesses.forEach((mediaProcess: any) => {
    const stillRunning = mediaProcess.exitCode === null && mediaProcess.signalCode === null;
    if (!stillRunning) {
      activeMediaProcesses.delete(mediaProcess);
      return;
    }
    try {
      mediaProcess.kill();
    } catch {
      // The normal exit/error listeners still settle the owning queue item.
    }
    const forceKill = setTimeout(() => {
      if (mediaProcess.exitCode === null && mediaProcess.signalCode === null) {
        try {
          mediaProcess.kill('SIGKILL');
        } catch {
          // The process may have exited between the state check and signal.
        }
      }
    }, FORCE_KILL_DELAY_MS);
    forceKill.unref?.();
  });
}

export function spawn_ffmpeg_and_run(
  args: string[],
  maxRunningTime: number,
  description: string,
  spawnMediaProcess: SpawnMediaProcess = spawn,
): Promise<boolean> {
  return spawn_ffmpeg_and_run_detailed(
    args,
    maxRunningTime,
    description,
    spawnMediaProcess,
  ).then((result: MediaProcessResult) => result.success);
}

export function spawn_ffmpeg_and_run_detailed(
  args: string[],
  maxRunningTime: number,
  description: string,
  spawnMediaProcess: SpawnMediaProcess = spawn,
): Promise<MediaProcessResult> {

  return new Promise((resolve) => {
    let resultSettled = false;
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let forceSettleTimeout: NodeJS.Timeout | undefined;

    const settleResult = (result: MediaProcessResult): void => {
      if (!resultSettled) {
        resultSettled = true;
        resolve(result);
      }
    };

    // Uncomment things in this method (and the `performance` import) to check how long extraction takes
    // const t0: number = performance.now();

    const ffmpeg_process = spawnMediaProcess(ffmpegPath, ['-nostdin', '-hide_banner', ...args], {
      windowsHide: true,
    });
    activeMediaProcesses.add(ffmpeg_process);

    const processStillRunning = (): boolean => {
      return ffmpeg_process.exitCode === null && ffmpeg_process.signalCode === null;
    };

    const killProcessTimeout = setTimeout(() => {
      // `exitCode` is populated before Node emits `exit`. If the process has
      // already finished, let that successful exit win rather than treating a
      // delayed event (or delayed stdio close) as a timeout.
      if (!processStillRunning()) {
        settleResult({
          exitCode: ffmpeg_process.exitCode,
          processError: false,
          success: ffmpeg_process.exitCode === 0,
          timedOut: false,
        });
        return;
      }

      timedOut = true;
      try {
        ffmpeg_process.kill();
      } catch (error) {
        if (GLOBALS.debug) {
          console.error(description + ' could not be stopped after timing out', error);
        }
      }
      forceKillTimeout = setTimeout(() => {
        if (processStillRunning()) {
          try {
            ffmpeg_process.kill('SIGKILL');
          } catch (error) {
            if (GLOBALS.debug) {
              console.error(description + ' could not be force-stopped', error);
            }
          }
        }
        // A real child normally emits exit immediately after SIGKILL. Keep a
        // final bounded escape hatch for malformed test doubles or platform
        // failures, but do not start the next queue item while a heavy child
        // is still in its ordinary termination window.
        forceSettleTimeout = setTimeout(() => {
          settleResult({
            exitCode: ffmpeg_process.exitCode,
            processError: false,
            success: false,
            timedOut: true,
          });
        }, FORCE_SETTLE_DELAY_MS);
        forceSettleTimeout.unref?.();
      }, FORCE_KILL_DELAY_MS);
      forceKillTimeout.unref?.();
    }, maxRunningTime);

    // Note from past Cal to future Cal:
    // ALWAYS READ THE DATA, EVEN IF YOU DO NOTHING WITH IT
    ffmpeg_process.stdout.on('data', data => {
      if (GLOBALS.debug) {
        console.log(data);
      }
    });
    ffmpeg_process.stderr.on('data', data => {
      if (GLOBALS.debug) {
        console.log('grep stderr: ' + data);
      }
    });
    ffmpeg_process.on('error', () => {
      clearTimeout(killProcessTimeout);
      // A failed termination can emit `error`. Keep the scheduled SIGKILL in
      // that case; it is safe to clear only after exit/close confirms the
      // child is gone.
      if (!timedOut && forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      if (timedOut && processStillRunning()) {
        return;
      }
      activeMediaProcesses.delete(ffmpeg_process);
      settleResult({
        exitCode: ffmpeg_process.exitCode,
        processError: true,
        success: false,
        timedOut,
      });
    });
    ffmpeg_process.on('exit', (code: number | null) => {
      activeMediaProcesses.delete(ffmpeg_process);
      clearTimeout(killProcessTimeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      if (forceSettleTimeout) {
        clearTimeout(forceSettleTimeout);
      }
      // const t1: number = performance.now();
      // console.log(description + ' ' + Math.round(t1 - t0) + ' < ' + maxRunningTime);
      settleResult({
        exitCode: code,
        processError: false,
        success: code === 0 && !timedOut,
        timedOut,
      });
    });
    ffmpeg_process.on('close', () => {
      activeMediaProcesses.delete(ffmpeg_process);
      clearTimeout(killProcessTimeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      if (forceSettleTimeout) {
        clearTimeout(forceSettleTimeout);
      }
      if (!resultSettled) {
        settleResult({
          exitCode: ffmpeg_process.exitCode,
          processError: false,
          success: ffmpeg_process.exitCode === 0 && !timedOut,
          timedOut,
        });
      }
    });

  });

}
