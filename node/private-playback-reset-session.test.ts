import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { privateVideoRevision } from './private-hub-metadata';
import { capturePrivatePreviewSource } from './private-preview-source';
import type { PrivatePlaybackHistoryMetric } from './private-playback-history';
import { parseVhaJson } from './vha-file-persistence';

const marker = 'PRIVATE_HISTORY_RESET_SYNTHETIC_CANARY';
const password = 'Synthetic private history reset password';
const current = () => true;
const accept = async () => true;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp/private-history-reset-stage/temp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'reset-'));
  const directory = path.join(root, 'encrypted');
  const sources = path.join(root, 'sources');
  await fs.mkdir(sources);
  await fs.writeFile(path.join(sources, 'video.mp4'), marker);
  const catalogue: FinalObject = { hubName: marker, version: 3, addTags: [], removeTags: [], numOfFolders: 1,
    images: ['First', 'Second', 'Third'].map((title, index) => ({ ...NewImageElement(), cleanName: title,
      hash: 'synthetic-' + index, fileName: 'video.mp4', screens: 3,
      notes: marker + title, tags: [' Legacy tag '], timesPlayed: index + 2, lastPlayed: index + 100,
      futureImage: { retained: [title, 7, 3] } })),
    inputDirs: { 0: { path: sources, watch: true, ignoredSubdirectories: ['B', 'A', 'A'] } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 } };
  Object.assign(catalogue, { futureCatalogue: { retained: true } });
  Object.assign(catalogue.inputDirs[0], { futureSource: { retained: true } });
  const initial = await PrivateHubStore.create(directory, password);
  await writePrivateHubCatalogue(initial, catalogue);
  await initial.writeRecord('settings:protection', Buffer.from(JSON.stringify({ version: 2, autoLockMinutes: 5, recordPlaybackHistory: true })));
  const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: initial.hubId }));
  try { await initial.writeNewRecord('session:activation', activation); }
  finally { activation.fill(0); await initial.lock(); }
  let store!: PrivateHubStore;
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (target: string, secret: string) => { store = await open(target, secret); return store; });
  const session = new PrivateHubSession();
  const { generation } = await session.unlock(directory, password);
  t.after(() => session.close());
  const readStored = async (): Promise<FinalObject> => {
    const bytes = await store.readRecord('catalogue');
    try { return JSON.parse(bytes.toString('utf8')); }
    finally { bytes.fill(0); }
  };
  const source = async () => {
    const captured = await capturePrivatePreviewSource({ root: sources, hash: 'synthetic-0', fileName: 'video.mp4',
      partialPath: '', inputSource: 0, signal: session.revocationSignal(generation), isCurrent: () => session.isCurrent(generation) });
    t.after(() => captured.close());
    return captured;
  };
  return { root, directory, sources, catalogue, store, session, generation, readStored, source };
}

async function fingerprint(directory: string) {
  const result: Record<string, string> = {};
  for (const name of await fs.readdir(directory)) {
    result[name] = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
  }
  return result;
}

for (const metric of ['lastPlayed', 'timesPlayed'] as const) {
  test('resetting ' + metric + ' changes only that field and survives encrypted reopening', async t => {
    const f = await fixture(t);
    const confirms: number[] = [];
    const reads: string[] = [];
    const writes: string[] = [];
    const read = f.store.readRecord.bind(f.store);
    const write = f.store.writeRecord.bind(f.store);
    t.mock.method(f.store, 'readRecord', (id: string, maximum?: number) => { reads.push(id); return read(id, maximum); });
    t.mock.method(f.store, 'writeRecord', (id: string, bytes: Buffer, guard?: () => boolean) => {
      writes.push(id); assert.equal(typeof guard, 'function'); return write(id, bytes, guard);
    });
    assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, metric, current,
      async count => { confirms.push(count); return true; }), { status: 'reset', count: 3 });
    assert.deepEqual(confirms, [3]); assert.deepEqual(reads, ['catalogue']); assert.deepEqual(writes, ['catalogue']);
    const expected = structuredClone(f.catalogue);
    for (const image of expected.images) { image[metric] = 0; }
    assert.deepEqual(await f.readStored(), expected);
    assert.equal(await fs.readFile(path.join(f.sources, 'video.mp4'), 'utf8'), marker);
    const backup = await f.store.readBackupRecord('catalogue');
    try { assert.deepEqual(JSON.parse(backup.toString('utf8')), f.catalogue, 'The previous encrypted catalogue remains a recovery backup'); }
    finally { backup.fill(0); }
    await f.session.lock();
    const reopened = await f.session.unlock(f.directory, password);
    assert.deepEqual(reopened.catalogue, parseVhaJson(JSON.stringify(expected)));
    assert.deepEqual(await f.readStored(), expected);
    assert.deepEqual(await f.session.readProtection(reopened.generation), { autoLockMinutes: 5, recordPlaybackHistory: true });
    for (const name of await fs.readdir(f.directory)) {
      const bytes = await fs.readFile(path.join(f.directory, name));
      for (const secret of [marker, password, f.sources, 'lastPlayed', 'timesPlayed']) {
        assert.equal(bytes.includes(Buffer.from(secret)), false, name);
      }
    }
  });
}

