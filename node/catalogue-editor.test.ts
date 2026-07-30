import { strict as assert } from 'assert';
import { test } from 'node:test';

import type { ImageElement } from '../interfaces/final-object.interface';
import { NewImageElement } from '../interfaces/final-object.interface';
import { parseDateAddedInput } from '../interfaces/date-added';
import {
  applyCatalogueOverwrite,
  filterCatalogueEntries,
  validateCatalogueOverwrite,
} from '../src/app/components/catalogue-editor/catalogue-editor.logic';

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

test('combines non-empty search lines as narrowing criteria', () => {
  const first = image({ cleanName: 'Alpine Walk', tags: ['travel', 'blue'] });
  const second = image({ cleanName: 'Alpine Lake', tags: ['travel', 'green'], index: 2 });
  const third = image({ cleanName: 'City Walk', tags: ['blue'], index: 3 });

  const results = filterCatalogueEntries([
    first,
    second,
    third,
  ], [
    { field: 'name', id: 0, query: 'alpine' },
    { field: 'tags', id: 1, query: 'blue' },
    { field: 'hash', id: 2, query: '   ' },
  ], false);

  assert.deepEqual(results, [first]);
});

test('keeps deleted entries hidden unless explicitly requested', () => {
  const active = image({ cleanName: 'Active' });
  const deleted = image({ cleanName: 'Deleted', deleted: true, index: 2 });
  const criteria = [{ field: 'all' as const, id: 0, query: '' }];

  assert.deepEqual(filterCatalogueEntries([active, deleted], criteria, false), [active]);
  assert.deepEqual(filterCatalogueEntries([active, deleted], criteria, true), [active, deleted]);
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
