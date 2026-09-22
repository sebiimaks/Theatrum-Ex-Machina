import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as privateHubCrypto from './private-hub-crypto.ts';
import {
  changePrivateHubPassword, createPrivateHub, createPrivateHubTouchIdSecret,
  privateHubTouchIdIdentity, unlockPrivateHubWithTouchId,
} from './private-hub-crypto.ts';
import { PRIVATE_HUB_HEADER_FILE, PrivateHubStore } from './private-hub-store.ts';
import { createPrivateTouchIdCleanupFailure, isPrivateTouchIdCleanupFailure, type PrivateTouchIdProvider } from './private-touch-id.ts';

const password = 'Synthetic Touch ID enrollment password';
const active = (): boolean => true;
const signal = (): AbortSignal => new AbortController().signal;
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: value => resolve(value) };
}
class Device implements PrivateTouchIdProvider {
  readonly entries = new Map<string, Buffer>();
  readonly events: string[] = [];
  input?: Buffer;
  returned?: Buffer;
  async availability(): Promise<'available'> { this.events.push('availability'); return 'available'; }
  async has(identity: string): Promise<boolean> { this.events.push('has'); return this.entries.has(identity); }
  async enroll(identity: string, secret: Buffer, _signal: AbortSignal): Promise<'enrolled' | 'unavailable'> {
    this.events.push('enroll');
    this.input = secret;
    if (this.entries.has(identity)) { return 'unavailable'; }
    this.entries.set(identity, Buffer.from(secret));
    return 'enrolled';
  }
  async unlock(identity: string, _signal: AbortSignal): Promise<Buffer | undefined> {
    this.events.push('unlock');
    const value = this.entries.get(identity);
    this.returned = value && Buffer.from(value);
    return this.returned;
  }
  async remove(identity: string, _signal: AbortSignal): Promise<boolean> {
    this.events.push('remove');
    this.entries.get(identity)?.fill(0);
    this.entries.delete(identity);
    return true;
  }
}
async function fixture(t: TestContext): Promise<{ directory: string; headerPath: string; store: PrivateHubStore; device: Device }> {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..'), '.private-touch-id-store-test-'));
  const directory = path.join(root, 'hub');
  const store = await PrivateHubStore.create(directory, password);
  const device = new Device();
  await store.writeRecord('catalogue', Buffer.from('Synthetic private catalogue'));
  t.after(async () => {
    await store.lock().catch(() => undefined);
    for (const value of device.entries.values()) { value.fill(0); }
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { directory, headerPath: path.join(directory, PRIVATE_HUB_HEADER_FILE), store, device };
}
function wiped(value: Buffer | undefined): void { assert.ok(value?.every(byte => byte === 0)); }

test('Touch ID names are stable across password changes while full-header secrets are not', async () => {
  const { header, key } = await createPrivateHub(password);
  const secret = createPrivateHubTouchIdSecret(header, key);
  const unchanged = Buffer.from(secret);
  try {
    assert.match(privateHubTouchIdIdentity(header), /^[a-f0-9]{64}$/);
    const replacement = await changePrivateHubPassword(header, key, password + '-new');
    assert.equal(privateHubTouchIdIdentity(replacement), privateHubTouchIdIdentity(header));
    assert.throws(() => unlockPrivateHubWithTouchId(replacement, secret));
    const reordered = Object.fromEntries(Object.entries(header).reverse());
    assert.equal(privateHubTouchIdIdentity(reordered), privateHubTouchIdIdentity(header));
    const unwrapped = unlockPrivateHubWithTouchId(reordered, secret);
    assert.deepEqual(unwrapped, key);
    unwrapped.fill(0);
    assert.deepEqual(secret, unchanged, 'crypto never mutates caller-owned Keychain payload');
  } finally { key.fill(0); secret.fill(0); unchanged.fill(0); }
});

test('Touch ID payload rejects malformed lengths, changed wrap fields and a wrong data key', async () => {
  const { header, key } = await createPrivateHub(password);
  const secret = createPrivateHubTouchIdSecret(header, key);
  try {
    for (const length of [0, 31, 32, 63, 65, 1024]) { assert.throws(() => unlockPrivateHubWithTouchId(header, Buffer.alloc(length))); }
    const corrupt = Buffer.from(secret);
    corrupt[63] ^= 1;
    assert.throws(() => unlockPrivateHubWithTouchId(header, corrupt));
    corrupt.fill(0);
    const changed = structuredClone(header);
    changed.wrappedKey.ciphertext = Buffer.alloc(32, 7).toString('base64');
    assert.throws(() => unlockPrivateHubWithTouchId(changed, secret));
    assert.throws(() => createPrivateHubTouchIdSecret(header, Buffer.alloc(32)));
    assert.throws(() => privateHubTouchIdIdentity({ ...header, extra: true }));
  } finally { key.fill(0); secret.fill(0); }
});

test('password-authorized enrollment unlocks only this hub and wipes temporary Keychain buffers', async t => {
  const { directory, store, device } = await fixture(t);
  assert.equal(await store.touchIdStatus(device, signal()), 'disabled');
  assert.equal(await store.enableTouchId(password, device, active, signal()), 'enabled');
  wiped(device.input);
  assert.equal(await store.touchIdStatus(device, signal()), 'enabled');
  await store.lock();
  const reopened = await PrivateHubStore.openWithTouchId(directory, device, signal());
  try {
    assert.equal((await reopened.readRecord('catalogue')).toString(), 'Synthetic private catalogue');
    wiped(device.returned);
  } finally { await reopened.lock(); }
});

test('wrong enrollment password makes no Keychain mutation', async t => {
  const { store, device } = await fixture(t);
  assert.equal(await store.enableTouchId('wrong password', device, active, signal()), 'incorrect-password');
  assert.deepEqual(device.events, []);
  assert.equal(device.entries.size, 0);
  assert.equal(store.locked, false);
});

test('duplicate enrollment does not remove a previously enabled credential', async t => {
  const { store, device } = await fixture(t);
  assert.equal(await store.enableTouchId(password, device, active, signal()), 'enabled');
  assert.equal(await store.enableTouchId(password, device, active, signal()), 'unavailable');
  assert.equal(device.entries.size, 1);
  assert.equal(device.events.includes('remove'), false);
  wiped(device.input);
});

test('cancelled native enrollment clears the transient secret without fabricating an enabled state', async t => {
  const { store, device } = await fixture(t);
  let input: Buffer | undefined;
  const provider: PrivateTouchIdProvider = { ...device, availability: () => device.availability(), has: id => device.has(id),
    enroll: async (_identity, secret) => { input = secret; return 'cancelled'; },
    unlock: (id, abort) => device.unlock(id, abort), remove: (id, abort) => device.remove(id, abort) };
  assert.equal(await store.enableTouchId(password, provider, active, signal()), 'cancelled');
  wiped(input);
  assert.equal(device.entries.size, 0);
});

test('aborted enrollment never invokes native code', async t => {
  const { store, device } = await fixture(t);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(store.enableTouchId(password, device, active, cancelled.signal));
  assert.deepEqual(device.events, []);
});

test('locking during enrollment wipes inputs immediately and drains late enrollment rollback', async t => {
  const { store, device } = await fixture(t);
  const enrolled = deferred<void>();
  const entered = deferred<void>();
  const removed = deferred<void>();
  const removeEntered = deferred<void>();
  const originalEnroll = device.enroll.bind(device);
  const originalRemove = device.remove.bind(device);
  t.mock.method(device, 'enroll', async (id: string, value: Buffer, abort: AbortSignal) => {
    const outcome = await originalEnroll(id, value, abort);
    entered.resolve();
    await enrolled.promise;
    return outcome;
  });
  t.mock.method(device, 'remove', async (id: string, abort: AbortSignal) => {
    assert.equal(abort.aborted, false, 'cleanup uses fresh authority after lock');
    removeEntered.resolve();
    await removed.promise;
    return originalRemove(id, abort);
  });
  const enabling = store.enableTouchId(password, device, active, signal());
  const rejected = assert.rejects(enabling);
  await entered.promise;
  let drained = false;
  const locking = store.lock().then(() => { drained = true; });
  wiped(device.input);
  enrolled.resolve();
  await removeEntered.promise;
  await tick();
  assert.equal(drained, false, 'storage lock includes Keychain rollback');
  removed.resolve();
  await rejected;
  await locking;
  assert.equal(device.entries.size, 0);
});

test('late enrollment after authority loss removes only the newly enrolled entry', async t => {
  const { store, device } = await fixture(t);
  let current = true;
  const original = device.enroll.bind(device);
  t.mock.method(device, 'enroll', async (id: string, value: Buffer, abort: AbortSignal) => {
    const result = await original(id, value, abort);
    current = false;
    return result;
  });
  await assert.rejects(store.enableTouchId(password, device, () => current, signal()));
  assert.equal(device.entries.size, 0);
  assert.equal(device.events.filter(value => value === 'remove').length, 1);
  wiped(device.input);
});

test('unconfirmed late-enrollment cleanup is branded and keeps storage quarantined', async t => {
  const { store, device } = await fixture(t);
  let current = true;
  const original = device.enroll.bind(device);
  t.mock.method(device, 'enroll', async (id: string, value: Buffer, abort: AbortSignal) => {
    const result = await original(id, value, abort);
    current = false;
    return result;
  });
  t.mock.method(device, 'remove', async () => false);
  await assert.rejects(store.enableTouchId(password, device, () => current, signal()), isPrivateTouchIdCleanupFailure);
  assert.equal(store.locked, true);
  await assert.rejects(store.lock(), isPrivateTouchIdCleanupFailure);
  wiped(device.input);
});

test('native enrollment cleanup failures remain branded across the store boundary', async t => {
  const { store, device } = await fixture(t);
  t.mock.method(device, 'enroll', async () => { throw createPrivateTouchIdCleanupFailure(); });
  await assert.rejects(store.enableTouchId(password, device, active, signal()), isPrivateTouchIdCleanupFailure);
  await assert.rejects(store.lock(), isPrivateTouchIdCleanupFailure);
});

test('enrollment and password operations are mutually exclusive', async t => {
  const { store, device } = await fixture(t);
  const entered = deferred<void>();
  const release = deferred<void>();
  const original = device.enroll.bind(device);
  t.mock.method(device, 'enroll', async (id: string, value: Buffer, abort: AbortSignal) => {
    entered.resolve();
    await release.promise;
    return original(id, value, abort);
  });
  const enabling = store.enableTouchId(password, device, active, signal());
  await entered.promise;
  await assert.rejects(store.changePassword(password, 'new password', active, device));
  await assert.rejects(store.disableTouchId(device, active, signal()));
  assert.equal(await store.touchIdStatus(device, signal()), 'unavailable');
  release.resolve();
  assert.equal(await enabling, 'enabled');
});

test('Disable Touch ID deletes only the selected hub credential and retains encrypted data', async t => {
  const { store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  device.entries.set('a'.repeat(64), Buffer.alloc(64, 1));
  assert.equal(await store.disableTouchId(device, active, signal()), 'disabled');
  assert.deepEqual([...device.entries.keys()], ['a'.repeat(64)]);
  assert.equal((await store.readRecord('catalogue')).toString(), 'Synthetic private catalogue');
  assert.equal(await store.disableTouchId(device, active, signal()), 'disabled');
});

test('unavailable deletion never claims Touch ID is disabled', async t => {
  const { store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  t.mock.method(device, 'remove', async () => false);
  assert.equal(await store.disableTouchId(device, active, signal()), 'unavailable');
  assert.equal(device.entries.size, 1);
});

test('native deletion cleanup failure locks storage and preserves the failure brand', async t => {
  const { store, device } = await fixture(t);
  t.mock.method(device, 'remove', async () => { throw createPrivateTouchIdCleanupFailure(); });
  await assert.rejects(store.disableTouchId(device, active, signal()), isPrivateTouchIdCleanupFailure);
  await assert.rejects(store.lock(), isPrivateTouchIdCleanupFailure);
});

test('password changes delete an enrolled credential before publishing the new envelope', async t => {
  const { headerPath, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  const originalHeader = await fs.promises.readFile(headerPath);
  const original = device.remove.bind(device);
  t.mock.method(device, 'remove', async (id: string, abort: AbortSignal) => {
    assert.deepEqual(await fs.promises.readFile(headerPath), originalHeader);
    return original(id, abort);
  });
  assert.equal(await store.changePassword(password, 'replacement password', active, device), 'changed');
  assert.equal(device.entries.size, 0);
  assert.notDeepEqual(await fs.promises.readFile(headerPath), originalHeader);
});

test('a failed credential removal prevents password publication', async t => {
  const { headerPath, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  const originalHeader = await fs.promises.readFile(headerPath);
  t.mock.method(device, 'remove', async () => false);
  await assert.rejects(store.changePassword(password, 'replacement password', active, device));
  assert.deepEqual(await fs.promises.readFile(headerPath), originalHeader);
  assert.equal(await store.verifyPassword(password, active), true);
});

test('incorrect password change does not delete or inspect a credential', async t => {
  const { store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  device.events.length = 0;
  assert.equal(await store.changePassword('wrong password', 'replacement password', active, device), 'incorrect-password');
  assert.deepEqual(device.events, []);
  assert.equal(device.entries.size, 1);
});

test('header rewrapping invalidates an old device secret even if deletion was unavailable to an older caller', async t => {
  const { directory, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  assert.equal(await store.changePassword(password, 'replacement password', active), 'changed');
  await store.lock();
  await assert.rejects(PrivateHubStore.openWithTouchId(directory, device, signal()));
  wiped(device.returned);
  const reopened = await PrivateHubStore.open(directory, 'replacement password');
  await reopened.lock();
});

test('Touch ID availability probes metadata without retrieving a credential or decrypting a record', async t => {
  const { directory, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  await store.lock();
  device.events.length = 0;
  assert.equal(await PrivateHubStore.touchIdAvailable(directory, device, signal()), true);
  assert.deepEqual(device.events, ['availability', 'has']);
  const reopened = await PrivateHubStore.open(directory, password);
  await reopened.lock();
});

test('availability probing refuses changed headers and does not leak its directory reservation', async t => {
  const { directory, headerPath, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  await store.lock();
  const original = device.has.bind(device);
  t.mock.method(device, 'has', async (id: string) => {
    await fs.promises.appendFile(headerPath, ' ');
    return original(id);
  });
  assert.equal(await PrivateHubStore.touchIdAvailable(directory, device, signal()), false);
  const reopened = await PrivateHubStore.open(directory, password);
  await reopened.lock();
});

test('aborted availability and unlock attempts do not query Keychain', async t => {
  const { directory, store, device } = await fixture(t);
  await store.lock();
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await PrivateHubStore.touchIdAvailable(directory, device, cancelled.signal), false);
  await assert.rejects(PrivateHubStore.openWithTouchId(directory, device, cancelled.signal));
  assert.deepEqual(device.events, []);
});

test('late biometric success after cancellation wipes the returned key and releases storage', async t => {
  const { directory, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  await store.lock();
  const cancelled = new AbortController();
  const original = device.unlock.bind(device);
  t.mock.method(device, 'unlock', async (id: string, abort: AbortSignal) => {
    const secret = await original(id, abort);
    cancelled.abort();
    return secret;
  });
  await assert.rejects(PrivateHubStore.openWithTouchId(directory, device, cancelled.signal));
  wiped(device.returned);
  const reopened = await PrivateHubStore.open(directory, password);
  await reopened.lock();
});

test('changed headers during Touch ID prevent adopting the key', async t => {
  const { directory, headerPath, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  await store.lock();
  const original = device.unlock.bind(device);
  t.mock.method(device, 'unlock', async (id: string, abort: AbortSignal) => {
    const secret = await original(id, abort);
    await fs.promises.appendFile(headerPath, ' ');
    return secret;
  });
  await assert.rejects(PrivateHubStore.openWithTouchId(directory, device, signal()));
  wiped(device.returned);
});

test('wrong device secrets do not repair interrupted header publication', async t => {
  const { directory, headerPath, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  await store.lock();
  const alias = headerPath + '.' + 'a'.repeat(48) + '.pending';
  await fs.promises.link(headerPath, alias);
  for (const entry of device.entries.values()) { entry[63] ^= 1; }
  assert.equal(await PrivateHubStore.touchIdAvailable(directory, device, signal()), false);
  await assert.rejects(PrivateHubStore.openWithTouchId(directory, device, signal()));
  assert.equal((await fs.promises.stat(alias)).nlink, 2);
  wiped(device.returned);
  const reopened = await PrivateHubStore.open(directory, password);
  await reopened.lock();
});

test('authenticated Touch ID can complete recognized interrupted header publication', async t => {
  const { directory, headerPath, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  await store.lock();
  const alias = headerPath + '.' + 'a'.repeat(48) + '.pending';
  await fs.promises.link(headerPath, alias);
  const reopened = await PrivateHubStore.openWithTouchId(directory, device, signal());
  try {
    await assert.rejects(fs.promises.stat(alias), { code: 'ENOENT' });
    assert.equal((await reopened.readRecord('catalogue')).toString(), 'Synthetic private catalogue');
  } finally { await reopened.lock(); }
});


test('unlock revocation wipes the authenticated data key before pending filesystem work resumes', async t => {
  const { directory, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  await store.lock();
  const cancelled = new AbortController();
  const original = privateHubCrypto.unlockPrivateHubWithTouchId;
  let checked = false;
  t.mock.method(privateHubCrypto, 'unlockPrivateHubWithTouchId', (value: unknown, secret: Buffer) => {
    const key = original(value, secret);
    queueMicrotask(() => {
      cancelled.abort();
      wiped(key);
      checked = true;
    });
    return key;
  });
  await assert.rejects(PrivateHubStore.openWithTouchId(directory, device, cancelled.signal));
  assert.equal(checked, true);
});

test('password-change cleanup uncertainty quarantines storage without publishing a new password', async t => {
  const { headerPath, store, device } = await fixture(t);
  await store.enableTouchId(password, device, active, signal());
  const before = await fs.promises.readFile(headerPath);
  t.mock.method(device, 'remove', async () => { throw createPrivateTouchIdCleanupFailure(); });
  await assert.rejects(store.changePassword(password, 'replacement password', active, device), isPrivateTouchIdCleanupFailure);
  assert.deepEqual(await fs.promises.readFile(headerPath), before);
  await assert.rejects(store.lock(), isPrivateTouchIdCleanupFailure);
});

test('a valid Keychain payload from another hub cannot unlock the selected hub', async t => {
  const { directory, store, device } = await fixture(t);
  const unrelated = await createPrivateHub('Other synthetic password');
  const foreignSecret = createPrivateHubTouchIdSecret(unrelated.header, unrelated.key);
  unrelated.key.fill(0);
  await store.lock();
  t.mock.method(device, 'unlock', async () => Buffer.from(foreignSecret));
  try { await assert.rejects(PrivateHubStore.openWithTouchId(directory, device, signal())); }
  finally { foreignSecret.fill(0); }
});

test('malformed on-disk headers are rejected before a Touch ID prompt is requested', async t => {
  const { directory, headerPath, store, device } = await fixture(t);
  await store.lock();
  await fs.promises.writeFile(headerPath, '{"format":"unknown"}');
  await assert.rejects(PrivateHubStore.openWithTouchId(directory, device, signal()));
  assert.deepEqual(device.events, []);
});
