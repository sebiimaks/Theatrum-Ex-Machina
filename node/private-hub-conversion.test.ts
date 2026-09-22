import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { NewImageElement } from '../interfaces/final-object.interface';
import type { FinalObject } from '../interfaces/final-object.interface';
import { readPrivateHubCatalogue, readPrivateHubPreview, privateHubClipMediaId } from './private-hub-catalogue';
import {
  convertCatalogueToPrivateHub,
  readPrivateHubConversionReceipt,
  verifyPrivateHubConversion,
} from './private-hub-conversion';
import type { PrivateHubConversionOptions } from './private-hub-conversion';
import { openPrivateHubMedia, PRIVATE_HUB_MEDIA_CHUNK_BYTES } from './private-hub-media';
import { PrivateHubStore } from './private-hub-store';

const marker = 'PRIVATE-CONVERSION-CANARY';
const password = 'Private conversion test passphrase 2026!';
const hash = 'test-video-1';

async function fixture(t: TestContext): Promise<{
  root: string; source: string; cataloguePath: string; assets: string; destination: string;
  catalogue: FinalObject; clip: Buffer; options: PrivateHubConversionOptions;
}> {
  const temporary = path.join(__dirname, '..', 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-conversion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const cataloguePath = path.join(source, 'example.scaena');
  const assets = path.join(source, `vha-${marker}`);
  for (const directory of ['thumbnails', 'filmstrips', 'clips']) {
    await fs.mkdir(path.join(assets, directory), { recursive: true });
  }
  const catalogue: FinalObject = {
    addTags: [], hubName: marker,
    images: [{ ...NewImageElement(), hash, fileName: `${marker}.mp4`, notes: `${marker} private note`, tags: [marker], lastPlayed: 1234, timesPlayed: 5 }],
    inputDirs: { 0: { path: `/unopened-source/${marker}`, watch: false } },
    numOfFolders: 1, removeTags: [], version: 3,
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 1, fixed: true, height: 144, n: 5 },
  };
  await fs.writeFile(cataloguePath, JSON.stringify(catalogue, null, 2));
  await fs.writeFile(cataloguePath + '.bak', JSON.stringify(catalogue));
  await fs.writeFile(path.join(assets, 'thumbnails', hash + '.jpg'), marker + ' thumbnail');
  await fs.writeFile(path.join(assets, 'filmstrips', hash + '.jpg'), marker + ' filmstrip');
  await fs.writeFile(path.join(assets, 'clips', hash + '.jpg'), marker + ' poster');
  const clip = Buffer.alloc(PRIVATE_HUB_MEDIA_CHUNK_BYTES + 33, 0x5a);
  clip.write(marker);
  await fs.writeFile(path.join(assets, 'clips', hash + '.mp4'), clip);
  // Unreferenced assets and prior backups are deliberately retained in source.
  await fs.writeFile(path.join(assets, 'thumbnails', 'orphan.jpg'), marker + ' orphan');
  const destination = path.join(root, 'private-copy');
  return { root, source, cataloguePath, assets, destination, catalogue, clip, options: {
    cataloguePath, destinationDirectory: destination, password, assertSourceQuiescent: () => undefined,
  } };
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const relative = path.relative(directory, file);
      const stat = await fs.lstat(file);
      if (entry.isDirectory()) { await visit(file); }
      else if (entry.isSymbolicLink()) { result[relative] = 'symlink:' + await fs.readlink(file); }
      else { result[relative] = `${stat.ino}:${stat.mtimeMs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`; }
    }
  }
  await visit(directory);
  return result;
}

async function assertEncrypted(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.name.includes(marker));
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await assertEncrypted(file); }
    else { assert.ok(!(await fs.readFile(file)).includes(Buffer.from(marker)), 'No plaintext canary in destination'); }
  }
}

