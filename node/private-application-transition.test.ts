import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { NormalApplicationPause } from './normal-application-pause';
import { NormalOperationScope } from './normal-operation-scope';
import { PrivateApplicationTransition, type PrivateApplicationTransitionDependencies, type TransitionPrivateWorkspace } from './private-application-transition';
import type { PrivateHubOpenOptions, PrivateHubOpenOutcome } from './private-hub-open';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) { return; } await turn(); }
  assert.fail('Transition did not reach the expected stage.');
}

function fixture() {
  const operations = new NormalOperationScope();
  const calls: string[] = [];
  const picker = deferred<string | undefined>();
  const normalDrain = deferred();
  const saving = deferred<object>();
  const opening = deferred<PrivateHubOpenOutcome>();
  const privateDrain = deferred();
  const saved = Object.freeze({});
  let ownerCurrent = true;
  let savedCurrent = true;
  let workspaceState = 'idle';
  let privateFailed = false;
  let workspaceOptions: PrivateHubOpenOptions | undefined;
  let prepareSignal: AbortSignal | undefined;
  let hidden = false;
  let restoreFails = false;
  let resumeFails = false;
  let documentCleanupFails = false;
  let quitCount = 0;
  let beforeCapture: (() => void) | undefined;
  let beforeFactory: (() => void) | undefined;
  let beforeRestore: (() => void) | undefined;
  let onQuit: (() => void) | undefined;
  const owner = { isCurrent: () => ownerCurrent };
  const normal = new NormalApplicationPause({
    operations, canPause: () => true,
    onPause: () => { calls.push('pause'); },
    pauseSources: () => normalDrain.promise,
    drainMedia: () => normalDrain.promise,
    resumeMedia: () => { if (resumeFails) { throw new Error('Synthetic resume failure'); } },
    resumeSources: () => undefined,
    onResume: () => { calls.push('resume'); },
  });
  const workspace: TransitionPrivateWorkspace = {
    get status() { return { state: workspaceState, cleanupFailed: privateFailed }; },
    get settled() { return privateDrain.promise; },
    open(options) { calls.push('private open'); workspaceState = 'opening'; workspaceOptions = options; return opening.promise; },
    cancel() { calls.push('private cancel'); if (workspaceState !== 'idle') { workspaceState = 'closing'; } return privateDrain.promise; },
  };
  const dependencies: PrivateApplicationTransitionDependencies<typeof owner, object> = {
    captureNormal: () => { beforeCapture?.(); return owner; },
    selectDirectory: () => { calls.push('picker'); return picker.promise; },
    normal,
    document: {
      prepare: (_owner, proof, lifetime) => {
        normal.assertPaused(proof);
        assert.equal(operations.accepting, false);
        calls.push('save'); prepareSignal = lifetime.signal; return saving.promise;
      },
      assertSaved: proof => { if (proof !== saved || !savedCurrent) { throw new Error('Invalid saved proof'); } },
      cancel: async () => {
        calls.push('document release');
        if (documentCleanupFails) { throw new Error('Synthetic document cleanup failure'); }
      },
    },
    createWorkspace: () => { beforeFactory?.(); return workspace; },
    hideNormal: () => { calls.push('hide'); hidden = true; },
    restoreNormal: () => {
      assert.equal(operations.accepting, false);
      beforeRestore?.();
      if (restoreFails) { throw new Error('Synthetic restore failure'); }
      calls.push('restore'); hidden = false;
    },
    afterResume: () => { assert.equal(operations.accepting, true); calls.push('refresh'); },
    quit: () => { assert.equal(operations.accepting, true); calls.push('quit'); quitCount++; onQuit?.(); },
  };
  const transition = new PrivateApplicationTransition(dependencies);
  const advanceToSave = async () => {
    picker.resolve('/Users/sm/Workspace/synthetic-private-hub'); normalDrain.resolve();
    await until(() => calls.includes('save'));
  };
  const advanceToPrivate = async () => { await advanceToSave(); saving.resolve(saved); await until(() => calls.includes('private open')); };
  const settlePrivate = (failed = false) => { privateFailed = failed; workspaceState = failed ? 'failed' : 'idle'; privateDrain.resolve(); };
  return { transition, calls, operations, picker, normalDrain, saving, saved, opening, privateDrain,
    advanceToSave, advanceToPrivate, settlePrivate,
    opened: () => { workspaceState = 'open'; opening.resolve('opened'); },
    get workspaceOptions() { return workspaceOptions!; },
    get prepareSignal() { return prepareSignal!; },
    get hidden() { return hidden; }, get quits() { return quitCount; },
    invalidateOwner: () => { ownerCurrent = false; }, invalidateSaved: () => { savedCurrent = false; },
    failRestore: () => { restoreFails = true; }, failResume: () => { resumeFails = true; },
    failDocumentCleanup: () => { documentCleanupFails = true; },
    beforeCapture: (callback: () => void) => { beforeCapture = callback; },
    beforeFactory: (callback: () => void) => { beforeFactory = callback; },
    beforeRestore: (callback: () => void) => { beforeRestore = callback; },
    onQuit: (callback: () => void) => { onQuit = callback; },
  };
}

