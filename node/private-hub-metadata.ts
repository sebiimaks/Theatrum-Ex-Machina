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
  rating?: number;
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

/** Detach plain string entries without invoking caller accessors or iterators. */
export function snapshotPrivateVideoTags(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) { return; }
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > PRIVATE_VIDEO_TAGS_MAX_COUNT) { return; }
    if (Reflect.ownKeys(value).length !== length + 1) { return; }
    const tags: string[] = [];
    for (let index = 0; index < length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      if (!field || !field.enumerable || !Object.hasOwn(field, 'value')
        || typeof field.value !== 'string' || field.value.length > PRIVATE_VIDEO_TAG_MAX_LENGTH) { return; }
      tags.push(field.value);
    }
    return tags;
  } catch { return; }
}

/** Validate a bounded request and detach mutable caller arrays before queue admission. */
export function snapshotPrivateVideoMetadataUpdate(value: unknown): PrivateVideoMetadataUpdate | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { return; }
    const allowed = new Set(['index', 'revision', 'notes', 'tags', 'rating']);
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) { return; }
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) { return; }
      fields[key] = field.value;
    }
    const { index, revision, notes } = fields;
    const tags = snapshotPrivateVideoTags(fields.tags);
    if (!Number.isSafeInteger(index) || (index as number) < 0 || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)
      || typeof notes !== 'string' || notes.length > PRIVATE_VIDEO_NOTES_MAX_LENGTH || !tags) { return; }
    const ratingPresent = Object.hasOwn(fields, 'rating');
    const rating = fields.rating;
    if (ratingPresent && (!Number.isInteger(rating) || (rating as number) < 0 || (rating as number) > 5)) { return; }
    return { index: index as number, revision, notes, tags, ...(ratingPresent ? { rating: rating as number } : {}) };
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
  if (Object.hasOwn(update, 'rating')) { edited.stars = (update.rating! + 0.5) as ImageElement['stars']; }
  // An unchanged empty field retains its original optional representation.
  if (image.notes !== undefined || update.notes !== '') { edited.notes = update.notes; }
  if (image.tags !== undefined || tags.length > 0) { edited.tags = tags; }
  return edited;
}
