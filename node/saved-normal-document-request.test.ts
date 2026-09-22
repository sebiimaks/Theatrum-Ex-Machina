import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { FinalObject } from '../interfaces/final-object.interface';
import type { SavedNormalDocumentRelease } from '../interfaces/saved-normal-document';
import { SavedNormalDocumentRequest } from './saved-normal-document-request';
import type { SavedNormalDocumentOwner, SavedNormalDocumentRequestOptions } from './saved-normal-document-request';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

function harness(overrides: Partial<SavedNormalDocumentRequestOptions> = {}) {
  const events: string[] = [];
  const writes: (FinalObject | null)[] = [];
  const releases: SavedNormalDocumentRelease[] = [];
  const write = deferred<void>();
  let current = true;
  let frameCurrent = true;
  let requestId = '';
  const owner: SavedNormalDocumentOwner = {
    contents: {}, frame: {}, isCurrent: () => current, isFrameCurrent: () => frameCurrent,
  };
  const request = new SavedNormalDocumentRequest({
    acquireMutationHold: () => { events.push('hold'); return () => { events.push('unhold'); }; },
    captureOwner: () => owner,
    saveSnapshot: async (_owner, document) => { writes.push(document); events.push('write'); await write.promise; events.push('written'); },
    sendRequest: (_owner, id) => { requestId = id; events.push('request'); },
    sendRelease: (_owner, _id, result) => { releases.push(result); events.push('release'); },
    ...overrides,
  });
  const event = { sender: owner.contents, senderFrame: owner.frame };
  return {
    events, writes, releases, write, owner, request, event,
    id: () => requestId,
    snapshot: (document: FinalObject | null = null) => request.acceptSnapshot(event, requestId, { status: 'snapshot', document }),
    setCurrent: (value: boolean) => { current = value; },
    setFrameCurrent: (value: boolean) => { frameCurrent = value; },
  };
}

test('retains the hold through actual save and rejects forged or consumed proof', async () => {
  const h = harness();
  const pending = h.request.request();
  assert.deepEqual(h.events, ['hold', 'request']);
  assert.throws(() => h.request.assertSaved({ saved: true }));
  assert.equal(h.snapshot(), true);
  await flush();
  assert.equal(h.request.status.state, 'saving');
  assert.deepEqual(h.events, ['hold', 'request', 'write']);
  h.write.resolve();
  const proof = await pending;
  h.request.assertSaved(proof);
  assert.deepEqual(h.events, ['hold', 'request', 'write', 'written']);
  await h.request.release(proof);
  assert.deepEqual(h.releases, [{ saved: true }]);
  assert.deepEqual(h.events.slice(-2), ['release', 'unhold']);
  assert.throws(() => h.request.assertSaved(proof));
  assert.equal(h.request.status.state, 'idle');
});

test('requires the exact sender, original frame, nonce and one response', async () => {
  const h = harness();
  const pending = h.request.request();
  const response = { status: 'snapshot', document: null };
  assert.equal(h.request.acceptSnapshot({ ...h.event, sender: {} }, h.id(), response), false);
  assert.equal(h.request.acceptSnapshot({ ...h.event, senderFrame: {} }, h.id(), response), false);
  assert.equal(h.request.acceptSnapshot(h.event, 'stale', response), false);
  assert.equal(h.request.acceptSnapshot(h.event, h.id(), { status: 'saved' }), false);
  assert.equal(h.request.acceptSnapshot(h.event, h.id(), { status: 'snapshot' }), false);
  assert.equal(h.snapshot(), true);
  assert.equal(h.snapshot(), false);
  h.write.resolve();
  await h.request.release(await pending);
  assert.equal(h.writes.length, 1);
});

test('copies the accepted snapshot rather than retaining a mutable transport reference', async () => {
  const h = harness();
  const pending = h.request.request();
  const document = { images: [{ notes: 'Original' }] } as unknown as FinalObject;
  assert.equal(h.snapshot(document), true);
  document.images[0].notes = 'Changed after reply';
  await flush();
  assert.equal(h.writes[0]?.images[0].notes, 'Original');
  h.write.resolve();
  await h.request.release(await pending);
});

test('a session change before reply cannot authorize any save', async () => {
  const h = harness();
  const pending = h.request.request();
  const rejected = assert.rejects(pending, /could not be prepared/);
  h.setCurrent(false);
  assert.equal(h.snapshot(), false);
  await h.request.cancel();
  await rejected;
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.releases, [{ saved: false }]);
});

test('a navigation during save invalidates proof and never releases a replacement frame', async () => {
  const h = harness();
  const pending = h.request.request();
  const rejected = assert.rejects(pending, /could not be prepared/);
  h.snapshot();
  await flush();
  h.setFrameCurrent(false);
  h.write.resolve();
  await rejected;
  assert.deepEqual(h.releases, []);
  assert.equal(h.events.at(-1), 'unhold');
});

