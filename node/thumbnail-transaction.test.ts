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

function createOutputFolder(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vha-thumbnail-transaction-'));
  temporaryDirectories.push(directory);
  for (const subfolder of ['thumbnails', 'filmstrips', 'clips', '.thumbnail-regeneration/job-1']) {
    fs.mkdirSync(path.join(directory, subfolder), { recursive: true });
  }
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

test('rolls back an interrupted pending transaction on the next catalogue open', async () => {
  const outputFolder = createOutputFolder();
  const stagingFolder = path.join(outputFolder, '.thumbnail-regeneration', 'job-1');
  const thumbnailRelative = path.join('thumbnails', 'sample.jpg');
  const filmstripRelative = path.join('filmstrips', 'sample.jpg');
  const thumbnailPath = path.join(outputFolder, thumbnailRelative);
  const filmstripPath = path.join(outputFolder, filmstripRelative);
  const backupSuffix = '.regeneration-1-2-3.bak';
  fs.writeFileSync(thumbnailPath, 'old thumbnail');

  await beginPreviewTransaction(
    stagingFolder,
    outputFolder,
    [thumbnailRelative, filmstripRelative],
    backupSuffix,
  );
  fs.renameSync(thumbnailPath, thumbnailPath + backupSuffix);
  fs.writeFileSync(thumbnailPath, 'new thumbnail');
  fs.writeFileSync(filmstripPath, 'new filmstrip');

  const result = await recoverInterruptedPreviewTransactions(outputFolder);

  assert.deepEqual(result, { committedCleaned: 0, rolledBack: 1 });
  assert.equal(fs.readFileSync(thumbnailPath, 'utf8'), 'old thumbnail');
  assert.equal(fs.existsSync(filmstripPath), false);
  assert.equal(fs.existsSync(stagingFolder), false);
});

test('keeps a committed replacement and removes its old backup', async () => {
  const outputFolder = createOutputFolder();
  const stagingFolder = path.join(outputFolder, '.thumbnail-regeneration', 'job-1');
  const thumbnailRelative = path.join('thumbnails', 'sample.jpg');
  const thumbnailPath = path.join(outputFolder, thumbnailRelative);
  const backupSuffix = '.regeneration-4-5-6.bak';
  fs.writeFileSync(thumbnailPath, 'old thumbnail');

  const manifest = await beginPreviewTransaction(
    stagingFolder,
    outputFolder,
    [thumbnailRelative],
    backupSuffix,
  );
  fs.renameSync(thumbnailPath, thumbnailPath + backupSuffix);
  fs.writeFileSync(thumbnailPath, 'new thumbnail');
  await markPreviewTransactionCommitted(stagingFolder, manifest);

  const result = await recoverInterruptedPreviewTransactions(outputFolder);

  assert.deepEqual(result, { committedCleaned: 1, rolledBack: 0 });
  assert.equal(fs.readFileSync(thumbnailPath, 'utf8'), 'new thumbnail');
  assert.equal(fs.existsSync(thumbnailPath + backupSuffix), false);
  assert.equal(fs.existsSync(stagingFolder), false);
});