test('explicit reset counts malformed, deleted and folder metrics but preserves missing and zero fields', async t => {
  const f = await fixture(t);
  const catalogue = structuredClone(f.catalogue);
  catalogue.images = [{}, { lastPlayed: 0 }, { lastPlayed: '0' }, { lastPlayed: null },
    { lastPlayed: -1 }, { lastPlayed: 1.5 }, { lastPlayed: { future: true } }, { lastPlayed: 99, deleted: true },
    { lastPlayed: 88, cleanName: '*FOLDER*' }].map((fields, index) => {
    return { inputSource: 0, hash: 'same-synthetic-hash', cleanName: 'Row ' + index, timesPlayed: 'Preserved legacy count', ...fields };
  }) as unknown as FinalObject['images'];
  const raw = Buffer.from(JSON.stringify(catalogue));
  await f.store.writeRecord('catalogue', raw); raw.fill(0);
  assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, async count => {
    assert.equal(count, 7); return true;
  }), { status: 'reset', count: 7 });
  const expected = structuredClone(catalogue);
  for (const image of expected.images) {
    if (image && typeof image === 'object' && Object.hasOwn(image, 'lastPlayed')) { image.lastPlayed = 0; }
  }
  assert.deepEqual(await f.readStored(), expected);
  assert.equal(Object.hasOwn((await f.readStored()).images[0], 'lastPlayed'), false);
});

test('an unchanged catalogue does not prompt or write and a cancelled reset leaves every encrypted byte intact', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.directory);
  assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, async count => {
    assert.equal(count, 3); return false;
  }), { status: 'cancelled' });
  assert.deepEqual(await fingerprint(f.directory), before);
  const catalogue = structuredClone(f.catalogue);
  catalogue.images[0].lastPlayed = 0;
  for (const image of catalogue.images.slice(1)) { delete (image as unknown as Record<string, unknown>).lastPlayed; }
  await f.session.writeCatalogue(f.generation, catalogue);
  const unchanged = await fingerprint(f.directory);
  assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current,
    async () => { assert.fail('No confirmation without changes'); }), { status: 'unchanged' });
  assert.deepEqual(await fingerprint(f.directory), unchanged);
  assert.deepEqual(await f.readStored(), catalogue);
});

test('only exact supported metrics and confirmation functions enter storage or authority callbacks', async t => {
  const f = await fixture(t);
  const read = t.mock.method(f.store, 'readRecord', async () => { assert.fail('Invalid reset must not read'); });
  for (const metric of ['history', '', null, {}, ['lastPlayed'], new String('lastPlayed')]) {
    assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, metric as PrivatePlaybackHistoryMetric,
      () => { assert.fail('Invalid reset must not consult authority'); }, accept), { status: 'invalid' });
  }
  assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current,
    null as unknown as typeof accept), { status: 'invalid' });
  assert.equal(read.mock.callCount(), 0);
});