test('native selection, normal drain and exact saved proof precede private opening; natural close restores afterward', async () => {
  const f = fixture(); const opening = f.transition.open();
  f.picker.resolve('/Users/sm/Workspace/synthetic-private-hub');
  await until(() => f.calls.includes('pause'));
  assert.equal(f.operations.accepting, false); assert.equal(f.calls.includes('save'), false);
  f.normalDrain.resolve(); await until(() => f.calls.includes('save'));
  assert.equal(f.calls.includes('private open'), false);
  f.saving.resolve(f.saved); await until(() => f.calls.includes('private open'));
  assert.equal(f.workspaceOptions.isAuthorized(), true); assert.equal(f.hidden, true);
  f.opened(); assert.equal(await opening, 'opened');
  assert.equal(f.transition.status.state, 'open');
  assert.equal(await f.transition.open(), 'busy');
  const complete = f.transition.settled;
  f.settlePrivate(); await complete;
  assert.equal(f.transition.status.state, 'idle');
  assert.equal(f.operations.accepting, true); assert.equal(f.hidden, false);
  assert.deepEqual(f.calls.slice(-4), ['document release', 'restore', 'resume', 'refresh']);
});

test('reentrant capture cannot admit another transition', async () => {
  const f = fixture(); let second!: Promise<PrivateHubOpenOutcome>;
  f.beforeCapture(() => { second = f.transition.open(); });
  const first = f.transition.open();
  assert.equal(await second, 'busy');
  f.picker.resolve(undefined); assert.equal(await first, 'cancelled');
  assert.deepEqual(f.calls, ['picker']);
});

test('cancel waits for a late picker result and does not pause or save', async () => {
  const f = fixture(); const opening = f.transition.open(); const cancellation = f.transition.cancel();
  let done = false; void cancellation.then(() => { done = true; }); await turn();
  assert.equal(done, false);
  f.picker.resolve('/Users/sm/Workspace/stale-choice'); await cancellation;
  assert.equal(await opening, 'cancelled'); assert.deepEqual(f.calls, ['picker']);
});

test('cancel while normal drain is pending waits and restores without requesting a snapshot', async () => {
  const f = fixture(); const opening = f.transition.open();
  f.picker.resolve('/Users/sm/Workspace/synthetic-private-hub');
  await until(() => f.calls.includes('pause'));
  const cancelled = f.transition.cancel(); await turn();
  assert.equal(f.operations.accepting, false);
  f.normalDrain.resolve(); await cancelled;
  assert.equal(await opening, 'cancelled'); assert.equal(f.calls.includes('save'), false);
  assert.equal(f.operations.accepting, true);
});

test('cancel while saving waits for the actual save before releasing editing and restoring normal work', async () => {
  const f = fixture(); const opening = f.transition.open(); await f.advanceToSave();
  const cancelled = f.transition.cancel();
  assert.equal(f.prepareSignal.aborted, true); await turn();
  assert.equal(f.calls.includes('document release'), false);
  assert.equal(f.operations.accepting, false);
  f.saving.resolve(f.saved); await cancelled;
  assert.equal(await opening, 'cancelled'); assert.equal(f.calls.includes('private open'), false);
  assert.equal(f.operations.accepting, true);
});

