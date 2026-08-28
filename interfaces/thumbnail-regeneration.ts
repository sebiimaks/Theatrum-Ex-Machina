export interface ThumbnailCoreStatus {
  readonly filmstrip: boolean;
  readonly thumbnail: boolean;
}

export interface FolderThumbnailRegenerationProgress {
  readonly completed: number;
  readonly failed: number;
  readonly fileHash: string;
  readonly screenshotCount?: number;
  readonly succeeded: number;
  readonly success: boolean;
  readonly total: number;
}

export interface FolderThumbnailRegenerationResult {
  readonly cancelled: boolean;
  readonly completed: number;
  readonly failed: number;
  readonly skippedVideos: number;
  readonly succeeded: number;
  readonly total: number;
  readonly videoCount: number;
}

const SAFE_THUMBNAIL_HASH = /^[a-zA-Z0-9_-]{1,200}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isSafeThumbnailHash(value: unknown): value is string {
  return typeof value === 'string' && SAFE_THUMBNAIL_HASH.test(value);
}

export function isThumbnailRegenerationCorrelation(
  requestId: unknown,
  sourceIndex: unknown,
): boolean {
  return Number.isSafeInteger(requestId)
    && (requestId as number) > 0
    && Number.isInteger(sourceIndex)
    && (sourceIndex as number) >= 0;
}

export function isThumbnailCoreStatus(value: unknown): value is ThumbnailCoreStatus {
  return isRecord(value)
    && Object.keys(value).every(key => key === 'filmstrip' || key === 'thumbnail')
    && typeof value.filmstrip === 'boolean'
    && typeof value.thumbnail === 'boolean';
}

export function isFolderThumbnailRegenerationProgress(
  value: unknown,
): value is FolderThumbnailRegenerationProgress {
  if (!isRecord(value) || !isSafeThumbnailHash(value.fileHash)) {
    return false;
  }
  if (
    !isNonNegativeSafeInteger(value.completed)
    || !isNonNegativeSafeInteger(value.failed)
    || !isNonNegativeSafeInteger(value.succeeded)
    || !isNonNegativeSafeInteger(value.total)
    || value.completed > value.total
    || typeof value.success !== 'boolean'
  ) {
    return false;
  }
  return value.screenshotCount === undefined
    || (
      Number.isSafeInteger(value.screenshotCount)
      && (value.screenshotCount as number) > 0
    );
}

export function isFolderThumbnailRegenerationResult(
  value: unknown,
): value is FolderThumbnailRegenerationResult {
  if (!isRecord(value) || typeof value.cancelled !== 'boolean') {
    return false;
  }
  return isNonNegativeSafeInteger(value.completed)
    && isNonNegativeSafeInteger(value.failed)
    && isNonNegativeSafeInteger(value.skippedVideos)
    && isNonNegativeSafeInteger(value.succeeded)
    && isNonNegativeSafeInteger(value.total)
    && isNonNegativeSafeInteger(value.videoCount)
    && value.completed <= value.total;
}
