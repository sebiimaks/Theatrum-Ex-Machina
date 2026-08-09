import { strict as assert } from 'assert';
import { test } from 'node:test';

import { shouldStartSourceOnCatalogueSetup } from '../interfaces/folder-scan-startup';
import {
  normalizeGeneratePreviewsOnFolderAddition,
  normalizeHideSubdirectoriesWithNoVideos,
  normalizeScanFoldersOnAddition,
} from '../src/app/common/app-state';

test('migrates legacy scan-on-addition settings without overwriting an explicit choice', () => {
  assert.equal(normalizeScanFoldersOnAddition(undefined), true);
  assert.equal(normalizeScanFoldersOnAddition(null), true);
  assert.equal(normalizeScanFoldersOnAddition('false'), true);
  assert.equal(normalizeScanFoldersOnAddition(true), true);
  assert.equal(normalizeScanFoldersOnAddition(false), false);
});

test('migrates legacy folder-add preview settings without overwriting an explicit choice', () => {
  assert.equal(normalizeGeneratePreviewsOnFolderAddition(undefined), true);
  assert.equal(normalizeGeneratePreviewsOnFolderAddition(null), true);
  assert.equal(normalizeGeneratePreviewsOnFolderAddition('false'), true);
  assert.equal(normalizeGeneratePreviewsOnFolderAddition(true), true);
  assert.equal(normalizeGeneratePreviewsOnFolderAddition(false), false);
});

test('keeps empty subdirectories visible for legacy settings unless explicitly hidden', () => {
  assert.equal(normalizeHideSubdirectoriesWithNoVideos(undefined), false);
  assert.equal(normalizeHideSubdirectoriesWithNoVideos(null), false);
  assert.equal(normalizeHideSubdirectoriesWithNoVideos('true'), false);
  assert.equal(normalizeHideSubdirectoriesWithNoVideos(false), false);
  assert.equal(normalizeHideSubdirectoriesWithNoVideos(true), true);
});

test('starts watched sources regardless of catalogue age', () => {
  assert.equal(shouldStartSourceOnCatalogueSetup(true, true), true);
  assert.equal(shouldStartSourceOnCatalogueSetup(true, false), true);
});

test('scans non-watched sources only during explicit new-catalogue setup', () => {
  assert.equal(shouldStartSourceOnCatalogueSetup(false, true), true);
  assert.equal(shouldStartSourceOnCatalogueSetup(false, false), false);
});
