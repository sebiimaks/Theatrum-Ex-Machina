'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const privateAssets = Object.freeze([
  'private-password-preload.cjs', 'private-conversion-preload.cjs', 'private-gallery-preload.cjs',
  'private-unlock/index.html', 'private-unlock/unlock.css', 'private-unlock/unlock.js',
  'private-conversion/index.html', 'private-conversion/conversion.css', 'private-conversion/conversion.js',
  'private-gallery/index.html', 'private-gallery/gallery.css', 'private-gallery/gallery.js',
]);
const privateModules = Object.freeze([
  'node/private-helper-paths.js', 'node/private-ui-paths.js', 'node/private-hub-lock.js', 'node/private-touch-id.js',
  'node/private-hub-browser.js', 'node/private-conversion-workspace.js', 'node/private-application-workspace.js',
  'node/private-hub-menu.js',
  'node/private-conversion-destination.js', 'node/private-conversion-errors.js',
]);
function helperNames(platform) {
  if (platform === 'darwin') { return ['private-hub-lock', 'private-touch-id.node']; }
  if (platform === 'linux') { return ['private-hub-lock']; }
  if (platform === 'win32') { return []; }
  throw new Error('Unsupported privacy package platform.');
}
function regularFile(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0,
    'A privacy package file must be a nonempty regular file.');
  return stat;
}
function verifyNativeHelpers(directory, platform, arch) {
  const helpers = helperNames(platform);
  if (helpers.length === 0) { return; }
  assert.ok(['arm64', 'x64'].includes(arch), 'Unsupported privacy helper architecture.');
  assert.equal(fs.realpathSync(directory), directory, 'Privacy helpers must use a canonical resource directory.');
  for (const name of helpers) {
    const file = path.join(directory, name);
    regularFile(file);
    fs.accessSync(file, fs.constants.X_OK);
    const descriptor = fs.openSync(file, 'r');
    const header = Buffer.alloc(32);
    try { assert.equal(fs.readSync(descriptor, header, 0, header.length, 0), header.length); }
    finally { fs.closeSync(descriptor); }
    if (platform === 'darwin') {
      assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'Expected a native 64-bit Mach-O privacy helper.');
      assert.equal(header.readUInt32LE(4), arch === 'arm64' ? 0x0100000c : 0x01000007,
        'Privacy helper architecture differs from its package target.');
      assert.equal(header.readUInt32LE(12), name.endsWith('.node') ? 8 : 2,
        'Expected a native bundle or executable privacy helper.');
    } else {
      assert.deepEqual([...header.subarray(0, 6)], [0x7f, 0x45, 0x4c, 0x46, 2, 1], 'Expected a little-endian ELF64 privacy helper.');
      assert.equal(header.readUInt16LE(18), arch === 'arm64' ? 183 : 62,
        'Privacy helper architecture differs from its package target.');
      assert.ok([2, 3].includes(header.readUInt16LE(16)), 'Expected an executable or PIE privacy helper.');
    }
  }
}

/** Verify actual ASAR content plus fixed native resources without running either. */
function verifyPrivacyPayload({ resourcesPath, projectDirectory, platform, arch, asar }) {
  const archive = path.join(resourcesPath, 'app.asar');
  const entries = new Set(asar.listPackage(archive));
  for (const asset of privateAssets) {
    assert.ok(entries.has('/' + asset), 'A private document asset or preload is missing from the application archive.');
    assert.equal(asar.statFile(archive, asset).unpacked, true, 'Private UI assets must be physical unpacked files.');
    const unpacked = path.join(resourcesPath, 'app.asar.unpacked', asset);
    regularFile(unpacked);
    assert.equal(fs.realpathSync(unpacked), unpacked, 'Packaged private assets must not use linked paths.');
    regularFile(path.join(projectDirectory, asset));
    assert.ok(asar.extractFile(archive, asset).equals(fs.readFileSync(path.join(projectDirectory, asset))),
      'A packaged private document asset differs from its reviewed source.');
  }
  for (const file of privateModules) {
    assert.ok(entries.has('/' + file) && asar.extractFile(archive, file).length > 0,
      'A required private main-process module is missing from the application archive.');
  }
  assert.ok(![...entries].some(file => /\/(?:private-[^/]+-native|private-host-instrumentation)\.cjs$/.test(file)),
    'Native privacy acceptance drivers must not ship in the application archive.');
  assert.ok(![...entries].some(file => file.startsWith('/build/privacy-tools/') || file.startsWith('/privacy-tools/')),
    'Native privacy helpers must live outside the application archive.');
  verifyNativeHelpers(path.join(resourcesPath, 'privacy-tools'), platform, arch);
}

module.exports = { privateAssets, privateModules, helperNames, verifyNativeHelpers, verifyPrivacyPayload };