test('confirmation exceptions and nonboolean responses cannot authorize a write or leak details', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.directory);
  await assert.rejects(f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current,
    async () => { throw new Error(f.root + '/' + marker); }), error => {
    assert.equal(String(error).includes(marker), false); assert.equal(String(error).includes(f.root), false); return true;
  });
  assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current,
    async () => 'yes' as unknown as boolean), { status: 'cancelled' });
  assert.deepEqual(await fingerprint(f.directory), before);
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('confirmation owns the queue, observes earlier writes, and allows later writes only after reset', async t => {
  const f = await fixture(t);
  const catalogue = structuredClone(f.catalogue);
  catalogue.images[0].lastPlayed = 0; catalogue.images[1].notes = 'New queued notes';
  const writing = f.session.writeCatalogue(f.generation, catalogue);
  const started = deferred(); const release = deferred(); t.after(() => release.resolve());
  const resetting = f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, async count => {
    assert.equal(count, 2); started.resolve(); await release.promise; return true;
  });
  await started.promise; await writing;
  let readFinished = false;
  const reading = f.session.readCatalogue(f.generation).then(value => { readFinished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(readFinished, false);
  release.resolve(); assert.deepEqual(await resetting, { status: 'reset', count: 2 });
  const result = await reading;
  assert.ok(result.images.every(image => image.lastPlayed === 0));
  assert.equal(result.images[1].notes, 'New queued notes');
  const recorded = await f.session.recordVideoPlayback(f.generation,
    { index: 0, revision: privateVideoRevision(result.images[0]), playedAt: 1234 }, current);
  assert.equal(recorded.status, 'recorded');
  assert.equal((await f.readStored()).images[0].lastPlayed, 1234);
});

test('a second queued reset sees the first committed result and never shows a stale confirmation', async t => {
  const f = await fixture(t);
  const started = deferred(); const release = deferred(); t.after(() => release.resolve());
  const first = f.session.resetPlaybackHistory(f.generation, 'timesPlayed', current, async () => {
    started.resolve(); await release.promise; return true;
  });
  await started.promise;
  const second = f.session.resetPlaybackHistory(f.generation, 'timesPlayed', current,
    async () => { assert.fail('First reset removed the need for another prompt'); });
  release.resolve(); assert.deepEqual(await first, { status: 'reset', count: 3 });
  assert.deepEqual(await second, { status: 'unchanged' });
});

test('queue saturation returns busy and releases every reservation after cancelled work', async t => {
  const f = await fixture(t);
  const started = deferred(); const release = deferred(); t.after(() => release.resolve());
  const first = f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, async () => {
    started.resolve(); await release.promise; return false;
  });
  await started.promise;
  const queued = Array.from({ length: 15 }, () => f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, async () => false));
  assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, accept), { status: 'busy' });
  release.resolve(); assert.deepEqual(await first, { status: 'cancelled' });
  assert.ok((await Promise.all(queued)).every(result => result.status === 'cancelled'));
  assert.equal(await f.session.changePassword(f.generation,
    { currentPassword: 'Wrong synthetic password', newPassword: password + ' new' }, current), 'incorrect-password');
});

test('write admission precedes callbacks and excludes generation, password changes and unprotected copies', async t => {
  const f = await fixture(t); const source = await f.source();
  let generationAttempt: Promise<unknown> | undefined;
  const result = await f.session.resetPlaybackHistory(f.generation, 'lastPlayed', () => {
    generationAttempt ??= assert.rejects(f.session.generatePreviews(f.generation, source)); return true;
  }, async () => {
    await generationAttempt;
    await assert.rejects(f.session.changePassword(f.generation,
      { currentPassword: password, newPassword: password + ' new' }, current));
    await assert.rejects(f.session.createUnprotectedCopy(f.generation, { password, acknowledge: true }, current,
      { signal: new AbortController().signal, chooseDestination: async () => { assert.fail('Reset must exclude export'); } }));
    return false;
  });
  assert.deepEqual(result, { status: 'cancelled' });
});

