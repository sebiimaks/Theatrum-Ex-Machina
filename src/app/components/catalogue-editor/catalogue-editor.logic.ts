import type { ImageElement, StarRating } from '../../../../interfaces/final-object.interface';
import { isMetadataImportFailure } from '../../../../interfaces/final-object.interface';
import {
  formatDateAddedForDisplay,
  formatDateAddedForInput,
  normalizeDateAdded,
  parseDateAddedInput,
} from '../../../../interfaces/date-added';

export type CatalogueSearchField =
  | 'all'
  | 'name'
  | 'file'
  | 'path'
  | 'tags'
  | 'stars'
  | 'year'
  | 'dateAdded'
  | 'timesPlayed'
  | 'defaultScreen'
  | 'notes'
  | 'entryNumber'
  | 'source'
  | 'duration'
  | 'resolution'
  | 'fileSize'
  | 'fps'
  | 'status'
  | 'hash';
export type CatalogueSearchOperator = 'contains' | 'doesNotContain';
export type CatalogueAvailabilityFilter = 'all' | 'available' | 'missing';
export type CatalogueOverwriteField = 'cleanName' | 'dateAdded' | 'stars' | 'year' | 'timesPlayed' | 'defaultScreen' | 'notes';
export type CatalogueOverwriteValue = number | string | undefined;

export interface CatalogueSearchCriterion {
  field: CatalogueSearchField;
  id: number;
  operator: CatalogueSearchOperator;
  query: string;
}

export interface CatalogueOverwriteValidation {
  action: 'clear' | 'overwrite';
  displayValue: string;
  error?: string;
  valid: boolean;
  value?: CatalogueOverwriteValue;
}

export interface MetadataImportSaveNotice {
  complete: boolean;
  error: boolean;
  message: string;
}

const starValues: StarRating[] = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];

export const catalogueOverwriteFieldLabels: Record<CatalogueOverwriteField, string> = {
  cleanName: 'Clean Name',
  dateAdded: 'Date Added',
  defaultScreen: 'Default Screen',
  notes: 'Notes',
  stars: 'Stars',
  timesPlayed: 'Times Played',
  year: 'Year',
};

export function resolveMetadataImportSaveNotice(
  saveStatus: unknown,
  importSummary: string,
): MetadataImportSaveNotice | undefined {
  if (typeof saveStatus !== 'string') {
    return undefined;
  }
  if (saveStatus === 'Saved') {
    return { complete: true, error: false, message: '' };
  }
  if (saveStatus.toLowerCase().startsWith('save failed')) {
    return {
      complete: false,
      error: true,
      message: `${importSummary}. Changes remain unsaved. ${saveStatus}.`,
    };
  }

  return undefined;
}

export function applyCatalogueOverwrite(
  entries: ImageElement[],
  field: CatalogueOverwriteField,
  value: CatalogueOverwriteValue,
): number {
  let updatedEntryCount = 0;

  entries.forEach((item: ImageElement) => {
    let changed = false;

    if (field === 'cleanName' && typeof value === 'string' && item.cleanName !== value) {
      item.cleanName = value;
      changed = true;
    } else if (field === 'dateAdded') {
      changed = setOptionalNumber(item, 'dateAdded', value);
    } else if (field === 'stars' && typeof value === 'number' && item.stars !== value) {
      item.stars = value as StarRating;
      changed = true;
    } else if (field === 'timesPlayed' && typeof value === 'number' && item.timesPlayed !== value) {
      item.timesPlayed = value;
      changed = true;
    } else if (field === 'year') {
      changed = setOptionalNumber(item, 'year', value);
    } else if (field === 'defaultScreen') {
      changed = setOptionalNumber(item, 'defaultScreen', value);
    } else if (field === 'notes') {
      changed = setOptionalString(item, 'notes', value);
    }

    if (changed) {
      updatedEntryCount++;
    }
  });

  return updatedEntryCount;
}

