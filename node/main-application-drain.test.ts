import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

import { CATALOGUE_PICKER_EXTENSIONS, isCataloguePickerFilePath } from '../interfaces/catalogue-file';
import { NormalOperationScope } from './normal-operation-scope';

const repositoryRoot = path.join(__dirname, '..');
const mainSource = readFileSync(path.join(repositoryRoot, 'main.ts'), 'utf8');
const syntax = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
const helperNames = new Set(['trustedIpcOn', 'showNormalMessageBox', 'showNormalOpenDialog']);
const channels = new Set(['just-started', 'system-open-file-through-modal']);
const statements = syntax.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) {
    return helperNames.has(statement.name?.text ?? '');
  }
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return false;
  }
  const call = statement.expression;
  return ts.isIdentifier(call.expression) && call.expression.text === 'trustedIpcOn'
    && ts.isStringLiteral(call.arguments[0]) && channels.has(call.arguments[0].text);
});
assert.equal(statements.length, helperNames.size + channels.size);
const productionCallbacks = ts.transpileModule(statements.map(statement => statement.getText(syntax)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const operations = new NormalOperationScope();
  const settingsRead = deferred<Buffer>();
  const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
  const handlers = new Map<string, (event: unknown) => void>();
  const messages: unknown[][] = [];
  const savedAuthorities: string[] = [];
  const bounds: unknown[] = [];
  let readCalls = 0;
  let pickerCalls = 0;
  let dispatchCalls = 0;
  const sender = { send: (...args: unknown[]): void => { messages.push(args); } };
  const event = { sender };
  runInNewContext(productionCallbacks, {
    Buffer,
    CATALOGUE_PICKER_EXTENSIONS,
    GLOBALS: {
      catalogueStorage: { kind: 'normal' },
      macVersion: false,
      settingsPath: path.join(repositoryRoot, 'tmp/synthetic-main-settings'),
    },
    app: { getLocale: () => 'en-AU' },
    catalogueOpenQueue: { waitingCount: 0 },
    console: { warn: (): void => undefined },
    dialog: {
      showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> => {
        pickerCalls++;
        return picker.promise;
      },
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    },
    dispatchNextCatalogueOpenRequest: (): void => { dispatchCalls++; },
    fs: { promises: { readFile: (): Promise<Buffer> => { readCalls++; return settingsRead.promise; } } },
    ipcMain: { on: (channel: string, callback: (event: unknown) => void): void => { handlers.set(channel, callback); } },
    isCataloguePickerFilePath,
    isTrustedRenderer: (candidate: unknown): boolean => candidate === event,
    normalOperationScope: operations,
    path,
    rememberCataloguePath: (selected: string): string => { savedAuthorities.push(selected); return selected; },
    rendererCanReceiveCatalogueOpenRequests: false,
    screenHeight: 800,
    screenWidth: 1200,
    systemMessages: { selectPreviousHub: 'Open catalogue' },
    win: { setBounds: (value: unknown): void => { bounds.push(value); } },
  });
  return {
    operations, settingsRead, picker, messages, savedAuthorities, bounds,
    emit: (channel: string): void => {
      const listener = handlers.get(channel);
      assert.ok(listener, `Missing production callback ${channel}`);
      listener(event);
    },
    get readCalls() { return readCalls; },
    get pickerCalls() { return pickerCalls; },
    get dispatchCalls() { return dispatchCalls; },
  };
}

async function settleCallbacks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('the normal startup operation retains its pending settings read and still opens first-run setup', async () => {
  const state = harness();
  state.emit('just-started');
  assert.equal(state.readCalls, 1);
  assert.equal(state.operations.pendingCount, 1);
  assert.deepEqual(state.messages, []);
  state.settingsRead.reject(new Error('Synthetic first run has no settings file.'));
  await settleCallbacks();
  assert.equal(state.operations.pendingCount, 0);
  assert.deepEqual(state.messages, [
    ['set-language-based-off-system-locale', 'en-AU'],
    ['please-open-wizard', true],
  ]);
  assert.equal(state.bounds.length, 1);
  assert.equal(state.dispatchCalls, 1);
});

for (const succeeds of [false, true]) {
  test(`sealing retains a settings read and discards its late ${succeeds ? 'data' : 'failure'}`, async () => {
    const state = harness();
    state.emit('just-started');
    const drain = state.operations.seal();
    let drained = false;
    void drain.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    if (succeeds) {
      state.settingsRead.resolve(Buffer.from('{"appState":{}}'));
    } else {
      state.settingsRead.reject(new Error('Synthetic stale settings failure.'));
    }
    state.operations.assertDrained(await drain);
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.savedAuthorities, []);
    assert.deepEqual(state.bounds, []);
    assert.equal(state.dispatchCalls, 0);
  });
}

test('the current catalogue picker authorizes its selected path and sends the opening request', async () => {
  const state = harness();
  const selected = path.join(repositoryRoot, 'tmp/synthetic-picked.scaena');
  state.emit('system-open-file-through-modal');
  assert.equal(state.pickerCalls, 1);
  assert.equal(state.operations.pendingCount, 2);
  state.picker.resolve({ canceled: false, filePaths: [selected] });
  await settleCallbacks();
  assert.equal(state.operations.pendingCount, 0);
  assert.deepEqual(state.savedAuthorities, [selected]);
  assert.deepEqual(state.messages, [['open-catalogue-from-system', selected]]);
});

test('sealing waits for the catalogue picker and discards selection without granting authority', async () => {
  const state = harness();
  state.emit('system-open-file-through-modal');
  const drain = state.operations.seal();
  let drained = false;
  void drain.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  state.picker.resolve({ canceled: false, filePaths: [path.join(repositoryRoot, 'tmp/stale-picked.scaena')] });
  state.operations.assertDrained(await drain);
  assert.deepEqual(state.savedAuthorities, []);
  assert.deepEqual(state.messages, []);
  assert.equal(state.pickerCalls, 1);
});
