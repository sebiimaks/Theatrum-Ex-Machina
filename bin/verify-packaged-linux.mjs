import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { collectRuntimePackagePaths } from './runtime-dependencies.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const projectPackageJson = JSON.parse(
  fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'),
);
const packageLock = JSON.parse(
  fs.readFileSync(path.join(projectDirectory, 'package-lock.json'), 'utf8'),
);
const builderConfiguration = JSON.parse(
  fs.readFileSync(path.join(projectDirectory, 'electron-builder.json'), 'utf8'),
);
const packageVersion = projectPackageJson.version;
const linuxPackageName = builderConfiguration.deb?.packageName || projectPackageJson.name;
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed.\n${result.stderr || result.stdout}`,
  );
  return result.stdout || '';
}

function commandExists(command) {
  const result = spawnSync('sh', ['-c', `command -v "$1" >/dev/null 2>&1`, 'sh', command], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertNonempty(filePath, description = 'packaged resource') {
  assert.ok(
    fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0,
    `Missing or empty ${description}: ${filePath}`,
  );
}

function walkFiles(rootDirectory) {
  const files = [];
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function findOnly(files, predicate, description) {
  const matches = files.filter(predicate);
  assert.equal(
    matches.length,
    1,
    `Expected exactly one ${description}; found ${matches.length}: ${matches.join(', ')}`,
  );
  return matches[0];
}

function parseDesktopEntry(contents) {
  const entries = new Map();
  let section = '';
  for (const sourceLine of contents.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== 'Desktop Entry') {
      continue;
    }
    const equalsIndex = line.indexOf('=');
    if (equalsIndex > 0) {
      entries.set(line.slice(0, equalsIndex), line.slice(equalsIndex + 1));
    }
  }
  return entries;
}

function parseDesktopExec(value) {
  const tokens = [];
  let token = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (/\s/u.test(character) && !quoted) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else {
      token += character;
    }
  }
  assert.equal(quoted, false, `Unterminated quote in desktop Exec entry: ${value}`);
  assert.equal(escaped, false, `Trailing escape in desktop Exec entry: ${value}`);
  if (token) {
    tokens.push(token);
  }
  return tokens;
}

function packagedPath(extractionRoot, absoluteInstalledPath) {
  assert.ok(
    path.posix.isAbsolute(absoluteInstalledPath),
    `Installed path must be absolute: ${absoluteInstalledPath}`,
  );
  const relativePath = absoluteInstalledPath.replace(/^\/+/, '');
  assert.equal(
    relativePath.split('/').includes('..'),
    false,
    `Installed path must not escape the package root: ${absoluteInstalledPath}`,
  );
  return path.join(extractionRoot, ...relativePath.split('/'));
}

function assertElfAmd64(filePath, description) {
  assertNonempty(filePath, description);
  fs.accessSync(filePath, fs.constants.X_OK);
  const fileDescription = run('file', ['-L', filePath]);
  assert.match(
    fileDescription,
    /ELF 64-bit LSB[^\n]*x86-64/u,
    `${description} is not an x86-64 ELF binary: ${fileDescription}`,
  );
  const elfHeader = run('readelf', ['-h', filePath]);
  assert.match(
    elfHeader,
    /^\s*Class:\s+ELF64\s*$/mu,
    `${description} is not ELF64.`,
  );
  assert.match(
    elfHeader,
    /^\s*Machine:\s+Advanced Micro Devices X86-64\s*$/mu,
    `${description} does not target AMD64.`,
  );
}

function verifyLinkedLibraries(filePath, packagedApplicationRoot, allowPackagedLibraries) {
  const result = spawnSync('ldd', [filePath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (/statically linked|not a dynamic executable/u.test(output)) {
    return;
  }
  assert.equal(result.status, 0, `ldd failed for ${filePath}.\n${output}`);
  assert.doesNotMatch(output, /=>\s+not found/u, `Unresolved library in ${filePath}.\n${output}`);

  const packagedRoot = `${fs.realpathSync(packagedApplicationRoot)}${path.sep}`;
  for (const line of output.split(/\r?\n/u)) {
    // ldd does not quote resolved paths, so capture through the address suffix;
    // Electron's installation directory intentionally contains spaces.
    const resolution = /=>\s+(\/.+?)\s+\(0x[0-9a-f]+\)/iu.exec(line)?.[1]
      || /^\s*(\/.+?)\s+\(0x[0-9a-f]+\)/iu.exec(line)?.[1];
    if (!resolution) {
      assert.match(
        line,
        /^\s*(?:linux-vdso|linux-gate)\.so/u,
        `Unrecognised ldd result for ${filePath}: ${line}`,
      );
      continue;
    }
    const resolvedLibrary = fs.realpathSync(resolution);
    const systemLibrary = [
      '/lib/',
      '/lib64/',
      '/usr/lib/',
      '/usr/lib64/',
    ].some((prefix) => resolvedLibrary.startsWith(prefix));
    const packagedLibrary = allowPackagedLibraries
      && (`${resolvedLibrary}${path.sep}`.startsWith(packagedRoot) || resolvedLibrary.startsWith(packagedRoot));
    assert.ok(
      systemLibrary || packagedLibrary,
      `Unexpected dynamic library linked by ${filePath}: ${resolution}`,
    );
  }
}

function verifyApplicationArchive(resourcesPath) {
  const applicationArchive = path.join(resourcesPath, 'app.asar');
  assertNonempty(applicationArchive, 'application archive');
  const archivedFiles = asar.listPackage(applicationArchive);
  const archivedFileSet = new Set(archivedFiles);

  assert.ok(archivedFileSet.has('/package.json'), 'The packaged app is missing package.json.');
  const packagedApplicationMetadata = JSON.parse(
    asar.extractFile(applicationArchive, 'package.json').toString('utf8'),
  );
  assert.equal(
    packagedApplicationMetadata.name,
    projectPackageJson.name,
    'The packaged application name does not match package.json.',
  );
  assert.equal(
    packagedApplicationMetadata.productName,
    projectPackageJson.productName,
    'The packaged product name does not match package.json.',
  );
  assert.equal(
    packagedApplicationMetadata.version,
    packageVersion,
    'The packaged application version does not match package.json.',
  );
  assert.equal(
    packagedApplicationMetadata.main,
    projectPackageJson.main,
    'The packaged application entry point does not match package.json.',
  );

  assert.equal(
    archivedFiles.some((entry) => entry === '/demo' || entry.startsWith('/demo/')),
    false,
    'The removed demo application must not be packaged.',
  );
  const appOwnedTextFiles = archivedFiles.filter((entry) => (
    entry === '/main.js'
    || entry === '/preload.js'
    || entry.startsWith('/node/')
    || entry.startsWith('/interfaces/')
    || entry.startsWith('/dist/')
  ) && /\.(?:html|js|json)$/u.test(entry));
  for (const archivedFile of appOwnedTextFiles) {
    const contents = asar.extractFile(applicationArchive, archivedFile.slice(1)).toString('utf8');
    for (const marker of ['DEMO LIMIT REACHED', 'demoVersion', 'limited to 50 video files']) {
      assert.equal(
        contents.includes(marker),
        false,
        `Removed demo marker '${marker}' must not be packaged in ${archivedFile}.`,
      );
    }
  }

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
    archivedFileSet.has('/node/media-tool-paths.js'),
    'The packaged app is missing its fork-owned media-tool resolver.',
  );
  assert.ok(
    archivedFileSet.has('/preload.js'),
    'The packaged application is missing its context-isolation preload bridge.',
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
  assert.equal(
    archivedFileSet.has('/node/server.js'),
    false,
    'The removed local server implementation must not be packaged.',
  );
  for (const packageName of ['an-qrcode', 'body-parser', 'express', 'ip', 'ws']) {
    assert.equal(
      archivedFiles.some((entry) => entry.startsWith(`/node_modules/${packageName}/`)),
      false,
      `Removed server dependency must not be packaged: ${packageName}`,
    );
  }
  for (const packageName of ['trash', 'uuid', 'glob', 'globby', 'minimatch', 'brace-expansion']) {
    assert.equal(
      archivedFiles.some((entry) => entry.startsWith(`/node_modules/${packageName}/`)),
      false,
      `Removed dependency-debt package must not be packaged: ${packageName}`,
    );
  }

  return { applicationArchive, archivedFiles };
}

function verifyNotices(resourcesPath, archivedFiles) {
  const packagedRuntimeNoticesPath = path.join(
    resourcesPath,
    'licenses',
    'THIRD_PARTY_NOTICES.txt',
  );
  const packagedRendererNoticesPath = path.join(
    resourcesPath,
    'licenses',
    'RENDERER-THIRD-PARTY-NOTICES.txt',
  );
  const thirdPartyNotices = fs.readFileSync(packagedRuntimeNoticesPath, 'utf8');
  const rendererThirdPartyNotices = fs.readFileSync(packagedRendererNoticesPath, 'utf8');

  assert.equal(
    thirdPartyNotices,
    fs.readFileSync(path.join(projectDirectory, 'legal', 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
    'The packaged runtime notices differ from the reviewed tracked notice file.',
  );
  assert.equal(
    rendererThirdPartyNotices,
    fs.readFileSync(path.join(projectDirectory, 'dist', '3rdpartylicenses.txt'), 'utf8'),
    'The externally packaged renderer notices differ from the production bundle notices.',
  );

  const expectedRendererNoticeHeadings = [
    '@angular/animations',
    '@angular/cdk',
    '@angular/common',
    '@angular/core',
    '@angular/forms',
    '@angular/material',
    '@angular/platform-browser',
    '@angular/router',
    '@iharbeck/ngx-virtual-scroller',
    '@ngx-translate/core',
    '@tweenjs/tween.js',
    'fuse.js',
    'inherits',
    'natural-orderby',
    'path',
    'reflect-metadata',
    'rxjs',
    'util',
    'zone.js',
  ];
  const rendererNoticeLines = new Set(rendererThirdPartyNotices.split(/\r?\n/u));
  for (const packageName of expectedRendererNoticeHeadings) {
    assert.ok(
      rendererNoticeLines.has(packageName),
      `Renderer third-party notices are missing ${packageName}.`,
    );
  }

  const bundledRendererPackages = [
    '@angular/animations',
    '@angular/cdk',
    '@angular/common',
    '@angular/core',
    '@angular/forms',
    '@angular/material',
    '@angular/platform-browser',
    '@angular/platform-browser-dynamic',
    '@angular/router',
    '@tweenjs/tween.js',
    'rxjs',
    'zone.js',
  ];
  const bundledRendererPackageIdentities = new Set();
  for (const packageName of bundledRendererPackages) {
    const version = projectPackageJson.devDependencies[packageName];
    assert.ok(version, `Missing expected renderer dependency declaration: ${packageName}`);
    const identity = `${packageName}@${version}`;
    bundledRendererPackageIdentities.add(identity);
    assert.ok(
      thirdPartyNotices.includes(`\n${identity}\n`),
      `Tracked shipped-package notices are missing ${identity}.`,
    );
  }

  function runtimeNoticeSection(identity) {
    const identityMarker = `\n${identity}\n`;
    const identityStart = thirdPartyNotices.indexOf(identityMarker);
    assert.notEqual(identityStart, -1, `Runtime notice section is missing ${identity}.`);
    const separator = `\n${'='.repeat(80)}\n`;
    const headerEnd = thirdPartyNotices.indexOf(separator, identityStart + identityMarker.length);
    assert.notEqual(headerEnd, -1, `Runtime notice header is malformed for ${identity}.`);
    const sectionEnd = thirdPartyNotices.indexOf(separator, headerEnd + separator.length);
    return thirdPartyNotices.slice(
      identityStart,
      sectionEnd === -1 ? thirdPartyNotices.length : sectionEnd,
    );
  }

  const requiredExactAttributions = new Map([
    ['@iharbeck/ngx-virtual-scroller@19.0.1', 'Copyright (c) 2016 Rinto Jose (rintoj)'],
    ['assert-plus@1.0.0', 'Copyright (c) 2012 Mark Cavage'],
    ['emoji-regex@8.0.0', 'Copyright Mathias Bynens <https://mathiasbynens.be/>'],
    ['punycode@2.3.1', 'Copyright Mathias Bynens <https://mathiasbynens.be/>'],
  ]);
  for (const [identity, copyrightNotice] of requiredExactAttributions) {
    assert.ok(
      runtimeNoticeSection(identity).includes(copyrightNotice),
      `The packaged notice for ${identity} is missing its reviewed copyright attribution.`,
    );
  }

  const packagedPackageIdentities = new Set();
  const applicationArchive = path.join(resourcesPath, 'app.asar');
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
  const noticePackageIdentities = new Set(
    [...thirdPartyNotices.matchAll(/^={80}\n([^\n]+)\nDeclared license:/gmu)].map(
      (match) => match[1],
    ),
  );
  const expectedNoticePackageIdentities = new Set([
    ...packagedPackageIdentities,
    ...bundledRendererPackageIdentities,
  ]);
  assert.deepEqual(
    [...noticePackageIdentities].sort(),
    [...expectedNoticePackageIdentities].sort(),
    'THIRD_PARTY_NOTICES.txt must exactly match packaged and bundled-renderer dependencies.',
  );
}

function verifyMediaTools(resourcesPath) {
  const ffmpegPath = path.join(resourcesPath, 'media-tools', 'ffmpeg');
  const ffprobePath = path.join(resourcesPath, 'media-tools', 'ffprobe');
  const manifestPath = path.join(resourcesPath, 'media-tools', 'BUILD-MANIFEST.txt');
  const packagedManifest = fs.readFileSync(manifestPath, 'utf8');

  assert.match(packagedManifest, /^Target: linux-amd64$/mu);
  assert.ok(
    packagedManifest.includes(`ffmpeg binary SHA-256: ${sha256(ffmpegPath)}`),
    'The packaged ffmpeg binary does not match its build manifest.',
  );
  assert.ok(
    packagedManifest.includes(`ffprobe binary SHA-256: ${sha256(ffprobePath)}`),
    'The packaged ffprobe binary does not match its build manifest.',
  );

  assertElfAmd64(ffmpegPath, 'packaged ffmpeg');
  assertElfAmd64(ffprobePath, 'packaged ffprobe');
  verifyLinkedLibraries(ffmpegPath, resourcesPath, false);
  verifyLinkedLibraries(ffprobePath, resourcesPath, false);

  const ffmpegVersion = run(ffmpegPath, ['-version']);
  const ffprobeVersion = run(ffprobePath, ['-version']);
  assert.match(ffmpegVersion, /^ffmpeg version 8\.1\.2/mu);
  assert.match(ffprobeVersion, /^ffprobe version 8\.1\.2/mu);
  assert.match(ffmpegVersion, /--enable-gpl/u);
  assert.match(ffmpegVersion, /--enable-libx264/u);
  assert.match(ffmpegVersion, /--disable-network/u);
  assert.doesNotMatch(ffmpegVersion, /--enable-nonfree/u);

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'theatrum-ex-machina-linux-media-'),
  );
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
    assertNonempty(thumbnailPath, 'test thumbnail');
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }

  return { ffmpegPath, ffprobePath, packagedManifest };
}

function verifyCorrespondingSource(correspondingSourcePath, packagedManifest, resourcesPath) {
  assertNonempty(correspondingSourcePath, 'corresponding-source archive');
  const archiveEntries = run('tar', ['-tf', correspondingSourcePath])
    .split(/\r?\n/u)
    .filter(Boolean);
  assert.ok(archiveEntries.length > 0, 'The corresponding-source archive is empty.');
  for (const archiveEntry of archiveEntries) {
    assert.equal(path.posix.isAbsolute(archiveEntry), false, `Unsafe absolute archive path: ${archiveEntry}`);
    assert.equal(
      archiveEntry.split('/').includes('..'),
      false,
      `Unsafe parent traversal in archive path: ${archiveEntry}`,
    );
  }
  const sourceRoots = new Set(archiveEntries.map((entry) => entry.replace(/^\.\//u, '').split('/')[0]));
  assert.equal(sourceRoots.size, 1, 'The corresponding-source archive must have one top-level directory.');
  const sourceRootName = [...sourceRoots][0];
  for (const expectedName of [
    'sources/ffmpeg-8.1.2.tar.xz',
    'sources/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz',
    'build-scripts/build-media-tools.sh',
    'licenses/GPL-2.0-or-later.txt',
    'licenses/FFMPEG-LICENSE.md',
    'licenses/X264-LICENSE.txt',
    'BUILD-MANIFEST.txt',
  ]) {
    assert.ok(
      archiveEntries.some((entry) => entry.replace(/^\.\//u, '') === `${sourceRootName}/${expectedName}`),
      `Corresponding-source archive is missing ${expectedName}`,
    );
  }

  const sourceVerificationDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'theatrum-ex-machina-linux-source-verification-'),
  );
  try {
    run('tar', ['-xf', correspondingSourcePath, '-C', sourceVerificationDirectory]);
    const sourceRoot = path.join(sourceVerificationDirectory, sourceRootName);
    assert.equal(
      sha256(path.join(sourceRoot, 'sources', 'ffmpeg-8.1.2.tar.xz')),
      '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
    );
    assert.equal(
      sha256(path.join(
        sourceRoot,
        'sources',
        'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz',
      )),
      'cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9',
    );
    const sourceManifest = fs.readFileSync(path.join(sourceRoot, 'BUILD-MANIFEST.txt'), 'utf8');
    assert.equal(
      sourceManifest,
      packagedManifest,
      'The corresponding-source manifest does not match the packaged media tools.',
    );
    const archivedBuildScript = path.join(sourceRoot, 'build-scripts', 'build-media-tools.sh');
    assert.ok(
      sourceManifest.includes(`Build script SHA-256: ${sha256(archivedBuildScript)}`),
      'The corresponding-source build script does not match its build manifest.',
    );
    assert.equal(
      sha256(archivedBuildScript),
      sha256(path.join(projectDirectory, 'bin', 'build-media-tools.sh')),
      'The corresponding-source build script differs from the release source tree.',
    );
    for (const licenseName of [
      'GPL-2.0-or-later.txt',
      'FFMPEG-LICENSE.md',
      'X264-LICENSE.txt',
    ]) {
      assert.equal(
        sha256(path.join(sourceRoot, 'licenses', licenseName)),
        sha256(path.join(resourcesPath, 'licenses', licenseName)),
        `The corresponding-source ${licenseName} differs from the packaged licence.`,
      );
    }
  } finally {
    fs.rmSync(sourceVerificationDirectory, { force: true, recursive: true });
  }
}

async function verifyPackagedStartup(executablePath) {
  if (process.env.THEATRUM_SKIP_PACKAGED_SMOKE_TEST === '1') {
    console.log('Skipping packaged Linux startup smoke test by request.');
    return;
  }
  if (!commandExists('xvfb-run')) {
    if (process.env.THEATRUM_REQUIRE_XVFB_SMOKE === '1') {
      throw new Error('xvfb-run is required for the packaged Linux startup smoke test.');
    }
    console.log('xvfb-run is unavailable; skipping the optional packaged Linux startup smoke test.');
    return;
  }

  const smokeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'theatrum-ex-machina-linux-smoke-'),
  );
  const expectedMarker = 'THEATRUM_PACKAGED_SMOKE_READY';
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('xvfb-run', [
        '-a',
        '--server-args=-screen 0 1280x800x24',
        executablePath,
        '--no-sandbox',
        '--disable-gpu',
      ], {
        detached: true,
        env: {
          ...process.env,
          XDG_CACHE_HOME: path.join(smokeDirectory, 'cache'),
          XDG_CONFIG_HOME: path.join(smokeDirectory, 'config'),
          XDG_DATA_HOME: path.join(smokeDirectory, 'data'),
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
      }, 30_000);

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
          reject(new Error(`Packaged Linux app startup timed out.\n${output}`));
        } else if (code !== 0) {
          reject(new Error(
            `Packaged Linux app exited with code ${code} (${signal || 'no signal'}).\n${output}`,
          ));
        } else if (!stdout.includes(expectedMarker)) {
          reject(new Error(`Packaged Linux app exited before renderer startup completed.\n${output}`));
        } else {
          resolve();
        }
      });
    });
  } finally {
    fs.rmSync(smokeDirectory, { force: true, recursive: true });
  }
}

function verifyDebianMetadata(debPath) {
  const field = (name) => run('dpkg-deb', ['--field', debPath, name]).trim();
  assert.equal(field('Package'), linuxPackageName, 'Unexpected Debian package name.');
  assert.equal(field('Version'), packageVersion, 'Unexpected Debian package version.');
  assert.equal(field('Architecture'), 'amd64', 'The Debian package must target amd64.');
  assert.equal(field('Priority'), 'optional', 'Unexpected Debian package priority.');
  assert.equal(field('Section'), 'video', 'Unexpected Debian package section.');
  assert.match(field('Maintainer'), /sebiimaks\s+<github\.sadness446@passmail\.net>/u);
  assert.equal(field('Homepage'), projectPackageJson.homepage, 'Unexpected Debian package homepage.');
  const description = field('Description');
  assert.match(description, /^Personal fork of Video Hub App$/mu);
  assert.match(description, /Theatrum Ex Machina is a personal fork of Video Hub App/u);
  const dependencies = field('Depends');
  for (const expectedDependency of ['libnss3', 'libxss1', 'xdg-utils']) {
    assert.match(
      dependencies,
      new RegExp(`(?:^|[, ])${expectedDependency}(?:\\s|,|$)`, 'u'),
      `Debian metadata is missing runtime dependency ${expectedDependency}.`,
    );
  }
}

function verifyDesktopIntegration(extractionRoot, extractedFiles) {
  const desktopPath = findOnly(
    extractedFiles,
    (filePath) => filePath.startsWith(path.join(extractionRoot, 'usr', 'share', 'applications'))
      && filePath.endsWith('.desktop'),
    'desktop entry',
  );
  const desktopContents = fs.readFileSync(desktopPath, 'utf8');
  const desktopEntry = parseDesktopEntry(desktopContents);
  assert.equal(desktopEntry.get('Name'), builderConfiguration.productName);
  assert.equal(desktopEntry.get('Type'), 'Application');
  assert.equal(desktopEntry.get('Terminal'), 'false');
  const categories = new Set((desktopEntry.get('Categories') || '').split(';').filter(Boolean));
  assert.ok(categories.has('AudioVideo'), 'The desktop entry lacks the AudioVideo category.');
  assert.ok(categories.has('Video'), 'The desktop entry lacks the Video category.');

  const mimeTypes = new Set((desktopEntry.get('MimeType') || '').split(';').filter(Boolean));
  const catalogueMime = builderConfiguration.fileAssociations.mimeType;
  assert.ok(mimeTypes.has(catalogueMime), `The desktop entry does not associate ${catalogueMime}.`);
  assert.equal(
    [...mimeTypes].some((mimeType) => /vha2/iu.test(mimeType)),
    false,
    'The packaged app must not compete for the legacy .vha2 association.',
  );

  const execTokens = parseDesktopExec(desktopEntry.get('Exec') || '');
  assert.ok(execTokens.length > 0, 'The desktop entry has no executable.');
  assert.ok(execTokens.includes('%U'), 'The desktop entry must accept catalogue paths with %U.');
  const executablePath = packagedPath(extractionRoot, execTokens[0]);
  assertElfAmd64(executablePath, 'packaged Electron executable');

  const mimePath = findOnly(
    extractedFiles,
    (filePath) => filePath.startsWith(path.join(extractionRoot, 'usr', 'share', 'mime', 'packages'))
      && filePath.endsWith('.xml'),
    'shared MIME database entry',
  );
  const mimeContents = fs.readFileSync(mimePath, 'utf8');
  assert.ok(
    mimeContents.includes(`type="${catalogueMime}"`),
    `The MIME definition does not declare ${catalogueMime}.`,
  );
  assert.match(mimeContents, /pattern="\*\.scaena"/u);
  assert.doesNotMatch(mimeContents, /\.vha2/iu);

  const iconName = desktopEntry.get('Icon');
  assert.ok(iconName, 'The desktop entry has no icon name.');
  const packagedIcons = extractedFiles.filter((filePath) => (
    filePath.startsWith(path.join(extractionRoot, 'usr', 'share', 'icons', 'hicolor'))
    && path.basename(filePath) === `${iconName}.png`
  ));
  assert.ok(packagedIcons.length > 0, 'The Debian package contains no application icons.');
  const iconHashes = new Set(packagedIcons.map(sha256));
  for (const sourceIconName of fs.readdirSync(path.join(projectDirectory, 'src', 'assets', 'icons', 'png'))) {
    if (!sourceIconName.endsWith('.png')) {
      continue;
    }
    const sourceIconPath = path.join(
      projectDirectory,
      'src',
      'assets',
      'icons',
      'png',
      sourceIconName,
    );
    assert.ok(
      iconHashes.has(sha256(sourceIconPath)),
      `The Debian package is missing the reviewed ${sourceIconName} application icon.`,
    );
  }

  return executablePath;
}

function verifyCriticalUnpackedFiles(unpackedRoot, packagedApplicationRoot, executablePath) {
  const unpackedResources = path.join(unpackedRoot, 'resources');
  const packagedResources = path.join(packagedApplicationRoot, 'resources');
  const criticalRelativePaths = [
    'app.asar',
    'LICENSE',
    'assets/logo.png',
    'assets/favicon-light.png',
    'assets/favicon-dark.png',
    'licenses/GPL-2.0-or-later.txt',
    'licenses/FFMPEG-LICENSE.md',
    'licenses/X264-LICENSE.txt',
    'licenses/MEDIA-TOOLS.md',
    'licenses/THIRD_PARTY_NOTICES.txt',
    'licenses/RENDERER-THIRD-PARTY-NOTICES.txt',
    'licenses/ELECTRON-LICENSE.txt',
    'licenses/LICENSES.chromium.html',
    'media-tools/BUILD-MANIFEST.txt',
    'media-tools/ffmpeg',
    'media-tools/ffprobe',
  ];
  for (const relativePath of criticalRelativePaths) {
    const unpackedFile = path.join(unpackedResources, relativePath);
    const packagedFile = path.join(packagedResources, relativePath);
    assertNonempty(unpackedFile, 'unpacked build resource');
    assert.equal(
      sha256(unpackedFile),
      sha256(packagedFile),
      `The Debian payload differs from linux-unpacked: ${relativePath}`,
    );
  }
  const unpackedExecutable = path.join(unpackedRoot, path.basename(executablePath));
  assertNonempty(unpackedExecutable, 'unpacked Electron executable');
  assert.equal(
    sha256(unpackedExecutable),
    sha256(executablePath),
    'The Debian Electron executable differs from linux-unpacked.',
  );
}

async function main() {
  const unpackedPathArgument = process.argv[2];
  if (!unpackedPathArgument) {
    throw new Error(
      'Usage: node bin/verify-packaged-linux.mjs <linux-unpacked directory> '
      + '[corresponding-source archive] [Debian package]',
    );
  }
  const unpackedRoot = path.resolve(unpackedPathArgument);
  assert.ok(fs.statSync(unpackedRoot).isDirectory(), `Not a directory: ${unpackedRoot}`);
  assertNonempty(path.join(unpackedRoot, 'resources', 'app.asar'), 'linux-unpacked application archive');
  const releaseDirectory = path.dirname(unpackedRoot);
  const correspondingSourcePath = path.resolve(process.argv[3] || path.join(
    releaseDirectory,
    `theatrum-ex-machina-media-source-v${packageVersion}-linux-amd64.tar.xz`,
  ));
  const debPath = path.resolve(process.argv[4] || path.join(
    releaseDirectory,
    `theatrum-ex-machina-v${packageVersion}-linux-amd64.deb`,
  ));
  assertNonempty(debPath, 'Debian package');
  verifyDebianMetadata(debPath);

  const extractionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'theatrum-ex-machina-deb-verification-'),
  );
  try {
    run('dpkg-deb', ['--extract', debPath, extractionRoot], 60_000);
    const extractedFiles = walkFiles(extractionRoot);
    const applicationArchive = findOnly(
      extractedFiles,
      (filePath) => filePath.endsWith(`${path.sep}resources${path.sep}app.asar`),
      'packaged app.asar',
    );
    const resourcesPath = path.dirname(applicationArchive);
    const packagedApplicationRoot = path.dirname(resourcesPath);
    const expectedInstallRoot = path.join(extractionRoot, 'opt');
    assert.ok(
      `${packagedApplicationRoot}${path.sep}`.startsWith(`${expectedInstallRoot}${path.sep}`),
      `The application must be installed below /opt: ${packagedApplicationRoot}`,
    );

    const requiredResources = [
      path.join(resourcesPath, 'LICENSE'),
      path.join(resourcesPath, 'assets', 'logo.png'),
      path.join(resourcesPath, 'assets', 'favicon-light.png'),
      path.join(resourcesPath, 'assets', 'favicon-dark.png'),
      path.join(resourcesPath, 'licenses', 'GPL-2.0-or-later.txt'),
      path.join(resourcesPath, 'licenses', 'FFMPEG-LICENSE.md'),
      path.join(resourcesPath, 'licenses', 'X264-LICENSE.txt'),
      path.join(resourcesPath, 'licenses', 'MEDIA-TOOLS.md'),
      path.join(resourcesPath, 'licenses', 'THIRD_PARTY_NOTICES.txt'),
      path.join(resourcesPath, 'licenses', 'RENDERER-THIRD-PARTY-NOTICES.txt'),
      path.join(resourcesPath, 'licenses', 'ELECTRON-LICENSE.txt'),
      path.join(resourcesPath, 'licenses', 'LICENSES.chromium.html'),
      path.join(resourcesPath, 'media-tools', 'BUILD-MANIFEST.txt'),
      path.join(resourcesPath, 'media-tools', 'ffmpeg'),
      path.join(resourcesPath, 'media-tools', 'ffprobe'),
    ];
    for (const resourcePath of requiredResources) {
      assertNonempty(resourcePath);
    }
    assert.equal(
      sha256(path.join(resourcesPath, 'LICENSE')),
      sha256(path.join(projectDirectory, 'LICENSE')),
      'The packaged application licence differs from the release source tree.',
    );
    for (const assetName of ['logo.png', 'favicon-light.png', 'favicon-dark.png']) {
      assert.equal(
        sha256(path.join(resourcesPath, 'assets', assetName)),
        sha256(path.join(projectDirectory, 'src', 'assets', assetName)),
        `The packaged ${assetName} differs from the reviewed generated asset.`,
      );
    }
    for (const legalName of [
      'GPL-2.0-or-later.txt',
      'FFMPEG-LICENSE.md',
      'X264-LICENSE.txt',
      'MEDIA-TOOLS.md',
      'THIRD_PARTY_NOTICES.txt',
      'ELECTRON-LICENSE.txt',
      'LICENSES.chromium.html',
    ]) {
      assert.equal(
        sha256(path.join(resourcesPath, 'licenses', legalName)),
        sha256(path.join(projectDirectory, 'build', 'media-legal', legalName)),
        `The packaged ${legalName} differs from the generated legal payload.`,
      );
    }
    assert.equal(
      fs.existsSync(path.join(resourcesPath, 'remote')),
      false,
      'Removed remote-control resources must not be packaged.',
    );

    const { archivedFiles } = verifyApplicationArchive(resourcesPath);
    verifyNotices(resourcesPath, archivedFiles);
    const { packagedManifest } = verifyMediaTools(resourcesPath);
    verifyCorrespondingSource(correspondingSourcePath, packagedManifest, resourcesPath);

    const executablePath = verifyDesktopIntegration(extractionRoot, extractedFiles);
    verifyLinkedLibraries(executablePath, packagedApplicationRoot, true);
    verifyCriticalUnpackedFiles(unpackedRoot, packagedApplicationRoot, executablePath);
    await verifyPackagedStartup(executablePath);
  } finally {
    fs.rmSync(extractionRoot, { force: true, recursive: true });
  }

  console.log('Packaged Linux AMD64 application, Debian integration, runtime startup, and licensing payload verified.');
}

await main();
