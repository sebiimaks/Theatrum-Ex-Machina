import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { readPrivateHubCatalogue, writePrivateHubCatalogue } from './private-hub-catalogue';
import { PrivateHubLeaseError } from './private-hub-lock';
import { PRIVATE_HUB_HEADER_FILE, PrivateHubStore } from './private-hub-store';

const checkout = fs.realpathSync(path.resolve(__dirname, '..'));
const password = 'Synthetic interrupted password original';
const replacement = 'Synthetic interrupted password replacement 🔒';
const subsequent = 'Synthetic password change after reopening';
const marker = 'PRIVATE_PASSWORD_INTERRUPTION_CANARY';
const previewId = 'thumbnail:synthetic-video';
const cases = [
  { stage: 'before-header', pending: 1, active: password, rejected: replacement },
  { stage: 'after-header', pending: 0, active: replacement, rejected: password },
] as const;

async function within<T>(pending: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Interrupted-password test checkpoint timed out.')), milliseconds);
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

// Storage-level preview payloads; no image decoder is involved in this fixture.
function preview(revision: string): Buffer { return Buffer.from(marker + ' preview ' + revision); }

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

function assertSameFiles(actual: Map<string, Buffer>, expected: Map<string, Buffer>, except: string[] = []): void {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [name, bytes] of expected) {
    if (!except.includes(name)) { assert.ok(actual.get(name)?.equals(bytes), 'Encrypted fixture files must remain byte-identical.'); }
  }
}

async function assertPrivate(directory: string): Promise<void> {
  for (const [name, bytes] of await snapshot(directory)) {
    for (const secret of [marker, password, replacement, subsequent]) {
      assert.equal(name.includes(secret), false);
      for (const encoding of ['utf8', 'utf16le'] as const) {
        assert.equal(bytes.includes(Buffer.from(secret, encoding)), false, 'Password interruption must not persist the specified synthetic plaintext secrets.');
      }
    }
  }
}

async function assertAuthenticated(store: PrivateHubStore, root: string, revision: string, backupRevision: string): Promise<void> {
  assert.ok(JSON.stringify(await readPrivateHubCatalogue(store)) === JSON.stringify(catalogue(root, revision)),
    'The authenticated catalogue must retain its expected revision.');
  const backup = await store.readBackupRecord('catalogue');
  try { assert.ok(backup.equals(Buffer.from(JSON.stringify(catalogue(root, backupRevision))))); }
  finally { backup.fill(0); }
  const thumbnail = await store.readRecord(previewId);
  try { assert.ok(thumbnail.equals(preview('B'))); } finally { thumbnail.fill(0); }
  const thumbnailBackup = await store.readBackupRecord(previewId);
  try { assert.ok(thumbnailBackup.equals(preview('A'))); } finally { thumbnailBackup.fill(0); }
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
  throw new Error('The interrupted password writer lock helper did not exit.');
}

function writer(root: string, stage: typeof cases[number]['stage']) {
  const child = spawn(process.execPath, ['-r', require.resolve('ts-node/register'),
    path.join(checkout, 'node/private-password-interruption-child.cjs')], {
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
    const failure = () => reject(new Error('Interrupted-password writer failed before its checkpoint.'));
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
    child.send({ root, stage, password, replacement }, error => { if (error) { failure(); } });
  });
  void checkpoint.catch(() => undefined);
  const kill = (owned: ChildProcess): void => {
    if (!closed && owned.exitCode === null && owned.signalCode === null) { owned.kill('SIGKILL'); }
  };
  let disposal: Promise<void> | undefined;
  return {
    ready: () => within(checkpoint, 15_000),
    dispose: () => disposal ??= (async () => {
      kill(child);
      await within(closure);
      if (helperPid !== undefined) { await assertHelperExited(helperPid); }
    })(),
    assertKilled: () => {
      assert.ok(closed, 'The writer must be reaped before opening another session.');
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(outputBytes, 0, 'The child must not log credentials, catalogue contents, or paths.');
    },
  };
}

