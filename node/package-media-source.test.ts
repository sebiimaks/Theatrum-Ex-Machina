import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

const projectDirectory = path.resolve(__dirname, '..');
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'),
).version;
const temporaryDirectories: string[] = [];

function createFixture(): {
  legalDirectory: string;
  releaseDirectory: string;
  sourceDirectory: string;
} {
  const fixtureDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'theatrum-media-source-package-'),
  );
  temporaryDirectories.push(fixtureDirectory);
  const sourceDirectory = path.join(fixtureDirectory, 'sources');
  const legalDirectory = path.join(fixtureDirectory, 'legal');
  const releaseDirectory = path.join(fixtureDirectory, 'release');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(legalDirectory, { recursive: true });

  for (const fileName of [
    'ffmpeg-8.1.2.tar.xz',
    'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz',
    'BUILD-MANIFEST.txt',
  ]) {
    fs.writeFileSync(path.join(sourceDirectory, fileName), `${fileName}\n`);
  }
  for (const fileName of [
    'GPL-2.0-or-later.txt',
    'FFMPEG-LICENSE.md',
    'X264-LICENSE.txt',
  ]) {
    fs.writeFileSync(path.join(legalDirectory, fileName), `${fileName}\n`);
  }

  return { legalDirectory, releaseDirectory, sourceDirectory };
}

function packageSource(
  fixture: ReturnType<typeof createFixture>,
  platformSuffix?: string,
) {
  const arguments_ = [
    path.join(projectDirectory, 'bin', 'package-media-source.sh'),
    fixture.releaseDirectory,
  ];
  if (platformSuffix !== undefined) {
    arguments_.push(platformSuffix);
  }
  return spawnSync('sh', arguments_, {
    encoding: 'utf8',
    env: {
      ...process.env,
      MEDIA_LEGAL_OUTPUT_DIR: fixture.legalDirectory,
      MEDIA_SOURCE_OUTPUT_DIR: fixture.sourceDirectory,
    },
  });
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { force: true, recursive: true });
  });
});

test('media-source packaging preserves the existing unsuffixed archive name', () => {
  const fixture = createFixture();
  const result = packageSource(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(
    fixture.releaseDirectory,
    `theatrum-ex-machina-media-source-v${packageVersion}.tar.xz`,
  )));
});

test('media-source packaging safely appends a platform suffix', () => {
  const fixture = createFixture();
  const result = packageSource(fixture, 'linux-amd64');
  assert.equal(result.status, 0, result.stderr);

  const archivePath = path.join(
    fixture.releaseDirectory,
    `theatrum-ex-machina-media-source-v${packageVersion}-linux-amd64.tar.xz`,
  );
  assert.ok(fs.existsSync(archivePath));
  const listing = spawnSync('tar', ['-tJf', archivePath], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(
    listing.stdout,
    new RegExp(`^theatrum-ex-machina-media-source-v${packageVersion}-linux-amd64/`, 'm'),
  );
});

test('media-source packaging rejects unsafe platform suffixes', () => {
  const fixture = createFixture();
  for (const invalidSuffix of ['../linux-amd64', 'Linux AMD64', '-linux', 'linux-']) {
    const result = packageSource(fixture, invalidSuffix);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid media-source platform suffix/);
  }
  assert.equal(fs.existsSync(fixture.releaseDirectory), false);
});
