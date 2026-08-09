import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { NewImageElement } from '../interfaces/final-object.interface';
import {
  buildSourceFolderTree,
  isSourceFolderWithinScope,
  normalizeSourceFolderRelativePath,
} from '../interfaces/source-folder-tree';
import {
  configuredSourceRootsEqual,
  normalizeIgnoredSubdirectories,
  sourceFolderPathIsIgnored,
} from '../interfaces/source-folder-path';
import type { SourceFolderTreeNode } from '../interfaces/source-folder-tree';

function video(overrides: Record<string, unknown>) {
  return {
    ...NewImageElement(),
    cleanName: 'Video',
    fileName: 'video.mp4',
    hash: 'valid-hash',
    inputSource: 2,
    ...overrides,
  };
}

function child(node: SourceFolderTreeNode, name: string): SourceFolderTreeNode {
  const result = node.children.find((candidate) => candidate.name === name);
  assert.ok(result, `Expected folder ${name}`);
  return result;
}

test('normalizes legacy separators and matches subtree boundaries', () => {
  assert.equal(normalizeSourceFolderRelativePath('/Camera\\Canon/./Bodies/'), 'Camera/Canon/Bodies');
  assert.equal(isSourceFolderWithinScope('/Camera/Canon', 'Camera'), true);
  assert.equal(isSourceFolderWithinScope('/Camera', '/Camera'), true);
  assert.equal(isSourceFolderWithinScope('/Camerabag', '/Camera'), false);
  assert.equal(isSourceFolderWithinScope('/Anything', '/'), true);
});

test('recognizes only canonically identical configured roots as duplicates', () => {
  assert.equal(configuredSourceRootsEqual('/Media/Videos/', '/Media/Videos'), true);
  assert.equal(configuredSourceRootsEqual('/Media/Videos/.', '/Media/Videos'), true);
  assert.equal(configuredSourceRootsEqual('/Media/Videos', '/Media'), false);
  assert.equal(configuredSourceRootsEqual('/Media', '/Media/Videos'), false);
});

test('rejects relative paths that attempt to leave the configured root', () => {
  assert.throws(
    () => normalizeSourceFolderRelativePath('/Camera/../Private'),
    /cannot leave its configured root/,
  );
  assert.throws(
    () => isSourceFolderWithinScope('/Camera', '../Camera'),
    /cannot leave its configured root/,
  );
  assert.throws(
    () => buildSourceFolderTree([], 2, ['/Safe', '/Safe/../../Private']),
    /cannot leave its configured root/,
  );
  assert.throws(
    () => normalizeSourceFolderRelativePath(Array.from({ length: 257 }, () => 'folder').join('/')),
    /too deeply nested/,
  );
});

test('normalizes ignored subdirectories to minimal safe source-relative scopes', () => {
  assert.deepEqual(normalizeIgnoredSubdirectories([
    '/Camera/Canon',
    'Archive',
    'Camera',
    'Archive/Old',
    'Camera\\Canon',
  ]), ['Archive', 'Camera']);
  assert.equal(sourceFolderPathIsIgnored('/Camera/Canon/Bodies', ['Camera']), true);
  assert.equal(sourceFolderPathIsIgnored('/Camerabag', ['Camera']), false);
  assert.deepEqual(normalizeIgnoredSubdirectories(undefined), []);
  assert.throws(() => normalizeIgnoredSubdirectories('Camera'), /are invalid/);
  assert.throws(() => normalizeIgnoredSubdirectories(['/']), /root cannot be ignored/);
  assert.throws(() => normalizeIgnoredSubdirectories(['Camera/../Private']), /cannot leave/);
});