test('conversion preserves every source byte and verifies catalogue plus four preview types after reopening', async t => {
  const f = await fixture(t);
  const original = await fingerprint(f.source);
  const events: unknown[] = [];
  const receipt = await convertCatalogueToPrivateHub({ ...f.options, onProgress: event => events.push(event) });
  assert.equal(receipt.previews.length, 4);
  assert.deepEqual(receipt.missingPreviews, []);
  assert.deepEqual(await fingerprint(f.source), original);
  await assertEncrypted(f.destination);
  assert.ok(!JSON.stringify(events).includes(marker));
  const store = await PrivateHubStore.open(f.destination, password);
  try {
    assert.deepEqual(await verifyPrivateHubConversion(store), receipt);
    assert.deepEqual(await readPrivateHubCatalogue(store), f.catalogue);
    assert.equal((await readPrivateHubPreview(store, 'thumbnail', hash)).toString(), marker + ' thumbnail');
    assert.deepEqual(await readPrivateHubPreview(store, 'clip', hash), f.clip);
    const reader = await openPrivateHubMedia(store, privateHubClipMediaId(hash));
    const pieces: Buffer[] = [];
    for await (const piece of reader.readRange(PRIVATE_HUB_MEDIA_CHUNK_BYTES - 11, PRIVATE_HUB_MEDIA_CHUNK_BYTES + 9)) { pieces.push(piece); }
    assert.deepEqual(Buffer.concat(pieces), f.clip.subarray(PRIVATE_HUB_MEDIA_CHUNK_BYTES - 11, PRIVATE_HUB_MEDIA_CHUNK_BYTES + 9));
  } finally { await store.lock(); }
});

test('missing expected previews require explicit consent and their state is recorded inside the vault', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.assets, 'filmstrips', hash + '.jpg'));
  await assert.rejects(convertCatalogueToPrivateHub(f.options), /Expected previews are missing/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  const original = await fingerprint(f.source);
  const receipt = await convertCatalogueToPrivateHub({ ...f.options, allowMissingPreviews: true });
  assert.deepEqual(receipt.missingPreviews, [{ kind: 'filmstrip', hash }]);
  const store = await PrivateHubStore.open(f.destination, password);
  try { assert.deepEqual(await verifyPrivateHubConversion(store), receipt); } finally { await store.lock(); }
  assert.deepEqual(await fingerprint(f.source), original);
});

test('disabled clips need no missing-preview override when no clips exist', async t => {
  const f = await fixture(t);
  f.catalogue.screenshotSettings.clipSnippets = 0;
  await fs.writeFile(f.cataloguePath, JSON.stringify(f.catalogue));
  await fs.unlink(path.join(f.assets, 'clips', hash + '.mp4'));
  await fs.unlink(path.join(f.assets, 'clips', hash + '.jpg'));
  const receipt = await convertCatalogueToPrivateHub(f.options);
  assert.equal(receipt.previews.length, 2);
  assert.deepEqual(receipt.missingPreviews, []);
});

test('existing or overlapping destinations and unsafe preview hashes are refused before source mutation', async t => {
  const f = await fixture(t);
  const original = await fingerprint(f.source);
  await fs.mkdir(f.destination);
  await fs.writeFile(path.join(f.destination, 'unrelated.txt'), 'preserve');
  await assert.rejects(convertCatalogueToPrivateHub(f.options), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(f.destination, 'unrelated.txt'), 'utf8'), 'preserve');
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, destinationDirectory: path.join(f.assets, 'private') }), /separate/);
  assert.deepEqual(await fingerprint(f.source), original);
  f.catalogue.images[0].hash = '../outside';
  await fs.writeFile(f.cataloguePath, JSON.stringify(f.catalogue));
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, destinationDirectory: path.join(f.root, 'other') }), /invalid preview identities/);
});

test('symbolic and hard-linked sources are rejected without reading their targets into a vault', async t => {
  const f = await fixture(t);
  const thumbnail = path.join(f.assets, 'thumbnails', hash + '.jpg');
  await fs.unlink(thumbnail);
  const unrelated = path.join(f.root, 'unrelated.jpg');
  await fs.writeFile(unrelated, 'unrelated source');
  await fs.symlink(unrelated, thumbnail);
  await assert.rejects(convertCatalogueToPrivateHub(f.options), /linked/);
  await fs.unlink(thumbnail);
  await fs.link(unrelated, thumbnail);
  await assert.rejects(convertCatalogueToPrivateHub(f.options), /linked/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'unrelated source');
});

test('source changes detected at final verification prevent a completion receipt', async t => {
  const f = await fixture(t);
  let changed = false;
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, onProgress: event => {
    if (!changed && event.stage === 'verifying' && event.completed === 0) {
      changed = true;
      syncFs.appendFileSync(f.cataloguePath, '\n');
    }
  } }), /changed|oversized/);
  const store = await PrivateHubStore.open(f.destination, password);
  try { await assert.rejects(readPrivateHubConversionReceipt(store), /does not exist/); } finally { await store.lock(); }
  await assertEncrypted(f.destination);
});

