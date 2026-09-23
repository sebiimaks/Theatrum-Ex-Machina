import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { isPrivateHubLeaseCleanupFailure, PRIVATE_HUB_LOCK_FILE, PrivateHubLease, PrivateHubLeaseError } from './private-hub-lock.ts';

const root = path.resolve(__dirname, '..');

async function fixture(t: TestContext): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(root, '.private-hub-lock-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

function contender(directory: string): childProcess.ChildProcess {
  return childProcess.spawn(process.execPath, [
    '-r', require.resolve('ts-node/register'), '-e', `
      const { PrivateHubLease } = require('./node/private-hub-lock.ts');
      PrivateHubLease.acquire(process.argv[1]).then(lease => {
        process.send({ ready: true });
        process.on('message', async () => {
          await lease.release();
          process.disconnect();
        });
      }).catch(error => {
        process.send({ error: error.code || error.message });
        process.disconnect();
      });
    `, directory,
  ], {
    cwd: root,
    env: { ...process.env, TS_NODE_PROJECT: path.join(root, 'tsconfig.persistence-tests.json'), TS_NODE_PREFER_TS_EXTS: 'true' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
}

async function reacquire(directory: string): Promise<PrivateHubLease> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await PrivateHubLease.acquire(directory);
    } catch (error) {
      if (!(error instanceof PrivateHubLeaseError)) {
        throw error;
      }
      await delay(10);
    }
  }
  throw new Error('The kernel lock was not released after the synthetic crash.');
}

test('independent helpers contend for one persistent inode and concurrent release is idempotent', async t => {
  const directory = await fixture(t);
  const first = await PrivateHubLease.acquire(directory);
  t.after(() => first.release());
  const file = path.join(directory, PRIVATE_HUB_LOCK_FILE);
  const before = await fs.promises.stat(file);
  await assert.rejects(PrivateHubLease.acquire(directory), PrivateHubLeaseError);
  const release = first.release();
  assert.equal(first.release(), release);
  await release;
  const second = await PrivateHubLease.acquire(directory);
  t.after(() => second.release());
  await first.release();
  await second.assertOwned();
  const after = await fs.promises.stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, 0);
  assert.equal(after.mode & 0o777, 0o600);
});

test('independent Node processes cannot acquire simultaneously', async t => {
  const directory = await fixture(t);
  const first = contender(directory);
  const second = contender(directory);
  t.after(() => { first.kill('SIGKILL'); second.kill('SIGKILL'); });
  const outcomes = await Promise.all([once(first, 'message'), once(second, 'message')]);
  assert.equal(outcomes.filter(([message]) => message.ready).length, 1);
  assert.equal(outcomes.filter(([message]) => message.error === 'PRIVATE_HUB_LEASE_EXISTS').length, 1);
  const winner = outcomes[0][0].ready ? first : second;
  const closed = once(winner, 'close');
  winner.send('release');
  await closed;
  const reopened = await reacquire(directory);
  await reopened.release();
});

test('killing the owning Node process releases its helper lock without deleting the lock file', async t => {
  const directory = await fixture(t);
  const owner = contender(directory);
  t.after(() => owner.kill('SIGKILL'));
  assert.equal((await once(owner, 'message'))[0].ready, true);
  const before = await fs.promises.stat(path.join(directory, PRIVATE_HUB_LOCK_FILE));
  const ended = once(owner, 'close');
  owner.kill('SIGKILL');
  await ended;
  const reopened = await reacquire(directory);
  await reopened.release();
  assert.equal((await fs.promises.stat(path.join(directory, PRIVATE_HUB_LOCK_FILE))).ino, before.ino);
});

test('helper death invalidates the owning lease and allows fresh acquisition', async t => {
  const directory = await fixture(t);
  const originalSpawn = childProcess.spawn;
  let helper: childProcess.ChildProcess | undefined;
  const mock = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    helper = originalSpawn(...args);
    return helper;
  });
  const lease = await PrivateHubLease.acquire(directory);
  mock.mock.restore();
  t.after(() => lease.release());
  const lost = once(lease.lostSignal, 'abort');
  helper!.kill('SIGKILL');
  await lost;
  await assert.rejects(lease.assertOwned(), /lock was lost/);
  await assert.rejects(PrivateHubLease.acquire(directory), PrivateHubLeaseError, 'the parent retains the shared lock until release');
  await lease.release();
  const reopened = await reacquire(directory);
  await reopened.release();
});

