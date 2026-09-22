import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { FinalObject } from '../interfaces/final-object.interface';
import type { SavedNormalDocumentSnapshot } from '../interfaces/saved-normal-document';
import { SavedNormalDocumentCoordinator } from '../src/app/common/saved-normal-document-coordinator';
import type { SavedNormalDocumentRendererHooks } from '../src/app/common/saved-normal-document-coordinator';

function harness(overrides: Partial<SavedNormalDocumentRendererHooks> = {}) {
  const events: string[] = [];
  const replies: SavedNormalDocumentSnapshot[] = [];
  let editing = true;
  let session: unknown = {};
  let revision = 0;
  let dirty = true;
  const coordinator = new SavedNormalDocumentCoordinator({
    freeze: () => { events.push('freeze'); editing = false; return () => { events.push('thaw'); editing = true; }; },
    sessionIdentity: () => session,
    revisionIdentity: () => revision,
    snapshot: () => { assert.equal(editing, false); events.push('snapshot'); return {} as FinalObject; },
    markSaved: () => { assert.equal(editing, false); events.push('saved'); dirty = false; },
    ...overrides,
  }, { sendSnapshot: (_id, snapshot) => { replies.push(snapshot); events.push('reply'); } });
  return {
    events, replies, coordinator, editing: () => editing, dirty: () => dirty,
    changeSession: () => { session = {}; },
    changeRevision: () => { revision += 1; },
  };
}

test('freezes before reading the snapshot and retains unsaved edits until matching saved release', () => {
  const h = harness();
  const id = randomUUID();
  assert.equal(h.coordinator.prepare(id), true);
  assert.deepEqual(h.events, ['freeze', 'snapshot', 'reply']);
  assert.equal(h.editing(), false);
  assert.equal(h.dirty(), true);
  assert.equal(h.coordinator.release(id, { saved: true }), true);
  assert.deepEqual(h.events.slice(-2), ['saved', 'thaw']);
  assert.equal(h.editing(), true);
  assert.equal(h.dirty(), false);
});

test('rejects uncorrelated releases, duplicate requests and replayed retired requests', () => {
  const h = harness();
  const id = randomUUID();
  assert.equal(h.coordinator.prepare(id), true);
  assert.equal(h.coordinator.prepare(id), false);
  assert.equal(h.coordinator.prepare(randomUUID()), false);
  assert.equal(h.coordinator.release(randomUUID(), { saved: true }), false);
  assert.equal(h.editing(), false);
  assert.equal(h.coordinator.release(id, { saved: false }), true);
  assert.equal(h.coordinator.prepare(id), false);
  assert.equal(h.coordinator.release(id, { saved: true }), false);
});

test('failed or cancelled save restores editing without clearing dirty flags', () => {
  const h = harness();
  const id = randomUUID();
  h.coordinator.prepare(id);
  h.coordinator.release(id, { saved: false });
  assert.equal(h.dirty(), true);
  assert.equal(h.editing(), true);
});

test('session replacement cannot be marked clean by a delayed save release', () => {
  const h = harness();
  const id = randomUUID();
  h.coordinator.prepare(id);
  h.changeSession();
  h.coordinator.release(id, { saved: true });
  assert.equal(h.dirty(), true);
  assert.equal(h.editing(), true);
});

test('a late renderer mutation is never marked clean by the saved snapshot release', () => {
  const h = harness();
  const id = randomUUID();
  h.coordinator.prepare(id);
  h.changeRevision();
  h.coordinator.release(id, { saved: true });
  assert.equal(h.dirty(), true);
  assert.equal(h.editing(), true);
  assert.equal(h.events.includes('saved'), false);
});

test('a mutation during snapshot collection cancels that incoherent snapshot', () => {
  const h = harness({ snapshot: () => { h.changeRevision(); return {} as FinalObject; } });
  const id = randomUUID();
  assert.equal(h.coordinator.prepare(id), false);
  assert.deepEqual(h.replies, [{ status: 'cancelled' }]);
  h.coordinator.release(id, { saved: false });
  assert.equal(h.dirty(), true);
});

test('snapshot failure reports cancellation but keeps editing frozen until main drains', () => {
  const h = harness({ snapshot: () => { throw new Error('Unfinished editor'); } });
  const id = randomUUID();
  assert.equal(h.coordinator.prepare(id), false);
  assert.deepEqual(h.replies, [{ status: 'cancelled' }]);
  assert.equal(h.editing(), false);
  h.coordinator.release(id, { saved: false });
  assert.equal(h.editing(), true);
  assert.equal(h.dirty(), true);
});

test('session replacement while collecting a snapshot reports cancellation', () => {
  const h = harness({ snapshot: () => { h.changeSession(); return {} as FinalObject; } });
  const id = randomUUID();
  assert.equal(h.coordinator.prepare(id), false);
  assert.deepEqual(h.replies, [{ status: 'cancelled' }]);
  h.coordinator.release(id, { saved: false });
});

test('send failure cannot thaw a snapshot which main might already be writing', () => {
  let editing = true;
  const coordinator = new SavedNormalDocumentCoordinator({
    freeze: () => { editing = false; return () => { editing = true; }; },
    sessionIdentity: () => 1,
    revisionIdentity: () => 1,
    snapshot: () => null,
    markSaved: () => undefined,
  }, { sendSnapshot: () => { throw new Error('Synthetic lost response'); } });
  const id = randomUUID();
  assert.equal(coordinator.prepare(id), false);
  assert.equal(editing, false);
  assert.equal(coordinator.release(id, { saved: false }), true);
  assert.equal(editing, true);
});

test('invalid request IDs do not invoke renderer hooks', () => {
  const h = harness();
  for (const id of ['', null, {}, 'current-vha-file-saved', 'a'.repeat(4096)]) {
    assert.equal(h.coordinator.prepare(id), false);
  }
  assert.deepEqual(h.events, []);
});

test('reentrant freeze hooks cannot replace or release the active request before snapshot', () => {
  const id = randomUUID();
  let frozen = false;
  const h = harness({
    freeze: () => {
      frozen = true;
      assert.equal(h.coordinator.prepare(randomUUID()), false);
      assert.equal(h.coordinator.release(id, { saved: false }), false);
      return () => { frozen = false; };
    },
    snapshot: () => { assert.equal(frozen, true); return null; },
  });
  assert.equal(h.coordinator.prepare(id), true);
  assert.equal(h.coordinator.release(id, { saved: false }), true);
  assert.equal(frozen, false);
});

test('a failed thaw leaves the coordinator closed to further requests', () => {
  const h = harness({ freeze: () => () => { throw new Error('Synthetic failed restore'); } });
  const id = randomUUID();
  h.coordinator.prepare(id);
  assert.equal(h.coordinator.release(id, { saved: false }), false);
  assert.equal(h.coordinator.frozen, true);
  assert.equal(h.coordinator.prepare(randomUUID()), false);
});
