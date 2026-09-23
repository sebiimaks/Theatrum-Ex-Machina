import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { createPrivateHubMenu } from './private-hub-menu';
import type { PrivateHubOpenOutcome } from './private-hub-open';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const calls: string[] = [];
  let writable = true;
  let outcome: () => Promise<PrivateHubOpenOutcome> = async () => 'opened';
  const menu = createPrivateHubMenu({
    open: async () => { calls.push('open'); return outcome(); },
    create: async () => { calls.push('create'); return outcome(); },
    canCreate: () => writable,
    report: async (problem, operation) => { calls.push(operation + ':' + problem); },
  });
  const items = menu.submenu as MenuItemConstructorOptions[];
  const click = (operation: 'open' | 'create') => {
    const item = items.find(value => value.id === 'private-hub-' + operation)!;
    (item.click as () => void)();
  };
  return { menu, items, calls, click, setWritable: (value: boolean) => { writable = value; },
    setOutcome: (value: () => Promise<PrivateHubOpenOutcome>) => { outcome = value; } };
}

test('native File menu exposes fixed open/create actions without accepting paths', async () => {
  const f = fixture();
  assert.equal(f.menu.label, 'File');
  assert.deepEqual(f.items.map(item => item.id), ['private-hub-open', 'private-hub-create']);
  f.click('open'); await turn(); f.click('create'); await turn();
  assert.deepEqual(f.calls, ['open', 'create']);
});

test('creation without a writable catalogue reports a useful prerequisite and never begins conversion', async () => {
  const f = fixture(); f.setWritable(false); f.click('create'); await turn();
  assert.deepEqual(f.calls, ['create:no-catalogue']);
  f.click('open'); await turn(); assert.equal(f.calls.at(-1), 'open');
});

test('rapid repeated actions share a reservation until the native operation settles', async () => {
  const f = fixture(); let finish!: (value: PrivateHubOpenOutcome) => void;
  f.setOutcome(() => new Promise(resolve => { finish = resolve; }));
  f.click('open'); f.click('create'); f.click('open');
  assert.deepEqual(f.calls, ['open']);
  finish('opened'); await turn();
  f.setOutcome(async () => 'opened'); f.click('create'); await turn();
  assert.deepEqual(f.calls, ['open', 'create']);
});

test('cancellation stays quiet while busy/unavailable outcomes receive generic native feedback', async () => {
  const f = fixture();
  for (const result of ['cancelled', 'busy', 'unavailable'] as const) {
    f.setOutcome(async () => result); f.click('open'); await turn();
  }
  assert.deepEqual(f.calls, ['open', 'open', 'open:busy', 'open', 'open:unavailable']);
});

test('unexpected errors are reduced to a generic outcome and cannot disclose private values', async () => {
  const f = fixture();
  f.setOutcome(async () => { throw new Error('Synthetic secret must not reach the dialog'); });
  f.click('create'); await turn(); assert.deepEqual(f.calls, ['create', 'create:unavailable']);
});
