import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { privateVideoRevision } from './private-hub-metadata';
import { createPrivatePreviewSet } from './private-hub-preview-set';
import { checkPrivateVideoRefresh, createPrivateRefreshedVideo, snapshotPrivateVideoRefreshUpdate } from './private-video-refresh';

function fixture() {
  const root = path.resolve(__dirname, '../tmp/synthetic-refresh-source');
  const image = { ...NewImageElement(), hash: 'old', fileName: 'video.mp4', partialPath: '/nested', screens: 3,
    cleanName: 'User title', notes: 'Keep notes', tags: ['Keep tags'], stars: 4.5 as const,
    year: 2001, lastPlayed: 1234, timesPlayed: 6, playlist: 5678, dateAdded: 9999, missing: true, defaultScreen: 1 };
  Object.assign(image, { futureMetadata: { retained: true } });
  const catalogue: FinalObject = { hubName: 'Synthetic', images: [image], inputDirs: { 0: { path: root, watch: true } },
    addTags: [], removeTags: [], numOfFolders: 1, version: 3,
    screenshotSettings: { height: 144, clipHeight: 144, fixed: true, n: 3, clipSnippets: 0, clipSnippetLength: 1 } };
  const location = { hash: 'new', root, inputSource: 0, partialPath: 'nested', fileName: 'video.mp4' };
  const update = { index: 0, revision: privateVideoRevision(image) };
  return { catalogue, image, location, update };
}

test('ready is a pure single-location check including a saved missing location', () => {
  const f = fixture(); const before = structuredClone(f.catalogue);
  assert.equal(checkPrivateVideoRefresh(f.catalogue, f.location, f.update), 'ready');
  assert.deepEqual(f.catalogue, before);
});

test('authoritative one-location arrays and normalized relative spelling are supported', () => {
  const f = fixture();
  f.image.locations = [{ fileName: f.image.fileName, inputSource: 0, partialPath: 'nested', missing: true }];
  f.update.revision = privateVideoRevision(f.image);
  assert.equal(checkPrivateVideoRefresh(f.catalogue, f.location, f.update), 'ready');
});

for (const change of ['revision', 'index', 'root', 'source', 'file', 'path', 'old-hash', 'new-hash'] as const) {
  test(`changed ${change} cannot refresh the reviewed row`, () => {
    const f = fixture();
    if (change === 'revision') { f.image.notes = 'New notes'; }
    if (change === 'index') { f.update.index = 1; }
    if (change === 'root') { f.catalogue.inputDirs[0].path += '-other'; }
    if (change === 'source') { f.location.inputSource = 1; }
    if (change === 'file') { f.location.fileName = 'different.mp4'; }
    if (change === 'path') { f.location.partialPath = 'different'; }
    if (change === 'old-hash') { f.catalogue.images.push({ ...f.image, deleted: true }); }
    if (change === 'new-hash') { f.catalogue.images.push({ ...f.image, hash: f.location.hash, deleted: true }); }
    assert.equal(checkPrivateVideoRefresh(f.catalogue, f.location, f.update), 'conflict');
  });
}

for (const change of ['alias', 'deleted', 'folder', 'ignored', 'malformed-path', 'reused-hash'] as const) {
  test(`${change} is refused without expanding source access`, () => {
    const f = fixture();
    if (change === 'alias') { f.image.locations = [
      { fileName: 'video.mp4', partialPath: '/nested', inputSource: 0 },
      { fileName: 'other.mp4', partialPath: '/nested', inputSource: 0 },
    ]; }
    if (change === 'deleted') { f.image.deleted = true; }
    if (change === 'folder') { f.image.cleanName = '*FOLDER*'; }
    if (change === 'ignored') { f.catalogue.inputDirs[0].ignoredSubdirectories = ['nested']; }
    if (change === 'malformed-path') { f.location.partialPath = '../outside'; }
    if (change === 'reused-hash') { f.location.hash = f.image.hash; }
    f.update.revision = privateVideoRevision(f.image);
    assert.equal(checkPrivateVideoRefresh(f.catalogue, f.location, f.update), change === 'reused-hash' ? 'conflict' : 'invalid');
  });
}

test('request snapshot refuses getters, extras, symbols and malformed numeric/revision fields', () => {
  let getters = 0;
  const accessor = { get index() { getters++; return 0; }, revision: 'a'.repeat(64) };
  for (const value of [null, [], accessor, { index: -1, revision: 'a'.repeat(64) },
    { index: 1.5, revision: 'a'.repeat(64) }, { index: 0, revision: 'bad' },
    { index: 0, revision: 'a'.repeat(64), extra: true }, { index: 0, revision: 'a'.repeat(64), [Symbol('extra')]: 1 }]) {
    assert.equal(snapshotPrivateVideoRefreshUpdate(value), undefined);
  }
  assert.equal(getters, 0);
  const input = { index: 0, revision: 'a'.repeat(64) };
  const result = snapshotPrivateVideoRefreshUpdate(input)!;
  input.index = 1;
  assert.equal(result.index, 0); assert.equal(Object.isFrozen(result), true);
});

test('replacement changes only bounded technical metadata and preserves raw user and unknown fields', () => {
  const f = fixture(); const before = structuredClone(f.image);
  const source = { hash: f.location.hash, byteLength: 2_000_000, birthtime: 123.4, mtime: 456.6 };
  const metadata = { width: 640, height: 360, duration: 10, fps: 23.976, hasAudio: true };
  const set = createPrivatePreviewSet(f.location.hash, 256, 144, 4, true);
  const result = createPrivateRefreshedVideo(f.image, source, f.location, metadata, set);
  assert.deepEqual(result, { ...before, hash: source.hash, fileSize: source.byteLength, birthtime: 123, mtime: 457,
    duration: 10, width: 640, height: 360, fps: 23.976, bitrate: 0.2, screens: 4 });
  assert.deepEqual(f.image, before);
});

for (const defaultScreen of [-1, 4, 99, 1.5, Number.NaN, undefined, 0, 3]) {
  test(`default-screen selection ${defaultScreen} fits the new geometry or is cleared`, () => {
    const f = fixture(); f.image.defaultScreen = defaultScreen as number;
    const result = createPrivateRefreshedVideo(f.image,
      { hash: f.location.hash, byteLength: 100, birthtime: 1, mtime: 2 }, f.location,
      { width: 160, height: 90, duration: 3, fps: 30, hasAudio: false }, createPrivatePreviewSet(f.location.hash, 256, 144, 4, false));
    if (defaultScreen === 0 || defaultScreen === 3) { assert.equal(result.defaultScreen, defaultScreen); }
    else { assert.equal(result.defaultScreen, undefined); }
  });
}

test('unbounded probe metadata and mismatched generated namespaces are rejected', () => {
  const f = fixture();
  const source = { hash: f.location.hash, byteLength: 100, birthtime: 1, mtime: 2 };
  const metadata = { width: 160, height: 90, duration: 3, fps: 30, hasAudio: false };
  const set = createPrivatePreviewSet(f.location.hash, 256, 144, 4, false);
  assert.throws(() => createPrivateRefreshedVideo(f.image, source, f.location, { ...metadata, width: Infinity }, set));
  assert.throws(() => createPrivateRefreshedVideo(f.image, { ...source, byteLength: 0 }, f.location, metadata, set));
  assert.throws(() => createPrivateRefreshedVideo(f.image, source, f.location, metadata, { ...set, hash: 'wrong' }));
});
