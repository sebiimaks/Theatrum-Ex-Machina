import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { FinalObject, ImageElement } from '../interfaces/final-object.interface';
import { getImageLocations } from '../interfaces/media-locations';
import { PRIVATE_GALLERY_CHANNELS as channels, PRIVATE_GALLERY_PAGE_SIZE,
  type PrivateGalleryDetail, type PrivateGalleryItem, type PrivateGalleryPage,
  type PrivateGalleryEdit, type PrivateGallerySave, type PrivateGallerySelection,
  type PrivateGalleryRegeneration, type PrivateGalleryProtection, type PrivateGalleryProtectionSave,
  type PrivateCredentialsPasswordChange, type PrivateCredentialsUnprotectedCopy,
  type PrivateCredentialsTouchIdStatus, type PrivateCredentialsTouchIdEnable, type PrivateCredentialsTouchIdDisable } from '../interfaces/private-gallery';
import { snapshotPrivateHubPasswordChange, snapshotPrivateHubPlaintextCopyRequest, snapshotPrivateHubTouchIdEnable,
  type PrivateHubPasswordChangeRequest, type PrivateHubPlaintextCopyRequest } from '../interfaces/private-hub-credentials';
import { snapshotPrivateHubProtection, type PrivateHubProtection } from '../interfaces/private-hub-protection';
import { createTheatrumMediaUrl } from '../interfaces/theatrum-protocol';
import type { PrivateHubSession } from './private-hub-session';
import { isPrivateHubPlaintextExportCleanupFailure } from './private-hub-plaintext-export';
import { privateVideoMetadataEditable, privateVideoRevision } from './private-hub-metadata';
import { PrivateSourceAccess } from './private-source-access';
import { isPrivatePreviewGenerationCleanupFailure } from './private-hub-preview-generation';
import { capturePrivatePreviewSource, isPrivatePreviewSourceCleanupFailure, type PrivatePreviewSource } from './private-preview-source';

