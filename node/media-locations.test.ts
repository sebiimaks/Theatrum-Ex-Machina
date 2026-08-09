import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NewImageElement } from '../interfaces/final-object.interface';
import type { ImageElement, ImageLocation } from '../interfaces/final-object.interface';
import {
  attachImageLocation,
  getImageLocations,
  hasUserManagedMetadata,
  imageElementAtLocation,
  markImageLocationsMissingInScope,
  normalizeImageElementLocations,
  normalizeImageLocation,
  planIgnoredSourceFolderRemoval,
  removeImageLocationsInScope,
  removeImageLocationsForSource,
  selectAvailableImageLocation,
  updatePreferredImageLocationFields,
} from '../interfaces/media-locations';

function video(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    ...NewImageElement(),
    cleanName: 'Original title',
    dateAdded: 1_700_000_000_000,
    fileName: 'video.mp4',
    hash: 'same-media',
    inputSource: 1,
    notes: 'Keep this note',
    partialPath: '/Camera/Canon',
    stars: 4.5,
    tags: ['camera'],
    timesPlayed: 7,
    ...overrides,
  };
}

function location(
  inputSource: number,
  partialPath: string,
  fileName = 'video.mp4',
  missing = false,
): ImageLocation {
  return {
    fileName,
    inputSource,
    ...(missing ? { missing: true } : {}),
    partialPath,
  };
}

function userMetadata(entry: ImageElement) {
  return {
    cleanName: entry.cleanName,
    dateAdded: entry.dateAdded,
    notes: entry.notes,
    stars: entry.stars,
    tags: entry.tags,
    timesPlayed: entry.timesPlayed,
  };
}

test('normalizes a legacy location and makes a modern location list authoritative', () => {
  const legacy = video({ partialPath: '\\Archive\\./Masters/' });
  assert.deepEqual(getImageLocations(legacy), [location(1, '/Archive/Masters')]);
  assert.equal(legacy.partialPath, '\\Archive\\./Masters/', 'enumeration does not mutate legacy data');

  const modern = video({
    fileName: 'stale.mp4',
    inputSource: 99,
    locations: [location(3, '/Live')],
    partialPath: '/Stale',
  });
  assert.deepEqual(getImageLocations(modern), [location(3, '/Live')]);
  assert.equal(normalizeImageElementLocations(modern), true);
  assert.equal(modern.inputSource, 3);
  assert.equal(modern.partialPath, '/Live');
});

test('attaches and deduplicates explicit locations without changing user metadata', () => {
  const entry = video();
  const metadataBefore = userMetadata(entry);

  assert.equal(attachImageLocation(entry, location(2, '/Library/Canon')), true);
  assert.deepEqual(getImageLocations(entry), [
    location(1, '/Camera/Canon'),
    location(2, '/Library/Canon'),
  ]);
  assert.equal(attachImageLocation(entry, location(2, '\\Library\\Canon')), false);
  assert.deepEqual(userMetadata(entry), metadataBefore);
  assert.equal(entry.hash, 'same-media');
});

test('an available attached location replaces a missing preferred mirror', () => {
  const entry = video({ missing: true });
  attachImageLocation(entry, location(2, '/Library/Canon'));

  assert.equal(entry.inputSource, 2);
  assert.equal(entry.partialPath, '/Library/Canon');
  assert.equal(entry.missing, undefined);
  assert.deepEqual(getImageLocations(entry), [
    location(2, '/Library/Canon'),
    location(1, '/Camera/Canon', 'video.mp4', true),
  ]);
});

test('scoped missing updates do not affect another source or a prefix sibling', () => {
  const entry = video({
    locations: [
      location(1, '/Camera/Canon'),
      location(1, '/Camerabag'),
      location(2, '/Backup'),
    ],
  });

  assert.equal(markImageLocationsMissingInScope(entry, 1, '/Camera', () => false), true);
  assert.deepEqual(getImageLocations(entry), [
    location(1, '/Camerabag'),
    location(1, '/Camera/Canon', 'video.mp4', true),
    location(2, '/Backup'),
  ]);
  assert.equal(entry.missing, undefined, 'another available association keeps the item online');

  assert.equal(markImageLocationsMissingInScope(entry, 1, '/Camera', () => true), true);
  assert.deepEqual(getImageLocations(entry), [
    location(1, '/Camerabag'),
    location(1, '/Camera/Canon'),
    location(2, '/Backup'),
  ]);
});

