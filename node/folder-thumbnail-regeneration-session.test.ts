import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';

import {
  FolderThumbnailRegenerationSession,
} from '../src/app/common/folder-thumbnail-regeneration-session';

const baseStart = {
  hubFile: '/catalogues/photography.scaena',
  relativePath: 'Cameras/Leica',
  skippedVideos: 2,
  sourceFolderPath: '/media/videos',
  sourceIndex: 3,
  totalJobs: 2,
  videoCountsByHash: new Map([
    ['hash-a', 2],
    ['hash-b', 1],
  ]),
};

const baseEvent = {
  currentHubFile: baseStart.hubFile,
  currentSourceFolderPath: baseStart.sourceFolderPath,
  requestId: 1,
  sourceIndex: baseStart.sourceIndex,
};

test('begin snapshots the confirmed plan and allocates monotonic request IDs', () => {
  const session = new FolderThumbnailRegenerationSession();
  const videoCountsByHash = new Map(baseStart.videoCountsByHash);
  const first = session.begin({ ...baseStart, videoCountsByHash });

  assert.deepEqual(first, {
    requestId: 1,
    status: {
      completedJobs: 0,
      relativePath: baseStart.relativePath,
      sourceIndex: baseStart.sourceIndex,
      totalJobs: baseStart.totalJobs,
    },
  });
  assert.equal(session.active, true);
  assert.equal(session.begin(baseStart), undefined);

  videoCountsByHash.set('hash-a', 99);
  assert.equal(session.snapshot?.videoCountsByHash.get('hash-a'), 2);
  const snapshot = session.snapshot;
  (snapshot?.videoCountsByHash as Map<string, number>).set('hash-a', 100);
  assert.equal(session.snapshot?.videoCountsByHash.get('hash-a'), 2);

  session.clear();
  assert.equal(session.begin(baseStart)?.requestId, 2);
});

test('progress is correlated by request, source, hub, and configured source path', () => {
  const progress = {
    completed: 1,
    fileHash: 'hash-a',
    screenshotCount: 12,
    success: true,
    total: 2,
  };

  for (const mismatch of [
    { requestId: 7 },
    { sourceIndex: 8 },
  ]) {
    const session = new FolderThumbnailRegenerationSession();
    session.begin(baseStart);
    assert.deepEqual(session.acceptProgress({ ...baseEvent, ...mismatch, progress }), {
      accepted: false,
    });
    assert.equal(session.active, true);
  }

  for (const mismatch of [
    { currentHubFile: '/catalogues/other.scaena' },
    { currentSourceFolderPath: '/media/replaced' },
  ]) {
    const session = new FolderThumbnailRegenerationSession();
    session.begin(baseStart);
    assert.deepEqual(session.acceptProgress({ ...baseEvent, ...mismatch, progress }), {
      accepted: false,
    });
    assert.equal(session.active, false);
  }
});

test('unknown and duplicate hashes cannot mutate the active batch', () => {
  const session = new FolderThumbnailRegenerationSession();
  session.begin(baseStart);

  assert.deepEqual(session.acceptProgress({
    ...baseEvent,
    progress: {
      completed: 1,
      fileHash: 'unknown-hash',
      screenshotCount: 12,
      success: true,
      total: 2,
    },
  }), { accepted: false });
  assert.equal(session.snapshot?.processedHashes.size, 0);

  const first = session.acceptProgress({
    ...baseEvent,
    progress: {
      completed: 1,
      fileHash: 'hash-a',
      screenshotCount: 12,
      success: true,
      total: 2,
    },
  });
  assert.equal(first.accepted, true);
  assert.deepEqual(session.acceptProgress({
    ...baseEvent,
    progress: {
      completed: 2,
      fileHash: 'hash-a',
      success: false,
      total: 2,
    },
  }), { accepted: false });
  assert.equal(session.snapshot?.succeededVideos, 2);
  assert.equal(session.snapshot?.failedVideos, 0);
});

test('progress weights logical videos and keeps confirmed progress bounded and monotonic', () => {
  const session = new FolderThumbnailRegenerationSession();
  session.begin(baseStart);

  const success = session.acceptProgress({
    ...baseEvent,
    progress: {
      completed: 50,
      fileHash: 'hash-a',
      screenshotCount: 8,
      success: true,
      total: 50,
    },
  });
  assert.deepEqual(success, {
    accepted: true,
    status: {
      cancelling: undefined,
      completedJobs: 2,
      relativePath: baseStart.relativePath,
      sourceIndex: baseStart.sourceIndex,
      totalJobs: 2,
    },
    successfulUpdate: { fileHash: 'hash-a', screenshotCount: 8 },
  });
  assert.equal(session.snapshot?.succeededVideos, 2);

  const failure = session.acceptProgress({
    ...baseEvent,
    progress: {
      completed: -1,
      fileHash: 'hash-b',
      screenshotCount: 0,
      success: true,
      total: 50,
    },
  });
  assert.equal(failure.accepted, true);
  assert.equal(session.status?.completedJobs, 2);
  assert.equal(session.snapshot?.failedVideos, 1);
  assert.deepEqual(Array.from(session.snapshot?.updatedHashes || []), ['hash-a']);
});

