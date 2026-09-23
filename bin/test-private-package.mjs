import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// A fixture launcher exercises exact packaged ASAR, physical UI assets and native
// resources. Host mode loads its untouched main.js and invokes its registered
// native menu entries. The outer launcher is a fixture, never signing acceptance
// or production release packaging.
const repository = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
assert.ok(repository.startsWith('/Users/sm/Workspace/'));
assert.equal(process.platform, 'darwin');
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const args = process.argv.slice(2);
const hostMode = args.includes('--host');
assert.ok(args.filter(value => value === '--host').length <= 1);
const appArguments = args.filter(value => value !== '--host');
assert.ok(appArguments.length <= 1 && !appArguments.some(value => value.startsWith('--')));
const sourceApp = path.resolve(appArguments[0] || path.join(repository, 'release-test', 'mac-arm64', 'Theatrum Ex Machina.app'));
assert.ok(sourceApp.startsWith(repository + path.sep) && sourceApp.endsWith('.app'));
assert.equal(await fs.realpath(sourceApp), sourceApp);
const inside = (root, file) => file.startsWith(root + path.sep);
async function safeTree(root, directory = root) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { assert.ok(inside(root, await fs.realpath(file)), 'Bundle links must remain in their own bundle.'); }
    else if (entry.isDirectory()) { await safeTree(root, file); }
    else { assert.ok(entry.isFile(), 'Unexpected bundle file type.'); }
  }
}
await safeTree(sourceApp);
const wire = await getCurrentFuseWire(sourceApp);
assert.equal(wire.version, '1');
// Never flip a fuse or invalidate a verified ASAR identity to run a fixture.
assert.equal(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], 48,
  'The fixture launcher cannot run with embedded ASAR integrity enabled; no fuse will be changed.');
const relativeMaterials = ['Contents/Resources/app.asar', 'Contents/MacOS/Theatrum Ex Machina',
  'Contents/Info.plist', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  'Contents/Resources/privacy-tools/private-hub-lock', 'Contents/Resources/privacy-tools/private-touch-id.node'];
