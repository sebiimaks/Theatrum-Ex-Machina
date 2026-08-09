import * as path from 'node:path';
import * as fs from 'node:fs';

const MAX_PLAYER_ARGUMENT_TEXT_LENGTH = 8192;
const MAX_PLAYER_ARGUMENTS = 128;

export interface ProcessLaunch {
  args: string[];
  command: string;
}

/**
 * External links are intentionally limited to ordinary web pages.
 * Local files, scripts, application-specific protocols, and credentials are rejected.
 */
export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * Normalize a path received over IPC, rejecting relative paths and embedded NUL bytes.
 */
export function normalizeAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.normalize(value);
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const relativeCandidate = path.relative(rootPath, candidatePath);
  return relativeCandidate !== ''
    && relativeCandidate !== '..'
    && !relativeCandidate.startsWith('..' + path.sep)
    && !path.isAbsolute(relativeCandidate);
}

function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
  }
  return left === right;
}

/**
 * Accept a source root only when it is one of the roots held by the main
 * process for the currently open catalogue. Renderer-supplied roots are not
 * treated as authority for rename or delete operations.
 */
export function requireConfiguredSourceRoot(
  requestedRoot: unknown,
  configuredRoots: readonly unknown[],
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedRequestedRoot = path.resolve(normalizeAbsolutePath(requestedRoot, 'Source folder'));
  for (const configuredRoot of configuredRoots) {
    try {
      const normalizedConfiguredRoot = path.resolve(
        normalizeAbsolutePath(configuredRoot, 'Configured source folder'),
      );
      if (samePath(normalizedRequestedRoot, normalizedConfiguredRoot, platform)) {
        return normalizedConfiguredRoot;
      }
    } catch {
      // Ignore malformed catalogue roots; they cannot authorize an operation.
    }
  }
  throw new Error('The source folder is not part of the currently open catalogue.');
}

/**
 * Resolve an existing directory beneath a configured source folder.
 *
 * The scope is deliberately root-relative: an empty string or `.` selects the
 * source root, while absolute and parent-traversal paths are rejected. Both
 * the lexical path and its real path must remain inside the configured root so
 * a symlink or junction cannot redirect a scoped operation elsewhere.
 */
export function resolveExistingSourceSubfolder(
  basePath: unknown,
  scope: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedBase = path.resolve(normalizeAbsolutePath(basePath, 'Source folder'));

  if (typeof scope !== 'string' || scope.includes('\0')) {
    throw new Error('The source subfolder scope is invalid.');
  }
  if (
    path.isAbsolute(scope)
    || path.posix.isAbsolute(scope)
    || path.win32.isAbsolute(scope)
  ) {
    throw new Error('The source subfolder scope must be root-relative.');
  }

  const scopeSegments = scope.split(/[\\/]+/);
  if (scopeSegments.some(segment => segment === '..')) {
    throw new Error('The source subfolder scope cannot traverse parent folders.');
  }

  const normalizedScope = scopeSegments
    .filter(segment => segment !== '' && segment !== '.')
    .join(path.sep);
  const candidate = path.resolve(normalizedBase, normalizedScope);
  if (!samePath(normalizedBase, candidate, platform) && !pathIsWithin(normalizedBase, candidate)) {
    throw new Error('The source subfolder is outside its source folder.');
  }

  let baseStats: fs.Stats;
  let candidateStats: fs.Stats;
  try {
    baseStats = fs.statSync(normalizedBase);
  } catch {
    throw new Error('The source folder must be an existing directory.');
  }
  if (!baseStats.isDirectory()) {
    throw new Error('The source folder must be an existing directory.');
  }
  try {
    candidateStats = fs.statSync(candidate);
  } catch {
    throw new Error('The source subfolder must be an existing directory.');
  }
  if (!candidateStats.isDirectory()) {
    throw new Error('The source subfolder must be an existing directory.');
  }

  const realBase = fs.realpathSync.native(normalizedBase);
  const realCandidate = fs.realpathSync.native(candidate);
  if (!samePath(realBase, realCandidate, platform) && !pathIsWithin(realBase, realCandidate)) {
    throw new Error('The source subfolder resolves outside its source folder.');
  }

  return candidate;
}

/**
 * Resolve a catalogue-relative media path without allowing traversal outside its source folder.
 * Catalogue partial paths historically start with a slash, so leading separators are removed.
 */
