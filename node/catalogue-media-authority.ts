import type { ImageElement, ImageLocation } from '../interfaces/final-object.interface';
import {
  getImageLocations,
  imageLocationKey,
  normalizeImageLocation,
} from '../interfaces/media-locations';
import {
  compileIgnoredSubdirectories,
  sourceFolderPathIsIgnored,
} from '../interfaces/source-folder-path';

const SAFE_MEDIA_HASH = /^[a-zA-Z0-9_-]{1,200}$/;

/** A renderer-visible hash is only an identifier; it is never path authority by itself. */
export function isSafeCatalogueMediaHash(value: unknown): value is string {
  return typeof value === 'string' && SAFE_MEDIA_HASH.test(value);
}

export function catalogueMediaLocationAuthorizationKey(
  hash: unknown,
  rawLocation: unknown,
): string {
  if (!isSafeCatalogueMediaHash(hash)) {
    throw new Error('The catalogue media identifier is invalid.');
  }
  return `${hash}\0${imageLocationKey(rawLocation)}`;
}

function requestedLocation(item: unknown): ImageLocation {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('The catalogue media item is invalid.');
  }
  const candidate = item as Partial<ImageElement>;
  if (candidate.cleanName === '*FOLDER*' || candidate.deleted === true) {
    throw new Error('The catalogue entry is not an active media item.');
  }
  return normalizeImageLocation({
    fileName: candidate.fileName,
    inputSource: candidate.inputSource,
    partialPath: candidate.partialPath,
  });
}

/** Build an immutable-by-replacement snapshot from main-owned catalogue data. */
export function buildCatalogueMediaLocationAuthority(
  images: readonly ImageElement[],
): Set<string> {
  const authority = new Set<string>();
  images.forEach((item: ImageElement) => {
    if (
      !item
      || item.cleanName === '*FOLDER*'
      || item.deleted === true
      || !isSafeCatalogueMediaHash(item.hash)
    ) {
      return;
    }
    getImageLocations(item).forEach((location: ImageLocation) => {
      authority.add(catalogueMediaLocationAuthorizationKey(item.hash, location));
    });
  });
  return authority;
}

/** Extend the snapshot only with metadata emitted by the trusted main scanner. */
export function addCatalogueMediaLocationAuthority(
  authority: Set<string>,
  item: ImageElement,
): void {
  if (!item || item.cleanName === '*FOLDER*' || !isSafeCatalogueMediaHash(item.hash)) {
    throw new Error('The catalogue media item is invalid.');
  }
  getImageLocations(item).forEach((location: ImageLocation) => {
    authority.add(catalogueMediaLocationAuthorizationKey(item.hash, location));
  });
}

/** Require the exact hash/location pair represented by an IPC request. */
export function requireCatalogueMediaLocationAuthority(
  authority: ReadonlySet<string>,
  item: unknown,
): { hash: string; location: ImageLocation } {
  const candidate = item as Partial<ImageElement> | undefined;
  const hash = candidate?.hash;
  const location = requestedLocation(item);
  const key = catalogueMediaLocationAuthorizationKey(hash, location);
  if (!authority.has(key)) {
    throw new Error('The requested media location is not owned by the active catalogue.');
  }
  return { hash, location };
}

export function catalogueMediaAuthorityLocationsForHash(
  authority: ReadonlySet<string>,
  hash: string,
): ImageLocation[] {
  if (!isSafeCatalogueMediaHash(hash)) {
    return [];
  }
  const prefix = `${hash}\0`;
  const locations: ImageLocation[] = [];
  authority.forEach((key: string) => {
    if (!key.startsWith(prefix)) {
      return;
    }
    const fields = key.slice(prefix.length).split('\0');
    if (fields.length !== 3) {
      return;
    }
    try {
      locations.push(normalizeImageLocation({
        fileName: fields[2],
        inputSource: Number(fields[0]),
        partialPath: fields[1],
      }));
    } catch {
      // Malformed in-memory keys confer no authority.
    }
  });
  return locations;
}

/**
 * Renderer saves may revoke locations but cannot mint a new hash/path pair.
 * A caller may explicitly attest a new alias only when it resolves to the
 * same physical file as an already-authorized location for that hash.
 */
