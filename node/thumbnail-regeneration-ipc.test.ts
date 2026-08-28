import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';

import type { ImageElement } from '../interfaces/final-object.interface';
import {
  isFolderThumbnailRegenerationProgress,
  isFolderThumbnailRegenerationResult,
  isSafeThumbnailHash,
  isThumbnailCoreStatus,
  isThumbnailRegenerationCorrelation,
} from '../interfaces/thumbnail-regeneration';
import type {
  FolderThumbnailRegenerationProgress,
  FolderThumbnailRegenerationResult,
  ThumbnailCoreStatus,
} from '../interfaces/thumbnail-regeneration';
import {
  classifyIndividualThumbnailRegenerationTerminal,
  ThumbnailRegenerationIpcCoordinator,
} from '../src/app/common/thumbnail-regeneration-ipc';
import type {
  FolderThumbnailRegenerationCommand,
  ThumbnailRegenerationIpcHooks,
  ThumbnailRegenerationIpcTransport,
} from '../src/app/common/thumbnail-regeneration-ipc';

type AssetsListener = () => void;
type IndividualCompletedListener = (fileHash: string, screenshotCount?: number) => void;
type IndividualFailedListener = (
  fileHash: string,
  reason?: string,
  coreStatus?: ThumbnailCoreStatus,
) => void;
type FolderProgressListener = (
  requestId: number,
  sourceIndex: number,
  progress?: FolderThumbnailRegenerationProgress,
) => void;
type FolderCompletedListener = (
  requestId: number,
  sourceIndex: number,
  result?: FolderThumbnailRegenerationResult,
) => void;
type FolderFailedListener = (requestId: number, sourceIndex: number) => void;

class FakeThumbnailRegenerationTransport implements ThumbnailRegenerationIpcTransport {

  readonly allListeners: ((...args: any[]) => void)[] = [];
  readonly assetsReplaced = new Set<AssetsListener>();
  readonly folderCommands: FolderThumbnailRegenerationCommand[] = [];
  readonly folderCompleted = new Set<FolderCompletedListener>();
  readonly folderFailed = new Set<FolderFailedListener>();
  readonly folderProgress = new Set<FolderProgressListener>();
  readonly individualCompleted = new Set<IndividualCompletedListener>();
  readonly individualFailed = new Set<IndividualFailedListener>();
  readonly individualItems: ImageElement[] = [];
  cancelFolderCalls = 0;
  cancelIndividualCalls = 0;
  disposerAttempts = 0;
  disposerCalls = 0;
  registrationCalls = 0;
  throwOnDisposerAttempt = 0;
  throwOnRegistration = 0;

  cancelFolder(): void {
    this.cancelFolderCalls += 1;
  }

  cancelIndividual(): void {
    this.cancelIndividualCalls += 1;
  }

  onFolderCompleted(listener: FolderCompletedListener): () => void {
    return this.register(this.folderCompleted, listener);
  }

  onFolderFailed(listener: FolderFailedListener): () => void {
    return this.register(this.folderFailed, listener);
  }

  onFolderProgress(listener: FolderProgressListener): () => void {
    return this.register(this.folderProgress, listener);
  }

  onIndividualAssetsReplaced(listener: AssetsListener): () => void {
    return this.register(this.assetsReplaced, listener);
  }

  onIndividualCompleted(listener: IndividualCompletedListener): () => void {
    return this.register(this.individualCompleted, listener);
  }

  onIndividualFailed(listener: IndividualFailedListener): () => void {
    return this.register(this.individualFailed, listener);
  }

  regenerateFolder(command: FolderThumbnailRegenerationCommand): void {
    this.folderCommands.push(command);
  }

  regenerateIndividual(item: ImageElement): void {
    this.individualItems.push(item);
  }

  private register<T extends (...args: any[]) => void>(listeners: Set<T>, listener: T): () => void {
    this.registrationCalls += 1;
    if (this.registrationCalls === this.throwOnRegistration) {
      throw new Error('Listener registration failed.');
    }
    listeners.add(listener);
    this.allListeners.push(listener);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      listeners.delete(listener);
      this.disposerAttempts += 1;
      if (this.disposerAttempts === this.throwOnDisposerAttempt) {
        throw new Error('Listener disposal failed.');
      }
      this.disposerCalls += 1;
    };
  }
}

