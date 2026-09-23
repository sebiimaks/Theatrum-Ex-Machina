import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

import type { PrivateConversionFailure } from '../interfaces/private-conversion';
import { privateConversionFailureAtStage } from './private-conversion-errors';
import type { PrivateHubPreviewKind } from './private-hub-catalogue';
import { writePrivateHubPreview, readPrivateHubPreview, privateHubClipMediaId, PRIVATE_HUB_MAX_IMAGE_BYTES } from './private-hub-catalogue';
import { openPrivateHubMedia, writePrivateHubMedia } from './private-hub-media';
import { PrivateHubStore, isPrivateHubStoreCleanupFailure } from './private-hub-store';
import { CATALOGUE_FILE_MAX_BYTES, parseVhaJson } from './vha-file-persistence';

const RECEIPT_RECORD = 'conversion:receipt';
const MAX_PREVIEWS = 100_000;
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = PRIVATE_HUB_MAX_IMAGE_BYTES;
const MAX_CLIP_BYTES = 1024 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 5000;
// Allow an admitted file close (5s), lease graceful/forced shutdown (10s),
// and its parent descriptor close (5s), with headroom for sequential drainage.
const STORE_DRAIN_TIMEOUT_MS = 30_000;
const cleanupFailures = new WeakSet<object>();

function cleanupFailure(): Error {
  const error = new Error('The private hub conversion cleanup could not be confirmed.');
  cleanupFailures.add(error);
  return error;
}

/** Main must keep normal admission sealed after unconfirmed descriptor, iterator or store cleanup. */
export function isPrivateHubConversionCleanupFailure(error: unknown): error is Error {
  return isPrivateHubStoreCleanupFailure(error)
    || (typeof error === 'object' && error !== null && cleanupFailures.has(error));
}

/** Retain uncertainty even when an iterator consumer masks a failed return() with its own error. */
class ConversionCleanup {
  #failure?: Error;

  async confirm(work: () => Promise<unknown>, timeout = CLEANUP_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(work), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(cleanupFailure()), timeout);
      })]);
    } catch {
      this.#failure ??= cleanupFailure();
      throw this.#failure;
    } finally { if (timer) { clearTimeout(timer); } }
  }

  assertConfirmed(): void { if (this.#failure) { throw this.#failure; } }

  async closeIterator(iterator: AsyncIterableIterator<unknown>): Promise<void> {
    await this.confirm(async () => {
      if (typeof iterator.return !== 'function' || (await iterator.return()).done !== true) {
        throw cleanupFailure();
      }
    });
  }
}

type Stage = 'scanning' | 'copying' | 'verifying' | 'complete';
export interface PrivateHubConversionReviewOptions {
  cataloguePath: string;
  /** Main must hold the same source writer exclusion through review and conversion. */
  assertSourceQuiescent: () => void;
  signal?: AbortSignal;
}

/** Display-safe counts. The issued object itself remains a main-process authority. */
export interface PrivateHubConversionReview {
  readonly videos: number;
  readonly availablePreviews: number;
  readonly previewBytes: number;
  readonly missingPreviews: Readonly<Record<PrivateHubPreviewKind, number>>;
}

interface ReviewProof {
  cataloguePath: string;
  fingerprint: string;
  assertSourceQuiescent: () => void;
  signal?: AbortSignal;
}
const issuedReviews = new WeakMap<PrivateHubConversionReview, ReviewProof>();

export interface PrivateHubConversionOptions extends PrivateHubConversionReviewOptions {
  destinationDirectory: string;
  password: string;
  /** Missing expected previews require a deliberate decision bound to an issued review. */
  allowMissingPreviews?: boolean;
  /** Exact main-owned review object; single use, bound to the source and exclusion lifetime. */
  review?: PrivateHubConversionReview;
  /** Counts only: source names, paths, passwords and notes never appear in progress events. */
  onProgress?: (progress: { stage: Stage; completed: number; total: number }) => void;
}

interface FileSnapshot {
  filePath: string;
  stats: Stats;
}
interface DirectorySnapshot {
  directory: string;
  stats?: Stats;
}
export interface ConvertedPreview {
  kind: PrivateHubPreviewKind;
  hash: string;
  byteLength: number;
  sha256: string;
}
export interface PrivateHubConversionReceipt {
  format: 'theatrum-private-hub-conversion';
  version: 1;
  state: 'complete';
  catalogueSha256: string;
  catalogueByteLength: number;
  previews: ConvertedPreview[];
  missingPreviews: { kind: PrivateHubPreviewKind; hash: string }[];
}
interface PreviewSource {
  kind: PrivateHubPreviewKind;
  hash: string;
  file: FileSnapshot;
}

const PREVIEW_LAYOUT: { kind: PrivateHubPreviewKind; directory: string; extension: string }[] = [
  { kind: 'thumbnail', directory: 'thumbnails', extension: '.jpg' },
  { kind: 'filmstrip', directory: 'filmstrips', extension: '.jpg' },
  { kind: 'clip-poster', directory: 'clips', extension: '.jpg' },
  { kind: 'clip', directory: 'clips', extension: '.mp4' },
];

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function sameContentSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

function sameSnapshot(before: Stats, after: Stats): boolean {
  return sameContentSnapshot(before, after) && before.ctimeMs === after.ctimeMs;
}

function guard(options: PrivateHubConversionReviewOptions): void {
  options.signal?.throwIfAborted();
  const result: unknown = options.assertSourceQuiescent();
  if (result !== undefined) {
    // TypeScript permits async functions where () => void is expected. Never
    // treat an unawaited assertion as successful writer exclusion.
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      Promise.resolve(result).catch(() => undefined);
    }
    throw new Error('The source quiescence guard must be synchronous.');
  }
}

