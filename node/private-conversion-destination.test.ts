import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { privateConversionDestination } from './private-conversion-destination';
import { privateConversionFailureCode } from './private-conversion-errors';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.resolve(__dirname, '../tmp/private-destination-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('an existing empty selected folder gets a new exclusive child path without filesystem writes', async t => {
  const parent = await fixture(t);
  assert.equal(await privateConversionDestination(parent), path.join(parent, 'Private hub'));
  assert.deepEqual(await fs.readdir(parent), []);
});

test('existing files, hub folders and linked candidate names are preserved and skipped', async t => {
  const parent = await fixture(t);
  await fs.writeFile(path.join(parent, 'keep.txt'), 'Retain this file');
  await fs.mkdir(path.join(parent, 'Private hub'));
  await fs.writeFile(path.join(parent, 'Private hub', 'keep.txt'), 'Retain this hub');
  await fs.writeFile(path.join(parent, 'Private hub 2'), 'Retain this name');
  await fs.symlink(path.join(parent, 'Private hub'), path.join(parent, 'Private hub 3'));
  assert.equal(await privateConversionDestination(parent), path.join(parent, 'Private hub 4'));
  assert.equal(await fs.readFile(path.join(parent, 'keep.txt'), 'utf8'), 'Retain this file');
  assert.equal(await fs.readFile(path.join(parent, 'Private hub', 'keep.txt'), 'utf8'), 'Retain this hub');
  assert.equal(await fs.readFile(path.join(parent, 'Private hub 2'), 'utf8'), 'Retain this name');
  assert.equal((await fs.lstat(path.join(parent, 'Private hub 3'))).isSymbolicLink(), true);
  assert.equal((await fs.readdir(parent)).length, 4);
});

test('a newly created folder selected from the dialog is a parent, never adopted as private storage', async t => {
  const root = await fixture(t);
  const selected = path.join(root, 'New Folder'); await fs.mkdir(selected);
  assert.equal(await privateConversionDestination(selected), path.join(selected, 'Private hub'));
  assert.deepEqual(await fs.readdir(selected), []);
});

test('non-directory and linked parents are refused with a fixed safe failure', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'file'); await fs.writeFile(file, 'Keep me');
  const link = path.join(root, 'link'); await fs.symlink(root, link);
  for (const selected of [file, link, 'relative-parent']) {
    await assert.rejects(privateConversionDestination(selected), error => privateConversionFailureCode(error) === 'destination-unavailable');
  }
});

test('case-variant selected folders resolve to the canonical parent without changing existing files', async t => {
  const root = await fixture(t);
  const parent = path.join(root, 'Enc_Hub'); await fs.mkdir(parent);
  const selected = path.join(root, 'Enc_hub');
  try { await fs.lstat(selected); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') { throw error; }
    t.skip('Requires a case-insensitive filesystem'); return;
  }
  const canonical = await fs.realpath(parent);
  assert.notEqual(selected, canonical);
  await fs.writeFile(path.join(parent, 'keep.txt'), 'Keep this existing file');
  await fs.mkdir(path.join(parent, 'Private hub'));
  await fs.writeFile(path.join(parent, 'Private hub', 'keep.txt'), 'Keep this existing hub');
  const before = await fs.lstat(parent);

  assert.equal(await privateConversionDestination(selected), path.join(canonical, 'Private hub 2'));

  const after = await fs.lstat(parent);
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
  assert.deepEqual((await fs.readdir(parent)).sort(), ['Private hub', 'keep.txt']);
  assert.equal(await fs.readFile(path.join(parent, 'keep.txt'), 'utf8'), 'Keep this existing file');
  assert.equal(await fs.readFile(path.join(parent, 'Private hub', 'keep.txt'), 'utf8'), 'Keep this existing hub');
});

test('case variants in ancestor segments return a canonical destination without creating it', async t => {
  const root = await fixture(t);
  const parent = path.join(root, 'Containing_Folder', 'Enc_Hub'); await fs.mkdir(parent, { recursive: true });
  const selected = path.join(root, 'containing_folder', 'enc_hub');
  try { await fs.lstat(selected); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') { throw error; }
    t.skip('Requires a case-insensitive filesystem'); return;
  }
  const canonical = await fs.realpath(parent);
  assert.notEqual(selected, canonical);
  assert.equal(await privateConversionDestination(selected), path.join(canonical, 'Private hub'));
  assert.deepEqual(await fs.readdir(parent), []);
});

test('a selected directory reached through a linked ancestor is still refused', async t => {
  const root = await fixture(t);
  const actual = path.join(root, 'actual'); await fs.mkdir(actual);
  const parent = path.join(actual, 'Enc_Hub'); await fs.mkdir(parent);
  const linked = path.join(root, 'linked'); await fs.symlink(actual, linked);
  const selected = path.join(linked, 'Enc_Hub');
  assert.equal((await fs.lstat(selected)).isDirectory(), true);
  assert.equal((await fs.lstat(selected)).isSymbolicLink(), false);

  await assert.rejects(privateConversionDestination(selected), error => privateConversionFailureCode(error) === 'destination-unavailable');

  assert.deepEqual(await fs.readdir(parent), []);
  assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
});
