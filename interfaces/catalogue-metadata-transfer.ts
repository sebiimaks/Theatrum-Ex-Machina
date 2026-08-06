import type { ImageElement, StarRating } from './final-object.interface';
import { normalizeDateAdded } from './date-added';
import { normalizeNewTagPath, tagIdentityKey } from './tag-hierarchy';

export const CATALOGUE_METADATA_FORMAT = 'theatrum-ex-machina.catalogue-metadata';
export const CATALOGUE_METADATA_FORMAT_VERSION = 1;
export const CATALOGUE_METADATA_MAX_ENTRIES = 200000;
export const CATALOGUE_METADATA_MAX_BYTES = 50 * 1024 * 1024;

export const catalogueMetadataCategories = [
  'stars',
  'year',
  'dateAdded',
  'timesPlayed',
  'tags',
  'notes',
] as const;

export type CatalogueMetadataCategory = typeof catalogueMetadataCategories[number];
export type PortableStarRating = 1 | 2 | 3 | 4 | 5 | null;

export const catalogueMetadataCategoryLabels: Record<CatalogueMetadataCategory, string> = {
  dateAdded: 'Date Added',
  notes: 'Notes',
  stars: 'Stars',
  tags: 'Tags',
  timesPlayed: 'Times Played',
  year: 'Year',
};

export interface CatalogueMetadataEntry {
  fileName: string;
  hash: string;
  stars: PortableStarRating;
  year: number | null;
  dateAdded: string | null;
  timesPlayed: number;
  tags: string[];
  notes: string | null;
}

export interface CatalogueMetadataDocument {
  format: typeof CATALOGUE_METADATA_FORMAT;
  formatVersion: typeof CATALOGUE_METADATA_FORMAT_VERSION;
  exportedAt: string;
  instructions: string[];
  entries: CatalogueMetadataEntry[];
}

export interface CatalogueMetadataExportResult {
  ambiguousHashEntryCount: number;
  deletedEntryCount: number;
  document: CatalogueMetadataDocument;
  missingHashEntryCount: number;
}

interface CatalogueMetadataImportEntry {
  fileName: string;
  hash: string;
  stars?: StarRating;
  year?: number | null;
  dateAdded?: number | null;
  timesPlayed?: number;
  tags?: string[];
  notes?: string | null;
}

export interface CatalogueMetadataUpdate {
  stars?: StarRating;
  year?: number | null;
  dateAdded?: number | null;
  timesPlayed?: number;
  tags?: string[];
  notes?: string | null;
}

export interface CatalogueMetadataImportChange {
  target: ImageElement;
  updates: CatalogueMetadataUpdate;
}

export interface CatalogueMetadataImportPlan {
  ambiguousCatalogueRecordCount: number;
  categories: CatalogueMetadataCategory[];
  changedEntryCount: number;
  changedFieldCount: number;
  changes: CatalogueMetadataImportChange[];
  duplicateHashRecordCount: number;
  entriesRead: number;
  matchedRecordCount: number;
  missingHashRecordCount: number;
  outsideScopeRecordCount: number;
  unmatchedRecordCount: number;
}

export interface CatalogueMetadataImportResult {
  starsChanged: boolean;
  tagsChanged: boolean;
  updatedEntryCount: number;
  updatedFieldCount: number;
}

const exportInstructions = [
  'Hash is the only import match key. Keep it unchanged; File Name is for reference only.',
  'Choose the metadata categories to import in the Catalogue JSON Editor.',
  'Use null to clear Stars, Year, Date Added, or Notes, and use an empty array to clear Tags.',
  'If a selected category is omitted from an entry, its existing value remains unchanged.',
  'Date Added uses an absolute ISO 8601 timestamp with a timezone.',
];

const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function isCatalogueMetadataImportTarget(item: ImageElement): boolean {
  return !item.deleted
    && item.cleanName !== '*FOLDER*'
    && typeof item.hash === 'string'
    && Boolean(item.hash.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function requireString(value: unknown, label: string, maximumLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be text.`);
  }

  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw new Error(`${label} cannot be blank.`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${label} is too long.`);
  }

  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative whole number.`);
  }

  return Number(value);
}

function normalizePortableStars(value: unknown, label: string): PortableStarRating {
  if (value === null) {
    return null;
  }
  if (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5) {
    return Number(value) as Exclude<PortableStarRating, null>;
  }

  throw new Error(`${label} must be null or a whole number from 1 to 5.`);
}

function normalizeOptionalYear(value: unknown, label: string): number | null {
  return value === null ? null : requireNonNegativeInteger(value, label);
}

function normalizeIsoDate(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} must be null or an ISO 8601 date and time with a timezone.`);
  }

  const timestamp = Date.parse(value);
  if (normalizeDateAdded(timestamp) === undefined) {
    throw new Error(`${label} is not a valid date and time.`);
  }

  return new Date(timestamp).toISOString();
}