test('removing a preferred source promotes a survivor and preserves user metadata', () => {
  const entry = video({
    locations: [
      location(1, '/Camera/Canon'),
      location(2, '/Library/Canon'),
    ],
  });
  const metadataBefore = userMetadata(entry);

  assert.deepEqual(removeImageLocationsForSource(entry, 1), {
    changed: true,
    promoted: true,
    removedLocationCount: 1,
    survivingLocationCount: 1,
  });
  assert.equal(entry.inputSource, 2);
  assert.deepEqual(userMetadata(entry), metadataBefore);

  assert.deepEqual(removeImageLocationsForSource(entry, 2), {
    changed: true,
    promoted: false,
    removedLocationCount: 1,
    survivingLocationCount: 0,
  });
  assert.deepEqual(entry.locations, []);
  assert.equal(entry.missing, true);
  assert.deepEqual(userMetadata(entry), metadataBefore);
});

test('removes only source locations inside an exact subtree boundary', () => {
  const entry = video({
    locations: [
      location(1, '/Camera/Canon'),
      location(1, '/Camerabag'),
      location(2, '/Backup'),
    ],
  });
  const metadataBefore = userMetadata(entry);

  assert.deepEqual(removeImageLocationsInScope(entry, 1, '/Camera'), {
    changed: true,
    promoted: true,
    removedLocationCount: 1,
    survivingLocationCount: 2,
  });
  assert.deepEqual(getImageLocations(entry), [
    location(1, '/Camerabag'),
    location(2, '/Backup'),
  ]);
  assert.deepEqual(userMetadata(entry), metadataBefore);
  assert.throws(() => removeImageLocationsInScope(entry, 1, '/'), /root cannot be ignored/);
});

test('plans ignored-folder removal immutably and distinguishes retained metadata', () => {
  const shared = video({
    locations: [
      location(1, '/Camera/Canon'),
      location(2, '/Backup'),
    ],
  });
  const sole = video({
    cleanName: 'second',
    fileName: 'second.mp4',
    locations: [location(1, '/Camera/Nikon', 'second.mp4')],
    notes: 'Important',
    partialPath: '/Camera/Nikon',
  });
  const sibling = video({
    cleanName: 'third',
    fileName: 'third.mp4',
    locations: [location(1, '/Camerabag', 'third.mp4')],
    notes: undefined,
    partialPath: '/Camerabag',
    stars: 0.5,
    tags: undefined,
    timesPlayed: 0,
  });
  const originals = JSON.stringify([shared, sole, sibling]);

  const plan = planIgnoredSourceFolderRemoval([shared, sole, sibling], 1, '/Camera');

  assert.equal(JSON.stringify([shared, sole, sibling]), originals, 'planning never mutates live entries');
  assert.deepEqual({
    affectedEntryCount: plan.affectedEntryCount,
    affectedEntrySignatureCount: plan.affectedEntrySignatures.length,
    metadataAffectedEntryCount: plan.metadataAffectedEntryCount,
    metadataRemovedEntryCount: plan.metadataRemovedEntryCount,
    metadataRetainedSharedEntryCount: plan.metadataRetainedSharedEntryCount,
    removedEntryCount: plan.removedEntryCount,
    removedLocationCount: plan.removedLocationCount,
    retainedSharedEntryCount: plan.retainedSharedEntryCount,
  }, {
    affectedEntryCount: 2,
    affectedEntrySignatureCount: 2,
    metadataAffectedEntryCount: 2,
    metadataRemovedEntryCount: 1,
    metadataRetainedSharedEntryCount: 1,
    removedEntryCount: 1,
    removedLocationCount: 2,
    retainedSharedEntryCount: 1,
  });
  assert.equal(plan.nextElements.length, 2);
  assert.equal(plan.nextElements.includes(sibling), true, 'an untouched sibling retains identity');
  const retained = plan.nextElements.find((entry: ImageElement) => entry.hash === shared.hash);
  assert.ok(retained);
  assert.notEqual(retained, shared);
  assert.deepEqual(getImageLocations(retained), [location(2, '/Backup')]);
  assert.deepEqual(userMetadata(retained), userMetadata(shared));
});

