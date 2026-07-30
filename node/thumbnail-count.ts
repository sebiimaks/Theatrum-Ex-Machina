import type { ImageElement, ScreenshotSettings } from '../interfaces/final-object.interface';
import { isMetadataImportFailure } from '../interfaces/final-object.interface';

export interface FolderThumbnailRegenerationPlan {
  candidatesByHash: Map<string, ImageElement[]>;
  eligibleVideos: ImageElement[];
  entrySignatures: string[];
  skippedVideos: number;
  targets: ImageElement[];
  videoCount: number;
  videoCountsByHash: Map<string, number>;
}

export interface ThumbnailCoreStatus {
  filmstrip: boolean;
  thumbnail: boolean;
}

export interface FilmstripHoverPosition {
  frameIndex: number;
  offset: number;
}

export type ThumbnailRefreshKind = 'thumbnail' | 'custom-thumbnail' | 'thumbnail-recovery';

export const MAX_FIXED_SCREENSHOT_COUNT = 30;
const DEFAULT_SCREENSHOT_COUNT = 10;
const DEFAULT_SCREENSHOT_HEIGHT = 288;
const THUMBNAIL_REFRESH_SUFFIX = /(?:(?:-thumbnail|-custom-thumbnail|-thumbnail-recovery)-\d+)+$/;

/** Normalize unsafe settings while retaining safe legacy interval values. */
export function sanitizeScreenshotSettings(
  screenshotSettings: ScreenshotSettings,
): ScreenshotSettings {
  const configuredValue = Number(screenshotSettings.n);
  const n = screenshotSettings.fixed
    ? Math.min(
      MAX_FIXED_SCREENSHOT_COUNT,
      Math.max(
        3,
        Number.isFinite(configuredValue) ? Math.round(configuredValue) : DEFAULT_SCREENSHOT_COUNT,
      ),
    )
    : Math.max(1, Number.isFinite(configuredValue) ? configuredValue : 1);

  return {
    ...screenshotSettings,
    n,
  };
}

/**
 * Calculate the screenshot count represented by a catalogue's current
 * extraction settings for one video.
 */
export function calculateScreenshotCount(
  screenshotSettings: ScreenshotSettings,
  duration: number,
): number {
  const safeSettings = sanitizeScreenshotSettings(screenshotSettings);
  const safeDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0;
  const configuredValue = Number(safeSettings.n);
  const safeHeight = Number.isFinite(safeSettings.height) && safeSettings.height > 0
    ? safeSettings.height
    : DEFAULT_SCREENSHOT_HEIGHT;
  let total: number;

  if (safeSettings.fixed) {
    total = configuredValue;
  } else {
    total = Math.ceil(safeDuration / 60 / configuredValue);
  }

  if (total < 3) {
    total = 3;
  }

  const screenWidth: number = safeHeight * (16 / 9);
  if (total * screenWidth > 65535) {
    total = Math.max(1, Math.floor(65535 / screenWidth));
  }

  if (safeDuration < total) {
    total = Math.max(2, Math.floor(safeDuration));
  }

  return Number.isFinite(total) ? Math.max(1, Math.floor(total)) : 3;
}

/**
 * Repair unsafe or hand-edited screenshot metadata when a catalogue is
 * opened. Import-error and folder placeholder entries do not own previews
 * and are intentionally left untouched.
 */
export function normalizeCatalogueThumbnailCounts(
  elements: ImageElement[],
  screenshotSettings: ScreenshotSettings,
): boolean {
  let catalogueChanged = false;

  elements.forEach((element: ImageElement) => {
    if (
      element.cleanName === '*FOLDER*'
      || isMetadataImportFailure(element)
      || !Number.isFinite(element.duration)
      || element.duration < 0
    ) {
      return;
    }

    const expectedCount = calculateScreenshotCount(screenshotSettings, element.duration);
    if (element.screens !== expectedCount) {
      element.screens = expectedCount;
      catalogueChanged = true;
    }
    if (
      element.defaultScreen !== undefined
      && (
        !Number.isInteger(element.defaultScreen)
        || element.defaultScreen < 0
        || element.defaultScreen >= expectedCount
      )
    ) {
      delete element.defaultScreen;
      catalogueChanged = true;
    }
  });

  return catalogueChanged;
}