export function filterCatalogueEntries(
  images: ImageElement[],
  criteria: CatalogueSearchCriterion[],
  showDeleted: boolean,
  availabilityFilter: CatalogueAvailabilityFilter = 'all',
): ImageElement[] {
  const activeCriteria = criteria
    .map((criterion: CatalogueSearchCriterion) => ({
      field: criterion.field,
      needle: criterion.query.trim().toLowerCase(),
      operator: criterion.operator,
    }))
    .filter((criterion: { field: CatalogueSearchField; needle: string; operator: CatalogueSearchOperator }) => (
      Boolean(criterion.needle)
    ));

  return images.filter((item: ImageElement) => {
    if (!showDeleted && item.deleted) {
      return false;
    }

    if (availabilityFilter === 'available' && item.missing === true) {
      return false;
    }

    const temporarilyUnavailable = !item.deleted && item.missing === true;

    if (availabilityFilter === 'missing' && !temporarilyUnavailable) {
      return false;
    }

    return activeCriteria.every((criterion: {
      field: CatalogueSearchField;
      needle: string;
      operator: CatalogueSearchOperator;
    }) => {
      const fieldContainsQuery = getCatalogueSearchAliases(item, criterion.field).some(
        (alias: string) => alias.includes(criterion.needle)
      );

      return criterion.operator === 'doesNotContain'
        ? !fieldContainsQuery
        : fieldContainsQuery;
    });
  });
}

export function validateCatalogueOverwrite(
  field: CatalogueOverwriteField,
  draft: string,
  entries: ImageElement[],
): CatalogueOverwriteValidation {
  const trimmedDraft = draft.trim();

  if (field === 'cleanName') {
    if (!trimmedDraft) {
      return invalidOverwrite('Clean Name cannot be blank.');
    }

    return validOverwrite(trimmedDraft);
  }

  if (field === 'notes') {
    return trimmedDraft
      ? validOverwrite(draft)
      : validClear();
  }

  if (field === 'dateAdded') {
    const parsedDate = parseDateAddedInput(draft);

    if (parsedDate === undefined) {
      return validClear();
    }
    if (parsedDate === null) {
      return invalidOverwrite('Enter a valid local date and time from 1970 onwards.');
    }

    return validOverwrite(parsedDate, formatDateAddedForDisplay(parsedDate));
  }

  if (field === 'stars') {
    const parsedStar = Number(trimmedDraft) as StarRating;

    if (!starValues.includes(parsedStar)) {
      return invalidOverwrite('Select a valid star rating.');
    }

    const displayValue = parsedStar === 0.5 ? 'N/A' : String(parsedStar - 0.5);
    return validOverwrite(parsedStar, displayValue);
  }

  const optionalField = field === 'year' || field === 'defaultScreen';

  if (!trimmedDraft) {
    return optionalField
      ? validClear()
      : invalidOverwrite('Times Played requires a value.');
  }

  if (!/^\d+$/.test(trimmedDraft)) {
    return invalidOverwrite(`${catalogueOverwriteFieldLabels[field]} must be a non-negative whole number.`);
  }

  const parsedNumber = Number(trimmedDraft);

  if (!Number.isSafeInteger(parsedNumber)) {
    return invalidOverwrite(`${catalogueOverwriteFieldLabels[field]} is too large.`);
  }

  if (field === 'defaultScreen') {
    const invalidEntryCount = entries.filter((item: ImageElement) => parsedNumber >= item.screens).length;

    if (invalidEntryCount > 0) {
      const entryLabel = invalidEntryCount === 1 ? 'entry does' : 'entries do';
      return invalidOverwrite(
        `${invalidEntryCount} displayed ${entryLabel} not have screen ${parsedNumber}. Choose a lower screen or narrow the results.`
      );
    }
  }

  return validOverwrite(parsedNumber);
}

function formatDurationSearchAliases(value: unknown): string[] {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return [];
  }

  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor(wholeSeconds / 60) % 60;
  const remainingSeconds = wholeSeconds % 60;
  const displayed = hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;

  return [displayed, String(seconds), `${seconds} seconds`];
}

function formatFileSizeSearchAliases(value: unknown): string[] {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return [];
  }

  const formatSize = (megabytes: number, gigabyteDivisor: number): string => {
    if (megabytes > 999000) {
      return `${(megabytes / gigabyteDivisor / gigabyteDivisor).toFixed(1)} TB`;
    }
    if (megabytes > 999) {
      return `${(megabytes / gigabyteDivisor).toFixed(1)} GB`;
    }
    return `${megabytes} MB`;
  };
  const decimalMegabytes = Math.round(bytes / 1000000);
  const binaryMegabytes = Math.round(bytes / 1048576);

  return [
    `${bytes} bytes`,
    formatSize(decimalMegabytes, 1000),
    formatSize(binaryMegabytes, 1024),
  ];
}

