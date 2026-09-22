import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { PRIVATE_HUB_MAX_IMAGE_BYTES, type PrivateHubPreviewKind } from './private-hub-catalogue';
import { openPrivateHubMedia, privateHubMediaManifestRecordId, PRIVATE_HUB_MEDIA_CHUNK_BYTES,
  PRIVATE_HUB_MEDIA_MAX_BYTES, PRIVATE_HUB_MEDIA_MAX_MANIFEST_BYTES } from './private-hub-media';
import { readPrivatePreviewSet, privatePreviewSetMemberId, type PrivatePreviewSet } from './private-hub-preview-set';
import type { PrivateHubStore } from './private-hub-store';
import { CATALOGUE_FILE_MAX_BYTES, parseVhaJson } from './vha-file-persistence';

export interface PrivateHubPlaintextExportProgress {
  stage: 'copying' | 'verifying' | 'complete';
  completed: number;
  total: number;
}
export interface PrivateHubPlaintextExportOptions {
  destinationDirectory: string;
  /** Main must own reauthentication and exclude every source writer until this work drains. */
  assertSourceQuiescent: () => void;
  signal?: AbortSignal;
  /** Counts only; filenames and private metadata never appear in progress. */
  onProgress?: (counts: PrivateHubPlaintextExportProgress) => void;
}
interface Snapshot { filePath: string; stats: Stats; }
interface SourceRecord { id: string; maximum: number; digest?: string; }
interface Output { file: Snapshot; digest: string; }
const MAX_PREVIEWS = 100_000;
const CLEANUP_TIMEOUT_MS = 5000;
const cleanupFailures = new WeakSet<object>();
const LAYOUT: { kind: PrivateHubPreviewKind; directory: string; extension: string }[] = [
  { kind: 'thumbnail', directory: 'thumbnails', extension: '.jpg' },
  { kind: 'filmstrip', directory: 'filmstrips', extension: '.jpg' },
  { kind: 'clip-poster', directory: 'clips', extension: '.jpg' },
  { kind: 'clip', directory: 'clips', extension: '.mp4' },
];
function unavailable(): Error { return new Error('The unencrypted hub copy could not be completed.'); }
function cleanupFailure(): Error {
  const error = new Error('The unencrypted hub copy cleanup could not be confirmed.');
  cleanupFailures.add(error);
  return error;
}
/** Main must quarantine normal-mode restoration when an owned descriptor or iterator did not drain. */
export function isPrivateHubPlaintextExportCleanupFailure(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && cleanupFailures.has(error);
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a: Stats, b: Stats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function nested(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
async function confirmedCleanup(work: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(work), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(cleanupFailure()), CLEANUP_TIMEOUT_MS);
    })]);
  } catch { throw cleanupFailure(); }
  finally { if (timer) { clearTimeout(timer); } }
}

/**
 * Make a separately chosen ordinary hub. The encrypted source remains intact.
 * Every output is deliberately plaintext in that new destination; an interrupted
 * copy may retain partial files there. This does not promise rollback or erasure.
 */
