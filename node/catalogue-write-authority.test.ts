import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FinalObject } from '../interfaces/final-object.interface.ts';
import { prepareAuthorizedCatalogueWrite } from './catalogue-write-authority.ts';

function catalogue(inputDirs: FinalObject['inputDirs']): FinalObject {
  return {
    addTags: [],
    hubName: 'Renderer Name',
    images: [],
    inputDirs,
    numOfFolders: 0,
    removeTags: [],
    screenshotSettings: {
      clipHeight: 144,
      clipSnippetLength: 1,
      clipSnippets: 0,
      fixed: true,
      height: 288,
      n: 10,
    },
    version: 3,
  };
}

test('preserves main-owned source roots and allows deliberate source removal', () => {
  const configuredSources = {
    0: { path: '/Volumes/Videos', watch: true },
    1: { path: '/Volumes/Archive', watch: false },
  };
  const prepared = prepareAuthorizedCatalogueWrite(
    catalogue({ 1: { path: '/Volumes/Archive', watch: true } }),
    configuredSources,
    'Trusted Hub',
  );

  assert.equal(prepared.hubName, 'Trusted Hub');
  assert.deepEqual(prepared.inputDirs, {
    1: { path: '/Volumes/Archive', watch: false },
  });
});

test('rejects renderer attempts to add or remap source folders', () => {
  assert.throws(
    () => prepareAuthorizedCatalogueWrite(
      catalogue({ 0: { path: '/Sensitive', watch: true } }),
      { 0: { path: '/Volumes/Videos', watch: false } },
      'Hub',
    ),
    /currently open catalogue|unselected source folder/,
  );
  assert.throws(
    () => prepareAuthorizedCatalogueWrite(
      catalogue({ 1: { path: '/Sensitive', watch: true } }),
      { 0: { path: '/Volumes/Videos', watch: false } },
      'Hub',
    ),
    /unselected source folder/,
  );
});
