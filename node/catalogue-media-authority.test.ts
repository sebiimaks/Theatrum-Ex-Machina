import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ImageElement } from '../interfaces/final-object.interface.ts';
import {
  addCatalogueMediaLocationAuthority,
  buildCatalogueMediaLocationAuthority,
  catalogueMediaAuthorityLocationsForHash,
  catalogueMediaAuthorityHashes,
  catalogueMediaLocationAuthorizationKey,
  removeCatalogueMediaLocationAuthority,
  removeCatalogueMediaAuthorityForSource,
  removeCatalogueMediaAuthorityForSourceScopes,
  renameCatalogueMediaLocationAuthority,
  reconcileCatalogueMediaLocationAuthority,
  requireCatalogueMediaLocationAuthority,
  retainCatalogueMediaHashAuthority,
} from './catalogue-media-authority.ts';

function item(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    birthtime: 0,
    bitrate: 0,
    cleanName: 'one',
    duration: 1,
    durationDisplay: '0:01',
    fileName: 'one.mp4',
    fileSize: 1,
    fileSizeDisplay: '1 B',
    fps: 24,
    hash: 'hash-one',
    height: 720,
    index: 0,
    inputSource: 0,
    lastPlayed: 0,
    mtime: 0,
    partialPath: '/Camera',
    resBucket: 1,
    resolution: '720',
    screens: 1,
    stars: 0.5,
    timesPlayed: 0,
    uuid: 'one',
    width: 1280,
    ...overrides,
  };
}

test('authority binds a hash to each exact catalogue location', () => {
  const source = item({
    locations: [
      { fileName: 'one.mp4', inputSource: 0, partialPath: '/Camera' },
      { fileName: 'copy.mp4', inputSource: 1, partialPath: '/Archive' },
    ],
  });
  const authority = buildCatalogueMediaLocationAuthority([source]);

  assert.equal(authority.size, 2);
  assert.doesNotThrow(() => requireCatalogueMediaLocationAuthority(authority, source));
  assert.doesNotThrow(() => requireCatalogueMediaLocationAuthority(authority, {
    ...source,
    fileName: 'copy.mp4',
    inputSource: 1,
    partialPath: '/Archive',
  }));
  assert.throws(() => requireCatalogueMediaLocationAuthority(authority, {
    ...source,
    fileName: 'unlisted.mp4',
  }), /not owned/);
  assert.throws(() => requireCatalogueMediaLocationAuthority(authority, {
    ...source,
    hash: 'different-hash',
  }), /not owned/);
});

test('trusted scanner additions, rename, and removal update exact authority', () => {
  const authority = new Set<string>();
  const source = item();
  addCatalogueMediaLocationAuthority(authority, source);
  assert.equal(authority.has(catalogueMediaLocationAuthorizationKey(source.hash, source)), true);

  renameCatalogueMediaLocationAuthority(authority, source, 'renamed.mp4');
  assert.equal(authority.has(catalogueMediaLocationAuthorizationKey(source.hash, source)), false);
  const renamed = { ...source, fileName: 'renamed.mp4' };
  assert.doesNotThrow(() => requireCatalogueMediaLocationAuthority(authority, renamed));

  removeCatalogueMediaLocationAuthority(authority, renamed);
  assert.throws(() => requireCatalogueMediaLocationAuthority(authority, renamed), /not owned/);
});

test('persisted deleted, folder, and unsafe entries never receive media or generated-preview authority', () => {
  const authority = buildCatalogueMediaLocationAuthority([
    item({ hash: 'active' }),
    item({ deleted: true, hash: 'deleted' }),
    item({ cleanName: '*FOLDER*', hash: 'folder' }),
    item({ hash: '../unsafe' }),
  ]);

  assert.equal(authority.size, 1);
  assert.deepEqual(catalogueMediaAuthorityHashes(authority), new Set(['active']));
});

test('source replacement and hash cleanup revoke only their intended locations', () => {
  const first = item();
  const second = item({
    fileName: 'two.mov',
    hash: 'hash-two',
    inputSource: 1,
    partialPath: '/Other',
  });
  const authority = buildCatalogueMediaLocationAuthority([first, second]);

  removeCatalogueMediaAuthorityForSource(authority, 0);
  assert.throws(() => requireCatalogueMediaLocationAuthority(authority, first), /not owned/);
  assert.doesNotThrow(() => requireCatalogueMediaLocationAuthority(authority, second));

  retainCatalogueMediaHashAuthority(authority, new Set());
  assert.equal(authority.size, 0);
});

test('ignored source scopes revoke nested paths while retaining siblings', () => {
  const authority = buildCatalogueMediaLocationAuthority([
    item({ hash: 'camera', partialPath: '/Camera' }),
    item({ fileName: 'nested.mp4', hash: 'nested', partialPath: '/Camera/Nested' }),
    item({ fileName: 'other.mp4', hash: 'other', partialPath: '/Other' }),
  ]);
  removeCatalogueMediaAuthorityForSourceScopes(authority, 0, ['Camera']);
  assert.deepEqual(Array.from(catalogueMediaAuthorityHashes(authority)), ['other']);
});

test('ignored source scopes preserve a shared alias and reject a source-root scope', () => {
  const shared = item({
    hash: 'shared',
    locations: [
      { fileName: 'one.mp4', inputSource: 0, partialPath: '/Camera/Nested' },
      { fileName: 'one.mp4', inputSource: 1, partialPath: '/Mirror' },
    ],
  });
  const authority = buildCatalogueMediaLocationAuthority([shared]);

  removeCatalogueMediaAuthorityForSourceScopes(authority, 0, ['Camera']);
  assert.deepEqual(catalogueMediaAuthorityHashes(authority), new Set(['shared']));
  assert.deepEqual(catalogueMediaAuthorityLocationsForHash(authority, 'shared'), [
    { fileName: 'one.mp4', inputSource: 1, partialPath: '/Mirror' },
  ]);
  assert.throws(
    () => removeCatalogueMediaAuthorityForSourceScopes(authority, 1, ['']),
    /configured source root cannot be ignored/,
  );
});

test('renderer reconciliation can revoke but cannot mint hashes or locations', () => {
  const source = item();
  const authority = buildCatalogueMediaLocationAuthority([source]);
  const hashes = new Set([source.hash]);

  assert.equal(reconcileCatalogueMediaLocationAuthority([], hashes, authority).size, 0);
  assert.throws(() => reconcileCatalogueMediaLocationAuthority([
    item({ hash: 'new-hash' }),
  ], hashes, authority), /unauthorized media item/);
  assert.throws(() => reconcileCatalogueMediaLocationAuthority([
    item({ fileName: 'other.mp4' }),
  ], hashes, authority), /unauthorized media location/);

  const alias = item({ fileName: 'alias.mp4', inputSource: 1, partialPath: '/Mirror' });
  const reconciled = reconcileCatalogueMediaLocationAuthority(
    [alias],
    hashes,
    authority,
    (hash, location) => hash === source.hash && location.fileName === 'alias.mp4',
  );
  assert.equal(reconciled.size, 1);
  assert.deepEqual(catalogueMediaAuthorityLocationsForHash(reconciled, source.hash), [
    { fileName: 'alias.mp4', inputSource: 1, partialPath: '/Mirror' },
  ]);
});
