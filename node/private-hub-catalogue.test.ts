import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';

import { NewImageElement } from '../interfaces/final-object.interface';
import type { FinalObject } from '../interfaces/final-object.interface';
import {
  readPrivateHubCatalogue,
  readPrivateHubPreview,
  writePrivateHubCatalogue,
  writePrivateHubPreview,
  PRIVATE_HUB_MAX_IMAGE_BYTES,
} from './private-hub-catalogue';
import type { PrivateHubPreviewKind } from './private-hub-catalogue';
import { PrivateHubStore } from './private-hub-store';

const marker = 'PRIVATE-HUB-INTEGRATION-CANARY';
const password = 'Private hub test passphrase 2026!';

function catalogue(): FinalObject {
  return {
    addTags: [],
    hubName: `${marker}-hub`,
    images: [{
      ...NewImageElement(),
      fileName: `${marker}.mp4`,
      hash: 'example-video-1',
      lastPlayed: 123456,
      notes: `${marker} notes`,
      tags: [`${marker} tag`],
      timesPlayed: 3,
    }],
    inputDirs: { 0: { path: `/private-source/${marker}`, watch: false } },
    numOfFolders: 1,
    removeTags: [],
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 3, fixed: true, height: 144, n: 10 },
    version: 3,
  };
}

async function withHub(run: (store: PrivateHubStore, directory: string) => Promise<void>): Promise<void> {
  const temporaryRoot = path.join(__dirname, '..', 'tmp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const parent = await fs.mkdtemp(path.join(temporaryRoot, 'private-hub-catalogue-'));
  const directory = path.join(parent, 'hub');
  let store: PrivateHubStore | undefined;
  try {
    store = await PrivateHubStore.create(directory, password);
    await run(store, directory);
  } finally {
    await store?.lock();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function assertNoPlaintext(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.name.includes(marker), 'Sensitive names must not appear in storage paths.');
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoPlaintext(file);
    } else {
      assert.ok(!(await fs.readFile(file)).includes(Buffer.from(marker)), 'Sensitive bytes must not appear in stored files.');
    }
  }
}

test('catalogue metadata and every preview kind survive encrypted save, backup, lock and reopen', async () => {
  await withHub(async (store, directory) => {
    const original = catalogue();
    await writePrivateHubCatalogue(store, original);
    const updated = catalogue();
    updated.images[0].notes += ' updated';
    await writePrivateHubCatalogue(store, updated);
    const kinds: PrivateHubPreviewKind[] = ['thumbnail', 'filmstrip', 'clip-poster', 'clip'];
    for (const kind of kinds) {
      await writePrivateHubPreview(store, kind, 'example-video-1', Buffer.from(`${marker} ${kind}`));
    }
    await assertNoPlaintext(directory);
    await store.lock();
    const reopened = await PrivateHubStore.open(directory, password);
    try {
      assert.deepEqual(await readPrivateHubCatalogue(reopened), updated);
      assert.deepEqual(JSON.parse((await reopened.readBackupRecord('catalogue')).toString()), original);
      for (const kind of kinds) {
        assert.equal((await readPrivateHubPreview(reopened, kind, 'example-video-1')).toString(), `${marker} ${kind}`);
      }
    } finally {
      await reopened.lock();
    }
  });
});

test('invalid catalogue writes leave the previous authenticated catalogue intact', async () => {
  await withHub(async (store, directory) => {
    const valid = catalogue();
    await writePrivateHubCatalogue(store, valid);
    await assert.rejects(writePrivateHubCatalogue(store, { ...valid, hubName: '../escape' }));
    assert.deepEqual(await readPrivateHubCatalogue(store), valid);
    await store.writeRecord('catalogue', Buffer.from('invalid JSON'));
    await assert.rejects(readPrivateHubCatalogue(store));
    await assertNoPlaintext(directory);
  });
});

test('preview identities reject traversal and unsupported types before storage', async () => {
  await withHub(async (store) => {
    for (const hash of ['../outside', '/absolute', 'nested/path', 'nested\\path', '', 'a'.repeat(201)]) {
      assert.throws(() => writePrivateHubPreview(store, 'thumbnail', hash, Buffer.from(marker)));
      assert.throws(() => readPrivateHubPreview(store, 'thumbnail', hash));
    }
    assert.throws(() => readPrivateHubPreview(store, 'unexpected' as PrivateHubPreviewKind, 'safe'));
  });
});

test('a locked store refuses catalogue and preview access', async () => {
  await withHub(async (store) => {
    await writePrivateHubCatalogue(store, catalogue());
    await writePrivateHubPreview(store, 'thumbnail', 'example-video-1', Buffer.from(marker));
    await store.lock();
    await assert.rejects(async () => readPrivateHubCatalogue(store));
    await assert.rejects(async () => readPrivateHubPreview(store, 'thumbnail', 'example-video-1'));
    await assert.rejects(async () => writePrivateHubCatalogue(store, catalogue()));
    await assert.rejects(async () => writePrivateHubPreview(store, 'thumbnail', 'example-video-1', Buffer.from(marker)));
  });
});

test('image writes enforce the same size boundary as default preview reads', async () => {
  await withHub(async (store) => {
    const oversized = Buffer.allocUnsafe(PRIVATE_HUB_MAX_IMAGE_BYTES + 1);
    for (const kind of ['thumbnail', 'filmstrip', 'clip-poster'] as const) {
      await assert.rejects(writePrivateHubPreview(store, kind, 'example-video-1', oversized), /oversized private hub image/);
      await assert.rejects(readPrivateHubPreview(store, kind, 'example-video-1'), /does not exist/);
    }
  });
});