export function reconcileCatalogueMediaLocationAuthority(
  images: readonly ImageElement[],
  authorizedHashes: ReadonlySet<string>,
  currentAuthority: ReadonlySet<string>,
  mayAuthorizeAlias: (hash: string, location: ImageLocation) => boolean = () => false,
): Set<string> {
  const nextAuthority = new Set<string>();
  images.forEach((item: ImageElement) => {
    if (!item || item.cleanName === '*FOLDER*' || item.deleted === true) {
      return;
    }
    if (!isSafeCatalogueMediaHash(item.hash) || !authorizedHashes.has(item.hash)) {
      throw new Error('The catalogue attempted to add an unauthorized media item.');
    }
    getImageLocations(item).forEach((location: ImageLocation) => {
      const key = catalogueMediaLocationAuthorizationKey(item.hash, location);
      if (!currentAuthority.has(key) && !mayAuthorizeAlias(item.hash, location)) {
        throw new Error('The catalogue attempted to add an unauthorized media location.');
      }
      nextAuthority.add(key);
    });
  });
  return nextAuthority;
}

export function removeCatalogueMediaLocationAuthority(
  authority: Set<string>,
  item: unknown,
): void {
  const candidate = item as Partial<ImageElement> | undefined;
  const location = requestedLocation(item);
  authority.delete(catalogueMediaLocationAuthorizationKey(candidate?.hash, location));
}

export function removeCatalogueMediaAuthorityForSource(
  authority: Set<string>,
  inputSource: number,
): void {
  if (!Number.isSafeInteger(inputSource) || inputSource < 0) {
    throw new Error('The catalogue media source is invalid.');
  }
  authority.forEach((key: string) => {
    const fields = key.split('\0');
    if (fields.length === 4 && fields[1] === String(inputSource)) {
      authority.delete(key);
    }
  });
}

export function removeCatalogueMediaAuthorityForSourceScopes(
  authority: Set<string>,
  inputSource: number,
  scopes: readonly unknown[],
): void {
  if (!Number.isSafeInteger(inputSource) || inputSource < 0 || !Array.isArray(scopes)) {
    throw new Error('The catalogue media source scopes are invalid.');
  }
  const compiledScopes = compileIgnoredSubdirectories(scopes);
  authority.forEach((key: string) => {
    const fields = key.split('\0');
    if (fields.length !== 4 || fields[1] !== String(inputSource)) {
      return;
    }
    if (sourceFolderPathIsIgnored(fields[2], compiledScopes)) {
      authority.delete(key);
    }
  });
}

export function catalogueMediaAuthorityHashes(authority: ReadonlySet<string>): Set<string> {
  const hashes = new Set<string>();
  authority.forEach((key: string) => {
    const separatorIndex = key.indexOf('\0');
    const hash = separatorIndex > 0 ? key.slice(0, separatorIndex) : '';
    if (isSafeCatalogueMediaHash(hash)) {
      hashes.add(hash);
    }
  });
  return hashes;
}

export function retainCatalogueMediaHashAuthority(
  authority: Set<string>,
  hashes: ReadonlySet<string>,
): void {
  authority.forEach((key: string) => {
    const separatorIndex = key.indexOf('\0');
    const hash = separatorIndex >= 0 ? key.slice(0, separatorIndex) : '';
    if (!hashes.has(hash)) {
      authority.delete(key);
    }
  });
}

export function renameCatalogueMediaLocationAuthority(
  authority: Set<string>,
  item: unknown,
  newFileName: unknown,
): void {
  const candidate = item as Partial<ImageElement> | undefined;
  const oldLocation = requestedLocation(item);
  const nextLocation = normalizeImageLocation({
    ...oldLocation,
    fileName: newFileName,
  });
  const oldKey = catalogueMediaLocationAuthorizationKey(candidate?.hash, oldLocation);
  if (!authority.has(oldKey)) {
    throw new Error('The requested media location is not owned by the active catalogue.');
  }
  authority.delete(oldKey);
  authority.add(catalogueMediaLocationAuthorizationKey(candidate?.hash, nextLocation));
}
