import type { SupportedView } from '../../../interfaces/shared-interfaces';

export const GALLERY_SCROLLBAR_ALLOWANCE = 14;
export const COMPACT_CARD_MARGIN = 4;
export const STANDARD_CARD_MARGIN = 40;
export const FILMSTRIP_INSET = 30;
export const RELATED_PREVIEW_COLUMNS = 5;
export const RELATED_PREVIEW_MAX_WIDTH = 176;
export const RELATED_PREVIEW_MAX_HEIGHT = 144;
export const WIDESCREEN_HEIGHT_RATIO = 9 / 16;

export interface GalleryGeometryInput {
  compactView: boolean;
  containerWidth: number;
  currentPreviewWidth?: number;
  imagesPerRow: number;
  relatedTrayVisible: boolean;
  view: SupportedView;
}

/**
 * Only fields that the legacy layout calculation assigns are returned.
 * Callers merge these values into their current state so views that
 * intentionally retain prior geometry continue to do so.
 */
export interface GalleryGeometryResult {
  galleryWidth?: number;
  previewHeight?: number;
  previewHeightRelated?: number;
  previewWidth?: number;
  previewWidthRelated?: number;
}

export interface GalleryTextPaddingInput {
  compactView: boolean;
  showMoreInfo: boolean;
  view: SupportedView;
}

const MARGIN_BASED_VIEWS: ReadonlySet<SupportedView> = new Set([
  'showClips',
  'showDetails',
  'showDetails2',
  'showThumbnails',
]);

const INSET_BASED_VIEWS: ReadonlySet<SupportedView> = new Set([
  'showFilmstrip',
  'showFullView',
]);

/**
 * Calculate gallery dimensions without reading the DOM or scheduling a render.
 * Invalid transient measurements produce no assignments, allowing the last
 * stable geometry to remain visible while the gallery settles.
 */
export function calculateGalleryGeometry(
  input: GalleryGeometryInput,
): GalleryGeometryResult {
  if (
       !Number.isFinite(input.containerWidth)
    || !Number.isFinite(input.imagesPerRow)
    || input.containerWidth <= GALLERY_SCROLLBAR_ALLOWANCE
    || input.imagesPerRow <= 0
  ) {
    return {};
  }

  const galleryWidth = input.containerWidth - GALLERY_SCROLLBAR_ALLOWANCE;
  const result: GalleryGeometryResult = { galleryWidth };
  let previewWidth = input.currentPreviewWidth;

  if (MARGIN_BASED_VIEWS.has(input.view)) {
    const margin = input.compactView ? COMPACT_CARD_MARGIN : STANDARD_CARD_MARGIN;
    previewWidth = (galleryWidth / input.imagesPerRow) - margin;
    result.previewWidth = previewWidth;
  } else if (INSET_BASED_VIEWS.has(input.view)) {
    previewWidth = (galleryWidth - FILMSTRIP_INSET) / input.imagesPerRow;
    result.previewWidth = previewWidth;
  }

  // File view historically retains the previous preview width but refreshes
  // its corresponding height. Preserve that state transition explicitly.
  if (previewWidth !== undefined && Number.isFinite(previewWidth)) {
    result.previewHeight = previewWidth * WIDESCREEN_HEIGHT_RATIO;
  }

  if (input.relatedTrayVisible) {
    result.previewWidthRelated = Math.min(
      (galleryWidth / RELATED_PREVIEW_COLUMNS) - STANDARD_CARD_MARGIN,
      RELATED_PREVIEW_MAX_WIDTH,
    );
    result.previewHeightRelated = Math.min(
      result.previewWidthRelated * WIDESCREEN_HEIGHT_RATIO,
      RELATED_PREVIEW_MAX_HEIGHT,
    );
  }

  return result;
}

/**
 * Return no assignment for views whose padding is intentionally retained.
 */
export function calculateGalleryTextPadding(
  input: GalleryTextPaddingInput,
): number | undefined {
  switch (input.view) {
    case 'showThumbnails':
    case 'showClips':
      if (input.compactView) {
        return 0;
      }
      return input.showMoreInfo ? 55 : 20;

    case 'showFilmstrip':
      if (input.compactView) {
        return 0;
      }
      return input.showMoreInfo ? 20 : 0;

    case 'showFiles':
      return 20;

    case 'showDetails':
    case 'showDetails2':
    case 'showFullView':
      return undefined;
  }
}