/** Keep thumbnail cache keys bounded during long application sessions. */
export function withThumbnailRefreshId(
  uuid: string,
  kind: ThumbnailRefreshKind,
  refreshId: number,
): string {
  const baseUuid = (uuid || '').replace(THUMBNAIL_REFRESH_SUFFIX, '');
  const safeRefreshId = Number.isFinite(refreshId) ? Math.trunc(refreshId) : Date.now();
  return `${baseUuid}-${kind}-${safeRefreshId}`;
}

/** Calculate a bounded filmstrip frame and background offset from pointer position. */
export function calculateFilmstripHoverPosition(
  screenCount: number,
  frameWidth: number,
  containerWidth: number,
  pointerX: number,
): FilmstripHoverPosition {
  const safeScreenCount = Number.isFinite(screenCount) ? Math.max(1, Math.floor(screenCount)) : 1;
  if (
    !Number.isFinite(frameWidth)
    || frameWidth <= 0
    || !Number.isFinite(containerWidth)
    || containerWidth <= 0
  ) {
    return { frameIndex: 0, offset: 0 };
  }

  const clampedPointer = Number.isFinite(pointerX)
    ? Math.min(containerWidth, Math.max(0, pointerX))
    : 0;
  const pointerRatio = clampedPointer / containerWidth;
  const maximumOffset = Math.max(0, safeScreenCount * frameWidth - containerWidth);

  return {
    frameIndex: Math.min(safeScreenCount - 1, Math.floor(pointerRatio * safeScreenCount)),
    offset: Math.min(maximumOffset, Math.max(0, Math.round(pointerRatio * maximumOffset))),
  };
}

/**
 * Prepare an item for regeneration without mutating its saved catalogue
 * metadata before extraction succeeds.
 */
export function prepareThumbnailRegeneration(
  element: ImageElement,
  screenshotSettings: ScreenshotSettings,
): ImageElement {
  return {
    ...element,
    screens: calculateScreenshotCount(screenshotSettings, element.duration),
  };
}

/**
 * Prevent another queued thumbnail task for the same file from completing a
 * regeneration request that it did not create.
 */
export function isActiveThumbnailRegenerationJob(
  queuedJobId: number | undefined,
  activeJobId: number,
): boolean {
  return queuedJobId !== undefined && queuedJobId === activeJobId;
}

/**
 * Synchronize a successfully regenerated filmstrip count into every
 * catalogue entry using the same preview hash.
 */
export function applyRegeneratedScreenshotCount(
  elements: ImageElement[],
  fileHash: string,
  screenshotCount: number,
): boolean {
  let catalogueChanged = false;

  elements
    .filter(element => element.hash === fileHash)
    .forEach((element) => {
      if (element.screens !== screenshotCount) {
        element.screens = screenshotCount;
        catalogueChanged = true;
      }
      if (element.defaultScreen !== undefined && element.defaultScreen >= screenshotCount) {
        delete element.defaultScreen;
        catalogueChanged = true;
      }
    });

  return catalogueChanged;
}

/**
 * Make a successfully written custom thumbnail the default for every
 * catalogue entry using the same preview hash, and force tracked views to
 * recreate their image components.
 */
export function applyCustomThumbnailReplacement(
  elements: ImageElement[],
  fileHash: string,
  refreshId: number,
): boolean {
  let catalogueChanged = false;

  elements
    .filter(element => element.hash === fileHash)
    .forEach((element) => {
      if (element.defaultScreen !== undefined) {
        delete element.defaultScreen;
        catalogueChanged = true;
      }
      element.uuid = withThumbnailRefreshId(element.uuid, 'custom-thumbnail', refreshId);
    });

  return catalogueChanged;
}

/**
 * Reveal any standalone thumbnail that survived a failed refresh. A saved
 * default frame selects the filmstrip in the renderer, so it must be cleared
 * when the thumbnail exists but the filmstrip does not.
 */
