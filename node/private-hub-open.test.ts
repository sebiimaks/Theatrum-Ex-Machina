import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  PrivateHubOpenCoordinator, type PrivateHubOpenBrowser, type PrivateHubOpenDependencies,
  type PrivateHubOpenLifetime, type PrivateHubOpenSession, type PrivateHubPreparedOpen,
} from './private-hub-open';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve: resolve!, reject: reject! };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) { return; }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Expected coordinator handoff did not occur.');
}

class FakeSession implements PrivateHubOpenSession {
  readonly revocation = new AbortController();
  readonly unlockGate = deferred<{ generation: number; catalogue?: unknown }>();
  lockGate: Promise<void> = Promise.resolve();
  closeGate: Promise<void> = Promise.resolve();
  unlockCalls: [string, string][] = [];
  lockCalls = 0;
  closeCalls = 0;
  current = true;
  unlock(directory: string, password: string): Promise<{ generation: number }> {
    this.unlockCalls.push([directory, password]);
    return this.unlockGate.promise;
  }
  isCurrent(generation: number): boolean { return this.current && generation === 7 && !this.revocation.signal.aborted; }
  revocationSignal(): AbortSignal { return this.revocation.signal; }
  lock(): Promise<void> {
    this.lockCalls++;
    this.current = false;
    this.revocation.abort();
    return this.lockGate;
  }
  close(): Promise<void> { this.closeCalls++; return this.closeGate; }
}

class FakeBrowser implements PrivateHubOpenBrowser {
  readonly finished = deferred();
  readonly closed = this.finished.promise;
  state: 'open' | 'closed' = 'open';
  cleanupFailed = false;
  closeGate: Promise<void> = Promise.resolve();
  showCalls = 0;
  closeCalls = 0;
  get status(): { state: 'open' | 'closed'; cleanupFailed: boolean } { return { state: this.state, cleanupFailed: this.cleanupFailed }; }
  show(): void { this.showCalls++; }
  close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
    void this.closeGate.then(() => this.finished.resolve(), error => this.finished.reject(error));
    return this.closeGate;
  }
  closeExternally(): void { this.state = 'closed'; this.finished.resolve(); }
}

function fixture(overrides: Partial<PrivateHubOpenDependencies<FakeSession>> = {}): {
  coordinator: PrivateHubOpenCoordinator<FakeSession>; session: FakeSession; browser: FakeBrowser;
  promptLifetimes: PrivateHubOpenLifetime[]; browserLifetimes: PrivateHubOpenLifetime[];
  options: { directory: string; isAuthorized: () => boolean }; setAuthority: (value: boolean) => void;
} {
  const session = new FakeSession();
  session.unlockGate.resolve({ generation: 7, catalogue: { secret: 'DECRYPTED-CATALOGUE' } });
  const browser = new FakeBrowser();
  const promptLifetimes: PrivateHubOpenLifetime[] = [];
  const browserLifetimes: PrivateHubOpenLifetime[] = [];
  let authority = true;
  const options = { directory: '/main-owned/synthetic-private-hub', isAuthorized: () => authority };
  const coordinator = new PrivateHubOpenCoordinator<FakeSession>({
    createSession: () => session,
    requestPassword: async lifetime => { promptLifetimes.push(lifetime); return 'synthetic secret'; },
    createBrowser: async lifetime => { browserLifetimes.push(lifetime); return browser; },
    ...overrides,
  });
  return { coordinator, session, browser, promptLifetimes, browserLifetimes, options, setAuthority: value => { authority = value; } };
}

test('opens only the isolated browser and returns no password, path, or catalogue', async () => {
  const f = fixture();
  assert.equal(await f.coordinator.open(f.options), 'opened');
  assert.deepEqual(f.coordinator.status, { state: 'open', cleanupFailed: false });
  assert.ok(Object.isFrozen(f.coordinator.status));
  assert.equal(f.browser.showCalls, 1);
  assert.deepEqual(f.session.unlockCalls, [[f.options.directory, 'synthetic secret']]);
  assert.equal(f.promptLifetimes[0].signal, f.browserLifetimes[0].signal);
  assert.ok(Object.isFrozen(f.promptLifetimes[0]));
  assert.ok(Object.isFrozen(f.browserLifetimes[0]));
  assert.equal(await f.coordinator.open(f.options), 'busy');
  await f.coordinator.cancel();
  assert.deepEqual(f.coordinator.status, { state: 'idle', cleanupFailed: false });
});

