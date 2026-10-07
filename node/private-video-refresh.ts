import * as path from 'node:path';
import type { FinalObject, ImageElement } from '../interfaces/final-object.interface';
import { getImageLocations } from '../interfaces/media-locations';
import { sourceFolderPathIsIgnored } from '../interfaces/source-folder-path';
import { privateVideoRevision } from './private-hub-metadata';
import type { PrivatePreviewSet } from './private-hub-preview-set';
import type { PrivateVideoMetadata } from './private-preview-plan';
import type { PrivatePreviewSource, PrivatePreviewSourceLocation } from './private-preview-source';
import { createPrivateImportedVideo, snapshotPrivateVideoImportLocation } from './private-video-import';

export interface PrivateVideoRefreshUpdate { index: number; revision: string; }
export type PrivateVideoRefreshResult = { status: 'refreshed'; image: ImageElement }
  | { status: 'conflict' | 'invalid' | 'busy' };
export type PrivateVideoRefreshCheck = 'ready' | 'conflict' | 'invalid';

/** Main-only row revision, detached before queue admission. */
export function snapshotPrivateVideoRefreshUpdate(value: unknown): Readonly<PrivateVideoRefreshUpdate> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { return; }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== 2 || !Object.hasOwn(descriptors, 'index') || !Object.hasOwn(descriptors, 'revision')) { return; }
    for (const field of Object.values(descriptors)) {
      if (!field.enumerable || !Object.hasOwn(field, 'value')) { return; }
    }
    const index = descriptors.index.value;
    const revision = descriptors.revision.value;
    if (!Number.isSafeInteger(index) || index < 0 || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) { return; }
    return Object.freeze({ index, revision });
  } catch { return; }
}

/** No source I/O. Ambiguous aliases and reused preview namespaces are refused. */
export function checkPrivateVideoRefresh(
  catalogue: FinalObject, location: PrivatePreviewSourceLocation, update: PrivateVideoRefreshUpdate,
): PrivateVideoRefreshCheck {
  try {
    const request = snapshotPrivateVideoRefreshUpdate(update);
    const selected = snapshotPrivateVideoImportLocation(location);
    if (!request || !Array.isArray(catalogue.images) || catalogue.images.length > 100_000) { return 'invalid'; }
    const image = catalogue.images[request.index];
    if (!image || privateVideoRevision(image) !== request.revision) { return 'conflict'; }
    if (image.deleted || image.cleanName === '*FOLDER*' || typeof image.hash !== 'string'
      || !/^[a-zA-Z0-9_-]{1,200}$/.test(image.hash)) { return 'invalid'; }
    const locations = getImageLocations(image);
    if (locations.length !== 1) { return 'invalid'; }
    const saved = locations[0];
    const folder = catalogue.inputDirs?.[saved.inputSource];
    if (!folder || typeof folder.path !== 'string' || !path.isAbsolute(folder.path)
      || path.resolve(folder.path) !== selected.root || saved.inputSource !== selected.inputSource
      || saved.fileName !== selected.fileName || saved.partialPath !== selected.partialPath) { return 'conflict'; }
    if (sourceFolderPathIsIgnored(saved.partialPath, folder.ignoredSubdirectories)) { return 'invalid'; }
    let previousOwners = 0;
    for (const row of catalogue.images) {
      // Tombstones and folder rows can still retain a preview namespace.
      if (row.hash === selected.hash) { return 'conflict'; }
      if (row.hash === image.hash) { previousOwners++; }
    }
    return previousOwners === 1 ? 'ready' : 'conflict';
  } catch { return 'invalid'; }
}

/** Replace technical fields only; user metadata, source associations and unknown fields survive intact. */
export function createPrivateRefreshedVideo(
  image: ImageElement, source: Pick<PrivatePreviewSource, 'hash' | 'byteLength' | 'birthtime' | 'mtime'>,
  location: PrivatePreviewSourceLocation, metadata: PrivateVideoMetadata, set: PrivatePreviewSet,
): ImageElement {
  // Reuse the bounded probe/source validation and numeric conventions used by import.
  const technical = createPrivateImportedVideo(source, location, metadata, set, 0, 0);
  const refreshed = { ...image, hash: technical.hash, fileSize: technical.fileSize,
    birthtime: technical.birthtime, mtime: technical.mtime, duration: technical.duration,
    width: technical.width, height: technical.height, fps: technical.fps, bitrate: technical.bitrate,
    screens: technical.screens };
  if (refreshed.defaultScreen !== undefined && (!Number.isInteger(refreshed.defaultScreen)
    || refreshed.defaultScreen < 0 || refreshed.defaultScreen >= refreshed.screens)) { delete refreshed.defaultScreen; }
  return refreshed;
}