function normalizeTags(
  value: unknown,
  label: string,
  normalizeHierarchyPaths = false,
  catalogueTagSpellings: Map<string, string> = new Map<string, string>(),
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of text values.`);
  }
  if (value.length > 1000) {
    throw new Error(`${label} contains too many tags.`);
  }

  const tags: string[] = [];
  const seen = new Set<string>();

  value.forEach((tag: unknown, index: number) => {
    const storedValue = requireString(tag, `${label} item ${index + 1}`, 500).trim();
    if (/[,\r\n]/.test(storedValue)) {
      throw new Error(`${label} item ${index + 1} cannot contain commas or line breaks.`);
    }
    const establishedSpelling = catalogueTagSpellings.get(tagIdentityKey(storedValue));
    let normalized = establishedSpelling || storedValue;
    if (normalizeHierarchyPaths && establishedSpelling === undefined) {
      try {
        normalized = normalizeNewTagPath(storedValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tag is invalid.';
        throw new Error(`${label} item ${index + 1} is invalid: ${message}`);
      }
    }
    const key = tagIdentityKey(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(normalized);
    }
  });

  return tags;
}

function normalizeNotes(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be null or text.`);
  }
  if (value.length > 1000000) {
    throw new Error(`${label} is too long.`);
  }

  return value || null;
}

function portableStarsFromImage(value: unknown): PortableStarRating {
  const portable = typeof value === 'number' ? value - 0.5 : 0;
  return Number.isInteger(portable) && portable >= 1 && portable <= 5
    ? portable as Exclude<PortableStarRating, null>
    : null;
}

function internalStarsFromPortable(value: PortableStarRating): StarRating {
  return value === null ? 0.5 : (value + 0.5) as StarRating;
}

function tagsFromImage(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return normalizeTags(value.filter((tag: unknown) => typeof tag === 'string'), 'Tags');
}

function normalizeExportEntry(value: unknown, index: number): CatalogueMetadataEntry {
  const record = requireRecord(value, `Entry ${index + 1}`);
  const fileName = requireString(record.fileName, `Entry ${index + 1} File Name`, 4096, true);
  const hash = requireString(record.hash, `Entry ${index + 1} Hash`, 512).trim();

  return {
    fileName,
    hash,
    stars: normalizePortableStars(record.stars, `${fileName || `Entry ${index + 1}`} Stars`),
    year: normalizeOptionalYear(record.year, `${fileName || `Entry ${index + 1}`} Year`),
    dateAdded: normalizeIsoDate(record.dateAdded, `${fileName || `Entry ${index + 1}`} Date Added`),
    timesPlayed: requireNonNegativeInteger(record.timesPlayed, `${fileName || `Entry ${index + 1}`} Times Played`),
    tags: normalizeTags(record.tags, `${fileName || `Entry ${index + 1}`} Tags`),
    notes: normalizeNotes(record.notes, `${fileName || `Entry ${index + 1}`} Notes`),
  };
}

function validateDocumentHeader(value: unknown): Record<string, unknown> {
  const document = requireRecord(value, 'Metadata document');
  if (document.format !== CATALOGUE_METADATA_FORMAT) {
    throw new Error('This is not a Theatrum Ex Machina metadata export.');
  }
  if (document.formatVersion !== CATALOGUE_METADATA_FORMAT_VERSION) {
    throw new Error(`Metadata format version ${String(document.formatVersion)} is not supported.`);
  }
  if (!Array.isArray(document.entries)) {
    throw new Error('Metadata document Entries must be an array.');
  }
  if (document.entries.length > CATALOGUE_METADATA_MAX_ENTRIES) {
    throw new Error(`Metadata document contains more than ${CATALOGUE_METADATA_MAX_ENTRIES} entries.`);
  }

  return document;
}

