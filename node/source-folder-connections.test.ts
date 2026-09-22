import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SourceFolderConnections,
  type SourceConnectionSession,
  type SourceFolderConnectionDependencies,
} from './source-folder-connections.ts';

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return {
    promise,
    resolve: (value: T) => resolve(value),
    reject: (reason: unknown) => reject(reason),
  };
}

function fixture() {
  let session: SourceConnectionSession | undefined = {
    generation: 1,
    cataloguePath: '/catalogue.scaena',
    sources: [{ index: 0, path: '/media' }],
  };
  let availablePath: string | undefined;
  const changes: { index: number; connected: boolean; canonicalPath?: string }[] = [];
  const errors: unknown[] = [];
  const dependencies: SourceFolderConnectionDependencies = {
    captureSession: () => session,
    isCurrent: (snapshot, source) => snapshot.generation === session?.generation
      && snapshot.cataloguePath === session.cataloguePath
      && session.sources.some(current => current.index === source.index && current.path === source.path),
    probe: async () => availablePath,
    authorize: async () => true,
    connectionChanged: (_snapshot, source, connected, canonicalPath) => {
      changes.push({ index: source.index, connected, canonicalPath });
    },
    reportError: error => errors.push(error),
  };
  const coordinator = new SourceFolderConnections(dependencies);
  return {
    coordinator,
    dependencies,
    changes,
    errors,
    setAvailable: (value?: string) => { availablePath = value; },
    setSession: (value?: SourceConnectionSession) => { session = value; },
    statuses: () => changes.map(change => change.connected),
  };
}

test('a source unavailable at opening is reviewed and connected after it appears', async () => {
  const state = fixture();
  let prompts = 0;
  state.dependencies.authorize = async (_session, source, canonicalPath) => {
    prompts++;
    assert.equal(source.path, '/media');
    assert.equal(canonicalPath, '/mounted-media');
    return true;
  };

  await state.coordinator.refresh();
  await state.coordinator.refresh();
  assert.equal(prompts, 0);
  assert.deepEqual(state.statuses(), [false]);

  state.setAvailable('/mounted-media');
  await state.coordinator.refresh();
  await state.coordinator.refresh();
  assert.equal(prompts, 1);
  assert.deepEqual(state.statuses(), [false, true]);
  assert.equal(state.changes[1].canonicalPath, '/mounted-media');
});

test('authorization can restore a saved grant without asking again', async () => {
  const state = fixture();
  const savedGrants = new Set(['/mounted-media']);
  let permissionPrompts = 0;
  state.dependencies.authorize = async (_session, _source, canonicalPath) => {
    if (savedGrants.has(canonicalPath)) {
      return true;
    }
    permissionPrompts++;
    return false;
  };
  await state.coordinator.refresh();
  state.setAvailable('/mounted-media');
  await state.coordinator.refresh();
  assert.equal(permissionPrompts, 0);
  assert.deepEqual(state.statuses(), [false, true]);
});

test('denied permission never connects and remembered denial prevents repeat prompts', async () => {
  const state = fixture();
  let decision: boolean | undefined;
  let prompts = 0;
  state.dependencies.authorize = async () => {
    if (decision === undefined) {
      prompts++;
      decision = false;
    }
    return decision;
  };
  state.setAvailable('/media');
  await state.coordinator.refresh();
  await state.coordinator.refresh();
  assert.equal(prompts, 1);
  assert.deepEqual(state.statuses(), [false]);
  decision = true;
  await state.coordinator.refresh();
  assert.deepEqual(state.statuses(), [false, true]);
});

test('overlapping refreshes share work and present only one permission review', async () => {
  const state = fixture();
  const review = deferred<boolean>();
  const entered = deferred<void>();
  let prompts = 0;
  state.setAvailable('/media');
  state.dependencies.authorize = async () => {
    prompts++;
    entered.resolve();
    return review.promise;
  };
  const first = state.coordinator.refresh();
  await entered.promise;
  const second = state.coordinator.refresh();
  assert.equal(first, second);
  assert.equal(prompts, 1);
  review.resolve(true);
  await Promise.all([first, second]);
  assert.deepEqual(state.statuses(), [true]);
});

test('source reviews are serial and one failure does not prevent later sources', async () => {
  const state = fixture();
  state.setSession({
    generation: 1,
    cataloguePath: '/catalogue.scaena',
    sources: [{ index: 0, path: '/media' }, { index: 1, path: '/other-media' }],
  });
  const review = deferred<boolean>();
  const entered = deferred<void>();
  const reviewed: number[] = [];
  state.dependencies.probe = async source => source.path;
  state.dependencies.authorize = async (_session, source) => {
    reviewed.push(source.index);
    if (source.index === 0) {
      entered.resolve();
      await review.promise;
      throw new Error('Temporary authorization failure');
    }
    return true;
  };
  const pending = state.coordinator.refresh();
  await entered.promise;
  assert.deepEqual(reviewed, [0]);
  review.resolve(false);
  await pending;
  assert.deepEqual(reviewed, [0, 1]);
  assert.deepEqual(state.statuses(), [false, true]);
  assert.equal(state.errors.length, 1);
});