test('a revoked quiescence guard or cancellation leaves encrypted incomplete output and the original intact', async t => {
  const f = await fixture(t);
  const original = await fingerprint(f.source);
  let quiescent = true;
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options,
    assertSourceQuiescent: () => { if (!quiescent) { throw new Error('Writer resumed'); } },
    onProgress: event => { if (event.stage === 'copying' && event.completed === 1) { quiescent = false; } },
  }), /Writer resumed/);
  let store = await PrivateHubStore.open(f.destination, password);
  try { await assert.rejects(readPrivateHubConversionReceipt(store), /does not exist/); } finally { await store.lock(); }
  await assertEncrypted(f.destination);
  const cancellation = new AbortController();
  const cancelledDirectory = path.join(f.root, 'cancelled');
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, destinationDirectory: cancelledDirectory,
    signal: cancellation.signal, onProgress: event => { if (event.stage === 'copying') { cancellation.abort(); } },
  }), { name: 'AbortError' });
  store = await PrivateHubStore.open(cancelledDirectory, password);
  try { await assert.rejects(readPrivateHubConversionReceipt(store), /does not exist/); } finally { await store.lock(); }
  assert.deepEqual(await fingerprint(f.source), original);
  await assertEncrypted(cancelledDirectory);
});

test('asynchronous writer guards are refused rather than silently treating promises as successful', async t => {
  const f = await fixture(t);
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, assertSourceQuiescent: async () => undefined }), /must be synchronous/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('destination corruption during verification never produces a complete receipt', async t => {
  const f = await fixture(t);
  const original = await fingerprint(f.source);
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, onProgress: event => {
    if (event.stage === 'verifying' && event.completed === 0) {
      for (const file of syncFs.readdirSync(f.destination).filter(name => name.endsWith('.sealed'))) {
        const target = path.join(f.destination, file);
        const bytes = syncFs.readFileSync(target);
        bytes[bytes.length - 1] ^= 1;
        syncFs.writeFileSync(target, bytes);
      }
    }
  } }), /authenticate/);
  const store = await PrivateHubStore.open(f.destination, password);
  try { await assert.rejects(readPrivateHubConversionReceipt(store), /does not exist/); } finally { await store.lock(); }
  assert.deepEqual(await fingerprint(f.source), original);
});

test('completion publication uncertainty is resolved by reopening and authenticating the encrypted receipt', async t => {
  const f = await fixture(t);
  const original = await fingerprint(f.source);
  const write = PrivateHubStore.prototype.writeRecord;
  const mock = t.mock.method(PrivateHubStore.prototype, 'writeRecord', async function (this: PrivateHubStore, id: string, bytes: Buffer) {
    await write.call(this, id, bytes);
    if (id === 'conversion:receipt') { throw new Error('Synthetic failure after publication'); }
  });
  await assert.rejects(convertCatalogueToPrivateHub(f.options), /Synthetic failure after publication/);
  mock.mock.restore();
  const store = await PrivateHubStore.open(f.destination, password);
  try { assert.equal((await verifyPrivateHubConversion(store)).previews.length, 4); } finally { await store.lock(); }
  assert.deepEqual(await fingerprint(f.source), original);
});

test('reopened verification rejects incomplete inventories and malformed authenticated receipts', async t => {
  const f = await fixture(t);
  const receipt = await convertCatalogueToPrivateHub(f.options);
  const store = await PrivateHubStore.open(f.destination, password);
  try {
    await store.writeRecord('conversion:receipt', Buffer.from(JSON.stringify({ ...receipt, previews: [] })));
    await assert.rejects(verifyPrivateHubConversion(store), /omits an expected/);
    await store.writeRecord('conversion:receipt', Buffer.from(JSON.stringify({ ...receipt, version: 2 })));
    await assert.rejects(readPrivateHubConversionReceipt(store), /Invalid or incomplete/);
    await store.writeRecord('conversion:receipt', Buffer.from(JSON.stringify({ ...receipt, previews: [receipt.previews[0], receipt.previews[0]] })));
    await assert.rejects(readPrivateHubConversionReceipt(store), /Invalid conversion preview inventory/);
  } finally { await store.lock(); }
});

test('oversized images and pre-cancelled operations are refused before a destination is created', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, signal: controller.signal }), { name: 'AbortError' });
  await fs.truncate(path.join(f.assets, 'thumbnails', hash + '.jpg'), 32 * 1024 * 1024 + 1);
  await assert.rejects(convertCatalogueToPrivateHub(f.options), /oversized/);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});
