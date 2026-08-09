import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  buildFfprobeArguments,
  buildPlayerLaunch,
  isAllowedExternalUrl,
  normalizeAbsolutePath,
  parsePlayerArguments,
  requireConfiguredSourceRoot,
  resolveExistingSourceSubfolder,
  resolveExistingMediaPath,
  resolveMediaPath,
  resolveNewMediaPath,
} from './local-operation-safety.ts';

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
