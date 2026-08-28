import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CATALOGUE_FILE_EXTENSION,
  CATALOGUE_PICKER_EXTENSIONS,
  catalogueFileCandidates,
  catalogueFileName,
  hasCatalogueOrAssetNameCollision,
  isCataloguePickerFilePath,
  isSafeCatalogueHubName,
  isSupportedCatalogueFilePath,
} from '../interfaces/catalogue-file.ts';

test('uses the branded extension for new catalogue files', () => {
  assert.equal(CATALOGUE_FILE_EXTENSION, '.scaena');
  assert.equal(catalogueFileName('Archive'), 'Archive.scaena');
});

test('accepts only a single safe path segment for a new catalogue name', () => {
  assert.equal(isSafeCatalogueHubName('Photography 2026'), true);
  assert.equal(isSafeCatalogueHubName('..'), false);
  assert.equal(isSafeCatalogueHubName('../outside'), false);
  assert.equal(isSafeCatalogueHubName('nested/folder'), false);
  assert.equal(isSafeCatalogueHubName('nested\\folder'), false);
  assert.equal(isSafeCatalogueHubName(''), false);
  assert.equal(isSafeCatalogueHubName('   '), false);
});

test('recognizes branded and legacy catalogue paths case-insensitively', () => {
  assert.equal(isSupportedCatalogueFilePath('/catalogues/Archive.scaena'), true);
  assert.equal(isSupportedCatalogueFilePath('/catalogues/ARCHIVE.SCAENA'), true);
  assert.equal(isSupportedCatalogueFilePath('/catalogues/Archive.vha2'), true);
  assert.equal(isSupportedCatalogueFilePath('/catalogues/ARCHIVE.VHA2'), true);
  assert.equal(isSupportedCatalogueFilePath('/catalogues/Archive.json'), false);
});

test('checks both branded and legacy names for new-hub collisions', () => {
  assert.deepEqual(catalogueFileCandidates('Archive'), ['Archive.scaena', 'Archive.vha2']);
  assert.equal(hasCatalogueOrAssetNameCollision('Archive', ['ARCHIVE.SCAENA']), true);
  assert.equal(hasCatalogueOrAssetNameCollision('Archive', ['archive.vha2']), true);
  assert.equal(hasCatalogueOrAssetNameCollision('Archive', ['VHA-ARCHIVE']), true);
  assert.equal(hasCatalogueOrAssetNameCollision('Archive', ['Another.scaena']), false);
});

test('lists the branded extension first while retaining manual legacy import', () => {
  assert.deepEqual([...CATALOGUE_PICKER_EXTENSIONS], ['scaena', 'vha2', 'json']);
  assert.equal(isCataloguePickerFilePath('/catalogues/Archive.scaena'), true);
  assert.equal(isCataloguePickerFilePath('/catalogues/Archive.vha2'), true);
  assert.equal(isCataloguePickerFilePath('/catalogues/Archive.json'), true);
  assert.equal(isCataloguePickerFilePath('/catalogues/Archive.txt'), false);
});