function createHooks(events: string[], captured: unknown[]): ThumbnailRegenerationIpcHooks {
  return {
    folderCompleted: (requestId, sourceIndex, result): void => {
      events.push(`folder-completed:${requestId}:${sourceIndex}`);
      captured.push(result);
    },
    folderFailed: (requestId, sourceIndex): void => {
      events.push(`folder-failed:${requestId}:${sourceIndex}`);
    },
    folderProgress: (requestId, sourceIndex, progress): void => {
      events.push(`folder-progress:${requestId}:${sourceIndex}`);
      captured.push(progress);
    },
    folderProgressRejected: (requestId, sourceIndex): void => {
      events.push(`folder-progress-rejected:${requestId}:${sourceIndex}`);
    },
    individualAssetsReplaced: (): void => {
      events.push('assets-replaced');
    },
    individualCompleted: (fileHash, screenshotCount): void => {
      events.push(`individual-completed:${fileHash}:${screenshotCount}`);
    },
    individualFailed: (fileHash, reason, coreStatus): void => {
      events.push(`individual-failed:${fileHash}:${reason || ''}`);
      captured.push(coreStatus);
    },
  };
}

const progress: FolderThumbnailRegenerationProgress = {
  completed: 1,
  failed: 0,
  fileHash: 'hash-a',
  screenshotCount: 10,
  succeeded: 1,
  success: true,
  total: 2,
};

const result: FolderThumbnailRegenerationResult = {
  cancelled: false,
  completed: 2,
  failed: 0,
  skippedVideos: 0,
  succeeded: 2,
  total: 2,
  videoCount: 2,
};

test('maps all six notifications to typed hooks without losing payload identity', () => {
  const transport = new FakeThumbnailRegenerationTransport();
  const coordinator = new ThumbnailRegenerationIpcCoordinator(transport);
  const events: string[] = [];
  const captured: unknown[] = [];
  const coreStatus: ThumbnailCoreStatus = { filmstrip: false, thumbnail: true };
  coordinator.connect(createHooks(events, captured));

  Array.from(transport.assetsReplaced).forEach(listener => listener());
  Array.from(transport.individualCompleted).forEach(listener => listener('hash-a', 10));
  Array.from(transport.individualFailed).forEach(listener => {
    listener('hash-b', 'decoder failed', coreStatus);
  });
  Array.from(transport.folderProgress).forEach(listener => listener(4, 2, progress));
  Array.from(transport.folderCompleted).forEach(listener => listener(4, 2, result));
  Array.from(transport.folderFailed).forEach(listener => listener(5, 3));

  assert.deepEqual(events, [
    'assets-replaced',
    'individual-completed:hash-a:10',
    'individual-failed:hash-b:decoder failed',
    'folder-progress:4:2',
    'folder-completed:4:2',
    'folder-failed:5:3',
  ]);
  assert.equal(captured[0], coreStatus);
  assert.equal(captured[1], progress);
  assert.equal(captured[2], result);
});

test('invalid payloads fail closed and distinguish malformed progress from terminal failure', () => {
  const transport = new FakeThumbnailRegenerationTransport();
  const coordinator = new ThumbnailRegenerationIpcCoordinator(transport);
  const events: string[] = [];
  coordinator.connect(createHooks(events, []));

  Array.from(transport.individualCompleted).forEach(listener => listener('hash-a', undefined));
  Array.from(transport.folderProgress).forEach(listener => listener(4, 2, undefined));
  Array.from(transport.folderCompleted).forEach(listener => listener(5, 3, undefined));

  assert.deepEqual(events, [
    'individual-failed:hash-a:',
    'folder-progress-rejected:4:2',
    'folder-failed:5:3',
  ]);
  assert.equal(transport.cancelFolderCalls, 0);
});

test('outbound operations preserve command and item identity', () => {
  const transport = new FakeThumbnailRegenerationTransport();
  const coordinator = new ThumbnailRegenerationIpcCoordinator(transport);
  const item = { hash: 'hash-a' } as ImageElement;
  const command: FolderThumbnailRegenerationCommand = {
    cataloguePath: '/catalogues/library.scaena',
    eligibleVideos: [item],
    relativePath: 'Cameras',
    requestId: 4,
    sourceIndex: 2,
  };

  coordinator.regenerateIndividual(item);
  coordinator.regenerateFolder(command);
  coordinator.cancelIndividual();
  coordinator.cancelFolder();

  assert.equal(transport.individualItems[0], item);
  assert.equal(transport.folderCommands[0], command);
  assert.equal(transport.cancelIndividualCalls, 1);
  assert.equal(transport.cancelFolderCalls, 1);
});

