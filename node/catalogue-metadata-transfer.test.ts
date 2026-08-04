import { strict as assert } from 'assert';
import { test } from 'node:test';

import type { ImageElement } from '../interfaces/final-object.interface';
import { NewImageElement } from '../interfaces/final-object.interface';
import {
  applyCatalogueMetadataImportPlan,
  buildCatalogueMetadataImportPlan,
  CATALOGUE_METADATA_FORMAT,
  CATALOGUE_METADATA_FORMAT_VERSION,
  createCatalogueMetadataExport,
  serializeCatalogueMetadataExport,
} from '../interfaces/catalogue-metadata-transfer';

function image(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    ...NewImageElement(),
    cleanName: 'Example Video',
    fileName: 'example.mp4',
    hash: 'example-hash',
    index: 1,
    notes: 'Original notes',
    screens: 4,
    stars: 2.5,
    tags: ['original'],
    timesPlayed: 2,
    year: 2020,
    ...overrides,
  };
}

function metadataJson(entries: Record<string, unknown>[]): string {
  return JSON.stringify({
    entries,
    exportedAt: '2026-08-04T00:00:00.000Z',
    format: CATALOGUE_METADATA_FORMAT,
    formatVersion: CATALOGUE_METADATA_FORMAT_VERSION,
  });
}

test('exports only the requested human-readable metadata with safe representations', () => {
  const dateAdded = Date.parse('2026-07-30T04:45:00.000Z');
  const entry = image({
    dateAdded,
    fileName: 'Quoted, “Unicode”.mp4',
    hash: 'unique-hash',
    notes: 'Line one\nLine two, with "quotes" and 日本語',
    stars: 5.5,
    tags: ['Tag One', '日本語'],
    timesPlayed: 7,
    year: 2026,
  });
  const result = createCatalogueMetadataExport([
    entry,
    image({ deleted: true, hash: 'deleted-hash', index: 2 }),
    image({ hash: '', index: 3 }),
  ], Date.parse('2026-08-04T01:02:03.000Z'));

  assert.equal(result.document.entries.length, 1);
  assert.deepEqual(result.document.entries[0], {
    dateAdded: '2026-07-30T04:45:00.000Z',
    fileName: 'Quoted, “Unicode”.mp4',
    hash: 'unique-hash',
    notes: 'Line one\nLine two, with "quotes" and 日本語',
    stars: 5,
    tags: ['Tag One', '日本語'],
    timesPlayed: 7,
    year: 2026,
  });
  assert.equal(result.deletedEntryCount, 1);
  assert.equal(result.missingHashEntryCount, 1);

  const serialized = serializeCatalogueMetadataExport(result.document);
  assert.ok(serialized.endsWith('\n'));
  assert.deepEqual(JSON.parse(serialized).entries[0], result.document.entries[0]);
  assert.equal(serialized.includes('partialPath'), false);
  assert.equal(serialized.includes('birthtime'), false);
});

test('skips every local entry whose hash is not unique during export', () => {
  const result = createCatalogueMetadataExport([
    image({ fileName: 'first.mp4', hash: 'duplicate-hash' }),
    image({ fileName: 'second.mp4', hash: 'duplicate-hash', index: 2 }),
    image({ fileName: 'safe.mp4', hash: 'safe-hash', index: 3 }),
  ]);

  assert.deepEqual(result.document.entries.map(entry => entry.hash), ['safe-hash']);
  assert.equal(result.ambiguousHashEntryCount, 2);
});