for (const change of ['catalogue', 'source', 'reset'] as const) {
  test(`a ${change} change while reviewing permission discards the pending result`, async () => {
    const state = fixture();
    const review = deferred<boolean>();
    const entered = deferred<void>();
    state.setAvailable('/media');
    state.dependencies.authorize = async () => {
      entered.resolve();
      return review.promise;
    };
    const pending = state.coordinator.refresh();
    await entered.promise;
    if (change === 'reset') {
      state.coordinator.reset();
    } else {
      state.setSession({
        generation: change === 'catalogue' ? 2 : 1,
        cataloguePath: '/catalogue.scaena',
        sources: [{ index: 0, path: change === 'source' ? '/replacement' : '/media' }],
      });
    }
    review.resolve(true);
    await pending;
    assert.deepEqual(state.changes, []);
    state.dependencies.authorize = async () => true;
    await state.coordinator.refresh();
    assert.deepEqual(state.statuses(), [true]);
  });
}

test('a stale probe cannot request permission for a previous catalogue', async () => {
  const state = fixture();
  const probe = deferred<string | undefined>();
  let prompts = 0;
  state.dependencies.probe = () => probe.promise;
  state.dependencies.authorize = async () => { prompts++; return true; };
  const pending = state.coordinator.refresh();
  state.setSession();
  probe.resolve('/media');
  await pending;
  assert.equal(prompts, 0);
  assert.deepEqual(state.changes, []);
});

for (const replacement of [undefined, '/different-media']) {
  test(`approval does not connect a root that ${replacement ? 'changes identity' : 'disappears'} during review`, async () => {
    const state = fixture();
    state.setAvailable('/media');
    state.dependencies.authorize = async () => {
      state.setAvailable(replacement);
      return true;
    };
    await state.coordinator.refresh();
    assert.deepEqual(state.statuses(), [false]);
  });
}

test('a change during the final probe cannot publish a connection to the old source', async () => {
  const state = fixture();
  const finalProbe = deferred<string | undefined>();
  const entered = deferred<void>();
  let probes = 0;
  state.dependencies.probe = async () => {
    if (++probes === 1) {
      return '/media';
    }
    entered.resolve();
    return finalProbe.promise;
  };
  const pending = state.coordinator.refresh();
  await entered.promise;
  state.setSession();
  finalProbe.resolve('/media');
  await pending;
  assert.deepEqual(state.changes, []);
});

test('connected roots report disconnection and can subsequently reconnect', async () => {
  const state = fixture();
  state.setAvailable('/media');
  await state.coordinator.refresh();
  state.setAvailable();
  await state.coordinator.refresh();
  state.setAvailable('/media');
  await state.coordinator.refresh();
  assert.deepEqual(state.statuses(), [true, false, true]);
});

test('a changed canonical identity disconnects before the replacement is reviewed', async () => {
  const state = fixture();
  state.setAvailable('/media');
  await state.coordinator.refresh();
  state.setAvailable('/replacement');
  state.dependencies.authorize = async (_session, _source, canonicalPath) => {
    assert.deepEqual(state.statuses(), [true, false]);
    assert.equal(canonicalPath, '/replacement');
    return false;
  };
  await state.coordinator.refresh();
  assert.deepEqual(state.statuses(), [true, false]);
});

test('a failed probe reports disconnection and does not prevent a later retry', async () => {
  const state = fixture();
  state.dependencies.probe = async () => { throw new Error('Temporary failure'); };
  await state.coordinator.refresh();
  assert.deepEqual(state.statuses(), [false]);
  assert.equal(state.errors.length, 1);
  state.dependencies.probe = async () => '/media';
  await state.coordinator.refresh();
  assert.deepEqual(state.statuses(), [false, true]);
});

test('new catalogue generations each receive initial connectivity notifications', async () => {
  const state = fixture();
  state.setAvailable('/media');
  await state.coordinator.refresh();
  state.setSession({
    generation: 2,
    cataloguePath: '/catalogue.scaena',
    sources: [{ index: 0, path: '/media' }],
  });
  await state.coordinator.refresh();
  assert.deepEqual(state.statuses(), [true, true]);
});

test('pausing before a cycle starts prevents session capture and further refreshes', async () => {
  const state = fixture();
  let captures = 0;
  state.dependencies.captureSession = () => { captures++; return undefined; };
  const pending = state.coordinator.refresh();
  const drain = state.coordinator.pauseAndDrain();
  assert.equal(drain, pending);
  await Promise.all([pending, drain]);
  state.coordinator.reset();
  await state.coordinator.refresh();
  assert.equal(captures, 0);
  state.coordinator.resume();
  await state.coordinator.refresh();
  assert.equal(captures, 1);
});