test('cancellation is idempotent and remains visible through later progress', () => {
  const session = new FolderThumbnailRegenerationSession();
  session.begin(baseStart);

  assert.equal(session.markCancelling().changed, true);
  assert.equal(session.markCancelling().changed, false);
  session.acceptProgress({
    ...baseEvent,
    progress: {
      completed: 1,
      fileHash: 'hash-a',
      success: false,
      total: 2,
    },
  });
  assert.equal(session.status?.cancelling, true);
});

test('completion returns immutable accumulated summaries and then clears', () => {
  const session = new FolderThumbnailRegenerationSession();
  session.begin(baseStart);
  session.acceptProgress({
    ...baseEvent,
    progress: {
      completed: 1,
      fileHash: 'hash-a',
      screenshotCount: 10,
      success: true,
      total: 2,
    },
  });
  session.acceptProgress({
    ...baseEvent,
    progress: {
      completed: 2,
      fileHash: 'hash-b',
      success: false,
      total: 2,
    },
  });

  const completion = session.complete({ ...baseEvent, cancelled: false });
  assert.deepEqual(completion, {
    accepted: true,
    failedVideos: 1,
    outcome: 'partial',
    skippedVideos: 2,
    succeededVideos: 2,
    updatedHashes: new Set(['hash-a']),
  });
  assert.equal(session.active, false);

  if (completion.accepted) {
    (completion.updatedHashes as Set<string>).add('external-mutation');
  }
  assert.equal(session.snapshot, null);
  assert.deepEqual(session.complete({ ...baseEvent, cancelled: false }), { accepted: false });
});

test('cancelled completion takes precedence over partial and all-success batches complete', () => {
  const cancelled = new FolderThumbnailRegenerationSession();
  cancelled.begin(baseStart);
  assert.equal(cancelled.complete({ ...baseEvent, cancelled: true }).accepted, true);
  const cancelledResult = new FolderThumbnailRegenerationSession();
  cancelledResult.begin(baseStart);
  const cancelledDecision = cancelledResult.complete({ ...baseEvent, cancelled: true });
  assert.equal(cancelledDecision.accepted && cancelledDecision.outcome, 'cancelled');

  const complete = new FolderThumbnailRegenerationSession();
  complete.begin({ ...baseStart, skippedVideos: 0, totalJobs: 1 });
  complete.acceptProgress({
    ...baseEvent,
    progress: {
      completed: 1,
      fileHash: 'hash-a',
      screenshotCount: 5,
      success: true,
      total: 1,
    },
  });
  const decision = complete.complete({ ...baseEvent, cancelled: false });
  assert.equal(decision.accepted && decision.outcome, 'complete');
});

test('failure clears only a matching active batch', () => {
  const session = new FolderThumbnailRegenerationSession();
  session.begin(baseStart);
  assert.equal(session.fail({ ...baseEvent, requestId: 99 }), false);
  assert.equal(session.active, true);
  assert.equal(session.fail(baseEvent), true);
  assert.equal(session.active, false);
});

test('Home keeps UI, IPC, timer, and catalogue effects around the pure session', () => {
  const component = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );
  const confirmationStart = component.indexOf('confirmRegenerateFolderThumbnails(');
  const confirmationCallbackStart = component.indexOf(
    '.subscribe((confirmed: boolean) => {',
    confirmationStart,
  );
  const sessionBeginStart = component.indexOf(
    'folderThumbnailRegenerationSession.begin(',
    confirmationCallbackStart,
  );
  const progressStart = component.indexOf(
    'handleFolderThumbnailRegenerationProgress(',
    confirmationStart,
  );
  const relevantComponent = component.slice(confirmationStart, progressStart + 5000);
  const postConfirmationGuard = component.slice(confirmationCallbackStart, sessionBeginStart);

  assert.match(postConfirmationGuard, /if \(this\.catalogueReadOnly\)/);
  assert.match(postConfirmationGuard, /if \(this\.thumbnailRegenerationActive\)/);
  assert.match(relevantComponent, /folderThumbnailRegenerationPlansMatch\(plan, currentPlan\)/);
  assert.match(relevantComponent, /folderThumbnailRegenerationSession\.begin\(/);
  assert.match(relevantComponent, /thumbnailRegenerationIpc\.regenerateFolder\(\{/);
  assert.match(relevantComponent, /folderThumbnailRegenerationSession\.acceptProgress\(/);
  assert.match(relevantComponent, /applyThumbnailRegenerationResult\(/);
  assert.match(relevantComponent, /webFrame\.clearCache\(\)/);
  assert.match(relevantComponent, /startThumbnailRegenerationClock\(\)/);
  assert.match(relevantComponent, /stopThumbnailRegenerationClockIfIdle\(\)/);
  assert.match(component, /folderProgress:[\s\S]*handleFolderThumbnailRegenerationProgress/);
  assert.match(component, /folderCompleted:[\s\S]*handleFolderThumbnailRegenerationComplete/);
  assert.match(component, /folderFailed:[\s\S]*handleFolderThumbnailRegenerationFailure/);
});
