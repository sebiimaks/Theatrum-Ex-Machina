import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject, type ImageElement } from '../interfaces/final-object.interface';
import { checkPrivateSource, privateSourceCheckRevision, type PrivateSourceCheckOptions } from './private-source-check';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp/private-source-check-stage/temp');
  await fs.promises.mkdir(temporary, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(temporary, 'source-check-'));
  const root = path.join(directory, 'source'); await fs.promises.mkdir(root);
  const controller = new AbortController(); let allowed = true;
  const catalogue = { images: [], inputDirs: { 0: { path: root, watch: false } } } as unknown as FinalObject;
  const options: PrivateSourceCheckOptions = { catalogue, sourceIndex: 0, signal: controller.signal, isCurrent: () => allowed };
  t.after(async () => { controller.abort(); t.mock.restoreAll(); await fs.promises.rm(directory, { recursive: true, force: true }); });
  const file = async (relative: string, data = 'TEST') => {
    const target = path.join(root, relative); await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data); return target;
  };
  const row = (relative: string, size = 4): ImageElement => {
    const parent = path.dirname(relative);
    const image = { ...NewImageElement(), hash: 'saved-' + catalogue.images.length, fileName: path.basename(relative),
      partialPath: parent === '.' ? '/' : '/' + parent.split(path.sep).join('/'), fileSize: size };
    catalogue.images.push(image); return image;
  };
  const run = () => checkPrivateSource(options);
  const checked = async () => {
    const result = await run(); assert.equal(result.status, 'checked');
    if (result.status !== 'checked') { throw new Error('Expected checked source'); }
    assert.equal(result.total, result.sameSize + result.differentSize + result.missing + result.unverified + result.ignored);
    assert.match(result.revision, /^[a-f0-9]{64}$/); return result;
  };
  return { directory, root, controller, catalogue, options, file, row, run, checked, revoke: () => { allowed = false; } };
}

test('reports exclusive size-only metadata counts without media reads, enumeration, opens or writes', async t => {
  const f = await fixture(t);
  await f.file('same.mp4'); await f.file('different.mp4', 'CHANGED'); await f.file('unknown.mp4');
  await f.file('ignored/private.mp4'); const linkedTarget = await f.file('link-target.mp4');
  await fs.promises.symlink(linkedTarget, path.join(f.root, 'linked.mp4'));
  f.row('same.mp4').mtime = 1; f.row('different.mp4'); f.row('missing.mp4'); f.row('unknown.mp4', 0);
  f.row('linked.mp4'); f.row('ignored/private.mp4');
  f.catalogue.inputDirs[0].ignoredSubdirectories = ['ignored'];
  const before = JSON.stringify(f.catalogue);
  const noAccess = () => { assert.fail('This operation may inspect only saved-location metadata'); };
  for (const method of ['readFile', 'open', 'readdir', 'opendir', 'writeFile'] as const) {
    t.mock.method(fs.promises, method, noAccess);
  }
  const checked = await f.checked();
  assert.deepEqual({ ...checked, revision: '' }, { status: 'checked', total: 6, sameSize: 1,
    differentSize: 1, missing: 1, unverified: 2, ignored: 1, revision: '' });
  assert.equal(JSON.stringify(f.catalogue), before);
});

test('all references remain counted, aliases dedupe within rows and previously missing locations are checked', async t => {
  const f = await fixture(t); await f.file('saved.mp4');
  const image = f.row('saved.mp4'); image.missing = true;
  image.locations = [{ fileName: 'saved.mp4', partialPath: '/', inputSource: 0, missing: true },
    { fileName: 'saved.mp4', partialPath: '/', inputSource: 0 },
    { fileName: 'missing.mp4', partialPath: '/', inputSource: 0 }];
  f.row('saved.mp4');
  f.row('deleted.mp4').deleted = true; f.row('folder.mp4').cleanName = '*FOLDER*';
  const result = await f.checked(); assert.equal(result.total, 3); assert.equal(result.sameSize, 2); assert.equal(result.missing, 1);
});

test('only the chosen source is probed and linked parents are never traversed', async t => {
  const f = await fixture(t); await f.file('saved.mp4');
  const outside = path.join(f.directory, 'outside'); await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'secret.mp4'), 'TEST');
  await fs.promises.symlink(outside, path.join(f.root, 'linked'));
  f.catalogue.inputDirs[1] = { path: outside, watch: false };
  f.row('saved.mp4'); f.row('secret.mp4').inputSource = 1; f.row('linked/secret.mp4');
  const probes: string[] = []; const lstat = fs.promises.lstat.bind(fs.promises);
  t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
    probes.push(String(args[0])); return lstat(...args);
  });
  const result = await f.checked(); assert.equal(result.total, 2); assert.equal(result.sameSize, 1); assert.equal(result.unverified, 1);
  assert.ok(!probes.some(value => value.startsWith(outside) || value === path.join(f.root, 'linked/secret.mp4')));
});

