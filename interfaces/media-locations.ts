import type { ImageElement, ImageLocation } from './final-object.interface';
import { IMPORT_ERROR_TAG } from './final-object.interface';
import {
  isSourceFolderWithinScope,
  normalizeSourceFolderRelativePath,
} from './source-folder-path';

export interface RemoveImageLocationsResult {
  changed: boolean;
  promoted: boolean;
  removedLocationCount: number;
  survivingLocationCount: number;
}

export interface IgnoredSourceFolderRemovalPlan {
  affectedEntryCount: number;
  affectedEntrySignatures: string[];
  metadataAffectedEntryCount: number;
  metadataRemovedEntryCount: number;
  metadataRetainedSharedEntryCount: number;
  nextElements: ImageElement[];
  removedEntryCount: number;
  removedLocationCount: number;
  retainedSharedEntryCount: number;
}

/** Keep stored paths compatible with legacy catalogues while comparing canonically. */
export function normalizeImageLocationPartialPath(value: unknown): string {
  const normalized = normalizeSourceFolderRelativePath(value);
  return normalized === '' ? '/' : `/${normalized}`;
}

export function normalizeImageLocation(value: unknown): ImageLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The media location is invalid.');
  }
  const candidate = value as Partial<ImageLocation>;
  if (!Number.isSafeInteger(candidate.inputSource) || Number(candidate.inputSource) < 0) {
    throw new Error('The media location source is invalid.');
  }
  if (
    typeof candidate.fileName !== 'string'
    || candidate.fileName.length === 0
    || candidate.fileName.includes('\0')
    || candidate.fileName === '.'
    || candidate.fileName === '..'
    || /[\\/]/.test(candidate.fileName)
  ) {
    throw new Error('The media location file name is invalid.');
  }
  if (candidate.missing !== undefined && typeof candidate.missing !== 'boolean') {
    throw new Error('The media location missing state is invalid.');
  }

  const normalized: ImageLocation = {
    fileName: candidate.fileName,
    inputSource: Number(candidate.inputSource),
    partialPath: normalizeImageLocationPartialPath(candidate.partialPath),
  };
  if (candidate.missing === true) {
    normalized.missing = true;
  }
  return normalized;
}

export function imageLocationKey(value: unknown): string {
  const location = normalizeImageLocation(value);
  return `${location.inputSource}\0${location.partialPath}\0${location.fileName}`;
}

function legacyLocation(element: ImageElement): ImageLocation {
  return normalizeImageLocation({
    fileName: element.fileName,
    inputSource: Number(element.inputSource),
    missing: element.missing === true,
    partialPath: element.partialPath,
  });
}

function normalizedUniqueLocations(locations: readonly unknown[]): ImageLocation[] {
  const result: ImageLocation[] = [];
  const indexByKey = new Map<string, number>();
  locations.forEach((value: unknown) => {
    const location = normalizeImageLocation(value);
    const key = imageLocationKey(location);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      if (location.missing !== true) {
        delete result[existingIndex].missing;
      }
      return;
    }
    indexByKey.set(key, result.length);
    result.push(location);
  });
  return result;
}

/** Return normalized copies; callers cannot mutate the saved list accidentally. */
export function getImageLocations(element: ImageElement): ImageLocation[] {
  if (element.locations !== undefined) {
    if (!Array.isArray(element.locations)) {
      throw new Error('The catalogue entry locations are invalid.');
    }
    return normalizedUniqueLocations(element.locations);
  }
  return [legacyLocation(element)];
}

function writeLocations(element: ImageElement, rawLocations: readonly unknown[]): void {
  let locations = normalizedUniqueLocations(rawLocations);
  if (locations.length === 0) {
    element.locations = [];
    element.missing = true;
    return;
  }

  if (locations[0].missing === true) {
    const availableIndex = locations.findIndex(location => location.missing !== true);
    if (availableIndex > 0) {
      const available = locations[availableIndex];
      locations = [
        available,
        ...locations.slice(0, availableIndex),
        ...locations.slice(availableIndex + 1),
      ];
    }
  }

  element.locations = locations;
  element.inputSource = locations[0].inputSource;
  element.partialPath = locations[0].partialPath;
  element.fileName = locations[0].fileName;
  if (locations.every(location => location.missing === true)) {
    element.missing = true;
  } else {
    delete element.missing;
  }
}

