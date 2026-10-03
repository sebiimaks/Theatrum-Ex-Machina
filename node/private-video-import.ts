import * as path from 'node:path';
import { NewImageElement, type FinalObject, type ImageElement } from '../interfaces/final-object.interface';
import { getImageLocations, normalizeImageLocationPartialPath } from '../interfaces/media-locations';
import { sourceFolderPathIsIgnored } from '../interfaces/source-folder-path';
import type { PrivatePreviewSource, PrivatePreviewSourceLocation } from './private-preview-source';
import type { PrivateVideoMetadata } from './private-preview-plan';
import type { PrivatePreviewSet } from './private-hub-preview-set';

export type PrivateVideoImportCheck = 'ready' | 'conflict' | 'invalid' | 'duplicate';
export type PrivateVideoImportResult = { status: 'imported'; index: number }
  | { status: Exclude<PrivateVideoImportCheck, 'ready'> };

function invalid(): Error { return new Error('Private video import is unavailable.'); }

/** Copy only main-owned location data; no mutable picker object survives admission. */
export function snapshotPrivateVideoImportLocation(value: PrivatePreviewSourceLocation): Readonly<PrivatePreviewSourceLocation> {
  if (!value || typeof value.hash !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.hash)
    || typeof value.root !== 'string' || !path.isAbsolute(value.root) || value.root.length > 32_768 || value.root.includes('\0')
    || typeof value.fileName !== 'string' || !value.fileName || value.fileName.length > 4_096
    || /[/\\\0]/.test(value.fileName) || value.fileName === '.' || value.fileName === '..'
    || typeof value.partialPath !== 'string' || value.partialPath.length > 16_384 || /[\\\0]/.test(value.partialPath)
    || value.partialPath.split('/').some(segment => segment === '..')
    || !Number.isSafeInteger(value.inputSource) || value.inputSource < 0) { throw invalid(); }
  const root = path.resolve(value.root);
  if (root === path.parse(root).root) { throw invalid(); }
  const partialPath = normalizeImageLocationPartialPath(value.partialPath);
  const file = path.resolve(root, partialPath.replace(/^\/+/, ''), value.fileName);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { throw invalid(); }
  return Object.freeze({ hash: value.hash, root, partialPath, fileName: value.fileName, inputSource: value.inputSource });
}

function locationKey(root: string, partialPath: string, fileName: string): string {
  const file = path.resolve(root, partialPath.replace(/^\/+/, ''), fileName);
  // Conservatively refuse duplicate spelling on the usual case-insensitive
  // platforms, without probing any source root that has not been granted.
  return process.platform === 'darwin' || process.platform === 'win32' ? file.toLowerCase() : file;
}

/** Pure catalogue checks run before a decoder sees the selected source. */
export function checkPrivateVideoImport(catalogue: FinalObject, location: PrivatePreviewSourceLocation): PrivateVideoImportCheck {
  try {
    const selected = snapshotPrivateVideoImportLocation(location);
    const folder = catalogue.inputDirs[selected.inputSource];
    if (!folder || typeof folder.path !== 'string' || !path.isAbsolute(folder.path)
      || path.resolve(folder.path) !== selected.root) { return 'conflict'; }
    if (sourceFolderPathIsIgnored(selected.partialPath, folder.ignoredSubdirectories)) { return 'invalid'; }
    const incoming = locationKey(selected.root, selected.partialPath, selected.fileName);
    for (const image of catalogue.images) {
      // Even a tombstone may own this preview namespace. Never replace a set
      // until a separate catalogue/preview replacement transaction exists.
      if (image.hash === selected.hash) { return 'conflict'; }
      if (image.deleted === true || image.cleanName === '*FOLDER*') { continue; }
      for (const existing of getImageLocations(image)) {
        const root = catalogue.inputDirs[existing.inputSource]?.path;
        if (typeof root !== 'string' || !path.isAbsolute(root)) { return 'invalid'; }
        if (locationKey(root, existing.partialPath, existing.fileName) === incoming) { return 'duplicate'; }
      }
    }
    return 'ready';
  } catch { return 'invalid'; }
}

/** New persisted metadata comes solely from a captured file and bounded probe. */
export function createPrivateImportedVideo(
  source: Pick<PrivatePreviewSource, 'hash' | 'byteLength' | 'birthtime' | 'mtime'>,
  location: PrivatePreviewSourceLocation, metadata: PrivateVideoMetadata, set: PrivatePreviewSet,
  index: number, dateAdded = Date.now(),
): ImageElement {
  const selected = snapshotPrivateVideoImportLocation(location);
  if (source.hash !== selected.hash || set.hash !== source.hash
    || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(dateAdded) || dateAdded < 0
    || !Number.isSafeInteger(source.byteLength) || source.byteLength < 1
    || ![source.birthtime, source.mtime].every(value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)
    || !metadata || !Number.isFinite(metadata.duration) || metadata.duration < 0.001 || metadata.duration > 604_800
    || ![metadata.width, metadata.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 32_768)
    || metadata.width * metadata.height > 268_435_456
    || !Number.isFinite(metadata.fps) || metadata.fps < 0 || metadata.fps > 1_000
    || typeof metadata.hasAudio !== 'boolean' || !Number.isInteger(set.screenCount) || set.screenCount < 1 || set.screenCount > 255) {
    throw invalid();
  }
  const extension = path.extname(selected.fileName);
  const title = selected.fileName.slice(0, extension ? -extension.length : undefined)
    // eslint-disable-next-line no-control-regex -- Strip file-name control characters from the displayed title.
    .replace(/[._\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return { ...NewImageElement(), hash: selected.hash, fileName: selected.fileName,
    cleanName: title && title !== '*FOLDER*' ? title : 'Video', inputSource: selected.inputSource,
    partialPath: selected.partialPath, birthtime: Math.round(source.birthtime), mtime: Math.round(source.mtime),
    fileSize: source.byteLength, duration: metadata.duration, width: metadata.width, height: metadata.height,
    fps: metadata.fps, bitrate: Math.round(source.byteLength / metadata.duration / 1_000_000 * 100) / 100,
    screens: set.screenCount, dateAdded, index };
}