test('preparation owns admission and must finish before destination activation without another prompt or Touch ID', async () => {
  const prepared = deferred<PrivateHubPreparedOpen | undefined>();
  let preparationLifetime: PrivateHubOpenLifetime | undefined;
  let source = '';
  let constructed = 0;
  let passwordPrompts = 0;
  let biometricQueries = 0;
  let biometricUnlocks = 0;
  const f = fixture({
    prepareHub: (directory, lifetime) => { source = directory; preparationLifetime = lifetime; return prepared.promise; },
    createSession: () => { constructed++; return f.session; },
    requestPassword: async () => { passwordPrompts++; return 'unused secret'; },
    touchIdAvailable: async () => { biometricQueries++; return true; },
  });
  Object.assign(f.session, { unlockWithTouchId: async () => { biometricUnlocks++; return { generation: 7 }; } });
  const opening = f.coordinator.open(f.options);
  assert.equal(source, f.options.directory);
  assert.ok(Object.isFrozen(preparationLifetime));
  assert.equal(constructed, 0);
  assert.equal(f.browser.showCalls, 0);
  assert.deepEqual(f.session.unlockCalls, []);
  const other = fixture();
  assert.equal(await other.coordinator.open(other.options), 'busy');
  prepared.resolve(Object.freeze({ directory: '/main-owned/new-private-hub', password: ' new é secret ' }));
  assert.equal(await opening, 'opened');
  assert.equal(constructed, 1);
  assert.deepEqual(f.session.unlockCalls, [['/main-owned/new-private-hub', ' new é secret ']]);
  assert.equal(preparationLifetime!.signal, f.browserLifetimes[0].signal);
  assert.equal(passwordPrompts, 0);
  assert.equal(biometricQueries, 0);
  assert.equal(biometricUnlocks, 0);
  assert.equal(other.promptLifetimes.length, 0);
  await f.coordinator.cancel();
});

test('late preparation cannot activate a destination after cancellation and holds all admission until drained', async () => {
  const prepared = deferred<PrivateHubPreparedOpen | undefined>();
  let preparationLifetime: PrivateHubOpenLifetime | undefined;
  let constructed = 0;
  const f = fixture({
    prepareHub: (_directory, lifetime) => { preparationLifetime = lifetime; return prepared.promise; },
    createSession: () => { constructed++; return f.session; },
  });
  const opening = f.coordinator.open(f.options);
  const settled = f.coordinator.settled;
  let finished = false;
  void settled.then(() => { finished = true; });
  const cancelling = f.coordinator.cancel();
  assert.equal(cancelling, settled);
  assert.equal(preparationLifetime!.signal.aborted, true);
  assert.equal(preparationLifetime!.isCurrent(), false);
  const other = fixture();
  assert.equal(await other.coordinator.open(other.options), 'busy');
  assert.equal(await f.coordinator.open(f.options), 'busy');
  assert.equal(finished, false);
  prepared.resolve({ directory: '/main-owned/late-private-hub', password: 'late secret' });
  assert.equal(await opening, 'cancelled');
  await cancelling;
  assert.equal(finished, true);
  assert.equal(constructed, 0);
  assert.deepEqual(f.session.unlockCalls, []);
  assert.equal(f.browser.showCalls, 0);
  assert.equal(f.coordinator.status.state, 'idle');
  assert.equal(await other.coordinator.open(other.options), 'opened');
  await other.coordinator.cancel();
});