test('imports only selected categories by exact hash and includes unavailable entries', () => {
  const target = image({
    dateAdded: 1000,
    fileName: 'renamed-locally.mp4',
    hash: 'same-hash',
    missing: true,
  });
  const json = metadataJson([{
    dateAdded: '2026-07-30T04:45:00.000Z',
    fileName: 'old-name.mp4',
    hash: 'same-hash',
    notes: 'Imported notes\nwith a second line',
    stars: 5,
    tags: ['New Tag', 'new tag', 'Second'],
    timesPlayed: 99,
    year: 2030,
  }]);

  const plan = buildCatalogueMetadataImportPlan([target], json, ['tags', 'notes']);
  assert.equal(plan.matchedRecordCount, 1);
  assert.equal(plan.changedEntryCount, 1);
  assert.equal(plan.changedFieldCount, 2);

  const result = applyCatalogueMetadataImportPlan(plan);
  assert.equal(result.updatedEntryCount, 1);
  assert.deepEqual(target.tags, ['New Tag', 'Second']);
  assert.equal(target.notes, 'Imported notes\nwith a second line');
  assert.equal(target.stars, 2.5);
  assert.equal(target.year, 2020);
  assert.equal(target.dateAdded, 1000);
  assert.equal(target.timesPlayed, 2);
  assert.equal(target.fileName, 'renamed-locally.mp4');
  assert.equal(target.hash, 'same-hash');
});

test('imports only globally unique targets within the filtered scope', () => {
  const included = image({ hash: 'included-hash', notes: 'Old included notes' });
  const excluded = image({ hash: 'excluded-hash', index: 2, notes: 'Old excluded notes' });
  const json = metadataJson([
    { fileName: 'included.mp4', hash: 'included-hash', notes: 'New included notes' },
    { fileName: 'excluded.mp4', hash: 'excluded-hash', notes: 'New excluded notes' },
  ]);

  const plan = buildCatalogueMetadataImportPlan(
    [included, excluded],
    json,
    ['notes'],
    [included],
  );

  assert.equal(plan.matchedRecordCount, 1);
  assert.equal(plan.outsideScopeRecordCount, 1);
  assert.equal(plan.changedEntryCount, 1);
  applyCatalogueMetadataImportPlan(plan);
  assert.equal(included.notes, 'New included notes');
  assert.equal(excluded.notes, 'Old excluded notes');
});

test('a filtered scope never makes a globally duplicated hash safe to import', () => {
  const displayed = image({ hash: 'duplicate-hash' });
  const hidden = image({ hash: 'duplicate-hash', index: 2 });
  const plan = buildCatalogueMetadataImportPlan(
    [displayed, hidden],
    metadataJson([{
      fileName: 'ambiguous.mp4',
      hash: 'duplicate-hash',
      notes: 'Must not apply',
    }]),
    ['notes'],
    [displayed],
  );

  assert.equal(plan.ambiguousCatalogueRecordCount, 1);
  assert.equal(plan.outsideScopeRecordCount, 0);
  assert.equal(plan.changedEntryCount, 0);
  assert.equal(displayed.notes, 'Original notes');
  assert.equal(hidden.notes, 'Original notes');
});

test('all-category import maps stars and dates and clears explicit empty metadata', () => {
  const target = image({ dateAdded: 1000 });
  const json = metadataJson([{
    dateAdded: null,
    fileName: 'reference-only.mp4',
    hash: 'example-hash',
    notes: null,
    stars: null,
    tags: [],
    timesPlayed: 0,
    year: null,
  }]);

  const plan = buildCatalogueMetadataImportPlan(
    [target],
    json,
    ['stars', 'year', 'dateAdded', 'timesPlayed', 'tags', 'notes'],
  );
  const result = applyCatalogueMetadataImportPlan(plan);

  assert.equal(result.updatedFieldCount, 6);
  assert.equal(target.stars, 0.5);
  assert.equal(target.year, undefined);
  assert.equal(target.dateAdded, undefined);
  assert.equal(target.timesPlayed, 0);
  assert.equal(target.tags, undefined);
  assert.equal(target.notes, undefined);
  assert.equal(buildCatalogueMetadataImportPlan(
    [target],
    json,
    ['stars', 'year', 'dateAdded', 'timesPlayed', 'tags', 'notes'],
  ).changedEntryCount, 0);
});

