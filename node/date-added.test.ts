import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NewImageElement } from '../interfaces/final-object.interface';
import {
  compareDateAdded,
  ensureDateAddedForNewEntry,
  findDeletedMetadataOrigin,
  formatDateAddedForDisplay,
  formatDateAddedForInput,
  inheritDateAdded,
  latestDateAdded,
  normalizeDateAdded,
  parseDateAddedInput,
} from '../interfaces/date-added';

test('assigns a supplied timestamp only to a genuinely new entry', () => {
  const entry = NewImageElement();

  assert.equal(ensureDateAddedForNewEntry(entry, 1_700_000_000_000), 1_700_000_000_000);
  assert.equal(entry.dateAdded, 1_700_000_000_000);
  assert.equal(ensureDateAddedForNewEntry(entry, 1_800_000_000_000), 1_700_000_000_000);
});

test('metadata recovery preserves a known date and keeps a legacy date unknown', () => {
  const recovered = NewImageElement();
  const knownOrigin = NewImageElement();
  knownOrigin.dateAdded = 1_700_000_000_000;

  inheritDateAdded(recovered, knownOrigin);
  assert.equal(recovered.dateAdded, knownOrigin.dateAdded);

  const legacyOrigin = NewImageElement();
  inheritDateAdded(recovered, legacyOrigin);
  assert.equal(recovered.dateAdded, undefined);
});

test('formats and parses local date-time values without a UTC shift', () => {
  const timestamp = new Date(2026, 6, 30, 14, 45, 0, 0).getTime();
  const draft = formatDateAddedForInput(timestamp);

  assert.equal(draft, '2026-07-30T14:45');
  assert.equal(parseDateAddedInput(draft), timestamp);
  assert.match(formatDateAddedForDisplay(timestamp), /2026/);
});

test('distinguishes blanks from malformed or impossible dates', () => {
  assert.equal(parseDateAddedInput(''), undefined);
  assert.equal(parseDateAddedInput('not a date'), null);
  assert.equal(parseDateAddedInput('2026-02-30T12:00'), null);
  assert.equal(parseDateAddedInput('1969-12-31T23:59'), null);
  assert.equal(normalizeDateAdded(Number.NaN), undefined);
  assert.equal(normalizeDateAdded(-1), undefined);
});

test('sorts known dates in either direction while leaving unknown values last', () => {
  const oldest = 1_600_000_000_000;
  const newest = 1_800_000_000_000;

  assert.ok(compareDateAdded(oldest, newest, true) < 0);
  assert.ok(compareDateAdded(oldest, newest, false) > 0);
  assert.ok(compareDateAdded(oldest, undefined, true) < 0);
  assert.ok(compareDateAdded(newest, undefined, false) < 0);
  assert.equal(compareDateAdded(undefined, undefined, true), 0);
});

test('folder aggregation uses the latest valid descendant date', () => {
  assert.equal(latestDateAdded([undefined, 1_600_000_000_000, -1, 1_800_000_000_000]), 1_800_000_000_000);
  assert.equal(latestDateAdded([undefined, Number.NaN, -1]), undefined);
});

test('finds a unique deleted origin even when it moved to another source', () => {
  const incoming = NewImageElement();
  incoming.birthtime = 100;
  incoming.fileSize = 200;
  incoming.hash = 'same-content';
  incoming.inputSource = 4;
  incoming.mtime = 300;

  const origin = NewImageElement();
  origin.birthtime = incoming.birthtime;
  origin.deleted = true;
  origin.fileSize = incoming.fileSize;
  origin.hash = incoming.hash;
  origin.inputSource = '7' as unknown as number;
  origin.mtime = incoming.mtime;

  assert.equal(findDeletedMetadataOrigin(incoming, [origin]), origin);
});

test('uses unique file-stat identity for a moved import-error entry across sources', () => {
  const incoming = NewImageElement();
  incoming.birthtime = 100;
  incoming.fileSize = 200;
  incoming.hash = 'new-path-hash';
  incoming.inputSource = 1;
  incoming.mtime = 300;

  const origin = NewImageElement();
  origin.birthtime = incoming.birthtime;
  origin.deleted = true;
  origin.fileSize = incoming.fileSize;
  origin.hash = 'old-path-hash';
  origin.inputSource = 2;
  origin.metadataImportFailed = true;
  origin.mtime = incoming.mtime;

  assert.equal(findDeletedMetadataOrigin(incoming, [origin]), origin);
});

test('does not inherit metadata from an ambiguous duplicate match', () => {
  const incoming = NewImageElement();
  incoming.birthtime = 100;
  incoming.fileSize = 200;
  incoming.hash = 'duplicate';
  incoming.inputSource = 1;
  incoming.mtime = 300;

  const first = { ...incoming, dateAdded: 1_600_000_000_000, deleted: true };
  const second = { ...incoming, dateAdded: 1_700_000_000_000, deleted: true };

  assert.equal(findDeletedMetadataOrigin(incoming, [first, second]), undefined);
});

test('uses file-stat identity to disambiguate duplicate hashes', () => {
  const incoming = NewImageElement();
  incoming.birthtime = 100;
  incoming.fileSize = 200;
  incoming.hash = 'duplicate';
  incoming.inputSource = 3;
  incoming.mtime = 300;

  const origin = { ...incoming, deleted: true, inputSource: 1 };
  const unrelatedDuplicate = {
    ...incoming,
    birthtime: 400,
    deleted: true,
    inputSource: 3,
    mtime: 500,
  };

  assert.equal(findDeletedMetadataOrigin(incoming, [unrelatedDuplicate, origin]), origin);
});

test('does not use source alone to choose between duplicate hashes', () => {
  const incoming = NewImageElement();
  incoming.birthtime = 100;
  incoming.fileSize = 200;
  incoming.hash = 'duplicate';
  incoming.inputSource = 3;
  incoming.mtime = 300;

  const sameSourceDuplicate = {
    ...incoming,
    birthtime: 400,
    deleted: true,
    mtime: 500,
  };
  const otherSourceDuplicate = {
    ...incoming,
    birthtime: 600,
    deleted: true,
    inputSource: 2,
    mtime: 700,
  };

  assert.equal(
    findDeletedMetadataOrigin(incoming, [sameSourceDuplicate, otherSourceDuplicate]),
    undefined,
  );
});

test('does not consume an offline entry for a same-content file in another source', () => {
  const offline = NewImageElement();
  offline.birthtime = 100;
  offline.fileSize = 200;
  offline.hash = 'same-content';
  offline.inputSource = 1;
  offline.missing = true;
  offline.mtime = 300;

  const incoming = {
    ...offline,
    inputSource: 2,
    missing: undefined,
  };

  assert.equal(findDeletedMetadataOrigin(incoming, [offline]), undefined);
});

test('recovers an exact same-source path even when its media identity changed', () => {
  const missing = NewImageElement();
  missing.fileName = 'replaced.mp4';
  missing.hash = 'old-content';
  missing.inputSource = 1;
  missing.missing = true;
  missing.partialPath = '/folder';

  const incoming = {
    ...missing,
    birthtime: 400,
    fileSize: 500,
    hash: 'new-content',
    missing: undefined,
    mtime: 600,
  };

  assert.equal(findDeletedMetadataOrigin(incoming, [missing]), missing);
});