test('cancelled or invalid prepared destinations never reach session construction', async () => {
  let getterCalls = 0;
  const accessor = { get directory(): string { getterCalls++; return '/synthetic'; }, password: 'secret' };
  const inherited = Object.create({ directory: '/synthetic', password: 'secret' }) as unknown;
  const values: unknown[] = [undefined, null, 42, 'secret', [], {}, inherited, accessor,
    { directory: '/synthetic', password: 'secret', extra: true },
    { directory: '/synthetic', method: 'touch-id' },
    ...['relative', '/a\0b', '/a/../b', '/a/./b', '/a//b', '/a/', '/' + 'a'.repeat(4096), '/' + 'é'.repeat(2048)]
      .map(directory => ({ directory, password: 'secret' })),
    ...['', 'a'.repeat(1025), 'é'.repeat(513), '\ud800', '\udc00', null, 123, { method: 'touch-id' }]
      .map(password => ({ directory: '/synthetic', password })),
  ];
  for (const value of values) {
    let constructed = 0;
    const f = fixture({
      prepareHub: async () => value as PrivateHubPreparedOpen | undefined,
      createSession: () => { constructed++; return f.session; },
    });
    assert.equal(await f.coordinator.open(f.options), value === undefined ? 'cancelled' : 'unavailable');
    assert.equal(constructed, 0);
    assert.equal(f.promptLifetimes.length, 0);
    assert.deepEqual(f.session.unlockCalls, []);
    assert.equal(f.coordinator.status.state, 'idle');
  }
  assert.equal(getterCalls, 0);
});

test('prepared destination and credentials are snapshotted before a reentrant session factory', async () => {
  const prepared = { directory: '/main-owned/prepared-hub', password: 'original secret' };
  const f = fixture({
    prepareHub: async () => prepared,
    createSession: () => {
      prepared.directory = '/main-owned/replacement';
      prepared.password = 'replacement secret';
      return f.session;
    },
  });
  assert.equal(await f.coordinator.open(f.options), 'opened');
  assert.deepEqual(f.session.unlockCalls, [['/main-owned/prepared-hub', 'original secret']]);
  await f.coordinator.cancel();
});

test('authority lost during preparation prevents destination activation', async () => {
  const prepared = deferred<PrivateHubPreparedOpen | undefined>();
  let constructed = 0;
  const f = fixture({ prepareHub: () => prepared.promise, createSession: () => { constructed++; return f.session; } });
  const opening = f.coordinator.open(f.options);
  f.setAuthority(false);
  prepared.resolve({ directory: '/main-owned/prepared-hub', password: 'secret' });
  assert.equal(await opening, 'cancelled');
  assert.equal(constructed, 0);
  assert.equal(f.coordinator.status.state, 'idle');
});

test('proven preparation failures remain generic and release admission after their own drainage', async () => {
  for (const cancel of [false, true]) {
    const prepared = deferred<PrivateHubPreparedOpen | undefined>();
    const failure = new Error('PRIVATE-PREPARATION-PATH-AND-SECRET');
    const controller = new AbortController();
    const f = fixture({ prepareHub: () => prepared.promise, isDisposedFailure: error => error === failure });
    const opening = f.coordinator.open({ ...f.options, signal: controller.signal });
    if (cancel) { controller.abort(); }
    prepared.reject(failure);
    assert.equal(await opening, cancel ? 'cancelled' : 'unavailable');
    assert.deepEqual(f.coordinator.status, { state: 'idle', cleanupFailed: false });
    assert.equal(f.promptLifetimes.length, 0);
    assert.deepEqual(f.session.unlockCalls, []);
  }
});

test('settled is available before the prompt completes and remains pending throughout a live attempt', async () => {
  const prompt = deferred<string | undefined>();
  const f = fixture({ requestPassword: () => prompt.promise });
  const idle = f.coordinator.settled;
  await idle;
  const opening = f.coordinator.open(f.options);
  const settled = f.coordinator.settled;
  let finished = false;
  void settled.then(() => { finished = true; });
  assert.notEqual(settled, idle);
  assert.equal(f.coordinator.settled, settled);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  prompt.resolve('secret');
  assert.equal(await opening, 'opened');
  assert.equal(finished, false);
  assert.equal(f.coordinator.settled, settled);
  const cancelling = f.coordinator.cancel();
  assert.equal(cancelling, settled);
  await settled;
  assert.equal(finished, true);
  assert.equal(f.coordinator.status.state, 'idle');
  assert.equal(f.coordinator.settled, idle);
});

