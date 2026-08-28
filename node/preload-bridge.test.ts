import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createTheatrumBridge } from '../interfaces/preload-bridge.ts';

function createDependencies() {
  const sent: [string, unknown[]][] = [];
  const invoked: [string, unknown[]][] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const removed: [string, (...args: any[]) => void][] = [];
  const zoomFactors: number[] = [];

  return {
    dependencies: {
      ipcRenderer: {
        invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
          invoked.push([channel, args]);
          return { channel };
        },
        on: (channel: string, listener: (...args: any[]) => void): void => { listeners.set(channel, listener); },
        removeListener: (channel: string, listener: (...args: any[]) => void): void => {
          removed.push([channel, listener]);
        },
        send: (channel: string, ...args: unknown[]): void => { sent.push([channel, args]); },
      },
      platform: 'darwin',
      webFrame: {
        clearCache: (): void => undefined,
        setZoomFactor: (factor: number): void => { zoomFactors.push(factor); },
      },
      webUtils: { getPathForFile: (): string => '/workspace/chosen-file.jpg' },
    },
    invoked,
    listeners,
    removed,
    sent,
    zoomFactors,
  };
}

test('preload exposes only allowlisted IPC channels and hides Electron event objects', async () => {
  const fixture = createDependencies();
  const bridge = createTheatrumBridge(fixture.dependencies);
  const received: unknown[][] = [];

  bridge.ipc.send('choose-input', 'allowed');
  assert.deepEqual(fixture.sent, [['choose-input', ['allowed']]]);
  assert.deepEqual(await bridge.ipc.invoke('import-catalogue-metadata', { version: 1 }), {
    channel: 'import-catalogue-metadata',
  });
  assert.deepEqual(fixture.invoked, [['import-catalogue-metadata', [{ version: 1 }]]]);

  const dispose = bridge.ipc.on('settings-returning', (...args: unknown[]) => received.push(args));
  fixture.listeners.get('settings-returning')?.({ privilegedEvent: true }, 'saved settings', 'en');
  assert.deepEqual(received, [['saved settings', 'en']]);
  dispose();
  assert.equal(fixture.removed[0][0], 'settings-returning');

  assert.throws(() => bridge.ipc.send('not-an-ipc-channel' as any), /Blocked renderer IPC channel/);
  assert.throws(() => bridge.ipc.on('not-an-ipc-channel' as any, () => undefined), /Blocked renderer IPC channel/);
  assert.throws(() => bridge.ipc.invoke('not-an-ipc-channel' as any), /Blocked renderer IPC channel/);
});

test('preload exposes only bounded utility calls', () => {
  const fixture = createDependencies();
  const bridge = createTheatrumBridge(fixture.dependencies);

  bridge.clipboard.writeText('catalogue hash');
  assert.deepEqual(fixture.sent, [['write-clipboard-text', ['catalogue hash']]]);
  assert.throws(() => bridge.clipboard.writeText('x'.repeat(1024 * 1024 + 1)), /1 MB/);
  assert.equal(bridge.files.getPathForFile({} as File), '/workspace/chosen-file.jpg');
  assert.deepEqual(fixture.sent, [
    ['write-clipboard-text', ['catalogue hash']],
    ['register-user-file-path', ['/workspace/chosen-file.jpg']],
  ]);
  bridge.webFrame.setZoomFactor(1.25);
  assert.deepEqual(fixture.zoomFactors, [1.25]);
  assert.throws(() => bridge.webFrame.setZoomFactor(0.49), /between 0.5 and 3/);
  assert.equal(bridge.platform, 'darwin');
});
