import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { privateVideoRevision } from './private-hub-metadata';
import { PrivateHubSession } from './private-hub-session';
import { PrivateHubStore } from './private-hub-store';
import { writePrivateHubCatalogue } from './private-hub-catalogue';
import { parseVhaJson } from './vha-file-persistence';
import type { PrivatePlaybackHistoryUpdate } from './private-playback-history';
import { capturePrivatePreviewSource } from './private-preview-source';
import { createPrivatePreviewSet } from './private-hub-preview-set';
import * as previewGeneration from './private-hub-preview-generation';

const marker = 'PRIVATE_PLAYBACK_HISTORY_SYNTHETIC_CANARY';
const password = 'Synthetic private playback history password';
const playedAt = 1_791_072_000_000;
const current = () => true;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext, enabled = true) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-history-'));
  const directory = path.join(root, 'sealed-hub');
  const sources = path.join(root, 'sources');
  await fs.mkdir(sources);
  const catalogue: FinalObject = { hubName: marker, version: 3, addTags: [], removeTags: [], numOfFolders: 1,
    images: ['First', 'Selected', 'Other'].map((title, index) => ({ ...NewImageElement(), cleanName: title,
      hash: index < 2 ? 'shared-hash' : 'other-hash', fileName: title + '.mp4', screens: 3,
      notes: marker + title, tags: [' Legacy tag '], timesPlayed: index + 2, lastPlayed: index + 100,
      extra: { future: [title, 7, 3] } })),
    inputDirs: { 0: { path: sources, watch: false, ignoredSubdirectories: ['B', 'A', 'A'] } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 } };
  Object.assign(catalogue, { extra: { future: true } });
  const initial = await PrivateHubStore.create(directory, password);
  await writePrivateHubCatalogue(initial, catalogue);
  if (enabled) { await initial.writeRecord('settings:protection', Buffer.from(JSON.stringify({ version: 2, autoLockMinutes: 5, recordPlaybackHistory: true }))); }
  const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: initial.hubId }));
  try { await initial.writeNewRecord('session:activation', activation); }
  finally { activation.fill(0); await initial.lock(); }
  let store!: PrivateHubStore;
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (target: string, secret: string) => { store = await open(target, secret); return store; });
  const session = new PrivateHubSession();
  const { generation } = await session.unlock(directory, password);
  t.after(async () => { await session.close(); await fs.rm(root, { recursive: true, force: true }); });
  const readStored = async (): Promise<FinalObject> => {
    const bytes = await store.readRecord('catalogue');
    try { return JSON.parse(bytes.toString('utf8')); }
    finally { bytes.fill(0); }
  };
  const update = (index = 1): PrivatePlaybackHistoryUpdate => ({ index, revision: privateVideoRevision(catalogue.images[index]), playedAt });
  const source = async () => {
    const image = catalogue.images[2];
    await fs.writeFile(path.join(sources, image.fileName), 'Synthetic source');
    const captured = await capturePrivatePreviewSource({ root: sources, hash: image.hash, fileName: image.fileName,
      partialPath: '', inputSource: 0, signal: session.revocationSignal(generation), isCurrent: () => session.isCurrent(generation) });
    t.after(() => captured.close());
    return captured;
  };
  return { root, directory, catalogue, store, session, generation, readStored, update, source };
}

function holdRead(t: TestContext, store: PrivateHubStore, record = 'catalogue') {
  const started = deferred(); const release = deferred();
  const read = store.readRecord.bind(store);
  let held = false;
  t.mock.method(store, 'readRecord', async (id: string, limit?: number) => {
    if (!held && id === record) { held = true; started.resolve(); await release.promise; }
    return read(id, limit);
  });
  t.after(() => release.resolve());
  return { started, release };
}

async function fingerprint(directory: string) {
  const result: Record<string, string> = {};
  for (const name of await fs.readdir(directory)) {
    result[name] = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
  }
  return result;
}

test('default-off history neither reads the catalogue nor writes any record', async t => {
  const f = await fixture(t, false);
  const before = await fingerprint(f.directory);
  const read = f.store.readRecord.bind(f.store);
  t.mock.method(f.store, 'readRecord', (id: string, maximum?: number) => {
    assert.notEqual(id, 'catalogue'); return read(id, maximum);
  });
  const write = t.mock.method(f.store, 'writeRecord', async () => { assert.fail('Disabled history must not write'); });
  assert.deepEqual(await f.session.recordVideoPlayback(f.generation, f.update(), current), { status: 'disabled' });
  assert.deepEqual(await fingerprint(f.directory), before);
  assert.equal(write.mock.callCount(), 0);
});