test('cancel invalidates synchronously and holds admission until browser and storage finish', async () => {
  const f = fixture();
  const storage = deferred();
  const browser = deferred();
  f.session.lockGate = storage.promise;
  f.browser.closeGate = browser.promise;
  assert.equal(await f.coordinator.open(f.options), 'opened');
  const settled = f.coordinator.settled;
  let disposalFinished = false;
  void settled.then(() => { disposalFinished = true; });
  let finished = false;
  const cancelling = f.coordinator.cancel().then(() => { finished = true; });
  assert.equal(f.coordinator.status.state, 'closing');
  assert.equal(f.session.current, false);
  assert.equal(f.browser.state, 'closed');
  assert.equal(f.browserLifetimes[0].signal.aborted, true);
  assert.equal(f.browserLifetimes[0].isCurrent(), false);
  assert.equal(f.session.lockCalls, 1);
  assert.equal(f.browser.closeCalls, 1);
  assert.equal(await f.coordinator.open(f.options), 'busy');
  browser.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(disposalFinished, false);
  assert.equal(f.session.closeCalls, 0);
  storage.resolve();
  await cancelling;
  await settled;
  assert.equal(disposalFinished, true);
  assert.equal(f.session.closeCalls, 1);
  assert.equal(f.coordinator.status.state, 'idle');
});

test('a cancelled prompt remains admitted until its own destruction drain settles', async () => {
  const password = deferred<string | undefined>();
  let lifetime: PrivateHubOpenLifetime | undefined;
  let sessionCalls = 0;
  const f = fixture({ requestPassword: value => { lifetime = value; return password.promise; },
    createSession: () => { sessionCalls++; throw new Error('Should not create a session'); } });
  const opening = f.coordinator.open(f.options);
  const settled = f.coordinator.settled;
  let disposalFinished = false;
  void settled.then(() => { disposalFinished = true; });
  const cancelling = f.coordinator.cancel();
  assert.equal(cancelling, settled);
  assert.equal(lifetime!.signal.aborted, true);
  assert.equal(await f.coordinator.open(f.options), 'busy');
  assert.equal(disposalFinished, false);
  password.resolve('late secret');
  assert.equal(await opening, 'cancelled');
  await cancelling;
  assert.equal(disposalFinished, true);
  assert.equal(sessionCalls, 0);
  assert.equal(f.browser.showCalls, 0);
  assert.equal(f.coordinator.status.state, 'idle');
});

test('a cancelled slow unlock is locked immediately and its late result never opens a browser', async () => {
  const session = new FakeSession();
  const storage = deferred();
  session.lockGate = storage.promise;
  const f = fixture({ createSession: () => session });
  const opening = f.coordinator.open(f.options);
  await until(() => session.unlockCalls.length === 1);
  const cancelling = f.coordinator.cancel();
  assert.equal(session.lockCalls, 1);
  assert.equal(session.current, false);
  assert.equal(await f.coordinator.open(f.options), 'busy');
  session.unlockGate.resolve({ generation: 7, catalogue: { secret: 'LATE-CATALOGUE' } });
  storage.resolve();
  assert.equal(await opening, 'cancelled');
  await cancelling;
  assert.equal(f.browserLifetimes.length, 0);
  assert.equal(session.closeCalls, 1);
});

test('a browser returned after cancellation is adopted for cleanup and never shown', async () => {
  const browser = deferred<PrivateHubOpenBrowser>();
  let invoked = false;
  const f = fixture({ createBrowser: () => { invoked = true; return browser.promise; } });
  const opening = f.coordinator.open(f.options);
  await until(() => invoked);
  const cancelling = f.coordinator.cancel();
  assert.equal(f.session.lockCalls, 1);
  assert.equal(f.browser.closeCalls, 0);
  browser.resolve(f.browser);
  assert.equal(await opening, 'cancelled');
  await cancelling;
  assert.equal(f.browser.closeCalls, 1);
  assert.equal(f.browser.showCalls, 0);
});