test('detects meaningful user metadata without treating automatic import fields as user-managed', () => {
  const automatic = video({
    cleanName: 'video',
    notes: undefined,
    stars: 0.5,
    tags: ['import_error'],
    timesPlayed: 0,
  });
  assert.equal(hasUserManagedMetadata(automatic), false);
  assert.equal(hasUserManagedMetadata({ ...automatic, dateAdded: Date.now() }), false);
  assert.equal(hasUserManagedMetadata({ ...automatic, tags: ['import_error', 'camera'] }), true);
  assert.equal(hasUserManagedMetadata({ ...automatic, notes: 'Remember this' }), true);
  assert.equal(hasUserManagedMetadata({ ...automatic, lastPlayed: 1 }), true);
  assert.equal(hasUserManagedMetadata({ ...automatic, defaultScreen: 0 }), true);
});

test('an invalid later entry aborts an ignored-folder plan without partial mutation', () => {
  const valid = video();
  const malformed = video({ locations: [
    location(1, '/Camera'),
    { fileName: '../escape.mp4', inputSource: 1, partialPath: '/Camera' },
  ] });
  const before = JSON.stringify([valid, malformed]);

  assert.throws(
    () => planIgnoredSourceFolderRemoval([valid, malformed], 1, '/Camera'),
    /file name is invalid/,
  );
  assert.equal(JSON.stringify([valid, malformed]), before);
});

test('selects only a live location on an available source', () => {
  const entry = video({
    locations: [
      location(1, '/Primary'),
      location(2, '/Offline', 'video.mp4', true),
      location(3, '/Available'),
    ],
  });
  assert.deepEqual(
    selectAvailableImageLocation(entry, (sourceIndex: number) => sourceIndex === 3),
    location(3, '/Available'),
  );
  assert.equal(selectAvailableImageLocation(entry, () => false), undefined);
  assert.equal(entry.inputSource, 1, 'selection does not mutate the preferred location');
});

test('creates a shallow candidate only for an associated location', () => {
  const entry = video({
    locations: [
      location(1, '/Primary'),
      location(2, '/Backup', 'renamed.mp4'),
    ],
  });
  const candidate = imageElementAtLocation(entry, location(2, '/Backup', 'renamed.mp4'));

  assert.notEqual(candidate, entry);
  assert.equal(candidate.hash, entry.hash);
  assert.equal(candidate.fileName, 'renamed.mp4');
  assert.equal(candidate.inputSource, 2);
  assert.equal(candidate.partialPath, '/Backup');
  assert.deepEqual(userMetadata(candidate), userMetadata(entry));
  assert.throws(
    () => imageElementAtLocation(entry, location(4, '/Unknown')),
    /not associated/,
  );
});

test('keeps aliases aligned when the preferred file name is edited', () => {
  const entry = video({
    locations: [
      location(1, '/Camera/Canon'),
      location(2, '/Library/Camera/Canon'),
    ],
  });

  updatePreferredImageLocationFields(entry, { fileName: 'renamed.mp4' });

  assert.deepEqual(getImageLocations(entry), [
    location(1, '/Camera/Canon', 'renamed.mp4'),
    location(2, '/Library/Camera/Canon', 'renamed.mp4'),
  ]);
  assert.equal(entry.fileName, 'renamed.mp4');
  assert.equal(entry.notes, 'Keep this note');
});

test('malformed authoritative data fails closed without partial mutation', () => {
  const malformedArray = video();
  (malformedArray as unknown as { locations: unknown }).locations = 'not-an-array';
  const malformedArrayBefore = JSON.stringify(malformedArray);
  assert.throws(() => getImageLocations(malformedArray), /locations are invalid/);
  assert.equal(JSON.stringify(malformedArray), malformedArrayBefore);

  const malformedEntry = video({
    locations: [
      location(1, '/Safe'),
      { fileName: '../escape.mp4', inputSource: 2, partialPath: '/Unsafe' },
    ],
  });
  const before = JSON.stringify(malformedEntry);
  assert.throws(() => attachImageLocation(malformedEntry, location(3, '/Other')), /file name is invalid/);
  assert.throws(() => removeImageLocationsForSource(malformedEntry, 1), /file name is invalid/);
  assert.equal(JSON.stringify(malformedEntry), before);
  assert.throws(
    () => normalizeImageLocation({ fileName: 'video.mp4', inputSource: 1, partialPath: '../escape' }),
    /cannot leave its configured root/,
  );
});