test('builds a stable display-only tree with recursive video and thumbnail counts', () => {
  const elements = [
    video({ fileName: 'root.mp4', hash: 'root-hash', partialPath: '/' }),
    video({ fileName: 'canon.mp4', hash: 'canon-hash', partialPath: '/Camera/Canon' }),
    video({ fileName: 'nikon.mp4', hash: 'nikon-hash', metadataImportFailed: true, partialPath: '/Camera/Nikon' }),
    video({ fileName: 'offline.mp4', hash: 'offline-hash', missing: true, partialPath: '/Archive' }),
    video({ deleted: true, fileName: 'deleted.mp4', hash: 'deleted-hash', partialPath: '/Deleted' }),
    video({ fileName: 'other-source.mp4', hash: 'other-hash', inputSource: 3, partialPath: '/Other' }),
  ];

  const tree = buildSourceFolderTree(elements, 2, ['/Empty/Nested', '/Camera/Canon']);
  assert.deepEqual(tree.children.map((node) => node.name), ['Archive', 'Camera', 'Empty']);
  assert.equal(tree.recursiveVideoCount, 4);
  assert.equal(tree.eligibleThumbnailCount, 2);
  assert.equal(tree.directVideoCount, 1);
  assert.equal(tree.directEligibleThumbnailCount, 1);

  const archive = child(tree, 'Archive');
  assert.equal(archive.recursiveVideoCount, 1, 'temporarily unavailable entries remain visible');
  assert.equal(archive.eligibleThumbnailCount, 0);

  const camera = child(tree, 'Camera');
  assert.equal(camera.recursiveVideoCount, 2);
  assert.equal(camera.eligibleThumbnailCount, 1);
  assert.deepEqual(camera.children.map((node) => node.name), ['Canon', 'Nikon']);
  assert.equal(child(camera, 'Canon').directEligibleThumbnailCount, 1);

  const empty = child(tree, 'Empty');
  assert.equal(empty.recursiveVideoCount, 0);
  assert.equal(empty.eligibleThumbnailCount, 0);
  assert.deepEqual(empty.children.map((node) => node.name), ['Nested']);
});

test('sorts folder rows deterministically without mutating the inputs', () => {
  const discovered = ['/zeta', '/alpha', '/Beta', '/beta'];
  const first = buildSourceFolderTree([], 2, discovered);
  const second = buildSourceFolderTree([], 2, [...discovered].reverse());

  assert.deepEqual(first.children.map((node) => node.name), ['alpha', 'Beta', 'beta', 'zeta']);
  assert.deepEqual(second.children.map((node) => node.name), first.children.map((node) => node.name));
  assert.deepEqual(discovered, ['/zeta', '/alpha', '/Beta', '/beta']);
});

test('keeps ignored scopes and their empty ancestors reachable while hiding descendants', () => {
  const tree = buildSourceFolderTree(
    [video({ fileName: 'hidden.mp4', hash: 'hidden-hash', partialPath: '/Camera/Canon/Bodies' })],
    2,
    ['/Empty'],
    ['/Camera/Canon'],
  );

  assert.equal(tree.containsIgnoredScope, true);
  assert.equal(tree.ignored, false);
  const camera = child(tree, 'Camera');
  assert.equal(camera.containsIgnoredScope, true);
  assert.equal(camera.ignored, false);
  const canon = child(camera, 'Canon');
  assert.equal(canon.containsIgnoredScope, true);
  assert.equal(canon.ignored, true);
  assert.deepEqual(canon.children, [], 'an ignored branch is terminal in the display tree');
  assert.equal(child(tree, 'Empty').containsIgnoredScope, false);
});

test('represents one logical video under every associated source location', () => {
  const shared = video({
    fileName: 'shared.mp4',
    hash: 'shared-hash',
    inputSource: 2,
    locations: [
      {
        fileName: 'shared.mp4',
        inputSource: 2,
        missing: true,
        partialPath: '/Existing/Canon',
      },
      {
        fileName: 'shared.mp4',
        inputSource: 7,
        partialPath: '/Library/Existing/Canon',
      },
    ],
    partialPath: '/Existing/Canon',
  });

  const childSourceTree = buildSourceFolderTree([shared], 2);
  assert.equal(childSourceTree.recursiveVideoCount, 1);
  assert.equal(childSourceTree.eligibleThumbnailCount, 0);
  assert.equal(child(child(childSourceTree, 'Existing'), 'Canon').directVideoCount, 1);

  const parentSourceTree = buildSourceFolderTree([shared], 7);
  assert.equal(parentSourceTree.recursiveVideoCount, 1);
  assert.equal(parentSourceTree.eligibleThumbnailCount, 1);
  assert.equal(
    child(child(child(parentSourceTree, 'Library'), 'Existing'), 'Canon').directVideoCount,
    1,
  );
});
