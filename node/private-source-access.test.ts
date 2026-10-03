import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PrivateSourceAccess, type PrivateSourceAccessResult } from './private-source-access';

const nativeFs = require('node:fs');
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function grant(result: PrivateSourceAccessResult): () => boolean {
  assert.equal(result.status, 'granted');
  if (result.status !== 'granted') { throw new Error('Synthetic grant expected'); }
  assert.deepEqual(Object.keys(result).sort(), ['isCurrent', 'status']);
  return result.isCurrent;
}

async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, 'private-source-grant-'));
  const root = path.join(directory, 'media');
  const other = path.join(directory, 'other');
  await fs.mkdir(root); await fs.mkdir(other);
  const owner = new AbortController();
  const operation = new AbortController();
  let ownerCurrent = true;
  let operationCurrent = true;
  const prompts: string[] = [];
  let choose: (root: string) => Promise<string | undefined> = async selected => selected;
  const releases: (() => void)[] = [];
  const access = new PrivateSourceAccess({ signal: owner.signal, isCurrent: () => ownerCurrent,
    chooseDirectory: selected => { prompts.push(selected); return choose(selected); } });
  t.after(async () => {
    for (const release of releases) { release(); }
    await access.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, other, owner, operation, access, prompts, releases,
    authorize: (selected = root) => access.authorize(selected, operation.signal, () => operationCurrent),
    setOwner: (value: boolean) => { ownerCurrent = value; },
    setOperation: (value: boolean) => { operationCurrent = value; },
    choose: (value: typeof choose) => { choose = value; } };
}

test('first grant waits for exact native selection before any source filesystem probe', async t => {
  const f = await fixture(t);
  const picker = deferred<string | undefined>();
  f.releases.push(() => picker.resolve(undefined));
  f.choose(() => picker.promise);
  const stat = nativeFs.lstatSync;
  const realpath = nativeFs.realpathSync.native;
  let probes = 0;
  t.mock.method(nativeFs, 'lstatSync', (value: unknown, ...args: unknown[]) => {
    probes++; return stat(value, ...args);
  });
  t.mock.method(nativeFs.realpathSync, 'native', (value: unknown, ...args: unknown[]) => {
    probes++; return realpath(value, ...args);
  });
  const pending = f.authorize();
  await turn();
  assert.deepEqual(f.prompts, [f.root]);
  assert.equal(probes, 0);
  picker.resolve(f.root);
  const current = grant(await pending);
  assert.ok(probes > 0);
  assert.equal(current(), true);
});

test('malformed paths and filesystem roots never invoke native UI or filesystem checks', async t => {
  const f = await fixture(t);
  const stat = t.mock.method(nativeFs, 'lstatSync', () => { assert.fail('Invalid path must not be probed'); });
  for (const root of ['', 'relative', '/', path.parse(f.root).root, f.root + '\0tail', '/' + 'x'.repeat(32_768), undefined, {}]) {
    assert.deepEqual(await f.access.authorize(root as string, f.operation.signal, () => true), { status: 'unavailable' });
  }
  assert.equal(f.prompts.length, 0);
  assert.equal(stat.mock.callCount(), 0);
});

test('cancelled and wrong-folder choices confer no authority and allow a later explicit retry', async t => {
  const f = await fixture(t);
  let probes = 0;
  const stat = nativeFs.lstatSync;
  t.mock.method(nativeFs, 'lstatSync', (value: unknown, ...args: unknown[]) => { probes++; return stat(value, ...args); });
  f.choose(async () => undefined);
  assert.deepEqual(await f.authorize(), { status: 'cancelled' });
  f.choose(async () => f.other);
  assert.deepEqual(await f.authorize(), { status: 'wrong-folder' });
  f.choose(async () => 'relative-selection');
  assert.deepEqual(await f.authorize(), { status: 'wrong-folder' });
  assert.equal(probes, 0);
  f.choose(async root => root);
  assert.equal(grant(await f.authorize())(), true);
  assert.equal(f.prompts.length, 4);
});

test('native failure stays generic and does not poison a retry', async t => {
  const f = await fixture(t);
  f.choose(async () => { throw new Error(f.root + '/private-title'); });
  assert.deepEqual(await f.authorize(), { status: 'unavailable' });
  f.choose(async root => root);
  assert.equal(grant(await f.authorize())(), true);
});

test('a granted canonical folder is reused in memory without disk persistence or repeat prompts', async t => {
  const f = await fixture(t);
  const before = (await fs.readdir(f.directory)).sort();
  const first = grant(await f.authorize());
  const second = grant(await f.authorize(f.root + path.sep));
  assert.equal(first(), true); assert.equal(second(), true);
  assert.deepEqual(f.prompts, [f.root]);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), before);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.deepEqual(Object.keys(f.access), [], 'private owner paths and cache are not exposed');
});

