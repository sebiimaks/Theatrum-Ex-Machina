import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  resolveCanonicalTheatrumAssetDirectory,
  resolveCanonicalTheatrumExistingAssetPath,
  resolveCanonicalTheatrumMediaWriteTarget,
} from './theatrum-protocol-paths';

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
const PREVIEW_ASSET_DIRECTORIES = new Set(['thumbnails', 'filmstrips', 'clips']);

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
  const [assetDirectory] = normalized.replace(/\\/g, '/').split('/');
  if (!PREVIEW_ASSET_DIRECTORIES.has(assetDirectory)) {
    throw new Error('Invalid preview transaction path.');
  }
  return normalized;
}

function isInsideDirectory(rootDirectory: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDirectory, candidatePath);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function emptyRecoveryResult(): PreviewTransactionRecoveryResult {
  return { committedCleaned: 0, rolledBack: 0 };
}

interface ResolvedRecoveryEntry {
  backup?: string;
  hadOriginal: boolean;
  original: string;
}

async function resolveRecoveryEntries(
  entries: PreviewTransactionEntry[],
  backupSuffix: string,
  outputDirectory: string,
  assetDirectory: string,
): Promise<ResolvedRecoveryEntry[]> {
  return Promise.all(entries.map(async (entry: PreviewTransactionEntry) => {
    const originalPath = path.join(assetDirectory, entry.relativePath);
    const original = resolveCanonicalTheatrumMediaWriteTarget(
      originalPath,
      outputDirectory,
      assetDirectory,
    );
    if (!original) {
      throw new Error('A thumbnail transaction target is outside the active catalogue assets.');
    }

    const backupPath = originalPath + backupSuffix;
    if (!await pathExists(backupPath)) {
      return { hadOriginal: entry.hadOriginal, original };
    }
    const backup = resolveCanonicalTheatrumMediaWriteTarget(
      backupPath,
      outputDirectory,
      assetDirectory,
    );
    if (!backup) {
      throw new Error('A thumbnail transaction backup is outside the active catalogue assets.');
    }
    return { backup, hadOriginal: entry.hadOriginal, original };
  }));
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
  outputDirectory: string,
  assetDirectory: string,
): Promise<PreviewTransactionRecoveryResult> {
  if (!fs.existsSync(assetDirectory)) {
    return emptyRecoveryResult();
  }
  const canonicalAssetDirectory = resolveCanonicalTheatrumAssetDirectory(
    outputDirectory,
    assetDirectory,
  );
  if (!canonicalAssetDirectory) {
    throw new Error('The catalogue preview asset directory is outside the selected output folder.');
  }

  const transactionRoot = path.join(canonicalAssetDirectory, '.thumbnail-regeneration');
  if (!fs.existsSync(transactionRoot)) {
    return emptyRecoveryResult();
  }
  const canonicalTransactionRoot = resolveCanonicalTheatrumExistingAssetPath(
    transactionRoot,
    outputDirectory,
    assetDirectory,
  );
  if (!canonicalTransactionRoot || !fs.statSync(canonicalTransactionRoot).isDirectory()) {
    throw new Error('The thumbnail transaction directory is outside the active catalogue assets.');
  }

  let directories: fs.Dirent[];
  try {
    directories = await fs.promises.readdir(canonicalTransactionRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRecoveryResult();
    }
    throw error;
  }

  let committedCleaned = 0;
  let rolledBack = 0;
  for (const directory of directories.filter(entry => entry.isDirectory())) {
    const stagingFolder = path.join(canonicalTransactionRoot, directory.name);
    const canonicalStagingFolder = resolveCanonicalTheatrumExistingAssetPath(
      stagingFolder,
      outputDirectory,
      assetDirectory,
    );
    if (
      !canonicalStagingFolder
      || !isInsideDirectory(canonicalTransactionRoot, canonicalStagingFolder)
      || !fs.statSync(canonicalStagingFolder).isDirectory()
    ) {
      console.warn('Skipping a thumbnail transaction outside the active catalogue assets.');
      continue;
    }
    const manifestPath = path.join(canonicalStagingFolder, TRANSACTION_MANIFEST);
    if (!await pathExists(manifestPath)) {
      await fs.promises.rm(canonicalStagingFolder, { force: true, recursive: true });
      continue;
    }

    const canonicalManifestPath = resolveCanonicalTheatrumExistingAssetPath(
      manifestPath,
      outputDirectory,
      assetDirectory,
    );
    if (!canonicalManifestPath || !isInsideDirectory(canonicalStagingFolder, canonicalManifestPath)) {
      throw new Error('A thumbnail transaction manifest is outside the active catalogue assets.');
    }

    const manifest = validateManifest(JSON.parse(await fs.promises.readFile(canonicalManifestPath, 'utf8')));
    const recoveryEntries = await resolveRecoveryEntries(
      manifest.entries,
      manifest.backupSuffix,
      outputDirectory,
      assetDirectory,
    );
    if (manifest.status === 'pending') {
      for (const entry of recoveryEntries) {
        if (entry.hadOriginal) {
          if (entry.backup) {
            await fs.promises.rm(entry.original, { force: true });
            await fs.promises.rename(entry.backup, entry.original);
          }
        } else {
          await fs.promises.rm(entry.original, { force: true });
        }
      }
      rolledBack++;
    } else {
      await Promise.all(recoveryEntries.map((entry: ResolvedRecoveryEntry) => {
        return entry.backup
          ? fs.promises.rm(entry.backup, { force: true })
          : Promise.resolve();
      }));
      committedCleaned++;
    }

    await fs.promises.rm(canonicalStagingFolder, { force: true, recursive: true });
  }

  return { committedCleaned, rolledBack };
}