export function validateCatalogueMetadataExportDocument(value: unknown): CatalogueMetadataDocument {
  const document = validateDocumentHeader(value);
  const exportedAt = normalizeIsoDate(document.exportedAt, 'Exported At');
  if (exportedAt === null) {
    throw new Error('Exported At cannot be null.');
  }

  const entries = (document.entries as unknown[]).map(normalizeExportEntry);
  const hashes = new Set<string>();
  entries.forEach((entry: CatalogueMetadataEntry) => {
    if (hashes.has(entry.hash)) {
      throw new Error(`Metadata export contains the hash '${entry.hash}' more than once.`);
    }
    hashes.add(entry.hash);
  });

  return {
    entries,
    exportedAt,
    format: CATALOGUE_METADATA_FORMAT,
    formatVersion: CATALOGUE_METADATA_FORMAT_VERSION,
    instructions: exportInstructions.slice(),
  };
}

export function serializeCatalogueMetadataExport(value: unknown): string {
  return JSON.stringify(validateCatalogueMetadataExportDocument(value), null, 2) + '\n';
}

export function createCatalogueMetadataExport(
  images: ImageElement[],
  exportedAt = Date.now(),
): CatalogueMetadataExportResult {
  const activeEntries = images.filter((item: ImageElement) => !item.deleted && item.cleanName !== '*FOLDER*');
  const hashCounts = new Map<string, number>();
  let missingHashEntryCount = 0;

  activeEntries.forEach((item: ImageElement) => {
    const hash = typeof item.hash === 'string' ? item.hash.trim() : '';
    if (!hash) {
      missingHashEntryCount++;
      return;
    }
    hashCounts.set(hash, (hashCounts.get(hash) || 0) + 1);
  });

  let ambiguousHashEntryCount = 0;
  const entries: CatalogueMetadataEntry[] = [];

  activeEntries.forEach((item: ImageElement) => {
    const hash = typeof item.hash === 'string' ? item.hash.trim() : '';
    if (!hash) {
      return;
    }
    if ((hashCounts.get(hash) || 0) !== 1) {
      ambiguousHashEntryCount++;
      return;
    }

    const dateAdded = normalizeDateAdded(item.dateAdded);
    entries.push({
      dateAdded: dateAdded === undefined ? null : new Date(dateAdded).toISOString(),
      fileName: typeof item.fileName === 'string' ? item.fileName : '',
      hash,
      notes: typeof item.notes === 'string' && item.notes ? item.notes : null,
      stars: portableStarsFromImage(item.stars),
      tags: tagsFromImage(item.tags),
      timesPlayed: Number.isSafeInteger(item.timesPlayed) && item.timesPlayed >= 0 ? item.timesPlayed : 0,
      year: Number.isSafeInteger(item.year) && Number(item.year) >= 0 ? Number(item.year) : null,
    });
  });

  return {
    ambiguousHashEntryCount,
    deletedEntryCount: images.filter((item: ImageElement) => item.deleted).length,
    document: {
      entries,
      exportedAt: new Date(exportedAt).toISOString(),
      format: CATALOGUE_METADATA_FORMAT,
      formatVersion: CATALOGUE_METADATA_FORMAT_VERSION,
      instructions: exportInstructions.slice(),
    },
    missingHashEntryCount,
  };
}

export function normalizeCatalogueMetadataCategories(value: unknown): CatalogueMetadataCategory[] {
  if (!Array.isArray(value)) {
    throw new Error('Choose at least one metadata category.');
  }

  const selected = new Set<CatalogueMetadataCategory>();
  value.forEach((category: unknown) => {
    if (!catalogueMetadataCategories.includes(category as CatalogueMetadataCategory)) {
      throw new Error(`Unknown metadata category '${String(category)}'.`);
    }
    selected.add(category as CatalogueMetadataCategory);
  });

  const normalized = catalogueMetadataCategories.filter((category: CatalogueMetadataCategory) => selected.has(category));
  if (!normalized.length) {
    throw new Error('Choose at least one metadata category.');
  }

  return normalized;
}

