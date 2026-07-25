import type { ImageElement, ScreenshotSettings } from '../interfaces/final-object.interface';

/**
 * Calculate the screenshot count represented by a catalogue's current
 * extraction settings for one video.
 */
export function calculateScreenshotCount(
  screenshotSettings: ScreenshotSettings,
  duration: number,
): number {
  let total: number;

  if (screenshotSettings.fixed) {
    total = screenshotSettings.n;
  } else {
    total = Math.ceil(duration / 60 / screenshotSettings.n);
  }

  if (total < 3) {
    total = 3;
  }

  const screenWidth: number = screenshotSettings.height * (16 / 9);
  if (total * screenWidth > 65535) {
    total = Math.floor(65535 / screenWidth);
  }

  if (duration < total) {
    total = Math.max(2, Math.floor(duration));
  }

  return total;
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
