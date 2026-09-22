import type { FinalObject } from '../interfaces/final-object.interface';
import type { PrivateHubStore } from './private-hub-store';
import { openPrivateHubMedia, writePrivateHubMedia } from './private-hub-media';
import { CATALOGUE_FILE_MAX_BYTES, parseVhaJson } from './vha-file-persistence';
import { resolvePrivatePreviewId } from './private-hub-preview-set';

/** Main-process storage adapter; deliberately not exposed through the renderer bridge yet. */
const CATALOGUE_RECORD = 'catalogue';
export const PRIVATE_HUB_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export type PrivateHubPreviewKind = 'thumbnail' | 'filmstrip' | 'clip-poster' | 'clip';
const PREVIEW_KINDS: readonly PrivateHubPreviewKind[] = ['thumbnail', 'filmstrip', 'clip-poster', 'clip'];

function previewRecordId(kind: PrivateHubPreviewKind, hash: string): string {
  if (!PREVIEW_KINDS.includes(kind) || typeof hash !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(hash)) {
    throw new Error('Invalid private hub preview identity.');
  }
  return `preview:${kind}:${hash}`;
}

export async function readPrivateHubCatalogue(store: PrivateHubStore): Promise<FinalObject> {
  const plaintext = await store.readRecord(CATALOGUE_RECORD);
  try {
    if (store.locked) { throw new Error('The private hub is locked.'); }
    if (plaintext.byteLength > CATALOGUE_FILE_MAX_BYTES) {
      throw new Error('The private catalogue exceeds the supported size.');
    }
    return parseVhaJson(plaintext);
  } finally {
    // The returned object and JavaScript's JSON string remain managed memory;
    // overwriting this owned buffer is not a guarantee of complete memory erasure.
    plaintext.fill(0);
  }
}

export async function writePrivateHubCatalogue(store: PrivateHubStore, catalogue: FinalObject): Promise<void> {
  const json = JSON.stringify(catalogue);
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > CATALOGUE_FILE_MAX_BYTES) {
    throw new Error('The private catalogue exceeds the supported size.');
  }
  // Preserve the existing catalogue validation and schema. No plaintext file is
  // written by this adapter, including when validation or persistence fails.
  parseVhaJson(json);
  const plaintext = Buffer.from(json, 'utf8');
  try {
    await store.writeRecord(CATALOGUE_RECORD, plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/** Caller owns the returned plaintext and must discard it when the hub locks. */
export function readPrivateHubPreview(
  store: PrivateHubStore,
  kind: PrivateHubPreviewKind,
  hash: string,
  maximumBytes = kind === 'clip' ? 256 * 1024 * 1024 : PRIVATE_HUB_MAX_IMAGE_BYTES,
): Promise<Buffer> {
  previewRecordId(kind, hash);
  return resolvePrivatePreviewId(store, hash, kind).then(recordId => kind === 'clip'
    ? readBufferedClip(store, recordId, maximumBytes)
    : store.readRecord(recordId, maximumBytes)).then(bytes => {
      if (store.locked) { bytes.fill(0); throw new Error('The private hub is locked.'); }
      return bytes;
    });
}

export function privateHubClipMediaId(hash: string): string {
  return previewRecordId('clip', hash);
}

/** Small-clip compatibility API; playback should use authenticated range reads. */
async function readBufferedClip(store: PrivateHubStore, mediaId: string, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 256 * 1024 * 1024) {
    throw new Error('Invalid buffered clip size limit. Use range reads for larger clips.');
  }
  const reader = await openPrivateHubMedia(store, mediaId);
  if (reader.byteLength > maximumBytes) { throw new Error('The clip exceeds the buffered read limit.'); }
  const result = Buffer.alloc(reader.byteLength);
  const erase = () => { result.fill(0); };
  store.lockSignal.addEventListener('abort', erase, { once: true });
  try {
    let offset = 0;
    for await (const bytes of reader.readRange()) {
      try {
        if (store.locked) { throw new Error('The private hub is locked.'); }
        bytes.copy(result, offset);
        offset += bytes.length;
      } finally { bytes.fill(0); }
    }
    if (store.locked) { throw new Error('The private hub is locked.'); }
    return result;
  } catch (error) {
    result.fill(0);
    throw error;
  } finally {
    store.lockSignal.removeEventListener('abort', erase);
  }
}

/** Preview generation must supply bytes directly rather than a plaintext disk path. */
export function writePrivateHubPreview(
  store: PrivateHubStore,
  kind: PrivateHubPreviewKind,
  hash: string,
  bytes: Buffer,
): Promise<void> {
  const recordId = previewRecordId(kind, hash);
  if (kind === 'clip') {
    if (!Buffer.isBuffer(bytes)) { return Promise.reject(new Error('Invalid private hub clip bytes.')); }
    const chunks = async function* (): AsyncGenerator<Buffer> { yield bytes; };
    return writePrivateHubMedia(store, recordId, chunks()).then(() => undefined);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length > PRIVATE_HUB_MAX_IMAGE_BYTES) {
    return Promise.reject(new Error('Invalid or oversized private hub image.'));
  }
  return store.writeRecord(recordId, bytes);
}
