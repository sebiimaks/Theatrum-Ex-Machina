import { createHash } from 'node:crypto';
import type { ImageElement } from '../interfaces/final-object.interface';
import { validateAndNormalizeNewTagPath } from '../interfaces/tag-hierarchy';

export const PRIVATE_VIDEO_NOTES_MAX_LENGTH = 65_536;
export const PRIVATE_VIDEO_TAGS_MAX_COUNT = 128;
export const PRIVATE_VIDEO_TAG_MAX_LENGTH = 512;

export interface PrivateVideoMetadataUpdate {
  index: number;
  revision: string;
  notes: string;
  tags: string[];
}
export type PrivateVideoMetadataResult = { status: 'saved'; image: ImageElement }
  | { status: 'conflict' | 'invalid' | 'busy' };

/** Internal optimistic revision only. Never send this digest or the raw row to a renderer. */
export function privateVideoRevision(image: ImageElement): string {
  return createHash('sha256').update(JSON.stringify(image)).digest('hex');
}

function validTags(tags: unknown): tags is string[] {
  if (!Array.isArray(tags) || tags.length > PRIVATE_VIDEO_TAGS_MAX_COUNT) { return false; }
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length > PRIVATE_VIDEO_TAG_MAX_LENGTH) { return false; }
  }
  return true;
}

/** Truncated or malformed existing metadata must not be silently replaced by its displayed subset. */
export function privateVideoMetadataEditable(image: ImageElement): boolean {
  return !!image && typeof image === 'object' && !Array.isArray(image) && !image.deleted && image.cleanName !== '*FOLDER*'
    && (image.notes === undefined || (typeof image.notes === 'string' && image.notes.length <= PRIVATE_VIDEO_NOTES_MAX_LENGTH))
    && (image.tags === undefined || validTags(image.tags));
}

/** Validate a bounded request and detach mutable caller arrays before queue admission. */
export function snapshotPrivateVideoMetadataUpdate(value: unknown): PrivateVideoMetadataUpdate | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'index,notes,revision,tags') { return; }
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) { return; }
    const index = fields.index.value;
    const revision = fields.revision.value;
    const notes = fields.notes.value;
    const tags = fields.tags.value;
    if (!Number.isSafeInteger(index) || index < 0 || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)
      || typeof notes !== 'string' || notes.length > PRIVATE_VIDEO_NOTES_MAX_LENGTH || !validTags(tags)) { return; }
    return { index, revision, notes, tags: [...tags] };
  } catch { return; }
}

/** Preserve stored legacy values; only newly introduced tags use current creation rules. */
export function applyPrivateVideoMetadata(image: ImageElement, update: PrivateVideoMetadataUpdate): ImageElement | undefined {
  if (!privateVideoMetadataEditable(image)) { return; }
  const existing = image.tags ?? [];
  const unchanged = existing.length === update.tags.length && existing.every((tag, index) => tag === update.tags[index]);
  let tags: string[];
  if (unchanged) {
    // A notes-only edit must preserve even old duplicate/noncanonical tags.
    tags = [...existing];
  } else {
    const previous = new Set(existing);
    const seen = new Set<string>();
    tags = [];
    for (const candidate of update.tags) {
      const validation = previous.has(candidate) ? undefined : validateAndNormalizeNewTagPath(candidate);
      if (validation && !validation.valid) { return; }
      const tag = validation ? validation.normalized! : candidate;
      if (seen.has(tag)) { return; }
      seen.add(tag);
      tags.push(tag);
    }
  }
  const edited = { ...image };
  // An unchanged empty field retains its original optional representation.
  if (image.notes !== undefined || update.notes !== '') { edited.notes = update.notes; }
  if (image.tags !== undefined || tags.length > 0) { edited.tags = tags; }
  return edited;
}