import { isPrivateTouchIdCleanupFailure } from './private-touch-id';

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
  /** Native main-owned picker. Never accept a path from the renderer. */
  readonly chooseSourceDirectory?: (root: string) => Promise<string | undefined>;
  /** Native picker for an explicitly acknowledged unprotected copy. No renderer paths. */
  readonly chooseUnprotectedCopyDestination?: () => Promise<string | undefined>;
}
interface Row {
  display: Omit<PrivateGalleryDetail, 'id'>;
  search: string;
  index: number;
  identity: string;
  persistedRevision: string;
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
function project(image: ImageElement, index: number, regenerable = false): Row {
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
    display: { title, notes, tags, duration: number(image.duration), width: number(image.width), height: number(image.height),
      rating, favourite: image.stars === 5.5, editable: privateVideoMetadataEditable(image), regenerable,
      revision: randomBytes(16).toString('hex'),
      thumbnailUrl: createTheatrumMediaUrl('thumbnails', image.hash, false, previewKey),
      clipUrl: createTheatrumMediaUrl('clips', image.hash, true, previewKey),
      posterUrl: createTheatrumMediaUrl('clips', image.hash, false, previewKey),
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

function uniqueHashes(catalogue: FinalObject): Set<string> {
  const counts = new Map<string, number>();
  for (const image of catalogue.images) {
    if (!image.deleted && image.cleanName !== '*FOLDER*') { counts.set(image.hash, (counts.get(image.hash) ?? 0) + 1); }
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([hash]) => hash));
}
function edit(value: unknown): PrivateGalleryEdit | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== 'id,notes,revision,tags'
    || typeof object.id !== 'string' || !/^[a-f0-9]{32}$/.test(object.id)
    || typeof object.revision !== 'string' || !/^[a-f0-9]{32}$/.test(object.revision)
    || typeof object.notes !== 'string' || object.notes.length > 65_536
    || !Array.isArray(object.tags) || object.tags.length > 128
    || !object.tags.every(tag => typeof tag === 'string' && tag.length <= 512)) { return undefined; }
  return { id: object.id, revision: object.revision, notes: object.notes, tags: [...object.tags] };
}
function summary(id: string, row: Row): PrivateGalleryItem {
  const { title, duration, width, height, rating, favourite, tags, thumbnailUrl } = row.display;
  return { id, title, duration, width, height, rating, favourite, tags: [...tags], thumbnailUrl };
}
function query(value: unknown): { query: string; offset: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== 'offset,query' || typeof object.query !== 'string'
    || object.query.length > 200 || !Number.isSafeInteger(object.offset) || (object.offset as number) < 0
    || (object.offset as number) > MAX_ROWS || (object.offset as number) % PRIVATE_GALLERY_PAGE_SIZE !== 0) { return undefined; }
  return { query: object.query.trim().toLocaleLowerCase('en-US'), offset: object.offset as number };
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
  let regeneration: AbortController | undefined;
  let regenerationDrain: Promise<void> | undefined;
  let credentialDrain: Promise<void> | undefined;
  let unprotectedCopy: AbortController | undefined;
  let unprotectedCopyDrain: Promise<void> | undefined;
  let cleanupFailed = false;
  let disposal: Promise<void> | undefined;
  const issued = new Map<string, Row>();
  const ids = new Map<Row, string>();
  const installed: string[] = [];
  const invalidate = (): void => {
    invalidated = true; lifetime.abort(); regeneration?.abort(); unprotectedCopy?.abort(); rows = undefined; issued.clear(); ids.clear();
  };
  const quarantine = (): void => {
    cleanupFailed = true;
    invalidate();
    try { onLock(); } catch { /* The failed cleanup is also returned through the disposer. */ }
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
  const load = async (): Promise<Row[]> => {
    if (rows) { return rows; }
    const catalogue = await hub.readCatalogue(generation);
    if (!current() || !Array.isArray(catalogue.images)) { throw new Error(); }
    const projected: Row[] = [];
    const hashes = uniqueHashes(catalogue);
    for (const [index, image] of catalogue.images.entries()) {
      if (image.deleted || image.cleanName === '*FOLDER*') { continue; }
      if (projected.length >= MAX_ROWS) { throw new Error(); }
      projected.push(project(image, index, eligible(catalogue, image, hashes)));
    }
    if (!current()) { throw new Error(); }
    rows = projected;
    return rows;
  };
  const list = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryPage> => {
    try {
      if (!trusted(event) || args.length !== 1) { return { status: 'unavailable' }; }
      const request = query(args[0]);
      if (!request) { return { status: 'unavailable' }; }
      if (pending) { return { status: 'busy' }; }
      pending = true;
      try {
        const all = await load();
        if (!trusted(event)) { return { status: 'unavailable' }; }
        const matches = request.query ? all.filter(row => row.search.includes(request.query)) : all;
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
        const catalogue = await hub.readCatalogue(generation);
        if (!trusted(event)) { return { status: 'unavailable' }; }
        const image = catalogue.images[row.index];
        if (!image || image.deleted || image.cleanName === '*FOLDER*' || identity(image) !== row.identity) {
          return { status: 'unavailable' };
        }
        const latest = project(image, row.index, eligible(catalogue, image));
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
        const result = await hub.updateVideoMetadata(generation, {
          index: row.index, revision: row.persistedRevision, notes: request.notes, tags: request.tags,
        }, () => trusted(event));
        if (!trusted(event)) { return { status: 'unavailable' }; }
        if (result.status !== 'saved') { return { status: result.status }; }
        if (identity(result.image) !== row.identity) { return { status: 'unavailable' }; }
        Object.assign(row, project(result.image, row.index, row.display.regenerable));
        return { status: 'saved', item: { ...row.display, id: request.id, tags: [...row.display.tags] } };
      } finally { pending = false; }
    } catch { return { status: 'unavailable' }; }
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
        Object.assign(row, project(refreshed, row.index, true));
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
  const cancelRegeneration = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (trusted(event) && args.length === 0) { regeneration?.abort(); }
  };
  const protection = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PrivateGalleryProtection> => {
    if (!trusted(event) || args.length !== 0) { return { status: 'unavailable' }; }
    if (pending) { return { status: 'busy' }; }
    pending = true;
    try {
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
          if (!trusted(event)) { return { status: 'unavailable' }; }
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
        if (!trusted(event)) { return; }
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
          if (!authorized()) { return stopped(); }
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
    ipcMain.removeListener(channels.cancelRegeneration, cancelRegeneration);
    ipcMain.removeListener(channels.cancelUnprotectedCopy, cancelUnprotectedCopy);
    if (activeRequest === token) {
      for (const channel of installed) { ipcMain.removeHandler(channel); }
      activeRequest = undefined;
    }
    disposal = Promise.all([access.dispose(), regenerationDrain, credentialDrain, unprotectedCopyDrain]).then(() => {
      if (cleanupFailed) { throw new Error('Private gallery cleanup unavailable'); }
    });
    return disposal;
  };
  try {
    ipcMain.handle(channels.list, list); installed.push(channels.list);
    ipcMain.handle(channels.detail, detail); installed.push(channels.detail);
    ipcMain.handle(channels.save, save); installed.push(channels.save);
    ipcMain.handle(channels.regenerate, regenerate); installed.push(channels.regenerate);
    ipcMain.handle(channels.protection, protection); installed.push(channels.protection);
    ipcMain.handle(channels.setProtection, setProtection); installed.push(channels.setProtection);
    ipcMain.handle(channels.changePassword, changePassword); installed.push(channels.changePassword);
    ipcMain.handle(channels.touchIdStatus, touchIdStatus); installed.push(channels.touchIdStatus);
    ipcMain.handle(channels.enableTouchId, enableTouchId); installed.push(channels.enableTouchId);
    ipcMain.handle(channels.disableTouchId, disableTouchId); installed.push(channels.disableTouchId);
    ipcMain.handle(channels.createUnprotectedCopy, createUnprotectedCopy); installed.push(channels.createUnprotectedCopy);
    ipcMain.on(channels.lock, lock);
    ipcMain.on(channels.cancelRegeneration, cancelRegeneration);
    ipcMain.on(channels.cancelUnprotectedCopy, cancelUnprotectedCopy);
    contents.on('did-start-navigation', navigate);
    contents.on('destroyed', invalidate);
    contents.on('render-process-gone', invalidate);
    signal.addEventListener('abort', invalidate, { once: true });
  } catch { void dispose().catch(() => undefined); throw new Error('Private gallery unavailable'); }
  return dispose;
}
