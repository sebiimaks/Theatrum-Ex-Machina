import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { createTheatrumMediaUrl } from '../interfaces/theatrum-protocol.ts';
import {
  resolveTheatrumAppFile,
  resolveTheatrumAssetDirectory,
  resolveCanonicalTheatrumAssetDirectory,
  resolveCanonicalTheatrumExistingAssetPath,
  resolveCanonicalTheatrumMediaWriteTarget,
  resolveTheatrumMediaFile,
} from './theatrum-protocol-paths.ts';

const distDirectory = path.join(path.sep, 'tmp', 'theatrum-dist');
const assetDirectory = path.join(path.sep, 'tmp', 'catalogues', 'vha-Photography');

test('resolves only static files beneath the application bundle', () => {
  assert.equal(
    resolveTheatrumAppFile('theatrum://app/', distDirectory),
    path.join(distDirectory, 'index.html'),
  );
  assert.equal(
    resolveTheatrumAppFile('theatrum://app/assets/logo.png', distDirectory),
    path.join(distDirectory, 'assets', 'logo.png'),
  );
  assert.equal(resolveTheatrumAppFile('theatrum://other/index.html', distDirectory), undefined);
  assert.equal(resolveTheatrumAppFile('file:///etc/passwd', distDirectory), undefined);
  assert.equal(resolveTheatrumAppFile('theatrum://app/%2e%2e%2fsecret.txt', distDirectory), undefined);
  assert.equal(resolveTheatrumAppFile('theatrum://app/media/thumbnails/hash.jpg', distDirectory), undefined);
});

test('creates generated-media URLs with no absolute local path', () => {
  const mediaUrl = createTheatrumMediaUrl('thumbnails', 'hash:1', false, 'cache key');

  assert.equal(mediaUrl, 'theatrum://app/media/thumbnails/hash%3A1.jpg?v=cache%20key');
  assert.equal(createTheatrumMediaUrl('clips', 'hash:1', true), 'theatrum://app/media/clips/hash%3A1.mp4');
  assert.equal(createTheatrumMediaUrl('thumbnails', '../secret', false), '');
});

test('serves only expected generated-preview file types from the active asset root', () => {
  assert.equal(
    resolveTheatrumMediaFile('theatrum://app/media/thumbnails/hash%3A1.jpg?v=1', assetDirectory),
    path.join(assetDirectory, 'thumbnails', 'hash:1.jpg'),
  );
  assert.equal(
    resolveTheatrumMediaFile('theatrum://app/media/filmstrips/hash.jpg', assetDirectory),
    path.join(assetDirectory, 'filmstrips', 'hash.jpg'),
  );
  assert.equal(
    resolveTheatrumMediaFile('theatrum://app/media/clips/hash.mp4', assetDirectory),
    path.join(assetDirectory, 'clips', 'hash.mp4'),
  );
  assert.equal(
    resolveTheatrumMediaFile('theatrum://app/media/clips/hash.jpg', assetDirectory),
    path.join(assetDirectory, 'clips', 'hash.jpg'),
  );

  for (const unsafeUrl of [
    'theatrum://app/media/clips/hash.png',
    'theatrum://app/media/thumbnails/hash.mp4',
    'theatrum://app/media/other/hash.jpg',
    'theatrum://app/media/thumbnails/%2e%2e%2fsecret.jpg',
    'theatrum://app/media/thumbnails/hash.jpg/extra',
    'theatrum://other/media/thumbnails/hash.jpg',
  ]) {
    assert.equal(resolveTheatrumMediaFile(unsafeUrl, assetDirectory), undefined, unsafeUrl);
  }
});

test('keeps the generated asset root under the configured catalogue output directory', () => {
  assert.equal(
    resolveTheatrumAssetDirectory(path.join(path.sep, 'tmp', 'catalogues'), 'Photography'),
    assetDirectory,
  );
  assert.equal(resolveTheatrumAssetDirectory('/tmp/catalogues', '../secret'), undefined);
  assert.equal(resolveTheatrumAssetDirectory('/tmp/catalogues', 'bad/name'), undefined);
  assert.equal(resolveTheatrumAssetDirectory('/tmp/catalogues', 'bad\\name'), undefined);
});

test('rejects generated-preview writes redirected outside the active asset directory', () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-output-'));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-outside-'));
  try {
    const assets = path.join(outputDirectory, 'vha-Test');
    const thumbnails = path.join(assets, 'thumbnails');
    fs.mkdirSync(thumbnails, { recursive: true });
    const safeTarget = path.join(thumbnails, 'safe.jpg');
    assert.equal(
      resolveCanonicalTheatrumMediaWriteTarget(safeTarget, outputDirectory, assets),
      fs.realpathSync.native(thumbnails) + path.sep + 'safe.jpg',
    );

    const outsideTarget = path.join(outsideDirectory, 'outside.jpg');
    fs.writeFileSync(outsideTarget, 'outside');
    const escapedTarget = path.join(thumbnails, 'escaped.jpg');
    fs.symlinkSync(outsideTarget, escapedTarget);
    assert.equal(
      resolveCanonicalTheatrumMediaWriteTarget(escapedTarget, outputDirectory, assets),
      undefined,
    );
  } finally {
    fs.rmSync(outputDirectory, { force: true, recursive: true });
    fs.rmSync(outsideDirectory, { force: true, recursive: true });
  }
});

test('rejects asset-root and child-directory symlink escapes for cleanup and preview writes', () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-canonical-output-'));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-canonical-outside-'));
  try {
    const escapedAssets = path.join(outputDirectory, 'vha-Escaped');
    fs.symlinkSync(outsideDirectory, escapedAssets, 'dir');
    assert.equal(
      resolveCanonicalTheatrumAssetDirectory(outputDirectory, escapedAssets),
      undefined,
    );

    const assets = path.join(outputDirectory, 'vha-Test');
    const thumbnails = path.join(assets, 'thumbnails');
    fs.mkdirSync(thumbnails, { recursive: true });
    const outsidePreview = path.join(outsideDirectory, 'escaped.jpg');
    fs.writeFileSync(outsidePreview, 'outside preview');
    fs.rmSync(thumbnails, { force: true, recursive: true });
    fs.symlinkSync(outsideDirectory, thumbnails, 'dir');

    assert.equal(
      resolveCanonicalTheatrumExistingAssetPath(
        path.join(thumbnails, 'escaped.jpg'),
        outputDirectory,
        assets,
      ),
      undefined,
    );
    assert.equal(
      resolveCanonicalTheatrumMediaWriteTarget(
        path.join(thumbnails, 'replacement.jpg'),
        outputDirectory,
        assets,
      ),
      undefined,
    );
  } finally {
    fs.rmSync(outputDirectory, { force: true, recursive: true });
    fs.rmSync(outsideDirectory, { force: true, recursive: true });
  }
});
