import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { compileIgnoredSubdirectories } from '../interfaces/source-folder-path';
import { rebaseKnownSourcePaths } from './source-folder-cache';
import { SourceScanIoGate } from './source-scan-io';
import { SourceWorkLifecycle } from './source-work-lifecycle';
import {
  resolveSourceScanMediaPath,
  resolveSourceScanScope,
  validateSourceScanEntries,
} from './source-scan-validation';
import type { SourceScanFileSystem, SourceScanGuard } from './source-scan-validation';

const options = {
  allowedExtensions: ['mp4'],
  ignoredSubdirectories: compileIgnoredSubdirectories([]),
  maxMediaFiles: 100,
};
const root = path.resolve('/synthetic-source');
const stats = {
  dev: 1, ino: 1,
  isDirectory: () => true,
  isFile: () => false,
};

function guard(fileSystem?: SourceScanFileSystem): SourceScanGuard {
  return {
    configuredRoot: root,
    canonicalRoot: root,
    isCurrent: () => true,
    fileSystem: fileSystem || {
      realpath: async value => value,
      stat: async () => stats,
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve: (value: T) => resolve(value) };
}

test('bounded asynchronous validation leaves the event loop responsive during slow filesystem IO', async () => {
  let active = 0;
  let maximumActive = 0;
  let heartbeats = 0;
  const delayed = async <T>(value: T): Promise<T> => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return value;
  };
  const heartbeat = setInterval(() => heartbeats++, 1);
  try {
    const paths = Array.from({ length: 32 }, (_, index) => path.join(root, `${index}.mp4`));
    const result = await validateSourceScanEntries(paths, guard({
      realpath: value => delayed(value),
      stat: () => delayed(stats),
    }), { ...options, concurrency: 4 });
    assert.equal(result.snapshot.size, 32);
    assert.ok(maximumActive <= 4, `Observed ${maximumActive} concurrent filesystem operations`);
    assert.ok(maximumActive > 1, 'Validation should use bounded parallelism');
    assert.ok(heartbeats > 10, 'The main event loop must advance while network reads are pending');
  } finally {
    clearInterval(heartbeat);
  }
});

test('real filesystem validation rejects a media symlink outside the authorized source', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'source-scan-validation-'));
  const source = path.join(temporary, 'source');
  const outside = path.join(temporary, 'outside.mp4');
  fs.mkdirSync(source);
  fs.writeFileSync(outside, 'Synthetic outside media');
  fs.symlinkSync(outside, path.join(source, 'linked.mp4'));
  try {
    await assert.rejects(resolveSourceScanMediaPath({
      configuredRoot: source,
      canonicalRoot: fs.realpathSync.native(source),
      isCurrent: () => true,
    }, '', 'linked.mp4'), /outside its authorized source/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'Synthetic outside media');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('a changed canonical source root during candidate resolution invalidates the whole scan', async () => {
  let changed = false;
  const file = path.join(root, 'video.mp4');
  await assert.rejects(validateSourceScanEntries([file], guard({
    realpath: async value => {
      if (value === file) {
        changed = true;
        return value;
      }
      return changed ? path.resolve('/replacement-source') : root;
    },
    stat: async () => stats,
  }), options), /identity changed/);
});

test('authorization revoked during pending IO prevents candidate publication', async () => {
  let current = true;
  const file = path.join(root, 'video.mp4');
  const scope = guard({
    realpath: async value => {
      if (value === file) current = false;
      return value;
    },
    stat: async () => stats,
  });
  await assert.rejects(validateSourceScanEntries([file], {
    ...scope, isCurrent: () => current,
  }, options), /cancelled or its authorization changed/);
});

test('cancellation releases a blocked network lookup and late completion cannot publish progress', async () => {
  const pending = deferred<string>();
  const controller = new AbortController();
  let progressCalls = 0;
  const operation = validateSourceScanEntries([path.join(root, 'video.mp4')], {
    ...guard({ realpath: () => pending.promise, stat: async () => stats }),
    signal: controller.signal,
  }, { ...options, onProgress: () => progressCalls++ });
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  pending.resolve(root);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progressCalls, 0);
});

test('an IO failure never yields an authoritative partial snapshot', async () => {
  const paths = ['good.mp4', 'offline.mp4'].map(name => path.join(root, name));
  let completed = false;
  const operation = validateSourceScanEntries(paths, guard({
    realpath: async value => {
      if (value === paths[1]) throw new Error('Network share disconnected');
      return value;
    },
    stat: async () => stats,
  }), { ...options, concurrency: 1 }).then(result => { completed = true; return result; });
  await assert.rejects(operation, /Network share disconnected/);
  assert.equal(completed, false);
});

test('excluded scopes and unrelated files are not validated and media limits reject a broad scan', async () => {
  const resolved: string[] = [];
  const scope = guard({
    realpath: async value => { resolved.push(value); return value; },
    stat: async () => stats,
  });
  const excluded = path.join(root, 'Ignore', 'video.mp4');
  const unrelated = path.join(root, 'document.txt');
  const kept = path.join(root, 'Keep', 'video.mp4');
  const result = await validateSourceScanEntries([excluded, unrelated, kept], scope, {
    ...options, ignoredSubdirectories: compileIgnoredSubdirectories(['Ignore']),
  });
  assert.deepEqual([...result.snapshot.keys()], [kept]);
  assert.equal(resolved.includes(excluded), false);
  assert.equal(resolved.includes(unrelated), false);
  await assert.rejects(validateSourceScanEntries([kept], scope, {
    ...options, maxMediaFiles: 1,
  }), /at least 1 media files/);
});

