import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  buildFfprobeArguments,
  buildPlayerLaunch,
  buildTimestampPlayerArguments,
  disablePersistedSourceWatches,
  isAllowedExternalUrl,
  isUsablePersistedSourcePath,
  normalizeAbsolutePath,
  parsePlayerArguments,
  requireConfiguredSourceRoot,
  requireAuthorizedSourceRoot,
  resolveAuthorizedSourceDirectory,
  resolveExistingMediaPathWithinConfiguredRoots,
  resolveExistingSourceSubfolder,
  resolveExistingMediaPath,
  resolveMediaPath,
  resolveNewMediaPath,
  reviewPersistedSourceAccessRequests,
} from './local-operation-safety.ts';

test('requires usable persisted source paths before connectivity checks', () => {
  assert.equal(isUsablePersistedSourcePath('/Volumes/Videos'), true);
  assert.equal(isUsablePersistedSourcePath('../Videos'), false);
  assert.equal(isUsablePersistedSourcePath('/Volumes/Vid\0eos'), false);
  assert.equal(isUsablePersistedSourcePath(''), false);
});

test('requires confirmation for ordinary persisted watches and disables unsafe roots', () => {
  const inputDirs = {
    0: { path: '/Volumes/Videos', watch: true },
    1: { path: '/', watch: true },
    2: { path: '../relative', watch: true },
    3: { path: '/Volumes/Archive', watch: false },
  };

  const review = reviewPersistedSourceAccessRequests(inputDirs);
  assert.equal(review.changed, true);
  assert.deepEqual(review.requestedPaths, ['/Volumes/Videos', '/Volumes/Archive']);
  assert.deepEqual(review.requestedSourceKeys, [0, 3]);
  assert.deepEqual(review.watchSourceKeys, [0]);
  assert.equal(inputDirs[1].watch, false);
  assert.equal(inputDirs[2].watch, false);
  assert.equal(inputDirs[3].watch, false);

  assert.equal(disablePersistedSourceWatches(inputDirs, review.watchSourceKeys), true);
  assert.equal(inputDirs[0].watch, false);
  assert.equal(disablePersistedSourceWatches(inputDirs, review.watchSourceKeys), false);
});

test('allows ordinary HTTP and HTTPS links only', () => {
  assert.equal(isAllowedExternalUrl('https://github.com/sebiimaks/Theatrum-Ex-Machina'), true);
  assert.equal(isAllowedExternalUrl('http://www.videohubapp.com/'), true);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('https://user:password@example.com/'), false);
  assert.equal(isAllowedExternalUrl('not a URL'), false);
});

test('requires absolute paths without embedded NUL bytes', () => {
  assert.equal(normalizeAbsolutePath('/Volumes/Videos/test.mp4', 'Media file'), '/Volumes/Videos/test.mp4');
  assert.throws(() => normalizeAbsolutePath('../test.mp4', 'Media file'), /absolute path/);
  assert.throws(() => normalizeAbsolutePath('/Volumes/Videos/test\0.mp4', 'Media file'), /absolute path/);
});