test('linked, nonempty, permissive and replaced lock paths fail closed without deleting user data', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, PRIVATE_HUB_LOCK_FILE);
  const unrelated = path.join(directory, 'unrelated');
  await fs.promises.writeFile(unrelated, 'keep', { mode: 0o600 });
  await fs.promises.symlink(unrelated, file);
  await assert.rejects(PrivateHubLease.acquire(directory));
  assert.equal(await fs.promises.readFile(unrelated, 'utf8'), 'keep');
  await fs.promises.unlink(file);
  await fs.promises.link(unrelated, file);
  await assert.rejects(PrivateHubLease.acquire(directory));
  await fs.promises.unlink(file);
  await fs.promises.writeFile(file, 'unknown previous data', { mode: 0o600 });
  await assert.rejects(PrivateHubLease.acquire(directory));
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'unknown previous data');
  await fs.promises.unlink(file);
  await fs.promises.writeFile(file, '', { mode: 0o644 });
  await fs.promises.chmod(file, 0o644);
  await assert.rejects(PrivateHubLease.acquire(directory));
  await fs.promises.chmod(file, 0o600);
  const lease = await PrivateHubLease.acquire(directory);
  await fs.promises.rename(file, file + '.original');
  await fs.promises.writeFile(file, 'replacement', { mode: 0o600 });
  await assert.rejects(lease.assertOwned(), /replaced or changed/);
  await lease.release();
  assert.equal(await fs.promises.readFile(file, 'utf8'), 'replacement');
  assert.equal(await fs.promises.readFile(file + '.original', 'utf8'), '');
});

test('missing helper and invalid handshake fail without leaking a child process', async t => {
  const directory = await fixture(t);
  const originalSpawn = childProcess.spawn;
  let child: childProcess.ChildProcess | undefined;
  const missing = t.mock.method(childProcess, 'spawn', () => {
    child = originalSpawn(path.join(directory, 'missing-helper'), [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    return child;
  });
  await assert.rejects(PrivateHubLease.acquire(directory), /unavailable/);
  missing.mock.restore();
  const invalid = t.mock.method(childProcess, 'spawn', () => {
    child = originalSpawn(process.execPath, ['-e', "process.stdout.write('INVALID\\n'); process.stdin.resume();"], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return child;
  });
  await assert.rejects(PrivateHubLease.acquire(directory), /valid storage lock/);
  invalid.mock.restore();
  assert.notEqual(child!.exitCode, null);
});

test('pausing the owning process never transfers its lock to another opener', async t => {
  const directory = await fixture(t);
  const owner = contender(directory);
  t.after(() => owner.kill('SIGKILL'));
  assert.equal((await once(owner, 'message'))[0].ready, true);
  owner.kill('SIGSTOP');
  try {
    await assert.rejects(PrivateHubLease.acquire(directory), PrivateHubLeaseError);
  } finally {
    owner.kill('SIGCONT');
  }
  const ended = once(owner, 'close');
  owner.send('release');
  await ended;
  const reopened = await reacquire(directory);
  await reopened.release();
});

test('an unresponsive helper is killed after bounded startup and release timeouts', async t => {
  const directory = await fixture(t);
  const originalSpawn = childProcess.spawn;
  let child: childProcess.ChildProcess | undefined;
  const mock = t.mock.method(childProcess, 'spawn', () => {
    child = originalSpawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return child;
  });
  await assert.rejects(PrivateHubLease.acquire(directory), /startup timed out/);
  mock.mock.restore();
  assert.equal(child!.signalCode, 'SIGKILL');
});

test('unsupported filesystem response is clear and unexpected post-ready output invalidates ownership', async t => {
  const directory = await fixture(t);
  const originalSpawn = childProcess.spawn;
  const unsupported = t.mock.method(childProcess, 'spawn', () => originalSpawn(process.execPath,
    ['-e', "process.stdout.write('UNSUPPORTED_FS\\n');"], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }));
  await assert.rejects(PrivateHubLease.acquire(directory), /supported local filesystem/);
  unsupported.mock.restore();
  const file = path.join(directory, PRIVATE_HUB_LOCK_FILE);
  await fs.promises.writeFile(file, '', { mode: 0o600 });
  const stat = await fs.promises.stat(file);
  const extra = t.mock.method(childProcess, 'spawn', () => originalSpawn(process.execPath,
    ['-e', `process.stdout.write('READY ${stat.dev} ${stat.ino}\\n');
      process.stdin.resume(); setTimeout(() => process.stdout.write('unexpected'), 100);`],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }));
  const lease = await PrivateHubLease.acquire(directory);
  extra.mock.restore();
  await once(lease.lostSignal, 'abort');
  await assert.rejects(lease.assertOwned(), /lock was lost/);
  await lease.release();
});

function shortCleanupDeadlines(t: TestContext): void {
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) =>
    schedule(callback, milliseconds === 5_000 ? 50 : milliseconds === 10_000 ? 100 : milliseconds, ...args));
}