test('Lock during native confirmation revokes the reset and waits for its callback before reopening', async t => {
  const f = await fixture(t);
  const started = deferred(); const release = deferred(); t.after(() => release.resolve());
  const before = await fingerprint(f.directory);
  const resetting = f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, async () => {
    started.resolve(); await release.promise; return true;
  });
  const rejected = assert.rejects(resetting);
  await started.promise;
  let drained = false;
  const locking = f.session.lock().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  await assert.rejects(f.session.unlock(f.directory, password));
  release.resolve(); await Promise.all([rejected, locking]);
  assert.deepEqual(await fingerprint(f.directory), before);
  await f.session.unlock(f.directory, password);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('revocation during read or confirmation prevents publication and wipes borrowed plaintext', async t => {
  const f = await fixture(t);
  const read = f.store.readRecord.bind(f.store);
  let permitted = true;
  const borrowed: Buffer[] = [];
  t.mock.method(f.store, 'readRecord', async (id: string, maximum?: number) => {
    const bytes = await read(id, maximum); borrowed.push(bytes); permitted = false; return bytes;
  });
  const before = await fingerprint(f.directory);
  await assert.rejects(f.session.resetPlaybackHistory(f.generation, 'lastPlayed', () => permitted,
    async () => { assert.fail('Revoked read must not prompt'); }));
  assert.ok(borrowed.every(bytes => bytes.every(byte => byte === 0)));
  t.mock.restoreAll(); permitted = true;
  await assert.rejects(f.session.resetPlaybackHistory(f.generation, 'lastPlayed', () => permitted,
    async () => { permitted = false; return true; }));
  assert.deepEqual(await fingerprint(f.directory), before);
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('failed catalogue reads or malformed raw JSON lock without exposing private details', async t => {
  const f = await fixture(t);
  t.mock.method(f.store, 'readRecord', async () => { throw new Error(f.root + '/' + marker); });
  await assert.rejects(f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, accept), error => {
    assert.equal(String(error).includes(marker), false); assert.equal(String(error).includes(f.root), false); return true;
  });
  assert.equal(f.session.isCurrent(f.generation), false);
  await f.session.lock(); t.mock.restoreAll();
  const reopen = await f.session.unlock(f.directory, password);
  t.mock.method(PrivateHubStore.prototype, 'readRecord', async () => Buffer.from('{"images":"invalid"}'));
  await assert.rejects(f.session.resetPlaybackHistory(reopen.generation, 'lastPlayed', current, accept));
  assert.equal(f.session.isCurrent(reopen.generation), false);
});

for (const committed of [false, true]) {
  test((committed ? 'postpublication' : 'prepublication') + ' write failure locks, wipes the output and preserves the authoritative encrypted result', async t => {
    const f = await fixture(t);
    const write = f.store.writeRecord.bind(f.store);
    let borrowed!: Buffer;
    t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, guard?: () => boolean) => {
      borrowed = bytes; assert.equal(guard!(), true);
      if (committed) { await write(id, bytes, guard); }
      throw new Error(f.root + '/' + marker);
    });
    await assert.rejects(f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current, accept), error => {
      assert.equal(String(error).includes(marker), false); assert.equal(String(error).includes(f.root), false); return true;
    });
    assert.ok(borrowed.length > 0 && borrowed.every(byte => byte === 0));
    assert.equal(f.session.isCurrent(f.generation), false);
    await f.session.lock(); await f.session.unlock(f.directory, password);
    const expected = structuredClone(f.catalogue);
    if (committed) { for (const image of expected.images) { image.lastPlayed = 0; } }
    assert.deepEqual(await f.readStored(), expected);
  });
}

test('authority is rechecked at publication and an uncertain retired handoff locks', async t => {
  const f = await fixture(t);
  const write = f.store.writeRecord.bind(f.store);
  let permitted = true;
  t.mock.method(f.store, 'writeRecord', (id: string, bytes: Buffer, guard?: () => boolean) => {
    assert.equal(guard!(), true); permitted = false; return write(id, bytes, guard);
  });
  await assert.rejects(f.session.resetPlaybackHistory(f.generation, 'lastPlayed', () => permitted, accept));
  assert.equal(f.session.isCurrent(f.generation), false);
  await f.session.lock(); await f.session.unlock(f.directory, password);
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('a successful write followed by Lock stays durable but is never acknowledged to the retired caller', async t => {
  const f = await fixture(t);
  const committed = deferred(); const release = deferred(); t.after(() => release.resolve());
  const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, guard?: () => boolean) => {
    await write(id, bytes, guard); committed.resolve(); await release.promise;
  });
  const resetting = f.session.resetPlaybackHistory(f.generation, 'timesPlayed', current, accept);
  const rejected = assert.rejects(resetting); await committed.promise;
  const locking = f.session.lock(); release.resolve(); await Promise.all([rejected, locking]);
  await f.session.unlock(f.directory, password);
  assert.ok((await f.readStored()).images.every(image => image.timesPlayed === 0));
});

test('more than 100000 changed entries are refused before confirmation or encrypted writes', async t => {
  const f = await fixture(t);
  const catalogue = structuredClone(f.catalogue);
  catalogue.images = Array.from({ length: 100_001 }, () => ({ inputSource: 0, hash: 'same-hash', cleanName: '*FOLDER*', lastPlayed: 1 })) as FinalObject['images'];
  const read = f.store.readRecord.bind(f.store);
  t.mock.method(f.store, 'readRecord', (id: string, maximum?: number) => id === 'catalogue'
    ? Promise.resolve(Buffer.from(JSON.stringify(catalogue))) : read(id, maximum));
  const before = await fingerprint(f.directory);
  assert.deepEqual(await f.session.resetPlaybackHistory(f.generation, 'lastPlayed', current,
    async () => { assert.fail('An oversized reset must not prompt'); }), { status: 'invalid' });
  assert.deepEqual(await fingerprint(f.directory), before);
});