test('rejects filesystem roots and symlinks to roots as media sources', () => {
  assert.throws(() => resolveAuthorizedSourceDirectory(path.parse(process.cwd()).root), /filesystem root/);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-source-root-'));
  try {
    const rootLink = path.join(temporaryDirectory, 'root-link');
    fs.symlinkSync(path.parse(temporaryDirectory).root, rootLink, 'dir');
    assert.throws(() => resolveAuthorizedSourceDirectory(rootLink), /filesystem root/);
    assert.equal(resolveAuthorizedSourceDirectory(temporaryDirectory), temporaryDirectory);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('resolves catalogue paths within their source folder', () => {
  assert.equal(
    resolveMediaPath('/Volumes/Videos', '/Lessons/Part 1', 'example.mp4'),
    '/Volumes/Videos/Lessons/Part 1/example.mp4',
  );
  assert.throws(
    () => resolveMediaPath('/Volumes/Videos', '../../Private', 'example.mp4'),
    /outside its source folder/,
  );
  assert.throws(
    () => resolveMediaPath('/Volumes/Videos', '/Lessons', '../example.mp4'),
    /file name is invalid/,
  );
  assert.throws(
    () => resolveMediaPath('/Volumes/Videos', '/Lessons', 'subfolder/example.mp4'),
    /file name is invalid/,
  );
  assert.equal(
    resolveMediaPath('/Volumes/Videos', '/Lessons', 'back\\slash.mp4', 'darwin'),
    '/Volumes/Videos/Lessons/back\\slash.mp4',
  );
});

test('authorizes destructive operations only for configured source roots', () => {
  assert.equal(
    requireConfiguredSourceRoot('/Volumes/Videos/', ['/Volumes/Other', '/Volumes/Videos']),
    '/Volumes/Videos',
  );
  assert.throws(
    () => requireConfiguredSourceRoot('/Volumes/Private', ['/Volumes/Videos']),
    /not part of the currently open catalogue/,
  );
});

test('revokes a source capability when a symlink target changes', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-source-identity-'));
  try {
    const firstTarget = path.join(container, 'first');
    const secondTarget = path.join(container, 'second');
    const sourceLink = path.join(container, 'source');
    fs.mkdirSync(firstTarget);
    fs.mkdirSync(secondTarget);
    fs.symlinkSync(firstTarget, sourceLink, 'dir');
    const normalizedLink = path.normalize(sourceLink);
    const identities = new Map([[normalizedLink, fs.realpathSync.native(sourceLink)]]);
    assert.equal(
      requireAuthorizedSourceRoot(normalizedLink, [normalizedLink], identities),
      normalizedLink,
    );

    fs.unlinkSync(sourceLink);
    fs.symlinkSync(secondTarget, sourceLink, 'dir');
    assert.throws(
      () => requireAuthorizedSourceRoot(normalizedLink, [normalizedLink], identities),
      /identity has changed/,
    );
  } finally {
    fs.rmSync(container, { force: true, recursive: true });
  }
});

test('resolves only existing root-relative source subfolders', () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-source-root-'));
  try {
    const nestedDirectory = path.join(rootDirectory, 'Cameras', 'Rangefinders');
    fs.mkdirSync(nestedDirectory, { recursive: true });
    fs.writeFileSync(path.join(rootDirectory, 'not-a-folder.mp4'), 'video');

    assert.equal(resolveExistingSourceSubfolder(rootDirectory, ''), rootDirectory);
    assert.equal(resolveExistingSourceSubfolder(rootDirectory, '.'), rootDirectory);
    assert.equal(
      resolveExistingSourceSubfolder(rootDirectory, 'Cameras/Rangefinders'),
      nestedDirectory,
    );
    assert.equal(
      resolveExistingSourceSubfolder(rootDirectory, 'Cameras\\Rangefinders'),
      nestedDirectory,
    );
    assert.throws(
      () => resolveExistingSourceSubfolder(rootDirectory, path.join(rootDirectory, 'Cameras')),
      /root-relative/,
    );
    assert.throws(
      () => resolveExistingSourceSubfolder(rootDirectory, '../outside'),
      /cannot traverse parent folders/,
    );
    assert.throws(
      () => resolveExistingSourceSubfolder(rootDirectory, 'Cameras/../Cameras'),
      /cannot traverse parent folders/,
    );
    assert.throws(
      () => resolveExistingSourceSubfolder(rootDirectory, 'Cameras\0Rangefinders'),
      /scope is invalid/,
    );
    assert.throws(
      () => resolveExistingSourceSubfolder(rootDirectory, 'missing'),
      /existing directory/,
    );
    assert.throws(
      () => resolveExistingSourceSubfolder(rootDirectory, 'not-a-folder.mp4'),
      /existing directory/,
    );
  } finally {
    fs.rmSync(rootDirectory, { force: true, recursive: true });
  }
});

test('rejects source subfolders that escape through symlinks', () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-source-root-'));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-source-outside-'));
  try {
    const containedDirectory = path.join(rootDirectory, 'contained');
    fs.mkdirSync(containedDirectory);
    fs.symlinkSync(containedDirectory, path.join(rootDirectory, 'linked-inside'), 'dir');
    fs.symlinkSync(outsideDirectory, path.join(rootDirectory, 'linked-outside'), 'dir');

    assert.equal(
      resolveExistingSourceSubfolder(rootDirectory, 'linked-inside'),
      path.join(rootDirectory, 'linked-inside'),
    );
    assert.throws(
      () => resolveExistingSourceSubfolder(rootDirectory, 'linked-outside'),
      /resolves outside its source folder/,
    );
  } finally {
    fs.rmSync(rootDirectory, { force: true, recursive: true });
    fs.rmSync(outsideDirectory, { force: true, recursive: true });
  }
});

