import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  reconnectSourceFolder,
  resolveReconnectSourceRoot,
  type SourceFolderRelinkOperations,
  type SourceFolderRelinkState,
} from './source-folder-relink';

const root = '/Users/sm/Workspace/relink-test-fixture';

function fixture() {
  const calls: string[] = [];
  const state: SourceFolderRelinkState = {
    catalogueAccessMode: 'read-write',
    cataloguePersistenceActive: false,
    catalogueSessionGeneration: 4,
    catalogueTransitionActive: false,
    currentlyOpenVhaFile: `${root}/hub.scaena`,
    selectedSourceFolders: {
      0: { path: `${root}/old`, watch: true, ignoredSubdirectories: ['Excluded'] },
      1: { path: `${root}/sibling`, watch: true },
    },
    authorizedCatalogueImageHashes: new Set(['first', 'second']),
    authorizedCatalogueMediaLocations: new Set([
      'first\0' + '0\0/Movies\0movie.mp4',
      'second\0' + '1\0/\0other.mp4',
    ]),
    authorizedSourceFolderPaths: new Set([`${root}/old`, `${root}/sibling`]),
    authorizedSourceFolderRealPaths: new Map([
      [`${root}/old`, `${root}/old`],
      [`${root}/sibling`, `${root}/sibling`],
    ]),
    authorizedSourceWatchPaths: new Set([`${root}/old`, `${root}/sibling`]),
  };
  const operations: SourceFolderRelinkOperations = {
    chooseDirectory: async () => { calls.push('choose'); return `${root}/new`; },
    resolveRoot: async selected => { calls.push('root'); return selected; },
    resolveCatalogueIdentity: async selected => { calls.push('catalogue'); return selected; },
    rememberAccess: (catalogue, source) => { calls.push(`remember:${catalogue}:${source}`); },
    stopSource: index => { calls.push(`stop:${index}`); },
    rebaseSource: (index, oldPath, newPath) => { calls.push(`rebase:${index}:${oldPath}:${newPath}`); },
  };
  return { state, operations, calls };
}

function assertNotCommitted(state: SourceFolderRelinkState, originalSource: unknown, originalAuthority: unknown): void {
  assert.equal(state.selectedSourceFolders[0], originalSource);
  assert.equal(state.authorizedCatalogueMediaLocations, originalAuthority);
  assert.equal(state.authorizedSourceFolderPaths.has(`${root}/new`), false);
}

test('relink changes only the selected source root/watch state and preserves exact media authority', async () => {
  const { state, operations, calls } = fixture();
  const oldSource = state.selectedSourceFolders[0];
  const sibling = state.selectedSourceFolders[1];
  const hashes = state.authorizedCatalogueImageHashes;
  const authority = state.authorizedCatalogueMediaLocations;
  const result = await reconnectSourceFolder(0, state, operations);

  assert.deepEqual(result, {
    status: 'reconnected', sourceIndex: 0, oldPath: `${root}/old`, newPath: `${root}/new`, cataloguePath: `${root}/hub.scaena`,
  });
  assert.deepEqual(state.selectedSourceFolders[0], { ...oldSource, path: `${root}/new`, watch: false });
  assert.equal(state.selectedSourceFolders[1], sibling);
  assert.equal(state.authorizedCatalogueImageHashes, hashes);
  assert.notEqual(state.authorizedCatalogueMediaLocations, authority);
  assert.deepEqual(state.authorizedCatalogueMediaLocations, authority);
  assert.equal(state.authorizedSourceFolderPaths.has(`${root}/old`), false);
  assert.equal(state.authorizedSourceFolderRealPaths.has(`${root}/old`), false);
  assert.equal(state.authorizedSourceWatchPaths.has(`${root}/old`), false);
  assert.equal(state.authorizedSourceFolderPaths.has(`${root}/new`), true);
  assert.equal(state.authorizedSourceFolderRealPaths.get(`${root}/new`), `${root}/new`);
  assert.equal(state.authorizedSourceWatchPaths.has(`${root}/new`), false);
  assert.equal(state.authorizedSourceWatchPaths.has(`${root}/sibling`), true);
  assert.deepEqual(calls.slice(-3), [
    `remember:${root}/hub.scaena:${root}/new`, 'stop:0', `rebase:0:${root}/old:${root}/new`,
  ]);
  assert.equal(calls.filter(call => call === 'root').length, 2);
  assert.equal(calls.some(call => /scan|extract|media/.test(call)), false);
});

test('shared source grants are retained for a sibling that still uses the old root', async () => {
  const { state, operations } = fixture();
  state.selectedSourceFolders[1] = { path: `${root}/old`, watch: true };
  await reconnectSourceFolder(0, state, operations);
  assert.equal(state.authorizedSourceFolderPaths.has(`${root}/old`), true);
  assert.equal(state.authorizedSourceFolderRealPaths.get(`${root}/old`), `${root}/old`);
  assert.equal(state.authorizedSourceWatchPaths.has(`${root}/old`), true);
});

test('a cancelled picker does not change source, authority, permissions or queues', async () => {
  const { state, operations, calls } = fixture();
  const oldSource = state.selectedSourceFolders[0];
  const authority = state.authorizedCatalogueMediaLocations;
  operations.chooseDirectory = async () => undefined;
  assert.deepEqual(await reconnectSourceFolder(0, state, operations), { status: 'cancelled' });
  assertNotCommitted(state, oldSource, authority);
  assert.deepEqual(calls, ['catalogue']);
});