const unpackedPrefix = 'Contents/Resources/app.asar.unpacked/';
async function unpackedMaterials(appRoot) {
  const root = path.join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked');
  let stat;
  try { stat = await fs.lstat(root); }
  catch (error) { if (error.code === 'ENOENT') { return []; } throw error; }
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Unpacked package content must have a physical directory.');
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Unpacked package content must not follow links.');
      if (entry.isDirectory()) { await visit(file); }
      else {
        assert.ok(entry.isFile(), 'Unpacked package content must contain regular files.');
        files.push(path.relative(appRoot, file));
      }
    }
  }
  await visit(root);
  return files.sort();
}
const unpackedFiles = await unpackedMaterials(sourceApp);
relativeMaterials.push(...unpackedFiles);
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) { hash.update(bytes); }
  return hash.digest('hex');
}
const original = new Map(await Promise.all(relativeMaterials.map(async file => [file, await digest(path.join(sourceApp, file))])));
const mainBytes = asar.extractFile(path.join(sourceApp, relativeMaterials[0]), 'main.js');
const main = mainBytes.toString('utf8');
if (hostMode) {
  assert.match(main, /const PRIVATE_HUB_UI_READY = process\.platform === 'darwin';/);
  assert.match(main, /createPrivateHubMenu/);
  const nativeMenu = asar.extractFile(path.join(sourceApp, relativeMaterials[0]), 'node/private-hub-menu.js').toString('utf8');
  for (const id of ['private-hub-open', 'private-hub-create']) {
    assert.ok(nativeMenu.includes(id), 'Packaged host acceptance requires the shipping native menu entries.');
  }
}
await fs.mkdir(path.join(repository, 'tmp'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(repository, 'tmp', 'private-package-native-'));
const fixtureApp = path.join(fixture, 'Private package fixture.app');
const resources = path.join(fixtureApp, 'Contents', 'Resources');
const profile = path.join(fixture, 'profile');
const encrypted = hostMode ? path.join(fixture, 'ordinary-hub', 'selected-folder', 'Private hub 2') : path.join(fixture, 'encrypted-hub');
const password = 'Packaged private password ' + randomBytes(24).toString('hex');
const marker = 'PACKAGED_PRIVATE_' + randomBytes(24).toString('hex');
const forbidden = [password, marker].flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le')]);
const expectedStages = hostMode
  ? ['host-started', 'host-created', 'host-restored', 'host-reopened', 'host-closed']
  : ['packaged-material', 'static-protocols', 'credential-windows', 'private-gallery', 'private-closed'];
const expectedChecks = hostMode ? {
  'host-started': ['packagedMain', 'ordinaryUiLoaded', 'nativeMenuRegistered', 'syntheticCatalogueLoaded'],
  'host-created': ['nativeConversion', 'previewDecoded', 'notesSaved', 'ordinaryPaused', 'privateIsolated', 'noDiskCache',
    'existingFolderPreserved', 'sourceParentChangeAccepted', 'newChildCreated'],
  'host-restored': ['privateDestroyed', 'ordinaryRestored', 'menuRestored', 'ordinaryUnchanged'],
  'host-reopened': ['nativePasswordUnlock', 'notesPersisted', 'previewDecoded', 'privateIsolated', 'noDiskCache'],
  'host-closed': ['privateDestroyed', 'ordinaryRestored', 'ordinaryClosed', 'settingsSaved', 'noPrivateRecentWrites'],
} : {
  'packaged-material': ['packagedRuntime', 'compiledModules', 'fixedHelperPaths', 'nativeAddonLoaded', 'nativeLeaseUsed'],
  'static-protocols': ['unlockAssets', 'conversionAssets', 'galleryAssets', 'noStore', 'routesRestricted'],
  'credential-windows': ['unlockLoaded', 'conversionLoaded', 'isolated', 'cancelDrained', 'menuRestored'],
  'private-gallery': ['galleryLoaded', 'previewDecoded', 'metadataVisible', 'isolated', 'noDiskCache'],
  'private-closed': ['galleryDestroyed', 'storeLocked', 'menuRestored', 'noDefaultRequests', 'noRecentWrites'],
};
let scans = 0;
const filesScanned = { profile: 0, encryptedHub: 0, ...(hostMode ? { ordinaryHub: 0 } : {}) };
const checkpoints = [];
async function scan(root, scope) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    assert.ok(!entry.isSymbolicLink(), 'Persistent fixture storage must not contain symbolic links.');
    const file = path.join(root, entry.name);
    assert.ok(![marker, password].some(value => entry.name.includes(value)), 'Private data appeared in a stored filename.');
    if (entry.isDirectory()) { await scan(file, scope); continue; }
    if (!entry.isFile()) { continue; }
    let bytes;
    try { bytes = await fs.readFile(file); }
    catch (error) { if (error.code === 'ENOENT') { continue; } throw error; }
    try { assert.ok(!forbidden.some(value => bytes.includes(value)), 'Private data appeared in fixture persistent storage.'); }
    finally { bytes.fill(0); }
    filesScanned[scope]++;
  }
}
async function scanPersistent() {
  const roots = [[profile, 'profile'], [encrypted, 'encryptedHub']];
  if (hostMode) { roots.push([path.join(fixture, 'ordinary-hub'), 'ordinaryHub']); }
  for (const [root, scope] of roots) {
    let stat;
    try { stat = await fs.lstat(root); }
    catch (error) {
      // The selected parent may exist, but its new encrypted child must not.
      // Only the first host checkpoint precedes actual creation.
      if (hostMode && scope === 'encryptedHub' && checkpoints.length === 0 && error.code === 'ENOENT') { continue; }
      throw error;
    }
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Persistent scan roots must exist as physical directories.');
    assert.equal(await fs.realpath(root), root);
    const previous = filesScanned[scope];
    await scan(root, scope);
    assert.ok(filesScanned[scope] > previous, 'Every persistent root must contain scanned files at every checkpoint.');
  }
  scans++;
}
async function verifySourceUnchanged() {
  assert.deepEqual(await unpackedMaterials(sourceApp), unpackedFiles, 'The untouched unpacked package inventory changed.');
  for (const [relative, hash] of original) {
    assert.equal(await digest(path.join(sourceApp, relative)), hash, 'The untouched test package changed during fixture acceptance.');
  }
}
async function prepare() {
  await fs.cp(sourceApp, fixtureApp, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  await safeTree(fixtureApp);
  assert.deepEqual(await unpackedMaterials(fixtureApp), unpackedFiles, 'The fixture unpacked inventory differs from its package.');
  for (const [relative, hash] of original) { assert.equal(await digest(path.join(fixtureApp, relative)), hash); }
  // Keep the exact reviewed ASAR; a separate tiny ASAR is only the test launcher.
  await fs.rename(path.join(resources, 'app.asar'), path.join(resources, 'payload.asar'));
  // Preserve the normal fixed resource paths and also the renamed archive's
  // companion path if Electron has unpacked any production dependencies.
  try {
    await fs.lstat(path.join(resources, 'app.asar.unpacked'));
    await fs.cp(path.join(resources, 'app.asar.unpacked'), path.join(resources, 'payload.asar.unpacked'),
      { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
  for (const relative of unpackedFiles) {
    const copy = path.join(resources, 'payload.asar.unpacked', relative.slice(unpackedPrefix.length));
    assert.equal(await digest(copy), original.get(relative), 'A fixture physical UI asset or dependency differs from the packaged original.');
  }
  const launcher = path.join(fixture, 'launcher');
  await fs.mkdir(launcher);
  await fs.writeFile(path.join(launcher, 'package.json'), JSON.stringify({ name: 'private-package-acceptance', version: '0.0.0', main: 'main.cjs' }));
  const driver = hostMode ? 'private-package-host-native.cjs' : 'private-package-native.cjs';
  await fs.writeFile(path.join(launcher, 'main.cjs'), "'use strict';\nrequire(" + JSON.stringify(path.join(repository, 'node', driver)) + ');\n');
  await asar.createPackage(launcher, path.join(resources, 'app.asar'));
  await fs.mkdir(path.join(profile, 'temporary'), { recursive: true });
}
async function run() {
  const environment = { ...process.env, TMPDIR: path.join(profile, 'temporary'),
    TMP: path.join(profile, 'temporary'), TEMP: path.join(profile, 'temporary'), PORTABLE_EXECUTABLE_DIR: path.join(profile, 'settings') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'CHROME_LOG_FILE',
    'FFREPORT', 'THEATRUM_PACKAGED_SMOKE_TEST', 'VIDEO_HUB_APP_SIN_MEDIA_TOOLS']) { delete environment[key]; }
  const child = spawn(path.join(fixtureApp, 'Contents', 'MacOS', 'Theatrum Ex Machina'),
    ['--private-package-fixture=' + fixture, '--user-data-dir=' + path.join(profile, 'user-data'),
      '--disk-cache-dir=' + path.join(profile, 'disk-cache'), '--crash-dumps-dir=' + path.join(profile, 'crash-dumps')],
    { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // No arbitrary exception, native output, path, URL or decrypted content is logged.
  child.stdout.on('data', () => undefined); child.stderr.on('data', () => undefined);
  let stage = 'startup';
  let completed = false;
  let failure;
  let chain = Promise.resolve();
  const timer = setTimeout(() => { failure ??= new Error('Packaged fixture timed out at ' + stage + '.'); child.kill('SIGKILL'); }, 120_000);
  child.on('message', message => {
    chain = chain.then(async () => {
      if (failure) { return; }
      assert.equal(completed, false);
      if (message?.type === 'progress') {
        assert.ok(typeof message.stage === 'string' && /^[a-z-]{1,50}$/.test(message.stage)); stage = message.stage;
      } else if (message?.type === 'checkpoint') {
        assert.equal(message.stage, expectedStages[checkpoints.length]);
        const keys = expectedChecks[message.stage];
        assert.deepEqual(Object.keys(message.checks).sort(), [...keys].sort());
        for (const key of keys) { assert.equal(message.checks[key], true, 'A required packaged fixture check failed.'); }
        await scanPersistent();
        checkpoints.push({ stage: message.stage, checks: Object.fromEntries(keys.map(key => [key, true])) });
        await new Promise((resolve, reject) => child.send({ type: 'continue', stage: message.stage }, error => error ? reject(new Error('Fixture continuation failed.')) : resolve()));
      } else if (message?.type === 'complete') { assert.equal(checkpoints.length, expectedStages.length); completed = true; }
      else if (message?.type === 'failure') {
        const line = Number.isSafeInteger(message.line) && message.line > 0 && message.line < 100000 ? ' (fixture line ' + message.line + ')' : '';
        throw new Error('Packaged fixture failed at ' + stage + line + '.');
      } else { throw new Error('Unexpected packaged fixture message.'); }
    }).catch(error => { failure ??= error; child.kill('SIGKILL'); });
  });
  const ended = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Packaged fixture could not start.')));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.send({ type: 'configuration', marker, password }, error => {
    if (error) { failure ??= new Error('Fixture configuration failed.'); child.kill('SIGKILL'); }
  });
  try {
    const result = await ended; await chain;
    if (failure) { throw failure; }
    assert.equal(result.code, 0, 'Packaged fixture exited unexpectedly at ' + stage + '.');
    assert.equal(completed, true, 'Packaged fixture stopped before completion.');
    await scanPersistent();
    assert.ok(filesScanned.profile > 0 && filesScanned.encryptedHub > 0);
    if (hostMode) { assert.ok(filesScanned.ordinaryHub > 0); }
  } finally { clearTimeout(timer); }
}
let succeeded = false;
try {
  await prepare(); await run();
  succeeded = true;
} finally {
  for (const bytes of forbidden) { bytes.fill(0); }
  await verifySourceUnchanged();
  if (succeeded) { await fs.rm(fixture, { recursive: true, force: true }); }
  else { process.stderr.write('Synthetic packaged fixture retained under repository tmp for diagnosis.\n'); }
}
process.stdout.write(JSON.stringify({ passed: true, mode: hostMode ? 'host' : 'modules', evidence: hostMode
  ? 'fixture loading untouched packaged main.js and its registered native menu entries; exact ASAR, unpacked UI assets and native resources; not signing acceptance'
  : 'fixture using exact packaged ASAR, unpacked UI assets and native resources; not untouched-app private entry or signing acceptance',
  archiveSha256: original.get(relativeMaterials[0]), unpackedFilesVerified: unpackedFiles.length, scans, filesScanned, checkpoints }) + '\n');
