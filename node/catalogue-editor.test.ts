import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';

import type { ImageElement } from '../interfaces/final-object.interface';
import { NewImageElement } from '../interfaces/final-object.interface';
import { parseDateAddedInput } from '../interfaces/date-added';
import {
  applyCatalogueOverwrite,
  filterCatalogueEntries,
  resolveMetadataImportSaveNotice,
  validateCatalogueOverwrite,
} from '../src/app/components/catalogue-editor/catalogue-editor.logic';
import type { CatalogueSearchField } from '../src/app/components/catalogue-editor/catalogue-editor.logic';

test('places the search operator before the query and field controls', () => {
  const template = readFileSync(
    join(__dirname, '../src/app/components/catalogue-editor/catalogue-editor.component.html'),
    'utf8',
  );
  const operatorPosition = template.indexOf('class="catalogue-search-operator"');
  const queryPosition = template.indexOf('class="catalogue-search"');
  const fieldPosition = template.indexOf('class="catalogue-search-field"');

  assert.ok(operatorPosition >= 0);
  assert.ok(queryPosition > operatorPosition);
  assert.ok(fieldPosition > queryPosition);
});

test('search dropdown exposes every editable and displayed entry field', () => {
  const template = readFileSync(
    join(__dirname, '../src/app/components/catalogue-editor/catalogue-editor.component.html'),
    'utf8',
  );
  const options: [CatalogueSearchField, string][] = [
    ['all', 'All Fields'],
    ['name', 'Clean Name'],
    ['file', 'File Name'],
    ['path', 'Folder'],
    ['tags', 'Tags'],
    ['stars', 'Stars'],
    ['year', 'Year'],
    ['dateAdded', 'Date Added'],
    ['timesPlayed', 'Times Played'],
    ['defaultScreen', 'Default Screen'],
    ['notes', 'Notes'],
    ['entryNumber', 'Entry Number'],
    ['source', 'Source'],
    ['duration', 'Duration'],
    ['resolution', 'Resolution'],
    ['fileSize', 'File Size'],
    ['fps', 'FPS'],
    ['hash', 'Hash'],
    ['status', 'Status'],
  ];

  options.forEach(([value, label]) => {
    assert.ok(
      template.includes(`<option value="${value}">${label}</option>`),
      `${label} is missing from the search dropdown`,
    );
  });
});

test('metadata import save notices clear only after a confirmed save and retain failures', () => {
  const summary = "Imported 2 metadata values into 1 entry from 'metadata.json'";

  assert.equal(resolveMetadataImportSaveNotice('', summary), undefined);
  assert.equal(resolveMetadataImportSaveNotice('Unsaved Changes', summary), undefined);
  assert.deepEqual(resolveMetadataImportSaveNotice('Saved', summary), {
    complete: true,
    error: false,
    message: '',
  });
  assert.deepEqual(resolveMetadataImportSaveNotice('Save failed: disk full', summary), {
    complete: false,
    error: true,
    message: `${summary}. Changes remain unsaved. Save failed: disk full.`,
  });
});

test('metadata import template exposes a preview-only diff workflow', () => {
  const template = readFileSync(
    join(__dirname, '../src/app/components/catalogue-editor/catalogue-editor.component.html'),
    'utf8',
  );

  assert.match(template, /Apply Reviewed Metadata/);
  assert.match(template, /Preview Selected Metadata/);
  assert.match(template, /catalogue-field-pending-change/);
  assert.match(template, /Proposed Changes/);
  assert.match(template, /metadataChangesFor\(item\)/);
});