export function resolveMediaPath(
  basePath: unknown,
  partialPath: unknown,
  fileName: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedBase = normalizeAbsolutePath(basePath, 'Source folder');

  if (typeof partialPath !== 'string' || partialPath.includes('\0')) {
    throw new Error('The media folder path is invalid.');
  }
  if (
    typeof fileName !== 'string'
    || fileName.length === 0
    || fileName.includes('\0')
    || fileName === '.'
    || fileName === '..'
    || fileName.includes('/')
    || (platform === 'win32' && fileName.includes('\\'))
  ) {
    throw new Error('The media file name is invalid.');
  }

  const relativeFolder = platform === 'win32'
    ? partialPath.replace(/^[\\/]+/, '')
    : partialPath.replace(/^\/+/, '');
  const candidate = path.resolve(normalizedBase, relativeFolder, fileName);
  const relativeCandidate = path.relative(normalizedBase, candidate);

  if (
    !pathIsWithin(normalizedBase, candidate)
  ) {
    throw new Error('The media path is outside its source folder.');
  }

  return candidate;
}

/**
 * Resolve an existing catalogue file and follow symlinks/junctions before
 * checking containment. This prevents a path that looks local from resolving
 * to a file outside the configured source folder.
 */
export function resolveExistingMediaPath(
  basePath: unknown,
  partialPath: unknown,
  fileName: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedBase = normalizeAbsolutePath(basePath, 'Source folder');
  const candidate = resolveMediaPath(normalizedBase, partialPath, fileName, platform);
  const realBase = fs.realpathSync.native(normalizedBase);
  const realCandidate = fs.realpathSync.native(candidate);

  if (!pathIsWithin(realBase, realCandidate)) {
    throw new Error('The media path resolves outside its source folder.');
  }
  return candidate;
}

/**
 * Resolve a not-yet-created catalogue filename. The destination's existing
 * parent directory is resolved first so a symlinked directory cannot redirect
 * the rename outside the configured root.
 */
export function resolveNewMediaPath(
  basePath: unknown,
  partialPath: unknown,
  fileName: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedBase = normalizeAbsolutePath(basePath, 'Source folder');
  const candidate = resolveMediaPath(normalizedBase, partialPath, fileName, platform);
  const realBase = fs.realpathSync.native(normalizedBase);
  const realParent = fs.realpathSync.native(path.dirname(candidate));

  if (!pathIsWithin(realBase, realParent) && !samePath(realBase, realParent, platform)) {
    throw new Error('The destination resolves outside its source folder.');
  }
  return candidate;
}

/**
 * Split the optional custom-player argument text without invoking a command shell.
 * Quotes group text; shell substitutions and separators remain ordinary argument characters.
 */
export function parsePlayerArguments(value: unknown): string[] {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  if (typeof value !== 'string' || value.length > MAX_PLAYER_ARGUMENT_TEXT_LENGTH || value.includes('\0')) {
    throw new Error('The custom-player arguments are invalid.');
  }

  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];

    if (quote) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (character === '\\' && quote === '"' && index + 1 < value.length) {
        const nextCharacter = value[index + 1];
        if (nextCharacter === '"' || nextCharacter === '\\') {
          current += nextCharacter;
          tokenStarted = true;
          index++;
          continue;
        }
      }
      current += character;
      tokenStarted = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    if (character === '\\' && index + 1 < value.length) {
      const nextCharacter = value[index + 1];
      if (/\s/.test(nextCharacter) || nextCharacter === '"' || nextCharacter === "'" || nextCharacter === '\\') {
        current += nextCharacter;
        tokenStarted = true;
        index++;
        continue;
      }
    }

    current += character;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error('The custom-player arguments contain an unmatched quote.');
  }
  if (tokenStarted) {
    args.push(current);
  }
  if (args.length > MAX_PLAYER_ARGUMENTS) {
    throw new Error('Too many custom-player arguments were supplied.');
  }

  return args;
}

/**
 * Build a shell-free process launch for a custom player.
 * macOS application bundles are launched through the fixed system open executable.
 */
export function buildPlayerLaunch(
  executablePath: unknown,
  mediaPath: unknown,
  argumentText: unknown,
  platform: NodeJS.Platform = process.platform,
): ProcessLaunch {
  const normalizedExecutable = normalizeAbsolutePath(executablePath, 'Video player');
  const normalizedMedia = normalizeAbsolutePath(mediaPath, 'Media file');
  const playerArgs = parsePlayerArguments(argumentText);

  if (platform === 'darwin' && normalizedExecutable.toLowerCase().endsWith('.app')) {
    return {
      command: '/usr/bin/open',
      args: [
        '-a',
        normalizedExecutable,
        normalizedMedia,
        ...(playerArgs.length ? ['--args', ...playerArgs] : []),
      ],
    };
  }

  return {
    command: normalizedExecutable,
    args: [normalizedMedia, ...playerArgs],
  };
}

/**
 * Build FFprobe arguments as discrete values so media filenames can never become shell syntax.
 */
export function buildFfprobeArguments(filePath: unknown): string[] {
  return [
    '-v', 'error',
    '-of', 'json',
    '-show_streams',
    '-show_format',
    '-select_streams', 'V',
    normalizeAbsolutePath(filePath, 'Media file'),
  ];
}
