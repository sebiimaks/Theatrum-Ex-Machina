import type { ImageElement } from './final-object.interface';

export type ParsedLocalDateTime = number | null | undefined;

/**
 * Date Added is stored as an absolute Unix timestamp in milliseconds. Legacy
 * catalogues legitimately omit it, so unknown and malformed values remain
 * distinguishable from a real timestamp.
 */
export function normalizeDateAdded(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }

  return Number.isFinite(new Date(value).getTime()) ? value : undefined;
}

export function ensureDateAddedForNewEntry(
  element: ImageElement,
  now = Date.now(),
): number {
  const existingValue = normalizeDateAdded(element.dateAdded);
  if (existingValue !== undefined) {
    return existingValue;
  }

  const timestamp = normalizeDateAdded(now);
  if (timestamp === undefined) {
    throw new Error('Cannot assign an invalid Date Added timestamp.');
  }

  element.dateAdded = timestamp;
  return timestamp;
}

/**
 * Metadata recovery represents the same catalogue entry, not a new addition.
 * An unknown legacy value must therefore remain unknown rather than becoming
 * the time at which a rescan happened.
 */
export function inheritDateAdded(
  destination: ImageElement,
  origin: ImageElement,
): void {
  const timestamp = normalizeDateAdded(origin.dateAdded);

  if (timestamp === undefined) {
    delete destination.dateAdded;
    return;
  }

  destination.dateAdded = timestamp;
}

function sourceIndicesMatch(left: unknown, right: unknown): boolean {
  const leftIndex = Number(left);
  const rightIndex = Number(right);
  return Number.isInteger(leftIndex) && leftIndex === rightIndex;
}

function fileStatIdentityMatches(left: ImageElement, right: ImageElement): boolean {
  return Number.isFinite(left.birthtime)
    && Number.isFinite(left.fileSize)
    && Number.isFinite(left.mtime)
    && left.birthtime === right.birthtime
    && left.fileSize === right.fileSize
    && left.mtime === right.mtime;
}

function isImportErrorEntry(element: ImageElement): boolean {
  return element.metadataImportFailed === true || element.tags?.includes('import_error') === true;
}

/**
 * Find one prior deleted entry whose metadata can be inherited safely after an
 * external rename or move. A unique hash wins; duplicate hashes require one
 * unique file-stat match. Failed imports use file-stat identity because their
 * fallback hash intentionally includes the old path.
 */
export function findDeletedMetadataOrigin(
  incoming: ImageElement,
  catalogue: ImageElement[],
): ImageElement | undefined {
  const candidates = catalogue.filter((candidate: ImageElement) => candidate.deleted === true);
  const hashMatches = incoming.hash
    ? candidates.filter((candidate: ImageElement) => candidate.hash === incoming.hash)
    : [];

  if (hashMatches.length === 1) {
    return hashMatches[0];
  }
  if (hashMatches.length > 1) {
    const statMatches = hashMatches.filter((candidate: ImageElement) => (
      fileStatIdentityMatches(candidate, incoming)
    ));
    if (statMatches.length === 1) {
      return statMatches[0];
    }
    if (statMatches.length > 1) {
      const sameSourceStatMatches = statMatches.filter((candidate: ImageElement) => (
        sourceIndicesMatch(candidate.inputSource, incoming.inputSource)
      ));
      return sameSourceStatMatches.length === 1 ? sameSourceStatMatches[0] : undefined;
    }

    return undefined;
  }

  const movedImportErrorMatches = candidates.filter((candidate: ImageElement) => (
    isImportErrorEntry(candidate) && fileStatIdentityMatches(candidate, incoming)
  ));
  if (movedImportErrorMatches.length === 1) {
    return movedImportErrorMatches[0];
  }

  const sameSourceImportErrorMatches = movedImportErrorMatches.filter((candidate: ImageElement) => (
    sourceIndicesMatch(candidate.inputSource, incoming.inputSource)
  ));
  return sameSourceImportErrorMatches.length === 1 ? sameSourceImportErrorMatches[0] : undefined;
}

/**
 * Standard Array.sort comparator with unknown legacy dates kept last for both
 * directions. True means oldest first; false means newest first.
 */
export function compareDateAdded(
  left: unknown,
  right: unknown,
  ascending: boolean,
): number {
  const leftTimestamp = normalizeDateAdded(left);
  const rightTimestamp = normalizeDateAdded(right);

  if (leftTimestamp === undefined && rightTimestamp === undefined) {
    return 0;
  }
  if (leftTimestamp === undefined) {
    return 1;
  }
  if (rightTimestamp === undefined) {
    return -1;
  }
  if (leftTimestamp === rightTimestamp) {
    return 0;
  }

  return ascending
    ? (leftTimestamp < rightTimestamp ? -1 : 1)
    : (leftTimestamp > rightTimestamp ? -1 : 1);
}

export function latestDateAdded(values: unknown[]): number | undefined {
  let latest: number | undefined;

  values.forEach((value: unknown) => {
    const timestamp = normalizeDateAdded(value);
    if (timestamp !== undefined && (latest === undefined || timestamp > latest)) {
      latest = timestamp;
    }
  });

  return latest;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

/** Format a stored instant for an HTML datetime-local control. */
export function formatDateAddedForInput(value: unknown): string {
  const timestamp = normalizeDateAdded(value);
  if (timestamp === undefined) {
    return '';
  }

  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    '-',
    padDatePart(date.getMonth() + 1),
    '-',
    padDatePart(date.getDate()),
    'T',
    padDatePart(date.getHours()),
    ':',
    padDatePart(date.getMinutes()),
  ].join('');
}

/**
 * Parse an HTML datetime-local value without treating it as UTC. Undefined is
 * an intentional blank; null is malformed or outside the supported range.
 */
export function parseDateAddedInput(value: string): ParsedLocalDateTime {
  const draft = value.trim();
  if (!draft) {
    return undefined;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(draft);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);

  if (year < 1970) {
    return null;
  }

  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  const timestamp = date.getTime();

  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second
    || normalizeDateAdded(timestamp) === undefined
  ) {
    return null;
  }

  return timestamp;
}

export function formatDateAddedForDisplay(value: unknown): string {
  const timestamp = normalizeDateAdded(value);
  if (timestamp === undefined) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZoneName: 'short',
    year: 'numeric',
  }).format(new Date(timestamp));
}
