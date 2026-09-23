import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Native host acceptance uses the actual main-process host and compiled
// Angular UI. It never installs or replaces an application.
const repository = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const workspace = '/Users/sm/Workspace';
assert.ok(repository.startsWith(workspace + path.sep), 'Native acceptance must remain in the authorized workspace.');
const require = createRequire(import.meta.url);
const electronPackage = path.dirname(require.resolve('electron/package.json'));
// Reading the package path directly avoids Electron's download/install entry.
const binaryRelative = (await fs.readFile(path.join(electronPackage, 'path.txt'), 'utf8')).trim();
assert.ok(binaryRelative && !path.isAbsolute(binaryRelative) && !binaryRelative.split(/[\\/]/).includes('..'));
const executable = await fs.realpath(path.join(electronPackage, 'dist', binaryRelative));
assert.ok(executable.startsWith(workspace + path.sep), 'Use the existing Workspace Electron installation.');
const requestedAssets = path.join(repository, 'tmp', 'private-transition-angular');
const assets = await fs.realpath(requestedAssets);
assert.equal(assets, requestedAssets, 'Compiled native-acceptance assets must remain in repository tmp.');
assert.ok((await fs.lstat(path.join(assets, 'index.html'))).isFile(), 'Compile the Angular acceptance assets before this native test.');
const fixture = await fs.mkdtemp(path.join(repository, 'tmp', 'private-host-native-'));
const profile = path.join(fixture, 'profile');
await fs.mkdir(profile);

const privateCanary = 'NATIVE_HOST_PRIVATE_' + randomBytes(24).toString('hex');
const privatePassword = 'Native host password ' + randomBytes(24).toString('hex');
const conversionPassword = 'Native host conversion ' + randomBytes(24).toString('hex');
const forbidden = [privateCanary, privatePassword, conversionPassword].flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le')]);
// These exact source values are deliberately plaintext in the normal hub and
// its persistent renderer. Only the new encrypted destination must hide them.
const convertedSourcePatterns = ['Synthetic normal notes saved before private opening', 'Synthetic > Pending draft']
  .flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le')]);
const expectedChecks = {
  'host-started': { hostLoaded: true, angularLoaded: true },
  'host-conversion-review': { draftsSaved: true, normalPaused: true, normalHidden: true, watcherStopped: true,
    countOnlyReview: true, privateIsolated: true, concurrentEntryDenied: true, privateCacheBytes: 0 },
  'host-conversion-cancelled': { latePickerDrained: true, noOutput: true, formDestroyed: true, sourceUnchanged: true,
    normalRestored: true, watcherResumed: true },
  'host-conversion-private': { draftsCopied: true, previewDecoded: true, normalPaused: true, watcherStopped: true,
    formDestroyed: true, galleryIsolated: true, sourceUnchanged: true, existingFolderPreserved: true,
    sourceParentChangeAccepted: true, newChildCreated: true, privateCacheBytes: 0 },
  'host-conversion-restored': { receiptVerified: true, activationVerified: true, missingStatePreserved: true,
    sourceUnchanged: true, normalRestored: true, watcherResumed: true },
  'host-conversion-reopened': { passwordReopened: true, privateEditPersisted: true, ordinaryUnchanged: true,
    normalRestored: true, historyUnchanged: true },
  'host-private': { normalPaused: true, normalHidden: true, privateIsolated: true, watcherStopped: true, ipcDenied: true, privateCacheBytes: 0 },
  'host-restored': { normalResumed: true, normalVisible: true, privateWindowDestroyed: true, watcherResumed: true, addedVideoDiscovered: true },
  'host-save-cancelled': { keepWorking: true, draftPreserved: true, normalRestored: true },
  'host-quit-cancelled': { quitCancelled: true, normalRestored: true, catalogueOpenDeferred: true },
  'host-reopened': { reopened: true, normalRestored: true },
  'host-closed': { windowClosed: true, catalogueSaved: true, settingsSaved: true },
};
const expectedStages = Object.keys(expectedChecks);
const checkpoints = [];
let scans = 0;
let profileFilesScanned = 0;
let encryptedFilesScanned = 0;
let convertedFilesScanned = 0;
let ordinaryFilesScanned = 0;