test('ignored and over-depth references are counted without probing their paths', async t => {
  const f = await fixture(t); f.catalogue.inputDirs[0].ignoredSubdirectories = ['ignored'];
  f.row('ignored/never.mp4'); f.row(Array(33).fill('a').join('/') + '/deep.mp4');
  const lstat = fs.promises.lstat.bind(fs.promises); const probes: string[] = [];
  t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
    probes.push(String(args[0])); return lstat(...args);
  });
  const result = await f.checked(); assert.equal(result.ignored, 1); assert.equal(result.unverified, 1);
  assert.ok(probes.every(value => value === f.root));
});

test('empty sources have a checked empty result and missing ancestors are missing', async t => {
  const f = await fixture(t); assert.equal((await f.checked()).total, 0);
  f.row('absent/parent/file.mp4'); assert.equal((await f.checked()).missing, 1);
});

for (const size of [0, -1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
  test(`unknown saved size ${String(size)} cannot assert a match`, async t => {
    const f = await fixture(t); await f.file('saved.mp4'); f.row('saved.mp4').fileSize = size as number;
    assert.equal((await f.checked()).unverified, 1);
  });
}

test('regular files with zero current length differ from a positive saved size', async t => {
  const f = await fixture(t); await f.file('saved.mp4', ''); f.row('saved.mp4');
  assert.equal((await f.checked()).differentSize, 1);
});

test('directories in a file position are unverified', async t => {
  const f = await fixture(t); await fs.promises.mkdir(path.join(f.root, 'directory.mp4')); f.row('directory.mp4');
  assert.equal((await f.checked()).unverified, 1);
});

for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR']) {
  test(`${code} at a leaf is unverified, not missing`, async t => {
    const f = await fixture(t); const file = await f.file('saved.mp4'); f.row('saved.mp4');
    const lstat = fs.promises.lstat.bind(fs.promises);
    t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
      if (args[0] === file) { throw Object.assign(new Error('PRIVATE PATH'), { code }); }
      return lstat(...args);
    });
    const result = await f.checked(); assert.equal(result.unverified, 1); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });
}

for (const damage of ['missing', 'symlink', 'file', 'replace'] as const) {
  test(`a ${damage} root aborts without classifying its files missing`, async t => {
    const f = await fixture(t); f.row('saved.mp4');
    if (damage !== 'replace') {
      await fs.promises.rename(f.root, f.root + '-old');
      if (damage === 'symlink') { await fs.promises.symlink(f.root + '-old', f.root); }
      if (damage === 'file') { await fs.promises.writeFile(f.root, 'FILE'); }
    } else {
      const lstat = fs.promises.lstat.bind(fs.promises); let calls = 0;
      t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
        if (args[0] === f.root && ++calls === 2) {
          await fs.promises.rename(f.root, f.root + '-old'); await fs.promises.mkdir(f.root);
        }
        return lstat(...args);
      });
    }
    assert.deepEqual(await f.run(), { status: 'source-unavailable' });
  });
}

test('leaf replacement during inspection is unverified even when its size matches', async t => {
  const f = await fixture(t); const file = await f.file('saved.mp4'); f.row('saved.mp4');
  const lstat = fs.promises.lstat.bind(fs.promises); let calls = 0;
  t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
    if (args[0] === file && ++calls === 2) {
      await fs.promises.rename(file, file + '-old'); await fs.promises.writeFile(file, 'TEST');
    }
    return lstat(...args);
  });
  assert.equal((await f.checked()).unverified, 1);
});

test('ancestor replacement during inspection never admits a leaf through the replacement', async t => {
  const f = await fixture(t); const file = await f.file('parent/saved.mp4'); f.row('parent/saved.mp4');
  const parent = path.dirname(file); const lstat = fs.promises.lstat.bind(fs.promises); let calls = 0; let leaves = 0;
  t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
    if (args[0] === parent && ++calls === 2) {
      await fs.promises.rename(parent, parent + '-old'); await fs.promises.mkdir(parent);
    }
    if (args[0] === file) { leaves++; }
    return lstat(...args);
  });
  assert.equal((await f.checked()).unverified, 1); assert.equal(leaves, 0);
});

for (const cancel of ['abort', 'grant'] as const) {
  test(`in-flight metadata is drained after ${cancel} and no later probes are admitted`, async t => {
    const f = await fixture(t); const file = await f.file('saved.mp4'); f.row('saved.mp4');
    const lstat = fs.promises.lstat.bind(fs.promises); const entered = deferred(); const release = deferred();
    t.after(() => release.resolve()); let calls = 0;
    t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
      calls++; const result = await lstat(...args);
      if (args[0] === file) { entered.resolve(); await release.promise; }
      return result;
    });
    let finished = false; const result = f.run().finally(() => { finished = true; }); await entered.promise;
    if (cancel === 'abort') { f.controller.abort(); } else { f.revoke(); }
    const count = calls; await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    release.resolve(); assert.deepEqual(await result, { status: 'cancelled' }); assert.equal(calls, count);
  });
}