test('a session change after write cannot clear a replacement document dirty state', async () => {
  const h = harness();
  const pending = h.request.request();
  const rejected = assert.rejects(pending, /could not be prepared/);
  h.snapshot();
  await flush();
  h.setCurrent(false);
  h.write.resolve();
  await rejected;
  assert.deepEqual(h.releases, [{ saved: false }]);
});

test('cancellation waits for an in-flight successful write before restoring edits', async () => {
  const h = harness();
  const controller = new AbortController();
  const pending = h.request.request(controller.signal);
  const rejected = assert.rejects(pending, /could not be prepared/);
  h.snapshot();
  await flush();
  controller.abort();
  let cancelled = false;
  const cancelling = h.request.cancel().then(() => { cancelled = true; });
  await flush();
  assert.equal(cancelled, false);
  assert.deepEqual(h.releases, []);
  h.write.resolve();
  await Promise.all([rejected, cancelling]);
  assert.deepEqual(h.releases, [{ saved: true }]);
  assert.deepEqual(h.events.slice(-3), ['written', 'release', 'unhold']);
});

test('a failed write restores editing while preserving unsaved data', async () => {
  const h = harness();
  const pending = h.request.request();
  const rejected = assert.rejects(pending, /could not be prepared/);
  h.snapshot();
  await flush();
  h.write.reject(new Error('Synthetic private path must not be echoed'));
  await rejected;
  assert.deepEqual(h.releases, [{ saved: false }]);
  assert.equal(h.request.status.state, 'idle');
});

test('renderer cancellation restores editing without writing', async () => {
  const h = harness();
  const pending = h.request.request();
  const rejected = assert.rejects(pending, /could not be prepared/);
  assert.equal(h.request.acceptSnapshot(h.event, h.id(), { status: 'cancelled' }), true);
  await rejected;
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.releases, [{ saved: false }]);
});

test('timeout restores a renderer that never supplied its frozen snapshot', async () => {
  const h = harness({ timeoutMs: 5 });
  await assert.rejects(h.request.request(), /could not be prepared/);
  assert.deepEqual(h.releases, [{ saved: false }]);
  assert.equal(h.request.status.state, 'idle');
});

test('already aborted request performs no privileged work', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.request.request(controller.signal), /cancelled/);
  assert.deepEqual(h.events, []);
});

test('post-proof abort cannot thaw normal editing while the private workspace may still exist', async () => {
  const h = harness();
  const controller = new AbortController();
  const pending = h.request.request(controller.signal);
  h.snapshot();
  h.write.resolve();
  const proof = await pending;
  controller.abort();
  await flush();
  h.request.assertSaved(proof);
  assert.deepEqual(h.releases, []);
  await h.request.release(proof);
});

test('concurrent and reentrant requests cannot share proof authority', async () => {
  let concurrent: Promise<unknown> | undefined;
  const h = harness({ acquireMutationHold: () => { concurrent = h.request.request(); return () => undefined; } });
  const pending = h.request.request();
  await assert.rejects(concurrent!, /already being prepared/);
  h.snapshot();
  h.write.resolve();
  await h.request.release(await pending);
});

test('request send failure rolls back its hold and emits only generic diagnostics', async () => {
  const h = harness({ sendRequest: () => { throw new Error('/synthetic/catalogue.scaena'); } });
  await assert.rejects(h.request.request(), { message: 'The normal document could not be prepared.' });
  assert.equal(h.events.at(-1), 'unhold');
});

test('failed renderer restoration retains the hold and blocks new requests', async () => {
  let unheld = false;
  const h = harness({
    acquireMutationHold: () => () => { unheld = true; },
    sendRelease: () => { throw new Error('Synthetic failed restoration'); },
  });
  const pending = h.request.request();
  h.snapshot();
  h.write.resolve();
  const proof = await pending;
  await assert.rejects(h.request.release(proof), /could not be restored/);
  assert.equal(unheld, false);
  assert.equal(h.request.status.state, 'failed');
  await assert.rejects(h.request.request(), /already being prepared/);
});

test('replayed snapshots from a retired request cannot enter the next request', async () => {
  const h = harness();
  const first = h.request.request();
  const oldId = h.id();
  h.snapshot(); h.write.resolve();
  await h.request.release(await first);
  const second = h.request.request();
  assert.notEqual(h.id(), oldId);
  assert.equal(h.request.acceptSnapshot(h.event, oldId, { status: 'snapshot', document: null }), false);
  h.snapshot();
  await h.request.release(await second);
});