for (const entry of cases) {
  test(`real password interruption ${entry.stage} preserves the authoritative credential and encrypted records`,
    { skip: !['darwin', 'linux'].includes(process.platform), timeout: 45_000 }, async () => {
      const temporaryRoot = path.join(checkout, 'tmp');
      await fs.promises.mkdir(temporaryRoot, { recursive: true });
      assert.equal(await fs.promises.realpath(temporaryRoot), temporaryRoot, 'Synthetic fixtures must stay in the checkout.');
      const root = await fs.promises.mkdtemp(path.join(temporaryRoot, 'private-password-interruption-'));
      const directory = path.join(root, 'hub');
      let store: PrivateHubStore | undefined;
      let active: ReturnType<typeof writer> | undefined;
      try {
        store = await PrivateHubStore.create(directory, password);
        await writePrivateHubCatalogue(store, catalogue(root, 'A'));
        await writePrivateHubCatalogue(store, catalogue(root, 'B'));
        const catalogueFiles = (await fs.promises.readdir(directory)).filter(name => /^[0-9a-f]{64}\.sealed(?:\.bak)?$/.test(name));
        assert.equal(catalogueFiles.length, 2);
        await store.writeRecord(previewId, preview('A'));
        await store.writeRecord(previewId, preview('B'));
        await store.lock(); store = undefined;
        const before = await snapshot(directory);
        active = writer(root, entry.stage);
        await active.ready();
        await assert.rejects(PrivateHubStore.open(directory, password), PrivateHubLeaseError,
          'The real child-held advisory lock must reject a second opener.');
        const held = await snapshot(directory);
        const pending = [...held.keys()].filter(name => name.endsWith('.pending'));
        assert.equal(pending.length, entry.pending);
        assert.equal(held.has(PRIVATE_HUB_HEADER_FILE + '.bak'), false);
        for (const [name, bytes] of before) {
          if (name !== PRIVATE_HUB_HEADER_FILE) { assert.ok(held.get(name)?.equals(bytes), 'Password changes must not rewrite encrypted records.'); }
        }
        assert.equal(held.get(PRIVATE_HUB_HEADER_FILE)!.equals(before.get(PRIVATE_HUB_HEADER_FILE)!), entry.pending === 1);
        await assertPrivate(directory);
        await active.dispose(); active.assertKilled();

        // A wrong password cannot adopt the pending replacement or change files.
        await assert.rejects(PrivateHubStore.open(directory, entry.rejected), /Unable to unlock/);
        assertSameFiles(await snapshot(directory), held);
        store = await PrivateHubStore.open(directory, entry.active);
        await assertAuthenticated(store, root, 'B', 'A');
        assertSameFiles(await snapshot(directory), held);
        await writePrivateHubCatalogue(store, catalogue(root, 'C'));
        await assertAuthenticated(store, root, 'C', 'B');
        const saved = await snapshot(directory);
        // Only the catalogue primary and backup may change during this save;
        // retain the encrypted preview bytes, current header and any orphan.
        assertSameFiles(saved, held, catalogueFiles);
        await store.lock(); store = await PrivateHubStore.open(directory, entry.active);
        await assertAuthenticated(store, root, 'C', 'B');
        assertSameFiles(await snapshot(directory), saved);

        if (entry.pending) {
          // An unexplained wrapped-key copy is retained, and prevents claiming
          // another password change while an alternate credential may survive.
          await assert.rejects(store.changePassword(entry.active, subsequent, () => true), /password change unavailable/);
          assert.equal(store.locked, false);
          assertSameFiles(await snapshot(directory), saved);
          await assertAuthenticated(store, root, 'C', 'B');
          // Resume only through the explicit two-password, confirmed action.
          assert.equal(await store.resumePasswordChange(password, replacement, () => true, async () => true), 'changed');
          const resumed = await snapshot(directory);
          const expected = new Map(saved);
          expected.set(PRIVATE_HUB_HEADER_FILE, saved.get(pending[0])!);
          expected.delete(pending[0]);
          assertSameFiles(resumed, expected);
          await store.lock(); store = undefined;
          await assert.rejects(PrivateHubStore.open(directory, password), /Unable to unlock/);
          assertSameFiles(await snapshot(directory), resumed);
          store = await PrivateHubStore.open(directory, replacement);
          await assertAuthenticated(store, root, 'C', 'B');
          assertSameFiles(await snapshot(directory), resumed);
        } else {
          assert.equal(await store.changePassword(entry.active, subsequent, () => true), 'changed');
          const changed = await snapshot(directory);
          assertSameFiles(changed, saved, [PRIVATE_HUB_HEADER_FILE]);
          assert.ok(!changed.get(PRIVATE_HUB_HEADER_FILE)!.equals(saved.get(PRIVATE_HUB_HEADER_FILE)!));
          await store.lock(); store = undefined;
          await assert.rejects(PrivateHubStore.open(directory, entry.active), /Unable to unlock/);
          assertSameFiles(await snapshot(directory), changed);
          store = await PrivateHubStore.open(directory, subsequent);
          await assertAuthenticated(store, root, 'C', 'B');
          assertSameFiles(await snapshot(directory), changed);
        }
        await assertPrivate(directory);
      } finally {
        await active?.dispose();
        await store?.lock();
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
}
