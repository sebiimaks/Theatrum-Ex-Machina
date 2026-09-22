import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrivateNativeMenuOptions } from './private-native-menu';

type NativeMenu = { items: any[] };
function fixture(initial: NativeMenu | null = { items: [{ label: 'Original menu' }] }) {
  let current = initial;
  const writes: (NativeMenu | null)[] = [];
  const builds: any[][] = [];
  let reading = (): NativeMenu | null => current;
  let writing = (menu: NativeMenu | null): void => { current = menu; };
  let building = (items: any[]): NativeMenu => ({ items });
  const Menu = {
    getApplicationMenu: () => reading(),
    setApplicationMenu: (menu: NativeMenu | null) => { writes.push(menu); writing(menu); },
    buildFromTemplate: (items: any[]) => { builds.push(items); return building(items); },
  };
  const NodeModule = require('node:module');
  const originalLoad = NodeModule._load;
  const file = require.resolve('./private-native-menu');
  delete require.cache[file];
  let native: typeof import('./private-native-menu');
  try {
    NodeModule._load = function(request: string, ...args: unknown[]) {
      return request === 'electron' ? { Menu } : originalLoad.call(this, request, ...args);
    };
    native = require('./private-native-menu');
  } finally { NodeModule._load = originalLoad; }
  const called = { close: 0, paste: 0, selectAll: 0 };
  const options: PrivateNativeMenuOptions = { kind: 'hub', onClose: () => { called.close++; },
    onPaste: () => { called.paste++; }, onSelectAll: () => { called.selectAll++; } };
  return { native: native!, options, original: initial, builds, writes, called,
    acquire: (patch: Partial<PrivateNativeMenuOptions> = {}) => native!.acquirePrivateNativeMenu({ ...options, ...patch }),
    current: () => current, force: (menu: NativeMenu | null) => { current = menu; },
    read: (next: typeof reading) => { reading = next; }, write: (next: typeof writing) => { writing = next; },
    build: (next: typeof building) => { building = next; },
  };
}
const menuItems = (menu: NativeMenu): any[] => menu.items.flatMap(item => item.submenu ?? []);
const action = (menu: NativeMenu, id: string) => menuItems(menu).find(item => item.id === 'private-native-' + id).click;

for (const original of [null, { items: [{ label: 'Original menu identity' }] }]) {
  test(`restriction restores the exact ${original ? 'previous menu object' : 'null menu'} after clean release`, () => {
    const f = fixture(original);
    const lease = f.acquire();
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(lease.check(), true);
    assert.notEqual(f.current(), original);
    lease.release();
    assert.equal(f.current(), original);
    assert.equal(lease.check(), false);
    lease.release(); lease.quarantine();
    assert.equal(f.writes.length, 2);
    const next = f.acquire(); next.release();
  });
}

test('native templates have only guarded custom actions and hide/quit roles without outbound clipboard or window menus', () => {
  for (const kind of ['password', 'hub'] as const) {
    const f = fixture(); const lease = f.acquire({ kind });
    assert.deepEqual(f.current()!.items.map(item => item.label), ['Theatrum Ex Machina', 'Edit']);
    const items = menuItems(f.current()!);
    assert.deepEqual(items.filter(item => item.role).map(item => item.role), ['hide', 'quit']);
    assert.deepEqual(items.filter(item => item.click).map(item => item.label), [kind === 'password' ? 'Cancel unlock' : 'Lock hub', 'Paste password', 'Select all']);
    assert.equal(items.some(item => item.accelerator !== undefined), false);
    assert.doesNotMatch(JSON.stringify(f.builds), /services|windowMenu|copy|cut|pasteAndMatchStyle|toggleDevTools|reload|print/);
    lease.release();
  }
});

test('singleton ownership rejects overlap before touching the current menu', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current();
  assert.throws(() => f.acquire(), error => error instanceof Error && !f.native.isPrivateNativeMenuCleanupFailure(error));
  assert.equal(f.current(), restricted); assert.equal(f.builds.length, 1); assert.equal(f.writes.length, 1);
  lease.release();
});

test('custom actions bind their own live lease and stale retained menu items never affect a later owner', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
  for (const id of ['close', 'paste', 'select-all']) { action(restricted, id)(); }
  assert.deepEqual(f.called, { close: 1, paste: 1, selectAll: 1 });
  lease.release(); const next = f.acquire(); const nextMenu = f.current();
  for (const id of ['close', 'paste', 'select-all']) { action(restricted, id)(); }
  lease.release(); lease.quarantine();
  assert.deepEqual(f.called, { close: 1, paste: 1, selectAll: 1 });
  assert.equal(f.current(), nextMenu); assert.equal(next.check(), true);
  next.release();
});

