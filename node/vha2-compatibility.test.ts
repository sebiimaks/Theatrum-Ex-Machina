import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FinalObject, ImageElement } from '../interfaces/final-object.interface.ts';
import { NewImageElement } from '../interfaces/final-object.interface.ts';
import { projectFinalObjectForVha2Export } from '../interfaces/vha2-compatibility.ts';

function image(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    ...NewImageElement(),
    birthtime: 10,
    bitrate: 20,
    cleanName: 'Camera repair',
    defaultScreen: 3,
    duration: 120,
    fileName: 'stale-name.mp4',
    fileSize: 1_000,
    fps: 25,
    hash: 'abc123',
    height: 1080,
    inputSource: 0,
    lastPlayed: 1_700_000_000_001,
    mtime: 30,
    notes: 'Preserve this note',
    partialPath: '/Stale',
    playlist: 1_700_000_000_002,
    screens: 12,
    stars: 4.5,
    tags: ['camera', 'repair'],
    timesPlayed: 9,
    width: 1920,
    year: 1984,
    ...overrides,
  };
}

function catalogue(overrides: Partial<FinalObject> = {}): FinalObject {
  return {
    addTags: ['new'],
    hubName: 'Archive',
    images: [image()],
    inputDirs: {
      0: {
        ignoredSubdirectories: ['/Private'],
        path: '/Volumes/Primary',
        watch: true,
      },
      1: {
        ignoredSubdirectories: ['/Temporary'],
        path: '/Volumes/Mirror',
        watch: false,
      },
    },
    numOfFolders: 2,
    removeTags: ['old'],
    screenshotSettings: {
      clipHeight: 144,
      clipSnippetLength: 1,
      clipSnippets: 0,
      fixed: true,
      height: 288,
      n: 12,
    },
    tagColors: { camera: '#abcdef' },
    tagDefinitions: ['camera', 'unassigned'],
    version: 99,
    ...overrides,
  };
}

test('projects a deep-cloned Video Hub App version-3 catalogue', () => {
  const original = catalogue({
    images: [image({
      dateAdded: 1_700_000_000_000,
      locations: [
        {
          fileName: 'offline.mp4',
          inputSource: 0,
          missing: true,
          partialPath: '\\Offline\\Camera\\',
        },
        {
          fileName: 'camera.mp4',
          inputSource: 1,
          partialPath: '\\Available\\./Repair/',
        },
      ],
      metadataImportFailed: true,
      missing: true,
    })],
  });
  const before = JSON.stringify(original);

  const projected = projectFinalObjectForVha2Export(original);

  assert.equal(JSON.stringify(original), before, 'projection must not mutate the live catalogue');
  assert.notEqual(projected, original);
  assert.equal(projected.version, 3);
  assert.equal('tagDefinitions' in projected, false);
  assert.deepEqual(projected.inputDirs, {
    0: { path: '/Volumes/Primary', watch: true },
    1: { path: '/Volumes/Mirror', watch: false },
  });
  assert.deepEqual(projected.tagColors, { camera: '#abcdef' });

  const result = projected.images[0];
  assert.equal(result.fileName, 'camera.mp4', 'an available authoritative location is promoted');
  assert.equal(result.inputSource, 1);
  assert.equal(result.partialPath, '/Available/Repair');
  assert.equal('locations' in result, false);
  assert.equal('dateAdded' in result, false);
  assert.equal('missing' in result, false);
  assert.equal('metadataImportFailed' in result, false);
  assert.equal('durationDisplay' in result, false);
  assert.equal('fileSizeDisplay' in result, false);
  assert.equal('index' in result, false);
  assert.equal('resBucket' in result, false);
  assert.equal('resolution' in result, false);
  assert.equal('selected' in result, false);
  assert.equal('uuid' in result, false);
  assert.deepEqual({
    defaultScreen: result.defaultScreen,
    lastPlayed: result.lastPlayed,
    notes: result.notes,
    playlist: result.playlist,
    stars: result.stars,
    tags: result.tags,
    timesPlayed: result.timesPlayed,
    year: result.year,
  }, {
    defaultScreen: 3,
    lastPlayed: 1_700_000_000_001,
    notes: 'Preserve this note',
    playlist: 1_700_000_000_002,
    stars: 4.5,
    tags: ['camera', 'repair'],
    timesPlayed: 9,
    year: 1984,
  });

  result.tags?.push('changed');
  projected.inputDirs[0].path = '/Changed';
  if (projected.tagColors) {
    projected.tagColors.camera = '#000000';
  }
  assert.deepEqual(original.images[0].tags, ['camera', 'repair']);
  assert.equal(original.inputDirs[0].path, '/Volumes/Primary');
  assert.equal(original.tagColors?.camera, '#abcdef');
});

test('normalizes a legacy single-location mirror without adding fork fields', () => {
  const projected = projectFinalObjectForVha2Export(catalogue({
    images: [image({
      fileName: 'legacy.mp4',
      inputSource: 0,
      partialPath: '\\Archive\\./Masters/',
    })],
  }));

  assert.equal(projected.images[0].fileName, 'legacy.mp4');
  assert.equal(projected.images[0].inputSource, 0);
  assert.equal(projected.images[0].partialPath, '/Archive/Masters');
  assert.equal('locations' in projected.images[0], false);
});

test('omits entries pending deletion and refreshes the derived folder count', () => {
  const projected = projectFinalObjectForVha2Export(catalogue({
    images: [
      image({ fileName: 'one.mp4', partialPath: '/One' }),
      image({ deleted: true, fileName: 'deleted.mp4', partialPath: '/Two' }),
      image({ fileName: 'three.mp4', partialPath: '/One' }),
    ],
    numOfFolders: 99,
  }));

  assert.deepEqual(projected.images.map(entry => entry.fileName), ['one.mp4', 'three.mp4']);
  assert.equal(projected.numOfFolders, 1);
});

test('fails closed when source definitions are malformed', () => {
  assert.throws(
    () => projectFinalObjectForVha2Export(catalogue({ inputDirs: null as never })),
    /source folders are invalid/,
  );
  assert.throws(
    () => projectFinalObjectForVha2Export(catalogue({
      inputDirs: { 0: { path: '', watch: true } },
    })),
    /invalid path/,
  );
  assert.throws(
    () => projectFinalObjectForVha2Export(catalogue({
      inputDirs: { 0: { path: '/Videos', watch: 'yes' as never } },
    })),
    /invalid watch setting/,
  );
  assert.throws(
    () => projectFinalObjectForVha2Export(catalogue({
      inputDirs: { '-1': { path: '/Videos', watch: true } } as never,
    })),
    /source index/,
  );
});

test('fails closed when media locations are empty, malformed, or unconfigured', () => {
  assert.throws(
    () => projectFinalObjectForVha2Export(catalogue({
      images: [image({ locations: [] })],
    })),
    /no exportable media location/,
  );
  assert.throws(
    () => projectFinalObjectForVha2Export(catalogue({
      images: [image({ locations: 'invalid' as never })],
    })),
    /invalid media locations/,
  );
  assert.throws(
    () => projectFinalObjectForVha2Export(catalogue({
      images: [image({
        locations: [{ fileName: '../escape.mp4', inputSource: 0, partialPath: '/' }],
      })],
    })),
    /invalid media locations/,
  );
  assert.throws(
    () => projectFinalObjectForVha2Export(catalogue({
      images: [image({
        locations: [{ fileName: 'video.mp4', inputSource: 7, partialPath: '/' }],
      })],
    })),
    /references missing source 7/,
  );
});
