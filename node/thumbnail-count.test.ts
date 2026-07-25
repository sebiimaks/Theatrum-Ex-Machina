import { strict as assert } from 'assert';
import { test } from 'node:test';

import type { ScreenshotSettings } from '../interfaces/final-object.interface';
import { NewImageElement } from '../interfaces/final-object.interface';
import {
  applyRegeneratedScreenshotCount,
  calculateScreenshotCount,
  isActiveThumbnailRegenerationJob,
  prepareThumbnailRegeneration,
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
  assert.equal(calculateScreenshotCount(settings({ height: 504, n: 100 }), 1000), 73);
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