test('legacy and explicitly disabled policies preserve existing last-played data', async t => {
  const f = await fixture(t, false);
  for (const settings of [{ version: 1, autoLockMinutes: 5 }, { version: 2, autoLockMinutes: 5, recordPlaybackHistory: false }]) {
    await f.store.writeRecord('settings:protection', Buffer.from(JSON.stringify(settings)));
    const before = await fingerprint(f.directory);
    assert.deepEqual(await f.session.recordVideoPlayback(f.generation, f.update(), current), { status: 'disabled' });
    assert.deepEqual(await fingerprint(f.directory), before);
    assert.deepEqual(await f.readStored(), f.catalogue);
  }
});

test('enabled history changes only the exact indexed row metrics and persists exclusively encrypted', async t => {
  const f = await fixture(t);
  const result = await f.session.recordVideoPlayback(f.generation, f.update(), current);
  const expected = structuredClone(f.catalogue);
  expected.images[1].timesPlayed++; expected.images[1].lastPlayed = playedAt;
  assert.equal(result.status, 'recorded');
  assert.deepEqual(await f.readStored(), expected);
  if (result.status === 'recorded') { result.image.notes = 'Mutated result'; }
  assert.deepEqual(await f.readStored(), expected);
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(reopened.catalogue, parseVhaJson(JSON.stringify(expected)));
  assert.deepEqual(await f.readStored(), expected, 'reopening normalizes its view, not the encrypted original JSON');
  for (const name of await fs.readdir(f.directory)) {
    const bytes = await fs.readFile(path.join(f.directory, name));
    for (const secret of [marker, password, 'recordPlaybackHistory', String(playedAt), f.catalogue.inputDirs[0].path]) {
      assert.equal(bytes.includes(Buffer.from(secret)), false, name);
    }
  }
});

test('replaying a used full-row revision cannot increment twice', async t => {
  const f = await fixture(t);
  assert.equal((await f.session.recordVideoPlayback(f.generation, f.update(), current)).status, 'recorded');
  const before = await fingerprint(f.directory);
  assert.deepEqual(await f.session.recordVideoPlayback(f.generation, f.update(), current), { status: 'conflict' });
  assert.deepEqual(await fingerprint(f.directory), before);
  assert.equal((await f.readStored()).images[1].timesPlayed, 4);
});

test('selected-row changes and duplicate-hash reordering conflict while other row edits are retained', async t => {
  const f = await fixture(t);
  const latest = structuredClone(f.catalogue);
  latest.images[1].notes = 'Concurrent notes';
  await f.session.writeCatalogue(f.generation, latest);
  assert.deepEqual(await f.session.recordVideoPlayback(f.generation, f.update(), current), { status: 'conflict' });
  [latest.images[0], latest.images[1]] = [latest.images[1], latest.images[0]];
  await f.session.writeCatalogue(f.generation, latest);
  assert.deepEqual(await f.session.recordVideoPlayback(f.generation, f.update(), current), { status: 'conflict' });
  const otherChanged = structuredClone(f.catalogue);
  otherChanged.images[2].notes = 'Unrelated update';
  await f.session.writeCatalogue(f.generation, otherChanged);
  assert.equal((await f.session.recordVideoPlayback(f.generation, f.update(), current)).status, 'recorded');
  otherChanged.images[1].timesPlayed++; otherChanged.images[1].lastPlayed = playedAt;
  assert.deepEqual(await f.readStored(), otherChanged);
});

test('missing metrics are initialized but malformed, overflowing and non-video rows are untouched', async t => {
  const f = await fixture(t);
  for (const fields of [{ timesPlayed: null }, { timesPlayed: -1 }, { timesPlayed: 0.5 }, { timesPlayed: '3' },
    { timesPlayed: Number.MAX_SAFE_INTEGER }, { lastPlayed: null }, { lastPlayed: -1 }, { lastPlayed: 0.5 },
    { lastPlayed: '100' }, { lastPlayed: 8_640_000_000_000_001 }, { deleted: true }, { cleanName: '*FOLDER*' }]) {
    const catalogue = structuredClone(f.catalogue);
    Object.assign(catalogue.images[1], fields);
    await f.session.writeCatalogue(f.generation, catalogue);
    const request = { ...f.update(), revision: privateVideoRevision(catalogue.images[1]) };
    assert.deepEqual(await f.session.recordVideoPlayback(f.generation, request, current), { status: 'invalid' });
    assert.deepEqual(await f.readStored(), catalogue);
  }
  const legacy = structuredClone(f.catalogue);
  const selected = legacy.images[1] as unknown as Record<string, unknown>;
  delete selected.timesPlayed; delete selected.lastPlayed;
  await f.session.writeCatalogue(f.generation, legacy);
  assert.equal((await f.session.recordVideoPlayback(f.generation,
    { ...f.update(), revision: privateVideoRevision(legacy.images[1]) }, current)).status, 'recorded');
  assert.equal((await f.readStored()).images[1].timesPlayed, 1);
});

