import { strict as assert } from 'assert';
import { test } from 'node:test';

import type { ScreenshotSettings } from '../interfaces/final-object.interface';
import { NewImageElement } from '../interfaces/final-object.interface';
import {
  applyCustomThumbnailReplacement,
  applyRegeneratedScreenshotCount,
  applyThumbnailRegenerationFailure,
  buildEligibleFolderThumbnailVideoCounts,
  calculateFilmstripHoverPosition,
  calculateScreenshotCount,
  countEligibleFolderThumbnailVideos,
  folderThumbnailRegenerationPlansMatch,
  isActiveThumbnailRegenerationJob,
  MAX_FIXED_SCREENSHOT_COUNT,
  normalizeCatalogueThumbnailCounts,
  planFolderThumbnailRegeneration,
  prepareThumbnailRegeneration,
  sanitizeScreenshotSettings,
  withThumbnailRefreshId,
} from './thumbnail-count';

const settings = (overrides: Partial<ScreenshotSettings> = {}): ScreenshotSettings => ({
  clipHeight: 144,
  clipSnippetLength: 1,
  clipSnippets: 0,
  fixed: true,
  height: 288,
  n: 10,
  ...overrides,
});

test('regeneration replaces a stale item count with the catalogue fixed count', () => {
  const original = {
    ...NewImageElement(),
    duration: 600,
    screens: 3,
  };

  const prepared = prepareThumbnailRegeneration(original, settings({ n: 12 }));

  assert.equal(prepared.screens, 12);
  assert.equal(original.screens, 3);
});

test('uses the catalogue interval for variable screenshot counts', () => {
  assert.equal(calculateScreenshotCount(settings({ fixed: false, n: 5 }), 3600), 12);
});

test('retains the existing minimum, short-video, and JPEG limits', () => {
  assert.equal(calculateScreenshotCount(settings({ n: 1 }), 120), 3);
  assert.equal(calculateScreenshotCount(settings({ n: 10 }), 2), 2);
  assert.equal(calculateScreenshotCount(settings({ fixed: false, height: 504, n: 1 }), 6000), 73);
});

test('caps unsafe fixed counts without limiting legitimate interval catalogues', () => {
  assert.equal(calculateScreenshotCount(settings({ n: 32 }), 600), MAX_FIXED_SCREENSHOT_COUNT);
  assert.equal(calculateScreenshotCount(settings({ fixed: false, height: 144, n: 1 }), 7200), 120);
  assert.equal(calculateScreenshotCount(settings({ fixed: false, n: 60 }), 21600), 6);
  assert.ok(Number.isFinite(calculateScreenshotCount(settings({ n: <any>Number.NaN }), Number.NaN)));
  assert.ok(calculateScreenshotCount(settings({ fixed: false, n: 0 }), 3600) > 0);
});

test('normalizes unsafe settings consistently for display, saving, and extraction', () => {
  assert.equal(sanitizeScreenshotSettings(settings({ n: 32 })).n, 30);
  assert.equal(sanitizeScreenshotSettings(settings({ n: <any>Number.NaN })).n, 10);
  assert.equal(sanitizeScreenshotSettings(settings({ fixed: false, n: 60 })).n, 60);
  assert.equal(sanitizeScreenshotSettings(settings({ fixed: false, n: 0 })).n, 1);
});

test('filmstrip hover positions stay within the first and last frame bounds', () => {
  assert.deepEqual(calculateFilmstripHoverPosition(10, 100, 400, -25), {
    frameIndex: 0,
    offset: 0,
  });
  assert.deepEqual(calculateFilmstripHoverPosition(10, 100, 400, 400), {
    frameIndex: 9,
    offset: 600,
  });
  assert.deepEqual(calculateFilmstripHoverPosition(3, 100, 400, 200), {
    frameIndex: 1,
    offset: 0,
  });
});

test('only the exact queued regeneration job can complete the request', () => {
  assert.equal(isActiveThumbnailRegenerationJob(undefined, 7), false);
  assert.equal(isActiveThumbnailRegenerationJob(6, 7), false);
  assert.equal(isActiveThumbnailRegenerationJob(7, 7), true);
});

test('completion updates matching metadata and clears an invalid default frame', () => {
  const matching = {
    ...NewImageElement(),
    defaultScreen: 8,
    hash: 'matching-hash',
    screens: 10,
  };
  const other = {
    ...NewImageElement(),
    hash: 'other-hash',
    screens: 4,
  };

  const changed = applyRegeneratedScreenshotCount([matching, other], 'matching-hash', 6);

  assert.equal(changed, true);
  assert.equal(matching.screens, 6);
  assert.equal(matching.defaultScreen, undefined);
  assert.equal(other.screens, 4);
});