test('pausing in session capture includes the registered cycle in the drain', async () => {
  const state = fixture();
  const capture = state.dependencies.captureSession;
  let drain: Promise<void> | undefined;
  let probes = 0;
  state.dependencies.captureSession = () => {
    drain = state.coordinator.pauseAndDrain();
    return capture();
  };
  state.dependencies.probe = async () => { probes++; return '/media'; };
  const pending = state.coordinator.refresh();
  await pending;
  assert.equal(drain, pending);
  assert.equal(probes, 0);
  assert.deepEqual(state.changes, []);
});

for (const rejected of [false, true]) {
  test(`pause waits for a pending probe and discards its ${rejected ? 'error' : 'result'}`, async () => {
    const state = fixture();
    const probe = deferred<string | undefined>();
    const entered = deferred<void>();
    let probes = 0;
    let prompts = 0;
    let drained = false;
    state.dependencies.probe = () => { probes++; entered.resolve(); return probe.promise; };
    state.dependencies.authorize = async () => { prompts++; return true; };
    const pending = state.coordinator.refresh();
    await entered.promise;
    const drain = state.coordinator.pauseAndDrain();
    void drain.then(() => { drained = true; });
    assert.equal(state.coordinator.pauseAndDrain(), drain);
    assert.equal(state.coordinator.refresh(), pending);
    assert.throws(() => state.coordinator.resume(), /still draining/);
    await Promise.resolve();
    assert.equal(drained, false);
    if (rejected) {
      probe.reject(new Error('An old private source path must not be reported.'));
    } else {
      probe.resolve('/media');
    }
    await drain;
    await state.coordinator.refresh();
    assert.equal(drained, true);
    assert.equal(probes, 1);
    assert.equal(prompts, 0);
    assert.deepEqual(state.changes, []);
    assert.deepEqual(state.errors, []);
  });
}

for (const rejected of [false, true]) {
  test(`pause waits for native permission review and discards its ${rejected ? 'error' : 'approval'}`, async () => {
    const state = fixture();
    const review = deferred<boolean>();
    const entered = deferred<void>();
    let probes = 0;
    let prompts = 0;
    let drained = false;
    state.setSession({
      generation: 1,
      cataloguePath: '/catalogue.scaena',
      sources: [{ index: 0, path: '/media' }, { index: 1, path: '/other-media' }],
    });
    state.dependencies.probe = async source => { probes++; return source.path; };
    state.dependencies.authorize = () => { prompts++; entered.resolve(); return review.promise; };
    const pending = state.coordinator.refresh();
    await entered.promise;
    const drain = state.coordinator.pauseAndDrain();
    void drain.then(() => { drained = true; });
    assert.equal(drain, pending);
    await Promise.resolve();
    assert.equal(drained, false);
    if (rejected) {
      review.reject(new Error('Permission review failed for the old source.'));
    } else {
      review.resolve(true);
    }
    await drain;
    assert.equal(drained, true);
    assert.equal(probes, 1);
    assert.equal(prompts, 1);
    assert.deepEqual(state.changes, []);
    assert.deepEqual(state.errors, []);
  });
}

test('pause during the confirmation probe prevents a late connection notification', async () => {
  const state = fixture();
  const confirmation = deferred<string | undefined>();
  const entered = deferred<void>();
  let probes = 0;
  state.dependencies.probe = async () => {
    if (++probes === 1) {
      return '/media';
    }
    entered.resolve();
    return confirmation.promise;
  };
  const pending = state.coordinator.refresh();
  await entered.promise;
  const drain = state.coordinator.pauseAndDrain();
  confirmation.resolve('/media');
  await Promise.all([pending, drain]);
  assert.deepEqual(state.changes, []);
});

test('resuming starts a fresh serial cycle for the current session', async () => {
  const state = fixture();
  state.setAvailable('/media');
  let prompts = 0;
  state.dependencies.authorize = async () => { prompts++; return true; };
  await state.coordinator.refresh();
  await state.coordinator.pauseAndDrain();
  state.setSession({
    generation: 2,
    cataloguePath: '/replacement.scaena',
    sources: [{ index: 1, path: '/replacement' }],
  });
  state.setAvailable('/replacement');
  state.coordinator.reset();
  await state.coordinator.refresh();
  assert.equal(prompts, 1);
  state.coordinator.resume();
  const first = state.coordinator.refresh();
  const second = state.coordinator.refresh();
  assert.equal(first, second);
  await first;
  assert.equal(prompts, 2);
  assert.deepEqual(state.changes, [
    { index: 0, connected: true, canonicalPath: '/media' },
    { index: 1, connected: true, canonicalPath: '/replacement' },
  ]);
});
