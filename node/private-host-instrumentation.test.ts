import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext, Script } from 'node:vm';

const { compilePrivateHost, instrumentPrivateHostSource } = require('./private-host-instrumentation.cjs');
const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const actual = fs.readFileSync(path.join(repository, 'main.ts'), 'utf8');
const paths = { assets: path.join(repository, 'tmp', 'synthetic-assets'), preload: path.join(repository, 'tmp', 'synthetic-preload.cjs') };
const gate = "const PRIVATE_HUB_UI_READY = process.platform === 'darwin';";

function minimalSource(): string {
  return `
    ${gate}
    const win = { identity: 'original window' };
    const privateApplicationWorkspace = { identity: 'original workspace' };
    const sourceFolderConnections = { identity: 'original sources' };
    const rendererStartupComplete = true;
    const catalogueOpenQueue = { identity: 'original queue' };
    const preferences = { preload: path.join(__dirname, 'preload.js') };
    registerTheatrumProtocols(path.join(__dirname, 'dist'), false);
    function openPrivateHubFromNative() { return PRIVATE_HUB_UI_READY; }
    function createPrivateCopyFromNative() { return PRIVATE_HUB_UI_READY; }
    createPrivateHubMenu({ open: openPrivateHubFromNative, create: createPrivateCopyFromNative });
    function requestCatalogueOpenFromSystem(value) { return value; }
  `;
}

test('actual main instrumentation retains production platform admission, native registration and private assets', () => {
  const compiled = instrumentPrivateHostSource(actual, paths);
  assert.ok(actual.includes(gate));
  assert.ok(compiled.includes(gate));
  assert.match(compiled, /open: openPrivateHubFromNative/);
  assert.match(compiled, /create: createPrivateCopyFromNative/);
  assert.ok(compiled.includes(JSON.stringify(paths.assets)));
  assert.ok(compiled.includes(JSON.stringify(paths.preload)));
  assert.ok(compiled.includes("path.join(__dirname, 'private-gallery')"));
  assert.ok(compiled.includes('require("./node/private-application-workspace")'));
  assert.equal(fs.readFileSync(path.join(repository, 'main.ts'), 'utf8'), actual);
});

test('acceptance driver uses the original host identities and exposes no writable selector', () => {
  const exports: { __privateHostAcceptance?: {
    openPrivateHubFromNative(): boolean;
    createPrivateCopyFromNative(): boolean;
    requestCatalogueOpenFromSystem(value: string): string;
    readonly window: { identity: string };
    readonly workspace: { identity: string };
    readonly sources: { identity: string };
    readonly queue: { identity: string };
    readonly ready: boolean;
  } } = {};
  const roots: unknown[][] = [];
  let nativeMenu: { open: () => boolean; create: () => boolean } | undefined;
  runInNewContext(instrumentPrivateHostSource(minimalSource(), paths), {
    exports, registerTheatrumProtocols: (...args: unknown[]) => roots.push(args),
    process: { platform: 'darwin' }, createPrivateHubMenu: (options: typeof nativeMenu) => { nativeMenu = options; },
  });
  const driver = exports.__privateHostAcceptance;
  assert.ok(driver);
  assert.equal(Object.isFrozen(driver), true);
  assert.deepEqual(Object.keys(driver).sort(), ['createPrivateCopyFromNative', 'openPrivateHubFromNative', 'queue', 'ready', 'requestCatalogueOpenFromSystem', 'sources', 'window', 'workspace']);
  assert.equal(driver.openPrivateHubFromNative(), true);
  assert.equal(driver.createPrivateCopyFromNative(), true);
  assert.equal(nativeMenu?.open, driver.openPrivateHubFromNative);
  assert.equal(nativeMenu?.create, driver.createPrivateCopyFromNative);
  assert.equal(driver.requestCatalogueOpenFromSystem('synthetic.scaena'), 'synthetic.scaena');
  assert.equal(driver.window.identity, 'original window');
  assert.equal(driver.workspace.identity, 'original workspace');
  assert.equal(driver.sources.identity, 'original sources');
  assert.equal(driver.queue.identity, 'original queue');
  assert.equal(driver.ready, true);
  assert.equal(Object.getOwnPropertyDescriptor(driver, 'window')?.set, undefined);
  assert.deepEqual(roots, [[paths.assets, false]]);
});

test('unconditional, mutable, differently computed, missing or duplicate production admission is refused', () => {
  for (const changed of [
    actual.replace(gate, 'const PRIVATE_HUB_UI_READY = true;'),
    actual.replace(gate, "let PRIVATE_HUB_UI_READY = process.platform === 'darwin';"),
    actual.replace(gate, "const PRIVATE_HUB_UI_READY = process.platform !== 'win32';"),
    actual.replace(gate, "const PRIVATE_HUB_UI_READY = process.platform === 'linux';"),
    actual.replace(gate, ''),
    actual + '\n' + gate + '\n',
  ]) { assert.throws(() => instrumentPrivateHostSource(changed, paths), /readiness/); }
});

