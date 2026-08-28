import * as fs from 'fs';
import * as path from 'path';

import type { FinalObject } from '../interfaces/final-object.interface';
import { isSafeCatalogueHubName } from '../interfaces/catalogue-file';
import { normalizeIgnoredSubdirectories } from '../interfaces/source-folder-path';
import {
  imageLocationKey,
  normalizeImageLocation,
} from '../interfaces/media-locations';

export interface VhaFileReadResult {
  backupError?: Error;
  backupRaw?: string;
  finalObject?: FinalObject;
  primaryError?: Error;
  raw?: string;
  source: 'backup' | 'invalid' | 'primary' | 'unreadable';
}

export interface VhaFileRecoveryResult {
  corruptPath?: string;
  finalObject: FinalObject;
}

interface VhaFileCandidate {
  error?: Error;
  failure?: 'invalid' | 'missing' | 'unreadable';
  finalObject?: FinalObject;
  raw?: string;
}

const writeQueues = new Map<string, Promise<unknown>>();
let temporaryFileCounter = 0;
export const CATALOGUE_FILE_MAX_BYTES = 256 * 1024 * 1024;
const CATALOGUE_SOURCE_MAX_COUNT = 4096;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse and minimally validate a catalogue.
 * Version 2 catalogues legitimately use `inputDir` until upgraded after loading.
 */
export function parseVhaJson(raw: string | Buffer): FinalObject {
  const json = raw.toString().replace(/^\uFEFF/, '');
  const parsed: unknown = JSON.parse(json);

  if (!isObject(parsed)) {
    throw new Error('The catalogue root must be a JSON object.');
  }
  if (!isSafeCatalogueHubName(parsed.hubName)) {
    throw new Error('The catalogue does not contain a valid hub name.');
  }
  if (!Array.isArray(parsed.images)) {
    throw new Error('The catalogue does not contain a valid images list.');
  }
  if (
    parsed.tagDefinitions !== undefined
    && (
      !Array.isArray(parsed.tagDefinitions)
      || parsed.tagDefinitions.some((definition: unknown) => (
        typeof definition !== 'string' || !definition
      ))
    )
  ) {
    throw new Error('The catalogue contains invalid tag definitions.');
  }
  parsed.images.forEach((image: unknown) => {
    if (isObject(image) && image.missing !== undefined && typeof image.missing !== 'boolean') {
      throw new Error('The catalogue contains an invalid missing-file state.');
    }
    if (!isObject(image) || image.locations === undefined) {
      return;
    }
    try {
      if (!Array.isArray(image.locations) || image.locations.length === 0) {
        throw new Error('The authoritative media locations are empty or invalid.');
      }
      const locations = image.locations.map(location => normalizeImageLocation(location));
      const locationKeys = locations.map(location => imageLocationKey(location));
      if (new Set(locationKeys).size !== locationKeys.length) {
        throw new Error('The authoritative media locations contain duplicates.');
      }
      const legacyMirror = normalizeImageLocation({
        fileName: image.fileName,
        inputSource: image.inputSource,
        partialPath: image.partialPath,
      });
      if (locationKeys[0] !== imageLocationKey(legacyMirror)) {
        throw new Error('The preferred media location mirror is inconsistent.');
      }
      const allLocationsMissing = locations.every(location => location.missing === true);
      if ((image.missing === true) !== allLocationsMissing) {
        throw new Error('The aggregate media availability state is inconsistent.');
      }
    } catch {
      throw new Error('The catalogue contains invalid media locations.');
    }
  });
  if (!isObject(parsed.screenshotSettings)) {
    throw new Error('The catalogue does not contain valid screenshot settings.');
  }

  const hasCurrentInputDirectories = isObject(parsed.inputDirs);
  const hasLegacyInputDirectory = parsed.version === 2 && typeof parsed.inputDir === 'string';
  if (!hasCurrentInputDirectories && !hasLegacyInputDirectory) {
    throw new Error('The catalogue does not contain valid video folder information.');
  }

  if (hasCurrentInputDirectories) {
    const configuredSourceKeys = Object.keys(parsed.inputDirs);
    if (configuredSourceKeys.length > CATALOGUE_SOURCE_MAX_COUNT) {
      throw new Error('The catalogue contains too many video folder entries.');
    }
    configuredSourceKeys.forEach((sourceKey: string) => {
      if (!/^(0|[1-9]\d*)$/.test(sourceKey) || !Number.isSafeInteger(Number(sourceKey))) {
        throw new Error('The catalogue contains an invalid video folder key.');
      }
    });
    Object.values(parsed.inputDirs).forEach((inputDirectory: unknown) => {
      if (
        !isObject(inputDirectory)
        || typeof inputDirectory.path !== 'string'
        || inputDirectory.path.length === 0
        || inputDirectory.path.includes('\0')
      ) {
        throw new Error('The catalogue contains an invalid video folder entry.');
      }
      if (inputDirectory.watch !== undefined && typeof inputDirectory.watch !== 'boolean') {
        throw new Error('The catalogue contains an invalid folder watch setting.');
      }
      if (inputDirectory.ignoredSubdirectories !== undefined) {
        try {
          inputDirectory.ignoredSubdirectories = normalizeIgnoredSubdirectories(
            inputDirectory.ignoredSubdirectories,
          );
        } catch {
          throw new Error('The catalogue contains invalid ignored subdirectories.');
        }
      }
    });
    const configuredSourceKeySet = new Set(configuredSourceKeys);
    parsed.images.forEach((image: unknown) => {
      if (!isObject(image)) {
        throw new Error('The catalogue contains an invalid image entry.');
      }
      try {
        if (image.locations === undefined) {
          const legacySourceIndex = Number(image.inputSource);
          if (
            !Number.isSafeInteger(legacySourceIndex)
            || legacySourceIndex < 0
            || !configuredSourceKeySet.has(String(legacySourceIndex))
          ) {
            throw new Error('The legacy media source is not configured.');
          }
          return;
        }
        const locations = image.locations as unknown[];
        locations.forEach((location: unknown) => {
          const normalizedLocation = normalizeImageLocation(location);
          if (!configuredSourceKeySet.has(String(normalizedLocation.inputSource))) {
            throw new Error('The media location source is not configured.');
          }
        });
      } catch {
        throw new Error('The catalogue contains invalid media locations.');
      }
    });
  }

  return parsed as unknown as FinalObject;
}

