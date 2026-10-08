import { createHash, randomBytes } from 'node:crypto';
import type { PrivateHubStore } from './private-hub-store';

export interface PrivateThumbnailOverride {
  readonly format: 'theatrum-private-thumbnail';
  readonly version: 1;
  readonly hash: string;
  readonly baseGeneration: string;
  readonly generation: string;
  readonly width: number;
  readonly height: number;
}
const MAX_BYTES = 1024;
function invalid(): Error { return new Error('The private thumbnail is unavailable.'); }
function namespace(hash: string): string {
  if (typeof hash !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(hash)) { throw invalid(); }
  return createHash('sha256').update('theatrum-private-thumbnail-v1\0').update(hash).digest('hex');
}
function validate(value: unknown, hash: string): PrivateThumbnailOverride {
  namespace(hash);
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw invalid(); }
  const thumbnail = value as PrivateThumbnailOverride;
  if (Object.keys(thumbnail).sort().join(',') !== 'baseGeneration,format,generation,hash,height,version,width'
    || thumbnail.format !== 'theatrum-private-thumbnail' || thumbnail.version !== 1 || thumbnail.hash !== hash
    || typeof thumbnail.baseGeneration !== 'string' || !/^(?:legacy|[a-f0-9]{48})$/.test(thumbnail.baseGeneration)
    || typeof thumbnail.generation !== 'string' || !/^[a-f0-9]{48}$/.test(thumbnail.generation)
    || ![144, 216, 288, 360, 432, 504].includes(thumbnail.height) || thumbnail.width !== thumbnail.height * 16 / 9) { throw invalid(); }
  return Object.freeze({ ...thumbnail });
}
export function createPrivateThumbnailOverride(hash: string, baseGeneration: string, height: number): PrivateThumbnailOverride {
  return validate({ format: 'theatrum-private-thumbnail', version: 1, hash, baseGeneration,
    generation: randomBytes(24).toString('hex'), width: height * 16 / 9, height }, hash);
}
export function privateThumbnailOverrideRecordId(hash: string): string { return `thumbnail-override:${namespace(hash)}`; }
export function privateThumbnailOverrideMemberId(value: PrivateThumbnailOverride): string {
  const thumbnail = validate(value, value.hash);
  return `thumbnail-member:${namespace(thumbnail.hash)}:${thumbnail.generation}`;
}
/** Even a stale override must authenticate; absence must not hide a surviving backup. */
export async function readPrivateThumbnailOverride(store: PrivateHubStore, hash: string): Promise<PrivateThumbnailOverride | undefined> {
  let bytes: Buffer;
  try { bytes = await store.readRecord(privateThumbnailOverrideRecordId(hash), MAX_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      let backup: Buffer;
      try { backup = await store.readBackupRecord(privateThumbnailOverrideRecordId(hash), MAX_BYTES); }
      catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code === 'ENOENT' && !store.locked) { return undefined; }
        throw invalid();
      }
      backup.fill(0);
    }
    throw invalid();
  }
  try {
    const thumbnail = validate(JSON.parse(bytes.toString('utf8')), hash);
    if (store.locked) { throw invalid(); }
    return thumbnail;
  } catch { throw invalid(); }
  finally { bytes.fill(0); }
}
export async function publishPrivateThumbnailOverride(store: PrivateHubStore, value: PrivateThumbnailOverride, isCurrent: () => boolean): Promise<void> {
  const thumbnail = validate(value, value.hash);
  if (typeof isCurrent !== 'function') { throw invalid(); }
  const bytes = Buffer.from(JSON.stringify(thumbnail));
  try { await store.writeRecord(privateThumbnailOverrideRecordId(thumbnail.hash), bytes, isCurrent); }
  finally { bytes.fill(0); }
}