function progress(options: PrivateHubConversionOptions, stage: Stage, completed: number, total: number): void {
  // Observers cannot change whether a completed transaction succeeded. Explicit
  // cancellation uses AbortSignal or the main-owned quiescence assertion.
  try { options.onProgress?.({ stage, completed, total }); } catch { /* observer only */ }
}

function nested(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function snapshotDirectory(directory: string): Promise<DirectorySnapshot> {
  try {
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || await fs.realpath(directory) !== directory) {
      throw new Error('Conversion requires canonical source directories without symbolic links.');
    }
    return { directory, stats };
  } catch (error) {
    if (missing(error)) { return { directory }; }
    throw error;
  }
}

async function snapshotFile(filePath: string, maximum: number): Promise<FileSnapshot | undefined> {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.size > maximum || stats.size < 0 || !Number.isSafeInteger(stats.size)
      || await fs.realpath(filePath) !== filePath) {
      throw new Error('A conversion source is linked, oversized, or not a regular file.');
    }
    return { filePath, stats };
  } catch (error) {
    if (missing(error)) { return undefined; }
    throw error;
  }
}

async function assertFileUnchanged(source: FileSnapshot): Promise<void> {
  const current = await snapshotFile(source.filePath, source.stats.size);
  if (!current || !sameSnapshot(source.stats, current.stats)) {
    throw new Error('A source file changed during conversion. The original hub remains authoritative.');
  }
}

/** Buffers are owned by the generator and erased after each consumer advances. */
async function* sourceChunks(source: FileSnapshot, options: PrivateHubConversionReviewOptions, cleanup: ConversionCleanup): AsyncGenerator<Buffer> {
  guard(options);
  await assertFileUnchanged(source);
  const handle = await fs.open(source.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (!sameSnapshot(source.stats, await handle.stat())) {
      throw new Error('A conversion source changed before it could be read.');
    }
    let offset = 0;
    while (offset < source.stats.size) {
      guard(options);
      const bytes = Buffer.alloc(Math.min(COPY_BUFFER_BYTES, source.stats.size - offset));
      const erase = () => { bytes.fill(0); };
      options.signal?.addEventListener('abort', erase, { once: true });
      try {
        let filled = 0;
        while (filled < bytes.length) {
          guard(options);
          const read = await handle.read(bytes, filled, bytes.length - filled, offset + filled);
          if (!read.bytesRead) { throw new Error('A conversion source was truncated while reading.'); }
          filled += read.bytesRead;
        }
        offset += bytes.length;
        guard(options);
        yield bytes;
      } finally {
        options.signal?.removeEventListener('abort', erase);
        bytes.fill(0);
      }
    }
    if (!sameSnapshot(source.stats, await handle.stat())) {
      throw new Error('A conversion source changed while reading.');
    }
    await assertFileUnchanged(source);
    guard(options);
  } finally {
    await cleanup.confirm(() => handle.close());
  }
}