test('action callbacks can synchronously release their lease without retaining authority', () => {
  const f = fixture();
  const lease = f.acquire({ onPaste: () => { f.called.paste++; lease.release(); } });
  const restricted = f.current()!;
  action(restricted, 'paste')(); action(restricted, 'paste')();
  assert.equal(f.called.paste, 1); assert.equal(f.current(), f.original); assert.equal(lease.check(), false);
});

test('synchronous callback failure permanently quarantines menu ownership', () => {
  const f = fixture(); const lease = f.acquire({ onClose: () => { throw new Error('Private diagnostics'); } });
  const restricted = f.current()!;
  assert.doesNotThrow(() => action(restricted, 'close')());
  assert.equal(lease.check(), false); assert.equal(f.current(), restricted);
  action(restricted, 'paste')(); assert.equal(f.called.paste, 0);
  assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
  assert.throws(() => f.acquire()); assert.equal(f.current(), restricted);
});

test('foreign menu replacement is re-restricted and permanently poisons the lease', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
  f.force({ items: [{ label: 'Foreign menu' }] });
  assert.equal(lease.check(), false); assert.equal(f.current(), restricted);
  assert.equal(lease.check(), false);
  assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
  assert.throws(() => f.acquire());
  action(restricted, 'close')(); assert.equal(f.called.close, 0);
});

test('a menu read failure while owned reasserts restriction and prevents later restoration', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
  f.read(() => { throw new Error('Unreadable menu'); });
  assert.equal(lease.check(), false); assert.equal(f.current(), restricted);
  f.read(() => f.current());
  assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
});

test('quarantine is permanent, idempotent, and preserves restricted menu after foreign replacement', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
  f.force(null); lease.quarantine(); lease.quarantine();
  assert.equal(f.current(), restricted); assert.equal(lease.check(), false);
  assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
  assert.throws(() => f.acquire());
});

for (const failure of ['read', 'build']) {
  test(`initial ${failure} failure before any mutation releases reservation without a cleanup-failure brand`, () => {
    const f = fixture();
    if (failure === 'read') { f.read(() => { throw new Error('Private adapter error'); }); }
    else { f.build(() => { throw new Error('Private adapter error'); }); }
    assert.throws(() => f.acquire(), error => error instanceof Error && !f.native.isPrivateNativeMenuCleanupFailure(error));
    assert.equal(f.current(), f.original); assert.deepEqual(f.writes, []);
    f.read(() => f.current()); f.build(items => ({ items }));
    const next = f.acquire(); next.release();
  });
}

for (const failure of ['throw-before', 'throw-after', 'ignore', 'read-after']) {
  test(`uncertain initial installation ${failure} retains poisoned ownership and has an authentic cleanup-failure brand`, () => {
    const f = fixture();
    f.write(menu => {
      if (failure === 'throw-before') { throw new Error('Private adapter error'); }
      if (failure !== 'ignore') { f.force(menu); }
      if (failure === 'throw-after') { throw new Error('Private adapter error'); }
      if (failure === 'read-after') { f.read(() => { throw new Error('Private adapter error'); }); }
    });
    assert.throws(() => f.acquire(), f.native.isPrivateNativeMenuCleanupFailure);
    assert.ok(f.writes.length >= 2, 'Restriction is retried even when installation is uncertain');
    assert.throws(() => f.acquire());
    assert.equal(f.native.isPrivateNativeMenuCleanupFailure(new Error('Private native controls cleanup could not be confirmed.')), false);
  });
}

for (const failure of ['throw-before', 'throw-after', 'ignore', 'read-after']) {
  test(`uncertain restoration ${failure} reasserts the restricted menu and permanently poisons ownership`, () => {
    const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
    f.write(menu => {
      if (menu === restricted) { f.force(menu); return; }
      if (failure === 'throw-before') { throw new Error('Private adapter error'); }
      if (failure !== 'ignore') { f.force(menu); }
      if (failure === 'throw-after') { throw new Error('Private adapter error'); }
      if (failure === 'read-after') { f.read(() => { throw new Error('Private adapter error'); }); }
    });
    assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
    assert.equal(f.current(), restricted); assert.equal(lease.check(), false);
    assert.throws(() => f.acquire());
  });
}

