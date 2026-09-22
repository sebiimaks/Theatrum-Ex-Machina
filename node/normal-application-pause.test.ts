import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { NormalApplicationPause, type NormalApplicationPauseOptions, type NormalApplicationPauseProof } from './normal-application-pause';
import { NormalOperationScope } from './normal-operation-scope';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function fixture(overrides: Partial<NormalApplicationPauseOptions> = {}) {
  const operations = overrides.operations ?? new NormalOperationScope();
  const calls: string[] = [];
  const pause = new NormalApplicationPause({
    operations, canPause: () => true,
    onPause: () => { calls.push('pause'); },
    pauseSources: async () => { calls.push('sources'); },
    drainMedia: async () => { calls.push('media'); },
    resumeMedia: () => { calls.push('resume media'); assert.equal(operations.accepting, false); },
    resumeSources: () => { calls.push('resume sources'); assert.equal(operations.accepting, false); },
    onResume: () => { calls.push('resume'); assert.equal(operations.accepting, false); },
    ...overrides,
  });
  return { pause, operations, calls };
}

test('pause closes admission immediately and proves all three independent drains have finished', async () => {
  const ipc = deferred(); const sources = deferred(); const media = deferred();
  const f = fixture({ pauseSources: () => sources.promise, drainMedia: () => media.promise });
  const work = f.operations.run(() => ipc.promise);
  const pausing = f.pause.pause();
  assert.equal(f.operations.accepting, false);
  assert.equal(f.pause.status.state, 'pausing');
  assert.equal(f.pause.pause(), pausing);
  let complete = false;
  void pausing.then(() => { complete = true; });
  sources.resolve(); ipc.resolve(); await work; await turn();
  assert.equal(complete, false);
  assert.throws(() => f.pause.assertPaused({ paused: true }));
  media.resolve();
  const proof = await pausing;
  f.pause.assertPaused(proof);
  assert.equal(f.pause.status.state, 'paused');
  assert.equal(Object.isFrozen(proof), true);
  f.pause.resume(proof);
  assert.deepEqual(f.calls, ['pause', 'resume media', 'resume sources', 'resume']);
  assert.equal(f.operations.accepting, true);
  assert.equal(f.pause.status.state, 'normal');
});

test('a failure still waits for all sibling cleanup and leaves admission closed', async () => {
  const media = deferred(); let mediaCalled = false;
  const f = fixture({
    pauseSources: () => { throw new Error('Synthetic native close failure'); },
    drainMedia: () => { mediaCalled = true; return media.promise; },
  });
  const pausing = f.pause.pause();
  let rejected = false;
  const check = assert.rejects(pausing, /could not finish pausing/).then(() => { rejected = true; });
  await turn();
  assert.equal(mediaCalled, true);
  assert.equal(rejected, false);
  media.resolve(); await check;
  assert.equal(f.pause.status.state, 'failed');
  assert.equal(f.operations.accepting, false);
  assert.throws(() => f.pause.resume({ paused: true }));
});

test('failure of the synchronous pause adapter cannot skip source or media cleanup', async () => {
  const f = fixture({ onPause: () => { throw new Error('Synthetic failure'); } });
  await assert.rejects(f.pause.pause());
  assert.deepEqual(f.calls, ['sources', 'media']);
  assert.equal(f.operations.accepting, false);
});

test('admission checks and tracked IPC callers cannot enter a self-dependent pause', async () => {
  const f = fixture({ canPause: () => false });
  await assert.rejects(f.pause.pause(), /cannot be paused/);
  assert.equal(f.operations.accepting, true);
  assert.deepEqual(f.calls, []);
  const allowed = fixture();
  await allowed.operations.run(async () => {
    await assert.rejects(allowed.pause.pause(), /cannot be paused/);
  });
  assert.equal(allowed.operations.accepting, true);
  allowed.pause.resume(await allowed.pause.pause());
});

test('reentrant admission check is rejected without admitting a second transition', async () => {
  let reentrant!: Promise<unknown>;
  const f: ReturnType<typeof fixture> = fixture({ canPause: () => {
    reentrant = assert.rejects(f.pause.pause(), /cannot be paused/);
    return true;
  } });
  const proof = await f.pause.pause();
  await reentrant;
  assert.deepEqual(f.calls, ['pause', 'sources', 'media']);
  f.pause.resume(proof);
});

test('abort and adapter reentry share one pause while forged and consumed proofs fail', async () => {
  const f = fixture();
  let reentrant!: Promise<NormalApplicationPauseProof>;
  const running = f.operations.run(context => new Promise<void>(resolve => {
    context.signal.addEventListener('abort', () => { reentrant = f.pause.pause(); resolve(); });
  }));
  const pausing = f.pause.pause();
  assert.equal(reentrant, pausing);
  const proof = await pausing; await running;
  assert.throws(() => fixture().pause.resume(proof));
  assert.throws(() => f.pause.resume({ paused: true }));
  f.pause.resume(proof);
  assert.throws(() => f.pause.resume(proof));
  const second = await f.pause.pause();
  assert.throws(() => f.pause.resume(proof));
  f.pause.resume(second);
});

test('resume is not reentrant and reopens IPC only after restoring every adapter', async () => {
  let rejected!: Promise<unknown>;
  const f: ReturnType<typeof fixture> = fixture({ resumeMedia: () => {
    assert.equal(f.pause.status.state, 'resuming');
    assert.throws(() => f.pause.resume(proof));
    rejected = assert.rejects(f.pause.pause());
    assert.equal(f.operations.accepting, false);
  } });
  const proof = await f.pause.pause();
  f.pause.resume(proof);
  await rejected;
  assert.equal(f.operations.accepting, true);
});

test('failed resume reseals every subsystem and rejects the old proof permanently', async () => {
  const cleanup = deferred();
  let drains = 0;
  const f = fixture({
    resumeSources: () => { throw new Error('Synthetic resume failure'); },
    drainMedia: () => ++drains === 1 ? Promise.resolve() : cleanup.promise,
  });
  const proof = await f.pause.pause();
  assert.throws(() => f.pause.resume(proof), /could not resume/);
  assert.equal(f.operations.accepting, false);
  assert.equal(f.pause.status.state, 'failed');
  assert.deepEqual(f.calls, ['pause', 'sources', 'resume media', 'sources']);
  assert.equal(drains, 2);
  assert.throws(() => f.pause.assertPaused(proof));
  await assert.rejects(f.pause.pause(), /cannot be paused/);
  await assert.rejects(f.operations.run(() => assert.fail('No new IPC')));
  cleanup.resolve();
});

test('critical renderer handback runs only after admission and failure seals normal work again', async () => {
  const f = fixture();
  const proof = await f.pause.pause();
  let notified = false;
  assert.throws(() => f.pause.resume(proof, () => {
    notified = true;
    assert.equal(f.operations.accepting, true);
    assert.equal(f.pause.status.state, 'normal');
    throw new Error('Renderer release could not be delivered');
  }), /could not resume/);
  assert.equal(notified, true);
  assert.equal(f.operations.accepting, false);
  assert.equal(f.pause.status.state, 'failed');
  await assert.rejects(f.operations.run(() => assert.fail('No new native requests')));
  await assert.rejects(f.pause.pause());
  assert.throws(() => f.pause.resume(proof));
});
