import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { readPrivateHubCatalogue, writePrivateHubCatalogue } from './private-hub-catalogue';
import { PrivateHubLeaseError } from './private-hub-lock';
import { PrivateHubStore } from './private-hub-store';

const checkout = fs.realpathSync(path.resolve(__dirname, '..'));
const password = 'Synthetic interrupted save passphrase';
const marker = 'PRIVATE_SAVE_INTERRUPTION_CANARY';
const cases = [
  { stage: 'before-backup', primary: 'B', backup: 'A', pending: 1 },
  { stage: 'after-backup', primary: 'B', backup: 'B', pending: 0 },
  { stage: 'before-primary', primary: 'B', backup: 'B', pending: 1 },
  { stage: 'after-primary', primary: 'C', backup: 'B', pending: 0 },
] as const;

async function within<T>(pending: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Interrupted-save test checkpoint timed out.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function catalogue(root: string, revision: string): FinalObject {
  return {
    addTags: [], removeTags: [], hubName: marker + revision, numOfFolders: 1, version: 3,
    images: [{ ...NewImageElement(), hash: 'synthetic-video', fileName: marker + '.mp4',
      notes: marker + revision, tags: [marker + revision], timesPlayed: 4, lastPlayed: 123456 }],
    inputDirs: { 0: { path: path.join(root, marker), watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 3, fixed: true, height: 144, n: 3 },
  };
}

async function snapshot(directory: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const stat = await fs.promises.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.nlink, 1);
    result.set(name, await fs.promises.readFile(file));
  }
  return result;
}

async function assertPrivate(directory: string): Promise<void> {
  for (const [name, bytes] of await snapshot(directory)) {
    for (const secret of [marker, password]) {
      assert.equal(name.includes(secret), false);
      for (const encoding of ['utf8', 'utf16le'] as const) {
        assert.equal(bytes.includes(Buffer.from(secret, encoding)), false, 'Interrupted saves must leave only encrypted content.');
      }
    }
  }
}

async function assertHelperExited(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return; }
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The interrupted writer lock helper did not exit.');
}