async function readCandidate(filePath: string): Promise<VhaFileCandidate> {
  let raw: string;
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      return {
        error: new Error('The catalogue path is not a file.'),
        failure: 'invalid',
      };
    }
    if (stats.size > CATALOGUE_FILE_MAX_BYTES) {
      return {
        error: new Error('The catalogue file is larger than the 256 MB safety limit.'),
        failure: 'invalid',
      };
    }
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    return {
      error: asError(error),
      failure: fileError.code === 'ENOENT' ? 'missing' : 'unreadable',
    };
  }
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > CATALOGUE_FILE_MAX_BYTES) {
      return {
        error: new Error('The catalogue file grew beyond the 256 MB safety limit while it was being read.'),
        failure: 'invalid',
      };
    }
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    return {
      error: asError(error),
      failure: fileError.code === 'ENOENT' ? 'missing' : 'unreadable',
    };
  }

  try {
    return {
      finalObject: parseVhaJson(raw),
      raw,
    };
  } catch (error) {
    return {
      error: asError(error),
      failure: 'invalid',
      raw,
    };
  }
}

/**
 * Read the primary catalogue and, only if it is invalid, inspect its backup.
 * This function never modifies either file.
 */
export async function readVhaFileWithBackup(pathToTheFile: string): Promise<VhaFileReadResult> {
  const primary = await readCandidate(pathToTheFile);
  if (primary.finalObject) {
    return {
      finalObject: primary.finalObject,
      raw: primary.raw,
      source: 'primary',
    };
  }

  if (primary.failure === 'unreadable') {
    return {
      primaryError: primary.error,
      source: 'unreadable',
    };
  }

  const backup = await readCandidate(pathToTheFile + '.bak');
  if (backup.finalObject) {
    return {
      backupRaw: backup.raw,
      finalObject: backup.finalObject,
      primaryError: primary.error,
      raw: backup.raw,
      source: 'backup',
    };
  }

  return {
    backupError: backup.error,
    primaryError: primary.error,
    source: 'invalid',
  };
}

