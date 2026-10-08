'use strict';

// Test-only writer: synthetic credentials arrive through IPC. Real filesystem
// publication is paused at one boundary; the parent terminates only this child.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { getPrivateHelperPath } = require('./private-helper-paths.ts');
const { PRIVATE_HUB_HEADER_FILE, PrivateHubStore } = require('./private-hub-store.ts');

const checkout = fs.realpathSync(path.resolve(__dirname, '..'));
let store;
let helper;

process.once('disconnect', () => process.exit(1));
process.once('message', async message => {
  try {
    assert.ok(message && ['before-header', 'after-header'].includes(message.stage));
    assert.equal(typeof message.password, 'string');
    assert.equal(typeof message.replacement, 'string');
    assert.equal(typeof message.root, 'string');
    const root = message.root;
    assert.equal(path.dirname(root), path.join(checkout, 'tmp'));
    assert.match(path.basename(root), /^private-password-interruption-[a-zA-Z0-9]{6}$/);
    assert.equal(await fs.promises.realpath(root), root);
    const directory = path.join(root, 'hub');
    assert.equal(await fs.promises.realpath(directory), directory);
    assert.equal(process.cwd(), checkout);

    const nativeHelper = getPrivateHelperPath('private-hub-lock');
    assert.ok(fs.realpathSync(nativeHelper).startsWith(checkout + path.sep));
    const spawn = childProcess.spawn;
    childProcess.spawn = (...args) => {
      assert.equal(args[0], nativeHelper);
      assert.equal(helper, undefined);
      helper = spawn(...args);
      assert.ok(Number.isInteger(helper.pid) && helper.pid > 1);
      process.send({ type: 'helper', helperPid: helper.pid });
      return helper;
    };
    store = await PrivateHubStore.open(directory, message.password);
    childProcess.spawn = spawn;

    const header = path.join(directory, PRIVATE_HUB_HEADER_FILE);
    const rename = fs.promises.rename;
    const checkpoint = async stage => {
      if (stage !== message.stage) { return; }
      process.send({ type: 'checkpoint', stage, helperPid: helper.pid });
      await new Promise(() => {});
    };
    fs.promises.rename = async (source, target) => {
      assert.equal(path.dirname(String(source)), directory);
      assert.match(path.basename(String(source)), /^private-hub\.json\.[0-9a-f]{48}\.pending$/);
      assert.equal(target, header);
      await checkpoint('before-header');
      await rename(source, target);
      // Publication completed, but commitFile has not resumed to update its
      // snapshot or sync the directory. This does not simulate power loss.
      await checkpoint('after-header');
    };
    await store.changePassword(message.password, message.replacement, () => true);
    throw new Error('Expected interruption checkpoint was not reached.');
  } catch {
    try { await store?.lock(); } catch { /* Parent termination closes inherited descriptors. */ }
    process.send?.({ type: 'failed' }, () => process.exit(1));
    if (!process.connected) { process.exit(1); }
  }
});
