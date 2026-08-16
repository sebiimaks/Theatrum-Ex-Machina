import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { collectRuntimePackagePaths } from './runtime-dependencies.mjs';

const appPath = process.argv[2];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'),
).version;
const packageLock = JSON.parse(
  fs.readFileSync(path.join(projectDirectory, 'package-lock.json'), 'utf8'),
);
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

if (!appPath) {
  throw new Error('Usage: node bin/verify-packaged-app.mjs <macOS .app> [corresponding-source archive]');
}

const resolvedAppPath = path.resolve(appPath);
const buildOutputDirectory = path.dirname(path.dirname(resolvedAppPath));
const correspondingSourcePath = process.argv[3] || path.join(
  buildOutputDirectory,
  `theatrum-ex-machina-media-source-v${packageVersion}.tar.xz`,
);

const resourcesPath = path.join(resolvedAppPath, 'Contents', 'Resources');
const infoPlistPath = path.join(resolvedAppPath, 'Contents', 'Info.plist');
const packagedIconPath = path.join(resourcesPath, 'icon.icns');
const packagedLogoPath = path.join(resourcesPath, 'assets', 'logo.png');
const packagedThemeIconPaths = {
  light: path.join(resourcesPath, 'assets', 'favicon-light.png'),
  dark: path.join(resourcesPath, 'assets', 'favicon-dark.png'),
};
const ffmpegPath = path.join(resourcesPath, 'media-tools', 'ffmpeg');
const ffprobePath = path.join(resourcesPath, 'media-tools', 'ffprobe');
const requiredResources = [
  infoPlistPath,
  packagedIconPath,
  packagedLogoPath,
  packagedThemeIconPaths.light,
  packagedThemeIconPaths.dark,
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

async function verifyPackagedStartup(executablePath) {
  const smokeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-smoke-'));
  const expectedMarker = 'THEATRUM_PACKAGED_SMOKE_READY';

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executablePath, [], {
        detached: true,
        env: {
          ...process.env,
          PORTABLE_EXECUTABLE_DIR: smokeDirectory,
          THEATRUM_PACKAGED_SMOKE_TEST: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stdout = '';
      let timedOut = false;
      let forceKillTimer;

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const terminateProcessGroup = (signal) => {
        if (!child.pid) {
          return;
        }
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process may already have exited between the timer and signal.
        }
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup('SIGTERM');
        forceKillTimer = setTimeout(() => terminateProcessGroup('SIGKILL'), 1_000);
      }, 20_000);

      child.on('error', (error) => {
        clearTimeout(timeout);
        clearTimeout(forceKillTimer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        clearTimeout(forceKillTimer);
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        if (timedOut) {
          reject(new Error(`Packaged app startup timed out.\n${output}`));
        } else if (code !== 0) {
          reject(new Error(`Packaged app exited with code ${code} (${signal || 'no signal'}).\n${output}`));
        } else if (!stdout.includes(expectedMarker)) {
          reject(new Error(`Packaged app exited before renderer startup completed.\n${output}`));
        } else {
          resolve();
        }
      });
    });
  } finally {
    fs.rmSync(smokeDirectory, { force: true, recursive: true });
  }
}

for (const requiredResource of requiredResources) {
  assert.ok(fs.statSync(requiredResource).size > 0, `Missing or empty packaged resource: ${requiredResource}`);
}

const infoPlist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', infoPlistPath]));
assert.equal(
  infoPlist.CFBundleShortVersionString,
  packageVersion,
  'The packaged app display version does not match package.json.',
);
assert.equal(
  infoPlist.CFBundleVersion,
  packageVersion,
  'The packaged app build version does not match package.json.',
);
assert.equal(infoPlist.CFBundleIconFile, 'icon.icns', 'The packaged app does not use the reviewed icon bundle.');
assert.equal(
  sha256(packagedIconPath),
  sha256(path.join(projectDirectory, 'src', 'assets', 'icons.icns')),
  'The packaged application icon differs from the reviewed generated icon.',
);
assert.equal(
  sha256(packagedLogoPath),
  sha256(path.join(projectDirectory, 'src', 'assets', 'logo.png')),
  'The packaged fallback logo differs from the reviewed generated logo.',
);
for (const [theme, packagedThemeIconPath] of Object.entries(packagedThemeIconPaths)) {
  assert.equal(
    sha256(packagedThemeIconPath),
    sha256(path.join(projectDirectory, 'src', 'assets', `favicon-${theme}.png`)),
    `The packaged ${theme} Dock icon differs from the reviewed generated icon.`,
  );
}
const associatedExtensions = (infoPlist.CFBundleDocumentTypes || [])
  .flatMap((documentType) => documentType.CFBundleTypeExtensions || [])
  .map((extension) => String(extension).toLowerCase());
assert.ok(
  associatedExtensions.includes('scaena'),
  'The packaged app does not associate .scaena catalogue files.',
);
assert.equal(
  associatedExtensions.includes('vha2'),
  false,
  'The packaged app must not compete with Video Hub App SIN for legacy .vha2 file association.',
);

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
const archivedFileSet = new Set(archivedFiles);
for (const themedAsset of [
  'assets/logo-light.png',
  'assets/logo-dark.png',
  'assets/favicon-light.png',
  'assets/favicon-dark.png',
]) {
  const archivedAsset = `/dist/${themedAsset}`;
  assert.ok(archivedFileSet.has(archivedAsset), `The packaged app is missing ${archivedAsset}.`);
  const packagedAssetHash = crypto
    .createHash('sha256')
    .update(asar.extractFile(applicationArchive, archivedAsset.slice(1)))
    .digest('hex');
  assert.equal(
    packagedAssetHash,
    sha256(path.join(projectDirectory, 'src', themedAsset)),
    `The packaged themed branding asset differs from its generated source: ${archivedAsset}`,
  );
}
assert.ok(
  archivedFiles.includes('/node/media-tool-paths.js'),
  'The packaged app is missing its fork-owned media-tool resolver.',
);
for (const packagePath of collectRuntimePackagePaths(packageLock)) {
  const requiredRuntimeFile = `/${packagePath}/package.json`;
  assert.ok(
    archivedFileSet.has(requiredRuntimeFile),
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

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-artifact-'));
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
    path.join(os.tmpdir(), 'theatrum-ex-machina-source-verification-'),
  );
  try {
    run('tar', ['-xf', path.resolve(correspondingSourcePath), '-C', sourceVerificationDirectory]);
    const sourceRoot = path.join(
      sourceVerificationDirectory,
      `theatrum-ex-machina-media-source-v${packageVersion}`,
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

const executableName = infoPlist.CFBundleExecutable;
assert.ok(executableName, 'The packaged application has no CFBundleExecutable.');
await verifyPackagedStartup(path.join(resolvedAppPath, 'Contents', 'MacOS', executableName));

console.log('Packaged Mac application, runtime startup, and licensing payload verified.');