test('an external signal aborts a pending prompt and its late rejection stays generic', async () => {
  const controller = new AbortController();
  const prompt = deferred<string | undefined>();
  const safeError = new Error('PRIVATE-PATH-AND-SECRET');
  const f = fixture({ requestPassword: () => prompt.promise, isDisposedFailure: error => error === safeError });
  const opening = f.coordinator.open({ ...f.options, signal: controller.signal });
  controller.abort();
  assert.equal(f.coordinator.status.state, 'closing');
  prompt.reject(safeError);
  assert.equal(await opening, 'cancelled');
  assert.equal(f.coordinator.status.state, 'idle');
});

test('native browser closure drains and resets coordinator state', async () => {
  const f = fixture();
  assert.equal(await f.coordinator.open(f.options), 'opened');
  const settled = f.coordinator.settled;
  f.browser.closeExternally();
  await settled;
  assert.equal(f.coordinator.status.state, 'idle');
  assert.equal(f.session.lockCalls, 1);
  assert.equal(f.session.closeCalls, 1);
  assert.equal(f.browser.closeCalls, 1);
});

test('storage revocation closes the browser synchronously and drains the session', async () => {
  const f = fixture();
  assert.equal(await f.coordinator.open(f.options), 'opened');
  f.session.revocation.abort();
  assert.equal(f.browser.state, 'closed');
  assert.equal(f.coordinator.status.state, 'closing');
  await until(() => f.coordinator.status.state === 'idle');
  assert.equal(f.session.closeCalls, 1);
});

test('false or throwing authority cannot prompt or unlock', async () => {
  for (const isAuthorized of [() => false, () => { throw new Error('SECRET'); }]) {
    const f = fixture();
    assert.equal(await f.coordinator.open({ ...f.options, isAuthorized }), 'cancelled');
    assert.equal(f.promptLifetimes.length, 0);
    assert.equal(f.session.unlockCalls.length, 0);
    assert.equal(f.coordinator.status.state, 'idle');
  }
});

test('authority lost during a prompt is checked before session construction', async () => {
  const prompt = deferred<string | undefined>();
  let created = 0;
  const f = fixture({ requestPassword: () => prompt.promise, createSession: () => { created++; return f.session; } });
  const opening = f.coordinator.open(f.options);
  f.setAuthority(false);
  prompt.resolve('synthetic secret');
  assert.equal(await opening, 'cancelled');
  assert.equal(created, 0);
});

test('authority lost during browser startup prevents show and disposes the late browser', async () => {
  const result = deferred<PrivateHubOpenBrowser>();
  let lifetime: PrivateHubOpenLifetime | undefined;
  const f = fixture({ createBrowser: value => { lifetime = value; return result.promise; } });
  const opening = f.coordinator.open(f.options);
  await until(() => !!lifetime);
  f.setAuthority(false);
  assert.equal(lifetime!.isCurrent(), false);
  assert.equal(f.session.current, false);
  result.resolve(f.browser);
  assert.equal(await opening, 'cancelled');
  assert.equal(f.browser.showCalls, 0);
  assert.equal(f.browser.closeCalls, 1);
});

test('live authority callback revokes keys and decoded window before returning false', async () => {
  const f = fixture();
  assert.equal(await f.coordinator.open(f.options), 'opened');
  f.setAuthority(false);
  assert.equal(f.browserLifetimes[0].isCurrent(), false);
  assert.equal(f.session.current, false);
  assert.equal(f.browser.state, 'closed');
  await f.coordinator.cancel();
});

test('reentrant authority cancellation cannot proceed to the prompt', async () => {
  const f = fixture();
  assert.equal(await f.coordinator.open({ ...f.options, isAuthorized: () => { void f.coordinator.cancel(); return true; } }), 'cancelled');
  assert.equal(f.promptLifetimes.length, 0);
  assert.equal(f.coordinator.status.state, 'idle');
});

