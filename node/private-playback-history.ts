import type { ImageElement } from '../interfaces/final-object.interface';

const MAX_TIMESTAMP = 8_640_000_000_000_000;

export type PrivatePlaybackHistoryMetric = 'lastPlayed' | 'timesPlayed';
export type PrivatePlaybackHistoryResetResult = { status: 'reset'; count: number }
  | { status: 'unchanged' | 'cancelled' | 'busy' | 'invalid' };

/** Main-owned playback acknowledgement. Never accept these fields from a renderer. */
export interface PrivatePlaybackHistoryUpdate {
  index: number;
  revision: string;
  playedAt: number;
}
export type PrivatePlaybackHistoryResult = { status: 'recorded'; image: ImageElement }
  | { status: 'disabled' | 'conflict' | 'invalid' | 'busy' };

export function snapshotPrivatePlaybackHistoryUpdate(value: unknown): PrivatePlaybackHistoryUpdate | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { return; }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some(key => key !== 'index' && key !== 'revision' && key !== 'playedAt')) { return; }
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) { return; }
      fields[key] = property.value;
    }
    const { index, revision, playedAt } = fields;
    if (!Number.isSafeInteger(index) || (index as number) < 0 || typeof revision !== 'string'
      || revision.length !== 64 || !/^[a-f0-9]{64}$/.test(revision) || !Number.isSafeInteger(playedAt)
      || (playedAt as number) <= 0 || (playedAt as number) > MAX_TIMESTAMP) { return; }
    return { index: index as number, revision, playedAt: playedAt as number };
  } catch { return; }
}

/** Never repair malformed legacy metrics as a side effect of starting playback. */
export function applyPrivatePlaybackHistory(image: ImageElement, update: PrivatePlaybackHistoryUpdate): ImageElement | undefined {
  if (!image || typeof image !== 'object' || Array.isArray(image) || image.deleted || image.cleanName === '*FOLDER*') { return; }
  const count = image.timesPlayed === undefined ? 0 : image.timesPlayed;
  const lastPlayed = image.lastPlayed === undefined ? 0 : image.lastPlayed;
  if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(lastPlayed) || lastPlayed < 0 || lastPlayed > MAX_TIMESTAMP) { return; }
  return { ...image, timesPlayed: count + 1, lastPlayed: update.playedAt };
}