function parseImportEntry(
  value: unknown,
  index: number,
  categories: CatalogueMetadataCategory[],
  catalogueTagSpellings: Map<string, string>,
): CatalogueMetadataImportEntry {
  const record = requireRecord(value, `Entry ${index + 1}`);
  const fileName = typeof record.fileName === 'string'
    ? requireString(record.fileName, `Entry ${index + 1} File Name`, 4096, true)
    : `Entry ${index + 1}`;
  const hash = typeof record.hash === 'string'
    ? requireString(record.hash, `${fileName} Hash`, 512, true).trim()
    : '';
  const entry: CatalogueMetadataImportEntry = { fileName, hash };

  categories.forEach((category: CatalogueMetadataCategory) => {
    if (!own(record, category)) {
      return;
    }

    if (category === 'stars') {
      entry.stars = internalStarsFromPortable(normalizePortableStars(record.stars, `${fileName} Stars`));
    } else if (category === 'year') {
      entry.year = normalizeOptionalYear(record.year, `${fileName} Year`);
    } else if (category === 'dateAdded') {
      const dateAdded = normalizeIsoDate(record.dateAdded, `${fileName} Date Added`);
      entry.dateAdded = dateAdded === null ? null : Date.parse(dateAdded);
    } else if (category === 'timesPlayed') {
      entry.timesPlayed = requireNonNegativeInteger(record.timesPlayed, `${fileName} Times Played`);
    } else if (category === 'tags') {
      entry.tags = normalizeTags(record.tags, `${fileName} Tags`, true, catalogueTagSpellings);
    } else if (category === 'notes') {
      entry.notes = normalizeNotes(record.notes, `${fileName} Notes`);
    }
  });

  return entry;
}

function parseCatalogueMetadataImport(
  json: string,
  categories: CatalogueMetadataCategory[],
  catalogueTagSpellings: Map<string, string>,
): CatalogueMetadataImportEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The selected metadata file is not valid JSON.');
  }

  const document = validateDocumentHeader(parsed);
  return (document.entries as unknown[]).map((entry: unknown, index: number) => (
    parseImportEntry(entry, index, categories, catalogueTagSpellings)
  ));
}

function arraysMatch(left: string[] | undefined, right: string[]): boolean {
  return left
    ? left.length === right.length && left.every((value: string, index: number) => value === right[index])
    : right.length === 0;
}

function establishedTagSpellings(images: ImageElement[]): Map<string, string> {
  const spellings = new Map<string, string>();
  images.forEach((item: ImageElement) => {
    (item.tags || []).forEach((tag: string) => {
      if (typeof tag === 'string' && tag && !spellings.has(tagIdentityKey(tag))) {
        spellings.set(tagIdentityKey(tag), tag);
      }
    });
  });
  return spellings;
}

function preserveEstablishedTagSpellings(
  incoming: string[],
  item: ImageElement,
  catalogueSpellings: Map<string, string>,
): string[] {
  const preferredSpellings = new Map(catalogueSpellings);
  (item.tags || []).forEach((tag: string) => {
    if (typeof tag === 'string' && tag) {
      preferredSpellings.set(tagIdentityKey(tag), tag);
    }
  });

  return incoming.map((tag: string) => preferredSpellings.get(tagIdentityKey(tag)) || tag);
}

function optionalValueMatches(current: unknown, incoming: unknown): boolean {
  return incoming === null ? current === undefined : current === incoming;
}

function buildUpdates(
  item: ImageElement,
  entry: CatalogueMetadataImportEntry,
  categories: CatalogueMetadataCategory[],
  catalogueTagSpellings: Map<string, string>,
): { changedFieldCount: number; updates: CatalogueMetadataUpdate } {
  const updates: CatalogueMetadataUpdate = {};
  let changedFieldCount = 0;

  categories.forEach((category: CatalogueMetadataCategory) => {
    if (!own(entry, category)) {
      return;
    }

    const incoming = category === 'tags'
      ? preserveEstablishedTagSpellings(entry.tags || [], item, catalogueTagSpellings)
      : entry[category];
    let changed = false;
    if (category === 'tags') {
      changed = !arraysMatch(item.tags, incoming as string[]);
    } else if (category === 'year' || category === 'dateAdded' || category === 'notes') {
      changed = !optionalValueMatches(item[category], incoming);
    } else {
      changed = item[category] !== incoming;
    }

    if (changed) {
      (updates as Record<string, unknown>)[category] = incoming;
      changedFieldCount++;
    }
  });

  return { changedFieldCount, updates };
}

