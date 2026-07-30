import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const appPath = process.argv[2];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'),
).version;
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

if (!appPath) {
  throw new Error('Usage: node bin/verify-packaged-app.mjs <macOS .app> [corresponding-source archive]');
}

const resolvedAppPath = path.resolve(appPath);
const buildOutputDirectory = path.dirname(path.dirname(resolvedAppPath));
const correspondingSourcePath = process.argv[3] || path.join(
  buildOutputDirectory,
  `video-hub-app-sin-media-source-v${packageVersion}.tar.xz`,
);

const resourcesPath = path.join(resolvedAppPath, 'Contents', 'Resources');
const ffmpegPath = path.join(resourcesPath, 'media-tools', 'ffmpeg');
const ffprobePath = path.join(resourcesPath, 'media-tools', 'ffprobe');
const requiredResources = [
  path.join(resourcesPath, 'LICENSE'),
  path.join(resourcesPath, 'licenses', 'GPL-2.0-or-later.txt'),
  path.join(resourcesPath, 'licenses', 'FFMPEG-LICENSE.md'),
  path.join(resourcesPath, 'licenses', 'X264-LICENSE.txt'),
  path.join(resourcesPath, 'licenses', 'MEDIA-TOOLS.md'),
  path.join(resourcesPath, 'licenses', 'THIRD_PARTY_NOTICES.txt'),
  path.join(resourcesPath, 'licenses', 'ELECTRON-LICENSE.txt'),
  path.join(resourcesPath, 'licenses', 'LICENSES.chromium.html'),
  path.join(resourcesPath, 'media-tools', 'BUILD-MANIFEST.txt'),
  ffmpegPath,
  ffprobePath,
];

function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout || '';
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

for (const requiredResource of requiredResources) {
  assert.ok(fs.statSync(requiredResource).size > 0, `Missing or empty packaged resource: ${requiredResource}`);
}

const packagedManifest = fs.readFileSync(
  path.join(resourcesPath, 'media-tools', 'BUILD-MANIFEST.txt'),
  'utf8',
);
assert.ok(
  packagedManifest.includes(`ffmpeg binary SHA-256: ${sha256(ffmpegPath)}`),
  'The packaged ffmpeg binary does not match its build manifest.',
);
assert.ok(
  packagedManifest.includes(`ffprobe binary SHA-256: ${sha256(ffprobePath)}`),
  'The packaged ffprobe binary does not match its build manifest.',
);

const applicationArchive = path.join(resourcesPath, 'app.asar');
const archivedFiles = asar.listPackage(applicationArchive);
assert.ok(
  archivedFiles.includes('/node/media-tool-paths.js'),
  'The packaged app is missing its fork-owned media-tool resolver.',
);
for (const requiredRuntimeFile of [
  '/node_modules/electron-window-state/index.js',
  '/node_modules/jsonfile/index.js',
  '/node_modules/mkdirp/index.js',
]) {
  assert.ok(
    archivedFiles.includes(requiredRuntimeFile),
    `The packaged app is missing a required runtime dependency: ${requiredRuntimeFile}`,
  );
}
assert.equal(
  archivedFiles.some((entry) => entry.includes('/node_modules/ffmpeg-ffprobe-static/')),
  false,
  'The removed opaque FFmpeg downloader must not be packaged.',
);

const thirdPartyNotices = fs.readFileSync(
  path.join(resourcesPath, 'licenses', 'THIRD_PARTY_NOTICES.txt'),
  'utf8',
);
const packagedPackageIdentities = new Set();
for (const archivedFile of archivedFiles) {
  if (!archivedFile.startsWith('/node_modules/') || !archivedFile.endsWith('/package.json')) {
    continue;
  }
  const packageJson = JSON.parse(
    asar.extractFile(applicationArchive, archivedFile.slice(1)).toString('utf8'),
  );
  if (packageJson.name && packageJson.version) {
    packagedPackageIdentities.add(`${packageJson.name}@${packageJson.version}`);
  }
}
for (const packageIdentity of packagedPackageIdentities) {
  assert.ok(
    thirdPartyNotices.includes(`\n${packageIdentity}\n`),
    `Packaged dependency is missing from THIRD_PARTY_NOTICES.txt: ${packageIdentity}`,
  );
}

fs.accessSync(ffmpegPath, fs.constants.X_OK);
fs.accessSync(ffprobePath, fs.constants.X_OK);