function safeCheckpointChecks(stage, checks) {
  assert.ok(Object.hasOwn(expectedChecks, stage), 'Unexpected native acceptance checkpoint stage.');
  assert.ok(checks && typeof checks === 'object' && !Array.isArray(checks), 'Invalid native acceptance checkpoint.');
  const expected = expectedChecks[stage];
  assert.ok(Object.keys(checks).length === Object.keys(expected).length
    && Object.keys(checks).every(key => Object.hasOwn(expected, key)), 'Native acceptance checkpoint fields do not match the required stage.');
  for (const [key, value] of Object.entries(expected)) {
    // Do not pass renderer-supplied values to assertion diagnostics or output.
    assert.ok(checks[key] === value, 'A required native acceptance check did not pass.');
  }
  return { ...expected };
}

async function scanPrivateContent(signal, requireConverted = false) {
  const sourcePreview = path.join(fixture, 'ordinary-hub', 'vha-Synthetic', 'thumbnails', 'normal-video.jpg');
  const previewStats = await fs.lstat(sourcePreview);
  assert.ok(previewStats.isFile() && !previewStats.isSymbolicLink() && previewStats.nlink === 1 && previewStats.size <= 1024 * 1024,
    'The converted preview scan requires an owned bounded source file.');
  const previewBytes = await fs.readFile(sourcePreview, { signal });
  const visit = async (directory, kind = 'profile') => {
    signal.throwIfAborted();
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') { return; } throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'A native acceptance fixture must not escape through a symlink.');
      if (entry.isDirectory()) { await visit(file, kind); continue; }
      if (!entry.isFile()) { continue; }
      let bytes;
      try { bytes = await fs.readFile(file, { signal }); }
      catch (error) { if (error.code === 'ENOENT') { continue; } throw error; }
      if (kind === 'encrypted' || kind === 'converted') { encryptedFilesScanned++; }
      else if (kind === 'ordinary') { ordinaryFilesScanned++; }
      else { profileFilesScanned++; }
      if (kind === 'converted') { convertedFilesScanned++; }
      try {
        assert.ok(!forbidden.some(value => bytes.includes(value)), 'Private synthetic content appeared in persistent storage.');
        if (kind === 'converted') {
          assert.ok(!convertedSourcePatterns.some(value => bytes.includes(value)) && !bytes.includes(previewBytes),
            'Converted source plaintext appeared in the encrypted destination.');
        }
      }
      finally { bytes.fill(0); }
    }
  };
  // Ordinary catalogue text and previews are allowed, but must never acquire
  // private catalogue values or passwords. Deliberate review screenshots stay
  // outside these scans. Normal Angular asset caching is expected.
  const encryptedHub = path.join(fixture, 'encrypted-hub');
  const convertedHub = path.join(fixture, 'ordinary-hub', 'selected-folder', 'Private hub 2');
  const ordinaryHub = path.join(fixture, 'ordinary-hub');
  try {
    for (const root of [profile, encryptedHub, ordinaryHub]) {
      assert.ok((await fs.lstat(root)).isDirectory(), 'A required native acceptance scan root is missing or is a symbolic link.');
    }
    await visit(profile);
    const priorEncryptedFiles = encryptedFilesScanned;
    await visit(encryptedHub, 'encrypted');
    // This destination exists only after actual-host creation. The earlier
    // cancellation stage must leave it absent; the child verifies that boundary.
    try { assert.ok((await fs.lstat(convertedHub)).isDirectory(), 'The converted scan root must be an owned directory.'); }
    catch (error) { if (error.code !== 'ENOENT' || requireConverted) { throw error; } }
    const priorConvertedFiles = convertedFilesScanned;
    await visit(convertedHub, 'converted');
    if (requireConverted) {
      assert.ok(convertedFilesScanned > priorConvertedFiles, 'Every post-creation checkpoint must scan the converted hub.');
    }
    assert.ok(encryptedFilesScanned > priorEncryptedFiles, 'Every acceptance checkpoint must scan the encrypted hub.');
    const priorOrdinaryFiles = ordinaryFilesScanned;
    await visit(ordinaryHub, 'ordinary');
    assert.ok(ordinaryFilesScanned > priorOrdinaryFiles, 'Every acceptance checkpoint must scan the ordinary hub.');
    scans++;
  } finally { previewBytes.fill(0); }
}