test('reservation precedes native get/build/set callbacks that try to acquire a competing lease', () => {
  const f = fixture(); let nested = 0;
  f.read(() => { assert.throws(() => f.acquire()); nested++; return f.current(); });
  f.build(items => { assert.throws(() => f.acquire()); nested++; return { items }; });
  f.write(menu => { assert.throws(() => f.acquire()); nested++; f.force(menu); });
  const lease = f.acquire(); assert.ok(nested >= 4);
  lease.release(); assert.equal(f.current(), f.original);
});

test('reentrant quarantine during a check cannot be mistaken for healthy identity', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
  f.read(() => { lease.quarantine(); return restricted; });
  assert.equal(lease.check(), false);
  assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
});

test('reentrant release and callback attempts during restoration cannot restore twice or dispatch actions', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
  f.write(menu => { lease.release(); action(restricted, 'close')(); f.force(menu); });
  lease.release(); assert.equal(f.current(), f.original); assert.equal(f.called.close, 0);
  assert.equal(f.writes.length, 2);
});

test('reentrant quarantine during restoration always wins over apparent normal-menu adoption', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
  f.write(menu => {
    if (menu !== restricted) { lease.quarantine(); }
    f.force(menu);
  });
  assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
  assert.equal(f.current(), restricted); assert.equal(lease.check(), false);
});

test('late rejected callback promises are consumed and cannot disturb an already restored or newer menu', async () => {
  const f = fixture(); let reject!: (error: Error) => void;
  const lease = f.acquire({ onClose: () => new Promise<void>((_resolve, no) => { reject = no; }) });
  action(f.current()!, 'close')();
  lease.release(); const next = f.acquire(); const nextMenu = f.current();
  reject(new Error('Retired private callback'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.current(), nextMenu); assert.equal(next.check(), true); next.release();
});

test('rejected callback promises while still owned poison the lease without escaping native dispatch', async () => {
  const f = fixture(); const lease = f.acquire({ onSelectAll: () => Promise.reject(new Error('Private callback failure')) });
  const restricted = f.current()!;
  assert.doesNotThrow(() => action(restricted, 'select-all')());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lease.check(), false); assert.equal(f.current(), restricted);
  assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
});

test('invalid callback contracts fail before observing or modifying native menu state', () => {
  const f = fixture();
  for (const patch of [{ kind: 'normal' }, { onClose: undefined }, { onPaste: null }, { onSelectAll: false }]) {
    assert.throws(() => f.acquire(patch as any));
  }
  assert.deepEqual(f.builds, []); assert.deepEqual(f.writes, []);
  const lease = f.acquire(); lease.release();
});


test('nested native action dispatch cannot reenter the same owner callback', () => {
  const f = fixture();
  const lease = f.acquire({ onPaste: () => {
    f.called.paste++; action(restricted, 'paste')(); action(restricted, 'close')();
    assert.equal(lease.check(), true, 'The browser callback may still validate its own native lease');
  } });
  const restricted = f.current()!; action(restricted, 'paste')();
  assert.deepEqual(f.called, { close: 0, paste: 1, selectAll: 0 }); lease.release();
});

test('reentrant native reads and restriction setters stay bounded', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current()!;
  f.read(() => { assert.equal(lease.check(), false); return f.current(); });
  assert.equal(lease.check(), false, 'Even reentrant failed validation permanently revokes the lease');
  f.write(menu => { lease.quarantine(); f.force(menu); });
  f.force(null); assert.equal(lease.check(), false);
  assert.equal(f.current(), restricted); assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
});


test('reopening after retained quarantine preserves cleanup-failure classification', () => {
  const f = fixture(); const lease = f.acquire(); const restricted = f.current();
  assert.throws(() => f.acquire(), error => error instanceof Error && !f.native.isPrivateNativeMenuCleanupFailure(error));
  lease.quarantine();
  f.force(f.original);
  assert.throws(() => f.acquire(), f.native.isPrivateNativeMenuCleanupFailure);
  assert.equal(f.current(), restricted);
  assert.throws(() => lease.release(), f.native.isPrivateNativeMenuCleanupFailure);
  assert.throws(() => f.acquire(), f.native.isPrivateNativeMenuCleanupFailure);
});