test('reentrant factory cancellation closes the newly returned session before unlock', async () => {
  const f = fixture({ createSession: () => { void f.coordinator.cancel(); return f.session; } });
  assert.equal(await f.coordinator.open(f.options), 'cancelled');
  assert.equal(f.session.unlockCalls.length, 0);
  assert.equal(f.session.lockCalls, 1);
  assert.equal(f.session.closeCalls, 1);
});

test('invalid or cancelled credentials never reach unlock', async () => {
  const values: unknown[] = [undefined, '', 'a'.repeat(1025), 'é'.repeat(513), '\ud800', '\udc00', null, 123, {}];
  for (const value of values) {
    const f = fixture({ requestPassword: async () => value as string | undefined });
    assert.equal(await f.coordinator.open(f.options), value === undefined ? 'cancelled' : 'unavailable');
    assert.equal(f.session.unlockCalls.length, 0);
    assert.equal(f.coordinator.status.state, 'idle');
  }
});

test('password Unicode and whitespace are preserved exactly within the crypto byte limit', async () => {
  const password = ' é😀' + 'a'.repeat(1016) + ' ';
  assert.equal(Buffer.byteLength(password), 1024);
  const f = fixture({ requestPassword: async () => password });
  assert.equal(await f.coordinator.open(f.options), 'opened');
  assert.equal(f.session.unlockCalls[0][1], password);
  await f.coordinator.cancel();
});

test('admission is shared across coordinators and a fresh attempt follows complete disposal', async () => {
  const first = fixture();
  const second = fixture();
  assert.equal(await first.coordinator.open(first.options), 'opened');
  assert.equal(await second.coordinator.open(second.options), 'busy');
  assert.equal(second.promptLifetimes.length, 0);
  await first.coordinator.cancel();
  assert.equal(await second.coordinator.open(second.options), 'opened');
  await second.coordinator.cancel();
});

test('the same coordinator reopens with fresh resources and old callbacks cannot revoke them', async () => {
  const sessions: FakeSession[] = [];
  const browsers: FakeBrowser[] = [];
  const lifetimes: PrivateHubOpenLifetime[] = [];
  const f = fixture({ createSession: () => {
    const session = new FakeSession();
    session.unlockGate.resolve({ generation: 7 });
    sessions.push(session);
    return session;
  }, createBrowser: async lifetime => {
    lifetimes.push(lifetime);
    const browser = new FakeBrowser();
    browsers.push(browser);
    return browser;
  } });
  assert.equal(await f.coordinator.open(f.options), 'opened');
  const firstSettled = f.coordinator.settled;
  await f.coordinator.cancel();
  assert.equal(await f.coordinator.open(f.options), 'opened');
  assert.notEqual(f.coordinator.settled, firstSettled);
  assert.equal(lifetimes[0].isCurrent(), false);
  assert.equal(lifetimes[1].isCurrent(), true);
  assert.notEqual(lifetimes[0].signal, lifetimes[1].signal);
  assert.equal(sessions[0].current, false);
  assert.equal(sessions[1].current, true);
  assert.equal(browsers[1].state, 'open');
  await f.coordinator.cancel();
});

test('cancellation reentered from show cannot leave an apparently open coordinator', async () => {
  const f = fixture();
  f.browser.show = () => { f.browser.showCalls++; void f.coordinator.cancel(); };
  assert.equal(await f.coordinator.open(f.options), 'cancelled');
  assert.equal(f.coordinator.status.state, 'idle');
  assert.equal(f.browser.state, 'closed');
  assert.equal(f.session.current, false);
});

test('options and dependencies are snapshotted before async handoffs', async () => {
  const prompt = deferred<string | undefined>();
  const session = new FakeSession();
  session.unlockGate.resolve({ generation: 7 });
  const browser = new FakeBrowser();
  const dependencies: PrivateHubOpenDependencies<FakeSession> = {
    requestPassword: () => prompt.promise, createSession: () => session, createBrowser: async () => browser,
  };
  const coordinator = new PrivateHubOpenCoordinator(dependencies);
  const options = { directory: '/original', isAuthorized: () => true };
  const opening = coordinator.open(options);
  options.directory = '/replacement';
  options.isAuthorized = () => false;
  Object.assign(dependencies, { createSession: () => { throw new Error('Replaced'); } });
  prompt.resolve('secret');
  assert.equal(await opening, 'opened');
  assert.equal(session.unlockCalls[0][0], '/original');
  await coordinator.cancel();
});