async function sourceBytes(source: FileSnapshot, options: PrivateHubConversionReviewOptions, cleanup: ConversionCleanup): Promise<Buffer> {
  const result = Buffer.alloc(source.stats.size);
  const erase = () => { result.fill(0); };
  options.signal?.addEventListener('abort', erase, { once: true });
  try {
    let offset = 0;
    for await (const bytes of sourceChunks(source, options, cleanup)) {
      guard(options);
      bytes.copy(result, offset);
      offset += bytes.length;
    }
    return result;
  } catch (error) {
    result.fill(0);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', erase);
    cleanup.assertConfirmed();
  }
}

interface ConversionInventory {
  catalogue: FileSnapshot;
  rawCatalogue: Buffer;
  catalogueSha256: string;
  parent: DirectorySnapshot;
  assetRoot: string;
  videos: number;
  directories: DirectorySnapshot[];
  files: PreviewSource[];
  absentPaths: string[];
  missingPreviews: PrivateHubConversionReceipt['missingPreviews'];
  dispose: () => void;
}

async function readInventory(options: PrivateHubConversionReviewOptions, cleanup: ConversionCleanup): Promise<ConversionInventory> {
  if (typeof options.assertSourceQuiescent !== 'function') {
    throw new Error('Conversion requires a main-process source quiescence guard.');
  }
  guard(options);
  const cataloguePath = path.resolve(options.cataloguePath);
  const sourceParent = path.dirname(cataloguePath);
  const parent = await snapshotDirectory(sourceParent);
  if (!parent.stats) { throw new Error('The source parent directory must exist.'); }
  const catalogue = await snapshotFile(cataloguePath, CATALOGUE_FILE_MAX_BYTES);
  if (!catalogue) { throw new Error('The source catalogue is missing.'); }
  const rawCatalogue = await sourceBytes(catalogue, options, cleanup);
  const erase = () => { rawCatalogue.fill(0); };
  options.signal?.addEventListener('abort', erase, { once: true });
  const dispose = () => { options.signal?.removeEventListener('abort', erase); erase(); };
  try {
    guard(options);
    const parsed = parseVhaJson(rawCatalogue);
    const assetRoot = path.join(sourceParent, `vha-${parsed.hubName}`);
    const hashes = [...new Set(parsed.images.map(image => image.hash))];
    if (hashes.length * PREVIEW_LAYOUT.length > MAX_PREVIEWS
      || hashes.some(hash => typeof hash !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(hash))) {
      throw new Error('The source contains invalid preview identities or too many previews.');
    }
    const directories: DirectorySnapshot[] = [];
    for (const directory of [assetRoot, ...new Set(PREVIEW_LAYOUT.map(layout => path.join(assetRoot, layout.directory)))]) {
      guard(options);
      directories.push(await snapshotDirectory(directory));
    }
    const files: PreviewSource[] = [];
    const absentPaths: string[] = [];
    const missingPreviews: PrivateHubConversionReceipt['missingPreviews'] = [];
    for (const hash of hashes) {
      for (const layout of PREVIEW_LAYOUT) {
        guard(options);
        const filePath = path.join(assetRoot, layout.directory, hash + layout.extension);
        const file = await snapshotFile(filePath, layout.kind === 'clip' ? MAX_CLIP_BYTES : MAX_IMAGE_BYTES);
        if (file) { files.push({ kind: layout.kind, hash, file }); }
        else {
          absentPaths.push(filePath);
          if (layout.kind === 'thumbnail' || layout.kind === 'filmstrip' || parsed.screenshotSettings.clipSnippets > 0) {
            missingPreviews.push({ kind: layout.kind, hash });
          }
        }
      }
    }
    guard(options);
    const catalogueSha256 = createHash('sha256').update(rawCatalogue).digest('hex');
    return { catalogue, rawCatalogue, catalogueSha256, parent, assetRoot, videos: hashes.length,
      directories, files, absentPaths, missingPreviews, dispose };
  } catch (error) { dispose(); throw error; }
}

