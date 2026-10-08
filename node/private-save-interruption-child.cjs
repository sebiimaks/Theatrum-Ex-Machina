'use strict';

// Test-only writer. The parent sends synthetic data over IPC, waits for a
// filesystem boundary, then kills this process. No production hook is needed.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { getPrivateHelperPath } = require('./private-helper-paths.ts');
const { PrivateHubStore } = require('./private-hub-store.ts');
const { writePrivateHubCatalogue } = require('./private-hub-catalogue.ts');

const stages = ['before-backup', 'after-backup', 'before-primary', 'after-primary'];
const checkout = fs.realpathSync(path.resolve(__dirname, '..'));
let store;
let helper;

process.once('disconnect', () => process.exit(1));
process.once('message', async message => {
  try {
    assert.ok(message && stages.includes(message.stage));
    assert.equal(typeof message.password, 'string');
    assert.equal(typeof message.root, 'string');
    // Refuse paths outside one canonical synthetic fixture in this checkout.
    const root = message.root;
    assert.equal(path.dirname(root), path.join(checkout, 'tmp'));
    assert.match(path.basename(root), /^private-save-interruption-[a-zA-Z0-9]{6}$/);
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
    const names = (await fs.promises.readdir(directory)).filter(name => /^[0-9a-f]{64}\.sealed$/.test(name));
    assert.equal(names.length, 1);
    const primary = path.join(directory, names[0]);
    const backup = primary + '.bak';
    const rename = fs.promises.rename;
    const checkpoint = async stage => {
      if (stage !== message.stage) { return; }
      assert.ok(Number.isInteger(helper.pid) && helper.pid > 1);
      process.send({ type: 'checkpoint', stage, helperPid: helper.pid });
      await new Promise(() => {});
    };
    fs.promises.rename = async (source, target) => {
      assert.ok(path.dirname(String(source)) === directory && String(source).endsWith('.pending'));
      assert.ok(target === primary || target === backup);
      const record = target === backup ? 'backup' : 'primary';
      await checkpoint(`before-${record}`);
      await rename(source, target);
      // The real rename completed, but commitFile has not reached its directory
      // sync. This models process termination, not a power-loss durability test.
      await checkpoint(`after-${record}`);
    };
    await writePrivateHubCatalogue(store, message.catalogue);
    throw new Error('Expected interruption checkpoint was not reached.');
  } catch {
    try { await store?.lock(); } catch { /* Parent termination closes inherited descriptors. */ }
    process.send?.({ type: 'failed' }, () => process.exit(1));
    if (!process.connected) { process.exit(1); }
  }
});