test('pre-revocation and a throwing predicate perform no filesystem access', async t => {
  const f = await fixture(t); f.row('saved.mp4'); f.revoke();
  const lstat = t.mock.method(fs.promises, 'lstat', async () => { assert.fail('Revoked'); });
  assert.deepEqual(await f.run(), { status: 'cancelled' });
  assert.deepEqual(await checkPrivateSource({ ...f.options, isCurrent: () => { throw new Error('PRIVATE'); } }), { status: 'cancelled' });
  assert.equal(lstat.mock.callCount(), 0);
});

test('malformed active locations are all rejected before filesystem access including other-source rows', async t => {
  const f = await fixture(t); f.row('valid.mp4');
  const bad = f.row('bad.mp4'); bad.partialPath = '/../../escape';
  const lstat = t.mock.method(fs.promises, 'lstat', async () => { assert.fail('Invalid catalogue'); });
  assert.deepEqual(await f.run(), { status: 'invalid' }); assert.equal(lstat.mock.callCount(), 0);
  assert.throws(() => privateSourceCheckRevision(f.catalogue, 0), { message: 'Private source check is unavailable.' });
});

for (const damage of ['rows', 'locations', 'sources', 'selected', 'path-budget'] as const) {
  test(`${damage} bound is checked before filesystem access`, async t => {
    const f = await fixture(t); const row = f.row('saved.mp4');
    if (damage === 'rows') { f.catalogue.images = Array(100_001).fill(row); }
    if (damage === 'locations') { row.locations = Array(100_001).fill({ fileName: 'saved.mp4', partialPath: '/', inputSource: 0 }); }
    if (damage === 'sources') { for (let i = 1; i <= 256; i++) { f.catalogue.inputDirs[i] = { path: f.root, watch: false }; } }
    if (damage === 'selected') { f.catalogue.images = Array(10_001).fill(row); }
    if (damage === 'path-budget') { row.fileName = 'a'.repeat(4096); f.catalogue.images = Array(2049).fill(row); }
    const lstat = t.mock.method(fs.promises, 'lstat', async () => { assert.fail('Oversized catalogue'); });
    assert.deepEqual(await f.run(), { status: 'limit' }); assert.equal(lstat.mock.callCount(), 0);
    assert.throws(() => privateSourceCheckRevision(f.catalogue, 0), { message: 'Private source check is unavailable.' });
  });
}

test('catalogue preparation yields to cancellation before any source I/O', async t => {
  const f = await fixture(t); const row = f.row('saved.mp4'); f.catalogue.images = Array(1000).fill(row);
  const lstat = t.mock.method(fs.promises, 'lstat', async () => { assert.fail('Preparation cancelled'); });
  const result = f.run(); f.controller.abort();
  assert.deepEqual(await result, { status: 'cancelled' }); assert.equal(lstat.mock.callCount(), 0);
});

test('revision tracks relevant source references, size and exclusions, preserving unrelated edits', async t => {
  const f = await fixture(t); const row = f.row('saved.mp4');
  const original = privateSourceCheckRevision(f.catalogue, 0);
  row.notes = 'DRAFT'; row.timesPlayed = 2; row.lastPlayed = 100; row.mtime = 100; row.missing = true;
  f.catalogue.inputDirs[0].watch = true;
  assert.equal(privateSourceCheckRevision(f.catalogue, 0), original);
  for (const mutate of [
    () => { row.fileSize = 8; }, () => { row.fileName = 'renamed.mp4'; },
    () => { row.partialPath = '/nested'; }, () => { f.catalogue.inputDirs[0].path += '-new'; },
    () => { f.catalogue.inputDirs[0].ignoredSubdirectories = ['nested']; },
  ]) {
    const before = privateSourceCheckRevision(f.catalogue, 0); mutate();
    assert.notEqual(privateSourceCheckRevision(f.catalogue, 0), before);
  }
});

test('check uses an immutable reference snapshot while caller can detect later catalogue mutation', async t => {
  const f = await fixture(t); await f.file('saved.mp4'); const row = f.row('saved.mp4');
  const original = privateSourceCheckRevision(f.catalogue, 0); const lstat = fs.promises.lstat.bind(fs.promises);
  t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
    row.fileName = 'after.mp4'; return lstat(...args);
  });
  const result = await f.checked(); assert.equal(result.sameSize, 1); assert.equal(result.revision, original);
  assert.notEqual(privateSourceCheckRevision(f.catalogue, 0), original);
});
