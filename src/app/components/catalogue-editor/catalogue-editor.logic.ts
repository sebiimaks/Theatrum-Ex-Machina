import type { ImageElement, StarRating } from '../../../../interfaces/final-object.interface';
import {
  formatDateAddedForDisplay,
  formatDateAddedForInput,
  parseDateAddedInput,
} from '../../../../interfaces/date-added';

export type CatalogueSearchField = 'all' | 'name' | 'file' | 'path' | 'tags' | 'hash';
export type CatalogueSearchOperator = 'contains' | 'doesNotContain';
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

    return activeCriteria.every((criterion: {
      field: CatalogueSearchField;
      needle: string;
      operator: CatalogueSearchOperator;
    }) => {
      const fieldContainsQuery = getCatalogueSearchText(item, criterion.field).includes(criterion.needle);

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

function getCatalogueSearchText(item: ImageElement, field: CatalogueSearchField): string {
  const tags = (item.tags || []).join(' ');

  if (field === 'name') {
    return (item.cleanName || '').toLowerCase();
  } else if (field === 'file') {
    return (item.fileName || '').toLowerCase();
  } else if (field === 'path') {
    return (item.partialPath || '').toLowerCase();
  } else if (field === 'tags') {
    return tags.toLowerCase();
  } else if (field === 'hash') {
    return (item.hash || '').toLowerCase();
  }

  return [
    item.cleanName,
    item.fileName,
    item.partialPath,
    tags,
    item.hash,
    item.inputSource,
    formatDateAddedForInput(item.dateAdded).replace('T', ' '),
    item.notes,
    item.year,
  ].join(' ').toLowerCase();
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
