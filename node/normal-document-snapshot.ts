import * as fs from 'node:fs';
import type { FinalObject, ImageElement, InputSources } from '../interfaces/final-object.interface';
import { getImageLocations, normalizeImageElementLocations, removeImageLocationsForSource } from '../interfaces/media-locations';
import type { VhaGlobals } from './main-globals';
import { catalogueMediaAuthorityHashes, reconcileCatalogueMediaLocationAuthority } from './catalogue-media-authority';
import { captureCatalogueStorageTarget, writeCatalogueStorage } from './catalogue-storage';
import { prepareAuthorizedCatalogueWrite } from './catalogue-write-authority';
import { normalizeAbsolutePath } from './local-operation-safety';
import { parseVhaJson } from './vha-file-persistence';

export interface NormalDocumentSnapshotOptions {
  readonly state: VhaGlobals;
  /** Main-owned closure asserting the exact, currently drained pause proof. */
  readonly assertPaused: () => void;
  /** Original window/frame and catalogue identity; never renderer-provided. */
  readonly isCurrent: () => boolean;
  /** Test seam; production uses the captured normal storage target's atomic writer. */
  readonly write?: typeof writeCatalogueStorage;
}

export interface NormalDocumentSnapshot {
  assertCurrent(): void;
  /** One frozen renderer snapshot; never a destination path or storage mode. */
  saveSnapshot(document: FinalObject | null): Promise<void>;
}

function unavailable(): Error { return new Error('The normal catalogue snapshot is unavailable.'); }

/** Both identities and contents are checked: in-place grant changes also revoke the capture. */
function captureAuthority(state: VhaGlobals): { references: unknown[]; values: string } {
  return {
    references: [state.catalogueStorage, state.selectedSourceFolders, state.authorizedCataloguePaths,
      state.authorizedCatalogueImageHashes, state.authorizedCatalogueMediaLocations,
      state.authorizedSourceFolderPaths, state.authorizedSourceFolderRealPaths, state.authorizedSourceWatchPaths,
      state.screenshotSettings],
    values: JSON.stringify({
      storage: state.catalogueStorage.kind, path: state.currentlyOpenVhaFile, access: state.catalogueAccessMode,
      generation: state.catalogueSessionGeneration, hub: state.hubName, output: state.selectedOutputFolder,
      sources: state.selectedSourceFolders, screenshots: state.screenshotSettings, version: state.vhaFileVersion,
      cataloguePaths: [...state.authorizedCataloguePaths].sort(), hashes: [...state.authorizedCatalogueImageHashes].sort(),
      locations: [...state.authorizedCatalogueMediaLocations].sort(), sourcePaths: [...state.authorizedSourceFolderPaths].sort(),
      sourceRealPaths: [...state.authorizedSourceFolderRealPaths].sort(), watches: [...state.authorizedSourceWatchPaths].sort(),
    }),
  };
}

/** Match the ordinary writer's persisted image projection without consulting mutable GLOBALS. */
function preparePersistedImages(document: FinalObject): void {
  document.images = document.images.filter(image => image.deleted !== true);
  document.images.forEach(image => {
    if (image.cleanName === '*FOLDER*') { throw unavailable(); }
    for (const key of ['durationDisplay', 'fileSizeDisplay', 'index', 'resBucket', 'resolution', 'selected', 'uuid'] as const) {
      delete image[key];
    }
    normalizeImageElementLocations(image);
    const removedSources = new Set(getImageLocations(image).map(location => location.inputSource)
      .filter(source => !Object.hasOwn(document.inputDirs, source)));
    removedSources.forEach(source => removeImageLocationsForSource(image, source));
  });
  document.images = document.images.filter(image => getImageLocations(image).length > 0);
  document.images.sort((left, right) => {
    const leftPath = left.partialPath.toLowerCase();
    const rightPath = right.partialPath.toLowerCase();
    if (leftPath !== rightPath) { return leftPath < rightPath ? -1 : 1; }
    const leftName = left.fileName.toLowerCase();
    const rightName = right.fileName.toLowerCase();
    return leftName === rightName ? 0 : leftName < rightName ? -1 : 1;
  });
  let previous: ImageElement | undefined;
  document.images = document.images.filter(image => {
    const duplicate = previous && image.fileName === previous.fileName
      && image.partialPath === previous.partialPath && image.inputSource === previous.inputSource;
    previous = image;
    return !duplicate;
  });
  document.numOfFolders = new Set(document.images.map(image => image.partialPath)).size;
}

/**
 * Capture only after ordinary jobs have drained. The renderer stays frozen and
 * the pause stays sealed throughout this write. A late completion can finish
 * its original atomic write, but cannot publish authority into a changed hub.
 */
