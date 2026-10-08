import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { decryptPrivateHubRecord, unlockPrivateHub } from './private-hub-crypto';
import { PrivateHubLeaseError } from './private-hub-lock';
import { PRIVATE_HUB_HEADER_FILE, PrivateHubStore } from './private-hub-store';

const checkout = fs.realpathSync(path.resolve(__dirname, '..'));
const password = 'Synthetic interrupted catalogue recovery password';
const canary = 'PRIVATE_CATALOGUE_RECOVERY_INTERRUPTION_CANARY';
const original = Buffer.from(JSON.stringify({ revision: 'A', notes: canary }));
const cases = ['before-primary', 'after-primary'] as const;

async function within<T>(pending: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Catalogue recovery interruption checkpoint timed out.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function helperExited(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') { return; }
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Interrupted catalogue recovery helper did not exit.');
}

function writer(root: string, stage: typeof cases[number]) {
  const child = spawn(process.execPath, ['-r', require.resolve('ts-node/register'),
    path.join(checkout, 'node/private-catalogue-recovery-interruption-child.cjs')], {
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
    const fail = () => reject(new Error('Catalogue recovery writer failed before its checkpoint.'));
    child.once('error', fail);
    child.once('close', fail);
    child.on('message', message => {
      const value = message as { type?: string; stage?: string; helperPid?: number };
      if (!Number.isInteger(value?.helperPid) || value.helperPid! <= 1
        || value.helperPid === process.pid || value.helperPid === child.pid) { fail(); return; }
      if (value.type === 'helper' && helperPid === undefined) { helperPid = value.helperPid; return; }
      if (value.type !== 'checkpoint' || value.stage !== stage || helperPid !== value.helperPid) { fail(); return; }
      resolve();
    });
    child.send({ root, stage, password }, error => { if (error) { fail(); } });
  });
  void checkpoint.catch(() => undefined);
  let disposal: Promise<void> | undefined;
  return {
    ready: () => within(checkpoint, 15_000),
    dispose: () => disposal ??= (async () => {
      if (!closed && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
      await within(closure);
      if (helperPid !== undefined) { await helperExited(helperPid); }
    })(),
    assertKilled: () => {
      assert.equal(closed, true);
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(outputBytes, 0, 'Owned writer must not log credentials, catalogue text or paths.');
    },
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

function unchanged(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [name, bytes] of expected) { assert.ok(actual.get(name)?.equals(bytes), 'Owned encrypted fixture files must remain unchanged.'); }
}

function privateFiles(files: Map<string, Buffer>): void {
  for (const [name, bytes] of files) {
    for (const value of [password, canary]) {
      assert.equal(name.includes(value), false);
      for (const encoding of ['utf8', 'utf16le'] as const) {
        assert.equal(bytes.includes(Buffer.from(value, encoding)), false, 'Recovery must not write synthetic plaintext secrets.');
      }
    }
  }
}

function evidence(files: Map<string, Buffer>, key: Buffer, hubId: string, damaged: Buffer, count: number): void {
  const records = [...files].filter(([name]) => /^[0-9a-f]{48}\.recovery$/.test(name));
  assert.equal(records.length, count);
  for (const [name, sealed] of records) {
    const plaintext = decryptPrivateHubRecord(key, hubId, 'recovery-evidence:' + name.slice(0, 48), sealed);
    try {
      const length = plaintext.readUInt32BE(0);
      assert.ok(length > 0 && length < plaintext.length - 4);
      assert.deepEqual(JSON.parse(plaintext.subarray(4, 4 + length).toString('utf8')),
        { format: 'theatrum-private-recovery-evidence', version: 1, recordId: 'catalogue' });
      assert.ok(plaintext.subarray(4 + length).equals(damaged), 'Encrypted evidence must retain the exact damaged primary.');
    } finally { plaintext.fill(0); }
  }
}

for (const stage of cases) {
  test(`real catalogue recovery interruption ${stage} retains backup and encrypted damaged-primary evidence`,
    { skip: !['darwin', 'linux'].includes(process.platform), timeout: 45_000 }, async () => {
      const temporary = path.join(checkout, 'tmp');
      await fs.promises.mkdir(temporary, { recursive: true });
      assert.equal(await fs.promises.realpath(temporary), temporary);
      const root = await fs.promises.mkdtemp(path.join(temporary, 'private-catalogue-recovery-interruption-'));
      const directory = path.join(root, 'hub');
      let store: PrivateHubStore | undefined;
      let active: ReturnType<typeof writer> | undefined;
      let key: Buffer | undefined;
      try {
        store = await PrivateHubStore.create(directory, password);
        const hubId = store.hubId;
        await store.writeRecord('catalogue', original);
        await store.writeRecord('catalogue', Buffer.from(JSON.stringify({ revision: 'B', notes: canary })));
        const names = (await fs.promises.readdir(directory)).filter(name => /^[0-9a-f]{64}\.sealed$/.test(name));
        assert.equal(names.length, 1);
        const primaryName = names[0];
        const primary = path.join(directory, primaryName);
        await store.lock(); store = undefined;
        key = await unlockPrivateHub(JSON.parse(await fs.promises.readFile(path.join(directory, PRIVATE_HUB_HEADER_FILE), 'utf8')), password);
        const damaged = await fs.promises.readFile(primary);
        damaged[damaged.length - 1] ^= 1;
        await fs.promises.writeFile(primary, damaged);
        const before = await snapshot(directory);
        active = writer(root, stage);
        await active.ready();
        await assert.rejects(PrivateHubStore.open(directory, password), PrivateHubLeaseError,
          'Live recovery writer must exclude another opener.');
        const held = await snapshot(directory);
        assert.ok(held.get(primaryName + '.bak')!.equals(before.get(primaryName + '.bak')!));
        assert.ok(held.get(PRIVATE_HUB_HEADER_FILE)!.equals(before.get(PRIVATE_HUB_HEADER_FILE)!));
        const pending = [...held.keys()].filter(name => name.endsWith('.pending'));
        assert.equal(pending.length, stage === 'before-primary' ? 1 : 0);
        const expectedPrimary = stage === 'before-primary' ? damaged : before.get(primaryName + '.bak')!;
        assert.ok(held.get(primaryName)!.equals(expectedPrimary));
        evidence(held, key, hubId, damaged, 1);
        privateFiles(held);
        await active.dispose(); active.assertKilled();
        unchanged(await snapshot(directory), held);

        store = await PrivateHubStore.open(directory, password);
        const backup = await store.readBackupRecord('catalogue');
        try { assert.ok(backup.equals(original)); } finally { backup.fill(0); }
        if (stage === 'before-primary') { await assert.rejects(store.readRecord('catalogue')); }
        else {
          const recovered = await store.readRecord('catalogue');
          try { assert.ok(recovered.equals(original)); } finally { recovered.fill(0); }
        }
        // Reopening never promotes the complete but orphaned .pending file.
        unchanged(await snapshot(directory), held);
        let confirmations = 0;
        assert.equal(await store.recoverRecordWithReview('catalogue', {
          maximumBytes: 4096, validate: bytes => bytes.equals(original), isCurrent: () => true,
          confirm: async () => { confirmations++; return true; },
        }), stage === 'before-primary' ? 'recovered' : 'not-needed');
        assert.equal(confirmations, stage === 'before-primary' ? 1 : 0);
        const finished = await snapshot(directory);
        for (const [name, bytes] of held) {
          if (name !== primaryName) { assert.ok(finished.get(name)?.equals(bytes), 'Retry must retain backup, earlier evidence and orphan staging.'); }
        }
        assert.ok(finished.get(primaryName)!.equals(before.get(primaryName + '.bak')!));
        evidence(finished, key, hubId, damaged, stage === 'before-primary' ? 2 : 1);
        privateFiles(finished);
        await store.lock(); store = await PrivateHubStore.open(directory, password);
        const reopened = await store.readRecord('catalogue');
        try { assert.ok(reopened.equals(original)); } finally { reopened.fill(0); }
        unchanged(await snapshot(directory), finished);
        assert.deepEqual(await fs.promises.readdir(root), ['hub']);
      } finally {
        await active?.dispose();
        await store?.lock();
        key?.fill(0);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
}