/** Normalize a persisted list and restore the legacy preferred-location mirror. */
export function normalizeImageElementLocations(element: ImageElement): boolean {
  const before = JSON.stringify({
    fileName: element.fileName,
    inputSource: element.inputSource,
    locations: element.locations,
    missing: element.missing,
    partialPath: element.partialPath,
  });
  writeLocations(element, getImageLocations(element));
  return before !== JSON.stringify({
    fileName: element.fileName,
    inputSource: element.inputSource,
    locations: element.locations,
    missing: element.missing,
    partialPath: element.partialPath,
  });
}

/** Explicitly associate one newly verified filesystem location. */
export function attachImageLocation(element: ImageElement, rawLocation: unknown): boolean {
  const incoming = normalizeImageLocation(rawLocation);
  const locations = getImageLocations(element);
  const incomingKey = imageLocationKey(incoming);
  const existingIndex = locations.findIndex(location => imageLocationKey(location) === incomingKey);

  if (existingIndex !== -1) {
    if (locations[existingIndex].missing !== true || incoming.missing === true) {
      return false;
    }
    delete locations[existingIndex].missing;
  } else {
    locations.push(incoming);
  }
  writeLocations(element, locations);
  return true;
}

/**
 * Apply one complete successful source-subtree snapshot. Only locations in
 * that source and scope are touched; callers supply exact presence checks.
 */
export function markImageLocationsMissingInScope(
  element: ImageElement,
  sourceIndex: number,
  relativeScope: string,
  isPresent: (location: ImageLocation) => boolean,
): boolean {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || typeof isPresent !== 'function') {
    throw new Error('The scoped media-location update is invalid.');
  }
  const normalizedScope = normalizeSourceFolderRelativePath(relativeScope);
  const locations = getImageLocations(element);
  let changed = false;

  locations.forEach((location: ImageLocation) => {
    if (
      location.inputSource !== sourceIndex
      || !isSourceFolderWithinScope(location.partialPath, normalizedScope)
    ) {
      return;
    }
    const shouldBeMissing = !isPresent(location);
    if ((location.missing === true) !== shouldBeMissing) {
      if (shouldBeMissing) {
        location.missing = true;
      } else {
        delete location.missing;
      }
      changed = true;
    }
  });

  if (changed) {
    writeLocations(element, locations);
  }
  return changed;
}

export function removeImageLocationsForSource(
  element: ImageElement,
  sourceIndex: number,
): RemoveImageLocationsResult {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error('The media location source is invalid.');
  }
  const locations = getImageLocations(element);
  const preferredKey = locations.length > 0 ? imageLocationKey(locations[0]) : '';
  const survivors = locations.filter(location => location.inputSource !== sourceIndex);
  const removedLocationCount = locations.length - survivors.length;
  if (removedLocationCount === 0) {
    return {
      changed: false,
      promoted: false,
      removedLocationCount: 0,
      survivingLocationCount: locations.length,
    };
  }

  writeLocations(element, survivors);
  return {
    changed: true,
    promoted: survivors.length > 0 && imageLocationKey(survivors[0]) !== preferredKey,
    removedLocationCount,
    survivingLocationCount: survivors.length,
  };
}

/** Remove one source-subtree association while preserving any other aliases. */
export function removeImageLocationsInScope(
  element: ImageElement,
  sourceIndex: number,
  relativeScope: string,
): RemoveImageLocationsResult {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error('The media location source is invalid.');
  }
  const normalizedScope = normalizeSourceFolderRelativePath(relativeScope);
  if (normalizedScope === '') {
    throw new Error('The configured source root cannot be ignored.');
  }
  const locations = getImageLocations(element);
  const preferredKey = locations.length > 0 ? imageLocationKey(locations[0]) : '';
  const survivors = locations.filter((location: ImageLocation) => !(
    location.inputSource === sourceIndex
    && isSourceFolderWithinScope(location.partialPath, normalizedScope)
  ));
  const removedLocationCount = locations.length - survivors.length;
  if (removedLocationCount === 0) {
    return {
      changed: false,
      promoted: false,
      removedLocationCount: 0,
      survivingLocationCount: locations.length,
    };
  }

  writeLocations(element, survivors);
  return {
    changed: true,
    promoted: survivors.length > 0 && imageLocationKey(survivors[0]) !== preferredKey,
    removedLocationCount,
    survivingLocationCount: survivors.length,
  };
}