test('invalid, read-only and busy requests are rejected before the picker or filesystem checks', async () => {
  for (const kind of ['index', 'missing-source', 'read-only', 'save', 'transition', 'external-busy']) {
    const { state, operations, calls } = fixture();
    if (kind === 'read-only') { state.catalogueAccessMode = 'read-only'; }
    if (kind === 'save') { state.cataloguePersistenceActive = true; }
    if (kind === 'transition') { state.catalogueTransitionActive = true; }
    if (kind === 'external-busy') { operations.isBusy = () => true; }
    const index = kind === 'index' ? -1 : kind === 'missing-source' ? 99 : 0;
    await assert.rejects(reconnectSourceFolder(index, state, operations), /invalid|no longer|read-only|busy/);
    assert.deepEqual(calls, [], kind);
  }
});

test('state changes while the picker is open cannot commit a stale relink', async () => {
  const changes: ((state: SourceFolderRelinkState) => void)[] = [
    state => { state.catalogueSessionGeneration++; },
    state => { state.currentlyOpenVhaFile = `${root}/other.scaena`; },
    state => { state.authorizedCatalogueMediaLocations = new Set(state.authorizedCatalogueMediaLocations); },
    state => { state.authorizedCatalogueImageHashes = new Set(state.authorizedCatalogueImageHashes); },
    state => { state.selectedSourceFolders[0] = { ...state.selectedSourceFolders[0] }; },
    state => { state.catalogueAccessMode = 'read-only'; },
    state => { state.cataloguePersistenceActive = true; },
    state => { state.catalogueTransitionActive = true; },
  ];
  for (const change of changes) {
    const { state, operations, calls } = fixture();
    operations.chooseDirectory = async () => { change(state); return `${root}/new`; };
    await assert.rejects(reconnectSourceFolder(0, state, operations), /changed|read-only|busy/);
    assert.equal(state.selectedSourceFolders[0].path, `${root}/old`);
    assert.equal(calls.some(call => call.startsWith('remember:') || call.startsWith('stop:') || call.startsWith('rebase:')), false);
  }
});

test('failed directory validation or permission-store writes leave the source and authority unchanged', async () => {
  for (const stage of ['root', 'remember']) {
    const { state, operations, calls } = fixture();
    const oldSource = state.selectedSourceFolders[0];
    const authority = state.authorizedCatalogueMediaLocations;
    if (stage === 'root') { operations.resolveRoot = async () => { throw new Error('Offline source'); }; }
    else { operations.rememberAccess = () => { throw new Error('Permission store unavailable'); }; }
    await assert.rejects(reconnectSourceFolder(0, state, operations), /Offline|unavailable/);
    assertNotCommitted(state, oldSource, authority);
    assert.equal(calls.some(call => call.startsWith('stop:') || call.startsWith('rebase:')), false);
  }
});

test('rechecks both catalogue and selected-directory identities before committing', async () => {
  for (const changedIdentity of ['catalogue', 'root']) {
    const { state, operations, calls } = fixture();
    const oldSource = state.selectedSourceFolders[0];
    const authority = state.authorizedCatalogueMediaLocations;
    let resolutions = 0;
    if (changedIdentity === 'root') {
      operations.resolveRoot = async () => ++resolutions === 1 ? `${root}/new` : `${root}/replacement`;
    } else {
      operations.resolveCatalogueIdentity = async () => ++resolutions === 1 ? `${root}/hub.scaena` : `${root}/replacement.scaena`;
    }
    await assert.rejects(reconnectSourceFolder(0, state, operations), /location changed/);
    assertNotCommitted(state, oldSource, authority);
    assert.equal(calls.some(call => call.startsWith('remember:') || call.startsWith('stop:') || call.startsWith('rebase:')), false);
  }
});

test('rejects filesystem roots, relative picker paths and canonical root redirects without mutation', async () => {
  for (const selected of ['/', 'relative-path', `${root}/link`]) {
    const { state, operations } = fixture();
    const oldSource = state.selectedSourceFolders[0];
    const authority = state.authorizedCatalogueMediaLocations;
    operations.chooseDirectory = async () => selected;
    operations.resolveRoot = async () => '/';
    await assert.rejects(reconnectSourceFolder(0, state, operations), /filesystem root|absolute path/);
    assertNotCommitted(state, oldSource, authority);
  }
  // The default resolver rejects lexical roots without accessing that directory.
  await assert.rejects(resolveReconnectSourceRoot('/'), /filesystem root/);
});


test('stalled filesystem checks time out without committing and ignore late completion', async () => {
  for (const stalledStage of ['catalogue', 'root']) {
    const { state, operations, calls } = fixture();
    const oldSource = state.selectedSourceFolders[0];
    const authority = state.authorizedCatalogueMediaLocations;
    let finish: (value: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    operations.operationTimeoutMs = 5;
    if (stalledStage === 'catalogue') {
      operations.resolveCatalogueIdentity = () => pending;
    } else {
      operations.resolveRoot = () => pending;
    }
    await assert.rejects(reconnectSourceFolder(0, state, operations), /did not respond in time/);
    assertNotCommitted(state, oldSource, authority);
    finish(stalledStage === 'catalogue' ? `${root}/hub.scaena` : `${root}/new`);
    await new Promise<void>(resolve => setImmediate(resolve));
    assertNotCommitted(state, oldSource, authority);
    assert.equal(calls.some(call => call.startsWith('remember:') || call.startsWith('stop:') || call.startsWith('rebase:')), false);
    if (stalledStage === 'catalogue') {
      assert.equal(calls.includes('choose'), false);
    }
  }
});

test('filesystem timeout does not limit the time spent choosing a native directory', async () => {
  const { state, operations } = fixture();
  operations.operationTimeoutMs = 5;
  operations.chooseDirectory = () => new Promise(resolve => setTimeout(() => resolve(`${root}/new`), 20));
  const result = await reconnectSourceFolder(0, state, operations);
  assert.equal(result.status, 'reconnected');
});