async function assertCatalogueUnchanged(
  inventory: ConversionInventory, options: PrivateHubConversionReviewOptions, cleanup: ConversionCleanup,
): Promise<void> {
  const { catalogue } = inventory;
  const current = await snapshotFile(catalogue.filePath, catalogue.stats.size);
  if (!current || !sameContentSnapshot(catalogue.stats, current.stats)) {
    throw new Error('A source file changed during conversion. The original hub remains authoritative.');
  }
  if (sameSnapshot(catalogue.stats, current.stats)) { return; }
  // OS metadata updates can change ctime without editing catalogue bytes.
  // A changed ctime still requires a fresh, stable descriptor read and an exact
  // content digest match; restoring size/mtime cannot hide a real edit.
  const bytes = await sourceBytes(current, options, cleanup);
  try {
    if (createHash('sha256').update(bytes).digest('hex') !== inventory.catalogueSha256) {
      throw new Error('A source file changed during conversion. The original hub remains authoritative.');
    }
  } finally { bytes.fill(0); }
}

async function assertInventoryUnchanged(
  inventory: ConversionInventory, options: PrivateHubConversionReviewOptions, includeParent: boolean, cleanup: ConversionCleanup,
): Promise<void> {
  guard(options);
  await assertCatalogueUnchanged(inventory, options, cleanup);
  for (const source of inventory.files) { guard(options); await assertFileUnchanged(source.file); }
  for (const filePath of inventory.absentPaths) {
    guard(options);
    if (await snapshotFile(filePath, MAX_CLIP_BYTES)) { throw new Error('A missing source preview appeared during conversion.'); }
  }
  // Save dialogs and Finder may create unrelated siblings in the source parent.
  // Keep its canonical identity stable without treating those entries as hub data.
  if (includeParent) {
    guard(options);
    const current = await snapshotDirectory(inventory.parent.directory);
    if (!current.stats || !inventory.parent.stats
      || current.stats.dev !== inventory.parent.stats.dev || current.stats.ino !== inventory.parent.stats.ino) {
      throw new Error('The source parent directory changed during conversion.');
    }
  }
  for (const previous of inventory.directories) {
    guard(options);
    const current = await snapshotDirectory(previous.directory);
    if (Boolean(previous.stats) !== Boolean(current.stats)
      || (previous.stats && !sameSnapshot(previous.stats, current.stats))) {
      throw new Error('The source preview tree changed during conversion.');
    }
  }
  guard(options);
}

function inventoryFingerprint(inventory: ConversionInventory): string {
  const identity = (stats?: Stats) => stats ? [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs] : null;
  const catalogueStats = inventory.catalogue.stats;
  return createHash('sha256').update(JSON.stringify({
    // The catalogue is fully reread for both inventories. Its digest captures
    // content changes without treating a metadata-only ctime update as an edit.
    catalogue: [inventory.catalogue.filePath, [catalogueStats.dev, catalogueStats.ino, catalogueStats.size, catalogueStats.mtimeMs],
      inventory.catalogueSha256],
    parent: [inventory.parent.directory, inventory.parent.stats ? [inventory.parent.stats.dev, inventory.parent.stats.ino] : null],
    directories: inventory.directories.map(item => [item.directory, identity(item.stats)]),
    files: inventory.files.map(item => [item.kind, item.hash, item.file.filePath, identity(item.file.stats)]),
    absentPaths: inventory.absentPaths,
    missingPreviews: inventory.missingPreviews,
  })).digest('hex');
}