test('source cache rebasing is lexical, keeps relative filenames and invalidates ambiguous physical keys', () => {
  const oldRoot = path.resolve('/old-mount/media');
  const newRoot = path.resolve('/new-mount/media');
  const old = path.join(oldRoot, 'nested', 'video.mp4');
  const unrelatedPrefix = path.join(oldRoot + '-other', 'video.mp4');
  const original = new Set([old, unrelatedPrefix]);
  const result = rebaseKnownSourcePaths(original, oldRoot, newRoot);
  const replacement = path.join(newRoot, 'nested', 'video.mp4');
  assert.deepEqual([...result.paths], [replacement]);
  assert.equal(result.replacements.get(old), replacement);
  assert.equal(result.invalidatedPhysicalKeys.has(old), true);
  assert.equal(result.invalidatedPhysicalKeys.has(replacement), true);
  assert.deepEqual([...original], [old, unrelatedPrefix]);
});


test('scope selection rejects absolute/traversal paths before IO and accepts a contained directory', async () => {
  let reads = 0;
  const scope = guard({
    realpath: async value => { reads++; return value; },
    stat: async () => stats,
  });
  await assert.rejects(resolveSourceScanScope(scope, '../other'), /cannot leave/);
  await assert.rejects(resolveSourceScanScope(scope, '/other'), /root-relative/);
  assert.equal(reads, 0);
  assert.equal(await resolveSourceScanScope(scope, 'nested'), path.join(root, 'nested'));
});

test('a scoped scan rejects directories resolving outside the authorized source', async () => {
  const nested = path.join(root, 'nested');
  await assert.rejects(resolveSourceScanScope(guard({
    realpath: async value => value === nested ? path.resolve('/outside') : value,
    stat: async () => stats,
  }), 'nested'), /outside its authorized source/);
});

test('a stalled network lookup has a finite wait and does not publish a snapshot', async () => {
  const pending = deferred<string>();
  const operation = validateSourceScanEntries([path.join(root, 'video.mp4')], {
    ...guard({ realpath: () => pending.promise, stat: async () => stats }),
    operationTimeoutMs: 5,
  }, options);
  await assert.rejects(operation, /filesystem operation timed out/);
  pending.resolve(root);
});


test('cancelled and timed-out native IO holds its admission slot across repeated retries', async () => {
  const gate = new SourceScanIoGate(1, 2);
  const pending = deferred<string>();
  const controller = new AbortController();
  let nativeCalls = 0;
  const first = gate.run({ isCurrent: () => true, signal: controller.signal }, () => {
    nativeCalls++;
    return pending.promise;
  });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeCalls, 1);
  controller.abort();
  await firstRejected;
  assert.deepEqual(gate.state, { active: 1, pending: 0 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(gate.run({ isCurrent: () => true, operationTimeoutMs: 5 }, async () => {
      nativeCalls++;
      return 'must not run yet';
    }), /timed out/);
    assert.equal(nativeCalls, 1, 'Retries must not submit native IO behind a stalled operation');
    assert.deepEqual(gate.state, { active: 1, pending: 0 });
  }
  pending.resolve('late completion');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(gate.state, { active: 0, pending: 0 });
  assert.equal(await gate.run({ isCurrent: () => true }, async () => 'new operation'), 'new operation');
});

test('pending cancellation removes admission work without disturbing another source', async () => {
  const gate = new SourceScanIoGate(1, 1);
  const pending = deferred<string>();
  const active = gate.run({ isCurrent: () => true }, () => pending.promise);
  const controller = new AbortController();
  let unwantedCalls = 0;
  const queued = gate.run({ isCurrent: () => true, signal: controller.signal }, async () => {
    unwantedCalls++;
    return 'cancelled';
  });
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(unwantedCalls, 0);
  assert.deepEqual(gate.state, { active: 1, pending: 0 });
  pending.resolve('unrelated source completed');
  assert.equal(await active, 'unrelated source completed');
});

test('late cancelled preview completions cannot clear newer markers or affect other sources', () => {
  const work = new SourceWorkLifecycle();
  const old = work.beginPreview(0, 'same-hash');
  const other = work.beginPreview(1, 'other-hash');
  assert.deepEqual(work.cancelSource(0), ['same-hash']);
  const current = work.beginPreview(0, 'same-hash');
  assert.equal(work.isCurrent(0, old.generation), false);
  assert.equal(work.finishPreview(old), false, 'Old completion must not own the replacement hash marker');
  assert.equal(work.finishPreview(current), true);
  assert.equal(work.finishPreview(other), true, 'Other source work remains current');
});

test('a replaced preview token is not confused with another catalogue using the same source generation', () => {
  const work = new SourceWorkLifecycle();
  const old = work.beginPreview(0, 'same-hash');
  const current = work.beginPreview(0, 'same-hash');
  assert.equal(work.finishPreview(old), false);
  assert.equal(work.finishPreview(current), true);
});


test('relinking a Windows catalogue on a POSIX host rebases historical cache paths without IO', () => {
  if (process.platform === 'win32') {
    return;
  }
  const newRoot = path.resolve('/replacement-source');
  const result = rebaseKnownSourcePaths(new Set([
    'C:\\Videos/subfolder/video.mp4',
    'C:\\Other/outside.mp4',
  ]), 'C:\\Videos', newRoot);
  assert.deepEqual([...result.paths], [path.join(newRoot, 'subfolder', 'video.mp4')]);
  assert.equal(rebaseKnownSourcePaths(new Set(['invalid/video.mp4']), 'invalid', newRoot).paths.size, 0);
});