test('missing roots, non-directories, root symlinks and ancestor symlinks cannot become grants', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'file');
  await fs.writeFile(file, 'synthetic');
  const link = path.join(f.directory, 'root-link');
  const ancestor = path.join(f.directory, 'ancestor-link');
  await fs.symlink(f.root, link);
  await fs.symlink(f.directory, ancestor);
  for (const root of [path.join(f.directory, 'missing'), file, link, path.join(ancestor, 'media')]) {
    assert.deepEqual(await f.authorize(root), { status: 'source-unavailable' });
  }
});

test('a replaced root permanently revokes its old grants and requires a new native choice', async t => {
  const f = await fixture(t);
  const first = grant(await f.authorize());
  const moved = path.join(f.directory, 'original');
  await fs.rename(f.root, moved); await fs.mkdir(f.root);
  assert.equal(first(), false);
  assert.equal(first(), false);
  const second = grant(await f.authorize());
  assert.equal(second(), true);
  assert.equal(f.prompts.length, 2);
  await fs.rmdir(f.root); await fs.rename(moved, f.root);
  assert.equal(first(), false, 'restoring an inode cannot revive its revoked grant');
  assert.equal(second(), false);
});

test('disconnection discovered during cache reuse reports unavailable, then reconnect needs a fresh prompt', async t => {
  const f = await fixture(t);
  const first = grant(await f.authorize());
  await fs.rmdir(f.root);
  assert.deepEqual(await f.authorize(), { status: 'source-unavailable' });
  assert.equal(f.prompts.length, 1);
  assert.equal(first(), false);
  await fs.mkdir(f.root);
  assert.equal(grant(await f.authorize())(), true);
  assert.equal(f.prompts.length, 2);
});

test('operation cancellation retires its guard but preserves the healthy folder grant for another action', async t => {
  const f = await fixture(t);
  const first = grant(await f.authorize());
  f.operation.abort();
  assert.equal(first(), false);
  const next = new AbortController();
  const second = grant(await f.access.authorize(f.root, next.signal, () => true));
  assert.equal(second(), true);
  assert.equal(f.prompts.length, 1);
  let current = true;
  const third = grant(await f.access.authorize(f.root, next.signal, () => current));
  current = false; assert.equal(third(), false);
  current = true; assert.equal(third(), false, 'an expired operation cannot regain its grant');
});

test('owner abort or frame authority loss synchronously retires every grant and prevents future prompts', async t => {
  for (const revoke of ['abort', 'frame']) {
    const f = await fixture(t);
    const first = grant(await f.authorize());
    if (revoke === 'abort') { f.owner.abort(); }
    else { f.setOwner(false); }
    assert.equal(first(), false);
    f.setOwner(true);
    assert.deepEqual(await f.authorize(), { status: 'unavailable' });
    assert.equal(f.prompts.length, 1);
  }
});

test('cached approval is rechecked before asynchronous handoff after the owner is revoked', async t => {
  const f = await fixture(t);
  grant(await f.authorize());
  const pending = f.authorize();
  f.owner.abort();
  assert.deepEqual(await pending, { status: 'unavailable' });
  assert.equal(f.prompts.length, 1);
});

test('one native prompt is admitted at a time; operation cancellation discards its late selection', async t => {
  const f = await fixture(t);
  const picker = deferred<string | undefined>();
  f.releases.push(() => picker.resolve(undefined));
  f.choose(() => picker.promise);
  const pending = f.authorize();
  await turn();
  assert.deepEqual(await f.authorize(f.other), { status: 'busy' });
  f.operation.abort();
  picker.resolve(f.root);
  assert.deepEqual(await pending, { status: 'unavailable' });
  f.choose(async root => root);
  const next = new AbortController();
  assert.equal(grant(await f.access.authorize(f.root, next.signal, () => true))(), true);
  assert.equal(f.prompts.length, 2, 'cancelled pending approval must not enter the cache');
});

test('dispose revokes immediately but waits for the outstanding native picker to settle', async t => {
  const f = await fixture(t);
  const cached = grant(await f.authorize());
  const picker = deferred<string | undefined>();
  f.releases.push(() => picker.resolve(undefined));
  f.choose(() => picker.promise);
  const pending = f.authorize(f.other);
  await turn();
  let drained = false;
  const disposing = f.access.dispose().then(() => { drained = true; });
  assert.equal(cached(), false);
  assert.deepEqual(await f.authorize(), { status: 'unavailable' });
  await turn(); assert.equal(drained, false);
  picker.resolve(f.other);
  assert.deepEqual(await pending, { status: 'unavailable' });
  await disposing;
  assert.equal(drained, true);
  await f.access.dispose();
});

test('owner abort drains a late rejected native picker without reopening or exposing errors', async t => {
  const f = await fixture(t);
  const picker = deferred<string | undefined>();
  f.releases.push(() => picker.resolve(undefined));
  f.choose(() => picker.promise);
  const pending = f.authorize();
  await turn();
  f.owner.abort();
  let drained = false;
  const disposing = f.access.dispose().then(() => { drained = true; });
  await turn(); assert.equal(drained, false);
  picker.reject(new Error(f.root));
  assert.deepEqual(await pending, { status: 'unavailable' });
  await disposing;
  assert.deepEqual(await f.authorize(), { status: 'unavailable' });
});

