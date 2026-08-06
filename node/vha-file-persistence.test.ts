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
import { writeVhaFileToDisk } from './main-support';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-persistence-'));
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

function writeCatalogue(catalogue: FinalObject, cataloguePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    writeVhaFileToDisk(catalogue, cataloguePath, (error?: Error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory: string) => {
    fs.rmSync(directory, { force: true, recursive: true });
  });
});

test('loads a valid legacy catalogue without consulting the backup', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'legacy.vha2');
  fs.writeFileSync(cataloguePath, JSON.stringify(createCatalogue('Primary')));
  fs.writeFileSync(cataloguePath + '.bak', 'invalid backup');

  const result = await readVhaFileWithBackup(cataloguePath);

  assert.equal(result.source, 'primary');
  assert.equal(result.finalObject?.hubName, 'Primary');
});

test('saves an opened legacy catalogue in place without creating a branded copy', async () => {
  const directory = createTemporaryDirectory();
  const legacyPath = path.join(directory, 'legacy.vha2');
  fs.writeFileSync(legacyPath, JSON.stringify(createCatalogue('Original')));

  await writeVhaJsonAtomically(legacyPath, JSON.stringify(createCatalogue('Updated')));

  assert.equal(parseVhaJson(fs.readFileSync(legacyPath)).hubName, 'Updated');
  assert.equal(parseVhaJson(fs.readFileSync(legacyPath + '.bak')).hubName, 'Original');
  assert.equal(fs.existsSync(path.join(directory, 'legacy.scaena')), false);
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

test('round-trips persistent tag definitions that are not assigned to videos', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'tag-definitions.scaena');
  const catalogue = createCatalogue('Tag Definitions');
  catalogue.tagDefinitions = [
    'Camera',
    'Camera > Rangefinder',
    'Unassigned',
  ];

  await writeCatalogue(catalogue, cataloguePath);
  const reloaded = await readVhaFileWithBackup(cataloguePath);

  assert.equal(reloaded.source, 'primary');
  assert.deepEqual(reloaded.finalObject?.tagDefinitions, catalogue.tagDefinitions);
  assert.deepEqual(reloaded.finalObject?.images, []);
});

test('keeps legacy catalogues valid without tag definitions and rejects malformed registries', () => {
  const legacyCatalogue = createCatalogue('Legacy Tags');
  assert.equal(parseVhaJson(JSON.stringify(legacyCatalogue)).tagDefinitions, undefined);

  const malformedCatalogue = createCatalogue('Malformed Tags') as unknown as Record<string, unknown>;
  malformedCatalogue.tagDefinitions = ['valid', 42];
  assert.throws(
    () => parseVhaJson(JSON.stringify(malformedCatalogue)),
    /invalid tag definitions/,
  );
});

test('preserves temporarily missing entries and their user metadata', () => {
  const catalogue = createCatalogue('Temporarily Offline');
  const missingEntry = NewImageElement();
  missingEntry.dateAdded = 1_700_000_000_123;
  missingEntry.missing = true;
  missingEntry.notes = 'Do not discard this note';
  missingEntry.tags = ['important'];
  catalogue.images = [missingEntry];

  const parsed = parseVhaJson(JSON.stringify(catalogue));

  assert.equal(parsed.images[0].missing, true);
  assert.equal(parsed.images[0].notes, 'Do not discard this note');
  assert.deepEqual(parsed.images[0].tags, ['important']);
  assert.equal(parsed.images[0].dateAdded, 1_700_000_000_123);
});

test('actual catalogue save and reload retains temporarily missing metadata', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'temporarily-offline.scaena');
  const catalogue = createCatalogue('Temporarily Offline Round Trip');
  const missingEntry = NewImageElement();
  missingEntry.dateAdded = 1_700_000_000_123;
  missingEntry.fileName = 'offline.mp4';
  missingEntry.inputSource = 0;
  missingEntry.missing = true;
  missingEntry.notes = 'Preserve through the real save path';
  missingEntry.partialPath = '/folder';
  missingEntry.tags = ['important'];
  catalogue.images = [missingEntry];

  await writeCatalogue(catalogue, cataloguePath);
  const reloaded = await readVhaFileWithBackup(cataloguePath);

  assert.equal(reloaded.source, 'primary');
  assert.equal(reloaded.finalObject?.images.length, 1);
  assert.equal(reloaded.finalObject?.images[0].missing, true);
  assert.equal(reloaded.finalObject?.images[0].notes, 'Preserve through the real save path');
  assert.deepEqual(reloaded.finalObject?.images[0].tags, ['important']);
  assert.equal(reloaded.finalObject?.images[0].dateAdded, 1_700_000_000_123);
});

test('rejects malformed missing-file state instead of treating it inconsistently', () => {
  const catalogue = createCatalogue('Malformed Missing State');
  const malformedEntry = NewImageElement() as unknown as Record<string, unknown>;
  malformedEntry.missing = 'yes';
  catalogue.images = [malformedEntry as unknown as ReturnType<typeof NewImageElement>];

  assert.throws(
    () => parseVhaJson(JSON.stringify(catalogue)),
    /invalid missing-file state/,
  );
});

test('offers a valid backup for an empty primary catalogue', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'empty.scaena');
  fs.writeFileSync(cataloguePath, '');
  fs.writeFileSync(cataloguePath + '.bak', JSON.stringify(createCatalogue('Backup')));

  const result = await readVhaFileWithBackup(cataloguePath);

  assert.equal(result.source, 'backup');
  assert.equal(result.finalObject?.hubName, 'Backup');
  assert.equal(fs.readFileSync(cataloguePath, 'utf8'), '');
});

test('offers a valid backup for a truncated primary catalogue', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'truncated.scaena');
  fs.writeFileSync(cataloguePath, '{"hubName":"Incomplete"');
  fs.writeFileSync(cataloguePath + '.bak', JSON.stringify(createCatalogue('Backup')));

  const result = await readVhaFileWithBackup(cataloguePath);

  assert.equal(result.source, 'backup');
  assert.equal(result.finalObject?.hubName, 'Backup');
});

test('returns a controlled invalid result when neither file is usable', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'invalid.scaena');
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
  const cataloguePath = path.join(directory, 'queued.scaena');
  fs.writeFileSync(cataloguePath, JSON.stringify(createCatalogue('Original')));

  const firstWrite = writeVhaJsonAtomically(cataloguePath, JSON.stringify(createCatalogue('First')));
  const secondWrite = writeVhaJsonAtomically(cataloguePath, JSON.stringify(createCatalogue('Second')));
  await Promise.all([firstWrite, secondWrite]);

  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath)).hubName, 'Second');
  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath + '.bak')).hubName, 'First');
});

test('recovers a backup without preserving a misleading empty corrupt file', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'recover.scaena');
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
  const cataloguePath = path.join(directory, 'recover-malformed.scaena');
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
  const cataloguePath = path.join(directory, 'failed-queue.scaena');
  fs.writeFileSync(cataloguePath, JSON.stringify(createCatalogue('Original')));

  const invalidWrite = writeVhaJsonAtomically(cataloguePath, '{');
  const validWrite = writeVhaJsonAtomically(cataloguePath, JSON.stringify(createCatalogue('Valid')));

  await assert.rejects(invalidWrite);
  await validWrite;
  assert.equal(parseVhaJson(fs.readFileSync(cataloguePath)).hubName, 'Valid');
});

test('does not overwrite an existing invalid catalogue or its valid backup', async () => {
  const directory = createTemporaryDirectory();
  const cataloguePath = path.join(directory, 'externally-damaged.scaena');
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