function derivedCleanName(fileName: string): string {
  return fileName.split('.').slice(0, -1).join('.')
    .split('_').join(' ')
    .split('.').join(' ')
    .split(/\s+/).join(' ');
}

/**
 * Detect metadata created or meaningfully managed by the user. Automatic
 * filesystem/probe fields and Date Added do not trigger a warning by
 * themselves; otherwise nearly every modern catalogue entry would prompt.
 */
export function hasUserManagedMetadata(element: ImageElement): boolean {
  const hasManualTag = Array.isArray(element.tags) && element.tags.some((tag: string) => (
    typeof tag === 'string' && tag.length > 0 && tag !== IMPORT_ERROR_TAG
  ));
  const hasEditedName = typeof element.cleanName === 'string'
    && typeof element.fileName === 'string'
    && element.cleanName !== derivedCleanName(element.fileName);

  return hasManualTag
    || (typeof element.notes === 'string' && element.notes.trim().length > 0)
    || (typeof element.stars === 'number' && element.stars !== 0.5)
    || element.year !== undefined
    || element.defaultScreen !== undefined
    || (typeof element.timesPlayed === 'number' && element.timesPlayed > 0)
    || (typeof element.lastPlayed === 'number' && element.lastPlayed > 0)
    || element.playlist !== undefined
    || hasEditedName;
}

/**
 * Plan an ignored-subdirectory change without mutating the live catalogue.
 * Any malformed location aborts the entire plan, so callers can confirm and
 * apply `nextElements` atomically.
 */
export function planIgnoredSourceFolderRemoval(
  elements: readonly ImageElement[],
  sourceIndex: number,
  relativeScope: string,
): IgnoredSourceFolderRemovalPlan {
  if (!Array.isArray(elements)) {
    throw new Error('The catalogue entries are invalid.');
  }
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error('The media location source is invalid.');
  }
  const normalizedScope = normalizeSourceFolderRelativePath(relativeScope);
  if (normalizedScope === '') {
    throw new Error('The configured source root cannot be ignored.');
  }

  let affectedEntryCount = 0;
  const affectedEntrySignatures: string[] = [];
  let metadataAffectedEntryCount = 0;
  let metadataRemovedEntryCount = 0;
  let metadataRetainedSharedEntryCount = 0;
  let removedEntryCount = 0;
  let removedLocationCount = 0;
  let retainedSharedEntryCount = 0;
  const nextElements: ImageElement[] = [];

  elements.forEach((element: ImageElement) => {
    if (!element || typeof element !== 'object') {
      throw new Error('The catalogue contains an invalid entry.');
    }
    if (element.deleted === true) {
      nextElements.push(element);
      return;
    }

    const locations = getImageLocations(element);
    const hasMatchingLocation = locations.some((location: ImageLocation) => (
      location.inputSource === sourceIndex
      && isSourceFolderWithinScope(location.partialPath, normalizedScope)
    ));
    if (!hasMatchingLocation) {
      nextElements.push(element);
      return;
    }

    affectedEntryCount++;
    affectedEntrySignatures.push(JSON.stringify({
      cleanName: element.cleanName,
      dateAdded: element.dateAdded,
      defaultScreen: element.defaultScreen,
      fileName: element.fileName,
      hash: element.hash,
      lastPlayed: element.lastPlayed,
      locations: locations.map((location: ImageLocation) => imageLocationKey(location)).sort(),
      notes: element.notes,
      playlist: element.playlist,
      stars: element.stars,
      tags: element.tags,
      timesPlayed: element.timesPlayed,
      uuid: element.uuid,
      year: element.year,
    }));
    const hasManagedMetadata = hasUserManagedMetadata(element);
    if (hasManagedMetadata) {
      metadataAffectedEntryCount++;
    }
    const candidate: ImageElement = {
      ...element,
      ...(Array.isArray(element.locations)
        ? { locations: element.locations.map((location: ImageLocation) => ({ ...location })) }
        : {}),
      ...(Array.isArray(element.tags) ? { tags: element.tags.slice() } : {}),
    };
    const result = removeImageLocationsInScope(candidate, sourceIndex, normalizedScope);
    removedLocationCount += result.removedLocationCount;
    if (result.survivingLocationCount === 0) {
      removedEntryCount++;
      if (hasManagedMetadata) {
        metadataRemovedEntryCount++;
      }
      return;
    }

    retainedSharedEntryCount++;
    if (hasManagedMetadata) {
      metadataRetainedSharedEntryCount++;
    }
    nextElements.push(candidate);
  });

  return {
    affectedEntryCount,
    affectedEntrySignatures: affectedEntrySignatures.sort(),
    metadataAffectedEntryCount,
    metadataRemovedEntryCount,
    metadataRetainedSharedEntryCount,
    nextElements,
    removedEntryCount,
    removedLocationCount,
    retainedSharedEntryCount,
  };
}

