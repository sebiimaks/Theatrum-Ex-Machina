import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { findDeletedMetadataOrigin } from '../interfaces/date-added';
import {
  copyRecoveredEntryMetadata,
  FolderScanCoordinator,
  forgetMissingKnownPaths,
  markMissingFolderEntries,
  replaceRecoveredFolderEntry,
} from '../interfaces/folder-rescan';
import { NewImageElement } from '../interfaces/final-object.interface';

test('each repeated rescan produces a fresh source snapshot', () => {
  const scans = new FolderScanCoordinator();
  const firstRename = scans.begin(3);
  scans.record(firstRename, '/media/beta.mp4');

  const firstSnapshot = scans.complete(firstRename);
  assert.deepEqual(Array.from(firstSnapshot?.keys() || []), ['/media/beta.mp4']);

  const secondRename = scans.begin(3);
  scans.record(secondRename, '/media/gamma.mp4');

  const secondSnapshot = scans.complete(secondRename);
  assert.deepEqual(Array.from(secondSnapshot?.keys() || []), ['/media/gamma.mp4']);
  assert.equal(secondSnapshot?.has('/media/beta.mp4'), false);
});

test('an older overlapping or failed scan cannot become authoritative', () => {
  const scans = new FolderScanCoordinator();
  const older = scans.begin(1);
  scans.record(older, '/media/old.mp4');
  const newer = scans.begin(1);
  scans.record(newer, '/media/current.mp4');

  assert.equal(scans.complete(older), undefined);
  assert.deepEqual(Array.from(scans.complete(newer)?.keys() || []), ['/media/current.mp4']);

  const failed = scans.begin(1);
  scans.record(failed, '/media/partial.mp4');
  assert.equal(scans.fail(failed), true);
  assert.equal(scans.complete(failed), undefined);
});

test('resetting for another hub cannot make an old scan current again', () => {
  const scans = new FolderScanCoordinator();
  const oldHubScan = scans.begin(0);
  scans.record(oldHubScan, '/old-hub/video.mp4');

  scans.reset();
  const newHubScan = scans.begin(0);
  scans.record(newHubScan, '/new-hub/video.mp4');

  assert.equal(scans.complete(oldHubScan), undefined);
  assert.deepEqual(Array.from(scans.complete(newHubScan)?.keys() || []), [
    '/new-hub/video.mp4',
  ]);
});

test('a successful scan forgets only absent paths from the selected source cache', () => {
  const known = new Set(['/media/old.mp4', '/media/current.mp4']);
  const failed = new Set(['/media/old.mp4', '/media/current.mp4']);
  const pending = new Set(['/media/old.mp4', '/media/current.mp4']);
  const snapshot = new Map<string, 1>([['/media/current.mp4', 1]]);

  assert.equal(forgetMissingKnownPaths(known, snapshot, failed, pending), 1);
  assert.deepEqual(Array.from(known), ['/media/current.mp4']);
  assert.deepEqual(Array.from(failed), ['/media/current.mp4']);
  assert.deepEqual(Array.from(pending), ['/media/current.mp4']);
});

test('missing files retain catalogue metadata and unrelated sources remain unchanged', () => {
  const present = NewImageElement();
  present.fileName = 'present.mp4';
  present.inputSource = 0;
  present.partialPath = '/videos';

  const temporarilyMissing = NewImageElement();
  temporarilyMissing.dateAdded = 1_700_000_000_000;
  temporarilyMissing.fileName = 'offline.mp4';
  temporarilyMissing.inputSource = 0;
  temporarilyMissing.notes = 'Keep these notes';
  temporarilyMissing.partialPath = '/videos';
  temporarilyMissing.tags = ['keep-this-tag'];

  const anotherSource = NewImageElement();
  anotherSource.fileName = 'other.mp4';
  anotherSource.inputSource = 1;
  anotherSource.partialPath = '/videos';

  const catalogue = [present, temporarilyMissing, anotherSource];
  const snapshot = new Map<string, 1>([['/media/videos/present.mp4', 1]]);

  assert.equal(markMissingFolderEntries(catalogue, 0, '/media', snapshot), 1);
  assert.equal(temporarilyMissing.missing, true);
  assert.equal(temporarilyMissing.deleted, undefined);
  assert.equal(temporarilyMissing.notes, 'Keep these notes');
  assert.deepEqual(temporarilyMissing.tags, ['keep-this-tag']);
  assert.equal(temporarilyMissing.dateAdded, 1_700_000_000_000);
  assert.equal(anotherSource.missing, undefined);
  assert.equal(markMissingFolderEntries(catalogue, 0, '/media', snapshot), 0);
});

test('successive rename recovery replaces one stable entry instead of accumulating tombstones', () => {
  const original = NewImageElement();
  original.birthtime = 10;
  original.fileName = 'alpha.mp4';
  original.fileSize = 20;
  original.hash = 'same-video';
  original.inputSource = 0;
  original.defaultScreen = 4;
  original.lastPlayed = 1_800_000_000_000;
  original.missing = true;
  original.mtime = 30;
  original.notes = 'Preserved metadata';
  original.playlist = 1_810_000_000_000;
  original.stars = 4.5;
  original.tags = ['keep'];
  original.timesPlayed = 9;
  original.year = 2024;

  const catalogue = [original];
  const firstRename = NewImageElement();
  firstRename.birthtime = original.birthtime;
  firstRename.fileName = 'beta.mp4';
  firstRename.fileSize = original.fileSize;
  firstRename.hash = original.hash;
  firstRename.inputSource = original.inputSource;
  firstRename.mtime = original.mtime;
  const firstOrigin = findDeletedMetadataOrigin(firstRename, catalogue);
  assert.equal(firstOrigin, original);
  copyRecoveredEntryMetadata(firstRename, firstOrigin);
  assert.equal(replaceRecoveredFolderEntry(catalogue, firstRename, firstOrigin), 0);
  assert.equal(catalogue.length, 1);
  assert.equal(catalogue[0].fileName, 'beta.mp4');

  catalogue[0].missing = true;
  const secondRename = NewImageElement();
  secondRename.birthtime = catalogue[0].birthtime;
  secondRename.fileName = 'gamma.mp4';
  secondRename.fileSize = catalogue[0].fileSize;
  secondRename.hash = catalogue[0].hash;
  secondRename.inputSource = catalogue[0].inputSource;
  secondRename.mtime = catalogue[0].mtime;
  const secondOrigin = findDeletedMetadataOrigin(secondRename, catalogue);
  assert.equal(secondOrigin, catalogue[0]);
  copyRecoveredEntryMetadata(secondRename, secondOrigin);
  assert.equal(replaceRecoveredFolderEntry(catalogue, secondRename, secondOrigin), 0);
  assert.equal(catalogue.length, 1);
  assert.equal(catalogue[0].fileName, 'gamma.mp4');
  assert.equal(catalogue[0].notes, 'Preserved metadata');
  assert.deepEqual(catalogue[0].tags, ['keep']);
  assert.equal(catalogue[0].defaultScreen, 4);
  assert.equal(catalogue[0].lastPlayed, 1_800_000_000_000);
  assert.equal(catalogue[0].playlist, 1_810_000_000_000);
  assert.equal(catalogue[0].stars, 4.5);
  assert.equal(catalogue[0].timesPlayed, 9);
  assert.equal(catalogue[0].year, 2024);
});