test('reconnect and disconnect dispose all listeners and fence retained callbacks', () => {
  const transport = new FakeThumbnailRegenerationTransport();
  const coordinator = new ThumbnailRegenerationIpcCoordinator(transport);
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];
  coordinator.connect(createHooks(firstEvents, []));
  const staleAssetsListener = transport.allListeners[0] as AssetsListener;

  coordinator.connect(createHooks(secondEvents, []));
  assert.equal(transport.disposerCalls, 6);
  staleAssetsListener();
  Array.from(transport.assetsReplaced).forEach(listener => listener());
  coordinator.disconnect();
  coordinator.disconnect();
  Array.from(transport.allListeners).forEach(listener => listener());

  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, ['assets-replaced']);
  assert.equal(transport.disposerCalls, 12);
  assert.equal(transport.assetsReplaced.size, 0);
});

test('partial registration and disposer failures still clean every possible listener', () => {
  const registrationTransport = new FakeThumbnailRegenerationTransport();
  registrationTransport.throwOnRegistration = 4;
  const registrationCoordinator = new ThumbnailRegenerationIpcCoordinator(registrationTransport);
  assert.throws(
    () => registrationCoordinator.connect(createHooks([], [])),
    /Listener registration failed/,
  );
  assert.equal(registrationTransport.disposerCalls, 3);
  assert.equal(registrationTransport.assetsReplaced.size, 0);
  assert.equal(registrationTransport.individualCompleted.size, 0);
  assert.equal(registrationTransport.individualFailed.size, 0);

  const disposalTransport = new FakeThumbnailRegenerationTransport();
  disposalTransport.throwOnDisposerAttempt = 2;
  const disposalCoordinator = new ThumbnailRegenerationIpcCoordinator(disposalTransport);
  disposalCoordinator.connect(createHooks([], []));
  assert.throws(() => disposalCoordinator.disconnect(), /Listener disposal failed/);
  assert.equal(disposalTransport.disposerAttempts, 6);
  assert.equal(disposalTransport.disposerCalls, 5);
  assert.equal(disposalTransport.assetsReplaced.size, 0);
  assert.equal(disposalTransport.folderFailed.size, 0);
});

test('wire payload guards accept valid shapes and reject unsafe values', () => {
  assert.equal(isSafeThumbnailHash('hash_A-1'), true);
  assert.equal(isSafeThumbnailHash('../escape'), false);
  assert.equal(isSafeThumbnailHash('x'.repeat(201)), false);
  assert.equal(isThumbnailRegenerationCorrelation(1, 0), true);
  assert.equal(isThumbnailRegenerationCorrelation(0, 0), false);
  assert.equal(isThumbnailRegenerationCorrelation(1, -1), false);
  assert.equal(isThumbnailCoreStatus({ filmstrip: false, thumbnail: true }), true);
  assert.equal(isThumbnailCoreStatus({ filmstrip: false, thumbnail: true, extra: true }), false);
  assert.equal(isFolderThumbnailRegenerationProgress(progress), true);
  assert.equal(isFolderThumbnailRegenerationProgress({ ...progress, completed: 3 }), false);
  assert.equal(isFolderThumbnailRegenerationProgress({ ...progress, screenshotCount: 0 }), false);
  assert.equal(isFolderThumbnailRegenerationResult(result), true);
  assert.equal(isFolderThumbnailRegenerationResult({ ...result, cancelled: 'no' }), false);
  assert.equal(isFolderThumbnailRegenerationResult({ ...result, completed: 3 }), false);
});

test('individual terminals require the exact loaded catalogue session, not only its path', () => {
  const status = {
    catalogueSessionGeneration: 1,
    cancelling: true,
    fileHash: 'hash-a',
    fileName: 'video.mp4',
    hubFile: '/catalogues/same.scaena',
  };

  assert.equal(classifyIndividualThumbnailRegenerationTerminal(
    status,
    'hash-a',
    '/catalogues/same.scaena',
    1,
  ), 'accept');
  assert.equal(classifyIndividualThumbnailRegenerationTerminal(
    status,
    'hash-a',
    '/catalogues/same.scaena',
    2,
  ), 'stale-session');
  assert.equal(classifyIndividualThumbnailRegenerationTerminal(
    status,
    'hash-b',
    '/catalogues/same.scaena',
    1,
  ), 'ignore');
  assert.equal(classifyIndividualThumbnailRegenerationTerminal(
    null,
    'hash-a',
    '/catalogues/same.scaena',
    1,
  ), 'ignore');
});

