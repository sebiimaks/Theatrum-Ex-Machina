import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';

import type { SupportedView } from '../interfaces/shared-interfaces';
import {
  calculateGalleryGeometry,
  calculateGalleryTextPadding,
} from '../src/app/common/gallery-layout';

const baseGeometry = {
  compactView: false,
  containerWidth: 1014,
  currentPreviewWidth: 321,
  imagesPerRow: 5,
  relatedTrayVisible: false,
} as const;

test('standard and compact card views retain their established margin policy', () => {
  for (const view of ['showThumbnails', 'showClips', 'showDetails', 'showDetails2'] as SupportedView[]) {
    assert.deepEqual(calculateGalleryGeometry({ ...baseGeometry, view }), {
      galleryWidth: 1000,
      previewHeight: 90,
      previewWidth: 160,
    });
    assert.deepEqual(calculateGalleryGeometry({
      ...baseGeometry,
      compactView: true,
      view,
    }), {
      galleryWidth: 1000,
      previewHeight: 110.25,
      previewWidth: 196,
    });
  }
});

test('filmstrip and full view retain their inset-based geometry', () => {
  for (const view of ['showFilmstrip', 'showFullView'] as SupportedView[]) {
    for (const compactView of [false, true]) {
      assert.deepEqual(calculateGalleryGeometry({ ...baseGeometry, compactView, view }), {
        galleryWidth: 1000,
        previewHeight: 109.125,
        previewWidth: 194,
      });
    }
  }
});

test('file view keeps the previous width while refreshing its paired height', () => {
  assert.deepEqual(calculateGalleryGeometry({ ...baseGeometry, view: 'showFiles' }), {
    galleryWidth: 1000,
    previewHeight: 180.5625,
  });
  assert.deepEqual(calculateGalleryGeometry({
    ...baseGeometry,
    currentPreviewWidth: undefined,
    view: 'showFiles',
  }), {
    galleryWidth: 1000,
  });
  assert.deepEqual(calculateGalleryGeometry({
    ...baseGeometry,
    currentPreviewWidth: Number.NaN,
    view: 'showFiles',
  }), {
    galleryWidth: 1000,
  });
});

test('related geometry updates only while a related tray is visible', () => {
  assert.deepEqual(
    calculateGalleryGeometry({
      ...baseGeometry,
      relatedTrayVisible: true,
      view: 'showThumbnails',
    }),
    {
      galleryWidth: 1000,
      previewHeight: 90,
      previewHeightRelated: 90,
      previewWidth: 160,
      previewWidthRelated: 160,
    },
  );

  const capped = calculateGalleryGeometry({
    ...baseGeometry,
    containerWidth: 1214,
    relatedTrayVisible: true,
    view: 'showThumbnails',
  });
  assert.equal(capped.previewWidthRelated, 176);
  assert.equal(capped.previewHeightRelated, 99);

  const narrow = calculateGalleryGeometry({
    ...baseGeometry,
    containerWidth: 100,
    relatedTrayVisible: true,
    view: 'showThumbnails',
  });
  assert.equal(narrow.previewWidthRelated, -22.8);
  assert.ok(Math.abs((narrow.previewHeightRelated || 0) - -12.825) < Number.EPSILON * 10);
});

test('transient invalid measurements retain the last stable layout', () => {
  assert.deepEqual(calculateGalleryGeometry({
    ...baseGeometry,
    containerWidth: 0,
    view: 'showThumbnails',
  }), {});
  assert.deepEqual(calculateGalleryGeometry({
    ...baseGeometry,
    imagesPerRow: 0,
    view: 'showThumbnails',
  }), {});
  assert.deepEqual(calculateGalleryGeometry({
    ...baseGeometry,
    containerWidth: Number.NaN,
    view: 'showThumbnails',
  }), {});
});

test('text padding matches compact, information, and view combinations', () => {
  for (const view of ['showThumbnails', 'showClips'] as SupportedView[]) {
    for (const showMoreInfo of [false, true]) {
      assert.equal(calculateGalleryTextPadding({ compactView: true, showMoreInfo, view }), 0);
      assert.equal(
        calculateGalleryTextPadding({ compactView: false, showMoreInfo, view }),
        showMoreInfo ? 55 : 20,
      );
    }
  }

  for (const showMoreInfo of [false, true]) {
    assert.equal(calculateGalleryTextPadding({
      compactView: true,
      showMoreInfo,
      view: 'showFilmstrip',
    }), 0);
    assert.equal(calculateGalleryTextPadding({
      compactView: false,
      showMoreInfo,
      view: 'showFilmstrip',
    }), showMoreInfo ? 20 : 0);
  }

  for (const compactView of [false, true]) {
    for (const showMoreInfo of [false, true]) {
      assert.equal(calculateGalleryTextPadding({
        compactView,
        showMoreInfo,
        view: 'showFiles',
      }), 20);
    }
  }

  for (const view of ['showDetails', 'showDetails2', 'showFullView'] as SupportedView[]) {
    for (const compactView of [false, true]) {
      for (const showMoreInfo of [false, true]) {
        assert.equal(calculateGalleryTextPadding({ compactView, showMoreInfo, view }), undefined);
      }
    }
  }
});

test('HomeComponent keeps DOM timing local and delegates only layout policy', () => {
  const component = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );
  const computeStart = component.indexOf('public computePreviewWidth(): void');
  const computeEnd = component.indexOf('/**\n   * Add search string', computeStart);
  const computeMethods = component.slice(computeStart, computeEnd);

  assert.match(computeMethods, /document\.getElementById\('scrollDiv'\)/);
  assert.match(computeMethods, /this\.galleryLayoutService\.calculateGeometry/);
  assert.match(computeMethods, /this\.galleryLayoutService\.calculateTextPadding/);
  assert.equal(computeMethods.includes('requestAnimationFrame'), false);
});
