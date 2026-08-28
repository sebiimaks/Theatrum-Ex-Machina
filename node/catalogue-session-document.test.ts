import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';

import type {
  ImageElement,
  InputSources,
  ScreenshotSettings,
} from '../interfaces/final-object.interface';
import {
  buildCatalogueDocument,
  catalogueDocumentForSave,
  collectCatalogueDocumentSource,
} from '../src/app/common/catalogue-session-document';
import type { CatalogueDocumentSaveSource } from '../src/app/common/catalogue-session-document';

function createSource(
  overrides: Partial<CatalogueDocumentSaveSource> = {},
): CatalogueDocumentSaveSource {
  return {
    accessMode: 'read-write',
    addTags: ['camera'],
    autoTagsDirty: false,
    hubName: 'Photography',
    images: [{ hash: 'video-hash' } as ImageElement],
    imagesDirty: false,
    inputDirs: { 0: { path: '/media', watch: true } } as InputSources,
    numOfFolders: 12,
    removeTags: ['hidden'],
    screenshotSettings: {
      clipHeight: 144,
      clipSnippetLength: 1,
      clipSnippets: 2,
      fixed: true,
      height: 288,
      n: 10,
    } as ScreenshotSettings,
    tagColors: { camera: '#123456' },
    tagDefinitions: ['camera', 'camera > rangefinder'],
    ...overrides,
  };
}

test('builds the complete version-3 catalogue document without cloning live state', () => {
  const source = createSource();
  const document = buildCatalogueDocument(source);

  assert.deepEqual(document, {
    addTags: ['camera'],
    hubName: 'Photography',
    images: [{ hash: 'video-hash' }],
    inputDirs: { 0: { path: '/media', watch: true } },
    numOfFolders: 12,
    removeTags: ['hidden'],
    screenshotSettings: source.screenshotSettings,
    tagColors: { camera: '#123456' },
    tagDefinitions: ['camera', 'camera > rangefinder'],
    version: 3,
  });
  assert.equal(document.images, source.images);
  assert.equal(document.inputDirs, source.inputDirs);
  assert.equal(document.addTags, source.addTags);
  assert.equal(document.removeTags, source.removeTags);
  assert.equal(document.screenshotSettings, source.screenshotSettings);
  assert.equal(document.tagColors, source.tagColors);
  assert.equal(document.tagDefinitions, source.tagDefinitions);
});

test('writable image or auto-tag changes independently make a document eligible to save', () => {
  const imageDocument = catalogueDocumentForSave(createSource({ imagesDirty: true }));
  const autoTagDocument = catalogueDocumentForSave(createSource({ autoTagsDirty: true }));

  assert.equal(imageDocument?.hubName, 'Photography');
  assert.equal(autoTagDocument?.hubName, 'Photography');
});

test('clean and read-only catalogues never produce a save document', () => {
  assert.equal(catalogueDocumentForSave(createSource()), null);
  assert.equal(catalogueDocumentForSave(createSource({
    accessMode: 'read-only',
    autoTagsDirty: true,
    imagesDirty: true,
  })), null);
});

test('the unconditional builder remains available for compatibility export', () => {
  const cleanReadOnlySource = createSource({ accessMode: 'read-only' });

  assert.equal(catalogueDocumentForSave(cleanReadOnlySource), null);
  assert.equal(buildCatalogueDocument(cleanReadOnlySource).hubName, 'Photography');
});

test('collects live persistence values and dirty flags through typed state ports', () => {
  const source = createSource({ autoTagsDirty: true, imagesDirty: true });
  const collected = collectCatalogueDocumentSource({
    accessMode: source.accessMode,
    hubName: source.hubName,
    numOfFolders: source.numOfFolders,
    screenshotSettings: source.screenshotSettings,
  }, {
    autoTags: {
      getAddTags: () => source.addTags,
      getRemoveTags: () => source.removeTags,
      needToSave: () => source.autoTagsDirty,
    },
    images: {
      finalArrayNeedsSaving: source.imagesDirty,
      imageElements: source.images,
    },
    manualTags: {
      getTagColors: () => source.tagColors,
      getTagDefinitions: () => source.tagDefinitions,
    },
    sourceFolders: {
      selectedSourceFolder: source.inputDirs,
    },
  });

  assert.equal(collected.images, source.images);
  assert.equal(collected.inputDirs, source.inputDirs);
  assert.equal(collected.addTags, source.addTags);
  assert.equal(collected.removeTags, source.removeTags);
  assert.equal(collected.tagColors, source.tagColors);
  assert.equal(collected.tagDefinitions, source.tagDefinitions);
  assert.equal(collected.screenshotSettings, source.screenshotSettings);
  assert.equal(collected.autoTagsDirty, true);
  assert.equal(collected.imagesDirty, true);
});

test('Home delegates save/open/close projection while export uses the unconditional builder', () => {
  const component = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );
  const saveProjectionStart = component.indexOf('public getFinalObjectForSaving(): FinalObject | null');
  const exportStart = component.indexOf('public async exportVha2Catalogue(): Promise<void>');
  const saveProjection = component.slice(saveProjectionStart, exportStart);
  const exportMethod = component.slice(exportStart, component.indexOf('/**', exportStart + 10));

  assert.match(saveProjection, /this\.catalogueSessionDocument\.documentForSave/);
  assert.match(exportMethod, /this\.catalogueSessionDocument\.buildDocument/);
  assert.equal(exportMethod.includes('getFinalObjectForSaving'), false);
  assert.match(component, /getCurrentCatalogueForSave: \(\) => this\.getFinalObjectForSaving\(\)/);
  assert.match(component, /cataloguePersistenceIpc\.saveCatalogue\(finalObjectToSave\)/);
  assert.match(
    component,
    /cataloguePersistenceIpc\.requestClose\(\s*this\.getSettingsForSave\(\),\s*this\.getFinalObjectForSaving\(\)/,
  );
});