export function applyThumbnailRegenerationFailure(
  elements: ImageElement[],
  fileHash: string,
  coreStatus: ThumbnailCoreStatus | undefined,
  refreshId: number,
): boolean {
  let catalogueChanged = false;

  elements
    .filter(element => element.hash === fileHash)
    .forEach((element) => {
      if (
        coreStatus?.thumbnail
        && !coreStatus.filmstrip
        && element.defaultScreen !== undefined
      ) {
        delete element.defaultScreen;
        catalogueChanged = true;
      }
      element.uuid = withThumbnailRefreshId(element.uuid, 'thumbnail-recovery', refreshId);
    });

  return catalogueChanged;
}

function isEligibleFolderThumbnailVideo(element: ImageElement): boolean {
  return !element.deleted
    && element.cleanName !== '*FOLDER*'
    && !isMetadataImportFailure(element)
    && typeof element.hash === 'string'
    && /^[a-zA-Z0-9_-]+$/.test(element.hash);
}

/** Count current eligible entries without caching mutable catalogue state. */
export function countEligibleFolderThumbnailVideos(
  elements: ImageElement[],
  sourceIndex: number,
): number {
  return elements.filter((element: ImageElement) => {
    return Number(element.inputSource) === sourceIndex
      && isEligibleFolderThumbnailVideo(element);
  }).length;
}

/** Build all source-folder counts in one pass for the Current Hub view. */
export function buildEligibleFolderThumbnailVideoCounts(
  elements: ImageElement[],
): Map<number, number> {
  const counts = new Map<number, number>();
  elements.forEach((element: ImageElement) => {
    const sourceIndex = Number(element.inputSource);
    if (!Number.isInteger(sourceIndex) || !isEligibleFolderThumbnailVideo(element)) {
      return;
    }
    counts.set(sourceIndex, (counts.get(sourceIndex) || 0) + 1);
  });
  return counts;
}

/**
 * Select active videos belonging to one configured source folder and collapse
 * duplicate preview hashes into one regeneration job. Duplicate catalogue
 * entries share the same generated preview files, so recreating them once is
 * sufficient for every matching video.
 */
export function planFolderThumbnailRegeneration(
  elements: ImageElement[],
  sourceIndex: number,
): FolderThumbnailRegenerationPlan {
  const matchingVideos = elements.filter((element: ImageElement) => {
    return Number(element.inputSource) === sourceIndex
      && !element.deleted
      && element.cleanName !== '*FOLDER*';
  });
  const eligibleVideos = matchingVideos.filter((element: ImageElement) => {
    return isEligibleFolderThumbnailVideo(element);
  });
  const candidatesByHash = new Map<string, ImageElement[]>();
  const videoCountsByHash = new Map<string, number>();

  eligibleVideos.forEach((element: ImageElement) => {
    const candidates = candidatesByHash.get(element.hash) || [];
    candidates.push(element);
    candidatesByHash.set(element.hash, candidates);
    videoCountsByHash.set(element.hash, (videoCountsByHash.get(element.hash) || 0) + 1);
  });

  return {
    candidatesByHash,
    eligibleVideos,
    entrySignatures: eligibleVideos
      .map((element: ImageElement) => [
        element.hash,
        Number(element.inputSource),
        element.partialPath,
        element.fileName,
      ].join('\u0000'))
      .sort(),
    skippedVideos: matchingVideos.length - eligibleVideos.length,
    targets: Array.from(candidatesByHash.values()).map(candidates => candidates[0]),
    videoCount: eligibleVideos.length,
    videoCountsByHash,
  };
}

/**
 * Confirm that the catalogue entries covered by a modal have not changed
 * while the user was deciding. Paths are included so duplicate hashes cannot
 * conceal a newly added, removed, or moved entry.
 */
export function folderThumbnailRegenerationPlansMatch(
  confirmed: FolderThumbnailRegenerationPlan,
  current: FolderThumbnailRegenerationPlan,
): boolean {
  if (
    confirmed.videoCount !== current.videoCount
    || confirmed.skippedVideos !== current.skippedVideos
    || confirmed.targets.length !== current.targets.length
  ) {
    return false;
  }

  return confirmed.entrySignatures.every((signature, index) => {
    return signature === current.entrySignatures[index];
  });
}
