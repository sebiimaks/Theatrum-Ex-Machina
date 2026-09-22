import { createHash, randomBytes } from 'node:crypto';
import type { PrivateHubPreviewKind } from './private-hub-catalogue';
import type { PrivateHubStore } from './private-hub-store';

const KINDS: readonly PrivateHubPreviewKind[] = ['thumbnail', 'filmstrip', 'clip-poster', 'clip'];
const MAX_MANIFEST_BYTES = 1024;
export interface PrivatePreviewSet {
  readonly format: 'theatrum-private-preview-set';
  readonly version: 1;
  readonly hash: string;
  readonly generation: string;
  readonly width: number;
  readonly height: number;
  readonly screenCount: number;
  readonly clip: boolean;
}

function invalid(): Error { return new Error('The private preview set is unavailable.'); }
function namespace(hash: string): string {
  if (typeof hash !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(hash)) { throw invalid(); }
  return createHash('sha256').update('theatrum-private-preview-set-v1\0').update(hash).digest('hex');
}
function validate(value: unknown, hash: string): PrivatePreviewSet {
  namespace(hash);
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw invalid(); }
  const set = value as PrivatePreviewSet;
  if (Object.keys(set).sort().join(',') !== 'clip,format,generation,hash,height,screenCount,version,width'
    || set.format !== 'theatrum-private-preview-set' || set.version !== 1 || set.hash !== hash
    || typeof set.generation !== 'string' || !/^[a-f0-9]{48}$/.test(set.generation)
    || ![144, 216, 288, 360, 432, 504].includes(set.height) || set.width !== set.height * 16 / 9
    || !Number.isSafeInteger(set.screenCount) || set.screenCount < 1 || set.screenCount > 255 || set.width * set.screenCount > 65535
    || typeof set.clip !== 'boolean') { throw invalid(); }
  return Object.freeze({ ...set });
}

export function createPrivatePreviewSet(hash: string, width: number, height: number, screenCount: number, clip: boolean): PrivatePreviewSet {
  return validate({ format: 'theatrum-private-preview-set', version: 1, hash,
    generation: randomBytes(24).toString('hex'), width, height, screenCount, clip }, hash);
}

export function privatePreviewSetRecordId(hash: string): string { return `preview-set:${namespace(hash)}`; }

/** Identifiers are derived from a strict manifest; stored data cannot redirect a read. */
export function privatePreviewSetMemberId(set: PrivatePreviewSet, kind: PrivateHubPreviewKind): string {
  const checked = validate(set, set.hash);
  if (!KINDS.includes(kind) || (!checked.clip && (kind === 'clip' || kind === 'clip-poster'))) { throw invalid(); }
  return `preview-set-member:${namespace(checked.hash)}:${checked.generation}:${kind}`;
}

export async function readPrivatePreviewSet(store: PrivateHubStore, hash: string): Promise<PrivatePreviewSet | undefined> {
  let bytes: Buffer;
  try { bytes = await store.readRecord(privatePreviewSetRecordId(hash), MAX_MANIFEST_BYTES); }
  catch (error) {
    // Compatibility with the initial encrypted conversion format only. An
    // unauthentic/malformed manifest must never fall back to older previews.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      let backup: Buffer;
      try { backup = await store.readBackupRecord(privatePreviewSetRecordId(hash), MAX_MANIFEST_BYTES); }
      catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code === 'ENOENT' && !store.locked) { return undefined; }
        throw invalid();
      }
      backup.fill(0);
      throw invalid();
    }
    throw invalid();
  }
  try {
    const set = validate(JSON.parse(bytes.toString('utf8')), hash);
    if (store.locked) { throw invalid(); }
    return set;
  } catch { throw invalid(); }
  finally { bytes.fill(0); }
}

export async function resolvePrivatePreviewId(store: PrivateHubStore, hash: string, kind: PrivateHubPreviewKind): Promise<string> {
  namespace(hash);
  if (!KINDS.includes(kind)) { throw invalid(); }
  const set = await readPrivatePreviewSet(store, hash);
  if (store.locked) { throw invalid(); }
  return set ? privatePreviewSetMemberId(set, kind) : `preview:${kind}:${hash}`;
}

/** Publish only after every immutable member has been generated and verified. */
export async function publishPrivatePreviewSet(store: PrivateHubStore, set: PrivatePreviewSet, isCurrent: () => boolean): Promise<void> {
  const snapshot = validate(set, set.hash);
  if (typeof isCurrent !== 'function') { throw invalid(); }
  const bytes = Buffer.from(JSON.stringify(snapshot));
  try { await store.writeRecord(privatePreviewSetRecordId(snapshot.hash), bytes, isCurrent); }
  finally { bytes.fill(0); }
}
