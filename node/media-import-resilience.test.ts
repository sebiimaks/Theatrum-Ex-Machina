import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  IMPORT_ERROR_TAG,
  NewImageElement,
  isMetadataImportFailure,
} from '../interfaces/final-object.interface.ts';
import {
  LOCAL_FFPROBE_TIMEOUT_MS,
  VOLUME_FFPROBE_TIMEOUT_MS,
  createImportErrorElement,
  getFfprobeTimeoutMs,
  runProbeWithOneRetry,
  shouldExtractThumbnails,
  shouldQueueAutomaticPreviews,
} from './media-import-resilience.ts';

const temporaryDirectories: string[] = [];

function createTemporaryFile(contents = 'not a valid video'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-import-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'network sample.mp4');
  fs.writeFileSync(filePath, contents);
  return filePath;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { force: true, recursive: true });
  });
});

test('allows mounted macOS volumes longer to answer FFprobe', () => {
  assert.equal(getFfprobeTimeoutMs('/Volumes/Videos/sample.mp4', 'darwin'), VOLUME_FFPROBE_TIMEOUT_MS);
  assert.equal(getFfprobeTimeoutMs('/Users/test/Videos/sample.mp4', 'darwin'), LOCAL_FFPROBE_TIMEOUT_MS);
});

test('retries one quick probe failure after the file settles', async () => {
  let attempts = 0;
  const result = await runProbeWithOneRetry(
    '/Volumes/Videos/sample.mp4',
    async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('moov atom not found');
      }
      return 'metadata';
    },
    { waitForSettle: async () => undefined },
  );

  assert.equal(result, 'metadata');
  assert.equal(attempts, 2);
});

test('does not multiply the full timeout allowance with another probe', async () => {
  let attempts = 0;
  const timeoutError = Object.assign(new Error('timed out'), { killed: true });

  await assert.rejects(
    runProbeWithOneRetry(
      '/Volumes/Videos/sample.mp4',
      async () => {
        attempts++;
        throw timeoutError;
      },
      { waitForSettle: async () => undefined },
    ),
    timeoutError,
  );

  assert.equal(attempts, 1);
});

test('creates a persistent, thumbnail-free catalogue entry after probe failure', async () => {
  const filePath = createTemporaryFile();
  const first = await createImportErrorElement(filePath);
  const second = await createImportErrorElement(filePath);

  assert.equal(first.hash, second.hash);
  assert.equal(first.fileSize, fs.statSync(filePath).size);
  assert.equal(first.metadataImportFailed, true);
  assert.deepEqual(first.tags, [IMPORT_ERROR_TAG]);
  assert.equal(first.screens, 0);
  assert.equal(isMetadataImportFailure(first), true);
  assert.equal(shouldExtractThumbnails(first), false);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test('folder-add preference suppresses automatic previews without suppressing metadata', async () => {
  const valid = NewImageElement();
  const failed = await createImportErrorElement(createTemporaryFile());

  assert.equal(shouldExtractThumbnails(valid), true);
  assert.equal(shouldQueueAutomaticPreviews(valid), true);
  assert.equal(shouldQueueAutomaticPreviews(valid, true), true);
  assert.equal(shouldQueueAutomaticPreviews(valid, false), false);
  assert.equal(shouldQueueAutomaticPreviews(failed, true), false);
});