function unconfirmedHelper(t: TestContext, response: string): { child: EventEmitter; kills: () => number } {
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null,
    kill: () => { kills++; return false; },
  });
  t.mock.method(childProcess, 'spawn', () => {
    process.nextTick(() => child.stdout.emit('data', Buffer.from(response)));
    return child;
  });
  return { child, kills: () => kills };
}

test('pre-helper refusal is ordinary only when its owned descriptor closes successfully', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, PRIVATE_HUB_LOCK_FILE);
  await fs.promises.writeFile(file, 'invalid lock contents', { mode: 0o600 });
  await assert.rejects(PrivateHubLease.acquire(directory), error => !isPrivateHubLeaseCleanupFailure(error));
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); throw new Error('synthetic close failure'); });
    return handle;
  });
  await assert.rejects(PrivateHubLease.acquire(directory), error => {
    assert.ok(isPrivateHubLeaseCleanupFailure(error));
    assert.equal(isPrivateHubLeaseCleanupFailure(new Error(error.message)), false);
    assert.equal(isPrivateHubLeaseCleanupFailure({ message: error.message }), false);
    return true;
  });
});

test('parent descriptor rejection remains the same branded failure on every release', async t => {
  const directory = await fixture(t);
  const open = fs.promises.open;
  let closes = 0;
  const capture = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { closes++; await close(); throw new Error('synthetic close failure'); });
    return handle;
  });
  const lease = await PrivateHubLease.acquire(directory);
  capture.mock.restore();
  const release = lease.release();
  let failure: unknown;
  await assert.rejects(release, error => { failure = error; return isPrivateHubLeaseCleanupFailure(error); });
  assert.equal(lease.lostSignal.aborted, true);
  assert.equal(lease.release(), release);
  await assert.rejects(lease.release(), error => error === failure);
  assert.equal(closes, 1);
});

test('descriptor-close timeout cannot be reset by its later successful settlement', async t => {
  const directory = await fixture(t);
  const open = fs.promises.open;
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  const capture = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); await delayed; });
    return handle;
  });
  const lease = await PrivateHubLease.acquire(directory);
  capture.mock.restore();
  shortCleanupDeadlines(t);
  const release = lease.release();
  let failure: unknown;
  await assert.rejects(release, error => { failure = error; return isPrivateHubLeaseCleanupFailure(error); });
  finish();
  await delayed;
  assert.equal(lease.release(), release);
  await assert.rejects(lease.release(), error => error === failure);
  assert.equal(lease.lostSignal.aborted, true);
});

test('unconfirmed helper exit attempts descriptor closure and stays failed after late exit', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, PRIVATE_HUB_LOCK_FILE);
  await fs.promises.writeFile(file, '', { mode: 0o600 });
  const stat = await fs.promises.stat(file);
  const helper = unconfirmedHelper(t, `READY ${stat.dev} ${stat.ino}\n`);
  const open = fs.promises.open;
  let closes = 0;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { closes++; await close(); });
    return handle;
  });
  const lease = await PrivateHubLease.acquire(directory);
  shortCleanupDeadlines(t);
  const release = lease.release();
  let failure: unknown;
  await assert.rejects(release, error => { failure = error; return isPrivateHubLeaseCleanupFailure(error); });
  assert.equal(helper.kills(), 1);
  assert.equal(closes, 1);
  helper.child.emit('exit');
  helper.child.emit('close');
  assert.equal(lease.release(), release);
  await assert.rejects(lease.release(), error => error === failure);
});

test('failed handshake propagates unconfirmed helper cleanup before any lease is returned', async t => {
  const directory = await fixture(t);
  const helper = unconfirmedHelper(t, 'INVALID\n');
  shortCleanupDeadlines(t);
  let failure: unknown;
  await assert.rejects(PrivateHubLease.acquire(directory), error => {
    failure = error;
    return isPrivateHubLeaseCleanupFailure(error);
  });
  assert.equal(helper.kills(), 1);
  helper.child.emit('close');
  assert.ok(isPrivateHubLeaseCleanupFailure(failure));
});