test('rejects existing files and rename destinations that escape through symlinks', () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-root-'));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-outside-'));
  try {
    fs.mkdirSync(path.join(rootDirectory, 'ordinary'));
    fs.writeFileSync(path.join(rootDirectory, 'ordinary', 'safe.mp4'), 'safe');
    fs.writeFileSync(path.join(outsideDirectory, 'outside.mp4'), 'outside');
    fs.symlinkSync(outsideDirectory, path.join(rootDirectory, 'linked-outside'), 'dir');

    assert.equal(
      resolveExistingMediaPath(rootDirectory, 'ordinary', 'safe.mp4'),
      path.join(rootDirectory, 'ordinary', 'safe.mp4'),
    );
    assert.equal(
      resolveNewMediaPath(rootDirectory, 'ordinary', 'renamed.mp4'),
      path.join(rootDirectory, 'ordinary', 'renamed.mp4'),
    );
    assert.throws(
      () => resolveExistingMediaPath(rootDirectory, 'linked-outside', 'outside.mp4'),
      /resolves outside its source folder/,
    );
    assert.throws(
      () => resolveNewMediaPath(rootDirectory, 'linked-outside', 'renamed.mp4'),
      /destination resolves outside its source folder/,
    );
  } finally {
    fs.rmSync(rootDirectory, { force: true, recursive: true });
    fs.rmSync(outsideDirectory, { force: true, recursive: true });
  }
});

test('accepts only existing media files beneath main-owned source roots', () => {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-root-'));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-outside-'));
  try {
    const mediaDirectory = path.join(rootDirectory, 'media');
    fs.mkdirSync(mediaDirectory);
    const safeFile = path.join(mediaDirectory, 'safe.mp4');
    const outsideFile = path.join(outsideDirectory, 'outside.mp4');
    fs.writeFileSync(safeFile, 'safe');
    fs.writeFileSync(outsideFile, 'outside');
    fs.symlinkSync(outsideFile, path.join(mediaDirectory, 'linked-outside.mp4'));

    assert.equal(
      resolveExistingMediaPathWithinConfiguredRoots(safeFile, [rootDirectory]),
      fs.realpathSync.native(safeFile),
    );
    assert.throws(
      () => resolveExistingMediaPathWithinConfiguredRoots(outsideFile, [rootDirectory]),
      /not within a configured source folder/,
    );
    assert.throws(
      () => resolveExistingMediaPathWithinConfiguredRoots(path.join(mediaDirectory, 'linked-outside.mp4'), [rootDirectory]),
      /not within a configured source folder/,
    );
  } finally {
    fs.rmSync(rootDirectory, { force: true, recursive: true });
    fs.rmSync(outsideDirectory, { force: true, recursive: true });
  }
});

test('parses custom-player arguments without interpreting shell syntax', () => {
  assert.deepEqual(
    parsePlayerArguments('--start-time 90 --title "A quoted title"'),
    ['--start-time', '90', '--title', 'A quoted title'],
  );
  assert.deepEqual(
    parsePlayerArguments('--label test;touch /tmp/should-not-exist'),
    ['--label', 'test;touch', '/tmp/should-not-exist'],
  );
  assert.deepEqual(parsePlayerArguments('--empty ""'), ['--empty', '']);
  assert.throws(() => parsePlayerArguments('--title "unfinished'), /unmatched quote/);
});

test('derives timestamp arguments from the main-owned player and a bounded offset', () => {
  assert.equal(
    buildTimestampPlayerArguments('/Applications/VLC.app', 42.5),
    '--start-time=42.5',
  );
  assert.equal(
    buildTimestampPlayerArguments('/Applications/mpv.app', 10),
    '--start=10',
  );
  assert.equal(
    buildTimestampPlayerArguments('/Applications/VLC.app', 0),
    '',
  );
  assert.equal(
    buildTimestampPlayerArguments('/Applications/VLC.app', Number.POSITIVE_INFINITY),
    '',
  );
});

test('keeps a hostile-looking media filename as one player argument', () => {
  const launch = buildPlayerLaunch(
    '/Applications/VLC.app/Contents/MacOS/VLC',
    '/Volumes/Videos/lesson"; touch injected; ".mp4',
    '--start-time 15',
    'darwin',
  );

  assert.equal(launch.command, '/Applications/VLC.app/Contents/MacOS/VLC');
  assert.deepEqual(launch.args, [
    '/Volumes/Videos/lesson"; touch injected; ".mp4',
    '--start-time',
    '15',
  ]);
});

test('launches macOS application bundles through the fixed open executable', () => {
  const launch = buildPlayerLaunch(
    '/Applications/VLC.app',
    '/Volumes/Videos/example.mp4',
    '--start-time 15',
    'darwin',
  );

  assert.equal(launch.command, '/usr/bin/open');
  assert.deepEqual(launch.args, [
    '-a',
    '/Applications/VLC.app',
    '/Volumes/Videos/example.mp4',
    '--args',
    '--start-time',
    '15',
  ]);
});

test('keeps the FFprobe media path in a discrete argument', () => {
  const maliciousLookingPath = '/Volumes/Videos/example"; touch injected; ".mp4';
  const args = buildFfprobeArguments(maliciousLookingPath);

  assert.equal(args.at(-1), maliciousLookingPath);
  assert.equal(args.includes('touch'), false);
});