/** Read only the catalogue and preview metadata; never open original videos or create output. */
export async function reviewCatalogueForPrivateConversion(options: PrivateHubConversionReviewOptions): Promise<PrivateHubConversionReview> {
  const cleanup = new ConversionCleanup();
  const inventory = await readInventory(options, cleanup);
  try {
    await assertInventoryUnchanged(inventory, options, true, cleanup);
    cleanup.assertConfirmed();
    const missingPreviews: Record<PrivateHubPreviewKind, number> = { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 };
    for (const missingPreview of inventory.missingPreviews) { missingPreviews[missingPreview.kind]++; }
    const review: PrivateHubConversionReview = Object.freeze({
      videos: inventory.videos,
      availablePreviews: inventory.files.length,
      previewBytes: inventory.files.reduce((total, source) => total + source.file.stats.size, 0),
      missingPreviews: Object.freeze(missingPreviews),
    });
    issuedReviews.set(review, {
      cataloguePath: inventory.catalogue.filePath, fingerprint: inventoryFingerprint(inventory),
      assertSourceQuiescent: options.assertSourceQuiescent, signal: options.signal,
    });
    return review;
  } finally { inventory.dispose(); cleanup.assertConfirmed(); }
}

function consumeReview(options: PrivateHubConversionOptions): ReviewProof | undefined {
  if (options.review === undefined) {
    if (options.allowMissingPreviews === true) { throw new Error('Missing-preview consent requires an issued conversion review.'); }
    return undefined;
  }
  const proof = issuedReviews.get(options.review);
  issuedReviews.delete(options.review);
  if (!proof || proof.cataloguePath !== path.resolve(options.cataloguePath)
    || proof.assertSourceQuiescent !== options.assertSourceQuiescent || proof.signal !== options.signal) {
    throw new Error('The conversion review is invalid, expired, or belongs to another source lifetime.');
  }
  return proof;
}

/**
 * Copy a quiescent hub to an exclusive new destination. This function never
 * deletes, changes, renames, repairs, or activates the source. Incomplete output
 * is encrypted and retained for inspection. A failure after final publication
 * may leave a complete receipt; reopening and verification resolve that state.
 * A branded cleanup failure is permanent uncertainty for the caller's current
 * transition, including if the underlying close later settles successfully.
 */
