export interface SequentialBatchOutcome<TItem, TResult> {
  item: TItem;
  result?: TResult;
  succeeded: boolean;
}

export interface SequentialBatchProgress<TItem, TResult> {
  completed: number;
  failed: number;
  outcome: SequentialBatchOutcome<TItem, TResult>;
  succeeded: number;
  total: number;
}

export interface SequentialBatchResult<TItem, TResult> {
  cancelled: boolean;
  completed: number;
  failed: number;
  outcomes: SequentialBatchOutcome<TItem, TResult>[];
  succeeded: number;
  total: number;
}

/**
 * Run expensive jobs one at a time, continue after individual failures, and
 * stop cleanly when the owning catalogue or queue generation changes.
 */
export async function runSequentialBatch<TItem, TResult>(
  items: TItem[],
  execute: (item: TItem) => Promise<TResult>,
  shouldCancel: () => boolean,
  onProgress?: (progress: SequentialBatchProgress<TItem, TResult>) => void,
): Promise<SequentialBatchResult<TItem, TResult>> {
  const outcomes: SequentialBatchOutcome<TItem, TResult>[] = [];
  let failed = 0;
  let succeeded = 0;

  for (const item of items) {
    if (shouldCancel()) {
      break;
    }

    let outcome: SequentialBatchOutcome<TItem, TResult>;
    try {
      const result = await execute(item);
      succeeded++;
      outcome = { item, result, succeeded: true };
    } catch {
      if (shouldCancel()) {
        break;
      }
      failed++;
      outcome = { item, succeeded: false };
    }

    outcomes.push(outcome);
    try {
      onProgress?.({
        completed: outcomes.length,
        failed,
        outcome,
        succeeded,
        total: items.length,
      });
    } catch (error) {
      // Progress reporting is observational and must never abort media work.
      console.warn('Sequential batch progress callback failed:', error);
    }
  }

  return {
    cancelled: outcomes.length < items.length,
    completed: outcomes.length,
    failed,
    outcomes,
    succeeded,
    total: items.length,
  };
}
