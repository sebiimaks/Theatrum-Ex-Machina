export const FULL_VIEW_BUFFER_AMOUNT = 5;

export interface FullViewLayout {
  computedWidth: number;
  rowOffsets: number[];
}

/**
 * Keep a small number of neighbouring rows mounted for the views whose
 * contents are expensive to recreate or whose height varies by video.
 */
export function getVirtualScrollBufferAmount(view: string): number {
  if (view === 'showFullView') {
    return FULL_VIEW_BUFFER_AMOUNT;
  }

  return 0;
}

/**
 * Calculate Full View geometry only when both dimensions are ready. This
 * prevents a transient NaN or zero-width layout from being measured and
 * cached by the virtual scroller during view changes and resizes.
 */
export function calculateFullViewLayout(
  galleryWidth: number,
  imageHeight: number,
  screenshotCount: number,
): FullViewLayout {
  if (
       !Number.isFinite(galleryWidth)
    || !Number.isFinite(imageHeight)
    || galleryWidth <= 0
    || imageHeight <= 0
  ) {
    return { computedWidth: 0, rowOffsets: [] };
  }

  const imageWidth = imageHeight * 16 / 9;
  const imagesPerRow = Math.max(Math.floor(galleryWidth / imageWidth), 1);
  const safeScreenshotCount = Number.isFinite(screenshotCount)
    ? Math.max(Math.floor(screenshotCount), 0)
    : 0;
  const numberOfRows = Math.ceil(safeScreenshotCount / imagesPerRow);

  return {
    computedWidth: imageWidth * imagesPerRow,
    rowOffsets: Array.from({ length: numberOfRows }, (_, index) => index * imagesPerRow),
  };
}