export async function convertCatalogueToPrivateHub(options: PrivateHubConversionOptions): Promise<PrivateHubConversionReceipt> {
  let failureStage: PrivateConversionFailure = 'source-inspection-failed';
  try {
    const reviewProof = consumeReview(options);
    const cleanup = new ConversionCleanup();
    const destination = path.resolve(options.destinationDirectory);
    const inventory = await readInventory(options, cleanup);
    const { catalogue, rawCatalogue, assetRoot, files, missingPreviews } = inventory;
    let store: PrivateHubStore | undefined;
    let receipt: PrivateHubConversionReceipt | undefined;
    try {
      failureStage = 'destination-unavailable';
      const destinationParent = await snapshotDirectory(path.dirname(destination));
      if (!destinationParent.stats) { throw new Error('The destination parent directory must exist.'); }
      if (nested(assetRoot, destination) || nested(destination, assetRoot) || nested(destination, catalogue.filePath)) {
        throw new Error('The new private hub must be separate from the source catalogue and preview tree.');
      }
      progress(options, 'scanning', 0, inventory.videos * PREVIEW_LAYOUT.length);
      failureStage = 'source-inspection-failed';
      if (reviewProof && reviewProof.fingerprint !== inventoryFingerprint(inventory)) {
        throw privateConversionFailureAtStage(new Error('The conversion source changed after review. Review it again before converting.'), 'source-changed');
      }
      if (missingPreviews.length && options.allowMissingPreviews !== true) {
        throw new Error('Expected previews are missing. Conversion requires an explicit decision to preserve their missing state.');
      }
      failureStage = 'source-changed';
      await assertInventoryUnchanged(inventory, options, true, cleanup);
      guard(options);
      failureStage = 'storage-initialization-failed';
      store = await PrivateHubStore.create(destination, options.password);
      options = { ...options, password: '', signal: options.signal ? AbortSignal.any([options.signal, store.lockSignal]) : store.lockSignal };
      guard(options);
      failureStage = 'catalogue-encryption-failed';
      await store.writeRecord('catalogue', rawCatalogue);
      receipt = {
        format: 'theatrum-private-hub-conversion', version: 1, state: 'complete',
        catalogueSha256: createHash('sha256').update(rawCatalogue).digest('hex'),
        catalogueByteLength: rawCatalogue.length,
        previews: [], missingPreviews,
      };
      rawCatalogue.fill(0);
      failureStage = 'preview-copy-failed';
      progress(options, 'copying', 0, files.length);
      for (const source of files) {
        guard(options);
        const digest = createHash('sha256');
        if (source.kind === 'clip') {
          async function* chunks(): AsyncGenerator<Buffer> {
            for await (const bytes of sourceChunks(source.file, options, cleanup)) {
              digest.update(bytes);
              yield bytes;
            }
          }
          const sourceIterator = chunks();
          try { await writePrivateHubMedia(store, privateHubClipMediaId(source.hash), sourceIterator); }
          finally {
            // The media writer requests producer return without awaiting it on
            // failure. This owner must confirm that return before restoring work.
            await cleanup.closeIterator(sourceIterator);
            cleanup.assertConfirmed();
          }
        } else {
          const bytes = await sourceBytes(source.file, options, cleanup);
          try {
            digest.update(bytes);
            await writePrivateHubPreview(store, source.kind, source.hash, bytes);
          } finally { bytes.fill(0); }
        }
        receipt.previews.push({ kind: source.kind, hash: source.hash, byteLength: source.file.stats.size, sha256: digest.digest('hex') });
        progress(options, 'copying', receipt.previews.length, files.length);
      }
      guard(options);
      failureStage = 'verification-failed';
      await verifyConvertedContent(store, receipt, () => guard(options), completed => progress(options, 'verifying', completed, files.length + 1), cleanup);
      // Recheck every source, including absence and directory identity, immediately
      // before publishing the encrypted completion receipt. The caller's writer
      // exclusion must remain in effect until this function returns.
      failureStage = 'source-changed';
      await assertInventoryUnchanged(inventory, options, false, cleanup);
      failureStage = 'receipt-failed';
      const encodedReceipt = Buffer.from(JSON.stringify(receipt), 'utf8');
      try {
        if (encodedReceipt.length > MAX_RECEIPT_BYTES) { throw new Error('The conversion receipt exceeds its size limit.'); }
        guard(options);
        await store.writeRecord(RECEIPT_RECORD, encodedReceipt);
      } finally { encodedReceipt.fill(0); }
    } finally {
      inventory.dispose();
      try { if (store) { await cleanup.confirm(() => store!.lock(), STORE_DRAIN_TIMEOUT_MS); } }
      finally { cleanup.assertConfirmed(); }
    }
    progress(options, 'complete', receipt!.previews.length + 1, receipt!.previews.length + 1);
    return receipt!;
  } catch (error) {
    // Never replace cancellation or cleanup failures: their exact identity controls admission.
    if ((options.signal?.aborted && error === options.signal.reason) || isPrivateHubConversionCleanupFailure(error)) { throw error; }
    throw privateConversionFailureAtStage(error, failureStage);
  }
}

function validIdentity(value: unknown): value is { kind: PrivateHubPreviewKind; hash: string } {
  if (!value || typeof value !== 'object') { return false; }
  const item = value as Record<string, unknown>;
  return PREVIEW_LAYOUT.some(layout => layout.kind === item.kind)
    && typeof item.hash === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(item.hash);
}

/** An app must require a valid completed receipt before offering a converted hub. */
export async function readPrivateHubConversionReceipt(store: PrivateHubStore): Promise<PrivateHubConversionReceipt> {
  const bytes = await store.readRecord(RECEIPT_RECORD, MAX_RECEIPT_BYTES);
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object') { throw new Error('Invalid conversion receipt.'); }
    const receipt = value as PrivateHubConversionReceipt;
    if (receipt.format !== 'theatrum-private-hub-conversion' || receipt.version !== 1 || receipt.state !== 'complete'
      || typeof receipt.catalogueSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.catalogueSha256)
      || !Number.isSafeInteger(receipt.catalogueByteLength) || receipt.catalogueByteLength < 1 || receipt.catalogueByteLength > CATALOGUE_FILE_MAX_BYTES
      || !Array.isArray(receipt.previews) || !Array.isArray(receipt.missingPreviews)
      || receipt.previews.length + receipt.missingPreviews.length > MAX_PREVIEWS) {
      throw new Error('Invalid or incomplete private hub conversion receipt.');
    }
    const identities = new Set<string>();
    for (const item of [...receipt.previews, ...receipt.missingPreviews]) {
      if (!validIdentity(item) || identities.has(item.kind + ':' + item.hash)) { throw new Error('Invalid conversion preview inventory.'); }
      identities.add(item.kind + ':' + item.hash);
    }
    for (const item of receipt.previews) {
      if (!Number.isSafeInteger(item.byteLength) || item.byteLength < 0
        || item.byteLength > (item.kind === 'clip' ? MAX_CLIP_BYTES : MAX_IMAGE_BYTES)
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
        throw new Error('Invalid conversion preview digest.');
      }
    }
    if (store.locked) { throw new Error('The private hub is locked.'); }
    return receipt;
  } finally { bytes.fill(0); }
}