test('instrumentation does not enable private admission on another platform', () => {
  const exports: { __privateHostAcceptance?: { openPrivateHubFromNative: () => boolean } } = {};
  runInNewContext(instrumentPrivateHostSource(minimalSource(), paths), {
    exports, process: { platform: 'linux' }, createPrivateHubMenu: () => undefined, registerTheatrumProtocols: () => undefined,
  });
  assert.equal(exports.__privateHostAcceptance?.openPrivateHubFromNative(), false);
});

test('extra native entry use, renaming or a pre-existing acceptance export is refused', () => {
  for (const changed of [
    actual + '\nmenu.push({ click: openPrivateHubFromNative });\n',
    actual + '\nopenPrivateHubFromNative();\n',
    actual.replace('function openPrivateHubFromNative', 'function renamedPrivateEntry'),
    actual + '\nexports.__privateHostAcceptance = {};\n',
  ]) { assert.throws(() => instrumentPrivateHostSource(changed, paths), /private entry|acceptance driver/); }
});

test('native callbacks must belong to the same exact menu registration', () => {
  const source = minimalSource();
  for (const changed of [
    source.replace('open: openPrivateHubFromNative', 'click: openPrivateHubFromNative'),
    source.replace('createPrivateHubMenu({', 'otherMenu({'),
    source.replace('createPrivateHubMenu({ open: openPrivateHubFromNative, create: createPrivateCopyFromNative });',
      'createPrivateHubMenu({ open: openPrivateHubFromNative }); createPrivateHubMenu({ create: createPrivateCopyFromNative });'),
  ]) { assert.throws(() => instrumentPrivateHostSource(changed, paths), /native callback|native menu builder|share one menu/); }
});

test('changed, duplicated or relocated preload and protocol expressions fail closed', () => {
  for (const changed of [
    actual.replace("path.join(__dirname, 'preload.js')", "path.resolve(__dirname, 'preload.js')"),
    actual.replace("preload: path.join(__dirname, 'preload.js')", "other: path.join(__dirname, 'preload.js')"),
    actual + "\nconst duplicate = path.join(__dirname, 'preload.js');\n",
    actual.replace("path.join(__dirname, 'dist')", "path.join(__dirname, 'other')"),
    actual.replace("registerTheatrumProtocols(path.join(__dirname, 'dist'), serve)", "otherHandler(path.join(__dirname, 'dist'), serve)"),
    actual + "\nconst duplicate = path.join(__dirname, 'dist');\n",
  ]) { assert.throws(() => instrumentPrivateHostSource(changed, paths), /preload|asset/); }
});

test('malformed TypeScript is rejected before generating a driver', () => {
  assert.throws(() => instrumentPrivateHostSource(actual + '\nconst broken = ;', paths), /parse successfully/);
});

test('compiler accepts only canonical owned fixture assets/preload and writes no production source', t => {
  const temporary = path.join(repository, 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(temporary, 'host-instrumentation-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const assets = path.join(fixture, 'assets');
  const preload = path.join(fixture, 'preload.cjs');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'index.html'), '<!doctype html>');
  fs.writeFileSync(preload, '/* production-preload fixture */');
  const before = fs.readFileSync(path.join(repository, 'main.ts'), 'utf8');
  const compiled = compilePrivateHost({ repository, assets, preload });
  assert.doesNotThrow(() => new Script(compiled));
  assert.equal(fs.readFileSync(path.join(repository, 'main.ts'), 'utf8'), before);
  assert.throws(() => compilePrivateHost({ repository: '/unowned-repository', assets, preload }), /owned root/);
  assert.throws(() => compilePrivateHost({ repository, assets: repository, preload }), /owned root/);
  assert.throws(() => compilePrivateHost({ repository, assets, preload: path.join(repository, 'preload.ts') }), /owned root/);
  const linkedPreload = path.join(fixture, 'linked-preload.cjs');
  fs.symlinkSync(preload, linkedPreload);
  assert.throws(() => compilePrivateHost({ repository, assets, preload: linkedPreload }), /file type/);
  const linkedAssets = path.join(fixture, 'linked-assets');
  fs.symlinkSync(assets, linkedAssets);
  assert.throws(() => compilePrivateHost({ repository, assets: linkedAssets, preload }), /file type/);
});


test('a missing or additionally registered conversion action is refused by acceptance instrumentation', () => {
  assert.throws(() => instrumentPrivateHostSource(actual + '\ncreatePrivateCopyFromNative();', paths), /conversion entry/);
  assert.throws(() => instrumentPrivateHostSource(actual.replace('function createPrivateCopyFromNative()', 'function renamedCreationAction()'), paths), /conversion entry/);
});
