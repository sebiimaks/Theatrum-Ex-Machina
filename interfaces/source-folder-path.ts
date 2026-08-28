import * as path from 'path';

const MAX_SOURCE_FOLDER_PATH_LENGTH = 4096;
const MAX_SOURCE_FOLDER_SEGMENTS = 256;
const MAX_SOURCE_FOLDER_SEGMENT_LENGTH = 255;
const MAX_IGNORED_SUBDIRECTORIES = 4096;

export interface CompiledIgnoredSubdirectories {
  readonly scopes: readonly string[];
  readonly scopeSet: ReadonlySet<string>;
}

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
  if (value.length > MAX_IGNORED_SUBDIRECTORIES) {
    throw new Error('There are too many ignored source subdirectories.');
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
  const selectedScopes = new Set<string>();
  normalized.forEach((candidate: string) => {
    const segments = candidate.split('/');
    const hasSelectedAncestor = segments.some((_segment: string, index: number): boolean => (
      selectedScopes.has(segments.slice(0, index + 1).join('/'))
    ));
    if (!hasSelectedAncestor) {
      minimalScopes.push(candidate);
      selectedScopes.add(candidate);
    }
  });
  return minimalScopes;
}

/**
 * Validate ignored scopes once, then retain a constant-time ancestor lookup for
 * scan and catalogue-authority hot paths. The normalized list remains exposed
 * so callers can persist the same deterministic representation as before.
 */
export function compileIgnoredSubdirectories(value: unknown): CompiledIgnoredSubdirectories {
  const scopes = normalizeIgnoredSubdirectories(value);
  return {
    scopes,
    scopeSet: new Set(scopes),
  };
}

/** Match a folder against a validated set of ignored source-relative scopes. */
export function sourceFolderPathIsIgnored(
  relativePath: unknown,
  ignoredSubdirectories: readonly string[] | CompiledIgnoredSubdirectories | undefined,
): boolean {
  const folderPath = normalizeSourceFolderRelativePath(relativePath);
  const compiled = !ignoredSubdirectories || Array.isArray(ignoredSubdirectories)
    ? compileIgnoredSubdirectories(ignoredSubdirectories)
    : ignoredSubdirectories as CompiledIgnoredSubdirectories;
  if (folderPath === '') {
    return false;
  }
  const segments = folderPath.split('/');
  let ancestor = '';
  for (const segment of segments) {
    ancestor = ancestor ? `${ancestor}/${segment}` : segment;
    if (compiled.scopeSet.has(ancestor)) {
      return true;
    }
  }
  return false;
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
    return typeof process !== 'undefined' && process.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
  };
  return normalizeRoot(left) === normalizeRoot(right);
}
