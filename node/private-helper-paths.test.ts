import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { getPrivateHelperPath } from './private-helper-paths';
import type * as Helpers from './private-helper-paths';
import type * as Lease from './private-hub-lock';
import type * as TouchId from './private-touch-id';

const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'tmp', 'packaged-privacy-resources');
const helperNames = ['private-hub-lock', 'private-touch-id.node'] as const;
type Runtime = { versions: { electron?: string }; type?: string; resourcesPath?: unknown; env?: Record<string, string> };

/** Evaluate the real module under a controlled native runtime; do not change this Node process. */
function evaluateModule<T>(name: string, runtime: Runtime, resolve: (name: string) => unknown, directory = __dirname): T {
  const filename = path.join(__dirname, name + '.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(source, { exports, require: resolve, __dirname: directory,
    process: { platform: process.platform, geteuid: process.geteuid, ...runtime },
    Buffer, AbortController, AbortSignal, Promise, setTimeout, clearTimeout }, { filename });
  return exports as T;
}

function fixture(runtime: Runtime, app: unknown = { isPackaged: true }, directory = __dirname) {
  let electronLoads = 0;
  const helpers = evaluateModule<typeof Helpers>('private-helper-paths', runtime, name => {
    if (name === 'electron') { electronLoads++; return { app }; }
    return require(name);
  }, directory);
  return { ...helpers, electronLoads: () => electronLoads };
}

test('ordinary Node resolves only the two development helpers without loading Electron', () => {
  const f = fixture({ versions: {} });
  for (const helper of helperNames) {
    const expected = path.join(root, 'build', 'privacy-tools', helper);
    assert.equal(f.getPrivateHelperPath(helper), expected);
    assert.equal(getPrivateHelperPath(helper), expected);
  }
  assert.equal(f.electronLoads(), 0);
});

test('unpackaged main Electron uses development helpers rather than its installation resources', () => {
  const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources }, { isPackaged: false });
  for (const helper of helperNames) {
    assert.equal(f.getPrivateHelperPath(helper), path.join(root, 'build', 'privacy-tools', helper));
  }
});

test('packaged main Electron resolves outside app.asar with no environment override', () => {
  const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources,
    env: { PATH: path.join(root, 'tmp'), VIDEO_HUB_APP_SIN_MEDIA_TOOLS: path.join(root, 'tmp', 'untrusted') } },
  { isPackaged: true }, path.join(resources, 'app.asar', 'node'));
  for (const helper of helperNames) {
    assert.equal(f.getPrivateHelperPath(helper), path.join(resources, 'privacy-tools', helper));
  }
});

test('unknown helpers and arbitrary paths fail before loading Electron', () => {
  const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources });
  for (const helper of ['', '../private-hub-lock', 'private-hub-lock/other', path.join(root, 'private-hub-lock'),
    'ffmpeg', 'private-touch-id.node\0', null, undefined, 7]) {
    assert.throws(() => f.getPrivateHelperPath(helper as Helpers.PrivateHelperName), /Private native support is unavailable/);
  }
  assert.equal(f.electronLoads(), 0);
});

test('renderer, utility and incomplete Electron runtimes never fall back to development', () => {
  for (const runtime of [
    { versions: { electron: '42.11.1' }, type: 'renderer', resourcesPath: resources },
    { versions: { electron: '42.11.1' }, type: 'utility', resourcesPath: resources },
    { versions: { electron: '42.11.1' }, resourcesPath: resources },
    { versions: {}, type: 'browser' }, { versions: {}, resourcesPath: resources },
  ]) {
    const f = fixture(runtime);
    assert.throws(() => f.getPrivateHelperPath('private-hub-lock'), /Private native support is unavailable/);
    assert.equal(f.electronLoads(), 0);
  }
});

test('missing packaged roots and paths inside ASAR fail closed', () => {
  for (const resourcesPath of [undefined, null, 7, '', 'privacy-tools', resources + path.sep,
    path.join(resources, 'app.asar'), path.join(resources, 'APP.ASAR', 'nested'), resources + '\0',
    resources + '/folder/../other']) {
    const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath });
    assert.throws(() => f.getPrivateHelperPath('private-hub-lock'), /Private native support is unavailable/);
  }
  const wronglyUnpackaged = fixture({ versions: { electron: '42.11.1' }, type: 'browser' },
    { isPackaged: false }, path.join(resources, 'app.asar', 'node'));
  assert.throws(() => wronglyUnpackaged.getPrivateHelperPath('private-hub-lock'), /Private native support is unavailable/);
});

test('missing or malformed main-app capability cannot select development binaries', () => {
  for (const app of [null, {}, { isPackaged: 1 }, { isPackaged: 'false' }]) {
    const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources }, app);
    assert.throws(() => f.getPrivateHelperPath('private-hub-lock'), /Private native support is unavailable/);
  }
  const helpers = evaluateModule<typeof Helpers>('private-helper-paths',
    { versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources }, name => {
      if (name === 'electron') { throw new Error('Native application capability unavailable'); }
      return require(name);
    });
  assert.throws(() => helpers.getPrivateHelperPath('private-hub-lock'));
});

test('the packaged lease passes the resources helper path to spawn and retains working native locking', async t => {
  const directory = await fs.promises.mkdtemp(path.join(root, 'tmp', 'private-helper-path-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const runtime = { versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources };
  const helpers = fixture(runtime);
  const leaseModule = evaluateModule<typeof Lease>('private-hub-lock', runtime,
    name => name === './private-helper-paths' ? helpers : require(name));
  const originalSpawn = childProcess.spawn;
  let spawns = 0;
  t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, path.join(resources, 'privacy-tools', 'private-hub-lock'));
    spawns++;
    // This fixture tests packaged routing with the existing development binary;
    // it neither builds nor executes a packaged application.
    return originalSpawn(getPrivateHelperPath('private-hub-lock'), args, options);
  });
  const lease = await leaseModule.PrivateHubLease.acquire(directory);
  try { await lease.assertOwned(); assert.equal(spawns, 1); }
  finally { await lease.release(); }
});

test('the packaged Touch ID provider requires only its resources addon and does not fall back when missing', async () => {
  for (const available of [true, false]) {
    const runtime = { versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources };
    const helpers = fixture(runtime);
    const loads: string[] = [];
    const touchId = evaluateModule<typeof TouchId>('private-touch-id', runtime, name => {
      if (name === './private-helper-paths') { return helpers; }
      loads.push(name);
      assert.equal(name, path.join(resources, 'privacy-tools', 'private-touch-id.node'));
      if (!available) { throw new Error('Missing native addon'); }
      return { begin: () => ({ operation: 1, result: Promise.resolve({ status: 'available' }) }),
        cancel: () => undefined, finishEnrollment: () => Promise.resolve({ status: 'unavailable' }) };
    });
    const provider = touchId.createPrivateTouchIdProvider({ platform: 'darwin' });
    assert.equal(await provider.availability(), available ? 'available' : 'unavailable');
    assert.equal(loads.length, 1);
  }
});
