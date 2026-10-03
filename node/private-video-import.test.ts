import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { createPrivatePreviewSet } from './private-hub-preview-set';
import { checkPrivateVideoImport, createPrivateImportedVideo, snapshotPrivateVideoImportLocation } from './private-video-import';

const root = path.resolve(__dirname, '../tmp/import-helper-source');
const location = { root, inputSource: 0, partialPath: '/nested', fileName: 'new_video.mp4', hash: 'fresh-private-hash' };
const source = { hash: location.hash, byteLength: 100_000, birthtime: 1_000.5, mtime: 2_000.25 };
const metadata = { duration: 2.5, width: 160, height: 90, hasAudio: false, fps: 29.97 };
const set = createPrivatePreviewSet(source.hash, 256, 144, 3, false);
function catalogue(): FinalObject {
  return { images: [], inputDirs: { 0: { path: root, watch: false } }, addTags: [], removeTags: [], version: 3,
    numOfFolders: 1, hubName: 'Synthetic import', screenshotSettings: { clipHeight: 144, clipSnippetLength: 1,
      clipSnippets: 0, fixed: true, height: 144, n: 3 } };
}

test('location snapshot copies and freezes canonical main-only data', () => {
  const original = { ...location, partialPath: 'nested/' };
  const result = snapshotPrivateVideoImportLocation(original);
  original.fileName = 'changed.mp4';
  assert.equal(result.fileName, location.fileName);
  assert.equal(result.partialPath, '/nested');
  assert.equal(Object.isFrozen(result), true);
});

for (const patch of [
  { hash: '../escape' }, { root: 'relative' }, { root: path.parse(root).root }, { root: root + '\0' },
  { fileName: '..' }, { fileName: 'a/b' }, { fileName: 'a\\b' }, { partialPath: '../out' },
  { partialPath: 'nested/../../out' }, { inputSource: -1 }, { inputSource: 0.5 },
]) {
  test(`location snapshot rejects malformed ${Object.keys(patch).join(',')}: ${JSON.stringify(patch)}`, () => {
    assert.throws(() => snapshotPrivateVideoImportLocation({ ...location, ...patch }), /Private video import is unavailable/);
  });
}

test('valid fresh location is accepted without modifying catalogue settings or rows', () => {
  const data = catalogue();
  const before = structuredClone(data);
  assert.equal(checkPrivateVideoImport(data, location), 'ready');
  assert.deepEqual(data, before);
});

test('changed and missing saved roots conflict', () => {
  const data = catalogue();
  data.inputDirs[0].path += '-elsewhere';
  assert.equal(checkPrivateVideoImport(data, location), 'conflict');
  delete data.inputDirs[0];
  assert.equal(checkPrivateVideoImport(data, location), 'conflict');
});

test('ignored folder and descendants reject import but similarly named siblings do not', () => {
  const data = catalogue();
  data.inputDirs[0].ignoredSubdirectories = ['nested'];
  assert.equal(checkPrivateVideoImport(data, location), 'invalid');
  assert.equal(checkPrivateVideoImport(data, { ...location, partialPath: '/nested/child' }), 'invalid');
  assert.equal(checkPrivateVideoImport(data, { ...location, partialPath: '/nested-other' }), 'ready');
});

test('duplicate preferred and secondary locations are refused even when missing', () => {
  const data = catalogue();
  data.images.push({ ...NewImageElement(), hash: 'existing', cleanName: 'Existing', fileName: location.fileName,
    partialPath: location.partialPath, missing: true });
  assert.equal(checkPrivateVideoImport(data, location), 'duplicate');
  data.images[0].locations = [
    { inputSource: 0, partialPath: '', fileName: 'other.mp4' },
    { inputSource: 0, partialPath: location.partialPath, fileName: location.fileName, missing: true },
  ];
  assert.equal(checkPrivateVideoImport(data, location), 'duplicate');
});

test('overlapping roots resolve to the same duplicate without a filesystem lookup', () => {
  const data = catalogue();
  data.inputDirs[1] = { path: path.join(root, 'nested'), watch: true };
  data.images.push({ ...NewImageElement(), hash: 'existing', cleanName: 'Existing', inputSource: 1,
    fileName: location.fileName, partialPath: '' });
  assert.equal(checkPrivateVideoImport(data, location), 'duplicate');
});

for (const patch of [{}, { deleted: true }, { cleanName: '*FOLDER*' }]) {
  test(`preview hash collision conflicts for row ${JSON.stringify(patch)}`, () => {
    const data = catalogue();
    data.images.push({ ...NewImageElement(), hash: location.hash, fileName: 'different.mp4', ...patch });
    assert.equal(checkPrivateVideoImport(data, location), 'conflict');
  });
}

test('new row records probe/stat metadata and retains neutral user metadata defaults', () => {
  const image = createPrivateImportedVideo(source, location, metadata, set, 7, 123456);
  assert.equal(image.cleanName, 'new video');
  assert.equal(image.fileName, location.fileName);
  assert.equal(image.duration, 2.5);
  assert.equal(image.fps, 29.97);
  assert.equal(image.screens, 3);
  assert.equal(image.fileSize, 100_000);
  assert.equal(image.bitrate, 0.04);
  assert.equal(image.birthtime, 1001);
  assert.equal(image.mtime, 2000);
  assert.equal(image.dateAdded, 123456);
  assert.equal(image.index, 7);
  assert.equal(image.timesPlayed, 0);
  assert.equal(image.lastPlayed, 0);
  assert.equal(image.stars, 0.5);
  assert.equal(image.notes, undefined);
  assert.equal(image.tags, undefined);
  assert.equal(JSON.stringify(image).includes(root), false);
});

test('display names strip control whitespace and cannot become folder sentinels', () => {
  assert.equal(createPrivateImportedVideo(source, { ...location, fileName: 'new_\n\tvideo.mp4' }, metadata, set, 0).cleanName, 'new video');
  assert.equal(createPrivateImportedVideo(source, { ...location, fileName: '*FOLDER*.mp4' }, metadata, set, 0).cleanName, 'Video');
  assert.equal(createPrivateImportedVideo(source, { ...location, fileName: 'no_extension' }, metadata, set, 0).cleanName, 'no extension');
});

for (const patch of [{ byteLength: 0 }, { byteLength: Infinity }, { birthtime: NaN }, { mtime: -1 }, { hash: 'wrong' }]) {
  test(`invalid captured metadata ${Object.keys(patch).join(',')} cannot create a row`, () => {
    assert.throws(() => createPrivateImportedVideo({ ...source, ...patch }, location, metadata, set, 0));
  });
}
for (const patch of [{ duration: 0 }, { width: 0 }, { height: Infinity }, { fps: -1 }, { fps: NaN }]) {
  test(`invalid probe metadata ${JSON.stringify(patch)} cannot create a row`, () => {
    assert.throws(() => createPrivateImportedVideo(source, location, { ...metadata, ...patch }, set, 0));
  });
}
