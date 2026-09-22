import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RendererMutationLifetime } from '../src/app/common/renderer-mutation-lifetime';
import { RendererIpcLifetime } from '../src/app/common/renderer-ipc-lifetime';
import { RendererInteractionFreeze } from '../src/app/common/renderer-interaction-freeze';

function ipcHarness() {
  const mutations = new RendererMutationLifetime();
  const tasks: (() => void)[] = [];
  const ipc = new RendererIpcLifetime(mutations, callback => tasks.push(callback));
  return { mutations, ipc, nextTask: () => { for (const task of tasks.splice(0)) { task(); } } };
}

test('native invoke holds the editor through its consumer state update', async () => {
  const h = ipcHarness();
  let settle: (value: string) => void;
  let fileName = 'old.mp4';
  const result = h.ipc.invoke(() => new Promise<string>(resolve => { settle = resolve; }));
  assert.throws(() => h.mutations.freeze(), /requests are still completing/);
  const applied = result.then(name => {
    assert.throws(() => h.mutations.freeze(), /requests are still completing/);
    fileName = name;
    h.mutations.changed();
  });
  settle!('renamed.mp4');
  await applied;
  assert.equal(fileName, 'renamed.mp4');
  assert.equal(h.mutations.pendingCount, 1);
  h.nextTask();
  const thaw = h.mutations.freeze();
  assert.equal(h.mutations.revision, 1);
  thaw();
});

test('native failure remains pending until the consumer has handled rejection', async () => {
  const h = ipcHarness();
  await assert.rejects(h.ipc.invoke(async () => { throw new Error('disk unavailable'); }), /disk unavailable/);
  assert.equal(h.mutations.pendingCount, 1);
  h.nextTask();
  assert.equal(h.mutations.pendingCount, 0);
  await assert.rejects(h.ipc.invoke(() => { throw new Error('not sent'); }), /not sent/);
  assert.equal(h.mutations.pendingCount, 0);
});

test('paused requests never invoke the native bridge', async () => {
  const h = ipcHarness();
  const thaw = h.mutations.freeze();
  let requests = 0;
  await assert.rejects(h.ipc.invoke(async () => { requests++; }), /paused/);
  assert.equal(requests, 0);
  thaw();
});

test('late durable responses retain ordering and invalidate the saved revision until replay', () => {
  const h = ipcHarness();
  const applied: string[] = [];
  const thaw = h.mutations.freeze();
  const snapshotRevision = h.mutations.revision;
  h.ipc.deliver(() => applied.push('rename'));
  h.ipc.deliver(() => applied.push('source folder'));
  assert.deepEqual(applied, []);
  assert.notEqual(h.mutations.revision, snapshotRevision);
  assert.throws(() => h.ipc.drain(), /paused/);
  thaw();
  h.ipc.drain();
  assert.deepEqual(applied, ['rename', 'source folder']);
  h.ipc.drain();
  assert.equal(applied.length, 2);
});

test('a partly applied native response is never retried and failure quarantines the editor', () => {
  const h = ipcHarness();
  const thaw = h.mutations.freeze();
  let attempts = 0;
  h.ipc.deliver(() => { attempts++; throw new Error('renderer state unavailable'); });
  h.ipc.deliver(() => { attempts++; });
  thaw();
  assert.throws(() => h.ipc.drain(), /renderer state unavailable/);
  assert.equal(h.mutations.accepting, false);
  assert.throws(() => h.ipc.drain(), /paused/);
  thaw();
  assert.equal(h.mutations.accepting, false);
  assert.equal(attempts, 1);
});

function documentHarness() {
  const target = new EventTarget();
  let blurCount = 0;
  let focusCount = 0;
  const body = { inert: false };
  const active = { isConnected: true, blur: () => { blurCount++; }, focus: () => { focusCount++; } };
  let pausedMedia = 0;
  const media = { autoplay: true, isConnected: true, pause: () => { pausedMedia++; } };
  const document = Object.assign(target, { body, activeElement: active,
    querySelectorAll: () => [media],
  });
  const guard = new RendererInteractionFreeze(document as unknown as Document);
  const dispatch = (type: string) => {
    const event = new Event(type, { cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { target, body, active, guard, dispatch, blurCount: () => blurCount, focusCount: () => focusCount,
    pausedMedia: () => pausedMedia, media };
}

test('composition refuses the handoff without blurring or hiding unfinished notes', () => {
  const h = documentHarness();
  h.dispatch('compositionstart');
  assert.throws(() => h.guard.freeze(), /Finish the current text entry/);
  assert.equal(h.blurCount(), 0);
  assert.equal(h.body.inert, false);
  h.dispatch('compositionend');
  const thaw = h.guard.freeze();
  assert.equal(h.blurCount(), 1);
  assert.equal(h.body.inert, true);
  assert.equal(h.pausedMedia(), 1);
  assert.equal(h.media.autoplay, false);
  thaw();
  assert.equal(h.media.autoplay, true);
  h.guard.dispose();
});

test('freeze blocks native editing, clipboard, clicks and drag actions including external dialog overlays', () => {
  const h = documentHarness();
  let handlers = 0;
  for (const event of ['click', 'beforeinput', 'cut', 'paste', 'keydown', 'drop']) {
    h.target.addEventListener(event, () => { handlers++; });
  }
  const thaw = h.guard.freeze();
  for (const event of ['click', 'beforeinput', 'cut', 'paste', 'keydown', 'drop']) {
    assert.equal(h.dispatch(event), true);
  }
  assert.equal(handlers, 0);
  assert.equal(h.body.inert, true);
  thaw();
  assert.equal(h.dispatch('click'), false);
  assert.equal(handlers, 1);
  assert.equal(h.body.inert, false);
  assert.equal(h.focusCount(), 1);
  thaw();
  assert.equal(h.focusCount(), 1);
  h.guard.dispose();
});

test('handback preserves pre-existing inertness and tolerates removed focus targets', () => {
  const h = documentHarness();
  h.body.inert = true;
  h.guard.freeze()();
  assert.equal(h.body.inert, true);
  assert.equal(h.focusCount(), 0);
  h.body.inert = false;
  h.active.isConnected = false;
  h.guard.freeze()();
  assert.equal(h.focusCount(), 0);
  h.active.isConnected = true;
  h.active.focus = () => { throw new Error('detached input'); };
  assert.doesNotThrow(h.guard.freeze());
  assert.equal(h.body.inert, false);
  h.guard.dispose();
});

test('blur commits its synchronous draft before interaction is frozen', () => {
  const h = documentHarness();
  let notes = '';
  h.active.blur = () => {
    assert.equal(h.body.inert, false);
    notes = 'Completed notes';
  };
  const thaw = h.guard.freeze();
  assert.equal(notes, 'Completed notes');
  assert.equal(h.body.inert, true);
  thaw();
  h.guard.dispose();
});