async function verifyConvertedContent(
  store: PrivateHubStore,
  receipt: PrivateHubConversionReceipt,
  assertCurrent: () => void,
  onVerified: (count: number) => void,
  cleanup = new ConversionCleanup(),
): Promise<void> {
  assertCurrent();
  onVerified(0);
  const catalogue = await store.readRecord('catalogue', receipt.catalogueByteLength);
  try {
    const parsed = parseVhaJson(catalogue);
    if (catalogue.length !== receipt.catalogueByteLength || createHash('sha256').update(catalogue).digest('hex') !== receipt.catalogueSha256) {
      throw new Error('The converted catalogue failed verification.');
    }
    const hashes = new Set(parsed.images.map(image => image.hash));
    if (hashes.size * PREVIEW_LAYOUT.length > MAX_PREVIEWS
      || [...hashes].some(hash => typeof hash !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(hash))) {
      throw new Error('Invalid converted catalogue preview identities.');
    }
    const inventory = [...receipt.previews, ...receipt.missingPreviews];
    if (inventory.some(item => !hashes.has(item.hash))) {
      throw new Error('The conversion inventory contains an unrelated preview.');
    }
    const present = new Set(inventory.map(item => item.kind + ':' + item.hash));
    for (const hash of hashes) {
      for (const layout of PREVIEW_LAYOUT) {
        const required = layout.kind === 'thumbnail' || layout.kind === 'filmstrip' || parsed.screenshotSettings.clipSnippets > 0;
        if (required && !present.has(layout.kind + ':' + hash)) {
          throw new Error('The conversion inventory omits an expected preview.');
        }
      }
    }
  } finally { catalogue.fill(0); }
  onVerified(1);
  let completed = 1;
  for (const preview of receipt.previews) {
    assertCurrent();
    const digest = createHash('sha256');
    let byteLength = 0;
    if (preview.kind === 'clip') {
      const reader = await openPrivateHubMedia(store, privateHubClipMediaId(preview.hash));
      if (reader.byteLength !== preview.byteLength) { throw new Error('A converted clip has an unexpected size.'); }
      const iterator = reader.readRange();
      let done = false;
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) { done = true; break; }
          const bytes = next.value;
          try { assertCurrent(); byteLength += bytes.length; digest.update(bytes); } finally { bytes.fill(0); }
        }
      } finally {
        if (!done) { await cleanup.closeIterator(iterator); }
        cleanup.assertConfirmed();
      }
    } else {
      const bytes = await readPrivateHubPreview(store, preview.kind, preview.hash, preview.byteLength);
      try { byteLength = bytes.length; digest.update(bytes); } finally { bytes.fill(0); }
    }
    if (byteLength !== preview.byteLength || digest.digest('hex') !== preview.sha256) {
      throw new Error('A converted preview failed verification.');
    }
    onVerified(++completed);
  }
  assertCurrent();
}

/** Reauthenticate the completion receipt and every referenced record after reopening. */
export async function verifyPrivateHubConversion(store: PrivateHubStore): Promise<PrivateHubConversionReceipt> {
  const receipt = await readPrivateHubConversionReceipt(store);
  await verifyConvertedContent(store, receipt, () => {
    if (store.locked) { throw new Error('The private hub is locked.'); }
  }, () => undefined);
  if (store.locked) { throw new Error('The private hub is locked.'); }
  return receipt;
}
