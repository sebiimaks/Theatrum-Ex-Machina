import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { NewImageElement } from '../interfaces/final-object.interface';
import { privateVideoRevision } from './private-hub-metadata';
import { applyPrivatePlaybackHistory, snapshotPrivatePlaybackHistoryUpdate, type PrivatePlaybackHistoryUpdate } from './private-playback-history';

const image = { ...NewImageElement(), hash: 'synthetic-history', cleanName: 'Synthetic video', notes: 'Keep notes',
  tags: ['Keep tags'], extra: { future: ['preserved'] }, timesPlayed: 3, lastPlayed: 100 };
const update: PrivatePlaybackHistoryUpdate = { index: 0, revision: privateVideoRevision(image), playedAt: 1_791_072_000_000 };

test('a main-owned history update is detached and changes only the two metrics', () => {
  const input = { ...update };
  const snapshot = snapshotPrivatePlaybackHistoryUpdate(input)!;
  input.playedAt++;
  assert.deepEqual(snapshot, update);
  assert.deepEqual(applyPrivatePlaybackHistory(image, snapshot), { ...image, timesPlayed: 4, lastPlayed: update.playedAt });
  assert.equal(image.timesPlayed, 3);
});

test('absent legacy metrics start with one play and the main-owned timestamp', () => {
  const legacy = { ...image };
  delete (legacy as unknown as Record<string, unknown>).timesPlayed;
  delete (legacy as unknown as Record<string, unknown>).lastPlayed;
  assert.deepEqual(applyPrivatePlaybackHistory(legacy, update), { ...legacy, timesPlayed: 1, lastPlayed: update.playedAt });
});

test('history requests reject invalid scalar values and all extra or missing properties', () => {
  const invalid: unknown[] = [null, [], {}, 'request', { ...update, extra: 1 }, { index: 0, revision: update.revision },
    { ...update, [Symbol('extra')]: true }, Object.assign(Object.create({ future: true }), update)];
  for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) { invalid.push({ ...update, index }); }
  for (const revision of ['', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(65), 'a'.repeat(64) + '\n', null, 1]) { invalid.push({ ...update, revision }); }
  for (const playedAt of [0, -1, 0.5, NaN, Infinity, 8_640_000_000_000_001, '100', null]) { invalid.push({ ...update, playedAt }); }
  for (const value of invalid) { assert.equal(snapshotPrivatePlaybackHistoryUpdate(value), undefined); }
  assert.equal(snapshotPrivatePlaybackHistoryUpdate({ ...update, playedAt: 8_640_000_000_000_000 })?.playedAt, 8_640_000_000_000_000);
});

test('request getters and hidden fields are rejected without invoking accessors', () => {
  let getters = 0;
  for (const key of Object.keys(update)) {
    const accessor = Object.defineProperty({ ...update }, key, { enumerable: true, get: () => { getters++; return 1; } });
    const hidden = Object.defineProperty({ ...update }, key, { enumerable: false, value: 1 });
    assert.equal(snapshotPrivatePlaybackHistoryUpdate(accessor), undefined);
    assert.equal(snapshotPrivatePlaybackHistoryUpdate(hidden), undefined);
  }
  assert.equal(getters, 0);
});

test('malformed or overflowing existing counts are preserved by rejecting the update', () => {
  for (const timesPlayed of [null, -1, 0.5, NaN, Infinity, '3', {}, [], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const legacy = { ...image, timesPlayed };
    assert.equal(applyPrivatePlaybackHistory(legacy as typeof image, update), undefined);
    assert.equal(legacy.timesPlayed, timesPlayed);
  }
  assert.equal(applyPrivatePlaybackHistory({ ...image, timesPlayed: Number.MAX_SAFE_INTEGER - 1 }, update)?.timesPlayed,
    Number.MAX_SAFE_INTEGER);
});

test('malformed existing timestamps are not repaired by an automatic history update', () => {
  for (const lastPlayed of [null, -1, 0.5, NaN, Infinity, '100', {}, [], 8_640_000_000_000_001]) {
    const legacy = { ...image, lastPlayed };
    assert.equal(applyPrivatePlaybackHistory(legacy as typeof image, update), undefined);
    assert.equal(legacy.lastPlayed, lastPlayed);
  }
  assert.equal(applyPrivatePlaybackHistory({ ...image, lastPlayed: 8_640_000_000_000_000 }, update)?.lastPlayed, update.playedAt,
    'a valid earlier main clock timestamp remains the actual playback timestamp');
});

test('deleted rows and synthetic folders never gain playback history', () => {
  assert.equal(applyPrivatePlaybackHistory({ ...image, deleted: true }, update), undefined);
  assert.equal(applyPrivatePlaybackHistory({ ...image, cleanName: '*FOLDER*' }, update), undefined);
});