const architecture = run('file', [ffmpegPath, ffprobePath]);
assert.match(architecture, /ffmpeg:.*arm64/);
assert.match(architecture, /ffprobe:.*arm64/);
for (const mediaToolPath of [ffmpegPath, ffprobePath]) {
  const deploymentTarget = run('vtool', ['-show-build', mediaToolPath]);
  assert.match(deploymentTarget, /minos 12\.0/);

  const linkedLibraries = run('otool', ['-L', mediaToolPath])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0])
    .filter(Boolean);
  assert.ok(linkedLibraries.length > 0, `No linked system libraries reported for ${mediaToolPath}`);
  assert.ok(
    linkedLibraries.every((libraryPath) =>
      libraryPath.startsWith('/usr/lib/') || libraryPath.startsWith('/System/Library/'),
    ),
    `Unexpected non-system dynamic library linked by ${mediaToolPath}: ${linkedLibraries.join(', ')}`,
  );
}

const ffmpegVersion = run(ffmpegPath, ['-version']);
const ffprobeVersion = run(ffprobePath, ['-version']);
assert.match(ffmpegVersion, /^ffmpeg version 8\.1\.2/m);
assert.match(ffprobeVersion, /^ffprobe version 8\.1\.2/m);
assert.match(ffmpegVersion, /--enable-gpl/);
assert.match(ffmpegVersion, /--enable-libx264/);
assert.doesNotMatch(ffmpegVersion, /--enable-nonfree/);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-hub-app-sin-artifact-'));
try {
  const mediaPath = path.join(temporaryDirectory, 'packaged test with spaces; value.mp4');
  const thumbnailPath = path.join(temporaryDirectory, 'thumbnail with spaces; value.jpg');
  run(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc=size=160x90:rate=5:duration=2',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:duration=2',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-y',
    mediaPath,
  ]);
  const probeJson = run(ffprobePath, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    mediaPath,
  ]);
  const metadata = JSON.parse(probeJson);
  assert.ok(metadata.streams.some((stream) => stream.codec_type === 'video'));
  assert.ok(metadata.streams.some((stream) => stream.codec_type === 'audio'));
  run(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', '1',
    '-i', mediaPath,
    '-frames:v', '1',
    '-y',
    thumbnailPath,
  ]);
  assert.ok(fs.statSync(thumbnailPath).size > 0);
} finally {
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
}

if (correspondingSourcePath) {
  const archiveContents = run('tar', ['-tf', path.resolve(correspondingSourcePath)]);
  for (const expectedName of [
    'sources/ffmpeg-8.1.2.tar.xz',
    'sources/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz',
    'build-scripts/build-media-tools.sh',
    'licenses/GPL-2.0-or-later.txt',
    'licenses/FFMPEG-LICENSE.md',
    'licenses/X264-LICENSE.txt',
    'BUILD-MANIFEST.txt',
  ]) {
    assert.ok(archiveContents.includes(expectedName), `Corresponding-source archive is missing ${expectedName}`);
  }

  const sourceVerificationDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'video-hub-app-sin-source-verification-'),
  );
  try {
    run('tar', ['-xf', path.resolve(correspondingSourcePath), '-C', sourceVerificationDirectory]);
    const sourceRoot = path.join(
      sourceVerificationDirectory,
      `video-hub-app-sin-media-source-v${packageVersion}`,
    );
    assert.equal(
      sha256(path.join(sourceRoot, 'sources', 'ffmpeg-8.1.2.tar.xz')),
      '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
    );
    assert.equal(
      sha256(path.join(sourceRoot, 'sources', 'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz')),
      'cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9',
    );
    const sourceManifest = fs.readFileSync(path.join(sourceRoot, 'BUILD-MANIFEST.txt'), 'utf8');
    assert.equal(
      sourceManifest,
      packagedManifest,
      'The corresponding-source manifest does not match the packaged media tools.',
    );
    assert.ok(
      sourceManifest.includes(
        `Build script SHA-256: ${sha256(path.join(sourceRoot, 'build-scripts', 'build-media-tools.sh'))}`,
      ),
      'The corresponding-source build script does not match its build manifest.',
    );
  } finally {
    fs.rmSync(sourceVerificationDirectory, { force: true, recursive: true });
  }
}

console.log('Packaged Mac application and licensing payload verified.');