function writer(root: string, stage: typeof cases[number]['stage']) {
  const child = spawn(process.execPath, ['-r', require.resolve('ts-node/register'),
    path.join(checkout, 'node/private-save-interruption-child.cjs')], {
    cwd: checkout,
    env: { ...process.env, TS_NODE_PROJECT: path.join(checkout, 'tsconfig.persistence-tests.json'), TS_NODE_PREFER_TS_EXTS: 'true' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let closed = false;
  let helperPid: number | undefined;
  let outputBytes = 0;
  child.stdout!.on('data', (bytes: Buffer) => { outputBytes += bytes.length; });
  child.stderr!.on('data', (bytes: Buffer) => { outputBytes += bytes.length; });
  const closure = new Promise<void>(resolve => { child.once('close', () => { closed = true; resolve(); }); });
  const checkpoint = new Promise<void>((resolve, reject) => {
    const failure = () => reject(new Error('Interrupted-save writer failed before its checkpoint.'));
    child.once('error', failure);
    child.once('close', failure);
    child.on('message', message => {
      const value = message as { type?: string; stage?: string; helperPid?: number };
      if (!Number.isInteger(value?.helperPid)
        || value.helperPid! <= 1 || value.helperPid === process.pid || value.helperPid === child.pid) { failure(); return; }
      if (value.type === 'helper' && helperPid === undefined) { helperPid = value.helperPid; return; }
      if (value.type !== 'checkpoint' || value.stage !== stage || helperPid !== value.helperPid) { failure(); return; }
      resolve();
    });
    child.send({ root, stage, password, catalogue: catalogue(root, 'C') }, error => { if (error) { failure(); } });
  });
  // Install rejection handling immediately, including fixture/assertion failures
  // before the test awaits the checkpoint. Cleanup always owns this exact child.
  void checkpoint.catch(() => undefined);
  const kill = (owned: ChildProcess): void => {
    if (!closed && owned.exitCode === null && owned.signalCode === null) { owned.kill('SIGKILL'); }
  };
  let disposal: Promise<void> | undefined;
  return {
    child,
    ready: () => within(checkpoint, 15_000),
    dispose: () => disposal ??= (async () => {
      kill(child);
      await within(closure);
      if (helperPid !== undefined) { await assertHelperExited(helperPid); }
    })(),
    assertKilled: () => {
      assert.ok(closed, 'The writer must be reaped before opening another session.');
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(outputBytes, 0, 'The child must not log passwords, catalogue contents, or paths.');
    },
  };
}

for (const entry of cases) {
  test(`real save interruption ${entry.stage} preserves authenticated primary and backup revisions`,
    { skip: !['darwin', 'linux'].includes(process.platform), timeout: 30_000 }, async () => {
      const temporaryRoot = path.join(checkout, 'tmp');
      await fs.promises.mkdir(temporaryRoot, { recursive: true });
      assert.equal(await fs.promises.realpath(temporaryRoot), temporaryRoot, 'Synthetic fixtures must stay in the checkout.');
      const root = await fs.promises.mkdtemp(path.join(checkout, 'tmp/private-save-interruption-'));
      const directory = path.join(root, 'hub');
      let store: PrivateHubStore | undefined;
      let active: ReturnType<typeof writer> | undefined;
      try {
        store = await PrivateHubStore.create(directory, password);
        await writePrivateHubCatalogue(store, catalogue(root, 'A'));
        await writePrivateHubCatalogue(store, catalogue(root, 'B'));
        await store.lock(); store = undefined;
        const primary = (await fs.promises.readdir(directory)).find(name => /^[0-9a-f]{64}\.sealed$/.test(name));
        assert.ok(primary);
        // Unrelated files are not repair candidates, even with a pending suffix.
        const unrelated = 'unrelated.pending';
        await fs.promises.writeFile(path.join(directory, unrelated), randomBytes(48), { flag: 'wx', mode: 0o600 });
        active = writer(root, entry.stage);
        await active.ready();
        await assert.rejects(PrivateHubStore.open(directory, password), PrivateHubLeaseError,
          'The real child-held advisory lock must reject a second opener.');
        const held = await snapshot(directory);
        assert.equal([...held.keys()].filter(name => name !== unrelated && name.endsWith('.pending')).length, entry.pending);
        await assertPrivate(directory);
        await active.dispose(); active.assertKilled();

        // The fresh helper can obtain the lease after actual process death. Its
        // authenticated read must neither promote nor remove a one-link orphan.
        store = await PrivateHubStore.open(directory, password);
        assert.deepEqual(await readPrivateHubCatalogue(store), catalogue(root, entry.primary));
        const backup = await store.readBackupRecord('catalogue');
        try { assert.deepEqual(JSON.parse(backup.toString()), catalogue(root, entry.backup)); } finally { backup.fill(0); }
        assert.deepEqual(await snapshot(directory), held);
        await writePrivateHubCatalogue(store, catalogue(root, 'D'));
        assert.deepEqual(await readPrivateHubCatalogue(store), catalogue(root, 'D'));
        const after = await snapshot(directory);
        assert.deepEqual([...after.keys()], [...held.keys()]);
        for (const [name, bytes] of held) {
          if (name !== primary && name !== primary + '.bak') { assert.deepEqual(after.get(name), bytes); }
        }
        await store.lock(); store = await PrivateHubStore.open(directory, password);
        assert.deepEqual(await readPrivateHubCatalogue(store), catalogue(root, 'D'));
        const recoveredBackup = await store.readBackupRecord('catalogue');
        try { assert.deepEqual(JSON.parse(recoveredBackup.toString()), catalogue(root, entry.primary)); }
        finally { recoveredBackup.fill(0); }
        assert.deepEqual(await snapshot(directory), after);
        await assertPrivate(directory);
      } finally {
        await active?.dispose();
        await store?.lock();
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
}
