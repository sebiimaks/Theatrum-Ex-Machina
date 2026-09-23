'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Arch } = require('builder-util');
const { helperNames, verifyNativeHelpers } = require('./privacy-package.cjs');

function preparePrivacyPackage(context, runtime = {}) {
  const platform = context.electronPlatformName;
  const helpers = helperNames(platform);
  // The Windows backend is unavailable. Do not copy stale macOS/Linux helpers
  // into that package or make an unsupported native compilation a requirement.
  if (helpers.length === 0) { return; }
  const hostPlatform = runtime.platform ?? process.platform;
  const hostArch = runtime.arch ?? process.arch;
  const targetArch = Arch[context.arch];
  assert.ok(platform === hostPlatform && targetArch === hostArch && ['arm64', 'x64'].includes(targetArch),
    'Privacy packages must be built natively for their target platform and architecture.');
  const project = fs.realpathSync(path.join(__dirname, '..'));
  assert.equal(fs.realpathSync(context.packager.projectDir), project, 'Unexpected privacy package project directory.');
  const run = runtime.run ?? spawnSync;
  for (const script of ['build-privacy-tools.mjs', ...(platform === 'darwin' ? ['build-touch-id.mjs'] : [])]) {
    const result = run(process.execPath, [path.join(project, 'bin', script)], { cwd: project, stdio: 'inherit', timeout: 120_000 });
    assert.ok(!result.error && result.status === 0, 'Native privacy helper compilation failed.');
  }
  // Refuse a stale, linked, wrong-architecture or truncated compiler output.
  (runtime.verify ?? verifyNativeHelpers)(path.join(project, 'build', 'privacy-tools'), platform, targetArch);
}

exports.default = context => preparePrivacyPackage(context);
exports.preparePrivacyPackage = preparePrivacyPackage;
