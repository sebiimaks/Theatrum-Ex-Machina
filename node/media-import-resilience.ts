import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Stats } from 'node:fs';
import type { ImageElement } from '../interfaces/final-object.interface';
import {
  IMPORT_ERROR_TAG,
  NewImageElement,
  isMetadataImportFailure,
} from '../interfaces/final-object.interface';

export const LOCAL_FFPROBE_TIMEOUT_MS = 5 * 60 * 1000;
export const VOLUME_FFPROBE_TIMEOUT_MS = 8 * 60 * 1000;

const DEFAULT_SETTLE_POLL_MS = 1000;
const DEFAULT_SETTLE_STABILITY_MS = 3000;
const DEFAULT_SETTLE_MAX_WAIT_MS = 60 * 1000;

interface SettleOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
  stabilityThresholdMs?: number;
}

interface RetryOptions {
  isTimeout?: (error: unknown) => boolean;
  waitForSettle?: (filePath: string) => Promise<void>;
}

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function snapshot(stats: Stats): FileSnapshot {
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

function snapshotsMatch(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/**
 * Network shares mounted by macOS appear below /Volumes rather than using a
 * UNC path. Give those files a little more time without extending every local
 * probe or retrying a process that has already consumed its full allowance.
 */
export function getFfprobeTimeoutMs(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): number {
  const normalizedPath = path.normalize(filePath);
  const isMountedMacVolume = platform === 'darwin'
    && (normalizedPath === '/Volumes' || normalizedPath.startsWith('/Volumes/'));
  const isUncPath = platform === 'win32'
    && (normalizedPath.startsWith('\\\\') || normalizedPath.startsWith('//'));

  return isMountedMacVolume || isUncPath
    ? VOLUME_FFPROBE_TIMEOUT_MS
    : LOCAL_FFPROBE_TIMEOUT_MS;
}

export function isProcessTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const processError = error as NodeJS.ErrnoException & { killed?: boolean };
  return processError.code === 'ETIMEDOUT' || processError.killed === true;
}

/**
 * Wait only after a probe has failed. A stable corrupt file incurs a short
 * delay, while a file still being copied gets a bounded opportunity to finish.
 */
export async function waitForFileToSettle(
  filePath: string,
  options: SettleOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SETTLE_POLL_MS;
  const stabilityThresholdMs = options.stabilityThresholdMs ?? DEFAULT_SETTLE_STABILITY_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_SETTLE_MAX_WAIT_MS;
  const startedAt = Date.now();
  let stableSince = startedAt;
  let previous = snapshot(await fs.promises.stat(filePath));

  while (Date.now() - startedAt < maxWaitMs) {
    await delay(pollIntervalMs);
    const current = snapshot(await fs.promises.stat(filePath));

    if (snapshotsMatch(previous, current)) {
      if (Date.now() - stableSince >= stabilityThresholdMs) {
        return;
      }
    } else {
      previous = current;
      stableSince = Date.now();
    }
  }
}

/**
 * Retry one quick failure after the source file is stable. A timeout is not
 * retried because it has already used the full (and deliberately generous)
 * allowance for its storage location.
 */
export async function runProbeWithOneRetry<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  try {
    return await operation();
  } catch (firstError) {
    const timeoutCheck = options.isTimeout ?? isProcessTimeoutError;
    if (timeoutCheck(firstError)) {
      throw firstError;
    }

    const settle = options.waitForSettle ?? waitForFileToSettle;
    try {
      await settle(filePath);
    } catch {
      throw firstError;
    }

    return operation();
  }
}

/**
 * Create a deterministic identity without reading media bytes. This keeps a
 * catalogue entry usable even when a network read fails after stat succeeds.
 */
export function createFallbackImportHash(filePath: string, stats: Stats): string {
  return createHash('md5')
    .update(path.normalize(filePath))
    .update('\0')
    .update(stats.size.toString())
    .update('\0')
    .update(stats.mtimeMs.toString())
    .digest('hex');
}

export async function createImportErrorElement(filePath: string): Promise<ImageElement> {
  const stats = await fs.promises.stat(filePath);
  const imageElement = NewImageElement();

  imageElement.birthtime = Math.round(stats.birthtimeMs);
  imageElement.fileSize = stats.size;
  imageElement.hash = createFallbackImportHash(filePath, stats);
  imageElement.height = 0;
  imageElement.metadataImportFailed = true;
  imageElement.mtime = Math.round(stats.mtimeMs);
  imageElement.screens = 0;
  imageElement.tags = [IMPORT_ERROR_TAG];

  return imageElement;
}

export function shouldExtractThumbnails(element: ImageElement): boolean {
  return !isMetadataImportFailure(element);
}

/**
 * The folder-add preference suppresses only automatic preview generation.
 * Metadata import remains independent, while manual regeneration bypasses
 * this policy entirely.
 */
export function shouldQueueAutomaticPreviews(
  element: ImageElement,
  generateAutomaticPreviews = true,
): boolean {
  return generateAutomaticPreviews && shouldExtractThumbnails(element);
}
