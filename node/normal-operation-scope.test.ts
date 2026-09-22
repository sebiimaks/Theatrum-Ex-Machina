import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { NormalOperationScope, NormalOperationUnavailableError, type NormalOperationDrain } from './normal-operation-scope';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('admission reserves synchronous work before reentrant sealing and rejects new work', async () => {
  const scope = new NormalOperationScope();
  let drain!: Promise<NormalOperationDrain>;
  const running = scope.run(context => {
    assert.equal(scope.pendingCount, 1);
    drain = scope.seal();
    assert.equal(scope.accepting, false);
    assert.equal(context.signal.aborted, true);
    assert.equal(context.isCurrent(), false);
    assert.throws(() => context.assertCurrent(), NormalOperationUnavailableError);
    return 7;
  });
  assert.equal(await running, 7);
  scope.assertDrained(await drain);
  await assert.rejects(scope.run(() => assert.fail('No reentry')), NormalOperationUnavailableError);
});

test('sealing waits for nested returned promises and is idempotent while draining', async () => {
  const scope = new NormalOperationScope();
  const first = deferred(); const last = deferred();
  const running = scope.run(() => first.promise.then(() => last.promise).then(() => 42));
  const drain = scope.seal();
  assert.equal(drain, scope.seal());
  let drained = false;
  void drain.then(() => { drained = true; });
  first.resolve(); await turn();
  assert.equal(drained, false);
  assert.equal(scope.pendingCount, 1);
  last.resolve(); assert.equal(await running, 42);
  scope.assertDrained(await drain);
  assert.equal(scope.pendingCount, 0);
});

test('abort callbacks cannot enter another operation before the admission gate closes', async () => {
  const scope = new NormalOperationScope();
  let rejected!: Promise<unknown>;
  const running = scope.run(context => new Promise<void>(resolve => {
    context.signal.addEventListener('abort', () => {
      rejected = assert.rejects(scope.run(() => assert.fail('Reentrant work')), NormalOperationUnavailableError);
      resolve();
    });
  }));
  const drain = scope.seal();
  await Promise.all([running, rejected, drain]);
});

test('synchronous and asynchronous failures reach callers while all operations still drain', async () => {
  const scope = new NormalOperationScope();
  const failure = new Error('Synthetic failure'); const delayed = deferred();
  const sync = assert.rejects(scope.run(() => { throw failure; }), error => error === failure);
  const asyncFailure = assert.rejects(scope.run(() => delayed.promise), error => error === failure);
  const drain = scope.seal();
  delayed.reject(failure);
  await Promise.all([sync, asyncFailure]);
  scope.assertDrained(await drain);
});

test('only a real proof from the current sealed epoch can resume admission', async () => {
  const scope = new NormalOperationScope();
  const other = new NormalOperationScope();
  const first = await scope.seal();
  assert.throws(() => scope.resume({ drained: true }), NormalOperationUnavailableError);
  assert.throws(() => other.resume(first), NormalOperationUnavailableError);
  scope.resume(first);
  assert.equal(await scope.run(() => 'resumed'), 'resumed');
  assert.throws(() => scope.assertDrained(first), NormalOperationUnavailableError);
  const second = await scope.seal();
  assert.throws(() => scope.resume(first), NormalOperationUnavailableError);
  scope.resume(second);
});

test('old contexts and detached continuations remain revoked after reopening', async () => {
  const scope = new NormalOperationScope();
  const delayed = deferred();
  let late!: Promise<void>;
  let staleContext!: () => boolean;
  await scope.run(context => {
    staleContext = context.isCurrent;
    late = delayed.promise.then(async () => {
      assert.equal(scope.isCurrent(), false);
      await assert.rejects(scope.run(() => assert.fail('Old asynchronous authority')), NormalOperationUnavailableError);
    });
  });
  assert.equal(staleContext(), false);
  scope.resume(await scope.seal());
  delayed.resolve(); await late;
  assert.equal(scope.isCurrent(), true);
});

test('independently tracked child operations remain in drain after the parent settles', async () => {
  const scope = new NormalOperationScope(); const deferredChild = deferred();
  let child!: Promise<void>;
  await scope.run(() => { child = scope.run(() => deferredChild.promise); });
  assert.equal(scope.pendingCount, 1);
  const drain = scope.seal();
  await turn(); assert.equal(scope.pendingCount, 1);
  deferredChild.resolve(); await child;
  scope.assertDrained(await drain);
});

test('inOperation identifies synchronous and asynchronous ownership through revocation', async () => {
  const scope = new NormalOperationScope(); const continuation = deferred();
  assert.equal(scope.inOperation, false);
  const running = scope.run(async () => {
    assert.equal(scope.inOperation, true);
    await continuation.promise;
    assert.equal(scope.inOperation, true);
    assert.equal(scope.isCurrent(), false);
  });
  const draining = scope.seal();
  assert.equal(scope.inOperation, false);
  continuation.resolve(); await running; await draining;
});
