import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FinalObject } from '../interfaces/final-object.interface';
import type { PrivateHubSession } from './private-hub-session';
import { GLOBALS } from './main-globals';
import { writeVhaFileToDisk } from './main-support';
import {
  NORMAL_CATALOGUE_STORAGE, captureCatalogueStorageTarget, readCatalogueStorage,
  recoverCatalogueStorage, requireNormalCatalogueStorage, writeCatalogueStorage,
  type CatalogueStorage,
} from './catalogue-storage';

function catalogue(): FinalObject {
  return {
    version: 3, hubName: 'Synthetic private catalogue', images: [], inputDirs: {},
    addTags: [], removeTags: [], numOfFolders: 0,
    screenshotSettings: { n: 1, height: 288, fixed: true, clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0 },
  };
}

async function fixture(t: TestContext): Promise<{ directory: string; filePath: string }> {
  const root = path.resolve(__dirname, '..', 'tmp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'storage-routing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, 'catalogue.scaena') };
}

test('normal storage retains validated atomic saves, backups and explicit recovery', async t => {
  const { filePath } = await fixture(t);
  const target = captureCatalogueStorageTarget(NORMAL_CATALOGUE_STORAGE, filePath);
  await writeCatalogueStorage(target, catalogue());
  await writeCatalogueStorage(target, { ...catalogue(), hubName: 'Second' });
  assert.equal((await readCatalogueStorage(target)).finalObject.hubName, 'Second');
  await fs.writeFile(filePath, 'damaged');
  assert.equal((await readCatalogueStorage(target)).source, 'backup');
  assert.equal((await recoverCatalogueStorage(target)).finalObject.hubName, catalogue().hubName);
});

test('private targets ignore normal backups and never fall back after encrypted read/write failures', async t => {
  const { directory, filePath } = await fixture(t);
  await fs.writeFile(filePath, 'original plaintext copy');
  await fs.writeFile(filePath + '.bak', JSON.stringify(catalogue()));
  let current = true;
  const calls: unknown[] = [];
  const session = {
    isCurrent: (generation: number) => current && generation === 9,
    readCatalogue: async (generation: number) => { calls.push(generation); throw new Error('Encrypted read failed'); },
    writeCatalogue: async (generation: number, value: FinalObject) => { calls.push([generation, value]); throw new Error('Encrypted save failed'); },
  } as unknown as PrivateHubSession;
  const mode: CatalogueStorage = { kind: 'private', cataloguePath: filePath, session, generation: 9 };
  const target = captureCatalogueStorageTarget(mode, filePath);
  await assert.rejects(readCatalogueStorage(target), /Encrypted read failed/);
  await assert.rejects(writeCatalogueStorage(target, catalogue()), /Encrypted save failed/);
  await assert.rejects(recoverCatalogueStorage(target), /encrypted storage/);
  assert.throws(() => requireNormalCatalogueStorage(mode), /private hubs/);
  assert.throws(() => captureCatalogueStorageTarget(mode, path.join(directory, 'new.scaena')), /unavailable/);
  current = false;
  assert.throws(() => captureCatalogueStorageTarget(mode, filePath), /unavailable/);
  assert.equal(calls.length, 2);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'original plaintext copy');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['catalogue.scaena', 'catalogue.scaena.bak']);
});

test('the production common writer dispatches by captured main-owned mode and does not create a plaintext file', async t => {
  const { filePath, directory } = await fixture(t);
  const previous = GLOBALS.catalogueStorage;
  t.after(() => { GLOBALS.catalogueStorage = previous; });
  let committed: FinalObject | undefined;
  const session = {
    isCurrent: (generation: number) => generation === 12,
    writeCatalogue: async (generation: number, value: FinalObject) => {
      assert.equal(generation, 12);
      // A mode switch while completion is pending cannot redirect this operation.
      GLOBALS.catalogueStorage = NORMAL_CATALOGUE_STORAGE;
      await Promise.resolve();
      committed = value;
    },
  } as unknown as PrivateHubSession;
  GLOBALS.catalogueStorage = { kind: 'private', cataloguePath: filePath, session, generation: 12 };
  await new Promise<void>((resolve, reject) => {
    writeVhaFileToDisk(catalogue(), filePath, (error?: Error) => error ? reject(error) : resolve());
  });
  assert.equal(committed?.hubName, catalogue().hubName);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('unknown modes and malformed normal destinations cannot select a writer', () => {
  for (const mode of [undefined, {}, { kind: 'future' }]) {
    assert.throws(() => captureCatalogueStorageTarget(mode as CatalogueStorage, '/unused/catalogue.scaena'), /unavailable/);
  }
  for (const invalid of ['', 'relative.scaena', '/invalid\0file']) {
    assert.throws(() => captureCatalogueStorageTarget(NORMAL_CATALOGUE_STORAGE, invalid), /destination/);
  }
});