export function buildCatalogueMetadataImportPlan(
  images: ImageElement[],
  json: string,
  selectedCategories: unknown,
  eligibleTargets: ImageElement[] = images,
): CatalogueMetadataImportPlan {
  const categories = normalizeCatalogueMetadataCategories(selectedCategories);
  const catalogueTagSpellings = establishedTagSpellings(images);
  const importedEntries = parseCatalogueMetadataImport(json, categories, catalogueTagSpellings);
  const importedHashCounts = new Map<string, number>();
  const eligibleTargetSet = new Set(eligibleTargets);

  importedEntries.forEach((entry: CatalogueMetadataImportEntry) => {
    if (entry.hash) {
      importedHashCounts.set(entry.hash, (importedHashCounts.get(entry.hash) || 0) + 1);
    }
  });

  const catalogueByHash = new Map<string, ImageElement[]>();
  images
    .filter(isCatalogueMetadataImportTarget)
    .forEach((item: ImageElement) => {
      const hash = item.hash.trim();
      const entries = catalogueByHash.get(hash) || [];
      entries.push(item);
      catalogueByHash.set(hash, entries);
    });

  const changes: CatalogueMetadataImportChange[] = [];
  let ambiguousCatalogueRecordCount = 0;
  let changedFieldCount = 0;
  let duplicateHashRecordCount = 0;
  let matchedRecordCount = 0;
  let missingHashRecordCount = 0;
  let outsideScopeRecordCount = 0;
  let unmatchedRecordCount = 0;

  importedEntries.forEach((entry: CatalogueMetadataImportEntry) => {
    if (!entry.hash) {
      missingHashRecordCount++;
      return;
    }
    if ((importedHashCounts.get(entry.hash) || 0) > 1) {
      duplicateHashRecordCount++;
      return;
    }

    const targets = catalogueByHash.get(entry.hash) || [];
    if (targets.length === 0) {
      unmatchedRecordCount++;
      return;
    }
    if (targets.length > 1) {
      ambiguousCatalogueRecordCount++;
      return;
    }
    if (!eligibleTargetSet.has(targets[0])) {
      outsideScopeRecordCount++;
      return;
    }

    matchedRecordCount++;
    const update = buildUpdates(targets[0], entry, categories, catalogueTagSpellings);
    if (update.changedFieldCount > 0) {
      changedFieldCount += update.changedFieldCount;
      changes.push({ target: targets[0], updates: update.updates });
    }
  });

  return {
    ambiguousCatalogueRecordCount,
    categories,
    changedEntryCount: changes.length,
    changedFieldCount,
    changes,
    duplicateHashRecordCount,
    entriesRead: importedEntries.length,
    matchedRecordCount,
    missingHashRecordCount,
    outsideScopeRecordCount,
    unmatchedRecordCount,
  };
}

function applyOptionalValue(
  item: ImageElement,
  field: 'year' | 'dateAdded' | 'notes',
  value: number | string | null,
): void {
  if (value === null) {
    delete item[field];
  } else {
    (item as unknown as Record<string, unknown>)[field] = value;
  }
}

export function applyCatalogueMetadataImportPlan(
  plan: CatalogueMetadataImportPlan,
): CatalogueMetadataImportResult {
  let starsChanged = false;
  let tagsChanged = false;

  plan.changes.forEach((change: CatalogueMetadataImportChange) => {
    const item = change.target;
    const updates = change.updates;

    if (own(updates, 'stars')) {
      item.stars = updates.stars as StarRating;
      starsChanged = true;
    }
    if (own(updates, 'year')) {
      applyOptionalValue(item, 'year', updates.year as number | null);
    }
    if (own(updates, 'dateAdded')) {
      applyOptionalValue(item, 'dateAdded', updates.dateAdded as number | null);
    }
    if (own(updates, 'timesPlayed')) {
      item.timesPlayed = updates.timesPlayed as number;
    }
    if (own(updates, 'tags')) {
      const tags = updates.tags as string[];
      if (tags.length) {
        item.tags = tags.slice();
      } else {
        delete item.tags;
      }
      tagsChanged = true;
    }
    if (own(updates, 'notes')) {
      applyOptionalValue(item, 'notes', updates.notes as string | null);
    }
  });

  return {
    starsChanged,
    tagsChanged,
    updatedEntryCount: plan.changedEntryCount,
    updatedFieldCount: plan.changedFieldCount,
  };
}