export function selectAvailableImageLocation(
  element: ImageElement,
  sourceIsAvailable: (sourceIndex: number) => boolean = () => true,
): ImageLocation | undefined {
  const locations = getImageLocations(element);
  return locations.find(location => (
    location.missing !== true && sourceIsAvailable(location.inputSource)
  ));
}

/** Make one associated location the preferred legacy-compatible location. */
export function promoteImageLocation(
  element: ImageElement,
  rawLocation: unknown,
): boolean {
  const requested = normalizeImageLocation(rawLocation);
  const requestedKey = imageLocationKey(requested);
  const locations = getImageLocations(element);
  const requestedIndex = locations.findIndex(location => (
    imageLocationKey(location) === requestedKey
  ));
  if (requestedIndex < 0) {
    throw new Error('The requested media location is not associated with this catalogue entry.');
  }
  if (requestedIndex === 0) {
    return false;
  }
  const promoted = locations[requestedIndex];
  writeLocations(element, [
    promoted,
    ...locations.slice(0, requestedIndex),
    ...locations.slice(requestedIndex + 1),
  ]);
  return true;
}

/** Feed existing single-location operations without mutating the logical item. */
export function imageElementAtLocation(
  element: ImageElement,
  rawLocation: unknown,
): ImageElement {
  const requested = normalizeImageLocation(rawLocation);
  const requestedKey = imageLocationKey(requested);
  const location = getImageLocations(element).find(candidate => (
    imageLocationKey(candidate) === requestedKey
  ));
  if (!location) {
    throw new Error('The requested media location is not associated with this catalogue entry.');
  }
  const projected: ImageElement = {
    ...element,
    fileName: location.fileName,
    inputSource: location.inputSource,
    partialPath: location.partialPath,
  };
  if (location.missing === true) {
    projected.missing = true;
  } else {
    delete projected.missing;
  }
  return projected;
}

/** Keep the authoritative preferred location aligned with editor path changes. */
export function updatePreferredImageLocationFields(
  element: ImageElement,
  fields: Partial<Pick<ImageLocation, 'fileName' | 'partialPath'>>,
): void {
  if (!Array.isArray(element.locations) || element.locations.length === 0) {
    return;
  }
  const locations = getImageLocations(element);
  const previousPreferredFileName = locations[0].fileName;
  if (fields.fileName !== undefined) {
    locations.forEach((location: ImageLocation) => {
      if (location.fileName === previousPreferredFileName) {
        location.fileName = fields.fileName;
      }
    });
  }
  if (fields.partialPath !== undefined) {
    locations[0].partialPath = fields.partialPath;
  }
  writeLocations(element, locations);
}

/** Keep every alias synchronized after the one physical file is renamed. */
export function renameImageLocationFile(
  element: ImageElement,
  oldFileName: string,
  newFileName: string,
): boolean {
  const locations = getImageLocations(element);
  let changed = false;
  locations.forEach((location: ImageLocation) => {
    if (location.fileName === oldFileName) {
      location.fileName = newFileName;
      changed = true;
    }
  });
  if (changed) {
    writeLocations(element, locations);
  }
  return changed;
}