export async function exportPrivateHubToPlaintext(
  store: PrivateHubStore, supplied: PrivateHubPlaintextExportOptions,
): Promise<{ previewCount: number; byteLength: number }> {
  const { destinationDirectory, assertSourceQuiescent, signal, onProgress } = supplied;
  if (typeof destinationDirectory !== 'string' || !path.isAbsolute(destinationDirectory)
    || typeof assertSourceQuiescent !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))
    || (onProgress !== undefined && typeof onProgress !== 'function')) { throw unavailable(); }
  const destination = path.resolve(destinationDirectory);
  if (nested(store.directory, destination) || nested(destination, store.directory)) { throw unavailable(); }
  let revoked = false;
  const guard = (): void => {
    if (revoked || store.locked || signal?.aborted) { revoked = true; throw unavailable(); }
    try {
      const result: unknown = assertSourceQuiescent();
      if (result !== undefined) {
        if (result && typeof (result as Promise<unknown>).then === 'function') { void Promise.resolve(result).catch(() => undefined); }
        throw unavailable();
      }
      if (store.locked || signal?.aborted) { throw unavailable(); }
    } catch { revoked = true; throw unavailable(); }
  };
  const progress = (stage: PrivateHubPlaintextExportProgress['stage'], completed: number, total: number): void => {
    guard();
    let result: unknown;
    try { result = onProgress?.({ stage, completed, total }); } catch { /* The following authority check is decisive. */ }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
      revoked = true;
      throw unavailable();
    }
    guard();
  };
  const buffers = new Set<Buffer>();
  const own = (bytes: Buffer): Buffer => { buffers.add(bytes); return bytes; };
  const release = (bytes?: Buffer): void => { if (bytes) { bytes.fill(0); buffers.delete(bytes); } };
  const wipe = (): void => { revoked = true; for (const bytes of buffers) { bytes.fill(0); } };
  signal?.addEventListener('abort', wipe, { once: true });
  store.lockSignal.addEventListener('abort', wipe, { once: true });
  const directories: Snapshot[] = [];
  const sourceRecords: SourceRecord[] = [];
  const previewSets = new Map<string, PrivatePreviewSet | undefined>();
  const outputs: Output[] = [];
  let previewCount = 0;
  let byteLength = 0;
  const directory = async (filePath: string): Promise<Snapshot> => {
    guard();
    const stats = await fs.lstat(filePath);
    if (!stats.isDirectory() || stats.isSymbolicLink() || await fs.realpath(filePath) !== filePath) { throw unavailable(); }
    guard();
    return { filePath, stats };
  };
  const checkDirectories = async (): Promise<void> => {
    for (const saved of directories) {
      const current = await directory(saved.filePath);
      if (!sameFile(saved.stats, current.stats)) { throw unavailable(); }
    }
    guard();
  };
  const regular = async (filePath: string, maximum: number): Promise<Snapshot> => {
    guard();
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !Number.isSafeInteger(stats.size)
      || stats.size < 0 || stats.size > maximum || await fs.realpath(filePath) !== filePath) { throw unavailable(); }
    guard();
    return { filePath, stats };
  };
  const readRecord = async (id: string, maximum: number, optional: boolean): Promise<Buffer | undefined> => {
    guard();
    let bytes: Buffer | undefined;
    try { bytes = own(await store.readRecord(id, maximum)); guard(); return bytes; }
    catch (error) {
      release(bytes);
      if (!optional || !missing(error)) { throw error; }
      // A surviving backup is damage/recovery state, never an absent preview.
      let backup: Buffer | undefined;
      try { backup = own(await store.readBackupRecord(id, maximum)); guard(); }
      catch (backupError) { if (missing(backupError)) { guard(); return undefined; } throw backupError; }
      finally { release(backup); }
      throw unavailable();
    }
  };
  const copy = async (filePath: string, source: AsyncIterableIterator<Buffer>, maximum: number, expected?: number): Promise<Output> => {
    let handle: FileHandle | undefined;
    let sourceDone = false;
    let count = 0;
    const hash = createHash('sha256');
    let output: Output | undefined;
    let failure: unknown;
    let cleanupFailed = false;
    try {
      await checkDirectories();
      handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      guard();
      const initial = await handle.stat();
      if (!initial.isFile() || initial.nlink !== 1) { throw unavailable(); }
      while (true) {
        guard();
        const next = await source.next();
        if (next.done) { sourceDone = true; guard(); break; }
        if (!Buffer.isBuffer(next.value)) { throw unavailable(); }
        const bytes = own(next.value);
        try {
          guard();
          if (bytes.length > maximum - count) { throw unavailable(); }
          hash.update(bytes);
          let written = 0;
          while (written < bytes.length) {
            guard();
            const result = await handle.write(bytes, written, bytes.length - written, count + written);
            if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.length - written) { throw unavailable(); }
            written += result.bytesWritten;
          }
          count += bytes.length;
        } finally { release(bytes); }
      }
      if (expected !== undefined && count !== expected) { throw unavailable(); }
      guard();
      await handle.sync();
      const completed = await handle.stat();
      if (!sameFile(initial, completed) || !completed.isFile() || completed.nlink !== 1 || completed.size !== count) { throw unavailable(); }
      await checkDirectories();
      const file = await regular(filePath, maximum);
      if (!unchanged(completed, file.stats)) { throw unavailable(); }
      guard();
      output = { file, digest: hash.digest('hex') };
    } catch (error) { failure = error; }
    finally {
      if (!sourceDone) {
        try {
          await confirmedCleanup(async () => {
            if (typeof source.return !== 'function' || (await source.return()).done !== true) { throw unavailable(); }
          });
        } catch { cleanupFailed = true; }
      }
      if (handle) {
        try { await confirmedCleanup(() => handle!.close()); } catch { cleanupFailed = true; }
      }
    }
    if (cleanupFailed) { throw cleanupFailure(); }
    if (failure) { throw failure; }
    if (!output) { throw unavailable(); }
    return output;
  };
  const verify = async (output: Output): Promise<void> => {
    await checkDirectories();
    const current = await regular(output.file.filePath, output.file.stats.size);
    if (!unchanged(current.stats, output.file.stats)) { throw unavailable(); }
    const handle = await fs.open(current.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const bytes = own(Buffer.alloc(PRIVATE_HUB_MEDIA_CHUNK_BYTES));
    try {
      if (!unchanged(current.stats, await handle.stat())) { throw unavailable(); }
      const hash = createHash('sha256');
      let offset = 0;
      while (offset < current.stats.size) {
        guard();
        const result = await handle.read(bytes, 0, Math.min(bytes.length, current.stats.size - offset), offset);
        guard();
        if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > Math.min(bytes.length, current.stats.size - offset)) { throw unavailable(); }
        hash.update(bytes.subarray(0, result.bytesRead));
        offset += result.bytesRead;
        bytes.fill(0);
      }
      const after = await regular(current.filePath, current.stats.size);
      if (!unchanged(current.stats, after.stats) || !unchanged(current.stats, await handle.stat()) || hash.digest('hex') !== output.digest) { throw unavailable(); }
      await checkDirectories();
    } finally { release(bytes); await confirmedCleanup(() => handle.close()); }
  };
  const single = (bytes: Buffer): AsyncIterableIterator<Buffer> => {
    let remaining: Buffer | undefined = bytes;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() { const value = remaining; remaining = undefined; return value ? { done: false, value } : { done: true, value: undefined }; },
      async return() { release(remaining); remaining = undefined; return { done: true, value: undefined }; },
    };
  };
  const syncDirectory = async (saved: Snapshot): Promise<void> => {
    if (process.platform === 'win32') { return; }
    await checkDirectories();
    const handle = await fs.open(saved.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (!sameFile(saved.stats, await handle.stat())) { throw unavailable(); }
      guard(); await handle.sync(); guard();
    } finally { await confirmedCleanup(() => handle.close()); }
  };
  try {
    guard();
    directories.push(await directory(path.dirname(destination)));
    // Ordinary store reads may complete an interrupted hard-link publication.
    // Refuse such recovery state so this export does not mutate its source.
    await directory(store.directory);
    const entries = await fs.opendir(store.directory);
    try {
      while (true) {
        guard();
        const entry = await entries.read();
        if (!entry) { break; }
        const stats = await fs.lstat(path.join(store.directory, entry.name));
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) { throw unavailable(); }
      }
    } finally { await confirmedCleanup(() => entries.close()); }
    guard();
    const raw = own(await store.readRecord('catalogue', CATALOGUE_FILE_MAX_BYTES));
    guard();
    if (raw.length > CATALOGUE_FILE_MAX_BYTES) { throw unavailable(); }
    const catalogueDigest = digest(raw);
    const catalogueBytes = raw.length;
    const parsed = parseVhaJson(raw);
    const hashes = [...new Set(parsed.images.map(image => image.hash))];
    if (hashes.length * LAYOUT.length > MAX_PREVIEWS || hashes.some(hash => typeof hash !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(hash))) { throw unavailable(); }
    await checkDirectories();
    await fs.mkdir(destination, { mode: 0o700 });
    directories.push(await directory(destination));
    await checkDirectories();
    const assetRoot = path.join(destination, 'vha-' + parsed.hubName);
    for (const filePath of [assetRoot, ...new Set(LAYOUT.map(layout => path.join(assetRoot, layout.directory)))]) {
      await checkDirectories();
      await fs.mkdir(filePath, { mode: 0o700 });
      directories.push(await directory(filePath));
    }
    const total = hashes.length * LAYOUT.length;
    progress('copying', 0, total);
    let completed = 0;
    for (const hash of hashes) {
      guard();
      const set = await readPrivatePreviewSet(store, hash);
      guard();
      previewSets.set(hash, set);
      for (const layout of LAYOUT) {
        guard();
        if (set && !set.clip && (layout.kind === 'clip' || layout.kind === 'clip-poster')) {
          progress('copying', ++completed, total); continue;
        }
        const id = set ? privatePreviewSetMemberId(set, layout.kind) : `preview:${layout.kind}:${hash}`;
        const recordId = layout.kind === 'clip' ? privateHubMediaManifestRecordId(id) : id;
        const maximum = layout.kind === 'clip' ? PRIVATE_HUB_MEDIA_MAX_MANIFEST_BYTES : PRIVATE_HUB_MAX_IMAGE_BYTES;
        const bytes = await readRecord(recordId, maximum, !set);
        try {
          sourceRecords.push({ id: recordId, maximum, digest: bytes ? digest(bytes) : undefined });
          if (bytes) {
            const target = path.join(assetRoot, layout.directory, hash + layout.extension);
            let output: Output;
            if (layout.kind === 'clip') {
              const reader = await openPrivateHubMedia(store, id);
              guard();
              if (!Number.isSafeInteger(reader.byteLength) || reader.byteLength < 0 || reader.byteLength > PRIVATE_HUB_MEDIA_MAX_BYTES) { throw unavailable(); }
              output = await copy(target, reader.readRange(), PRIVATE_HUB_MEDIA_MAX_BYTES, reader.byteLength);
            } else { output = await copy(target, single(bytes), PRIVATE_HUB_MAX_IMAGE_BYTES, bytes.length); }
            await verify(output);
            outputs.push(output);
            previewCount++;
            byteLength += output.file.stats.size;
          }
        } finally { release(bytes); }
        progress('copying', ++completed, total);
      }
    }
    progress('verifying', 0, outputs.length);
    for (const [index, output] of outputs.entries()) {
      await verify(output);
      progress('verifying', index + 1, outputs.length);
    }
    for (const saved of directories.slice(1).reverse()) { await syncDirectory(saved); }
    await checkDirectories();
    const cataloguePath = path.join(destination, parsed.hubName + '.scaena');
    const stagedPath = path.join(destination, '.catalogue-' + randomBytes(24).toString('hex') + '.pending');
    // single() transfers ownership and wipes raw after the bounded write.
    const staged = await copy(stagedPath, single(raw), CATALOGUE_FILE_MAX_BYTES, catalogueBytes);
    await verify(staged);
    // Recheck both present and absent identities. No input may quietly change
    // while a long copy is in progress, even when no preview bytes were copied.
    for (const [hash, set] of previewSets) {
      guard();
      const current = await readPrivatePreviewSet(store, hash);
      guard();
      if (JSON.stringify(current) !== JSON.stringify(set)) { throw unavailable(); }
    }
    for (const saved of sourceRecords) {
      const bytes = await readRecord(saved.id, saved.maximum, saved.digest === undefined);
      try { if ((bytes ? digest(bytes) : undefined) !== saved.digest) { throw unavailable(); } }
      finally { release(bytes); }
    }
    const currentCatalogue = own(await store.readRecord('catalogue', CATALOGUE_FILE_MAX_BYTES));
    try { guard(); if (currentCatalogue.length !== catalogueBytes || digest(currentCatalogue) !== catalogueDigest) { throw unavailable(); } }
    finally { release(currentCatalogue); }
    await checkDirectories();
    guard();
    await fs.link(stagedPath, cataloguePath);
    // A cancellation after link admission can leave a complete ordinary hub;
    // never acknowledge success or delete it after losing authority.
    guard();
    await checkDirectories();
    const published = await fs.lstat(cataloguePath);
    const stagedNow = await fs.lstat(stagedPath);
    if (!sameFile(published, staged.file.stats) || !sameFile(stagedNow, staged.file.stats)
      || !published.isFile() || published.isSymbolicLink() || published.nlink !== 2
      || published.size !== catalogueBytes || published.mtimeMs !== staged.file.stats.mtimeMs) { throw unavailable(); }
    guard(); await fs.unlink(stagedPath); guard();
    const file = await regular(cataloguePath, catalogueBytes);
    if (!sameFile(file.stats, staged.file.stats)) { throw unavailable(); }
    await verify({ file, digest: catalogueDigest });
    await syncDirectory(directories[1]);
    guard();
    byteLength += catalogueBytes;
    progress('complete', previewCount, previewCount);
    guard();
    return { previewCount, byteLength };
  } catch (error) {
    throw isPrivateHubPlaintextExportCleanupFailure(error) ? error : unavailable();
  } finally {
    signal?.removeEventListener('abort', wipe);
    store.lockSignal.removeEventListener('abort', wipe);
    for (const bytes of buffers) { bytes.fill(0); }
    buffers.clear();
  }
}
