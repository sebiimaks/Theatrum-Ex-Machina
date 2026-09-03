import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';

import type { FinalObject } from '../interfaces/final-object.interface';
import {
  CatalogueOpenCoordinator,
  CatalogueOpenScheduler,
  LegacyCatalogueOpenChoice,
} from '../src/app/common/catalogue-open-coordinator';

class ManualScheduler implements CatalogueOpenScheduler {

  private nextHandle = 1;
  private readonly tasks = new Map<number, () => void>();

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  flushNext(): void {
    const next = this.tasks.entries().next();
    if (next.done) {
      return;
    }
    const [handle, task] = next.value;
    this.tasks.delete(handle);
    task();
  }

  get pendingCount(): number {
    return this.tasks.size;
  }

  schedule(task: () => void): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, task);
    return handle;
  }
}

interface OpenRecord {
  currentCatalogue: FinalObject | null;
  fullPath: string;
  intent: string;
}

function createHarness(options: {
  canBeginOpen?: () => boolean;
  chooseLegacyCatalogueOpen?: (
    fullPath: string,
  ) => Promise<LegacyCatalogueOpenChoice | undefined>;
  legacyOpenCancelled?: (fullPath: string) => void;
} = {}) {
  const scheduler = new ManualScheduler();
  const opens: OpenRecord[] = [];
  const snapshot = { hubName: 'Unsaved catalogue' } as FinalObject;
  let acknowledgements = 0;
  let startupCompletions = 0;

  const coordinator = new CatalogueOpenCoordinator({
    acknowledgeExternalRequest: () => {
      acknowledgements += 1;
    },
    loadCatalogue: (fullPath, currentCatalogue, intent) => {
      opens.push({ currentCatalogue, fullPath, intent });
    },
    markRendererStartupComplete: () => {
      startupCompletions += 1;
    },
  }, scheduler);

  coordinator.connect({
    canBeginOpen: options.canBeginOpen || (() => true),
    chooseLegacyCatalogueOpen: options.chooseLegacyCatalogueOpen || (async () => undefined),
    getCurrentCatalogueForSave: () => snapshot,
    legacyOpenCancelled: options.legacyOpenCancelled,
  });

  return {
    coordinator,
    get acknowledgements() {
      return acknowledgements;
    },
    get startupCompletions() {
      return startupCompletions;
    },
    opens,
    scheduler,
    snapshot,
  };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('catalogue opens are serialized in FIFO order with the latest unsaved snapshot', () => {
  const harness = createHarness();

  harness.coordinator.requestOpen('/catalogues/one.scaena', true);
  harness.coordinator.requestOpen('/catalogues/two.scaena', true);
  harness.coordinator.requestOpen('/catalogues/three.scaena', true);

  assert.deepEqual(harness.opens.map(({ fullPath }) => fullPath), ['/catalogues/one.scaena']);
  assert.equal(harness.acknowledgements, 1);
  assert.equal(harness.opens[0].currentCatalogue, harness.snapshot);
  assert.equal(harness.opens[0].intent, 'read-write');

  harness.coordinator.finishOpen();
  assert.equal(harness.scheduler.pendingCount, 1);
  harness.scheduler.flushNext();
  assert.deepEqual(
    harness.opens.map(({ fullPath }) => fullPath),
    ['/catalogues/one.scaena', '/catalogues/two.scaena'],
  );
  assert.equal(harness.acknowledgements, 2);

  harness.coordinator.finishOpen();
  harness.scheduler.flushNext();
  assert.deepEqual(
    harness.opens.map(({ fullPath }) => fullPath),
    ['/catalogues/one.scaena', '/catalogues/two.scaena', '/catalogues/three.scaena'],
  );
  assert.equal(harness.acknowledgements, 3);
});

test('legacy catalogue choices preserve read-only and duplicate intents', async () => {
  let resolveChoice: (choice: LegacyCatalogueOpenChoice | undefined) => void;
  const harness = createHarness({
    chooseLegacyCatalogueOpen: () => new Promise((resolve) => {
      resolveChoice = resolve;
    }),
  });

  harness.coordinator.requestOpen('/catalogues/legacy.vha2', true);
  assert.equal(harness.startupCompletions, 1);
  assert.equal(harness.opens.length, 0);
  assert.equal(harness.acknowledgements, 0);

  resolveChoice('read-only');
  await settlePromises();
  assert.deepEqual(harness.opens.map(({ intent }) => intent), ['read-only']);
  assert.equal(harness.acknowledgements, 1);

  harness.coordinator.finishOpen();
  harness.coordinator.requestOpen('/catalogues/duplicate.vha2');
  resolveChoice('duplicate-scaena');
  await settlePromises();
  assert.deepEqual(
    harness.opens.map(({ intent }) => intent),
    ['read-only', 'duplicate-scaena'],
  );

  harness.coordinator.markRendererStartupComplete();
  assert.equal(harness.startupCompletions, 1);
});

test('cancelling a legacy decision releases the next queued request', async () => {
  let resolveChoice: (choice: LegacyCatalogueOpenChoice | undefined) => void;
  const cancelledPaths: string[] = [];
  const harness = createHarness({
    chooseLegacyCatalogueOpen: () => new Promise((resolve) => {
      resolveChoice = resolve;
    }),
    legacyOpenCancelled: (fullPath: string) => cancelledPaths.push(fullPath),
  });

  harness.coordinator.requestOpen('/catalogues/legacy.vha2', true);
  harness.coordinator.requestOpen('/catalogues/next.scaena', true);
  resolveChoice(undefined);
  await settlePromises();

  assert.equal(harness.acknowledgements, 1);
  assert.deepEqual(cancelledPaths, ['/catalogues/legacy.vha2']);
  assert.equal(harness.scheduler.pendingCount, 1);
  harness.scheduler.flushNext();
  assert.deepEqual(harness.opens.map(({ fullPath }) => fullPath), ['/catalogues/next.scaena']);
  assert.equal(harness.acknowledgements, 2);
});

test('backup notices defer opens and blocked regeneration requests are acknowledged without opening', () => {
  const backupHarness = createHarness();
  backupHarness.coordinator.setBackupNoticeOpen(true);
  backupHarness.coordinator.requestOpen('/catalogues/after-backup.scaena', true);
  assert.equal(backupHarness.opens.length, 0);
  assert.equal(backupHarness.acknowledgements, 0);

  backupHarness.coordinator.setBackupNoticeOpen(false);
  backupHarness.scheduler.flushNext();
  assert.deepEqual(
    backupHarness.opens.map(({ fullPath }) => fullPath),
    ['/catalogues/after-backup.scaena'],
  );
  assert.equal(backupHarness.acknowledgements, 1);

  const blockedHarness = createHarness({ canBeginOpen: () => false });
  blockedHarness.coordinator.requestOpen('/catalogues/blocked.scaena', true);
  assert.equal(blockedHarness.opens.length, 0);
  assert.equal(blockedHarness.acknowledgements, 1);
});

test('disconnect cancels queued drains and ignores stale legacy decisions', async () => {
  let resolveChoice: (choice: LegacyCatalogueOpenChoice | undefined) => void;
  const harness = createHarness({
    chooseLegacyCatalogueOpen: () => new Promise((resolve) => {
      resolveChoice = resolve;
    }),
  });

  harness.coordinator.requestOpen('/catalogues/one.scaena');
  harness.coordinator.requestOpen('/catalogues/two.scaena');
  harness.coordinator.finishOpen();
  assert.equal(harness.scheduler.pendingCount, 1);
  harness.coordinator.disconnect();
  assert.equal(harness.scheduler.pendingCount, 0);
  harness.scheduler.flushNext();
  assert.deepEqual(harness.opens.map(({ fullPath }) => fullPath), ['/catalogues/one.scaena']);

  harness.coordinator.connect({
    canBeginOpen: () => true,
    chooseLegacyCatalogueOpen: () => new Promise((resolve) => {
      resolveChoice = resolve;
    }),
    getCurrentCatalogueForSave: () => harness.snapshot,
  });
  harness.coordinator.requestOpen('/catalogues/stale.vha2', true);
  harness.coordinator.disconnect();
  resolveChoice('read-only');
  await settlePromises();

  assert.deepEqual(harness.opens.map(({ fullPath }) => fullPath), ['/catalogues/one.scaena']);
  assert.equal(harness.acknowledgements, 1);
  harness.coordinator.disconnect();
  assert.equal(harness.acknowledgements, 1);
});

test('disconnect acknowledges a queued external open exactly once', () => {
  const harness = createHarness();

  harness.coordinator.requestOpen('/catalogues/local.scaena');
  harness.coordinator.requestOpen('/catalogues/from-finder.scaena', true);
  assert.equal(harness.acknowledgements, 0);

  harness.coordinator.disconnect();
  assert.equal(harness.acknowledgements, 1);
  harness.coordinator.disconnect();
  assert.equal(harness.acknowledgements, 1);
  assert.deepEqual(harness.opens.map(({ fullPath }) => fullPath), ['/catalogues/local.scaena']);
});

test('catalogue-open IPC ownership moved out of HomeComponent', () => {
  const home = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );
  const service = readFileSync(
    join(__dirname, '../src/app/services/catalogue-open-coordinator.service.ts'),
    'utf8',
  );

  assert.equal(home.includes("ipcRenderer.on('open-catalogue-from-system'"), false);
  assert.equal(home.includes("ipcRenderer.on('catalogue-open-request-finished'"), false);
  assert.match(service, /'open-catalogue-from-system'/);
  assert.match(service, /'catalogue-open-request-finished'/);
  assert.match(home, /this\.catalogueOpenCoordinator\.disconnect\(\)/);
});