function createTemporaryPath(targetPath: string, label: string): string {
  temporaryFileCounter++;
  return `${targetPath}.${label}-${process.pid}-${Date.now()}-${temporaryFileCounter}`;
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== 'ENOENT') {
      console.log('Unable to remove temporary file:', filePath, fileError);
    }
  }
}

async function writeSyncedFile(filePath: string, contents: string): Promise<void> {
  const fileHandle = await fs.promises.open(filePath, 'wx');
  try {
    await fileHandle.writeFile(contents, 'utf8');
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}

async function syncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  let directoryHandle: fs.promises.FileHandle | undefined;
  try {
    directoryHandle = await fs.promises.open(path.dirname(filePath), 'r');
    await directoryHandle.sync();
  } catch (error) {
    console.log('Unable to sync parent directory after replacing JSON file:', filePath, error);
  } finally {
    if (directoryHandle) {
      try {
        await directoryHandle.close();
      } catch (error) {
        console.log('Unable to close parent directory after syncing JSON file:', filePath, error);
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function renameWithRetry(sourcePath: string, targetPath: string): Promise<void> {
  const retryDelays = [0, 30, 90, 180];

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) {
      await delay(retryDelays[attempt]);
    }

    try {
      await fs.promises.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      const isTransient = ['EACCES', 'EBUSY', 'EPERM'].includes(fileError.code);
      if (!isTransient || attempt === retryDelays.length - 1) {
        throw error;
      }
    }
  }
}

async function preserveFailedReplacement(temporaryPath: string, targetPath: string): Promise<string> {
  const failedPath = createTemporaryPath(targetPath, 'failed');
  try {
    await fs.promises.rename(temporaryPath, failedPath);
    return failedPath;
  } catch {
    return temporaryPath;
  }
}

async function replaceWithValidatedJson(
  targetPath: string,
  contents: string,
  validate: (contentsToValidate: string) => unknown,
): Promise<void> {
  const temporaryPath = createTemporaryPath(targetPath, 'tmp');

  try {
    await writeSyncedFile(temporaryPath, contents);
    const completedContents = await fs.promises.readFile(temporaryPath, 'utf8');
    validate(completedContents);
  } catch (error) {
    await removeTemporaryFile(temporaryPath);
    throw error;
  }

  try {
    await renameWithRetry(temporaryPath, targetPath);
    await syncParentDirectory(targetPath);
  } catch (error) {
    try {
      const targetContents = await fs.promises.readFile(targetPath, 'utf8');
      validate(targetContents);
      if (targetContents === contents) {
        await removeTemporaryFile(temporaryPath);
        return;
      }
    } catch {
      // The target is absent, unreadable, invalid, or does not contain this completed write.
    }

    const preservedPath = await preserveFailedReplacement(temporaryPath, targetPath);
    const renameError = asError(error);
    throw new Error(`${renameError.message} The completed data was preserved at ${preservedPath}`);
  }
}

function enqueueWrite<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  const queueKey = path.resolve(targetPath);
  const previousWrite = writeQueues.get(queueKey) || Promise.resolve();
  const nextWrite = previousWrite.catch(() => undefined).then(operation);
  writeQueues.set(queueKey, nextWrite);

  const clearCompletedWrite = () => {
    if (writeQueues.get(queueKey) === nextWrite) {
      writeQueues.delete(queueKey);
    }
  };
  nextWrite.then(clearCompletedWrite, clearCompletedWrite);

  return nextWrite;
}

async function updateBackupFromValidPrimary(pathToTheFile: string): Promise<void> {
  const current = await readCandidate(pathToTheFile);
  if (current.failure === 'missing') {
    return;
  }
  if (!current.finalObject || current.raw === undefined) {
    throw current.error || new Error('The existing catalogue could not be validated and was not overwritten.');
  }

  await replaceWithValidatedJson(pathToTheFile + '.bak', current.raw, parseVhaJson);
}

/**
 * Queue catalogue writes by path, validate a completed same-directory temporary
 * file, preserve the current valid catalogue as a backup, then atomically replace it.
 */
export function writeVhaJsonAtomically(pathToTheFile: string, json: string): Promise<void> {
  return enqueueWrite(pathToTheFile, async () => {
    parseVhaJson(json);
    await updateBackupFromValidPrimary(pathToTheFile);
    await replaceWithValidatedJson(pathToTheFile, json, parseVhaJson);
  });
}

/**
 * Publish a complete, validated catalogue at a path that must not already exist.
 * A same-directory temporary file is fully written and synced before an atomic
 * hard-link creates the destination directory entry. Network filesystems that
 * reject hard links use an exclusive, synced copy instead. Both paths protect
 * an existing file from replacement and never create or change a backup.
 */
export function writeVhaJsonExclusively(pathToTheFile: string, json: string): Promise<void> {
  return enqueueWrite(pathToTheFile, async () => {
    parseVhaJson(json);
    const temporaryPath = createTemporaryPath(pathToTheFile, 'tmp');

    try {
      await writeSyncedFile(temporaryPath, json);
      const completedContents = await fs.promises.readFile(temporaryPath, 'utf8');
      parseVhaJson(completedContents);
      try {
        await fs.promises.link(temporaryPath, pathToTheFile);
      } catch (error) {
        const linkError = error as NodeJS.ErrnoException;
        if (linkError.code === 'EEXIST') {
          throw error;
        }
        if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'EINVAL'].includes(linkError.code || '')) {
          throw error;
        }

        // Some SMB/NAS volumes do not support hard links. COPYFILE_EXCL keeps
        // the no-overwrite guarantee there; the completed temporary file stays
        // available until the destination has also been synced and validated.
        try {
          await fs.promises.copyFile(temporaryPath, pathToTheFile, fs.constants.COPYFILE_EXCL);
          const destinationHandle = await fs.promises.open(pathToTheFile, 'r+');
          try {
            await destinationHandle.sync();
          } finally {
            await destinationHandle.close();
          }
          const destinationContents = await fs.promises.readFile(pathToTheFile, 'utf8');
          parseVhaJson(destinationContents);
          if (destinationContents !== json) {
            throw new Error('The completed catalogue copy did not match its source data.');
          }
        } catch (copyError) {
          const exclusiveCopyError = copyError as NodeJS.ErrnoException;
          if (exclusiveCopyError.code !== 'EEXIST') {
            await removeTemporaryFile(pathToTheFile);
          }
          throw copyError;
        }
      }
      await syncParentDirectory(pathToTheFile);
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code === 'EEXIST') {
        throw error;
      }
      try {
        const destinationContents = await fs.promises.readFile(pathToTheFile, 'utf8');
        if (destinationContents !== json) {
          throw error;
        }
        parseVhaJson(destinationContents);
      } catch {
        throw error;
      }
    } finally {
      await removeTemporaryFile(temporaryPath);
    }
  });
}

