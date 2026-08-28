import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  THEATRUM_APP_HOST,
  THEATRUM_APP_PROTOCOL,
  isTheatrumMediaAssetType,
} from '../interfaces/theatrum-protocol';

function decodedProtocolPath(requestUrl: string): string | undefined {
  try {
    const parsed = new URL(requestUrl);
    if (
      parsed.protocol !== `${THEATRUM_APP_PROTOCOL}:`
      || parsed.host !== THEATRUM_APP_HOST
      || parsed.username
      || parsed.password
    ) {
      return undefined;
    }

    const encodedPath = parsed.pathname.replace(/^\/+/, '');
    const decodedPath = decodeURIComponent(encodedPath);
    return !decodedPath.includes('\0') && !decodedPath.includes('\\')
      ? decodedPath
      : undefined;
  } catch {
    return undefined;
  }
}

function isInsideDirectory(rootDirectory: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDirectory, candidatePath);
  return relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath);
}

interface CanonicalTheatrumAssetRoots {
  assetDirectory: string;
  outputDirectory: string;
}

/**
 * Resolve the physical output and asset roots together.  Both the lexical
 * relationship and the resolved relationship must be contained, so an asset
 * directory symlink cannot turn a catalogue preview operation into a write
 * elsewhere on disk.
 */
function resolveCanonicalTheatrumAssetRoots(
  outputDirectory: string,
  assetDirectory: string,
): CanonicalTheatrumAssetRoots | undefined {
  try {
    const lexicalOutputDirectory = path.resolve(outputDirectory);
    const lexicalAssetDirectory = path.resolve(assetDirectory);
    if (!isInsideDirectory(lexicalOutputDirectory, lexicalAssetDirectory)) {
      return undefined;
    }

    const canonicalOutputDirectory = fs.realpathSync.native(lexicalOutputDirectory);
    const canonicalAssetDirectory = fs.realpathSync.native(lexicalAssetDirectory);
    if (!isInsideDirectory(canonicalOutputDirectory, canonicalAssetDirectory)) {
      return undefined;
    }

    return {
      assetDirectory: canonicalAssetDirectory,
      outputDirectory: canonicalOutputDirectory,
    };
  } catch {
    return undefined;
  }
}

/** Resolve the canonical active preview-asset root, rejecting symlink escapes. */
export function resolveCanonicalTheatrumAssetDirectory(
  outputDirectory: string,
  assetDirectory: string,
): string | undefined {
  return resolveCanonicalTheatrumAssetRoots(outputDirectory, assetDirectory)?.assetDirectory;
}

/**
 * Resolve an existing file or directory within the active preview-asset tree.
 * Callers can use either the lexical or already-canonical asset prefix; the
 * returned path is always canonical and remains beneath the selected hub.
 */
export function resolveCanonicalTheatrumExistingAssetPath(
  filePath: string,
  outputDirectory: string,
  assetDirectory: string,
): string | undefined {
  const roots = resolveCanonicalTheatrumAssetRoots(outputDirectory, assetDirectory);
  if (!roots) {
    return undefined;
  }

  try {
    const lexicalAssetDirectory = path.resolve(assetDirectory);
    const candidatePath = path.resolve(filePath);
    if (
      !isInsideDirectory(lexicalAssetDirectory, candidatePath)
      && !isInsideDirectory(roots.assetDirectory, candidatePath)
    ) {
      return undefined;
    }

    const canonicalFilePath = fs.realpathSync.native(candidatePath);
    return isInsideDirectory(roots.assetDirectory, canonicalFilePath)
      ? canonicalFilePath
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve an app-bundle URL without allowing it to escape the packaged dist directory. */
export function resolveTheatrumAppFile(requestUrl: string, distDirectory: string): string | undefined {
  const decodedPath = decodedProtocolPath(requestUrl);
  if (decodedPath === undefined) {
    return undefined;
  }

  const relativePath = decodedPath === '' ? 'index.html' : decodedPath;
  if (relativePath === 'media' || relativePath.startsWith(`media${path.posix.sep}`)) {
    return undefined;
  }
  const rootDirectory = path.resolve(distDirectory);
  const candidatePath = path.resolve(rootDirectory, `.${path.sep}${relativePath}`);
  return isInsideDirectory(rootDirectory, candidatePath) ? candidatePath : undefined;
}

/**
 * Resolve a generated preview path. Only the three asset directories and their
 * expected file types are available to the renderer, even if it constructs a
 * URL itself.
 */
export function resolveTheatrumMediaFile(requestUrl: string, assetDirectory: string): string | undefined {
  const decodedPath = decodedProtocolPath(requestUrl);
  if (decodedPath === undefined) {
    return undefined;
  }

  const pathSegments = decodedPath.split('/');
  if (pathSegments.length !== 3 || pathSegments[0] !== 'media') {
    return undefined;
  }

  const [, assetType, fileName] = pathSegments;
  if (
    !isTheatrumMediaAssetType(assetType)
    || !fileName
    || fileName === '.'
    || fileName === '..'
    || path.basename(fileName) !== fileName
  ) {
    return undefined;
  }

  const extension = path.extname(fileName).toLowerCase();
  if (
    (assetType === 'clips' && extension !== '.mp4' && extension !== '.jpg')
    || (assetType !== 'clips' && extension !== '.jpg')
  ) {
    return undefined;
  }

  const rootDirectory = path.resolve(assetDirectory);
  const candidatePath = path.resolve(rootDirectory, assetType, fileName);
  if (!isInsideDirectory(rootDirectory, candidatePath)) {
    return undefined;
  }
  return candidatePath;
}

/** Build a safe generated-assets root from persisted catalogue state. */
export function resolveTheatrumAssetDirectory(outputDirectory: string, hubName: string): string | undefined {
  if (
    !outputDirectory
    || !hubName
    || hubName.includes('\0')
    || hubName.includes('/')
    || hubName.includes('\\')
  ) {
    return undefined;
  }

  const rootDirectory = path.resolve(outputDirectory);
  const assetDirectory = path.resolve(rootDirectory, `vha-${hubName}`);
  return isInsideDirectory(rootDirectory, assetDirectory) ? assetDirectory : undefined;
}

/**
 * Canonicalize a generated-preview write target, including its existing
 * parent directories, so a symlink cannot redirect a replacement outside the
 * active catalogue asset directory.
 */
export function resolveCanonicalTheatrumMediaWriteTarget(
  filePath: string,
  outputDirectory: string,
  assetDirectory: string,
): string | undefined {
  const roots = resolveCanonicalTheatrumAssetRoots(outputDirectory, assetDirectory);
  if (!roots) {
    return undefined;
  }

  try {
    const lexicalAssetDirectory = path.resolve(assetDirectory);
    const candidatePath = path.resolve(filePath);
    if (
      !isInsideDirectory(lexicalAssetDirectory, candidatePath)
      && !isInsideDirectory(roots.assetDirectory, candidatePath)
    ) {
      return undefined;
    }

    const canonicalParent = fs.realpathSync.native(path.dirname(candidatePath));
    if (!isInsideDirectory(roots.assetDirectory, canonicalParent)) {
      return undefined;
    }

    if (fs.existsSync(candidatePath)) {
      const canonicalFile = fs.realpathSync.native(candidatePath);
      return isInsideDirectory(roots.assetDirectory, canonicalFile)
        ? canonicalFile
        : undefined;
    }
    return path.join(canonicalParent, path.basename(candidatePath));
  } catch {
    return undefined;
  }
}
