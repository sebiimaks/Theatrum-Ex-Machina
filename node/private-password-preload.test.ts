import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = fs.readFileSync(path.resolve(__dirname, '../private-password-preload.cjs'), 'utf8');

function fixture(...results: unknown[]) {
  const result = results.length ? results[0] : true;
  const exposed: Record<string, any> = {};
  const invoked: unknown[][] = [];
  const sent: unknown[][] = [];
  const imports: string[] = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { exposed[name] = value; } },
    ipcRenderer: {
      invoke: async (...args: unknown[]) => { invoked.push(args); if (result instanceof Error) { throw result; } return result; },
      send: (...args: unknown[]) => { sent.push(args); if (result instanceof Error) { throw result; } },
    },
  };
  runInNewContext(source, { require: (name: string) => {
    imports.push(name);
    if (name !== 'electron') { throw new Error('Forbidden module'); }
    return electron;
  } });
  return { exposed, invoked, sent, imports, bridge: exposed.privateUnlock };
}

test('standalone sandbox preload exposes exactly four frozen methods and imports only Electron', () => {
  const f = fixture();
  assert.deepEqual(f.imports, ['electron']);
  assert.deepEqual(Object.keys(f.exposed), ['privateUnlock']);
  assert.deepEqual(Object.keys(f.bridge).sort(), ['cancel', 'submit', 'touchIdAvailable', 'useTouchId']);
  assert.equal(Object.isFrozen(f.bridge), true);
  assert.equal(typeof f.bridge.submit, 'function');
  assert.equal(typeof f.bridge.cancel, 'function');
  for (const key of ['ipc', 'on', 'send', 'invoke', 'files', 'clipboard', 'platform', 'process']) {
    assert.equal(f.bridge[key], undefined);
  }
});

test('password IPC sends one primitive password unchanged with only a generic boolean result', async () => {
  const f = fixture();
  const password = '  private 🦉 e\u0301\t';
  assert.equal(await f.bridge.submit(password), true);
  assert.deepEqual(f.invoked, [['private-password-submit', password]]);
  assert.equal(await f.bridge.submit('again'), false);
  assert.equal(f.bridge.cancel(), undefined);
  assert.deepEqual(f.sent, []);
});

test('main rejection, diagnostics and Electron-like event objects never reach the page', async () => {
  for (const value of [false, undefined, null, 'secret', { sender: { privatePath: 'secret' } }, new Error('password or path secret')]) {
    const f = fixture(value);
    assert.equal(await f.bridge.submit('private'), false);
    assert.equal(f.invoked.length, 1);
    assert.equal(await f.bridge.submit('again'), false);
  }
});

test('preload rejects malformed, oversized and invalid Unicode before IPC without consuming the prompt', async () => {
  const f = fixture();
  for (const args of [[], [null], [7], [{}], [{ password: 'secret' }], [new String('secret')],
    [''], ['\ud800'], ['\udc00'], ['x\ud800x'], ['x'.repeat(1025)], ['é'.repeat(513)],
    ['😀'.repeat(257)], ['secret', {}]]) {
    assert.equal(await f.bridge.submit(...args), false);
  }
  assert.deepEqual(f.invoked, []);
  assert.equal(f.bridge.cancel('extra'), undefined);
  assert.deepEqual(f.sent, []);
  assert.equal(await f.bridge.submit('😀'.repeat(256)), true);
  assert.equal(f.invoked.length, 1);
});

test('preload neither trims nor normalizes all-whitespace passwords', async () => {
  const f = fixture();
  assert.equal(await f.bridge.submit(' \t\n'), true);
  assert.deepEqual(f.invoked, [['private-password-submit', ' \t\n']]);
});

test('cancel sends no payload, exposes no result and permanently consumes the prompt', async () => {
  const f = fixture();
  assert.equal(f.bridge.cancel(), undefined);
  assert.deepEqual(f.sent, [['private-password-cancel']]);
  assert.equal(f.bridge.cancel(), undefined);
  assert.equal(await f.bridge.submit('secret'), false);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.invoked, []);
});

test('cancellation during teardown does not expose native error details', () => {
  const f = fixture(new Error('native private diagnostics'));
  assert.equal(f.bridge.cancel(), undefined);
  assert.equal(f.sent.length, 1);
});

test('concurrent submissions invoke the main process only once', async () => {
  const f = fixture();
  const first = f.bridge.submit('first');
  const second = f.bridge.submit('second');
  assert.equal(await second, false);
  assert.equal(await first, true);
  assert.deepEqual(f.invoked, [['private-password-submit', 'first']]);
});


test('Touch ID availability is argument-free, sanitized and does not consume password fallback', async () => {
  for (const result of [true, false, null, 'true', { available: true, secret: '/private' }, new Error('/private')]) {
    const f = fixture(result);
    assert.equal(await f.bridge.touchIdAvailable('extra'), false);
    assert.deepEqual(f.invoked, []);
    assert.equal(await f.bridge.touchIdAvailable(), result === true);
    assert.equal(await f.bridge.submit('fallback'), result === true);
    assert.deepEqual(f.invoked, [['private-password-touch-id-available'], ['private-password-submit', 'fallback']]);
  }
});

test('Touch ID choice consumes the password prompt once and emits no payload', async () => {
  for (const result of [true, false, null, 'accepted', { secret: '/private' }, new Error('/private')]) {
    const f = fixture(result);
    assert.equal(await f.bridge.useTouchId('extra'), false);
    assert.equal(await f.bridge.useTouchId(), result === true);
    assert.equal(await f.bridge.useTouchId(), false);
    assert.equal(await f.bridge.touchIdAvailable(), false);
    assert.equal(await f.bridge.submit('fallback'), false);
    f.bridge.cancel();
    assert.deepEqual(f.invoked, [['private-password-touch-id']]);
    assert.deepEqual(f.sent, []);
  }
});

test('password submission or cancellation prevents later Touch ID choice and availability', async () => {
  for (const first of ['submit', 'cancel']) {
    const f = fixture();
    await f.bridge[first](...(first === 'submit' ? ['synthetic'] : []));
    const count = f.invoked.length;
    assert.equal(await f.bridge.useTouchId(), false);
    assert.equal(await f.bridge.touchIdAvailable(), false);
    assert.equal(f.invoked.length, count);
  }
});

test('late Touch ID availability cannot revive a prompt consumed during its IPC request', async () => {
  const f = fixture();
  const availability = f.bridge.touchIdAvailable();
  f.bridge.cancel();
  assert.equal(await availability, false);
  assert.deepEqual(f.sent, [['private-password-cancel']]);
});
