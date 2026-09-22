import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { isCataloguePickerFilePath } from '../interfaces/catalogue-file';
import { CatalogueOpenQueue } from './catalogue-open-queue';
import { NormalApplicationPause } from './normal-application-pause';
import { NormalOperationScope } from './normal-operation-scope';
import { normalizeAbsolutePath } from './local-operation-safety';

const root = path.resolve(__dirname, '..');
const source = readFileSync(path.join(root, 'main.ts'), 'utf8');
const syntax = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const functions = new Set(['openPrivateHubFromNative', 'resumeNormalAfterPrivateHub',
  'acknowledgePrivateQuitCancelled', 'getAngularToShutDown', 'requestCatalogueOpenFromSystem',
  'dispatchNextCatalogueOpenRequest', 'sourceConnectionSessionIsCurrent', 'beginCatalogueOpenOperation']);
const variables = new Set(['privateApplicationWorkspace', 'normalApplicationPause', 'PRIVATE_HUB_UI_READY', 'normalPrivateResumePending']);
const selected = syntax.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) ? functions.has(statement.name?.text || '')
    : ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && variables.has(declaration.name.text)));
assert.equal(selected.length, functions.size + variables.size);
const sourceConnectionDeclaration = syntax.statements.flatMap(statement => (
  ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []
)).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'sourceFolderConnections');
assert.ok(sourceConnectionDeclaration && ts.isNewExpression(sourceConnectionDeclaration.initializer));
const sourceConnectionOptions = sourceConnectionDeclaration.initializer.arguments?.[0];
assert.ok(sourceConnectionOptions && ts.isObjectLiteralExpression(sourceConnectionOptions));
const captureSession = sourceConnectionOptions.properties.find(property => (
  ts.isPropertyAssignment(property) && property.name.getText(syntax) === 'captureSession'
));
assert.ok(captureSession && ts.isPropertyAssignment(captureSession));
const compiled = ts.transpileModule([
  ...selected.map(statement => statement.getText(syntax).replace(/^export /, '')),
  `const captureSourceSession = ${captureSession.initializer.getText(syntax)};`,
].join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  const operations = new NormalOperationScope();
  const messages: unknown[][] = [];
  const authorities: string[] = [];
  const pending: string[] = [];
  const queue = new CatalogueOpenQueue();
  const sender = { id: 7, send: (...values: unknown[]) => { messages.push(values); }, isDestroyed: () => false };
  const globals = {
    angularApp: { sender }, catalogueStorage: { kind: 'normal' }, readyToQuit: false,
    catalogueTransitionActive: false, cataloguePersistenceActive: false,
    catalogueSessionGeneration: 7, currentlyOpenVhaFile: path.join(root, 'tmp', 'current.scaena'),
    selectedSourceFolders: { 0: { path: path.join(root, 'tmp', 'source'), watch: true } },
    pendingInputDirectorySelections: new Set(), pendingOutputDirectorySelections: new Set(), pendingUserFileSelections: new Set(),
  };
  let resolveSettled: () => void = () => undefined;
  let afterIdle = Promise.resolve();
  let quitRequests = 0;
  let opens = 0;
  let acknowledged = false;
  let refreshes = 0;
  let factoryOptions: any;
  const workspace = {
    isActive: false, status: { quitRequested: false, cleanupFailed: false },
    get settled() { return afterIdle; },
    open: () => {
      opens++;
      workspace.isActive = true;
      afterIdle = new Promise<void>(resolve => { resolveSettled = resolve; });
      return Promise.resolve('opened');
    },
    requestQuit: () => { quitRequests++; workspace.status.quitRequested = true; return Promise.resolve(); },
    acknowledgeQuitCancelled: () => {
      if (!acknowledged || workspace.isActive) { return false; }
      workspace.status.quitRequested = false;
      acknowledged = false;
      return true;
    },
  };
  const context: any = {
    exports: {}, path, __dirname: root, Promise, console: { warn: () => undefined },
    GLOBALS: globals, normalOperationScope: operations, NormalApplicationPause,
    rendererStartupComplete: true, rendererCanReceiveCatalogueOpenRequests: true, catalogueOpenOperationActive: false,
    activeCatalogueOpenGeneration: undefined,
    catalogueOpenQueue: queue, deferredNormalCatalogueOpens: pending, MAX_DEFERRED_NORMAL_OPENS: 128,
    createPrivateApplicationWorkspace: (options: unknown) => { factoryOptions = options; return workspace; },
    isAllowedRendererUrl: () => true,
    isCataloguePickerFilePath,
    normalizeAbsolutePath,
    rememberCataloguePath: (value: string) => { authorities.push(value); return value; },
    sourceFolderConnections: {
      pauseAndDrain: async () => undefined, resume: () => undefined,
      refresh: async () => { assert.equal(operations.isCurrent(), true); assert.equal(operations.inOperation, true); refreshes++; },
    },
    beginNormalMediaDrain: async () => undefined, resetAllQueues: () => undefined,
    win: { webContents: sender, isDestroyed: () => false, isVisible: () => true },
  };
  runInNewContext(compiled + '\nglobalThis.host = { openPrivateHubFromNative, resumeNormalAfterPrivateHub, acknowledgePrivateQuitCancelled, getAngularToShutDown, requestCatalogueOpenFromSystem, dispatchNextCatalogueOpenRequest, normalApplicationPause, captureSourceSession, sourceConnectionSessionIsCurrent, beginCatalogueOpenOperation };', context);
  return { context, host: context.host, operations, globals, workspace, queue, messages, authorities, pending,
    factoryOptions: () => factoryOptions, opens: () => opens, quits: () => quitRequests, refreshes: () => refreshes,
    allowAcknowledgement: () => { acknowledged = true; },
    settle: (paused = true) => {
      workspace.isActive = false;
      if (paused && !workspace.status.cleanupFailed) { factoryOptions.afterResume(); }
      resolveSettled();
    },
  };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const catalogue = (name: string) => path.join(root, 'tmp', `${name}.scaena`);

test('host installs one dormant factory with a closed readiness gate and no normal IPC opening action', () => {
  const f = fixture();
  assert.equal(f.factoryOptions().canStart(), false);
  assert.equal(f.factoryOptions().getNormalWindow(), f.context.win);
  assert.equal(f.factoryOptions().appDirectory, path.join(root, 'private-gallery'));
  assert.equal(f.opens(), 0);
  assert.doesNotMatch(source, /trustedIpcOn\(['"](?:open-private-hub|private-open)/);
});

test('private close and quit take priority over ordinary shutdown, including a ready-to-quit flag', () => {
  const f = fixture();
  f.workspace.isActive = true;
  f.globals.readyToQuit = true;
  assert.equal(f.host.getAngularToShutDown(), true);
  assert.equal(f.quits(), 1);
  assert.deepEqual(f.messages, []);
});

test('ordinary close still requests its existing save handshake and handles absent renderer startup', () => {
  const f = fixture();
  assert.equal(f.host.getAngularToShutDown(), true);
  assert.deepEqual(f.messages, [['please-shut-down-ASAP']]);
  f.context.win = null;
  assert.equal(f.host.getAngularToShutDown(), false);
  assert.equal(f.globals.readyToQuit, true);
});

test('private opening cannot run inside active or expired ordinary asynchronous work', async () => {
  const f = fixture();
  let delayed!: Promise<unknown>;
  await f.operations.run(async () => {
    assert.equal(await f.host.openPrivateHubFromNative(), 'unavailable');
    delayed = new Promise(resolve => setImmediate(() => { resolve(f.host.openPrivateHubFromNative()); }));
  });
  assert.equal(await delayed, 'unavailable');
  assert.equal(f.opens(), 0);
});

test('native opens during private use acquire no authority and replay FIFO only after clean settlement', async () => {
  const f = fixture();
  await f.host.openPrivateHubFromNative();
  f.host.requestCatalogueOpenFromSystem(catalogue('one'));
  f.host.requestCatalogueOpenFromSystem(catalogue('two'));
  f.host.requestCatalogueOpenFromSystem(catalogue('one'));
  f.host.dispatchNextCatalogueOpenRequest();
  assert.deepEqual(f.authorities, []);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.pending, [catalogue('one'), catalogue('two')]);
  f.settle(); await turn();
  assert.deepEqual(f.authorities, [catalogue('one'), catalogue('two')]);
  assert.deepEqual(f.messages, [['normal-workspace-resumed'], ['open-catalogue-from-system', catalogue('one')]]);
  assert.equal(f.refreshes(), 0, 'A queued catalogue switch must not prompt for the previous hub\'s source folders.');
  f.queue.acknowledge(); f.host.dispatchNextCatalogueOpenRequest();
  assert.deepEqual(f.messages.at(-1), ['open-catalogue-from-system', catalogue('two')]);
});

test('queued OS requests are bounded, deduplicated and never persist malformed/private-directory paths', () => {
  const f = fixture(); f.workspace.isActive = true;
  for (const value of [null, {}, '', 'relative.scaena', root, catalogue('bad') + '\0', '/' + 'x'.repeat(4100) + '.scaena']) {
    f.host.requestCatalogueOpenFromSystem(value);
  }
  assert.deepEqual(f.pending, []);
  for (let index = 0; index < 130; index++) { f.host.requestCatalogueOpenFromSystem(catalogue(`queued-${index}`)); }
  assert.equal(f.pending.length, 128);
  assert.deepEqual(f.authorities, []);
});

test('failed private cleanup and quit handback never refresh sources or open pending catalogues', async () => {
  for (const failure of ['cleanupFailed', 'quitRequested'] as const) {
    const f = fixture();
    await f.host.openPrivateHubFromNative();
    f.host.requestCatalogueOpenFromSystem(catalogue('retained'));
    f.workspace.status[failure] = true;
    f.settle(); await turn();
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.authorities, []);
    assert.equal(f.pending.length, 1);
    assert.equal(f.refreshes(), 0);
  }
});

test('only a proven cancelled private quit resumes queued work in a fresh ordinary scope', async () => {
  const f = fixture(); f.workspace.status.quitRequested = true;
  f.factoryOptions().afterResume();
  f.host.acknowledgePrivateQuitCancelled(); await turn();
  assert.equal(f.refreshes(), 0);
  f.allowAcknowledgement();
  await f.operations.run(() => f.host.acknowledgePrivateQuitCancelled()); await turn();
  assert.deepEqual(f.messages, [['normal-workspace-resumed']]);
  assert.equal(f.refreshes(), 1);
  f.host.acknowledgePrivateQuitCancelled(); await turn();
  assert.equal(f.refreshes(), 1);
});

test('new OS opens after private settlement remain deferred throughout the normal quit decision', async () => {
  const f = fixture();
  await f.host.openPrivateHubFromNative();
  f.workspace.status.quitRequested = true;
  f.settle(); await turn();
  assert.equal(f.workspace.isActive, false);
  // A normal settings-save failure releases persistence before its error dialog
  // closes. A Finder request received in that interval still cannot dispatch.
  f.globals.cataloguePersistenceActive = false;
  f.host.requestCatalogueOpenFromSystem(catalogue('during-quit-error'));
  f.host.dispatchNextCatalogueOpenRequest();
  assert.deepEqual(f.authorities, []);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.pending, [catalogue('during-quit-error')]);
  f.allowAcknowledgement();
  f.host.acknowledgePrivateQuitCancelled(); await turn();
  assert.deepEqual(f.authorities, [catalogue('during-quit-error')]);
  assert.deepEqual(f.messages, [
    ['normal-workspace-resumed'], ['open-catalogue-from-system', catalogue('during-quit-error')],
  ]);
});

test('already authorized ordinary catalogue requests cannot dispatch while private quit remains unacknowledged', () => {
  const f = fixture();
  f.queue.enqueue(catalogue('already-authorized'));
  f.workspace.status.quitRequested = true;
  f.host.dispatchNextCatalogueOpenRequest();
  assert.deepEqual(f.messages, []);
  assert.equal(f.queue.hasInFlightRequest, false);
  assert.equal(f.queue.waitingCount, 1);
});

test('renderer-requested catalogue creation or switching cannot advance the session during private quit', async () => {
  const f = fixture();
  const generation = f.globals.catalogueSessionGeneration;
  f.workspace.status.quitRequested = true;
  assert.equal(f.host.beginCatalogueOpenOperation(), undefined);
  assert.equal(f.globals.catalogueSessionGeneration, generation);
  assert.equal(f.globals.catalogueTransitionActive, false);
  assert.equal(f.context.catalogueOpenOperationActive, false);
  f.allowAcknowledgement();
  f.host.acknowledgePrivateQuitCancelled(); await turn();
  assert.equal(f.host.beginCatalogueOpenOperation(), generation + 1);
  assert.equal(f.globals.catalogueTransitionActive, true);
  assert.equal(f.context.catalogueOpenOperationActive, true);
});

test('source refresh cannot begin or publish during private quit handback until Keep Working is proven', async () => {
  const f = fixture();
  const session = f.host.captureSourceSession();
  assert.ok(session);
  const source = session.sources[0];
  assert.equal(f.host.sourceConnectionSessionIsCurrent(session, source), true);
  f.workspace.status.quitRequested = true;
  assert.equal(f.host.captureSourceSession(), undefined);
  assert.equal(f.host.sourceConnectionSessionIsCurrent(session, source), false);
  f.factoryOptions().afterResume();
  f.host.acknowledgePrivateQuitCancelled(); await turn();
  assert.equal(f.host.captureSourceSession(), undefined);
  assert.equal(f.refreshes(), 0);
  f.allowAcknowledgement();
  f.host.acknowledgePrivateQuitCancelled(); await turn();
  assert.ok(f.host.captureSourceSession());
  assert.equal(f.host.sourceConnectionSessionIsCurrent(session, source), true);
  assert.equal(f.refreshes(), 1);
});

test('cancelling before pause preserves active normal progress and still dispatches queued OS opens', async () => {
  const f = fixture();
  await f.host.openPrivateHubFromNative();
  assert.equal(await f.host.openPrivateHubFromNative(), 'busy');
  assert.equal(f.opens(), 1);
  f.host.requestCatalogueOpenFromSystem(catalogue('after-picker'));
  f.settle(false); await turn();
  assert.deepEqual(f.messages, [['open-catalogue-from-system', catalogue('after-picker')]]);
  assert.equal(f.refreshes(), 0);
});

test('in-flight or queued ordinary catalogue choices refuse a new pause without cancelling them', async () => {
  for (const inFlight of [false, true]) {
    const f = fixture(); f.queue.enqueue(catalogue('ordinary'));
    if (inFlight) { f.queue.next(); }
    await assert.rejects(f.host.normalApplicationPause.pause(), /cannot be paused/);
    assert.equal(f.operations.accepting, true);
    assert.equal(f.queue.hasInFlightRequest, inFlight);
  }
});

test('restoration refuses a replaced renderer and sealed ordinary admission', async () => {
  for (const sealed of [false, true]) {
    const f = fixture();
    if (sealed) { await f.operations.seal(); }
    else { f.context.win.webContents = {}; }
    await f.host.resumeNormalAfterPrivateHub();
    assert.deepEqual(f.messages, []);
    assert.equal(f.refreshes(), 0);
  }
});
