import * as path from 'path';

const MAX_SOURCE_FOLDER_PATH_LENGTH = 4096;
const MAX_SOURCE_FOLDER_SEGMENTS = 256;
const MAX_SOURCE_FOLDER_SEGMENT_LENGTH = 255;

/**
 * Canonicalize catalogue-relative folder paths without granting them absolute
 * filesystem semantics. Historical catalogue paths may begin with either
 * separator; the canonical representation never does.
 */
export function normalizeSourceFolderRelativePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || value.length > MAX_SOURCE_FOLDER_PATH_LENGTH
  ) {
    throw new Error('The source-folder path is invalid.');
  }

  const normalizedSegments: string[] = [];
  value.replace(/\\/g, '/').split('/').forEach((segment: string) => {
    if (segment === '' || segment === '.') {
      return;
    }
    if (segment === '..') {
      throw new Error('The source-folder path cannot leave its configured root.');
    }
    if (segment.length > MAX_SOURCE_FOLDER_SEGMENT_LENGTH) {
      throw new Error('The source-folder path is invalid.');
    }
    normalizedSegments.push(segment);
    if (normalizedSegments.length > MAX_SOURCE_FOLDER_SEGMENTS) {
      throw new Error('The source-folder path is too deeply nested.');
    }
  });

  return normalizedSegments.join('/');
}

/** Match a folder itself or one of its descendants, never a name prefix. */
export function isSourceFolderWithinScope(
  folderPath: unknown,
  scopePath: unknown,
): boolean {
  const folder = normalizeSourceFolderRelativePath(folderPath);
  const scope = normalizeSourceFolderRelativePath(scopePath);
  return scope === '' || folder === scope || folder.startsWith(scope + '/');
}

/**
 * Normalize persisted ignored subdirectories into the smallest deterministic
 * set of source-root-relative scopes. A configured source root itself can
 * never be ignored.
 */
export function normalizeIgnoredSubdirectories(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('The ignored source subdirectories are invalid.');
  }

  const normalized = Array.from(new Set(value.map((candidate: unknown) => {
    const relativePath = normalizeSourceFolderRelativePath(candidate);
    if (relativePath === '') {
      throw new Error('The configured source root cannot be ignored.');
    }
    return relativePath;
  }))).sort((left: string, right: string): number => {
    const depthDifference = left.split('/').length - right.split('/').length;
    return depthDifference || left.localeCompare(right, 'en-US');
  });

  const minimalScopes: string[] = [];
  normalized.forEach((candidate: string) => {
    if (!minimalScopes.some((scope: string) => isSourceFolderWithinScope(candidate, scope))) {
      minimalScopes.push(candidate);
    }
  });
  return minimalScopes;
}

/** Match a folder against a validated set of ignored source-relative scopes. */
export function sourceFolderPathIsIgnored(
  relativePath: unknown,
  ignoredSubdirectories: readonly string[] | undefined,
): boolean {
  const folderPath = normalizeSourceFolderRelativePath(relativePath);
  return normalizeIgnoredSubdirectories(ignoredSubdirectories)
    .some((scope: string) => isSourceFolderWithinScope(folderPath, scope));
}

/** Compare configured roots canonically without rejecting valid parent/child overlap. */
export function configuredSourceRootsEqual(left: unknown, right: unknown): boolean {
  if (
    typeof left !== 'string'
    || typeof right !== 'string'
    || left.length === 0
    || right.length === 0
    || left.includes('\0')
    || right.includes('\0')
  ) {
    return false;
  }

  const normalizeRoot = (value: string): string => {
    const normalized = path.resolve(path.normalize(value));
    return process.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  };
  return normalizeRoot(left) === normalizeRoot(right);
}