export function captureNormalDocumentSnapshot(options: NormalDocumentSnapshotOptions): NormalDocumentSnapshot {
  const { state, assertPaused, isCurrent } = Object.freeze({ ...options });
  const write = options.write ?? writeCatalogueStorage;
  assertPaused();
  if (!isCurrent() || state.catalogueStorage?.kind !== 'normal'
    || (state.catalogueAccessMode !== 'read-write' && state.catalogueAccessMode !== 'read-only')) { throw unavailable(); }
  assertPaused();
  const storage = state.catalogueStorage;
  if (storage?.kind !== 'normal') { throw unavailable(); }
  const cataloguePath = state.currentlyOpenVhaFile
    ? fs.realpathSync.native(normalizeAbsolutePath(state.currentlyOpenVhaFile, 'Catalogue file')) : undefined;
  if (cataloguePath && (!state.authorizedCataloguePaths.has(cataloguePath) || !fs.statSync(cataloguePath).isFile())) {
    throw unavailable();
  }
  const target = cataloguePath ? captureCatalogueStorageTarget(storage, cataloguePath) : undefined;
  if (target && target.kind !== 'normal') { throw unavailable(); }
  const writable = !!target && state.catalogueAccessMode === 'read-write';
  const configuredSources = structuredClone(state.selectedSourceFolders);
  const screenshotSettings = structuredClone(state.screenshotSettings);
  const hubName = state.hubName;
  const version = state.vhaFileVersion;
  const hashes = new Set(state.authorizedCatalogueImageHashes);
  const locations = new Set(state.authorizedCatalogueMediaLocations);
  let expected = captureAuthority(state);
  let phase: 'ready' | 'saving' | 'saved' | 'failed' = 'ready';

  const assertCurrent = (): void => {
    if (phase === 'failed') { throw unavailable(); }
    assertPaused();
    if (isCurrent() !== true) { throw unavailable(); }
    assertPaused();
    const actual = captureAuthority(state);
    if (actual.values !== expected.values || actual.references.some((value, index) => value !== expected.references[index])) {
      throw unavailable();
    }
    if (cataloguePath && fs.realpathSync.native(state.currentlyOpenVhaFile) !== cataloguePath) { throw unavailable(); }
  };
  assertCurrent();

  const saveSnapshot = async (document: FinalObject | null): Promise<void> => {
    if (phase !== 'ready') { throw unavailable(); }
    phase = 'saving';
    try {
      assertCurrent();
      if (!writable) {
        if (document !== null) { throw unavailable(); }
        phase = 'saved';
        return;
      }
      if (document === null || !target) { throw unavailable(); }
      const prepared = prepareAuthorizedCatalogueWrite(document, configuredSources, hubName);
      // Even associations subsequently removed by the persistence projection
      // must first belong to the captured normal catalogue.
      reconcileCatalogueMediaLocationAuthority(prepared.images, hashes, locations);
      preparePersistedImages(prepared);
      prepared.screenshotSettings = structuredClone(screenshotSettings);
      prepared.version = version;
      const validated = parseVhaJson(JSON.stringify(prepared));
      const nextLocations = reconcileCatalogueMediaLocationAuthority(validated.images, hashes, locations);
      const nextHashes = catalogueMediaAuthorityHashes(nextLocations);
      const nextSources: InputSources = structuredClone(validated.inputDirs);
      const retainedRoots = new Set(Object.values(nextSources).map(source => normalizeAbsolutePath(source.path, 'Source folder')));
      const removedRoots = new Set(Object.values(configuredSources).map(source => normalizeAbsolutePath(source.path, 'Source folder'))
        .filter(root => !retainedRoots.has(root)));
      const nextSourcePaths = new Set([...state.authorizedSourceFolderPaths].filter(root => !removedRoots.has(root)));
      const nextRealPaths = new Map([...state.authorizedSourceFolderRealPaths].filter(([root]) => !removedRoots.has(root)));
      const nextWatchPaths = new Set([...state.authorizedSourceWatchPaths].filter(root => !removedRoots.has(root)));
      assertCurrent();
      await write(target, validated);
      assertCurrent();
      // No adapters or asynchronous work between the final check and this
      // publication. All native watchers were already closed by the pause.
      state.selectedSourceFolders = nextSources;
      state.authorizedSourceFolderPaths = nextSourcePaths;
      state.authorizedSourceFolderRealPaths = nextRealPaths;
      state.authorizedSourceWatchPaths = nextWatchPaths;
      state.authorizedCatalogueImageHashes = nextHashes;
      state.authorizedCatalogueMediaLocations = nextLocations;
      expected = captureAuthority(state);
      phase = 'saved';
    } catch {
      phase = 'failed';
      throw unavailable();
    }
  };
  return Object.freeze({ assertCurrent, saveSnapshot });
}
