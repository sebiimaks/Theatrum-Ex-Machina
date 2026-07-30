import * as fs from 'node:fs';
import * as path from 'node:path';

export type PreviewTransactionStatus = 'pending' | 'committed';

export interface PreviewTransactionEntry {
  hadOriginal: boolean;
  relativePath: string;
}

export interface PreviewTransactionManifest {
  backupSuffix: string;
  entries: PreviewTransactionEntry[];
  status: PreviewTransactionStatus;
  version: 1;
}

export interface PreviewTransactionRecoveryResult {
  committedCleaned: number;
  rolledBack: number;
}

const TRANSACTION_MANIFEST = 'transaction.json';
const BACKUP_SUFFIX_PATTERN = /^\.regeneration-\d+-\d+-\d+\.bak$/;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function safeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (
    !relativePath
    || path.isAbsolute(relativePath)
    || normalized === '..'
    || normalized.startsWith('..' + path.sep)
  ) {
    throw new Error('Invalid preview transaction path.');
  }
  return normalized;
}

function validateManifest(value: unknown): PreviewTransactionManifest {
  const manifest = value as PreviewTransactionManifest;
  if (
    !manifest
    || manifest.version !== 1
    || (manifest.status !== 'pending' && manifest.status !== 'committed')
    || !BACKUP_SUFFIX_PATTERN.test(manifest.backupSuffix)
    || !Array.isArray(manifest.entries)
  ) {
    throw new Error('Invalid thumbnail transaction manifest.');
  }

  manifest.entries = manifest.entries.map((entry: PreviewTransactionEntry) => {
    if (!entry || typeof entry.hadOriginal !== 'boolean') {
      throw new Error('Invalid thumbnail transaction entry.');
    }
    return {
      hadOriginal: entry.hadOriginal,
      relativePath: safeRelativePath(entry.relativePath),
    };
  });
  return manifest;
}

async function writeManifest(
  stagingFolder: string,
  manifest: PreviewTransactionManifest,
): Promise<void> {
  await fs.promises.mkdir(stagingFolder, { recursive: true });
  const manifestPath = path.join(stagingFolder, TRANSACTION_MANIFEST);
  const temporaryPath = manifestPath + '.tmp';
  await fs.promises.writeFile(temporaryPath, JSON.stringify(manifest), 'utf8');
  await fs.promises.rename(temporaryPath, manifestPath);
}

export async function beginPreviewTransaction(
  stagingFolder: string,
  screenshotOutputFolder: string,
  relativePaths: string[],
  backupSuffix: string,
): Promise<PreviewTransactionManifest> {
  if (!BACKUP_SUFFIX_PATTERN.test(backupSuffix)) {
    throw new Error('Invalid thumbnail transaction backup suffix.');
  }

  const entries = await Promise.all(relativePaths.map(async (relativePath: string) => {
    const normalized = safeRelativePath(relativePath);
    return {
      hadOriginal: await pathExists(path.join(screenshotOutputFolder, normalized)),
      relativePath: normalized,
    };
  }));
  const manifest: PreviewTransactionManifest = {
    backupSuffix,
    entries,
    status: 'pending',
    version: 1,
  };
  await writeManifest(stagingFolder, manifest);
  return manifest;
}

export async function markPreviewTransactionCommitted(
  stagingFolder: string,
  manifest: PreviewTransactionManifest,
): Promise<void> {
  manifest.status = 'committed';
  await writeManifest(stagingFolder, manifest);
}

export async function recoverInterruptedPreviewTransactions(
  screenshotOutputFolder: string,
): Promise<PreviewTransactionRecoveryResult> {
  const transactionRoot = path.join(screenshotOutputFolder, '.thumbnail-regeneration');
  let directories: fs.Dirent[];
  try {
    directories = await fs.promises.readdir(transactionRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { committedCleaned: 0, rolledBack: 0 };
    }
    throw error;
  }

  let committedCleaned = 0;
  let rolledBack = 0;
  for (const directory of directories.filter(entry => entry.isDirectory())) {
    const stagingFolder = path.join(transactionRoot, directory.name);
    const manifestPath = path.join(stagingFolder, TRANSACTION_MANIFEST);
    if (!await pathExists(manifestPath)) {
      await fs.promises.rm(stagingFolder, { force: true, recursive: true });
      continue;
    }

    const manifest = validateManifest(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')));
    if (manifest.status === 'pending') {
      for (const entry of manifest.entries) {
        const original = path.join(screenshotOutputFolder, entry.relativePath);
        const backup = original + manifest.backupSuffix;
        if (entry.hadOriginal) {
          if (await pathExists(backup)) {
            await fs.promises.rm(original, { force: true });
            await fs.promises.rename(backup, original);
          }
        } else {
          await fs.promises.rm(original, { force: true });
        }
      }
      rolledBack++;
    } else {
      await Promise.all(manifest.entries.map((entry: PreviewTransactionEntry) => {
        const backup = path.join(screenshotOutputFolder, entry.relativePath) + manifest.backupSuffix;
        return fs.promises.rm(backup, { force: true });
      }));
      committedCleaned++;
    }

    await fs.promises.rm(stagingFolder, { force: true, recursive: true });
  }

  return { committedCleaned, rolledBack };
}
