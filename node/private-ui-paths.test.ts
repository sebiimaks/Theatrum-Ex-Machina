import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import type * as UiPaths from './private-ui-paths';
import type * as Protocol from './private-browser-protocol';
import type { PrivateHubSession } from './private-hub-session';

const repository = path.resolve(__dirname, '..');
const resources = path.join(repository, 'tmp', 'private-ui-resources');
const directories = ['private-unlock', 'private-conversion', 'private-gallery'] as const;
const preloads = ['private-password-preload.cjs', 'private-conversion-preload.cjs', 'private-gallery-preload.cjs'] as const;
const names = [...directories, ...preloads];
type Runtime = { versions: { electron?: string }; type?: string; resourcesPath?: unknown; env?: Record<string, string> };

function evaluate<T>(name: string, directory: string, runtime: Runtime, resolve: (name: string) => unknown): T {
  const filename = path.join(__dirname, name + '.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(source, { exports, __dirname: directory, require: resolve, process: runtime,
    Buffer, Uint8Array, URL, Request, Response, Headers, AbortController, AbortSignal, Promise }, { filename });
  return exports as T;
}
function fixture(runtime: Runtime, app: unknown = { isPackaged: true }, directory = path.join(resources, 'app.asar', 'node')) {
  let loads = 0;
  const api = evaluate<typeof UiPaths>('private-ui-paths', directory, runtime, name => {
    if (name === 'electron') { loads++; return { app }; }
    return require(name);
  });
  return { ...api, electronLoads: () => loads };
}
function invalidName(api: typeof UiPaths, name: unknown): void {
  assert.throws(() => api.getPrivateUiPath(name as Parameters<typeof api.getPrivateUiPath>[0]), /Private interface assets are unavailable/);
}

test('Node resolves all fixed development UI directories and preloads without loading Electron', () => {
  const f = fixture({ versions: {} }, undefined, __dirname);
  for (const name of names) { assert.equal(f.getPrivateUiPath(name), path.join(repository, name)); }
  for (const name of directories) { assert.equal(f.resolvePrivateUiDirectory(path.join(repository, name)), path.join(repository, name)); }
  assert.equal(f.electronLoads(), 0);
});

test('unpackaged Electron uses only its module-root UI rather than installation resources', () => {
  const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources }, { isPackaged: false }, __dirname);
  for (const name of names) { assert.equal(f.getPrivateUiPath(name), path.join(repository, name)); }
  assert.equal(f.resolvePrivateUiDirectory(path.join(repository, 'private-gallery')), path.join(repository, 'private-gallery'));
});

test('packaged Electron maps its exact current archive to its physical companion for every known UI asset', () => {
  for (const archiveName of ['app.asar', 'payload.asar', 'APP.ASAR']) {
    const archive = path.join(resources, archiveName);
    const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources,
      env: { PRIVATE_UI_ROOT: path.join(repository, 'tmp', 'untrusted'), PATH: repository } }, { isPackaged: true }, path.join(archive, 'node'));
    for (const name of names) { assert.equal(f.getPrivateUiPath(name), path.join(archive + '.unpacked', name)); }
    for (const name of directories) {
      assert.equal(f.resolvePrivateUiDirectory(path.join(archive, name)), path.join(archive + '.unpacked', name));
    }
  }
});

test('unknown names and arbitrary paths fail before consulting Electron', () => {
  const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources });
  for (const name of ['', '..', '../private-gallery', 'private-gallery/index.html', 'private-unlock/',
    'private-gallery-preload.cjs\0', 'preload.js', path.join(repository, 'private-gallery'), undefined, null, 17]) { invalidName(f, name); }
  assert.equal(f.electronLoads(), 0);
});

test('foreign archives, unknown archived directories, traversal and alternate spellings are never generically unpacked', () => {
  const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources });
  for (const directory of [path.join(resources, 'foreign.asar', 'private-gallery'), path.join(resources, 'app.asar', 'unknown'),
    path.join(resources, 'app.asar', 'private-gallery', 'nested'), path.join(resources, 'APP.ASAR', 'private-gallery'),
    path.join(resources, 'app.asar', 'private-gallery') + '/', path.join(resources, 'app.asar') + '/folder/../private-gallery']) {
    assert.throws(() => f.resolvePrivateUiDirectory(directory), /Private interface assets are unavailable/);
  }
});

