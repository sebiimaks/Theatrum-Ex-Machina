import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  beginPreviewTransaction,
  markPreviewTransactionCommitted,
  recoverInterruptedPreviewTransactions,
} from './thumbnail-transaction';

const temporaryDirectories: string[] = [];

interface PreviewOutputFolder {
  assetDirectory: string;
  outputDirectory: string;
}

function createOutputFolder(): PreviewOutputFolder {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vha-thumbnail-transaction-'));
  const assetDirectory = path.join(outputDirectory, 'vha-Test');
  temporaryDirectories.push(outputDirectory);
  for (const subfolder of ['thumbnails', 'filmstrips', 'clips', '.thumbnail-regeneration/job-1']) {
    fs.mkdirSync(path.join(assetDirectory, subfolder), { recursive: true });
  }
  return { assetDirectory, outputDirectory };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

test('rolls back an interrupted pending transaction on the next catalogue open', async () => {
  const { assetDirectory, outputDirectory } = createOutputFolder();
  const stagingFolder = path.join(assetDirectory, '.thumbnail-regeneration', 'job-1');
  const thumbnailRelative = path.join('thumbnails', 'sample.jpg');
  const filmstripRelative = path.join('filmstrips', 'sample.jpg');
  const thumbnailPath = path.join(assetDirectory, thumbnailRelative);
  const filmstripPath = path.join(assetDirectory, filmstripRelative);
  const backupSuffix = '.regeneration-1-2-3.bak';
  fs.writeFileSync(thumbnailPath, 'old thumbnail');

  await beginPreviewTransaction(
    stagingFolder,
    assetDirectory,
    [thumbnailRelative, filmstripRelative],
    backupSuffix,
  );
  fs.renameSync(thumbnailPath, thumbnailPath + backupSuffix);
  fs.writeFileSync(thumbnailPath, 'new thumbnail');
  fs.writeFileSync(filmstripPath, 'new filmstrip');

  const result = await recoverInterruptedPreviewTransactions(outputDirectory, assetDirectory);

  assert.deepEqual(result, { committedCleaned: 0, rolledBack: 1 });
  assert.equal(fs.readFileSync(thumbnailPath, 'utf8'), 'old thumbnail');
  assert.equal(fs.existsSync(filmstripPath), false);
  assert.equal(fs.existsSync(stagingFolder), false);
});

test('keeps a committed replacement and removes its old backup', async () => {
  const { assetDirectory, outputDirectory } = createOutputFolder();
  const stagingFolder = path.join(assetDirectory, '.thumbnail-regeneration', 'job-1');
  const thumbnailRelative = path.join('thumbnails', 'sample.jpg');
  const thumbnailPath = path.join(assetDirectory, thumbnailRelative);
  const backupSuffix = '.regeneration-4-5-6.bak';
  fs.writeFileSync(thumbnailPath, 'old thumbnail');

  const manifest = await beginPreviewTransaction(
    stagingFolder,
    assetDirectory,
    [thumbnailRelative],
    backupSuffix,
  );
  fs.renameSync(thumbnailPath, thumbnailPath + backupSuffix);
  fs.writeFileSync(thumbnailPath, 'new thumbnail');
  await markPreviewTransactionCommitted(stagingFolder, manifest);

  const result = await recoverInterruptedPreviewTransactions(outputDirectory, assetDirectory);

  assert.deepEqual(result, { committedCleaned: 1, rolledBack: 0 });
  assert.equal(fs.readFileSync(thumbnailPath, 'utf8'), 'new thumbnail');
  assert.equal(fs.existsSync(thumbnailPath + backupSuffix), false);
  assert.equal(fs.existsSync(stagingFolder), false);
});

test('rejects recovery when a preview directory resolves outside the active asset tree', async () => {
  const { assetDirectory, outputDirectory } = createOutputFolder();
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vha-thumbnail-transaction-outside-'));
  temporaryDirectories.push(outsideDirectory);
  const stagingFolder = path.join(assetDirectory, '.thumbnail-regeneration', 'job-1');
  const thumbnailRelative = path.join('thumbnails', 'sample.jpg');
  const backupSuffix = '.regeneration-7-8-9.bak';
  const outsideThumbnail = path.join(outsideDirectory, 'sample.jpg');
  fs.writeFileSync(outsideThumbnail, 'new thumbnail');
  fs.writeFileSync(outsideThumbnail + backupSuffix, 'old thumbnail');
  fs.rmSync(path.join(assetDirectory, 'thumbnails'), { force: true, recursive: true });
  fs.symlinkSync(outsideDirectory, path.join(assetDirectory, 'thumbnails'), 'dir');

  await beginPreviewTransaction(
    stagingFolder,
    assetDirectory,
    [thumbnailRelative],
    backupSuffix,
  );

  await assert.rejects(
    recoverInterruptedPreviewTransactions(outputDirectory, assetDirectory),
    /outside the active catalogue assets/,
  );
  assert.equal(fs.readFileSync(outsideThumbnail, 'utf8'), 'new thumbnail');
  assert.equal(fs.readFileSync(outsideThumbnail + backupSuffix, 'utf8'), 'old thumbnail');
});