test('validates catalogue location edits before mutating saved paths', () => {
  const component = readFileSync(
    join(__dirname, '../src/app/components/catalogue-editor/catalogue-editor.component.ts'),
    'utf8',
  );
  const template = readFileSync(
    join(__dirname, '../src/app/components/catalogue-editor/catalogue-editor.component.html'),
    'utf8',
  );

  assert.match(component, /normalizeImageLocation\(\{/);
  assert.match(component, /updatePreferredImageLocationFields\(item, \{ \[field\]: normalizedValue \}\)/);
  assert.match(component, /Enter a file name without folder separators\./);
  assert.match(component, /Enter a folder inside the configured video location\./);
  assert.match(template, /\[attr\.aria-invalid\]="locationFieldErrorFor\(item, 'fileName'\)/);
  assert.match(template, /\[attr\.aria-invalid\]="locationFieldErrorFor\(item, 'partialPath'\)/);
});

test('metadata import is scoped to the entries displayed by the active filters', () => {
  const component = readFileSync(
    join(__dirname, '../src/app/components/catalogue-editor/catalogue-editor.component.ts'),
    'utf8',
  );
  const template = readFileSync(
    join(__dirname, '../src/app/components/catalogue-editor/catalogue-editor.component.html'),
    'utf8',
  );
  const scopedPlanCalls = component.match(
    /buildCatalogueMetadataImportPlan\(\s*this\.images,\s*this\.metadataImportJson,\s*(?:categories|this\.selectedMetadataCategories),\s*this\.metadataImportScope,/g,
  ) || [];

  assert.match(component, /const filteredImportScope = this\.filteredEntries\.filter\(isCatalogueMetadataImportTarget\);/);
  assert.match(component, /this\.metadataImportScope = filteredImportScope;/);
  assert.equal(scopedPlanCalls.length, 3);
  assert.match(template, /Only entries displayed when Import Metadata was selected are eligible for import\./);
  assert.match(template, /metadataImportScopeCount/);
});

function image(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    ...NewImageElement(),
    cleanName: 'Example Video',
    fileName: 'example.mp4',
    hash: 'example-hash',
    index: 1,
    screens: 4,
    ...overrides,
  };
}

test('searches every editable and displayed entry field using human-readable values', () => {
  const target = image({
    cleanName: 'Reference Master',
    dateAdded: new Date(2026, 7, 4, 12, 34).getTime(),
    defaultScreen: 3,
    duration: 176,
    fileName: 'reference-master.mov',
    fileSize: 3900000000,
    fps: 24,
    hash: 'target-hash-abc',
    height: 2160,
    index: 6,
    inputSource: 2,
    metadataImportFailed: true,
    notes: 'Restored lens reference',
    partialPath: '/Archive/Masters',
    resolution: '4K',
    stars: 4.5,
    tags: ['Camera Archive'],
    timesPlayed: 12,
    width: 3840,
    year: 2026,
  });
  const other = image({
    cleanName: 'Unrelated Video',
    duration: 61,
    fileName: 'unrelated.mp4',
    fileSize: 1000000,
    fps: 30,
    hash: 'other-hash',
    height: 720,
    index: 40,
    inputSource: 9,
    notes: 'Different notes',
    partialPath: '/Other',
    resolution: '720',
    tags: ['Other Tag'],
    width: 1280,
  });
  const cases: [CatalogueSearchField, string][] = [
    ['name', 'reference master'],
    ['file', '.mov'],
    ['path', 'archive/masters'],
    ['tags', 'camera archive'],
    ['stars', '4 stars'],
    ['year', '2026'],
    ['dateAdded', '2026-08-04 12:34'],
    ['timesPlayed', '12 times played'],
    ['defaultScreen', '3'],
    ['notes', 'restored lens'],
    ['entryNumber', '#7'],
    ['source', 'source 2'],
    ['duration', '02:56'],
    ['resolution', '3840 x 2160'],
    ['resolution', '4k'],
    ['fileSize', '3.9 gb'],
    ['fps', '24 fps'],
    ['hash', 'target-hash'],
    ['status', 'import error'],
    ['all', '3.9 gb'],
  ];

  cases.forEach(([field, query], id) => {
    assert.deepEqual(filterCatalogueEntries([target, other], [{
      field,
      id,
      operator: 'contains',
      query,
    }], false), [target], `${field} did not match '${query}' correctly`);
  });

  assert.deepEqual(filterCatalogueEntries([target], [{
    field: 'stars',
    id: 99,
    operator: 'contains',
    query: '4.5',
  }], false), [], 'search exposed the internal half-star representation');

  assert.deepEqual(filterCatalogueEntries([target, other], [{
    field: 'dateAdded',
    id: 100,
    operator: 'contains',
    query: 'not set',
  }], false), [other], 'missing Date Added did not use the shared not-set alias');
});

test('All Fields does not create matches across separate field boundaries', () => {
  const target = image({
    cleanName: 'Boundary Alpha',
    fileName: 'Beta.mp4',
  });

  assert.deepEqual(filterCatalogueEntries([target], [{
    field: 'all',
    id: 0,
    operator: 'contains',
    query: 'alpha beta',
  }], false), []);
});

test('combines non-empty search lines as narrowing criteria', () => {
  const first = image({ cleanName: 'Alpine Walk', tags: ['travel', 'blue'] });
  const second = image({ cleanName: 'Alpine Lake', tags: ['travel', 'green'], index: 2 });
  const third = image({ cleanName: 'City Walk', tags: ['blue'], index: 3 });

  const results = filterCatalogueEntries([
    first,
    second,
    third,
  ], [
    { field: 'name', id: 0, operator: 'contains', query: 'alpine' },
    { field: 'tags', id: 1, operator: 'contains', query: 'blue' },
    { field: 'hash', id: 2, operator: 'doesNotContain', query: '   ' },
  ], false);

  assert.deepEqual(results, [first]);
});

test('supports contains and does not contain as combined case-insensitive criteria', () => {
  const first = image({ cleanName: 'Forest Walk', tags: ['Travel', 'green'] });
  const second = image({ cleanName: 'Forest Drive', tags: ['travel', 'green'], index: 2 });
  const third = image({ cleanName: 'City Walk', tags: ['travel', 'BLUE'], index: 3 });

  const results = filterCatalogueEntries([
    first,
    second,
    third,
  ], [
    { field: 'name', id: 0, operator: 'contains', query: 'WALK' },
    { field: 'tags', id: 1, operator: 'doesNotContain', query: 'blue' },
  ], false);

  assert.deepEqual(results, [first]);
});

test('applies does not contain across all searchable fields and includes missing values', () => {
  const first = image({ notes: 'Private reference' });
  const second = image({ index: 2, notes: 'Public reference' });
  const third = image({ index: 3 });

  const results = filterCatalogueEntries([
    first,
    second,
    third,
  ], [
    { field: 'all', id: 0, operator: 'doesNotContain', query: 'PRIVATE' },
  ], false);

  assert.deepEqual(results, [second, third]);
});

test('keeps deleted entries hidden unless explicitly requested', () => {
  const active = image({ cleanName: 'Active' });
  const deleted = image({ cleanName: 'Deleted', deleted: true, index: 2 });
  const criteria = [{ field: 'all' as const, id: 0, operator: 'contains' as const, query: '' }];

  assert.deepEqual(filterCatalogueEntries([active, deleted], criteria, false), [active]);
  assert.deepEqual(filterCatalogueEntries([active, deleted], criteria, true), [active, deleted]);
});

test('filters temporarily unavailable entries without mutating their metadata', () => {
  const available = image({ cleanName: 'Available', notes: 'Keep available metadata' });
  const missing = image({
    cleanName: 'Temporarily unavailable',
    index: 2,
    missing: true,
    notes: 'Keep missing metadata',
    tags: ['important'],
  });
  const anotherMissing = image({ cleanName: 'Other unavailable', index: 3, missing: true });
  const deletedMissing = image({ cleanName: 'Deleted unavailable', deleted: true, index: 4, missing: true });
  const criteria = [{ field: 'all' as const, id: 0, operator: 'contains' as const, query: '' }];

  const entries = [available, missing, anotherMissing, deletedMissing];

  assert.deepEqual(filterCatalogueEntries(entries, criteria, false, 'all'), [available, missing, anotherMissing]);
  assert.deepEqual(filterCatalogueEntries(entries, criteria, false, 'available'), [available]);
  assert.deepEqual(filterCatalogueEntries(entries, criteria, true, 'missing'), [missing, anotherMissing]);
  assert.deepEqual(filterCatalogueEntries(entries, [{
    field: 'tags',
    id: 0,
    operator: 'contains',
    query: 'IMPORTANT',
  }], false, 'missing'), [missing]);
  assert.deepEqual(missing.tags, ['important']);
  assert.equal(missing.notes, 'Keep missing metadata');
});

test('validates strict non-negative integers and optional field clearing', () => {
  const entries = [image()];

  assert.equal(validateCatalogueOverwrite('timesPlayed', '', entries).valid, false);
  assert.equal(validateCatalogueOverwrite('timesPlayed', '-1', entries).valid, false);
  assert.equal(validateCatalogueOverwrite('timesPlayed', '1.5', entries).valid, false);
  assert.deepEqual(validateCatalogueOverwrite('timesPlayed', '12', entries), {
    action: 'overwrite',
    displayValue: '12',
    valid: true,
    value: 12,
  });
  assert.deepEqual(validateCatalogueOverwrite('year', '', entries), {
    action: 'clear',
    displayValue: 'Clear Field',
    valid: true,
    value: undefined,
  });
});

test('rejects a default screen missing from any displayed entry', () => {
  const entries = [
    image({ screens: 5 }),
    image({ index: 2, screens: 2 }),
  ];

  assert.equal(validateCatalogueOverwrite('defaultScreen', '2', entries).valid, false);
  assert.equal(validateCatalogueOverwrite('defaultScreen', '1', entries).valid, true);
});

test('validates names, notes, and the internal star-rating values', () => {
  const entries = [image()];

  assert.equal(validateCatalogueOverwrite('cleanName', '   ', entries).valid, false);
  assert.deepEqual(validateCatalogueOverwrite('cleanName', '  Shared Name  ', entries), {
    action: 'overwrite',
    displayValue: 'Shared Name',
    valid: true,
    value: 'Shared Name',
  });
  assert.deepEqual(validateCatalogueOverwrite('notes', '   ', entries), {
    action: 'clear',
    displayValue: 'Clear Field',
    valid: true,
    value: undefined,
  });
  assert.deepEqual(validateCatalogueOverwrite('notes', 'Line one\nLine two', entries), {
    action: 'overwrite',
    displayValue: 'Line one\nLine two',
    valid: true,
    value: 'Line one\nLine two',
  });
  assert.equal(validateCatalogueOverwrite('stars', '5', entries).valid, false);
  assert.deepEqual(validateCatalogueOverwrite('stars', '5.5', entries), {
    action: 'overwrite',
    displayValue: '5',
    valid: true,
    value: 5.5,
  });
});

test('overwrites only changed entries and can clear optional fields', () => {
  const first = image({ timesPlayed: 2, year: 2020 });
  const second = image({ index: 2, timesPlayed: 5, year: 2020 });

  assert.equal(applyCatalogueOverwrite([first, second], 'timesPlayed', 5), 1);
  assert.equal(first.timesPlayed, 5);
  assert.equal(second.timesPlayed, 5);

  assert.equal(applyCatalogueOverwrite([first, second], 'year', undefined), 2);
  assert.equal(first.year, undefined);
  assert.equal(second.year, undefined);
  assert.equal(applyCatalogueOverwrite([first, second], 'year', undefined), 0);

  assert.equal(applyCatalogueOverwrite([first, second], 'stars', 5.5), 2);
  assert.equal(first.stars, 5.5);
  assert.equal(second.stars, 5.5);
});

test('validates and applies an editable Date Added value', () => {
  const first = image();
  const second = image({ index: 2 });
  const draft = '2026-07-30T14:45';
  const timestamp = parseDateAddedInput(draft);

  assert.equal(typeof timestamp, 'number');
  assert.equal(validateCatalogueOverwrite('dateAdded', '2026-02-30T12:00', [first]).valid, false);
  assert.deepEqual(validateCatalogueOverwrite('dateAdded', '', [first]), {
    action: 'clear',
    displayValue: 'Clear Field',
    valid: true,
    value: undefined,
  });

  const validation = validateCatalogueOverwrite('dateAdded', draft, [first, second]);
  assert.equal(validation.valid, true);
  assert.equal(validation.value, timestamp);
  assert.match(validation.displayValue, /2026/);

  assert.equal(applyCatalogueOverwrite([first, second], 'dateAdded', timestamp as number), 2);
  assert.equal(first.dateAdded, timestamp);
  assert.equal(second.dateAdded, timestamp);
  assert.equal(applyCatalogueOverwrite([first, second], 'dateAdded', timestamp as number), 0);
  assert.equal(applyCatalogueOverwrite([first, second], 'dateAdded', undefined), 2);
  assert.equal(first.dateAdded, undefined);
  assert.equal(second.dateAdded, undefined);
});
