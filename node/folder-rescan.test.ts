import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { findDeletedMetadataOrigin } from '../interfaces/date-added';
import {
  attachKnownLocationsFromSnapshot,
  buildKnownSuccessfulMediaPathCounts,
  copyRecoveredEntryMetadata,
  FolderScanCoordinator,
  forgetMissingKnownPaths,
  forgetMissingKnownPathsInScope,
  markMissingFolderEntries,
  markMissingFolderEntriesInScope,
  reconcileMissingFolderEntriesInScope,
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

test('one-shot scans can transfer their snapshot without retaining its paths', () => {
  const scans = new FolderScanCoordinator();
  const scan = scans.begin(4);
  scans.record(scan, '/media/one.mp4');
  scans.record(scan, '/media/two.mp4');

  const transferred = scans.completeAndReleaseSnapshot(scan);
  assert.deepEqual(Array.from(transferred?.keys() || []), [
    '/media/one.mp4',
    '/media/two.mp4',
  ]);
  assert.equal(scan.snapshot.size, 0);
  assert.equal(scans.isCurrent(scan), true, 'queued metadata still belongs to the current scan');
});

test('folder-add preview generation is scan-local and defaults on for later scans', () => {
  const scans = new FolderScanCoordinator();
  const folderAddition = scans.begin(4, '/media', false);
  scans.record(folderAddition, '/media/one.mp4');

  assert.equal(folderAddition.generateAutomaticPreviews, false);
  scans.completeAndReleaseSnapshot(folderAddition);
  assert.equal(folderAddition.generateAutomaticPreviews, false);

  const manualRescan = scans.begin(4, '/media');
  assert.equal(manualRescan.generateAutomaticPreviews, true);
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

test('a scoped scan marks only missing entries inside the selected subtree', () => {
  const present = NewImageElement();
  present.fileName = 'present.mp4';
  present.inputSource = 0;
  present.partialPath = '/Camera';

  const nestedMissing = NewImageElement();
  nestedMissing.dateAdded = 1_700_000_000_000;
  nestedMissing.fileName = 'missing.mp4';
  nestedMissing.inputSource = 0;
  nestedMissing.notes = 'Preserve this';
  nestedMissing.partialPath = '/Camera/Canon';
  nestedMissing.tags = ['manual'];

  const prefixSibling = NewImageElement();
  prefixSibling.fileName = 'bag.mp4';
  prefixSibling.inputSource = 0;
  prefixSibling.partialPath = '/Camerabag';

  const ordinarySibling = NewImageElement();
  ordinarySibling.fileName = 'nikon.mp4';
  ordinarySibling.inputSource = 0;
  ordinarySibling.partialPath = '/Nikon';

  const catalogue = [present, nestedMissing, prefixSibling, ordinarySibling];
  const snapshot = new Map<string, 1>([['/media/Camera/present.mp4', 1]]);

  assert.equal(
    markMissingFolderEntriesInScope(catalogue, 0, '/media', '/Camera', snapshot),
    1,
  );
  assert.equal(present.missing, undefined);
  assert.equal(nestedMissing.missing, true);
  assert.equal(nestedMissing.notes, 'Preserve this');
  assert.deepEqual(nestedMissing.tags, ['manual']);
  assert.equal(nestedMissing.dateAdded, 1_700_000_000_000);
  assert.equal(prefixSibling.missing, undefined);
  assert.equal(ordinarySibling.missing, undefined);
});

test('scoped scans update only matching locations and derive aggregate availability', () => {
  const shared = NewImageElement();
  shared.fileName = 'shared.mp4';
  shared.hash = 'shared-hash';
  shared.inputSource = 0;
  shared.notes = 'Retain metadata';
  shared.partialPath = '/Camera/Canon';
  shared.tags = ['manual'];
  shared.locations = [
    {
      fileName: 'shared.mp4',
      inputSource: 0,
      partialPath: '/Camera/Canon',
    },
    {
      fileName: 'shared.mp4',
      inputSource: 1,
      partialPath: '/Archive/Camera/Canon',
    },
  ];

  assert.equal(
    markMissingFolderEntriesInScope([shared], 0, '/media', '/Camera', new Map()),
    0,
    'the logical video remains available through its other location',
  );
  assert.equal(
    shared.locations.find(location => location.inputSource === 0)?.missing,
    true,
  );
  assert.equal(
    shared.locations.find(location => location.inputSource === 1)?.missing,
    undefined,
  );
  assert.equal(shared.missing, undefined);
  assert.equal(shared.notes, 'Retain metadata');
  assert.deepEqual(shared.tags, ['manual']);

  assert.equal(
    markMissingFolderEntries([shared], 1, '/archive', new Map()),
    1,
    'the logical video becomes unavailable only after every location is absent',
  );
  assert.equal(shared.missing, true);

  const restored = new Map<string, 1>([['/media/Camera/Canon/shared.mp4', 1]]);
  assert.equal(markMissingFolderEntries([shared], 0, '/media', restored), 0);
  assert.equal(
    shared.locations.find(location => location.inputSource === 0)?.missing,
    undefined,
  );
  assert.equal(
    shared.locations.find(location => location.inputSource === 1)?.missing,
    true,
  );
  assert.equal(shared.missing, undefined);
});

test('scoped reconciliation reports per-location changes while another alias stays available', () => {
  const shared = NewImageElement();
  shared.fileName = 'shared.mp4';
  shared.hash = 'shared-hash';
  shared.inputSource = 0;
  shared.notes = 'Preserve this metadata';
  shared.partialPath = '/Camera/Canon';
  shared.tags = ['manual'];
  shared.locations = [
    {
      fileName: 'shared.mp4',
      inputSource: 0,
      partialPath: '/Camera/Canon',
    },
    {
      fileName: 'shared.mp4',
      inputSource: 1,
      partialPath: '/Archive/Camera/Canon',
    },
  ];

  assert.deepEqual(
    reconcileMissingFolderEntriesInScope(
      [shared],
      0,
      '/media',
      '/Camera',
      new Map(),
    ),
    { changedEntries: 1, newlyMissing: 0 },
    'a changed alias must signal persistence even while the logical video stays available',
  );
  assert.equal(shared.missing, undefined);
  assert.equal(
    shared.locations.find(location => location.inputSource === 0)?.missing,
    true,
  );
  assert.equal(
    shared.locations.find(location => location.inputSource === 1)?.missing,
    undefined,
  );
  assert.equal(shared.notes, 'Preserve this metadata');
  assert.deepEqual(shared.tags, ['manual']);

  assert.deepEqual(
    reconcileMissingFolderEntriesInScope(
      [shared],
      0,
      '/media',
      '/Camera',
      new Map(),
    ),
    { changedEntries: 0, newlyMissing: 0 },
    'an unchanged follow-up snapshot must not dirty the catalogue again',
  );

  assert.deepEqual(
    reconcileMissingFolderEntriesInScope(
      [shared],
      0,
      '/media',
      '/Camera',
      new Map([['/media/Camera/Canon/shared.mp4', 1]]),
    ),
    { changedEntries: 1, newlyMissing: 0 },
    'restoring one alias must also signal persistence',
  );
  assert.equal(
    shared.locations.find(location => location.inputSource === 0)?.missing,
    undefined,
  );
  assert.equal(shared.missing, undefined);
});

test('a parent scan attaches an exact existing path without duplicating the logical video', () => {
  const shared = NewImageElement();
  shared.fileName = 'shared.mp4';
  shared.hash = 'content-hash';
  shared.inputSource = 0;
  shared.notes = 'Preserve user metadata';
  shared.partialPath = '/Canon';
  shared.tags = ['camera'];

  const sources = {
    0: { path: '/media/Camera', watch: false },
    1: { path: '/media', watch: false },
  };
  const snapshot = new Map<string, 1>([['/media/Camera/Canon/shared.mp4', 1]]);

  assert.deepEqual(
    attachKnownLocationsFromSnapshot([shared], 1, sources, snapshot),
    { ambiguousPaths: 0, attachedLocations: 1, changedEntries: 1 },
  );
  assert.equal(shared.notes, 'Preserve user metadata');
  assert.deepEqual(shared.tags, ['camera']);
  assert.deepEqual(shared.locations, [
    { fileName: 'shared.mp4', inputSource: 0, partialPath: '/Canon' },
    { fileName: 'shared.mp4', inputSource: 1, partialPath: '/Camera/Canon' },
  ]);
  assert.deepEqual(
    attachKnownLocationsFromSnapshot([shared], 1, sources, snapshot),
    { ambiguousPaths: 0, attachedLocations: 0, changedEntries: 0 },
    'repeating the parent scan must be idempotent',
  );
  assert.equal(
    buildKnownSuccessfulMediaPathCounts([shared], sources).get('/media/Camera/Canon/shared.mp4'),
    1,
    'two source aliases for one logical entry must count as one physical identity',
  );
});

test('an ambiguous exact path is not merged automatically', () => {
  const first = NewImageElement();
  first.fileName = 'shared.mp4';
  first.hash = 'first';
  first.inputSource = 0;
  first.partialPath = '/Canon';

  const second = NewImageElement();
  second.fileName = 'shared.mp4';
  second.hash = 'second';
  second.inputSource = 0;
  second.partialPath = '/Canon';

  const sources = {
    0: { path: '/media/Camera', watch: false },
    1: { path: '/media', watch: false },
  };
  const snapshot = new Map<string, 1>([['/media/Camera/Canon/shared.mp4', 1]]);

  assert.deepEqual(
    attachKnownLocationsFromSnapshot([first, second], 1, sources, snapshot),
    { ambiguousPaths: 1, attachedLocations: 0, changedEntries: 0 },
  );
  assert.equal(first.locations, undefined);
  assert.equal(second.locations, undefined);
  assert.equal(
    buildKnownSuccessfulMediaPathCounts([first, second], sources)
      .get('/media/Camera/Canon/shared.mp4'),
    2,
  );
});

test('malformed locations cannot abort a complete source missing-file pass', () => {
  const malformed = NewImageElement();
  malformed.fileName = 'unsafe.mp4';
  malformed.inputSource = 0;
  malformed.partialPath = '/../outside';

  const ordinaryMissing = NewImageElement();
  ordinaryMissing.fileName = 'missing.mp4';
  ordinaryMissing.inputSource = 0;
  ordinaryMissing.partialPath = '/videos';

  assert.equal(
    markMissingFolderEntries([malformed, ordinaryMissing], 0, '/media', new Map()),
    1,
  );
  assert.equal(malformed.missing, undefined);
  assert.equal(ordinaryMissing.missing, true);
});

test('a scoped scan forgets stale cache paths without touching sibling prefixes', () => {
  const known = new Set([
    '/media/Camera/keep.mp4',
    '/media/Camera/remove.mp4',
    '/media/Camerabag/sibling.mp4',
    '/media/Nikon/sibling.mp4',
  ]);
  const failed = new Set(known);
  const pending = new Set(known);
  const snapshot = new Map<string, 1>([['/media/Camera/keep.mp4', 1]]);

  assert.equal(
    forgetMissingKnownPathsInScope(
      known,
      snapshot,
      failed,
      pending,
      '/media',
      '/Camera',
    ),
    1,
  );
  assert.deepEqual(Array.from(known), [
    '/media/Camera/keep.mp4',
    '/media/Camerabag/sibling.mp4',
    '/media/Nikon/sibling.mp4',
  ]);
  assert.equal(failed.has('/media/Camera/remove.mp4'), false);
  assert.equal(pending.has('/media/Camera/remove.mp4'), false);
  assert.equal(failed.has('/media/Camerabag/sibling.mp4'), true);
  assert.equal(pending.has('/media/Nikon/sibling.mp4'), true);
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
