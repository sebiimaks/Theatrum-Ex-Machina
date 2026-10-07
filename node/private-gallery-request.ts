import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { FinalObject, ImageElement } from '../interfaces/final-object.interface';
import { getImageLocations } from '../interfaces/media-locations';
import { PRIVATE_GALLERY_CHANNELS as channels, PRIVATE_GALLERY_PAGE_SIZE, PRIVATE_GALLERY_SOURCE_LIMIT, PRIVATE_GALLERY_IMPORT_LIMIT,
  type PrivateGallerySource, type PrivateGallerySources, type PrivateGallerySourceConnection, type PrivateGallerySourceDisconnection,
  type PrivateGallerySourceCheck, type PrivateGallerySourceCheckCounts,
  type PrivateGallerySourceRelocation, type PrivateGallerySourceAddition, type PrivateGalleryOriginalPlayback, type PrivateGalleryImportResponse,
  type PrivateGalleryPlaybackAcknowledgement, type PrivateGalleryPlaybackHistoryReset, type PrivateGalleryPlaybackHistoryMetric,
  type PrivateGalleryImportCounts, type PrivateGalleryImportProgress,
  type PrivateGalleryDetail, type PrivateGalleryItem, type PrivateGalleryPage, type PrivateGalleryQuery,
  type PrivateGalleryEdit, type PrivateGallerySave, type PrivateGallerySelection,
  type PrivateGalleryRegeneration, type PrivateGalleryRefresh, type PrivateGalleryProtection, type PrivateGalleryProtectionSave,
  type PrivateCredentialsPasswordChange, type PrivateCredentialsUnprotectedCopy,
  type PrivateCredentialsTouchIdStatus, type PrivateCredentialsTouchIdEnable, type PrivateCredentialsTouchIdDisable } from '../interfaces/private-gallery';
import { snapshotPrivateHubPasswordChange, snapshotPrivateHubPlaintextCopyRequest, snapshotPrivateHubTouchIdEnable,
  type PrivateHubPasswordChangeRequest, type PrivateHubPlaintextCopyRequest } from '../interfaces/private-hub-credentials';
import { snapshotPrivateHubProtection, type PrivateHubProtection } from '../interfaces/private-hub-protection';
import { createTheatrumMediaUrl } from '../interfaces/theatrum-protocol';
import type { PrivateHubSession } from './private-hub-session';
import { isPrivateHubPlaintextExportCleanupFailure } from './private-hub-plaintext-export';
import { privateVideoMetadataEditable, privateVideoRevision, snapshotPrivateVideoTags } from './private-hub-metadata';
import { PrivateSourceAccess } from './private-source-access';
import { isPrivateSourcePlaybackUrl, privateSourcePlaybackType, type PrivateSourcePlayback } from './private-source-playback';
import { checkPrivateSource, privateSourceCheckRevision } from './private-source-check';
import { reviewPrivateSourceRelocation, type PrivateSourceRelocationReview } from './private-source-relocation';
import { reviewPrivateSourceAddition, type PrivateSourceAdditionReview } from './private-source-addition';
import { reviewPrivateSourceScan, isPrivateSourceScanCleanupFailure, type PrivateSourceScanReview } from './private-source-scan';
import { isPrivatePreviewGenerationCleanupFailure } from './private-hub-preview-generation';
import { capturePrivatePreviewSource, isPrivatePreviewSourceCleanupFailure, type PrivatePreviewSource } from './private-preview-source';

import { isPrivateTouchIdCleanupFailure } from './private-touch-id';
import { checkPrivateVideoImport, snapshotPrivateVideoImportLocation } from './private-video-import';
import { sourceFolderPathIsIgnored } from '../interfaces/source-folder-path';
import { checkPrivateVideoRefresh } from './private-video-refresh';

const ENTRY_URL = 'theatrum://app/index.html';
const HASH = /^[a-zA-Z0-9_-]{1,200}$/;
const MAX_ROWS = 100_000;
let activeRequest: symbol | undefined;

export interface PrivateGalleryRequestOptions {
  readonly contents: WebContents;
  readonly hub: PrivateHubSession;
  readonly generation: number;
  readonly isCurrent: () => boolean;
  readonly onLock: () => void;
  /** Applies a saved setting to the main-owned timer; never a renderer heartbeat. */
  readonly onProtectionChanged: (settings: PrivateHubProtection) => boolean;
  /** Count-only native confirmation for resetting one metric in the encrypted catalogue. */
  readonly confirmPlaybackHistoryReset?: (metric: PrivateGalleryPlaybackHistoryMetric, count: number) => Promise<boolean>;
  /** Native main-owned picker. Never accept a path from the renderer. */
  /** Main-owned descriptor playback; no source paths cross this bridge. */
  readonly playback?: PrivateSourcePlayback;
  readonly chooseSourceDirectory?: (root: string) => Promise<string | undefined>;
  /** Separate native picker for changing one saved source location. */
  readonly chooseSourceLocation?: (root: string) => Promise<string | undefined>;
  /** Native picker for a new saved source location. Saving does not grant access. */
  readonly chooseNewSourceDirectory?: () => Promise<string | undefined>;
  /** Native bounded file selection beneath a saved source. No renderer paths. */
  readonly chooseImportVideo?: (root: string) => Promise<string | readonly string[] | undefined>;
  /** Count-only native confirmation of one bounded discovered batch. */
  readonly confirmSourceScan?: (count: number, more: boolean) => Promise<boolean>;
  /** Native confirmation after the selected folder's referenced videos pass review. */
  readonly confirmSourceLocation?: (root: string, videoCount: number) => Promise<boolean>;
  /** Native picker for an explicitly acknowledged unprotected copy. No renderer paths. */
  readonly chooseUnprotectedCopyDestination?: () => Promise<string | undefined>;
}
interface Row {
  display: Omit<PrivateGalleryDetail, 'id'>;
  search: string;
  index: number;
  identity: string;
  persistedRevision: string;
  metrics: { dateAdded: number | undefined; lastPlayed: number | undefined; fileSize: number | undefined;
    duration: number | undefined; rating: number | undefined };
}

interface SourceRow {
  index: number;
  root: string;
  identity: string;
  title: string;
  videoCount: number;
}

/** Saved source identities and reference counts only; never probe original media. */
function sourceRows(catalogue: FinalObject): SourceRow[] {
  const entries = Object.entries(catalogue.inputDirs ?? {});
  if (entries.length > PRIVATE_GALLERY_SOURCE_LIMIT || !Array.isArray(catalogue.images)
    || catalogue.images.length > MAX_ROWS) { throw new Error(); }
  const sources: SourceRow[] = [];
  for (const [key, value] of entries) {
    const index = Number(key);
    const root = value?.path;
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key
      || typeof root !== 'string' || !root.length || root.length > 32_768 || root.includes('\0')
      || !path.isAbsolute(root)) { continue; }
    const normalized = path.resolve(root);
    if (normalized === path.parse(normalized).root) { continue; }
    sources.push({ index, root: normalized, identity: JSON.stringify([index, root]),
      title: `Source folder ${sources.length + 1}`, videoCount: 0 });
  }
  const byIndex = new Map(sources.map(source => [source.index, source]));
  for (const image of catalogue.images) {
    if (image.deleted || image.cleanName === '*FOLDER*') { continue; }
    try {
      for (const index of new Set(getImageLocations(image).map(location => location.inputSource))) {
        const source = byIndex.get(index);
        if (source) { source.videoCount++; }
      }
    } catch { /* Malformed locations cannot grant source authority. */ }
  }
  return sources;
}

/** Snapshot only the bounded count report; main-only source revision never crosses IPC. */
function sourceCheckCounts(value: unknown): (PrivateGallerySourceCheckCounts & { revision: string }) | undefined {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) { return; }
    const counts = ['total', 'sameSize', 'differentSize', 'missing', 'unverified', 'ignored'] as const;
    const expected = ['status', 'revision', ...counts];
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) { return; }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (expected.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) { return; }
    if (descriptors.status.value !== 'checked' || typeof descriptors.revision.value !== 'string'
      || !/^[a-f0-9]{64}$/.test(descriptors.revision.value)) { return; }
    const result = Object.fromEntries(counts.map(key => [key, descriptors[key].value])) as unknown as PrivateGallerySourceCheckCounts;
    if (counts.some(key => !Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > 10_000)
      || result.sameSize + result.differentSize + result.missing + result.unverified + result.ignored !== result.total) { return; }
    return { ...result, revision: descriptors.revision.value };
  } catch { return; }
}

// Main-owned row identity, never exposed to the private page. A reordered or
// replaced row cannot inherit the previous row's editing authority.
function identity(image: ImageElement): string {
  return createHash('sha256').update(JSON.stringify([image.hash, image.inputSource,
    image.partialPath, image.fileName, image.locations])).digest('hex');
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15 ? value : undefined;
}
function positiveMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}
function project(image: ImageElement, index: number, regenerable = false, playable = false, refreshable = false): Row {
  if (!HASH.test(image.hash)) { throw new Error(); }
  const title = text(image.cleanName, 2048) || 'Untitled video';
  const notes = text(image.notes, 65_536);
  const originalTags = Array.isArray(image.tags) ? image.tags : [];
  const tags = originalTags.slice(0, 128).filter(tag => typeof tag === 'string').map(tag => text(tag, 512));
  const rating = Math.max(0, Math.min(5, number(image.stars) - 0.5));
  // Chromium may retain decoded media for an identical URL despite no-store.
  // Fresh opaque keys also refresh a cancelled job whose publication finished.
  const previewKey = randomBytes(16).toString('hex');
  return {
    index, identity: identity(image), persistedRevision: privateVideoRevision(image),
    metrics: { dateAdded: timestamp(image.dateAdded), lastPlayed: timestamp(image.lastPlayed),
      fileSize: Number.isSafeInteger(image.fileSize) ? positiveMetric(image.fileSize) : undefined,
      duration: positiveMetric(image.duration),
      rating: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].includes(image.stars) ? rating : undefined },
    display: { title, notes, tags, duration: number(image.duration), width: number(image.width), height: number(image.height),
      rating, favourite: image.stars === 5.5, editable: privateVideoMetadataEditable(image), regenerable, playable, refreshable,
      revision: randomBytes(16).toString('hex'),
      thumbnailUrl: createTheatrumMediaUrl('thumbnails', image.hash, false, previewKey),
      clipUrl: createTheatrumMediaUrl('clips', image.hash, true, previewKey),
      posterUrl: createTheatrumMediaUrl('clips', image.hash, false, previewKey),
      filmstripUrl: createTheatrumMediaUrl('filmstrips', image.hash, false, previewKey),
      truncated: (typeof image.cleanName === 'string' && image.cleanName.length > 2048)
        || (typeof image.notes === 'string' && image.notes.length > 65_536)
        || originalTags.length > 128 || originalTags.some(tag => typeof tag === 'string' && tag.length > 512),
    },
    // Search only the same bounded display text supplied by this view.
    search: [title, ...tags].join('\n').toLocaleLowerCase('en-US'),
  };
}