test('invalid history requests are rejected before policy or catalogue storage reads', async t => {
  const f = await fixture(t);
  const read = t.mock.method(f.store, 'readRecord', async () => { assert.fail('Invalid input must not read'); });
  for (const value of [null, {}, { ...f.update(), index: -1 }, { ...f.update(), playedAt: 0 },
    { ...f.update(), playedAt: 8_640_000_000_000_001 }, { ...f.update(), extra: true }]) {
    assert.deepEqual(await f.session.recordVideoPlayback(f.generation, value as PrivatePlaybackHistoryUpdate, current), { status: 'invalid' });
  }
  assert.equal(read.mock.callCount(), 0);
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('queued updates snapshot input and consume the most recent committed catalogue', async t => {
  const f = await fixture(t);
  const held = holdRead(t, f.store);
  const reading = f.session.readCatalogue(f.generation); await held.started.promise;
  const request = f.update();
  const history = f.session.recordVideoPlayback(f.generation, request, current);
  request.index = 0; request.revision = privateVideoRevision(f.catalogue.images[0]); request.playedAt++;
  held.release.resolve(); await reading;
  assert.equal((await history).status, 'recorded');
  const saved = await f.readStored();
  assert.deepEqual(saved.images[0], f.catalogue.images[0]);
  assert.equal(saved.images[1].lastPlayed, playedAt);
});

test('queue saturation is busy and simultaneous acknowledgements only record one matching revision', async t => {
  const f = await fixture(t);
  const held = holdRead(t, f.store);
  const reading = f.session.readCatalogue(f.generation); await held.started.promise;
  const work = Array.from({ length: 15 }, () => f.session.recordVideoPlayback(f.generation, f.update(), current));
  assert.deepEqual(await f.session.recordVideoPlayback(f.generation, f.update(), current), { status: 'busy' });
  held.release.resolve(); await reading;
  const results = await Promise.all(work);
  assert.equal(results[0].status, 'recorded');
  assert.ok(results.slice(1).every(result => result.status === 'conflict'));
  assert.equal((await f.readStored()).images[1].timesPlayed, 4);
});

test('a settings update queues behind admitted history, and disabling prevents later writes', async t => {
  const f = await fixture(t);
  const held = holdRead(t, f.store, 'settings:protection');
  const history = f.session.recordVideoPlayback(f.generation, f.update(), current); await held.started.promise;
  const disabling = f.session.updateProtection(f.generation, { autoLockMinutes: 5, recordPlaybackHistory: false }, current);
  held.release.resolve();
  assert.equal((await history).status, 'recorded'); await disabling;
  const latest = await f.readStored();
  const before = await fingerprint(f.directory);
  assert.deepEqual(await f.session.recordVideoPlayback(f.generation,
    { ...f.update(), revision: privateVideoRevision(latest.images[1]) }, current), { status: 'disabled' });
  assert.deepEqual(await fingerprint(f.directory), before);
});

for (const record of ['settings:protection', 'catalogue']) {
  test('revocation during ' + record + ' read prevents history publication and wipes plaintext', async t => {
    const f = await fixture(t);
    const read = f.store.readRecord.bind(f.store);
    let allowed = true;
    const retained: Buffer[] = [];
    t.mock.method(f.store, 'readRecord', async (id: string, maximum?: number) => {
      const bytes = await read(id, maximum); retained.push(bytes);
      if (id === record) { allowed = false; }
      return bytes;
    });
    const before = await fingerprint(f.directory);
    await assert.rejects(f.session.recordVideoPlayback(f.generation, f.update(), () => allowed));
    assert.deepEqual(await fingerprint(f.directory), before);
    assert.ok(retained.every(bytes => bytes.every(byte => byte === 0)));
    assert.equal(f.session.isCurrent(f.generation), true);
  });
}

test('revocation while queued is sticky and preserves the encrypted catalogue', async t => {
  const f = await fixture(t);
  const held = holdRead(t, f.store);
  const reading = f.session.readCatalogue(f.generation); await held.started.promise;
  let allowed = true;
  const history = f.session.recordVideoPlayback(f.generation, f.update(), () => allowed);
  const rejected = assert.rejects(history);
  allowed = false; held.release.resolve();
  await Promise.all([reading, rejected]);
  assert.deepEqual(await f.readStored(), f.catalogue);
  assert.equal(f.session.isCurrent(f.generation), true);
});

test('locking rejects queued history and drains before an unlocked generation can replace it', async t => {
  const f = await fixture(t);
  const held = holdRead(t, f.store);
  const reading = f.session.readCatalogue(f.generation); const rejectedRead = assert.rejects(reading);
  await held.started.promise;
  const history = f.session.recordVideoPlayback(f.generation, f.update(), current); const rejectedHistory = assert.rejects(history);
  const locking = f.session.lock(); held.release.resolve();
  await Promise.all([rejectedRead, rejectedHistory, locking]);
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(reopened.catalogue, parseVhaJson(JSON.stringify(f.catalogue)));
  assert.deepEqual(await f.readStored(), f.catalogue);
  await assert.rejects(f.session.recordVideoPlayback(f.generation, f.update(), current));
});

test('successful publication followed by lock is durable but never acknowledged to a stale caller', async t => {
  const f = await fixture(t);
  const committed = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const write = f.store.writeRecord.bind(f.store);
  const retained: Buffer[] = [];
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, authority?: () => boolean) => {
    assert.equal(typeof authority, 'function'); retained.push(bytes);
    await write(id, bytes, authority); committed.resolve(); await release.promise;
  });
  const history = f.session.recordVideoPlayback(f.generation, f.update(), current); const rejected = assert.rejects(history);
  await committed.promise;
  let drained = false;
  const locking = f.session.lock().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release.resolve(); await Promise.all([rejected, locking]);
  assert.ok(retained.every(bytes => bytes.every(byte => byte === 0)));
  const reopened = await f.session.unlock(f.directory, password);
  assert.equal(reopened.catalogue.images[1].timesPlayed, 4);
  assert.equal(reopened.catalogue.images[1].lastPlayed, playedAt);
});