test('explicit physical fixture directories remain unchanged without inventing an archive mapping', () => {
  const f = fixture({ versions: {} }, undefined, __dirname);
  const physical = path.join(repository, 'tmp', 'synthetic-ui');
  assert.equal(f.resolvePrivateUiDirectory(physical), physical);
  assert.equal(f.resolvePrivateUiDirectory(path.join(resources, 'app.asar.unpacked', 'private-gallery')),
    path.join(resources, 'app.asar.unpacked', 'private-gallery'));
});

test('renderer, utility and incomplete Electron-shaped runtimes cannot select known UI assets', () => {
  for (const runtime of [
    { versions: { electron: '42.11.1' }, type: 'renderer', resourcesPath: resources },
    { versions: { electron: '42.11.1' }, type: 'utility', resourcesPath: resources },
    { versions: { electron: '42.11.1' }, resourcesPath: resources },
    { versions: {}, type: 'browser' }, { versions: {}, resourcesPath: resources },
  ]) {
    const f = fixture(runtime, undefined, __dirname);
    invalidName(f, 'private-gallery');
    assert.throws(() => f.resolvePrivateUiDirectory(path.join(repository, 'private-gallery')), /Private interface assets are unavailable/);
    assert.equal(f.electronLoads(), 0);
  }
});

test('missing, malformed or noncanonical resources roots cannot be used for packaged UI', () => {
  for (const resourcesPath of [undefined, null, 3, '', 'resources', resources + path.sep, resources + '\0',
    resources + '/part/..', path.join(resources, 'app.asar'), path.join(repository, 'other-resources')]) {
    const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath });
    invalidName(f, 'private-gallery-preload.cjs');
  }
});

test('packaged application identity must be present and strictly boolean', () => {
  for (const app of [null, {}, { isPackaged: 'true' }, { isPackaged: 1 }]) {
    const f = fixture({ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources }, app);
    invalidName(f, 'private-password-preload.cjs');
  }
  const api = evaluate<typeof UiPaths>('private-ui-paths', path.join(resources, 'app.asar', 'node'),
    { versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources }, name => {
      if (name === 'electron') { throw new Error('Missing app capability'); }
      return require(name);
    });
  assert.throws(() => api.getPrivateUiPath('private-conversion'));
});

test('wrongly packaged, wrongly unpackaged, ordinary Node archive and nested archive roots fail closed', () => {
  for (const [runtime, app, directory] of [
    [{ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources }, { isPackaged: true }, __dirname],
    [{ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: resources }, { isPackaged: false }, path.join(resources, 'app.asar', 'node')],
    [{ versions: {} }, undefined, path.join(resources, 'app.asar', 'node')],
    [{ versions: {} }, undefined, path.join(resources, 'outer.asar', 'nested', 'node')],
    [{ versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: path.join(resources, 'outer.asar') },
      { isPackaged: true }, path.join(resources, 'outer.asar', 'app.asar', 'node')],
  ] as [Runtime, unknown, string][]) {
    const f = fixture(runtime, app, directory);
    invalidName(f, 'private-conversion-preload.cjs');
  }
});