test('construction permits a dormant owner and rejects async/throwing authority predicates on admission', async t => {
  const f = await fixture(t);
  f.setOwner(false);
  let active = false;
  let prompts = 0;
  const access = new PrivateSourceAccess({ signal: f.owner.signal, isCurrent: () => active,
    chooseDirectory: async root => { prompts++; return root; } });
  active = true;
  assert.equal(grant(await access.authorize(f.root, f.operation.signal, () => true))(), true);
  assert.equal(prompts, 1);
  assert.deepEqual(await access.authorize(f.root, f.operation.signal, (() => Promise.resolve(true)) as unknown as () => boolean), { status: 'unavailable' });
  assert.deepEqual(await access.authorize(f.root, f.operation.signal, () => { throw new Error(f.root); }), { status: 'unavailable' });
  await access.dispose();
});

test('revocation inside the native adapter and after selection cannot adopt a late grant', async t => {
  const f = await fixture(t);
  const picker = deferred<string | undefined>();
  f.releases.push(() => picker.resolve(undefined));
  let disposing!: Promise<void>;
  f.choose(() => { disposing = f.access.dispose(); return picker.promise; });
  const pending = f.authorize();
  await turn();
  picker.resolve(f.root);
  assert.deepEqual(await pending, { status: 'unavailable' });
  await disposing;
  const next = await fixture(t);
  next.choose(async root => { next.setOperation(false); return root; });
  assert.deepEqual(await next.authorize(), { status: 'unavailable' });
});

test('the memory grant cache is bounded and cannot stack more native choices after its limit', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 256; index++) {
    const root = path.join(f.directory, 'source-' + index);
    await fs.mkdir(root);
    assert.equal(grant(await f.authorize(root))(), true);
  }
  assert.deepEqual(await f.authorize(), { status: 'busy' });
  assert.equal(f.prompts.length, 256);
});


test('connection status never probes an ungranted or invalid source or opens a picker', async t => {
  const f = await fixture(t);
  const stat = t.mock.method(nativeFs, 'lstatSync', () => { assert.fail('An ungranted source must not be probed'); });
  const realpath = t.mock.method(nativeFs.realpathSync, 'native', () => { assert.fail('An ungranted source must not be resolved'); });
  for (const root of [f.root, f.other, '', '/', 'relative', undefined, {}]) {
    assert.equal(f.access.isConnected(root as string), false);
    f.access.disconnect(root as string);
  }
  assert.equal(stat.mock.callCount(), 0);
  assert.equal(realpath.mock.callCount(), 0);
  assert.deepEqual(f.prompts, []);
});

test('connection status remains disconnected while its first native approval is pending', async t => {
  const f = await fixture(t);
  const picker = deferred<string | undefined>();
  f.releases.push(() => picker.resolve(undefined));
  f.choose(() => picker.promise);
  const pending = f.authorize();
  await turn();
  assert.equal(f.access.isConnected(f.root), false);
  picker.resolve(f.root);
  assert.equal(grant(await pending)(), true);
  assert.equal(f.access.isConnected(f.root), true);
});

test('disconnect revokes only the selected session grant and a later connection asks again', async t => {
  const f = await fixture(t);
  const first = grant(await f.authorize());
  const other = grant(await f.authorize(f.other));
  const before = (await fs.readdir(f.directory)).sort();
  assert.equal(f.access.isConnected(f.root), true);
  f.access.disconnect(f.root + path.sep);
  assert.equal(f.access.isConnected(f.root), false);
  assert.equal(first(), false);
  assert.equal(other(), true);
  assert.equal(f.access.isConnected(f.other), true);
  f.access.disconnect(f.root);
  const replacement = grant(await f.authorize());
  assert.equal(replacement(), true);
  assert.equal(first(), false, 'Reconnecting must not revive previously revoked authority');
  assert.deepEqual(f.prompts, [f.root, f.other, f.root]);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), before);
});

test('refresh detects a replaced folder and cannot revive its old grant when the original returns', async t => {
  const f = await fixture(t);
  const first = grant(await f.authorize());
  const original = path.join(f.directory, 'disconnected-media');
  await fs.rename(f.root, original);
  await fs.mkdir(f.root);
  assert.equal(f.access.isConnected(f.root), false);
  await fs.rmdir(f.root);
  await fs.rename(original, f.root);
  assert.equal(f.access.isConnected(f.root), false);
  assert.equal(first(), false);
  assert.equal(grant(await f.authorize())(), true);
  assert.equal(f.access.isConnected(f.root), true);
  assert.equal(f.prompts.length, 2);
});

test('status checks after owner revocation remain disconnected without probing former grants', async t => {
  const f = await fixture(t);
  grant(await f.authorize());
  f.owner.abort();
  const stat = t.mock.method(nativeFs, 'lstatSync', () => { assert.fail('Revoked sources must not be probed'); });
  assert.equal(f.access.isConnected(f.root), false);
  f.access.disconnect(f.root);
  assert.equal(f.access.isConnected(f.other), false);
  assert.equal(stat.mock.callCount(), 0);
});