async function run() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const name of ['ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'CHROME_LOG_FILE', 'FFREPORT']) { delete environment[name]; }
  environment.VIDEO_HUB_APP_SIN_MEDIA_TOOLS = path.join(repository, 'build', 'media-tools');
  environment.TMPDIR = path.join(profile, 'temporary');
  environment.TEMP = environment.TMPDIR;
  environment.TMP = environment.TMPDIR;
  await fs.mkdir(environment.TMPDIR, { recursive: true });
  const child = spawn(executable, [path.join(repository, 'node', 'private-host-native.cjs'),
    '--private-host-fixture=' + fixture, '--private-host-assets=' + assets,
    '--user-data-dir=' + path.join(profile, 'user-data'), '--disk-cache-dir=' + path.join(profile, 'disk-cache'),
    '--crash-dumps-dir=' + path.join(profile, 'crash-dumps')], {
    cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Consume native diagnostics without persisting or forwarding resource URLs,
  // paths, or private renderer content. Failures expose a bounded stage only.
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  let completed = false;
  let lastStage = 'configuration';
  let failure;
  let chain = Promise.resolve();
  const scanAbort = new AbortController();
  let timeout;
  const deadline = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      failure ??= new Error('Native private-host verification timed out at ' + lastStage + '.');
      scanAbort.abort();
      child.kill('SIGKILL');
      reject(failure);
    }, 120_000);
  });
  child.on('message', message => {
    chain = chain.then(async () => {
      if (failure) { return; }
      assert.equal(completed, false, 'Native acceptance sent data after its completion marker.');
      if (message?.type === 'progress') {
        if (typeof message.stage === 'string' && /^[a-z-]{1,50}$/.test(message.stage)) { lastStage = message.stage; }
      } else if (message?.type === 'checkpoint') {
        assert.ok(message.stage === expectedStages[checkpoints.length], 'Unexpected native acceptance checkpoint order.');
        const checks = safeCheckpointChecks(message.stage, message.checks);
        await scanPrivateContent(scanAbort.signal,
          expectedStages.indexOf(message.stage) >= expectedStages.indexOf('host-conversion-private'));
        checkpoints.push({ stage: message.stage, checks });
        await new Promise((resolve, reject) => child.send({ type: 'continue', stage: message.stage }, error => {
          if (error) { reject(new Error('Native acceptance continuation could not be delivered.')); } else { resolve(); }
        }));
      } else if (message?.type === 'complete') {
        assert.equal(checkpoints.length, expectedStages.length, 'Native acceptance ended before all required checkpoints.');
        completed = true;
      } else if (message?.type === 'failure') {
        const stage = typeof message.stage === 'string' && /^[a-z-]{1,50}$/.test(message.stage) ? message.stage : 'unknown';
        const line = Number.isSafeInteger(message.line) && message.line > 0 && message.line <= 100_000 ? ' (fixture line ' + message.line + ')' : '';
        throw new Error('Native private-host verification failed at ' + stage + line + '.');
      } else {
        throw new Error('Unexpected native acceptance message.');
      }
    }).catch(error => { failure ??= error; scanAbort.abort(); child.kill('SIGKILL'); });
  });
  const ended = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Native acceptance Electron process could not be started.')));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.send({ type: 'configuration', privateCanary, privatePassword, conversionPassword }, error => {
    if (error) { failure ??= new Error('Native acceptance configuration could not be delivered.'); child.kill('SIGKILL'); }
  });
  const completion = async () => {
    const result = await ended;
    await chain;
    if (failure) { throw failure; }
    assert.equal(result.code, 0, 'Native acceptance Electron process did not exit cleanly at ' + lastStage + '.');
    assert.equal(completed, true, 'Native acceptance Electron process did not finish its checks at ' + lastStage + '.');
    assert.deepEqual(checkpoints.map(item => item.stage), expectedStages);
    await scanPrivateContent(scanAbort.signal, true);
    assert.ok(profileFilesScanned > 0 && encryptedFilesScanned > 0 && ordinaryFilesScanned > 0,
      'Native acceptance must scan the application profile, encrypted hub, and ordinary hub.');
  };
  try { await Promise.race([completion(), deadline]); }
  finally { clearTimeout(timeout); }
}

let succeeded = false;
try {
  await run();
  succeeded = true;
  process.stdout.write(JSON.stringify({ passed: true, scans, profileFilesScanned, encryptedFilesScanned, convertedFilesScanned, ordinaryFilesScanned, checkpoints }) + '\n');
} finally {
  for (const bytes of forbidden) { bytes.fill(0); }
  for (const bytes of convertedSourcePatterns) { bytes.fill(0); }
  if (succeeded) { await fs.rm(fixture, { recursive: true, force: true }); }
  else { process.stderr.write('Synthetic native-host fixture retained under repository tmp for diagnosis.\n'); }
}