test('completion leaves valid unchanged metadata clean', () => {
  const matching = {
    ...NewImageElement(),
    defaultScreen: 2,
    hash: 'matching-hash',
    screens: 6,
  };

  assert.equal(applyRegeneratedScreenshotCount([matching], 'matching-hash', 6), false);
  assert.equal(matching.defaultScreen, 2);
});

test('custom thumbnail becomes the default and refreshes only matching entries', () => {
  const matching = {
    ...NewImageElement(),
    defaultScreen: 2,
    hash: 'matching-hash',
    screens: 6,
    uuid: 'matching-uuid',
  };
  const duplicate = {
    ...NewImageElement(),
    hash: 'matching-hash',
    screens: 4,
    uuid: 'duplicate-uuid',
  };
  const other = {
    ...NewImageElement(),
    defaultScreen: 1,
    hash: 'other-hash',
    uuid: 'other-uuid',
  };

  assert.equal(applyCustomThumbnailReplacement([matching, duplicate, other], 'matching-hash', 1234), true);
  assert.equal(matching.defaultScreen, undefined);
  assert.equal(matching.screens, 6);
  assert.equal(matching.uuid, 'matching-uuid-custom-thumbnail-1234');
  assert.equal(duplicate.uuid, 'duplicate-uuid-custom-thumbnail-1234');
  assert.equal(other.defaultScreen, 1);
  assert.equal(other.uuid, 'other-uuid');
});

test('custom thumbnail refresh without saved default metadata leaves catalogue clean', () => {
  const matching = {
    ...NewImageElement(),
    hash: 'matching-hash',
    uuid: 'matching-uuid',
  };

  assert.equal(applyCustomThumbnailReplacement([matching], 'matching-hash', 7), false);
  assert.equal(matching.uuid, 'matching-uuid-custom-thumbnail-7');
});

test('thumbnail-only refresh failure reveals the recovered image instead of a missing filmstrip', () => {
  const matching = {
    ...NewImageElement(),
    defaultScreen: 2,
    hash: 'matching-hash',
    uuid: 'matching-uuid',
  };
  const other = {
    ...NewImageElement(),
    defaultScreen: 1,
    hash: 'other-hash',
    uuid: 'other-uuid',
  };

  assert.equal(applyThumbnailRegenerationFailure(
    [matching, other],
    'matching-hash',
    { filmstrip: false, thumbnail: true },
    99,
  ), true);
  assert.equal(matching.defaultScreen, undefined);
  assert.equal(matching.uuid, 'matching-uuid-thumbnail-recovery-99');
  assert.equal(other.defaultScreen, 1);
  assert.equal(other.uuid, 'other-uuid');
});

test('repeated refreshes replace prior cache suffixes instead of growing indefinitely', () => {
  let uuid = 'stable-entry';
  uuid = withThumbnailRefreshId(uuid, 'thumbnail', 1);
  uuid = withThumbnailRefreshId(uuid, 'custom-thumbnail', 2);
  uuid = withThumbnailRefreshId(uuid, 'thumbnail-recovery', 3);
  uuid = withThumbnailRefreshId(`${uuid}-thumbnail-4-custom-thumbnail-5`, 'thumbnail', 6);

  assert.equal(uuid, 'stable-entry-thumbnail-6');
});

test('normalizes hand-edited counts and invalid defaults on catalogue load', () => {
  const regular = {
    ...NewImageElement(),
    cleanName: 'Regular',
    defaultScreen: 31,
    duration: 600,
    screens: 32,
  };
  const importError = {
    ...NewImageElement(),
    cleanName: 'Import error',
    duration: 600,
    metadataImportFailed: true,
    screens: 32,
  };

  assert.equal(normalizeCatalogueThumbnailCounts([regular, importError], settings({ n: 10 })), true);
  assert.equal(regular.screens, 10);
  assert.equal(regular.defaultScreen, undefined);
  assert.equal(importError.screens, 32);
});

test('plans one folder and collapses duplicate preview hashes', () => {
  const first = {
    ...NewImageElement(),
    cleanName: 'First',
    hash: 'shared-hash',
    inputSource: 2,
  };
  const duplicate = {
    ...NewImageElement(),
    cleanName: 'Duplicate',
    hash: 'shared-hash',
    inputSource: 2,
  };
  const otherFolder = {
    ...NewImageElement(),
    cleanName: 'Other folder',
    hash: 'other-hash',
    inputSource: 3,
  };

  const plan = planFolderThumbnailRegeneration([first, duplicate, otherFolder], 2);

  assert.equal(plan.videoCount, 2);
  assert.equal(plan.skippedVideos, 0);
  assert.deepEqual(plan.targets, [first]);
  assert.equal(plan.videoCountsByHash.get('shared-hash'), 2);
});