function sourceLocation(catalogue: FinalObject, image: ImageElement) {
  try {
    if (image.deleted || image.cleanName === '*FOLDER*' || !Number.isInteger(image.screens)
      || image.screens < 1 || image.screens > 255) { return undefined; }
    // This action regenerates the saved preferred source; it does not relocate
    // files, select an alternate source or change the catalogue's strip geometry.
    const location = getImageLocations(image)[0];
    const root = catalogue.inputDirs?.[location.inputSource]?.path;
    if (typeof root !== 'string' || root.length > 32_768 || root.includes('\0') || !path.isAbsolute(root)) { return undefined; }
    return { ...location, hash: image.hash, root: path.resolve(root) };
  } catch { return undefined; }
}

/** Playback uses the preferred original independently of generated preview geometry. */
function playbackLocation(catalogue: FinalObject, image: ImageElement) {
  try {
    if (image.deleted || image.cleanName === '*FOLDER*') { return undefined; }
    const location = getImageLocations(image)[0];
    if (!location || location.fileName.length > 4096 || location.partialPath.length > 16_384) { return undefined; }
    const savedRoot = catalogue.inputDirs?.[location.inputSource]?.path;
    if (typeof savedRoot !== 'string' || savedRoot.length > 32_768 || savedRoot.includes('\0')
      || !path.isAbsolute(savedRoot)) { return undefined; }
    const root = path.resolve(savedRoot);
    if (root === path.parse(root).root) { return undefined; }
    return { ...location, hash: image.hash, root };
  } catch { return undefined; }
}

/** Refresh replaces one unambiguous saved file, including its preview namespace. */
function refreshLocation(catalogue: FinalObject, image: ImageElement) {
  try {
    if (image.deleted || image.cleanName === '*FOLDER*') { return; }
    const locations = getImageLocations(image);
    if (locations.length !== 1) { return; }
    const location = locations[0];
    const folder = catalogue.inputDirs?.[location.inputSource];
    if (!folder || sourceFolderPathIsIgnored(location.partialPath, folder.ignoredSubdirectories)) { return; }
    return snapshotPrivateVideoImportLocation({ ...location, root: folder.path, hash: image.hash });
  } catch { return; }
}

/** Tombstones and folder rows may still own an encrypted preview namespace. */
function refreshHashes(catalogue: FinalObject): Set<string> {
  const counts = new Map<string, number>();
  for (const image of catalogue.images) { counts.set(image.hash, (counts.get(image.hash) ?? 0) + 1); }
  return new Set([...counts].filter(([, count]) => count === 1).map(([hash]) => hash));
}

function uniqueHashes(catalogue: FinalObject): Set<string> {
  const counts = new Map<string, number>();
  for (const image of catalogue.images) {
    if (!image.deleted && image.cleanName !== '*FOLDER*') { counts.set(image.hash, (counts.get(image.hash) ?? 0) + 1); }
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([hash]) => hash));
}
function edit(value: unknown): PrivateGalleryEdit | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { return; }
    const allowed = new Set(['id', 'revision', 'notes', 'tags', 'rating']);
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) { return; }
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) { return; }
      fields[key] = field.value;
    }
    const { id, revision, notes } = fields;
    const tags = snapshotPrivateVideoTags(fields.tags);
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)
      || typeof revision !== 'string' || !/^[a-f0-9]{32}$/.test(revision)
      || typeof notes !== 'string' || notes.length > 65_536 || !tags) { return; }
    const ratingPresent = Object.hasOwn(fields, 'rating');
    const rating = fields.rating;
    if (ratingPresent && (!Number.isInteger(rating) || (rating as number) < 0 || (rating as number) > 5)) { return; }
    return { id, revision, notes, tags, ...(ratingPresent ? { rating: rating as number } : {}) };
  } catch { return; }
}
function summary(id: string, row: Row): PrivateGalleryItem {
  const { title, duration, width, height, rating, favourite, tags, thumbnailUrl } = row.display;
  return { id, title, duration, width, height, rating, favourite, tags: [...tags], thumbnailUrl };
}
function query(value: unknown): Required<PrivateGalleryQuery> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { return; }
    const allowed = new Set(['query', 'offset', 'collection', 'sort', 'direction']);
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) { return; }
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) { return; }
      fields[key] = property.value;
    }
    if (typeof fields.query !== 'string' || fields.query.length > 200 || !Number.isSafeInteger(fields.offset)
      || (fields.offset as number) < 0 || (fields.offset as number) > MAX_ROWS
      || (fields.offset as number) % PRIVATE_GALLERY_PAGE_SIZE !== 0) { return; }
    const collection = Object.hasOwn(fields, 'collection') ? fields.collection : 'all';
    const sort = Object.hasOwn(fields, 'sort') ? fields.sort : 'catalogue';
    const direction = Object.hasOwn(fields, 'direction') ? fields.direction : 'asc';
    if (!['all', 'favourites', 'recent'].includes(collection as string)
      || !['catalogue', 'name', 'date-added', 'last-played', 'rating', 'duration', 'file-size'].includes(sort as string)
      || !['asc', 'desc'].includes(direction as string)) { return; }
    return { query: fields.query.trim().toLocaleLowerCase('en-US'), offset: fields.offset as number,
      collection, sort, direction } as Required<PrivateGalleryQuery>;
  } catch { return; }
}
const titleOrder = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });
function orderedRows(all: readonly Row[], request: Required<PrivateGalleryQuery>): Row[] {
  const matches = all.filter(row => (!request.query || row.search.includes(request.query))
    && (request.collection === 'all' || (request.collection === 'favourites' ? row.display.favourite : row.metrics.lastPlayed !== undefined)));
  const direction = request.direction === 'asc' ? 1 : -1;
  return matches.sort((left, right) => {
    if (request.sort === 'catalogue') { return direction * (left.index - right.index); }
    if (request.sort === 'name') { return direction * titleOrder.compare(left.display.title, right.display.title) || left.index - right.index; }
    const key = request.sort === 'date-added' ? 'dateAdded' : request.sort === 'last-played' ? 'lastPlayed'
      : request.sort === 'file-size' ? 'fileSize' : request.sort;
    const a = left.metrics[key], b = right.metrics[key];
    // Unknown values remain last in either direction. Original catalogue order
    // resolves ties, including missing pairs, without changing cached row IDs.
    if (a === undefined || b === undefined) { return a === b ? left.index - right.index : a === undefined ? 1 : -1; }
    return direction * (a - b) || left.index - right.index;
  });
}
function regenerationRequest(value: unknown): { id: string; revision: string } | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,revision') { return; }
    const object = value as Record<string, unknown>;
    const id = object.id, revision = object.revision;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)
      || typeof revision !== 'string' || !/^[a-f0-9]{32}$/.test(revision)) { return; }
    return { id, revision };
  } catch { return; }
}

/** Strict renderer request: no accessor, symbol, hidden field or native path. */
function refreshRequest(value: unknown): { id: string; revision: string } | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { return; }
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some(key => key !== 'id' && key !== 'revision')) { return; }
    if (['id', 'revision'].some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key], 'value')
      || typeof fields[key].value !== 'string' || !/^[a-f0-9]{32}$/.test(fields[key].value))) { return; }
    return { id: fields.id.value, revision: fields.revision.value };
  } catch { return; }
}

