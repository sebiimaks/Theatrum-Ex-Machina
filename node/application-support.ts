import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const APPLICATION_SUPPORT_DIRECTORY_NAME = 'Theatrum Ex Machina';

const LEGACY_DIRECTORY_NAMES = [
  'theatrum-ex-machina',
  'video-hub-app-2',
  'Video-hub-app-2',
  'video-hub-app-3',
  'Video Hub App 3',
  'Video Hub App SIN',
  'video-hub-app-sin',
] as const;
const SETTINGS_MAX_BYTES = 8 * 1024 * 1024;
const AUTHORITY_MAX_BYTES = 1024 * 1024;
const AUTHORITY_FILE_NAME = 'trusted-path-authority.json';

interface LegacyFile {
  bytes: Buffer;
  modified: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSettings(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.appState)) {
    return false;
  }
  if (value.buttonSettings !== undefined && (
    !isObject(value.buttonSettings)
    || !Object.values(value.buttonSettings).every((entry) => isObject(entry)
      && (entry.hidden === undefined || typeof entry.hidden === 'boolean')
      && (entry.toggled === undefined || typeof entry.toggled === 'boolean'))
  )) {
    return false;
  }
  return (value.shortcuts === undefined || (isObject(value.shortcuts)
      && Object.values(value.shortcuts).every((action) => typeof action === 'string')))
    && (value.wizardOptions === undefined || isObject(value.wizardOptions))
    && (value.vhaFileHistory === undefined || Array.isArray(value.vhaFileHistory));
}

function validAuthority(value: unknown): boolean {
  const validPaths = (paths: unknown): boolean => Array.isArray(paths)
    && paths.every((entry) => typeof entry === 'string' && entry.length > 0
      && entry.length <= 32768 && !entry.includes('\0') && path.isAbsolute(entry));
  const validDecisions = (decisions: unknown): boolean => isObject(decisions)
    && Object.entries(decisions).every(([key, decision]) => /^[a-f0-9]{64}$/.test(key)
      && typeof decision === 'boolean');
  return isObject(value) && value.version === 1
    && validPaths(value.cataloguePaths) && validPaths(value.playerPaths)
    && validDecisions(value.sourceDecisions) && validDecisions(value.watchDecisions);
}

function unchanged(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/** Only fixed legacy filenames are read; Chromium profiles are never copied. */
function readLegacyFile(
  directory: string,
  filename: string,
  maximumBytes: number,
  validate: (value: unknown) => boolean,
): LegacyFile | undefined {
  let descriptor: number | undefined;
  try {
    const directoryBefore = fs.lstatSync(directory);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      return undefined;
    }
    const sourcePath = path.join(directory, filename);
    const sourceBefore = fs.lstatSync(sourcePath);
    if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()
      || sourceBefore.size > maximumBytes) {
      return undefined;
    }
    descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !unchanged(sourceBefore, opened)) {
      return undefined;
    }
    // One extra byte detects growth without allowing readFile to allocate an
    // unbounded buffer while another app is rewriting its settings.
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) { break; }
      length += count;
    }
    if (length !== opened.size || !unchanged(opened, fs.fstatSync(descriptor))
      || !unchanged(opened, fs.lstatSync(sourcePath))
      || !unchanged(directoryBefore, fs.lstatSync(directory))) {
      return undefined;
    }
    const bytes = buffer.subarray(0, length);
    return validate(JSON.parse(bytes.toString('utf8')))
      ? { bytes, modified: opened.mtimeMs }
      : undefined;
  } catch {
    // Missing, unreadable, changing and malformed legacy files are optional.
    return undefined;
  } finally {
    if (descriptor !== undefined) { fs.closeSync(descriptor); }
  }
}

function destinationExists(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; }
    throw error;
  }
}

function publishIfAbsent(destination: string, bytes: Buffer): boolean {
  const temporary = path.join(path.dirname(destination), `.settings-migration-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // A hard link publishes the complete file atomically and fails if another
    // instance saved a destination after our initial check.
    fs.linkSync(temporary, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
    return false;
  } finally {
    if (descriptor !== undefined) { fs.closeSync(descriptor); }
    try { fs.unlinkSync(temporary); } catch { /* No temporary file was created. */ }
  }
}

/** Recover shared settings once, without changing any older installation. */
export function prepareApplicationSupport(appDataPath: string, portablePath?: string): string {
  if (portablePath) { return portablePath; }

  const supportPath = path.join(appDataPath, APPLICATION_SUPPORT_DIRECTORY_NAME);
  fs.mkdirSync(supportPath, { recursive: true, mode: 0o700 });
  const supportStats = fs.lstatSync(supportPath);
  if (!supportStats.isDirectory() || supportStats.isSymbolicLink()) {
    throw new Error('The application support location must be a directory, not a symbolic link.');
  }
  const settingsPath = path.join(supportPath, 'settings.json');
  let recoveredSettings = false;
  if (!destinationExists(settingsPath)) {
    let newest: LegacyFile | undefined;
    // Fixed order also makes equal modification times deterministic.
    for (const name of LEGACY_DIRECTORY_NAMES) {
      const candidate = readLegacyFile(path.join(appDataPath, name), 'settings.json', SETTINGS_MAX_BYTES, validSettings);
      if (candidate && (!newest || candidate.modified > newest.modified)) {
        newest = candidate;
      }
    }
    if (newest) { recoveredSettings = publishIfAbsent(settingsPath, newest.bytes); }
  }

  const authorityPath = path.join(supportPath, AUTHORITY_FILE_NAME);
  if (recoveredSettings && !destinationExists(authorityPath)) {
    // Only this fork's existing main-owned grants can survive its folder rename.
    // Preferences and older upstream/SIN installs never grant file access. Do
    // this only with the initial recovery, so deleting grants is respected.
    const authority = readLegacyFile(
      path.join(appDataPath, 'theatrum-ex-machina'), AUTHORITY_FILE_NAME, AUTHORITY_MAX_BYTES, validAuthority,
    );
    if (authority) { publishIfAbsent(authorityPath, authority.bytes); }
  }
  return supportPath;
}