test('malformed paths, guards and signals fail before any prompt, while pre-abort cancels', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  const values: unknown[] = [undefined, {}, { directory: 'relative', isAuthorized: () => true },
    { directory: '/a\0b', isAuthorized: () => true }, { directory: '/' + 'a'.repeat(4096), isAuthorized: () => true },
    { directory: '/', isAuthorized: true }, { directory: '/', isAuthorized: () => true, signal: {} }];
  for (const value of values) {
    assert.equal(await f.coordinator.open(value as Parameters<typeof f.coordinator.open>[0]), 'unavailable');
  }
  assert.equal(await f.coordinator.open({ ...f.options, signal: controller.signal }), 'cancelled');
  assert.equal(f.promptLifetimes.length, 0);
  await f.coordinator.cancel();
});

test('unlock and browser failures remain generic and release admission after safe disposal', async () => {
  const session = new FakeSession();
  const f = fixture({ createSession: () => session });
  const opening = f.coordinator.open(f.options);
  await until(() => session.unlockCalls.length === 1);
  session.unlockGate.reject(new Error('secret /private/location'));
  assert.equal(await opening, 'unavailable');
  assert.equal(session.closeCalls, 1);
  assert.equal(f.coordinator.status.state, 'idle');
  const safeError = new Error('secret decoded state');
  const browserFailure = fixture({ createBrowser: async () => { throw safeError; }, isDisposedFailure: error => error === safeError });
  assert.equal(await browserFailure.coordinator.open(browserFailure.options), 'unavailable');
  assert.equal(browserFailure.session.current, false);
  assert.equal(browserFailure.session.closeCalls, 1);
});