function formatDateAddedSearchAliases(value: unknown): string[] {
  const timestamp = normalizeDateAdded(value);
  if (timestamp === undefined) {
    return ['unknown', 'not set'];
  }

  return [
    formatDateAddedForInput(timestamp).replace('T', ' '),
    formatDateAddedForDisplay(timestamp),
  ];
}

function formatStarsSearchAliases(value: unknown): string[] {
  const stars = Number(value);
  if (stars === 0.5) {
    return ['n/a', 'not rated'];
  }
  if (!starValues.includes(stars as StarRating)) {
    return [];
  }

  const displayedStars = stars - 0.5;
  return [String(displayedStars), `${displayedStars} ${displayedStars === 1 ? 'star' : 'stars'}`];
}

function formatStatusSearchAliases(item: ImageElement): string[] {
  const statuses: string[] = [];
  if (item.deleted) {
    statuses.push('pending deletion', 'deleted');
  } else if (item.missing) {
    statuses.push('temporarily unavailable', 'missing');
  } else {
    statuses.push('available');
  }
  if (isMetadataImportFailure(item)) {
    statuses.push('import error');
  }

  return statuses;
}

function getCatalogueSearchAliases(item: ImageElement, field: CatalogueSearchField): string[] {
  const tags = (item.tags || []).join(' ');
  const entryNumber = item.index + 1;
  const values: Record<Exclude<CatalogueSearchField, 'all'>, string[]> = {
    dateAdded: formatDateAddedSearchAliases(item.dateAdded),
    defaultScreen: item.defaultScreen === undefined
      ? ['unknown', 'not set']
      : [String(item.defaultScreen)],
    duration: formatDurationSearchAliases(item.duration),
    entryNumber: [String(entryNumber), `#${entryNumber}`, `entry ${entryNumber}`],
    file: [String(item.fileName || '')],
    fileSize: formatFileSizeSearchAliases(item.fileSize),
    fps: [String(item.fps || 0), `${item.fps || 0} fps`],
    hash: item.hash ? [String(item.hash)] : ['no hash available'],
    name: [String(item.cleanName || '')],
    notes: [String(item.notes || '')],
    path: item.partialPath ? [String(item.partialPath)] : ['root'],
    resolution: [
      `${item.width} x ${item.height}`,
      `${item.width}x${item.height}`,
      String(item.resolution || ''),
    ],
    source: [String(item.inputSource), `source ${item.inputSource}`],
    stars: formatStarsSearchAliases(item.stars),
    status: formatStatusSearchAliases(item),
    tags: [tags],
    timesPlayed: [String(item.timesPlayed), `${item.timesPlayed} times played`],
    year: item.year === undefined ? ['unknown', 'not set'] : [String(item.year)],
  };

  const aliases = field === 'all' ? Object.values(values).flat() : values[field];
  return aliases.map((alias: string) => alias.toLowerCase());
}

function invalidOverwrite(error: string): CatalogueOverwriteValidation {
  return {
    action: 'overwrite',
    displayValue: '',
    error,
    valid: false,
  };
}

function setOptionalNumber(
  item: ImageElement,
  field: 'dateAdded' | 'defaultScreen' | 'year',
  value: CatalogueOverwriteValue,
): boolean {
  if (value === undefined) {
    if (item[field] === undefined) {
      return false;
    }

    delete item[field];
    return true;
  }

  if (typeof value === 'number' && item[field] !== value) {
    item[field] = value;
    return true;
  }

  return false;
}

function setOptionalString(
  item: ImageElement,
  field: 'notes',
  value: CatalogueOverwriteValue,
): boolean {
  if (value === undefined) {
    if (item[field] === undefined) {
      return false;
    }

    delete item[field];
    return true;
  }

  if (typeof value === 'string' && item[field] !== value) {
    item[field] = value;
    return true;
  }

  return false;
}

function validClear(): CatalogueOverwriteValidation {
  return {
    action: 'clear',
    displayValue: 'Clear Field',
    valid: true,
    value: undefined,
  };
}

function validOverwrite(value: number | string, displayValue = String(value)): CatalogueOverwriteValidation {
  return {
    action: 'overwrite',
    displayValue,
    valid: true,
    value,
  };
}