test('does not let a matching hash in another folder hide this folder candidate', () => {
  const otherFolder = {
    ...NewImageElement(),
    cleanName: 'Other folder first',
    hash: 'shared-hash',
    inputSource: 1,
  };
  const selectedFolder = {
    ...NewImageElement(),
    cleanName: 'Selected folder',
    hash: 'shared-hash',
    inputSource: 2,
  };

  const plan = planFolderThumbnailRegeneration([otherFolder, selectedFolder], 2);

  assert.deepEqual(plan.targets, [selectedFolder]);
  assert.deepEqual(plan.candidatesByHash.get('shared-hash'), [selectedFolder]);
});

test('accepts legacy string-valued source indices', () => {
  const legacy = {
    ...NewImageElement(),
    cleanName: 'Legacy',
    hash: 'legacy-hash',
    inputSource: <any>'4',
  };

  const plan = planFolderThumbnailRegeneration([legacy], 4);

  assert.equal(plan.videoCount, 1);
  assert.deepEqual(plan.targets, [legacy]);
});

test('excludes deleted, import-error, placeholder, and invalid-hash entries', () => {
  const eligible = {
    ...NewImageElement(),
    cleanName: 'Eligible',
    hash: 'eligible-hash',
    inputSource: 1,
  };
  const deleted = {
    ...NewImageElement(),
    cleanName: 'Deleted',
    deleted: true,
    hash: 'deleted-hash',
    inputSource: 1,
  };
  const importError = {
    ...NewImageElement(),
    cleanName: 'Import error',
    hash: 'error-hash',
    inputSource: 1,
    metadataImportFailed: true,
  };
  const taggedImportError = {
    ...NewImageElement(),
    cleanName: 'Tagged import error',
    hash: 'tagged-error-hash',
    inputSource: 1,
    tags: ['import_error'],
  };
  const invalidHash = {
    ...NewImageElement(),
    cleanName: 'Invalid hash',
    hash: '../invalid',
    inputSource: 1,
  };
  const folderPlaceholder = {
    ...NewImageElement(),
    cleanName: '*FOLDER*',
    hash: 'folder-hash',
    inputSource: 1,
  };

  const plan = planFolderThumbnailRegeneration([
    deleted,
    importError,
    taggedImportError,
    invalidHash,
    folderPlaceholder,
    eligible,
  ], 1);

  assert.equal(plan.videoCount, 1);
  assert.equal(plan.skippedVideos, 3);
  assert.deepEqual(plan.targets, [eligible]);
});

test('filters before deduplicating so an ineligible duplicate cannot hide an eligible item', () => {
  const ineligible = {
    ...NewImageElement(),
    cleanName: 'Unavailable',
    deleted: true,
    hash: 'same-hash',
    inputSource: 4,
  };
  const eligible = {
    ...NewImageElement(),
    cleanName: 'Available',
    hash: 'same-hash',
    inputSource: 4,
  };

  const plan = planFolderThumbnailRegeneration([ineligible, eligible], 4);

  assert.equal(plan.videoCount, 1);
  assert.deepEqual(plan.targets, [eligible]);
});

test('eligible folder counts react to in-place catalogue changes', () => {
  const entry = {
    ...NewImageElement(),
    cleanName: 'Mutable',
    hash: 'mutable-hash',
    inputSource: 4,
  };

  assert.equal(countEligibleFolderThumbnailVideos([entry], 4), 1);
  entry.deleted = true;
  assert.equal(countEligibleFolderThumbnailVideos([entry], 4), 0);
  entry.deleted = false;
  entry.missing = true;
  assert.equal(countEligibleFolderThumbnailVideos([entry], 4), 0);
  entry.missing = false;
  entry.metadataImportFailed = true;
  assert.equal(countEligibleFolderThumbnailVideos([entry], 4), 0);
  assert.equal(buildEligibleFolderThumbnailVideoCounts([entry]).get(4) || 0, 0);
});

test('detects catalogue changes made while confirmation is open', () => {
  const original = {
    ...NewImageElement(),
    cleanName: 'Original',
    fileName: 'original.mp4',
    hash: 'original-hash',
    inputSource: 4,
    partialPath: '/folder',
  };
  const confirmed = planFolderThumbnailRegeneration([original], 4);
  const unchanged = planFolderThumbnailRegeneration([{ ...original }], 4);
  const added = planFolderThumbnailRegeneration([
    original,
    {
      ...NewImageElement(),
      cleanName: 'Added',
      fileName: 'added.mp4',
      hash: 'added-hash',
      inputSource: 4,
      partialPath: '/folder',
    },
  ], 4);

  assert.equal(folderThumbnailRegenerationPlansMatch(confirmed, unchanged), true);
  assert.equal(folderThumbnailRegenerationPlansMatch(confirmed, added), false);

  original.fileName = 'renamed-while-confirming.mp4';
  const renamed = planFolderThumbnailRegeneration([original], 4);
  assert.equal(folderThumbnailRegenerationPlansMatch(confirmed, renamed), false);
});