async function packagedProtocol(t: TestContext) {
  const temporary = path.join(repository, 'tmp');
  await fs.promises.mkdir(temporary, { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(temporary, 'private-ui-protocol-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const packagedResources = path.join(root, 'Resources');
  const archive = path.join(packagedResources, 'app.asar');
  const unpacked = archive + '.unpacked';
  const runtime = { versions: { electron: '42.11.1' }, type: 'browser', resourcesPath: packagedResources };
  const directory = path.join(archive, 'node');
  const ui = fixture(runtime, { isPackaged: true }, directory);
  const api = evaluate<typeof Protocol>('private-browser-protocol', directory, runtime,
    name => name === './private-ui-paths' ? ui : require(name));
  for (const [name, script, style] of [
    ['private-unlock', 'unlock.js', 'unlock.css'], ['private-conversion', 'conversion.js', 'conversion.css'], ['private-gallery', 'gallery.js', 'gallery.css'],
  ]) {
    await fs.promises.mkdir(path.join(unpacked, name), { recursive: true });
    await fs.promises.mkdir(path.join(archive, name), { recursive: true });
    for (const asset of ['index.html', script, style]) {
      await fs.promises.writeFile(path.join(unpacked, name, asset), 'PHYSICAL-PRIVATE-UI-' + asset);
      // A tempting fallback under an archive-shaped root must never be read.
      await fs.promises.writeFile(path.join(archive, name, asset), 'PACKED-FALLBACK-MUST-NOT-BE-READ');
    }
  }
  const hub = { isCurrent: generation => generation === 7, createPreviewResponse: async () => { throw new Error('No media in static fixture'); } } as unknown as PrivateHubSession;
  const factories = [
    { directory: 'private-unlock', script: 'unlock.js', make: () => api.createPrivateUnlockProtocolHandler({ appDirectory: path.join(archive, 'private-unlock'), isCurrent: () => true }) },
    { directory: 'private-conversion', script: 'conversion.js', make: () => api.createPrivateConversionProtocolHandler({ appDirectory: path.join(archive, 'private-conversion'), isCurrent: () => true }) },
    { directory: 'private-gallery', script: 'gallery.js', make: () => api.createPrivateBrowserProtocolHandler({ appDirectory: path.join(archive, 'private-gallery'), isCurrent: () => true, hub, generation: 7 }) },
  ];
  return { root, archive, unpacked, factories };
}
function request(route = 'index.html', method = 'GET'): Request { return new Request('theatrum://app/' + route, { method }); }

test('real packaged protocols read physical UI bytes and retain authenticated HEAD, CSP and no-store responses', async t => {
  const f = await packagedProtocol(t);
  for (const factory of f.factories) {
    const handler = factory.make();
    for (const asset of ['index.html', factory.script]) {
      const response = await handler(request(asset));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'PHYSICAL-PRIVATE-UI-' + asset);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
      assert.ok(response.headers.get('Content-Security-Policy')?.includes("default-src 'none'"));
      const head = await handler(request(asset, 'HEAD'));
      assert.equal(head.status, 200); assert.equal(head.body, null);
      assert.equal(head.headers.get('Content-Length'), String(Buffer.byteLength('PHYSICAL-PRIVATE-UI-' + asset)));
    }
  }
});

test('missing physical packaged UI never reads an available archive-shaped fallback', async t => {
  const f = await packagedProtocol(t);
  const open = fs.promises.open.bind(fs.promises);
  const opened: string[] = [];
  t.mock.method(fs.promises, 'open', (...args: Parameters<typeof fs.promises.open>) => {
    opened.push(String(args[0])); return open(...args);
  });
  for (const factory of f.factories) {
    await fs.promises.rename(path.join(f.unpacked, factory.directory), path.join(f.root, factory.directory));
    const response = await factory.make()(request());
    assert.equal(response.status, 404); assert.equal(await response.text(), '');
  }
  assert.deepEqual(opened, []);
});

test('mapped physical UI retains symlink, hardlink and symlink-root refusal', async t => {
  const f = await packagedProtocol(t);
  const factory = f.factories[0];
  const app = path.join(f.unpacked, factory.directory);
  const file = path.join(app, 'index.html');
  const target = path.join(f.root, 'other.html');
  await fs.promises.writeFile(target, 'DO-NOT-EXPOSE');
  const handler = factory.make();
  await fs.promises.unlink(file); await fs.promises.symlink(target, file);
  assert.equal((await handler(request())).status, 404);
  await fs.promises.unlink(file); await fs.promises.link(target, file);
  assert.equal((await handler(request())).status, 404);
  const original = path.join(f.root, 'original-ui');
  await fs.promises.rename(app, original); await fs.promises.symlink(original, app);
  assert.equal((await factory.make()(request())).status, 404);
});

test('replacing a captured unpacked application directory invalidates its existing protocol', async t => {
  const f = await packagedProtocol(t);
  for (const factory of f.factories) {
    const app = path.join(f.unpacked, factory.directory);
    const handler = factory.make();
    await fs.promises.rename(app, path.join(f.root, factory.directory));
    await fs.promises.mkdir(app); await fs.promises.writeFile(path.join(app, 'index.html'), 'REPLACEMENT-MUST-NOT-BE-EXPOSED');
    const response = await handler(request());
    assert.equal(response.status, 404); assert.equal(await response.text(), '');
  }
});

test('a file replaced between physical lstat and open is still refused by descriptor identity', async t => {
  const f = await packagedProtocol(t);
  const factory = f.factories[0];
  const file = path.join(f.unpacked, factory.directory, 'index.html');
  const open = fs.promises.open.bind(fs.promises);
  let replacements = 0;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    if (args[0] === file) {
      replacements++;
      await fs.promises.rename(file, path.join(f.root, 'before-open.html'));
      await fs.promises.writeFile(file, 'SWAPPED-FILE-MUST-NOT-BE-EXPOSED');
    }
    return open(...args);
  });
  const response = await factory.make()(request());
  assert.equal(replacements, 1); assert.equal(response.status, 404); assert.equal(await response.text(), '');
});