test('unproven factory rejection, a throwing predicate, or a truthy non-boolean quarantines admission', () => {
  // Each failed cleanup intentionally blocks its entire process. Exercise
  // these independent cases in child processes, with no production reset hook.
  for (const kind of ['prompt', 'browser', 'predicate-throws', 'predicate-truthy', 'cancelled-prompt', 'preparation', 'cancelled-preparation']) {
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', `
      const assert = require('node:assert/strict');
      const { PrivateHubOpenCoordinator } = require('./node/private-hub-open.ts');
      const signal = new AbortController();
      let locks = 0, closes = 0;
      const hub = {
        unlock: async () => ({ generation: 7 }), isCurrent: () => !signal.signal.aborted,
        revocationSignal: () => signal.signal,
        lock: async () => { locks++; signal.abort(); }, close: async () => { closes++; }
      };
      const error = new Error('synthetic factory failure');
      const kind = process.argv[1];
      const cancellation = new AbortController();
      const options = { directory: '/synthetic', isAuthorized: () => true, signal: cancellation.signal };
      const dependencies = {
        createSession: () => hub,
        requestPassword: async () => {
          if (kind === 'cancelled-prompt') cancellation.abort();
          if (kind !== 'browser') throw error;
          return 'secret';
        },
        createBrowser: async () => { throw error; }
      };
      if (kind === 'preparation' || kind === 'cancelled-preparation') dependencies.prepareHub = async () => {
        if (kind === 'cancelled-preparation') cancellation.abort();
        throw error;
      };
      if (kind === 'predicate-throws') dependencies.isDisposedFailure = () => { throw error; };
      if (kind === 'predicate-truthy') dependencies.isDisposedFailure = () => 'true';
      const coordinator = new PrivateHubOpenCoordinator(dependencies);
      (async () => {
        assert.equal(await coordinator.open(options), 'unavailable');
        assert.deepEqual(coordinator.status, { state: 'failed', cleanupFailed: true });
        assert.equal(await coordinator.open(options), 'busy');
        assert.equal(await new PrivateHubOpenCoordinator(dependencies).open(options), 'busy');
        assert.equal(locks, kind === 'browser' ? 1 : 0);
        assert.equal(closes, kind === 'browser' ? 1 : 0);
      })().catch(() => { process.exitCode = 1; });
    `, kind], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.persistence-tests.json',
      TS_NODE_PREFER_TS_EXTS: 'true' }, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, 'Factory cleanup quarantine failed: ' + kind);
  }
});

test('Touch ID uses the main-selected directory without entering the password unlock path', async () => {
  const session = new FakeSession(); const browser = new FakeBrowser();
  let selected = '';
  const hub = Object.assign(session, { unlockWithTouchId: async (directory: string) => { selected = directory; return { generation: 7 }; } });
  const coordinator = new PrivateHubOpenCoordinator({
    createSession: () => hub,
    touchIdAvailable: async (directory, lifetime) => { assert.equal(directory, '/synthetic/hub'); return lifetime.isCurrent(); },
    requestPassword: async lifetime => { assert.equal(await lifetime.touchIdAvailable!(), true); return { method: 'touch-id' }; },
    createBrowser: async () => browser,
  });
  try {
    assert.equal(await coordinator.open({ directory: '/synthetic/hub', isAuthorized: () => true }), 'opened');
    assert.equal(selected, '/synthetic/hub'); assert.deepEqual(session.unlockCalls, []); assert.equal(browser.showCalls, 1);
  } finally { await coordinator.cancel(); }
});

test('an unavailable Touch ID attempt drains and permits a later password attempt', async () => {
  const session = new FakeSession(); let biometric = true;
  const hub = Object.assign(session, { unlockWithTouchId: async () => { throw new Error('Touch ID cancelled'); } });
  const browser = new FakeBrowser();
  const recovery = Object.assign(new FakeSession(), { unlockWithTouchId: hub.unlockWithTouchId });
  recovery.unlockGate.resolve({ generation: 7 });
  const coordinator = new PrivateHubOpenCoordinator({
    createSession: () => biometric ? hub : recovery, touchIdAvailable: async () => true,
    requestPassword: async () => biometric ? { method: 'touch-id' } : 'fallback', createBrowser: async () => browser,
  });
  assert.equal(await coordinator.open({ directory: '/synthetic/hub', isAuthorized: () => true }), 'unavailable');
  assert.equal(coordinator.status.state, 'idle'); assert.equal(session.closeCalls, 1);
  biometric = false;
  assert.equal(await coordinator.open({ directory: '/synthetic/hub', isAuthorized: () => true }), 'opened');
  assert.deepEqual(recovery.unlockCalls, [['/synthetic/hub', 'fallback']]);
  assert.equal(browser.showCalls, 1);
  await coordinator.cancel();
});

// Last because the intended response to uncertain cleanup is process-lifetime
// quarantine, including all other coordinator instances; no reset escape hatch.
test('cleanup failures attempt every owned drain and permanently quarantine admission', async () => {
  const f = fixture();
  const storageFailure = deferred();
  f.session.lockGate = storageFailure.promise;
  f.session.close = () => { f.session.closeCalls++; throw new Error('PRIVATE-CLOSE-FAILURE'); };
  assert.equal(await f.coordinator.open(f.options), 'opened');
  const settled = f.coordinator.settled;
  f.browser.cleanupFailed = true;
  const cancelling = f.coordinator.cancel();
  storageFailure.reject(new Error('PRIVATE-STORAGE-FAILURE'));
  await cancelling;
  await settled;
  assert.equal(f.coordinator.settled, settled);
  assert.deepEqual(f.coordinator.status, { state: 'failed', cleanupFailed: true });
  assert.equal(f.session.closeCalls, 1);
  assert.equal(f.browser.closeCalls, 1);
  assert.equal(await f.coordinator.open(f.options), 'busy');
  const other = fixture();
  assert.equal(await other.coordinator.open(other.options), 'busy');
  assert.equal(other.promptLifetimes.length, 0);
});