test('a save failure restores the normal document and never opens private credentials', async () => {
  const f = fixture(); const opening = f.transition.open(); await f.advanceToSave();
  f.saving.reject(new Error('Synthetic save failure'));
  assert.equal(await opening, 'unavailable'); assert.equal(f.calls.includes('private open'), false);
  assert.equal(f.operations.accepting, true); assert.equal(f.hidden, false);
});

test('cancel during private opening waits for late opening and storage disposal', async () => {
  const f = fixture(); const opening = f.transition.open(); await f.advanceToPrivate();
  const cancelled = f.transition.cancel();
  assert.equal(f.workspaceOptions.signal!.aborted, true); assert.equal(f.workspaceOptions.isAuthorized(), false);
  await turn(); assert.equal(f.calls.includes('document release'), false);
  f.opening.resolve('cancelled'); await turn(); assert.equal(f.operations.accepting, false);
  f.settlePrivate(); await cancelled;
  assert.equal(await opening, 'cancelled'); assert.equal(f.operations.accepting, true);
});

test('late workspace factory is adopted for cleanup after reentrant cancellation', async () => {
  const f = fixture(); f.beforeFactory(() => { void f.transition.cancel(); });
  const opening = f.transition.open(); await f.advanceToSave(); f.saving.resolve(f.saved);
  await until(() => f.calls.includes('private cancel'));
  assert.equal(f.calls.includes('private open'), false);
  f.settlePrivate(); assert.equal(await opening, 'cancelled'); assert.equal(f.operations.accepting, true);
});

test('a stale saved proof cannot authorize a private prompt', async () => {
  const f = fixture(); const opening = f.transition.open(); await f.advanceToSave();
  f.invalidateSaved(); f.saving.resolve(f.saved);
  assert.equal(await opening, 'unavailable'); assert.equal(f.calls.includes('private open'), false);
});

test('owner replacement during saving cannot restore or authorize the old catalogue', async () => {
  const f = fixture(); const opening = f.transition.open(); await f.advanceToSave();
  f.invalidateOwner(); f.saving.resolve(f.saved);
  assert.equal(await opening, 'unavailable'); assert.equal(f.calls.includes('private open'), false);
  assert.equal(f.transition.status.cleanupFailed, true); assert.equal(f.operations.accepting, false);
});

for (const failure of ['private', 'document', 'restore', 'resume'] as const) {
  test(`${failure} cleanup failure keeps admission closed and prevents quit retry`, async () => {
    const f = fixture(); const opening = f.transition.open(); await f.advanceToPrivate(); f.opened();
    assert.equal(await opening, 'opened');
    if (failure === 'document') { f.failDocumentCleanup(); }
    if (failure === 'restore') { f.failRestore(); }
    if (failure === 'resume') { f.failResume(); }
    const quitting = f.transition.requestQuit(); f.settlePrivate(failure === 'private'); await quitting;
    assert.equal(f.transition.status.state, 'failed'); assert.equal(f.operations.accepting, false);
    if (failure === 'private') { assert.equal(f.calls.includes('document release'), false); }
    assert.equal(f.quits, 0); assert.equal(await f.transition.open(), 'unavailable');
    assert.equal(f.transition.acknowledgeQuitCancelled(), false);
  });
}

test('repeated quit waits for complete private disposal and retries the normal close handshake only once', async () => {
  const f = fixture(); const opening = f.transition.open(); await f.advanceToPrivate(); f.opened();
  assert.equal(await opening, 'opened');
  const first = f.transition.requestQuit(); const second = f.transition.requestQuit();
  await turn(); assert.equal(f.quits, 0); assert.equal(f.operations.accepting, false);
  assert.equal(f.calls.includes('document release'), false);
  f.settlePrivate(); await Promise.all([first, second]);
  assert.equal(f.quits, 1); assert.equal(f.calls.at(-1), 'quit');
  assert.equal(f.operations.accepting, true);
  assert.equal(await f.transition.open(), 'unavailable');
});