test('the adapter owns exact channels while Home retains state and presentation effects', () => {
  const adapter = readFileSync(
    join(__dirname, '../src/app/services/thumbnail-regeneration-ipc.service.ts'),
    'utf8',
  );
  const component = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );
  const incomingChannels = [
    'thumbnail-replaced',
    'thumbnail-regeneration-complete',
    'thumbnail-regeneration-failed',
    'folder-thumbnail-regeneration-progress',
    'folder-thumbnail-regeneration-complete',
    'folder-thumbnail-regeneration-failed',
  ];
  const outgoingChannels = [
    'regenerate-thumbnails',
    'regenerate-folder-thumbnails',
    'cancel-thumbnail-regeneration',
    'cancel-folder-thumbnail-regeneration',
  ];

  for (const channel of [...incomingChannels, ...outgoingChannels]) {
    assert.ok(adapter.includes(`'${channel}'`), `Missing adapter channel ${channel}`);
  }
  for (const channel of incomingChannels) {
    assert.equal(
      new RegExp(`ipcRenderer\\.on\\(\\s*'${channel}'`).test(component),
      false,
      `Home still owns incoming channel ${channel}`,
    );
  }
  for (const channel of outgoingChannels) {
    assert.equal(
      new RegExp(`ipcRenderer\\.send\\(\\s*'${channel}'`).test(component),
      false,
      `Home still owns outgoing channel ${channel}`,
    );
  }

  assert.match(component, /this\.thumbnailRegenerationIpc\.connect\(\{/);
  assert.match(component, /individualCompleted:[\s\S]*this\.zone\.run/);
  assert.match(component, /individualFailed:[\s\S]*this\.zone\.run/);
  assert.match(component, /folderProgress:[\s\S]*this\.zone\.run/);
  assert.match(component, /folderProgressRejected:[\s\S]*this\.zone\.run/);
  assert.match(component, /folderCompleted:[\s\S]*this\.zone\.run/);
  assert.match(component, /folderFailed:[\s\S]*this\.zone\.run/);
  assert.match(component, /if \(!this\.clearIndividualThumbnailRegeneration\(fileHash\)\) \{\s*return;/);
  assert.match(component, /classifyIndividualThumbnailRegenerationTerminal\(/);
  assert.match(
    component,
    /final-object-returning[\s\S]*this\.catalogueSessionGeneration \+= 1;[\s\S]*cancelIndividualThumbnailRegenerationForCatalogueLoad\(\);[\s\S]*this\.appState\.currentVhaFile = pathToFile/,
  );
  assert.match(
    component,
    /cancelIndividualThumbnailRegenerationForCatalogueLoad\(\): void \{[\s\S]*cancelling: true,[\s\S]*thumbnailRegenerationIpc\.cancelIndividual\(\);/,
  );
  assert.match(
    component,
    /individualThumbnailRegenerationStatus = \{[\s\S]*catalogueSessionGeneration: this\.catalogueSessionGeneration,[\s\S]*fileHash: item\.hash/,
  );
  const rejectedProgressHandler = component.slice(
    component.indexOf('private handleFolderThumbnailRegenerationProgressRejected('),
    component.indexOf('private handleFolderThumbnailRegenerationComplete('),
  );
  assert.match(rejectedProgressHandler, /folderThumbnailRegenerationSession\.fail\(/);
  assert.ok(
    rejectedProgressHandler.indexOf('if (!accepted)')
      < rejectedProgressHandler.indexOf('thumbnailRegenerationIpc.cancelFolder()'),
  );
  assert.match(component, /this\.thumbnailRegenerationIpc\.regenerateIndividual\(projectedItem\)/);
  assert.match(component, /this\.thumbnailRegenerationIpc\.regenerateFolder\(\{/);
  assert.match(component, /this\.thumbnailRegenerationIpc\.disconnect\(\)/);
  assert.match(
    component,
    /ngOnDestroy\(\): void \{[\s\S]*folderThumbnailRegenerationSession\.clear\(\);[\s\S]*individualThumbnailRegenerationStatus = null;[\s\S]*stopThumbnailRegenerationClockIfIdle\(\)/,
  );
});