test('revocation at write admission is guarded and locks an uncertain live handoff', async t => {
  const f = await fixture(t);
  const write = f.store.writeRecord.bind(f.store);
  let allowed = true;
  let retained!: Buffer;
  t.mock.method(f.store, 'writeRecord', (id: string, bytes: Buffer, authority?: () => boolean) => {
    assert.equal(authority!(), true); retained = bytes; allowed = false;
    return write(id, bytes, authority);
  });
  await assert.rejects(f.session.recordVideoPlayback(f.generation, f.update(), () => allowed));
  assert.equal(retained.every(byte => byte === 0), true);
  assert.equal(f.session.isCurrent(f.generation), false);
  await f.session.lock();
  const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(reopened.catalogue, parseVhaJson(JSON.stringify(f.catalogue)));
  assert.deepEqual(await f.readStored(), f.catalogue);
});

test('malformed encrypted policy fails closed instead of treating damage as history disabled', async t => {
  const f = await fixture(t);
  await f.store.writeRecord('settings:protection', Buffer.from('{"version":2,"autoLockMinutes":5,"recordPlaybackHistory":"true"}'));
  await assert.rejects(f.session.recordVideoPlayback(f.generation, f.update(), current));
  assert.equal(f.session.status.state, 'locked');
});

for (const operation of ['readRecord', 'writeRecord'] as const) {
  test('actual ' + operation + ' failures lock and expose no catalogue or source details', async t => {
    const f = await fixture(t);
    t.mock.method(f.store, operation, async () => { throw new Error(f.root + '/' + marker); });
    await assert.rejects(f.session.recordVideoPlayback(f.generation, f.update(), current), error => {
      assert.equal(String(error).includes(marker), false); assert.equal(String(error).includes(f.root), false); return true;
    });
    assert.equal(f.session.isCurrent(f.generation), false);
  });
}

test('an admitted history update blocks generation until its encrypted write settles', async t => {
  const f = await fixture(t); const source = await f.source();
  const held = holdRead(t, f.store);
  const history = f.session.recordVideoPlayback(f.generation, f.update(), current); await held.started.promise;
  await assert.rejects(f.session.generatePreviews(f.generation, source));
  held.release.resolve(); assert.equal((await history).status, 'recorded');
});

test('active generation reports busy without queuing history or locking the hub', async t => {
  const f = await fixture(t); const source = await f.source();
  const started = deferred(); const release = deferred(); t.after(() => release.resolve());
  t.mock.method(previewGeneration, 'generatePrivateHubPreviews', async () => {
    started.resolve(); await release.promise; return createPrivatePreviewSet('other-hash', 256, 144, 3, false);
  });
  const generating = f.session.generatePreviews(f.generation, source); await started.promise;
  assert.deepEqual(await f.session.recordVideoPlayback(f.generation, f.update(), current), { status: 'busy' });
  assert.equal(f.session.isCurrent(f.generation), true);
  release.resolve(); await generating;
  assert.equal((await f.session.recordVideoPlayback(f.generation, f.update(), current)).status, 'recorded');
});
