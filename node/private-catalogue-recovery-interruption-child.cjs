'use strict';

// Synthetic, test-only writer. The parent owns this child and terminates it at
// one real rename boundary; passwords and fixture paths arrive only over IPC.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { getPrivateHelperPath } = require('./private-helper-paths.ts');
const { PrivateHubStore } = require('./private-hub-store.ts');

const checkout = fs.realpathSync(path.resolve(__dirname, '..'));
let store;
let helper;

process.once('disconnect', () => process.exit(1));
process.once('message', async message => {
  try {
    assert.ok(message && ['before-primary', 'after-primary'].includes(message.stage));
    assert.equal(typeof message.password, 'string');
    assert.equal(typeof message.root, 'string');
    const root = message.root;
    assert.equal(path.dirname(root), path.join(checkout, 'tmp'));
    assert.match(path.basename(root), /^private-catalogue-recovery-interruption-[a-zA-Z0-9]{6}$/);
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
    const rename = fs.promises.rename;
    const checkpoint = async stage => {
      if (stage !== message.stage) { return; }
      const evidence = (await fs.promises.readdir(directory)).filter(name => /^[0-9a-f]{48}\.recovery$/.test(name));
      assert.equal(evidence.length, 1, 'Evidence publication must precede primary replacement.');
      process.send({ type: 'checkpoint', stage, helperPid: helper.pid });
      await new Promise(() => {});
    };
    fs.promises.rename = async (source, target) => {
      assert.equal(path.dirname(String(source)), directory);
      assert.match(path.basename(String(source)), /^[0-9a-f]{64}\.sealed\.[0-9a-f]{48}\.pending$/);
      assert.equal(target, primary);
      await checkpoint('before-primary');
      await rename(source, target);
      // The real rename completed, but directory sync has not resumed. This
      // tests process death, not durable recovery after a machine power loss.
      await checkpoint('after-primary');
    };
    await store.recoverRecordWithReview('catalogue', {
      maximumBytes: 4096,
      validate: bytes => {
        try {
          const value = JSON.parse(bytes.toString('utf8'));
          return value && typeof value === 'object' && value.revision === 'A' && typeof value.notes === 'string';
        } catch { return false; }
      },
      confirm: async () => true,
      isCurrent: () => true,
    });
    throw new Error('Expected interruption checkpoint was not reached.');
  } catch {
    try { await store?.lock(); } catch { /* Parent death closes inherited descriptors. */ }
    process.send?.({ type: 'failed' }, () => process.exit(1));
    if (!process.connected) { process.exit(1); }
  }
});
