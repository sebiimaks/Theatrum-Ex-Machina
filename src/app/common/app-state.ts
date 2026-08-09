import type { SortType } from '../pipes/sorting.pipe';
import type { SupportedView } from '../../../interfaces/shared-interfaces';

// Please conform the supported languages exactly to the first two characters from here:
// https://github.com/electron/electron/blob/master/docs/api/locales.md
export type SupportedLanguage =
  'en'
| 'ar'
| 'bn'
| 'cs'
| 'de'
| 'es'
| 'fr'
| 'hi'
| 'it'
| 'ja'
| 'ko'
| 'ms'
| 'nl'
| 'pl'
| 'pt'
| 'ru'
| 'tr'
| 'uk'
| 'vi'
| 'zh';

export interface RowNumbers {
  thumbnailSheet: number;
  showThumbnails: number;
  showFilmstrip: number;
  showFullView: number;
  showDetails: number;
  showDetails2: number;
  showClips: number;
}

export const DefaultImagesPerRow: RowNumbers = {
  thumbnailSheet: 5,
  showThumbnails: 5,
  showFilmstrip: 5,
  showFullView: 5,
  showDetails: 4,
  showDetails2: 4,
  showClips: 4,
};

/**
 * Preserve an explicitly saved preference while keeping the historical
 * scan-on-addition behaviour for settings written before the option existed.
 */
export function normalizeScanFoldersOnAddition(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

/**
 * Older settings files predate the independent preview-generation option.
 * Preserve the historical behaviour for those users while retaining an
 * explicitly saved choice.
 */
export function normalizeGeneratePreviewsOnFolderAddition(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

/**
 * Empty source subdirectories were historically shown in the Current Hub
 * folder tree, so legacy and malformed settings keep that presentation.
 */
export function normalizeHideSubdirectoriesWithNoVideos(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

export const AppState: AppStateInterface = { // AppState is saved into `settings.json` so it persists
  addtionalExtensions: '',
  currentSort: 'default',
  currentVhaFile: '',  // full path to the catalogue file -- TODO: rename to `currentVhaFilePath`
  currentView: 'showThumbnails',
  currentZoomLevel: 1,
  generatePreviewsOnFolderAddition: true,
  hideSubdirectoriesWithNoVideos: false,
  hubName: '',
  imgsPerRow: DefaultImagesPerRow,
  language: 'en',
  menuHidden: false,
  numOfFolders: 0,
  port: 3000,
  preferredVideoPlayer: '',
  scanFoldersOnAddition: true,
  selectedOutputFolder: '',
  sortTagsByFrequency: false,
  videoPlayerArgs: '',
};

export interface AppStateInterface {
  addtionalExtensions: string;
  currentSort: SortType;
  currentVhaFile: string;
  currentView: SupportedView;
  currentZoomLevel: number;
  generatePreviewsOnFolderAddition: boolean;
  hideSubdirectoriesWithNoVideos: boolean;
  hubName: string;
  imgsPerRow: RowNumbers;
  language: SupportedLanguage;
  menuHidden: boolean;
  numOfFolders: number;
  port: number;
  preferredVideoPlayer: string;
  scanFoldersOnAddition: boolean;
  selectedOutputFolder: string;
  sortTagsByFrequency: boolean; // when `false` sort tags alphabetically
  videoPlayerArgs: string;
}
