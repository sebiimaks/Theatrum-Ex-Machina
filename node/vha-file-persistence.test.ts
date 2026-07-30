import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';

import type { FinalObject } from '../interfaces/final-object.interface';
import { NewImageElement } from '../interfaces/final-object.interface';
import {
  parseVhaJson,
  readVhaFileWithBackup,
  recoverVhaFileFromBackup,
  writeVhaJsonAtomically,
} from './vha-file-persistence.ts';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-hub-app-sin-persistence-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createCatalogue(hubName: string): FinalObject {
  return {
    addTags: [],
    hubName,
    images: [],
    inputDirs: {
      0: {
        path: '/videos',
        watch: false,
      },
    },
    numOfFolders: 0,
    removeTags: [],
    screenshotSettings: {
      clipHeight: 144,
      clipSnippetLength: 1,
      clipSnippets: 0,
      fixed: true,
      height: 288,
      n: 10,
    },
    version: 3,
  };
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory: string) => {
    fs.rmSync(directory, { force: true, recursive: true });
  });
});

test('loads a valid primary catalogue without consulting the backup', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'valid.vha2');
  fs.writeFileSync(cataloguePath, JSON.stringify(createCatalogue('Primary')));
  fs.writeFileSync(cataloguePath + '.bak', 'invalid backup');

  const result = await readVhaFileWithBackup(cataloguePath);

  assert.equal(result.source, 'primary');
  assert.equal(result.finalObject?.hubName, 'Primary');
});

test('preserves Date Added while legacy entries remain valid without it', () => {
  const catalogue = createCatalogue('Date Added');
  const datedEntry = NewImageElement();
  datedEntry.dateAdded = 1_700_000_000_123;
  const legacyEntry = NewImageElement();
  catalogue.images = [datedEntry, legacyEntry];

  const parsed = parseVhaJson(JSON.stringify(catalogue));

  assert.equal(parsed.images[0].dateAdded, 1_700_000_000_123);
  assert.equal(parsed.images[1].dateAdded, undefined);
});

test('offers a valid backup for an empty primary catalogue', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'empty.vha2');
  fs.writeFileSync(cataloguePath, '');
  fs.writeFileSync(cataloguePath + '.bak', JSON.stringify(createCatalogue('Backup')));

  const result = await readVhaFileWithBackup(cataloguePath);

  assert.equal(result.source, 'backup');
  assert.equal(result.finalObject?.hubName, 'Backup');
  assert.equal(fs.readFileSync(cataloguePath, 'utf8'), '');
});

test('offers a valid backup for a truncated primary catalogue', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'truncated.vha2');
  fs.writeFileSync(cataloguePath, '{"hubName":"Incomplete"');
  fs.writeFileSync(cataloguePath + '.bak', JSON.stringify(createCatalogue('Backup')));

  const result = await readVhaFileWithBackup(cataloguePath);

  assert.equal(result.source, 'backup');
  assert.equal(result.finalObject?.hubName, 'Backup');
});

test('returns a controlled invalid result when neither file is usable', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'invalid.vha2');
  fs.writeFileSync(cataloguePath, '');
  fs.writeFileSync(cataloguePath + '.bak', '{');

  const result = await readVhaFileWithBackup(cataloguePath);

  assert.equal(result.source, 'invalid');
  assert.ok(result.primaryError);
  assert.ok(result.backupError);
});

test('rejects syntactically valid JSON with an invalid catalogue structure', () => {
  assert.throws(
    () => parseVhaJson('{"hubName":"Missing fields"}'),
    /images list/,
  );
});

test('serializes rapid writes and keeps the prior valid catalogue as backup', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'queued.vha2');
  fs.writeFileSync(cataloguePath, JSON.stringify(createCatalogue('Original')));

  const firstWrite = writeVhaJsonAtomically(cataloguePath, JSON.stringify(createCatalogue('First')));
  const secondWrite = writeVhaJsonAtomically(cataloguePath, JSON.stringify(createCatalogue('Second')));
  await Promise.all([firstWrite, secondWrite]);

  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath)).hubName, 'Second');
  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath + '.bak')).hubName, 'First');
});

test('recovers a backup without preserving a misleading empty corrupt file', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'recover.vha2');
  fs.writeFileSync(cataloguePath, '');
  fs.writeFileSync(cataloguePath + '.bak', JSON.stringify(createCatalogue('Recovered')));

  const result = await recoverVhaFileFromBackup(cataloguePath);

  assert.equal(result.finalObject.hubName, 'Recovered');
  assert.equal(result.corruptPath, undefined);
  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath)).hubName, 'Recovered');
  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath + '.bak')).hubName, 'Recovered');
});

test('preserves a non-empty malformed primary before recovering its backup', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'recover-malformed.vha2');
  const malformedCatalogue = '{"hubName":"Incomplete"';
  fs.writeFileSync(cataloguePath, malformedCatalogue);
  fs.writeFileSync(cataloguePath + '.bak', JSON.stringify(createCatalogue('Recovered')));

  const result = await recoverVhaFileFromBackup(cataloguePath);

  assert.ok(result.corruptPath);
  assert.equal(fs.readFileSync(result.corruptPath, 'utf8'), malformedCatalogue);
  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath)).hubName, 'Recovered');
});

test('continues the write queue after an invalid write is rejected', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'failed-queue.vha2');
  fs.writeFileSync(cataloguePath, JSON.stringify(createCatalogue('Original')));

  const invalidWrite = writeVhaJsonAtomically(cataloguePath, '{');
  const validWrite = writeVhaJsonAtomically(cataloguePath, JSON.stringify(createCatalogue('Valid')));

  await assert.rejects(invalidWrite);
  await validWrite;
  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath)).hubName, 'Valid');
});

test('does not overwrite an existing invalid catalogue or its valid backup', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'externally-damaged.vha2');
  const invalidPrimary = '{"hubName":"Externally damaged"';
  const validBackup = JSON.stringify(createCatalogue('Backup'));
  fs.writeFileSync(cataloguePath, invalidPrimary);
  fs.writeFileSync(cataloguePath + '.bak', validBackup);

  await assert.rejects(
    writeVhaJsonAtomically(cataloguePath, JSON.stringify(createCatalogue('Replacement'))),
  );

  assert.equal(fs.readFileSync(cataloguePath, 'utf8'), invalidPrimary);
  assert.equal(fs.readFileSync(cataloguePath + '.bak', 'utf8'), validBackup);
});