/** One bounded metadata bridge for one private main frame and unlocked generation. */
export function registerPrivateGalleryRequest(options: PrivateGalleryRequestOptions): () => Promise<void> {
  if (activeRequest || typeof options?.isCurrent !== 'function' || typeof options?.onLock !== 'function'
    || typeof options?.onProtectionChanged !== 'function') {
    throw new Error('Private gallery unavailable');
  }
  const { contents, hub, generation, isCurrent, onLock, onProtectionChanged, chooseUnprotectedCopyDestination } = options;
  let initialUrl: string;
  let signal: AbortSignal;
  try {
    if (contents.isDestroyed() || !isCurrent() || !hub.isCurrent(generation)) { throw new Error(); }
    initialUrl = contents.getURL();
    if (!['', 'about:blank', ENTRY_URL].includes(initialUrl)) { throw new Error(); }
    signal = hub.revocationSignal(generation);
    if (signal.aborted) { throw new Error(); }
  } catch { throw new Error('Private gallery unavailable'); }
  const token = Symbol();
  activeRequest = token;
  let disposed = false;
  let invalidated = false;
  let pending = false;
  let awaitingInitialNavigation = initialUrl !== ENTRY_URL;
  let frame: WebFrameMain | undefined = awaitingInitialNavigation ? undefined : contents.mainFrame;
  let rows: Row[] | undefined;
  const lifetime = new AbortController();
  let original: AbortController | undefined;
  let originalDrain: Promise<void> | undefined;
  let originalReceipt: { url: string; controller: AbortController; row: Row; id: string;
    revision: string; grantCurrent: () => boolean; acknowledged: boolean } | undefined;
  let historyDrain: Promise<void> | undefined;
  let historyResetDrain: Promise<void> | undefined;
  let playbackDrain: Promise<void> | undefined;
  let regeneration: AbortController | undefined;
  let regenerationDrain: Promise<void> | undefined;
  let sourceConnection: AbortController | undefined;
  let sourceConnectionDrain: Promise<void> | undefined;
  let importing: AbortController | undefined;
  let importDrain: Promise<void> | undefined;
  let importCounts: PrivateGalleryImportCounts | undefined;
  let credentialDrain: Promise<void> | undefined;
  let unprotectedCopy: AbortController | undefined;
  let unprotectedCopyDrain: Promise<void> | undefined;
  let cleanupFailed = false;
  let disposal: Promise<void> | undefined;
  const issued = new Map<string, Row>();
  const ids = new Map<Row, string>();
  const issuedSources = new Map<string, SourceRow>();
  const installed: string[] = [];
  const invalidate = (): void => {
    invalidated = true; importCounts = undefined; lifetime.abort(); regeneration?.abort(); importing?.abort(); sourceConnection?.abort(); unprotectedCopy?.abort();
    void retireOriginal();
    rows = undefined; issued.clear(); ids.clear(); issuedSources.clear();
  };
  const quarantine = (): void => {
    if (cleanupFailed) { return; }
    cleanupFailed = true;
    invalidate();
    try { onLock(); } catch { /* The failed cleanup is also returned through the disposer. */ }
  };
  // stop() retires its token synchronously; every drain is observed, including
  // one-way cancellation and revocation callbacks which cannot be awaited.
  const drainPlayback = (): Promise<void> => {
    let stopping: Promise<void> | undefined;
    try { stopping = options.playback?.stop(); }
    catch { quarantine(); }
    const drain = Promise.resolve(stopping).catch(() => { quarantine(); });
    playbackDrain = Promise.all([playbackDrain, drain]).then(() => undefined);
    return playbackDrain;
  };
  const retireOriginal = (): Promise<void> => {
    originalReceipt = undefined;
    original?.abort(); original = undefined;
    return drainPlayback();
  };
  const navigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame === false) { return; }
    if (awaitingInitialNavigation && details.isMainFrame === true && !details.isSameDocument && details.url === ENTRY_URL) {
      awaitingInitialNavigation = false;
      return;
    }
    invalidate();
  };
  const current = (): boolean => {
    try {
      return !disposed && !invalidated && !cleanupFailed && !signal.aborted && !awaitingInitialNavigation && activeRequest === token
        && !contents.isDestroyed() && hub.isCurrent(generation) && isCurrent() === true
        && !disposed && !invalidated && !signal.aborted && hub.isCurrent(generation);
    } catch { return false; }
  };
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    try {
      if (!current() || event.sender !== contents) { return false; }
      const sender = event.senderFrame;
      if (!sender || sender !== contents.mainFrame || sender.isDestroyed() || sender.detached || sender.parent !== null
        || sender.url !== ENTRY_URL || contents.getURL() !== ENTRY_URL || (frame && frame !== sender)) { return false; }
      frame ??= sender;
      return current();
    } catch { return false; }
  };
  const access = new PrivateSourceAccess({ signal: lifetime.signal, isCurrent: current,
    chooseDirectory: root => options.chooseSourceDirectory ? options.chooseSourceDirectory(root) : Promise.resolve(undefined) });
  const eligible = (catalogue: FinalObject, image: ImageElement, hashes = uniqueHashes(catalogue)): boolean =>
    !!options.chooseSourceDirectory && hashes.has(image.hash) && !!sourceLocation(catalogue, image);
  const refreshable = (catalogue: FinalObject, image: ImageElement, hashes = refreshHashes(catalogue)): boolean =>
    !!options.chooseSourceDirectory && hashes.has(image.hash) && !!refreshLocation(catalogue, image);
  const playable = (catalogue: FinalObject, image: ImageElement): boolean => {
    const location = playbackLocation(catalogue, image);
    return !!options.playback && !!options.chooseSourceDirectory && !!location
      && privateSourcePlaybackType(location.fileName) !== undefined;
  };
  const stopForOperation = async (event: IpcMainEvent | IpcMainInvokeEvent): Promise<boolean> => {
    await retireOriginal();
    return trusted(event);
  };
  const load = async (): Promise<Row[]> => {
    if (rows) { return rows; }
    const catalogue = await hub.readCatalogue(generation);
    if (!current() || !Array.isArray(catalogue.images)) { throw new Error(); }
    const projected: Row[] = [];
    const hashes = uniqueHashes(catalogue);
    const refreshableHashes = refreshHashes(catalogue);
    for (const [index, image] of catalogue.images.entries()) {
      if (image.deleted || image.cleanName === '*FOLDER*') { continue; }
      if (projected.length >= MAX_ROWS) { throw new Error(); }
      projected.push(project(image, index, eligible(catalogue, image, hashes), playable(catalogue, image), refreshable(catalogue, image, refreshableHashes)));
    }
    if (!current()) { throw new Error(); }
    rows = projected;
    return rows;
  };
  const sourceItem = (id: string, source: SourceRow): PrivateGallerySource => ({ id, title: source.title,
    videoCount: source.videoCount, connected: access.isConnected(source.root) });
  const sources = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGallerySources> => {
    if (!trusted(event) || args.length !== 0) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    pending = true;
    try {
      if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
      const latest = sourceRows(await hub.readCatalogue(generation));
      if (!trusted(event)) { return { status: 'unavailable' }; }
      const previous = new Map([...issuedSources].map(([id, source]) => [source.identity, { id, source }]));
      const retained = new Set(latest.map(source => source.identity));
      for (const [id, source] of issuedSources) {
        if (!retained.has(source.identity)) { access.disconnect(source.root); issuedSources.delete(id); }
      }
      const items = latest.map(source => {
        const id = previous.get(source.identity)?.id ?? randomBytes(16).toString('hex');
        issuedSources.set(id, source);
        return sourceItem(id, source);
      });
      return trusted(event) ? { status: 'ready', items } : { status: 'unavailable' };
    } catch { return { status: 'unavailable' }; }
    finally { pending = false; }
  };
  const connectSource = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGallerySourceConnection> => {
    if (!trusted(event) || args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9]{32}$/.test(args[0])
      || !options.chooseSourceDirectory) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    const id = args[0];
    const source = issuedSources.get(id);
    if (!source) { return { status: 'unavailable' }; }
    pending = true;
    const controller = new AbortController();
    sourceConnection = controller;
    const authorized = (): boolean => !controller.signal.aborted && trusted(event) && !controller.signal.aborted;
    const stopped = (): PrivateGallerySourceConnection => trusted(event) && controller.signal.aborted
      ? { status: 'cancelled' } : { status: 'unavailable' };
    let granted = false;
    let connected = false;
    // Register drainage before the catalogue reader or native picker can reenter lock.
    const work = Promise.resolve().then(async (): Promise<PrivateGallerySourceConnection> => {
      try {
        if (!authorized() || (options.playback && !await stopForOperation(event)) || !authorized()) { return stopped(); }
        const before = sourceRows(await hub.readCatalogue(generation));
        if (!authorized()) { return stopped(); }
        if (!before.some(row => row.identity === source.identity)) {
          access.disconnect(source.root);
          return { status: 'conflict' };
        }
        access.isConnected(source.root); // Expire a replaced cached directory before offering reconnection.
        const grant = await access.authorize(source.root, controller.signal, authorized);
        granted = grant.status === 'granted';
        if (!authorized()) { return stopped(); }
        if (grant.status !== 'granted') { return { status: grant.status }; }
        const after = sourceRows(await hub.readCatalogue(generation));
        if (!authorized()) { return stopped(); }
        const latest = after.find(row => row.identity === source.identity);
        if (!latest) { return { status: 'conflict' }; }
        if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
        issuedSources.set(id, latest);
        const item = sourceItem(id, latest);
        if (!authorized()) { return stopped(); }
        if (!item.connected) { return { status: 'source-unavailable' }; }
        connected = true;
        return { status: 'connected', item };
      } catch { return stopped(); }
      finally { if (granted && !connected) { access.disconnect(source.root); } }
    });
    const drain = work.then(() => undefined, () => undefined);
    sourceConnectionDrain = drain;
    try {
      const result = await work;
      if (!authorized()) { if (granted) { access.disconnect(source.root); } return stopped(); }
      return result;
    } finally {
      pending = false;
      if (sourceConnection === controller) { sourceConnection = undefined; }
      if (sourceConnectionDrain === drain) { sourceConnectionDrain = undefined; }
    }
  };
  const checkSource = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGallerySourceCheck> => {
    if (!trusted(event) || args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9]{32}$/.test(args[0])
      || !options.chooseSourceDirectory) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    const source = issuedSources.get(args[0]);
    if (!source) { return { status: 'unavailable' }; }
    pending = true;
    const controller = new AbortController();
    sourceConnection = controller;
    const authorized = (): boolean => !controller.signal.aborted && trusted(event) && !controller.signal.aborted;
    const stopped = (): PrivateGallerySourceCheck => trusted(event) && controller.signal.aborted
      ? { status: 'cancelled' } : { status: 'unavailable' };
    let granted = false;
    let checked = false;
    // Install drainage before any catalogue, playback or native-picker callback
    // can reenter Lock. This operation changes neither catalogue nor row cache.
    const work = Promise.resolve().then(async (): Promise<PrivateGallerySourceCheck> => {
      try {
        if (!authorized() || (options.playback && !await stopForOperation(event)) || !authorized()) { return stopped(); }
        const before = sourceRows(await hub.readCatalogue(generation));
        if (!authorized()) { return stopped(); }
        if (!before.some(row => row.identity === source.identity)) {
          access.disconnect(source.root);
          return { status: 'conflict' };
        }
        access.isConnected(source.root); // Existing grants alone may probe; first access still requires the picker.
        const grant = await access.authorize(source.root, controller.signal, authorized);
        granted = grant.status === 'granted';
        if (!authorized()) { return stopped(); }
        if (grant.status !== 'granted') { return { status: grant.status }; }
        const catalogue = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        if (!sourceRows(catalogue).some(row => row.identity === source.identity)) { return { status: 'conflict' }; }
        if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
        const result = await checkPrivateSource({ catalogue, sourceIndex: source.index, signal: controller.signal,
          isCurrent: () => authorized() && grant.isCurrent() && authorized() });
        if (!authorized()) { return stopped(); }
        if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
        if (result.status !== 'checked') {
          return ['cancelled', 'invalid', 'limit', 'source-unavailable'].includes(result.status)
            ? { status: result.status } : { status: 'invalid' };
        }
        const snapshot = sourceCheckCounts(result);
        if (!snapshot) { return { status: 'invalid' }; }
        const latest = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
        if (!sourceRows(latest).some(row => row.identity === source.identity)) { return { status: 'conflict' }; }
        let revision: string;
        try { revision = privateSourceCheckRevision(latest, source.index); }
        catch { return { status: 'conflict' }; }
        if (revision !== snapshot.revision) { return { status: 'conflict' }; }
        if (!authorized()) { return stopped(); }
        if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
        checked = true;
        const { revision: _revision, ...counts } = snapshot;
        return { status: 'checked', ...counts };
      } catch { return authorized() ? { status: 'source-unavailable' } : stopped(); }
      finally { if (granted && !checked) { access.disconnect(source.root); } }
    });
    const drain = work.then(() => undefined, () => undefined);
    sourceConnectionDrain = drain;
    try {
      const result = await work;
      if (!authorized()) { if (granted) { access.disconnect(source.root); } return stopped(); }
      return result;
    } finally {
      pending = false;
      if (sourceConnection === controller) { sourceConnection = undefined; }
      if (sourceConnectionDrain === drain) { sourceConnectionDrain = undefined; }
    }
  };
  const disconnectSource = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGallerySourceDisconnection> => {
    if (!trusted(event) || args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9]{32}$/.test(args[0])) {
      return { status: 'unavailable' };
    }
    if (pending) { return { status: 'busy' }; }
    const id = args[0];
    const source = issuedSources.get(id);
    if (!source) { return { status: 'unavailable' }; }
    pending = true;
    try {
      if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
      const latest = sourceRows(await hub.readCatalogue(generation)).find(row => row.identity === source.identity);
      if (!trusted(event)) { return { status: 'unavailable' }; }
      access.disconnect(source.root);
      if (!latest) { return { status: 'conflict' }; }
      issuedSources.set(id, latest);
      return trusted(event) ? { status: 'disconnected', item: sourceItem(id, latest) } : { status: 'unavailable' };
    } catch { return { status: 'unavailable' }; }
    finally { pending = false; }
  };
  const relocateSource = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGallerySourceRelocation> => {
    if (!trusted(event) || args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9]{32}$/.test(args[0])
      || !options.chooseSourceLocation || !options.confirmSourceLocation) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    const source = issuedSources.get(args[0]);
    if (!source) { return { status: 'unavailable' }; }
    pending = true;
    const controller = new AbortController();
    sourceConnection = controller;
    const authorized = (): boolean => !controller.signal.aborted && trusted(event) && !controller.signal.aborted;
    const stopped = (): PrivateGallerySourceRelocation => trusted(event) && controller.signal.aborted
      ? { status: 'cancelled' } : { status: 'unavailable' };
    const work = Promise.resolve().then(async (): Promise<PrivateGallerySourceRelocation> => {
      let review: PrivateSourceRelocationReview | undefined;
      try {
        if (!authorized() || (options.playback && !await stopForOperation(event)) || !authorized()) { return stopped(); }
        const before = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        if (!sourceRows(before).some(row => row.identity === source.identity)) { return { status: 'conflict' }; }
        const selected = await options.chooseSourceLocation!(source.root);
        if (!authorized()) { return stopped(); }
        if (selected === undefined) { return { status: 'cancelled' }; }
        const latest = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        if (!sourceRows(latest).some(row => row.identity === source.identity)) { return { status: 'conflict' }; }
        const reviewed = await reviewPrivateSourceRelocation({ catalogue: latest, sourceIndex: source.index,
          newRoot: selected, signal: controller.signal, isCurrent: authorized });
        if (reviewed.status === 'ready') { review = reviewed.review; }
        if (!authorized()) { return stopped(); }
        if (reviewed.status !== 'ready') { return { status: reviewed.status }; }
        review = reviewed.review;
        const newRoot = review.newRoot;
        if (!await options.confirmSourceLocation!(newRoot, review.videoCount)) {
          return authorized() ? { status: 'cancelled' } : stopped();
        }
        if (!authorized()) { return stopped(); }
        // Retire authority before storage admission: a cancelled or rejected
        // completion can follow an already-published catalogue transaction.
        access.disconnect(source.root); access.disconnect(newRoot);
        rows = undefined; issued.clear(); ids.clear(); issuedSources.clear();
        const result = await hub.relocateSource(generation, review, authorized);
        return authorized() ? { status: result.status } : stopped();
      } catch { return authorized() ? { status: 'source-unavailable' } : stopped(); }
      finally {
        try { review?.dispose(); }
        catch { quarantine(); }
      }
    });
    const drain = work.then(() => undefined, () => undefined);
    sourceConnectionDrain = drain;
    try {
      const result = await work;
      return authorized() ? result : stopped();
    } finally {
      pending = false;
      if (sourceConnection === controller) { sourceConnection = undefined; }
      if (sourceConnectionDrain === drain) { sourceConnectionDrain = undefined; }
    }
  };
  const importWork = async (mode: 'manual' | 'scan', event: IpcMainInvokeEvent, args: unknown[]): Promise<PrivateGalleryImportResponse> => {
    if (!trusted(event) || args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9]{32}$/.test(args[0])
      || (mode === 'manual' ? !options.chooseImportVideo : !options.confirmSourceScan) || !options.chooseSourceDirectory) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    const saved = issuedSources.get(args[0]);
    if (!saved) { return { status: 'unavailable' }; }
    pending = true;
    const controller = new AbortController();
    importing = controller;
    let counts: PrivateGalleryImportCounts | undefined;
    let review: PrivateSourceScanReview | undefined;
    const authorized = (): boolean => !controller.signal.aborted && trusted(event) && !controller.signal.aborted;
    const finished = (outcome: 'completed' | 'cancelled' | 'stopped'): PrivateGalleryImportResponse => {
      if (!trusted(event)) { return { status: 'unavailable' }; }
      if (!counts) { return { status: controller.signal.aborted ? 'cancelled' : 'source-unavailable' }; }
      return { status: 'finished', outcome: controller.signal.aborted ? 'cancelled' : outcome, ...counts };
    };
    const stopped = (): PrivateGalleryImportResponse => counts ? finished('stopped')
      : trusted(event) && controller.signal.aborted ? { status: 'cancelled' } : { status: 'unavailable' };
    // Register drainage before a picker, reader or capture can reenter revocation.
    const work = Promise.resolve().then(async (): Promise<PrivateGalleryImportResponse> => {
      try {
        if (!authorized() || (options.playback && !await stopForOperation(event)) || !authorized()) { return stopped(); }
        const before = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        if (!sourceRows(before).some(row => row.identity === saved.identity)) { return { status: 'conflict' }; }
        access.isConnected(saved.root);
        const grant = await access.authorize(saved.root, controller.signal, authorized);
        if (!authorized()) { return stopped(); }
        if (grant.status !== 'granted') { return { status: grant.status }; }
        let selection: string | readonly string[] | undefined;
        if (mode === 'scan') {
          // The grant's native picker may have remained open while the saved
          // source policy changed. Re-read it before any directory enumeration.
          const current = await hub.readCatalogue(generation);
          if (!authorized()) { return stopped(); }
          if (!sourceRows(current).some(row => row.identity === saved.identity)) { return { status: 'conflict' }; }
          if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
          const discovered = await reviewPrivateSourceScan({ catalogue: current, sourceIndex: saved.index,
            signal: controller.signal, isCurrent: () => authorized() && grant.isCurrent() });
          if (discovered.status !== 'ready') {
            return !authorized() ? stopped() : { status: discovered.status === 'limit' ? 'scan-limit' : discovered.status };
          }
          review = discovered.review;
          if (!authorized()) { return stopped(); }
          const reviewed = await hub.readCatalogue(generation);
          if (!authorized()) { return stopped(); }
          if (!review.matchesCatalogue(reviewed)) { return { status: 'conflict' }; }
          if (!review.isCurrent() || !grant.isCurrent() || !review.files.every(file => review!.fileCurrent(file))) {
            return { status: 'source-unavailable' };
          }
          if (review.files.length === 0) { return { status: 'nothing-new' }; }
          if (!await options.confirmSourceScan!(review.files.length, review.more)) { return { status: 'cancelled' }; }
          if (!authorized()) { return stopped(); }
          const confirmed = await hub.readCatalogue(generation);
          if (!authorized()) { return stopped(); }
          if (!review.matchesCatalogue(confirmed)) { return { status: 'conflict' }; }
          if (!review.isCurrent() || !grant.isCurrent() || !review.files.every(file => review!.fileCurrent(file))) {
            return { status: 'source-unavailable' };
          }
          selection = review.files;
        } else {
          selection = await options.chooseImportVideo!(saved.root);
          if (!authorized()) { return stopped(); }
          if (selection === undefined) { return { status: 'cancelled' }; }
        }
        // Snapshot and validate the whole native selection before probing any file.
        // String support is retained for main-owned single-file adapters.
        const input = typeof selection === 'string' ? [selection] : selection;
        if (!Array.isArray(input) || input.length === 0) { return { status: 'invalid' }; }
        if (input.length > PRIVATE_GALLERY_IMPORT_LIMIT) { return { status: 'limit' }; }
        const selected: string[] = [];
        for (let index = 0; index < input.length; index++) {
          const property = Object.getOwnPropertyDescriptor(input, String(index));
          const file = property && Object.hasOwn(property, 'value') ? property.value : undefined;
          if (typeof file !== 'string' || file.length > 32_768 || file.includes('\0')
            || !path.isAbsolute(file) || path.resolve(file) !== file) { return { status: 'invalid' }; }
          const relative = path.relative(saved.root, file);
          if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
            return { status: 'invalid' };
          }
          selected.push(file);
        }
        counts = { total: selected.length, processed: 0, imported: 0, duplicates: 0, failed: 0 };
        importCounts = counts;
        for (const file of selected) {
          if (!authorized()) { return stopped(); }
          const latest = await hub.readCatalogue(generation);
          if (!authorized()) { return stopped(); }
          if (!sourceRows(latest).some(row => row.identity === saved.identity) || !grant.isCurrent()
            || (review && (!review.matchesCatalogue(latest) || !review.fileCurrent(file)))) { return finished('stopped'); }
          const relative = path.relative(saved.root, file);
          const directory = path.dirname(relative);
          const location = { root: saved.root, inputSource: saved.index, fileName: path.basename(relative),
            partialPath: directory === '.' ? '' : '/' + directory.split(path.sep).join('/'), hash: randomBytes(32).toString('hex') };
          const fileCurrent = (): boolean => authorized() && grant.isCurrent() && (!review || review.fileCurrent(file));
          let source: PrivatePreviewSource | undefined;
          let outcome: 'imported' | 'duplicate' | 'failed' | 'stopped' = 'stopped';
          try {
            // Known duplicates and excluded files require no media access.
            const eligibility = checkPrivateVideoImport(latest, location);
            if (eligibility === 'duplicate') { outcome = 'duplicate'; }
            else if (eligibility === 'invalid') { outcome = 'failed'; }
            else if (eligibility === 'ready') {
              source = await capturePrivatePreviewSource({ ...location, signal: controller.signal,
                isCurrent: fileCurrent });
              if (!authorized()) { return stopped(); }
              // Each publication may finish just before cancellation. Never retain
              // cached authority across an admitted catalogue write.
              rows = undefined; issued.clear(); ids.clear(); issuedSources.clear();
              const result = await hub.importVideo(generation, source, location,
                { signal: controller.signal, isCurrent: fileCurrent });
              outcome = result.status === 'invalid' ? 'failed' : result.status === 'conflict' ? 'stopped' : result.status;
            }
          } catch (error) {
            if (isPrivatePreviewGenerationCleanupFailure(error) || isPrivatePreviewSourceCleanupFailure(error)) { quarantine(); }
            if (fileCurrent()) { outcome = 'failed'; }
          } finally {
            // Drain one file completely before reporting it or starting another.
            try { await source?.close(); } catch { quarantine(); }
          }
          if (outcome !== 'stopped') {
            counts.processed++;
            if (outcome === 'imported') { counts.imported++; }
            else if (outcome === 'duplicate') { counts.duplicates++; }
            else { counts.failed++; }
          }
          if (!authorized()) { return stopped(); }
          if (outcome === 'stopped' || !fileCurrent()) { return finished('stopped'); }
        }
        return finished('completed');
      } catch (error) {
        if (isPrivatePreviewGenerationCleanupFailure(error) || isPrivatePreviewSourceCleanupFailure(error)
          || isPrivateSourceScanCleanupFailure(error)) { quarantine(); }
        return counts ? finished('stopped') : authorized() ? { status: 'source-unavailable' } : stopped();
      } finally {
        try { review?.dispose(); } catch { quarantine(); }
      }
    });
    const drain = work.then(() => undefined, () => undefined);
    importDrain = drain;
    try {
      const result = await work;
      return trusted(event) ? result : { status: 'unavailable' };
    } finally {
      pending = false;
      if (importing === controller) { importing = undefined; importCounts = undefined; }
      if (importDrain === drain) { importDrain = undefined; }
    }
  };
  const importVideo = (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryImportResponse> => importWork('manual', event, args);
  const scanSource = (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryImportResponse> => importWork('scan', event, args);
  const importProgress = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryImportProgress> => {
    if (!trusted(event) || args.length !== 0) { return { status: 'unavailable' }; }
    const snapshot = pending && importing && importCounts ? { ...importCounts } : undefined;
    if (!trusted(event)) { return { status: 'unavailable' }; }
    return snapshot ? { status: 'running', ...snapshot } : { status: 'idle' };
  };
  const cancelImport = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (trusted(event) && args.length === 0) { importing?.abort(); }
  };
  const addSource = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGallerySourceAddition> => {
    if (!trusted(event) || args.length !== 0 || !options.chooseNewSourceDirectory) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    pending = true;
    const controller = new AbortController();
    sourceConnection = controller;
    const authorized = (): boolean => !controller.signal.aborted && trusted(event) && !controller.signal.aborted;
    const stopped = (): PrivateGallerySourceAddition => trusted(event) && controller.signal.aborted
      ? { status: 'cancelled' } : { status: 'unavailable' };
    // A native picker can outlive cancellation. Install its drain before any
    // main callback runs, and reject its result if this owner has been retired.
    const work = Promise.resolve().then(async (): Promise<PrivateGallerySourceAddition> => {
      let review: PrivateSourceAdditionReview | undefined;
      try {
        if (!authorized() || (options.playback && !await stopForOperation(event)) || !authorized()) { return stopped(); }
        const before = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        if (Object.keys(before.inputDirs ?? {}).length >= PRIVATE_GALLERY_SOURCE_LIMIT) { return { status: 'limit' }; }
        const selected = await options.chooseNewSourceDirectory!();
        if (!authorized()) { return stopped(); }
        if (selected === undefined) { return { status: 'cancelled' }; }
        const catalogue = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        const checked = await reviewPrivateSourceAddition({ catalogue, newRoot: selected,
          signal: controller.signal, isCurrent: authorized });
        if (checked.status === 'ready') { review = checked.review; }
        if (!authorized()) { return stopped(); }
        if (checked.status !== 'ready') { return { status: checked.status }; }
        review = checked.review;
        // Saving a root never carries a stale grant from an earlier catalogue.
        access.disconnect(review.newRoot);
        // Even an uncertain completion can have saved the new root. Drop all
        // issued identities before publication; the page reloads saved state.
        rows = undefined; issued.clear(); ids.clear(); issuedSources.clear();
        const result = await hub.addSource(generation, review, authorized);
        return authorized() ? { status: result.status } : stopped();
      } catch { return authorized() ? { status: 'source-unavailable' } : stopped(); }
      finally {
        try { review?.dispose(); } catch { quarantine(); }
      }
    });
    const drain = work.then(() => undefined, () => undefined);
    sourceConnectionDrain = drain;
    try {
      const result = await work;
      return authorized() ? result : stopped();
    } finally {
      pending = false;
      if (sourceConnection === controller) { sourceConnection = undefined; }
      if (sourceConnectionDrain === drain) { sourceConnectionDrain = undefined; }
    }
  };
  const cancelSourceConnection = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (trusted(event) && args.length === 0) { sourceConnection?.abort(); }
  };
  const list = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryPage> => {
    try {
      if (!trusted(event) || args.length !== 1) { return { status: 'unavailable' }; }
      const request = query(args[0]);
      if (!request) { return { status: 'unavailable' }; }
      if (pending) { return { status: 'busy' }; }
      pending = true;
      try {
        if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
        const all = await load();
        if (!trusted(event)) { return { status: 'unavailable' }; }
        const matches = orderedRows(all, request);
        const items = matches.slice(request.offset, request.offset + PRIVATE_GALLERY_PAGE_SIZE).map(row => {
          let id = ids.get(row);
          if (!id) { id = randomBytes(16).toString('hex'); ids.set(row, id); issued.set(id, row); }
          return summary(id, row);
        });
        return trusted(event) ? { status: 'ready', total: matches.length, offset: request.offset, items } : { status: 'unavailable' };
      } finally { pending = false; }
    } catch { return { status: 'unavailable' }; }
  };
  const detail = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGallerySelection> => {
    try {
      if (!trusted(event) || args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9]{32}$/.test(args[0])) {
        return { status: 'unavailable' };
      }
      if (pending) { return { status: 'busy' }; }
      const row = issued.get(args[0]);
      if (!row) { return { status: 'unavailable' }; }
      pending = true;
      try {
        if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
        const catalogue = await hub.readCatalogue(generation);
        if (!trusted(event)) { return { status: 'unavailable' }; }
        const image = catalogue.images[row.index];
        if (!image || image.deleted || image.cleanName === '*FOLDER*' || identity(image) !== row.identity) {
          return { status: 'unavailable' };
        }
        const latest = project(image, row.index, eligible(catalogue, image), playable(catalogue, image), refreshable(catalogue, image));
        // Re-reading the same record does not invalidate another unchanged draft.
        if (latest.persistedRevision === row.persistedRevision) { latest.display.revision = row.display.revision; }
        Object.assign(row, latest);
        return trusted(event) ? { status: 'ready', item: { ...row.display, id: args[0], tags: [...row.display.tags] } }
          : { status: 'unavailable' };
      } finally { pending = false; }
    } catch { return { status: 'unavailable' }; }
  };
  const save = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGallerySave> => {
    try {
      if (!trusted(event) || args.length !== 1) { return { status: 'unavailable' }; }
      const request = edit(args[0]);
      if (!request) { return { status: 'invalid' }; }
      if (pending) { return { status: 'busy' }; }
      const row = issued.get(request.id);
      if (!row) { return { status: 'unavailable' }; }
      if (!row.display.editable) { return { status: 'invalid' }; }
      if (request.revision !== row.display.revision) { return { status: 'conflict' }; }
      pending = true;
      try {
        if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
        const result = await hub.updateVideoMetadata(generation, {
          index: row.index, revision: row.persistedRevision, notes: request.notes, tags: request.tags,
          ...(Object.hasOwn(request, 'rating') ? { rating: request.rating } : {}),
        }, () => trusted(event));
        if (!trusted(event)) { return { status: 'unavailable' }; }
        if (result.status !== 'saved') { return { status: result.status }; }
        if (identity(result.image) !== row.identity) { return { status: 'unavailable' }; }
        Object.assign(row, project(result.image, row.index, row.display.regenerable, row.display.playable, row.display.refreshable));
        return { status: 'saved', item: { ...row.display, id: request.id, tags: [...row.display.tags] } };
      } finally { pending = false; }
    } catch { return { status: 'unavailable' }; }
  };
  const playOriginal = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryOriginalPlayback> => {
    if (!trusted(event) || args.length !== 1 || !options.playback || !options.chooseSourceDirectory) {
      return { status: 'unavailable' };
    }
    const value = regenerationRequest(args[0]);
    if (!value) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    const row = issued.get(value.id);
    if (!row) { return { status: 'unavailable' }; }
    if (value.revision !== row.display.revision) { return { status: 'conflict' }; }
    pending = true;
    const previous = retireOriginal();
    const controller = new AbortController();
    original = controller;
    const authorized = (): boolean => !controller.signal.aborted && trusted(event) && !controller.signal.aborted;
    const stopped = (): PrivateGalleryOriginalPlayback => trusted(event) && controller.signal.aborted
      ? { status: 'cancelled' } : { status: 'unavailable' };
    let ready = false;
    const work = Promise.resolve().then(async (): Promise<PrivateGalleryOriginalPlayback> => {
      let source: PrivatePreviewSource | undefined;
      try {
        await previous;
        if (!authorized()) { return stopped(); }
        const catalogue = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        const image = catalogue.images[row.index];
        if (!image || privateVideoRevision(image) !== row.persistedRevision || identity(image) !== row.identity) {
          return { status: 'conflict' };
        }
        const location = playbackLocation(catalogue, image);
        if (!location) { return { status: 'source-unavailable' }; }
        const type = privateSourcePlaybackType(location.fileName);
        if (!type) { return { status: 'unsupported' }; }
        access.isConnected(location.root);
        const grant = await access.authorize(location.root, controller.signal, authorized);
        if (!authorized()) { return stopped(); }
        if (grant.status !== 'granted') { return { status: grant.status }; }
        const latest = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        const refreshed = latest.images[row.index];
        if (!refreshed || privateVideoRevision(refreshed) !== row.persistedRevision || identity(refreshed) !== row.identity
          || JSON.stringify(playbackLocation(latest, refreshed)) !== JSON.stringify(location)) {
          return { status: 'conflict' };
        }
        if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
        source = await capturePrivatePreviewSource({ ...location, signal: controller.signal,
          isCurrent: () => authorized() && grant.isCurrent() });
        if (!authorized() || !grant.isCurrent()) { return stopped(); }
        const owned = source; source = undefined; // Manager consumes even rejected starts.
        const url = await options.playback!.start(owned, type);
        if (!authorized() || !grant.isCurrent()) { await retireOriginal(); return stopped(); }
        originalReceipt = { url, controller, row, id: value.id, revision: row.persistedRevision,
          grantCurrent: grant.isCurrent, acknowledged: false };
        ready = true;
        return { status: 'ready', url };
      } catch (error) {
        const failedWhileCurrent = authorized();
        if (isPrivatePreviewSourceCleanupFailure(error)) { quarantine(); }
        await drainPlayback();
        return cleanupFailed || !trusted(event) ? { status: 'unavailable' }
          : failedWhileCurrent ? { status: 'source-unavailable' } : stopped();
      } finally {
        try { await source?.close(); } catch { quarantine(); }
      }
    });
    const drain = work.then(() => undefined, () => undefined);
    originalDrain = drain;
    try {
      const result = await work;
      if (!authorized()) { await retireOriginal(); return stopped(); }
      return result;
    } finally {
      pending = false;
      if (!ready && original === controller) { original = undefined; controller.abort(); }
      if (originalDrain === drain) { originalDrain = undefined; }
    }
  };
  const stopOriginal = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (trusted(event) && args.length === 0) { void retireOriginal(); }
  };
  const ackOriginalPlayback = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryPlaybackAcknowledgement> => {
    if (!trusted(event) || !options.playback) { return { status: 'unavailable' }; }
    if (args.length !== 1 || typeof args[0] !== 'string' || !isPrivateSourcePlaybackUrl(args[0])) {
      return { status: 'invalid' };
    }
    const receipt = originalReceipt;
    if (!receipt || receipt.url !== args[0] || receipt.acknowledged || original !== receipt.controller
      || receipt.controller.signal.aborted || issued.get(receipt.id) !== receipt.row
      || receipt.row.persistedRevision !== receipt.revision) { return { status: 'ignored' }; }
    if (pending) { return { status: 'busy' }; }
    try {
      if (!receipt.grantCurrent() || !options.playback.hasDeliveredData(receipt.url)) { return { status: 'ignored' }; }
    } catch { return { status: 'unavailable' }; }
    if (!trusted(event) || originalReceipt !== receipt || original !== receipt.controller
      || receipt.controller.signal.aborted || receipt.acknowledged) { return { status: 'ignored' }; }
    // Consume before any async admission. A failed or disabled acknowledgement
    // must not replay an uncertain publication or record later enablement.
    receipt.acknowledged = true;
    pending = true;
    const playedAt = Date.now();
    // Register drainage before invoking the session, which can synchronously
    // reenter lock/dispose. Once admitted, Stop does not undo a playback fact;
    // navigation, lock and generation revocation still cancel publication.
    const work = Promise.resolve().then(async (): Promise<PrivateGalleryPlaybackAcknowledgement> => {
      if (!trusted(event)) { return { status: 'unavailable' }; }
      const result = await hub.recordVideoPlayback(generation, {
        index: receipt.row.index, revision: receipt.revision, playedAt,
      }, () => trusted(event));
      if (!trusted(event)) { return { status: 'unavailable' }; }
      if (result.status !== 'recorded') { return { status: result.status }; }
      const row = receipt.row;
      if (issued.get(receipt.id) !== row || row.persistedRevision !== receipt.revision
        || identity(result.image) !== row.identity) { return { status: 'unavailable' }; }
      // The encrypted transaction changed only playback metadata. Keep the
      // existing editing revision so an unsaved notes/tags/rating draft remains
      // valid, while its next CAS uses the newly persisted complete-row hash.
      row.persistedRevision = privateVideoRevision(result.image);
      row.metrics.lastPlayed = timestamp(result.image.lastPlayed);
      return { status: 'recorded' };
    });
    const drain = work.then(() => undefined, () => undefined);
    historyDrain = drain;
    try { return await work; }
    catch { return { status: 'unavailable' }; }
    finally {
      pending = false;
      if (historyDrain === drain) { historyDrain = undefined; }
    }
  };
  const resetPlaybackHistory = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryPlaybackHistoryReset> => {
    if (!trusted(event) || typeof options.confirmPlaybackHistoryReset !== 'function') { return { status: 'unavailable' }; }
    if (args.length !== 1 || (args[0] !== 'lastPlayed' && args[0] !== 'timesPlayed')) { return { status: 'invalid' }; }
    if (pending) { return { status: 'busy' }; }
    const metric = args[0];
    pending = true;
    // A native dialog or session adapter can synchronously reenter Lock. Install
    // drainage before either callback, then recheck frame/session authority on
    // both sides of confirmation so a late answer cannot publish after Lock.
    const work = Promise.resolve().then(async (): Promise<PrivateGalleryPlaybackHistoryReset> => {
      if (!trusted(event) || (options.playback && !await stopForOperation(event)) || !trusted(event)) {
        return { status: 'unavailable' };
      }
      try {
        const result = await hub.resetPlaybackHistory(generation, metric, () => trusted(event), async count => {
          if (!trusted(event) || !Number.isSafeInteger(count) || count < 1 || count > MAX_ROWS) { return false; }
          const confirmed = await options.confirmPlaybackHistoryReset!(metric, count);
          return trusted(event) && confirmed === true;
        });
        if (!trusted(event) || !result || typeof result !== 'object' || Object.getPrototypeOf(result) !== Object.prototype) {
          return { status: 'unavailable' };
        }
        const fields = Object.getOwnPropertyDescriptors(result);
        const names = Reflect.ownKeys(fields);
        if (!fields.status?.enumerable || !Object.hasOwn(fields.status, 'value')) { return { status: 'unavailable' }; }
        const status = fields.status.value;
        if (status === 'reset' && names.length === 2 && fields.count?.enumerable && Object.hasOwn(fields.count, 'value')
          && Number.isSafeInteger(fields.count.value) && fields.count.value >= 1 && fields.count.value <= MAX_ROWS) {
          return { status: 'reset', count: fields.count.value };
        }
        if (names.length === 1 && (status === 'unchanged' || status === 'cancelled' || status === 'busy' || status === 'invalid')) {
          return { status };
        }
        return { status: 'unavailable' };
      } finally {
        // Every admitted review may have observed newer catalogue contents.
        // Retire all public revisions, even for cancellation/no-op, while saved
        // source access grants remain explicitly controlled by the user.
        rows = undefined; issued.clear(); ids.clear(); issuedSources.clear();
      }
    });
    const drain = work.then(() => undefined, () => undefined);
    historyResetDrain = drain;
    try { return await work; }
    catch { return { status: 'unavailable' }; }
    finally {
      pending = false;
      if (historyResetDrain === drain) { historyResetDrain = undefined; }
    }
  };
  const regenerate = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryRegeneration> => {
    if (!trusted(event) || args.length !== 1) { return { status: 'unavailable' }; }
    const value = regenerationRequest(args[0]);
    if (!value) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    const id = value.id;
    const row = issued.get(id);
    if (!row || !row.display.regenerable) { return { status: 'unavailable' }; }
    if (value.revision !== row.display.revision) { return { status: 'conflict' }; }
    pending = true;
    const controller = new AbortController();
    regeneration = controller;
    const authorized = (): boolean => !controller.signal.aborted && trusted(event);
    const stopped = (): PrivateGalleryRegeneration => trusted(event) && controller.signal.aborted
      ? { status: 'cancelled' } : { status: 'unavailable' };
    const work = (async (): Promise<PrivateGalleryRegeneration> => {
      let source: PrivatePreviewSource | undefined;
      try {
        if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
        const catalogue = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        const image = catalogue.images[row.index];
        if (!image || privateVideoRevision(image) !== row.persistedRevision) { return { status: 'conflict' }; }
        const location = sourceLocation(catalogue, image);
        if (!location || !eligible(catalogue, image)) { return { status: 'unavailable' }; }
        const grant = await access.authorize(location.root, controller.signal, authorized);
        if (!authorized()) { return stopped(); }
        if (grant.status !== 'granted') { return { status: grant.status }; }
        // The picker can remain open while another main-owned catalogue writer
        // completes. Never grant a replacement row or remapped source by accident.
        const latest = await hub.readCatalogue(generation);
        if (!authorized()) { return stopped(); }
        const refreshed = latest.images[row.index];
        if (!refreshed || privateVideoRevision(refreshed) !== row.persistedRevision
          || !eligible(latest, refreshed) || JSON.stringify(sourceLocation(latest, refreshed)) !== JSON.stringify(location)) {
          return { status: 'conflict' };
        }
        try { source = await capturePrivatePreviewSource({ ...location, signal: controller.signal,
          isCurrent: () => authorized() && grant.isCurrent() }); }
        catch (error) {
          if (isPrivatePreviewSourceCleanupFailure(error)) {
            quarantine();
          }
          return authorized() && !cleanupFailed ? { status: 'source-unavailable' } : stopped();
        }
        if (!authorized() || !grant.isCurrent()) { return stopped(); }
        await hub.generatePreviews(generation, source, { signal: controller.signal });
        if (!authorized()) { return stopped(); }
        Object.assign(row, project(refreshed, row.index, true, playable(latest, refreshed), refreshable(latest, refreshed)));
        return { status: 'generated', item: { ...row.display, id, tags: [...row.display.tags] } };
      } catch (error) {
        if (isPrivatePreviewGenerationCleanupFailure(error)) {
          quarantine();
        }
        return stopped();
      }
      finally {
        try { await source?.close(); }
        catch { quarantine(); }
      }
    })();
    const drain = work.then(() => undefined, () => undefined);
    regenerationDrain = drain;
    try {
      const result = await work;
      return cleanupFailed || !trusted(event) ? { status: 'unavailable' } : controller.signal.aborted ? stopped() : result;
    } finally {
      pending = false;
      if (regeneration === controller) { regeneration = undefined; }
      if (regenerationDrain === drain) { regenerationDrain = undefined; }
    }
  };
  const refreshVideo = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryRefresh> => {
    if (!trusted(event) || !options.chooseSourceDirectory) { return { status: 'unavailable' }; }
    const value = args.length === 1 ? refreshRequest(args[0]) : undefined;
    if (!value) { return { status: 'invalid' }; }
    if (pending) { return { status: 'busy' }; }
    const id = value.id;
    const row = issued.get(id);
    if (!row || !row.display.refreshable) { return { status: 'unavailable' }; }
    if (value.revision !== row.display.revision) { return { status: 'conflict' }; }
    pending = true;
    const controller = new AbortController();
    regeneration = controller;
    const authorized = (): boolean => !controller.signal.aborted && trusted(event) && !controller.signal.aborted;
    const stopped = (): PrivateGalleryRefresh => trusted(event) && controller.signal.aborted
      ? { status: 'cancelled' } : { status: 'unavailable' };
    const oldIdentity = row.identity;
    const oldRevision = row.persistedRevision;
    let location: ReturnType<typeof refreshLocation>;
    let replacementHash: string | undefined;
    let granted = false;
    let refreshed = false;
    const retire = (): void => { rows = undefined; issued.clear(); ids.clear(); };
    // Register the complete drain before any catalogue, playback, capture or
    // native-picker adapter can synchronously reenter Lock/disposal.
    const work = Promise.resolve().then(async (): Promise<PrivateGalleryRefresh> => {
      let outcome: PrivateGalleryRefresh = { status: 'unavailable' };
      let source: PrivatePreviewSource | undefined;
      try {
        outcome = await (async (): Promise<PrivateGalleryRefresh> => {
          if (!authorized() || (options.playback && !await stopForOperation(event)) || !authorized()) { return stopped(); }
          const catalogue = await hub.readCatalogue(generation);
          if (!authorized()) { return stopped(); }
          const image = catalogue.images[row.index];
          if (!image || identity(image) !== oldIdentity || privateVideoRevision(image) !== oldRevision) { return { status: 'conflict' }; }
          location = refreshLocation(catalogue, image);
          if (!location || !refreshable(catalogue, image)) { return { status: 'invalid' }; }
          access.isConnected(location.root);
          const grant = await access.authorize(location.root, controller.signal, authorized);
          granted = grant.status === 'granted';
          if (!authorized()) { return stopped(); }
          if (grant.status !== 'granted') { return { status: grant.status }; }
          const latest = await hub.readCatalogue(generation);
          if (!authorized()) { return stopped(); }
          const selected = latest.images[row.index];
          if (!selected || identity(selected) !== oldIdentity || privateVideoRevision(selected) !== oldRevision
            || !refreshable(latest, selected) || JSON.stringify(refreshLocation(latest, selected)) !== JSON.stringify(location)) {
            return { status: 'conflict' };
          }
          if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
          // A refresh never overwrites the old preview set, including when its
          // catalogue publication is cancelled or fails after media generation.
          replacementHash = randomBytes(16).toString('hex');
          if (latest.images.some(candidate => candidate.hash === replacementHash)) { return { status: 'conflict' }; }
          const replacement = { ...location, hash: replacementHash };
          const eligibility = checkPrivateVideoRefresh(latest, replacement, { index: row.index, revision: oldRevision });
          if (eligibility !== 'ready') { return { status: eligibility }; }
          const fileCurrent = (): boolean => authorized() && grant.isCurrent() && authorized();
          try { source = await capturePrivatePreviewSource({ ...replacement, signal: controller.signal, isCurrent: fileCurrent }); }
          catch (error) {
            if (isPrivatePreviewSourceCleanupFailure(error)) { quarantine(); }
            return authorized() && !cleanupFailed ? { status: 'source-unavailable' } : stopped();
          }
          if (!authorized()) { return stopped(); }
          if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
          const result = await hub.refreshVideo(generation, source, replacement, { index: row.index, revision: oldRevision },
            { signal: controller.signal, isCurrent: fileCurrent });
          if (!authorized()) { return stopped(); }
          if (!grant.isCurrent()) { return { status: 'source-unavailable' }; }
          if (result.status !== 'refreshed') {
            return ['conflict', 'invalid', 'busy'].includes(result.status) ? { status: result.status } : { status: 'unavailable' };
          }
          // The returned image is not enough: publication may have completed
          // before cancellation or another main-owned writer changed the row.
          refreshed = true;
          return { status: 'unavailable' };
        })();
      } catch (error) {
        if (isPrivatePreviewGenerationCleanupFailure(error) || isPrivatePreviewSourceCleanupFailure(error)) { quarantine(); }
        outcome = stopped();
      } finally {
        try { await source?.close(); } catch { quarantine(); }
      }
      try {
        if (!trusted(event)) { return { status: 'unavailable' }; }
        // Reconcile even cancellation or uncertain publication. Only the same
        // row at the original index can retain its issued public identifier.
        const latest = await hub.readCatalogue(generation);
        if (!trusted(event)) { return { status: 'unavailable' }; }
        const saved = latest.images[row.index];
        const savedLocation = saved && refreshLocation(latest, saved);
        const replacedHere = !!saved && !!location && !!replacementHash && saved.hash === replacementHash
          && refreshHashes(latest).has(replacementHash) && !!savedLocation
          && JSON.stringify({ ...savedLocation, hash: location.hash }) === JSON.stringify(location);
        if (!saved || saved.deleted || saved.cleanName === '*FOLDER*'
          || (identity(saved) !== oldIdentity && !replacedHere)) { retire(); return { status: 'conflict' }; }
        Object.assign(row, project(saved, row.index, eligible(latest, saved), playable(latest, saved), refreshable(latest, saved)));
        if (controller.signal.aborted) { return stopped(); }
        if (refreshed && replacedHere) {
          return { status: 'refreshed', item: { ...row.display, id, tags: [...row.display.tags] } };
        }
        return refreshed ? { status: 'conflict' } : outcome;
      } catch { retire(); return stopped(); }
    });
    const drain = work.then(() => undefined, () => undefined);
    regenerationDrain = drain;
    try {
      const result = await work;
      if (granted && result.status !== 'refreshed' && location) { access.disconnect(location.root); }
      return cleanupFailed || !trusted(event) ? { status: 'unavailable' } : result;
    } finally {
      pending = false;
      if (regeneration === controller) { regeneration = undefined; }
      if (regenerationDrain === drain) { regenerationDrain = undefined; }
    }
  };
  const cancelRegeneration = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (trusted(event) && args.length === 0) { regeneration?.abort(); }
  };
  const protection = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryProtection> => {
    if (!trusted(event) || args.length !== 0) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    pending = true;
    try {
      if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
      const settings = await hub.readProtection(generation);
      return trusted(event) ? { status: 'ready', ...settings } : { status: 'unavailable' };
    } catch { return { status: 'unavailable' }; }
    finally { pending = false; }
  };
  const setProtection = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryProtectionSave> => {
    if (!trusted(event) || args.length !== 1) { return { status: 'unavailable' }; }
    const request = snapshotPrivateHubProtection(args[0]);
    if (!request) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    pending = true;
    try {
      if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
      const settings = await hub.updateProtection(generation, request, () => trusted(event));
      if (!trusted(event)) { return { status: 'unavailable' }; }
      try {
        if (onProtectionChanged({ ...settings }) !== true) { throw new Error(); }
      } catch {
        invalidate();
        try { onLock(); } catch { /* A failed timer update cannot retain gallery authority. */ }
        return { status: 'unavailable' };
      }
      return trusted(event) ? { status: 'saved', ...settings } : { status: 'unavailable' };
    } catch { return { status: 'unavailable' }; }
    finally { pending = false; }
  };
  const changePassword = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateCredentialsPasswordChange> => {
    let request: PrivateHubPasswordChangeRequest | undefined;
    try {
      if (!trusted(event)) { return { status: 'unavailable' }; }
      request = args.length === 1 ? snapshotPrivateHubPasswordChange(args[0]) : undefined;
      args.fill(undefined);
      if (!request) { return { status: 'invalid' }; }
      if (pending) { return { status: 'busy' }; }
      pending = true;
      // Install the drain before invoking session code, which can synchronously
      // revoke this window. Lock never awaits this handler from inside the work.
      let successfulLock = false;
      const work = Promise.resolve().then(async (): Promise<PrivateCredentialsPasswordChange> => {
        try {
          if (options.playback && !await stopForOperation(event)) { return { status: 'unavailable' }; }
          const changing = hub.changePassword(generation, request!, () => trusted(event));
          request!.currentPassword = ''; request!.newPassword = '';
          const result = await changing;
          if (!trusted(event)) { return { status: 'unavailable' }; }
          if (result === 'incorrect-password') { return { status: 'incorrect-password' }; }
          if (result !== 'changed') { return { status: 'unavailable' }; }
          invalidate(); // End gallery authority before any lock callback reentry.
          let hubDrain: Promise<void> | undefined;
          try {
            // Key and session revocation are independent of fallible UI cleanup.
            // The session queue has completed; this drain never awaits this handler.
            hubDrain = hub.lock('explicit');
            if (hub.isCurrent(generation)) { cleanupFailed = true; }
          } catch { cleanupFailed = true; }
          try {
            const observer: unknown = onLock();
            if (observer !== undefined) {
              // The observer contract is synchronous. An unexpected promise may
              // depend on this gallery's disposal, so never await it in its own
              // drain. Quarantine immediately and consume any later rejection.
              cleanupFailed = true;
              void Promise.resolve(observer).catch(() => { cleanupFailed = true; });
            }
          } catch { cleanupFailed = true; }
          try { await hubDrain; }
          catch { cleanupFailed = true; }
          try { successfulLock = !cleanupFailed && !hub.isCurrent(generation); }
          catch { cleanupFailed = true; }
          return successfulLock ? { status: 'changed' } : { status: 'unavailable' };
        } catch { return { status: 'unavailable' }; }
        finally {
          if (request) { request.currentPassword = ''; request.newPassword = ''; }
        }
      });
      const drain = work.then(() => undefined, () => undefined);
      credentialDrain = drain;
      try {
        const result = await work;
        if (result.status === 'changed') { return successfulLock && !cleanupFailed ? result : { status: 'unavailable' }; }
        return trusted(event) ? result : { status: 'unavailable' };
      }
      finally {
        pending = false;
        if (credentialDrain === drain) { credentialDrain = undefined; }
      }
    } finally {
      args.fill(undefined);
      if (request) { request.currentPassword = ''; request.newPassword = ''; }
    }
  };
  const touchIdOperation = async <T>(event: IpcMainInvokeEvent, work: () => Promise<T>): Promise<T | undefined> => {
    if (!trusted(event) || pending) { return; }
    pending = true;
    // Register before adapters can reenter lock/dispose. Keychain cancellation
    // uses the same revoked window lifetime; native cleanup must finish first.
    const result = Promise.resolve().then(async () => {
      try {
        if (options.playback && !await stopForOperation(event)) { return; }
        const response = await work();
        return trusted(event) ? response : undefined;
      } catch (error) {
        if (isPrivateTouchIdCleanupFailure(error)) { quarantine(); }
        return undefined;
      }
    });
    const drain = result.then(() => undefined, () => undefined);
    credentialDrain = drain;
    try { return await result; }
    finally { pending = false; if (credentialDrain === drain) { credentialDrain = undefined; } }
  };
  const touchIdStatus = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateCredentialsTouchIdStatus> => {
    if (args.length !== 0) { return { outcome: 'unavailable' }; }
    const state = await touchIdOperation(event, () => hub.touchIdStatus(generation, lifetime.signal));
    return state === 'enabled' || state === 'disabled' ? { outcome: 'available', state } : { outcome: 'unavailable' };
  };
  const enableTouchId = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateCredentialsTouchIdEnable> => {
    const request = args.length === 1 ? snapshotPrivateHubTouchIdEnable(args[0]) : undefined;
    args.fill(undefined);
    try {
      if (!request) { return { outcome: 'unavailable' }; }
      const outcome = await touchIdOperation(event, async () => {
        const work = hub.enableTouchId(generation, request, () => trusted(event), lifetime.signal);
        request.password = '';
        return work;
      });
      return outcome === 'enabled' || outcome === 'incorrect-password' || outcome === 'cancelled'
        ? { outcome } : { outcome: 'unavailable' };
    } finally { if (request) { request.password = ''; } }
  };
  const disableTouchId = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateCredentialsTouchIdDisable> => {
    if (args.length !== 0) { return { outcome: 'unavailable' }; }
    const outcome = await touchIdOperation(event, () => hub.disableTouchId(generation, () => trusted(event), lifetime.signal));
    return { outcome: outcome === 'disabled' ? 'disabled' : 'unavailable' };
  };

  const createUnprotectedCopy = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateCredentialsUnprotectedCopy> => {
    let request: PrivateHubPlaintextCopyRequest | undefined;
    try {
      if (!trusted(event) || typeof chooseUnprotectedCopyDestination !== 'function') { return { status: 'unavailable' }; }
      request = args.length === 1 ? snapshotPrivateHubPlaintextCopyRequest(args[0]) : undefined;
      args.fill(undefined);
      if (!request) { return { status: 'invalid' }; }
      if (pending) { return { status: 'busy' }; }
      pending = true;
      const controller = new AbortController();
      unprotectedCopy = controller;
      const authorized = (): boolean => !controller.signal.aborted && trusted(event) && !controller.signal.aborted;
      const stopped = (): PrivateCredentialsUnprotectedCopy => trusted(event) && controller.signal.aborted
        ? { status: 'cancelled' } : { status: 'unavailable' };
      // Register drainage before a session callback can synchronously dispose us.
      const work = Promise.resolve().then(async (): Promise<PrivateCredentialsUnprotectedCopy> => {
        try {
          if (!authorized() || (options.playback && !await stopForOperation(event)) || !authorized()) { return stopped(); }
          const copying = hub.createUnprotectedCopy(generation, request!, authorized, {
            signal: controller.signal,
            chooseDestination: async () => {
              if (!authorized()) { return undefined; }
              const directory = await chooseUnprotectedCopyDestination();
              return authorized() ? directory : undefined;
            },
          });
          request!.password = '';
          const result = await copying;
          if (!authorized()) { return stopped(); }
          return ['copied', 'incorrect-password', 'cancelled', 'failed'].includes(result)
            ? { status: result } : { status: 'unavailable' };
        } catch (error) {
          if (isPrivateHubPlaintextExportCleanupFailure(error)) { quarantine(); }
          return authorized() ? { status: 'failed' } : stopped();
        } finally { if (request) { request.password = ''; } }
      });
      const drain = work.then(() => undefined, () => undefined);
      unprotectedCopyDrain = drain;
      try {
        const result = await work;
        return authorized() ? result : stopped();
      } finally {
        pending = false;
        if (unprotectedCopy === controller) { unprotectedCopy = undefined; }
        if (unprotectedCopyDrain === drain) { unprotectedCopyDrain = undefined; }
      }
    } finally {
      args.fill(undefined);
      if (request) { request.password = ''; }
    }
  };
  const cancelUnprotectedCopy = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (trusted(event) && args.length === 0 && !unprotectedCopy?.signal.aborted) { unprotectedCopy?.abort(); }
  };
  const lock = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (!trusted(event) || args.length !== 0) { return; }
    invalidate(); // Revoke before a main callback can synchronously reenter.
    try { onLock(); } catch { /* Do not return private diagnostics. */ }
  };
  const dispose = (): Promise<void> => {
    if (disposal) { return disposal; }
    disposed = true;
    invalidate();
    signal.removeEventListener('abort', invalidate);
    contents.removeListener('did-start-navigation', navigate);
    contents.removeListener('destroyed', invalidate);
    contents.removeListener('render-process-gone', invalidate);
    ipcMain.removeListener(channels.lock, lock);
    ipcMain.removeListener(channels.stopOriginal, stopOriginal);
    ipcMain.removeListener(channels.cancelRegeneration, cancelRegeneration);
    ipcMain.removeListener(channels.cancelSourceConnection, cancelSourceConnection);
    ipcMain.removeListener(channels.cancelImport, cancelImport);
    ipcMain.removeListener(channels.cancelUnprotectedCopy, cancelUnprotectedCopy);
    if (activeRequest === token) {
      for (const channel of installed) { ipcMain.removeHandler(channel); }
      activeRequest = undefined;
    }
    let playbackDisposal: Promise<void> | undefined;
    try { playbackDisposal = options.playback?.dispose(); } catch { cleanupFailed = true; }
    const disposedPlayback = Promise.resolve(playbackDisposal).catch(() => { cleanupFailed = true; });
    disposal = Promise.all([access.dispose(), originalDrain, historyDrain, historyResetDrain, playbackDrain, disposedPlayback,
      regenerationDrain, sourceConnectionDrain, importDrain, credentialDrain, unprotectedCopyDrain]).then(() => {
      if (cleanupFailed) { throw new Error('Private gallery cleanup unavailable'); }
    });
    return disposal;
  };
  try {
    ipcMain.handle(channels.sources, sources); installed.push(channels.sources);
    ipcMain.handle(channels.addSource, addSource); installed.push(channels.addSource);
    ipcMain.handle(channels.connectSource, connectSource); installed.push(channels.connectSource);
    ipcMain.handle(channels.checkSource, checkSource); installed.push(channels.checkSource);
    ipcMain.handle(channels.disconnectSource, disconnectSource); installed.push(channels.disconnectSource);
    ipcMain.handle(channels.relocateSource, relocateSource); installed.push(channels.relocateSource);
    ipcMain.handle(channels.importVideo, importVideo); installed.push(channels.importVideo);
    ipcMain.handle(channels.scanSource, scanSource); installed.push(channels.scanSource);
    ipcMain.handle(channels.importProgress, importProgress); installed.push(channels.importProgress);
    ipcMain.handle(channels.list, list); installed.push(channels.list);
    ipcMain.handle(channels.detail, detail); installed.push(channels.detail);
    ipcMain.handle(channels.save, save); installed.push(channels.save);
    ipcMain.handle(channels.playOriginal, playOriginal); installed.push(channels.playOriginal);
    ipcMain.handle(channels.ackOriginalPlayback, ackOriginalPlayback); installed.push(channels.ackOriginalPlayback);
    ipcMain.handle(channels.resetPlaybackHistory, resetPlaybackHistory); installed.push(channels.resetPlaybackHistory);
    ipcMain.handle(channels.regenerate, regenerate); installed.push(channels.regenerate);
    ipcMain.handle(channels.refreshVideo, refreshVideo); installed.push(channels.refreshVideo);
    ipcMain.handle(channels.protection, protection); installed.push(channels.protection);
    ipcMain.handle(channels.setProtection, setProtection); installed.push(channels.setProtection);
    ipcMain.handle(channels.changePassword, changePassword); installed.push(channels.changePassword);
    ipcMain.handle(channels.touchIdStatus, touchIdStatus); installed.push(channels.touchIdStatus);
    ipcMain.handle(channels.enableTouchId, enableTouchId); installed.push(channels.enableTouchId);
    ipcMain.handle(channels.disableTouchId, disableTouchId); installed.push(channels.disableTouchId);
    ipcMain.handle(channels.createUnprotectedCopy, createUnprotectedCopy); installed.push(channels.createUnprotectedCopy);
    ipcMain.on(channels.lock, lock);
    ipcMain.on(channels.stopOriginal, stopOriginal);
    ipcMain.on(channels.cancelRegeneration, cancelRegeneration);
    ipcMain.on(channels.cancelSourceConnection, cancelSourceConnection);
    ipcMain.on(channels.cancelImport, cancelImport);
    ipcMain.on(channels.cancelUnprotectedCopy, cancelUnprotectedCopy);
    contents.on('did-start-navigation', navigate);
    contents.on('destroyed', invalidate);
    contents.on('render-process-gone', invalidate);
    signal.addEventListener('abort', invalidate, { once: true });
  } catch { void dispose().catch(() => undefined); throw new Error('Private gallery unavailable'); }
  return dispose;
}