test('reports missing, duplicate, unmatched, and ambiguous hashes without mutation', () => {
  const firstAmbiguous = image({ hash: 'ambiguous-local' });
  const secondAmbiguous = image({ hash: 'ambiguous-local', index: 2 });
  const deleted = image({ deleted: true, hash: 'deleted-local', index: 3 });
  const json = metadataJson([
    { fileName: 'ambiguous.mp4', hash: 'ambiguous-local', notes: 'Do not apply' },
    { fileName: 'unknown.mp4', hash: 'unknown', notes: 'Do not apply' },
    { fileName: 'duplicate-one.mp4', hash: 'duplicate-import', notes: 'One' },
    { fileName: 'duplicate-two.mp4', hash: 'duplicate-import', notes: 'Two' },
    { fileName: 'missing-hash.mp4', hash: '', notes: 'Do not apply' },
    { fileName: 'deleted.mp4', hash: 'deleted-local', notes: 'Do not apply' },
  ]);

  const plan = buildCatalogueMetadataImportPlan(
    [firstAmbiguous, secondAmbiguous, deleted],
    json,
    ['notes'],
  );

  assert.equal(plan.entriesRead, 6);
  assert.equal(plan.ambiguousCatalogueRecordCount, 1);
  assert.equal(plan.duplicateHashRecordCount, 2);
  assert.equal(plan.missingHashRecordCount, 1);
  assert.equal(plan.unmatchedRecordCount, 2);
  assert.equal(plan.matchedRecordCount, 0);
  assert.equal(plan.changedEntryCount, 0);
  assert.equal(firstAmbiguous.notes, 'Original notes');
  assert.equal(secondAmbiguous.notes, 'Original notes');
  assert.equal(deleted.notes, 'Original notes');
});

test('invalid unselected metadata does not block a selected-category import', () => {
  const target = image();
  const json = metadataJson([{
    fileName: 'example.mp4',
    hash: 'example-hash',
    tags: ['safe'],
    year: 'not a year',
  }]);

  const tagsPlan = buildCatalogueMetadataImportPlan([target], json, ['tags']);
  applyCatalogueMetadataImportPlan(tagsPlan);
  assert.deepEqual(target.tags, ['safe']);
  assert.equal(target.year, 2020);

  assert.throws(
    () => buildCatalogueMetadataImportPlan([target], json, ['year']),
    /Year must be a non-negative whole number/,
  );
  assert.equal(target.year, 2020);
});

test('selected fields omitted from an entry remain unchanged', () => {
  const target = image({ notes: 'Keep these notes', tags: ['Keep Tag'] });
  const plan = buildCatalogueMetadataImportPlan([target], metadataJson([{
    fileName: 'example.mp4',
    hash: 'example-hash',
    tags: ['Replacement'],
  }]), ['tags', 'notes']);

  applyCatalogueMetadataImportPlan(plan);
  assert.deepEqual(target.tags, ['Replacement']);
  assert.equal(target.notes, 'Keep these notes');
});

test('rejects tag delimiters that the Catalogue Editor cannot represent safely', () => {
  assert.throws(
    () => buildCatalogueMetadataImportPlan([image()], metadataJson([{
      fileName: 'example.mp4',
      hash: 'example-hash',
      tags: ['one, two'],
    }]), ['tags']),
    /cannot contain commas or line breaks/,
  );
});

test('ignores corrupt non-text catalogue hashes instead of throwing', () => {
  const corrupt = image({ hash: 42 as unknown as string });
  const plan = buildCatalogueMetadataImportPlan([corrupt], metadataJson([{
    fileName: 'example.mp4',
    hash: '42',
    notes: 'Must not apply',
  }]), ['notes']);

  assert.equal(plan.unmatchedRecordCount, 1);
  assert.equal(plan.changedEntryCount, 0);
  assert.equal(corrupt.notes, 'Original notes');
});

test('a matching filename never substitutes for a matching hash', () => {
  const target = image({ fileName: 'same-name.mp4', hash: 'local-hash' });
  const plan = buildCatalogueMetadataImportPlan([target], metadataJson([{
    fileName: 'same-name.mp4',
    hash: 'different-hash',
    notes: 'Must not apply',
  }]), ['notes']);

  assert.equal(plan.unmatchedRecordCount, 1);
  assert.equal(plan.changedEntryCount, 0);
  assert.equal(target.notes, 'Original notes');
});
