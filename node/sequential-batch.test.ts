import { strict as assert } from 'assert';
import { test } from 'node:test';

import { runSequentialBatch } from './sequential-batch';

test('runs jobs sequentially and continues after an individual failure', async () => {
  const executionOrder: number[] = [];
  const progress: number[] = [];

  const result = await runSequentialBatch(
    [1, 2, 3],
    async (item: number): Promise<number> => {
      executionOrder.push(item);
      if (item === 2) {
        throw new Error('expected test failure');
      }
      return item * 10;
    },
    () => false,
    update => progress.push(update.completed),
  );

  assert.deepEqual(executionOrder, [1, 2, 3]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(result.cancelled, false);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.outcomes.map(outcome => outcome.result), [10, undefined, 30]);
});

test('reports consistent success and failure counters', async () => {
  const progress: { completed: number; failed: number; succeeded: number }[] = [];

  await runSequentialBatch(
    [1, 2, 3],
    async (item: number): Promise<number> => {
      if (item === 2) {
        throw new Error('expected test failure');
      }
      return item;
    },
    () => false,
    update => progress.push({
      completed: update.completed,
      failed: update.failed,
      succeeded: update.succeeded,
    }),
  );

  assert.deepEqual(progress, [
    { completed: 1, failed: 0, succeeded: 1 },
    { completed: 2, failed: 1, succeeded: 1 },
    { completed: 3, failed: 1, succeeded: 2 },
  ]);
});

test('does not let a progress callback failure abort remaining jobs', async () => {
  const executionOrder: number[] = [];

  const result = await runSequentialBatch(
    [1, 2],
    async (item: number): Promise<number> => {
      executionOrder.push(item);
      return item;
    },
    () => false,
    () => {
      throw new Error('observer failed');
    },
  );

  assert.deepEqual(executionOrder, [1, 2]);
  assert.equal(result.succeeded, 2);
  assert.equal(result.cancelled, false);
});

test('stops before scheduling another job after cancellation', async () => {
  let cancelled = false;
  const executionOrder: number[] = [];

  const result = await runSequentialBatch(
    [1, 2, 3],
    async (item: number): Promise<number> => {
      executionOrder.push(item);
      if (item === 1) {
        cancelled = true;
      }
      return item;
    },
    () => cancelled,
  );

  assert.deepEqual(executionOrder, [1]);
  assert.equal(result.cancelled, true);
  assert.equal(result.completed, 1);
  assert.equal(result.succeeded, 1);
});

test('treats cancellation during a rejected job as cancellation, not failure', async () => {
  let cancelled = false;

  const result = await runSequentialBatch(
    [1, 2],
    async (): Promise<number> => {
      cancelled = true;
      throw new Error('queue reset');
    },
    () => cancelled,
  );

  assert.equal(result.cancelled, true);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
});

test('reports a successful in-flight job before stopping for cancellation', async () => {
  let cancelled = false;
  const progress: number[] = [];

  const result = await runSequentialBatch(
    [1, 2],
    async (item: number): Promise<number> => {
      cancelled = true;
      return item;
    },
    () => cancelled,
    update => progress.push(update.completed),
  );

  assert.deepEqual(progress, [1]);
  assert.equal(result.completed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.cancelled, true);
});