/** Atomically replace a general JSON file without applying catalogue validation. */
export function writeJsonAtomically(pathToTheFile: string, json: string): Promise<void> {
  return enqueueWrite(pathToTheFile, async () => {
    JSON.parse(json);
    await replaceWithValidatedJson(pathToTheFile, json, JSON.parse);
  });
}

function createCorruptCopyPath(pathToTheFile: string): string {
  return createTemporaryPath(pathToTheFile, 'corrupt');
}

/**
 * Restore a validated backup while retaining an exact copy of the invalid
 * primary catalogue for inspection or manual salvage.
 */
export function recoverVhaFileFromBackup(pathToTheFile: string): Promise<VhaFileRecoveryResult> {
  return enqueueWrite(pathToTheFile, async (): Promise<VhaFileRecoveryResult> => {
    const backup = await readCandidate(pathToTheFile + '.bak');
    if (!backup.finalObject || backup.raw === undefined) {
      throw backup.error || new Error('The catalogue backup is not valid.');
    }

    let corruptPath: string | undefined;
    try {
      const primaryStats = await fs.promises.stat(pathToTheFile);
      if (primaryStats.size > 0) {
        corruptPath = createCorruptCopyPath(pathToTheFile);
        await fs.promises.copyFile(pathToTheFile, corruptPath, fs.constants.COPYFILE_EXCL);
        const corruptFileHandle = await fs.promises.open(corruptPath, 'r+');
        try {
          await corruptFileHandle.sync();
        } finally {
          await corruptFileHandle.close();
        }
      }
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw error;
      }
    }

    await replaceWithValidatedJson(pathToTheFile, backup.raw, parseVhaJson);
    return {
      corruptPath,
      finalObject: backup.finalObject,
    };
  });
}