test('quit before selection finishes waits for the picker then uses ordinary saving without private admission', async () => {
  const f = fixture(); const opening = f.transition.open(); const quitting = f.transition.requestQuit();
  await turn(); assert.equal(f.quits, 0);
  f.picker.resolve(undefined); await quitting;
  assert.equal(await opening, 'cancelled'); assert.equal(f.quits, 1);
  assert.deepEqual(f.calls, ['picker', 'quit']);
});

test('invalid picker paths fail before pausing or saving', async () => {
  for (const selected of ['relative-private-hub', '/Users/sm/Workspace/invalid\0hub']) {
    const f = fixture(); const opening = f.transition.open(); f.picker.resolve(selected);
    assert.equal(await opening, 'unavailable'); assert.deepEqual(f.calls, ['picker']);
  }
});

test('failed normal cleanup never requests a snapshot or opens a private workspace', async () => {
  const f = fixture(); const opening = f.transition.open();
  f.picker.resolve('/Users/sm/Workspace/synthetic-private-hub');
  f.normalDrain.reject(new Error('Synthetic watcher failure'));
  assert.equal(await opening, 'unavailable');
  assert.equal(f.transition.status.cleanupFailed, true); assert.equal(f.operations.accepting, false);
  assert.equal(f.calls.includes('save'), false); assert.equal(f.calls.includes('private open'), false);
});

test('allocation-free workspace factory failure restores the saved normal window', async () => {
  const f = fixture(); f.beforeFactory(() => { throw new Error('Synthetic configuration failure'); });
  const opening = f.transition.open(); await f.advanceToSave(); f.saving.resolve(f.saved);
  assert.equal(await opening, 'unavailable'); assert.equal(f.hidden, false);
  assert.equal(f.operations.accepting, true); assert.equal(f.calls.includes('private open'), false);
});

test('restore reentry cannot start another private workspace and a nested quit retries after restoration', async () => {
  const f = fixture(); let second!: Promise<PrivateHubOpenOutcome>; let quitting!: Promise<void>;
  f.beforeRestore(() => { second = f.transition.open(); quitting = f.transition.requestQuit(); });
  const opening = f.transition.open(); await f.advanceToPrivate(); f.opened();
  assert.equal(await opening, 'opened');
  f.settlePrivate(); await f.transition.settled;
  assert.equal(await second, 'busy'); await quitting;
  assert.equal(f.quits, 1); assert.equal(f.operations.accepting, true);
});

test('window replacement during restoration cannot reopen normal admission', async () => {
  const f = fixture(); f.beforeRestore(() => f.invalidateOwner());
  const opening = f.transition.open(); await f.advanceToPrivate(); f.opened();
  assert.equal(await opening, 'opened');
  const cancelled = f.transition.cancel(); f.settlePrivate(); await cancelled;
  assert.equal(f.transition.status.cleanupFailed, true);
  assert.equal(f.operations.accepting, false); assert.equal(f.calls.includes('resume'), false);
});

test('only an explicit close-cancel acknowledgement after clean handback restores private admission', async () => {
  const f = fixture(); assert.equal(f.transition.acknowledgeQuitCancelled(), false);
  const opening = f.transition.open(); await f.advanceToPrivate(); f.opened();
  assert.equal(await opening, 'opened');
  const quitting = f.transition.requestQuit();
  assert.equal(f.transition.acknowledgeQuitCancelled(), false);
  f.settlePrivate(); await quitting;
  assert.equal(await f.transition.open(), 'unavailable');
  assert.equal(f.transition.acknowledgeQuitCancelled(), true);
  assert.equal(f.transition.acknowledgeQuitCancelled(), false);
  const second = f.transition.open(); const cancelled = f.transition.cancel();
  await cancelled; assert.equal(await second, 'cancelled');
  assert.equal(f.calls.filter(call => call === 'picker').length, 2);
});

test('a reentrant quit cancellation prevents a second waiting quit caller from retrying', async () => {
  const f = fixture(); f.onQuit(() => { assert.equal(f.transition.acknowledgeQuitCancelled(), true); });
  const opening = f.transition.open(); await f.advanceToPrivate(); f.opened(); await opening;
  const first = f.transition.requestQuit(); const second = f.transition.requestQuit();
  f.settlePrivate(); await Promise.all([first, second]);
  assert.equal(f.quits, 1); assert.equal(f.transition.status.quitRequested, false);
});
