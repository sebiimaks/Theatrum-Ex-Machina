import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Explicit native acceptance only; no packaging, installation or existing hub.
const repository = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
assert.ok(repository.startsWith('/Users/sm/Workspace/'), 'Native acceptance must remain in the authorized workspace.');
const require = createRequire(import.meta.url);
const electronPackage = path.dirname(require.resolve('electron/package.json'));
const relativeBinary = (await fs.readFile(path.join(electronPackage, 'path.txt'), 'utf8')).trim();
assert.ok(relativeBinary && !path.isAbsolute(relativeBinary) && !relativeBinary.split(/[\\/]/).includes('..'));
const executable = await fs.realpath(path.join(electronPackage, 'dist', relativeBinary));
assert.ok(executable.startsWith('/Users/sm/Workspace/'), 'Use the existing Workspace Electron installation.');
await fs.mkdir(path.join(repository, 'tmp'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(repository, 'tmp', 'private-conversion-native-'));
const profile = path.join(fixture, 'profile');
await fs.mkdir(profile);
const marker = 'NATIVE_CONVERSION_PRIVATE_' + randomBytes(24).toString('hex');
const password = 'Native conversion password ' + randomBytes(24).toString('hex');
const forbidden = [marker, password].flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le')]);
const expected = {
  'conversion-review': { isolated: true, ordinaryBridgeAbsent: true, countOnlyReview: true,
    missingPreviewVisible: true, credentialsEmpty: true, compactControlsReachable: true, cacheBytes: 0, defaultRequests: 0, recentWrites: 0 },
  'picker-cancelled': { originalConsentRequired: true, missingConsentRequired: true, pickerCancelled: true,
    formDestroyed: true, noOutput: true, sourceUnchanged: true, menuRestored: true, cacheBytes: 0, defaultRequests: 0, recentWrites: 0 },
  'conversion-open': { freshFormPartition: true, formDestroyed: true, galleryIsolated: true, imageDecoded: true,
    notesPreserved: true, sourceUnchanged: true, existingFolderPreserved: true, newChildCreated: true,
    cacheBytes: 0, defaultRequests: 0, recentWrites: 0 },
  'conversion-closed': { galleryDestroyed: true, receiptVerified: true, missingStatePreserved: true,
    activationVerified: true, notesPreserved: true, sourceUnchanged: true, menuRestored: true,
    cacheBytes: 0, defaultRequests: 0, recentWrites: 0 },
};
const stages = Object.keys(expected);
const checkpoints = [];
let scans = 0;
let profileFilesScanned = 0;
let encryptedFilesScanned = 0;

function checkedStage(name, checks) {
  assert.ok(Object.hasOwn(expected, name), 'Unexpected native conversion checkpoint.');
  assert.ok(checks && typeof checks === 'object' && !Array.isArray(checks), 'Invalid native conversion checks.');
  const required = expected[name];
  assert.ok(Object.keys(checks).length === Object.keys(required).length &&
    Object.keys(checks).every(key => Object.hasOwn(required, key)), 'Unexpected native conversion checkpoint fields.');
  for (const [key, value] of Object.entries(required)) {
    // Never place an untrusted renderer value in assertion diagnostics.
    assert.ok(checks[key] === value, 'A required native conversion check did not pass.');
  }
  return { ...required };
}

async function scan(signal) {
  const visit = async (directory, encrypted) => {
    signal.throwIfAborted();
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') { return; } throw error; }
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink(), 'A native conversion fixture must not escape through a symlink.');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(file, encrypted); continue; }
      if (!entry.isFile()) { continue; }
      let bytes;
      try { bytes = await fs.readFile(file, { signal }); }
      catch (error) { if (error.code === 'ENOENT') { continue; } throw error; }
      if (encrypted) { encryptedFilesScanned++; } else { profileFilesScanned++; }
      try { assert.ok(!forbidden.some(value => bytes.includes(value)), 'Private synthetic content appeared in persistent storage.'); }
      finally { bytes.fill(0); }
    }
  };
  assert.ok((await fs.lstat(profile)).isDirectory(), 'The redirected profile is missing.');
  await visit(profile, false);
  await visit(path.join(fixture, 'selected-folder', 'Private hub 2'), true);
  // The ordinary fixture deliberately contains the source plaintext. The two
  // review screenshots are outside the profile and contain no credentials.
  scans++;
}

async function run() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const key of ['ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'CHROME_LOG_FILE', 'FFREPORT']) { delete environment[key]; }
  environment.VIDEO_HUB_APP_SIN_MEDIA_TOOLS = path.join(repository, 'build', 'media-tools');
  environment.TMPDIR = path.join(profile, 'temporary');
  environment.TMP = environment.TMPDIR;
  environment.TEMP = environment.TMPDIR;
  await fs.mkdir(environment.TMPDIR, { recursive: true });
  const child = spawn(executable, [path.join(repository, 'node', 'private-conversion-native.cjs'),
    '--private-conversion-fixture=' + fixture,
    '--user-data-dir=' + path.join(profile, 'user-data'), '--disk-cache-dir=' + path.join(profile, 'disk-cache'),
    '--crash-dumps-dir=' + path.join(profile, 'crash-dumps')], {
    cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Consume diagnostics without logging resource URLs, private values or paths.
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  let completed = false;
  let stage = 'configuration';
  let failure;
  let chain = Promise.resolve();
  const cancellation = new AbortController();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      failure ??= new Error('Native private-conversion verification timed out at ' + stage + '.');
      cancellation.abort(); child.kill('SIGKILL'); reject(failure);
    }, 90_000);
  });
  child.on('message', message => {
    chain = chain.then(async () => {
      if (failure) { return; }
      assert.equal(completed, false, 'Native conversion sent data after completion.');
      if (message?.type === 'progress') {
        if (typeof message.stage === 'string' && /^[a-z-]{1,50}$/.test(message.stage)) { stage = message.stage; }
      } else if (message?.type === 'checkpoint') {
        assert.ok(message.stage === stages[checkpoints.length], 'Unexpected native conversion checkpoint order.');
        const checks = checkedStage(message.stage, message.checks);
        await scan(cancellation.signal);
        checkpoints.push({ stage: message.stage, checks });
        await new Promise((resolve, reject) => child.send({ type: 'continue', stage: message.stage }, error => {
          if (error) { reject(new Error('Native conversion continuation could not be delivered.')); } else { resolve(); }
        }));
      } else if (message?.type === 'complete') {
        assert.equal(checkpoints.length, stages.length, 'Native conversion ended before all checkpoints.');
        completed = true;
      } else if (message?.type === 'failure') {
        const failedStage = typeof message.stage === 'string' && /^[a-z-]{1,50}$/.test(message.stage) ? message.stage : 'unknown';
        const line = Number.isSafeInteger(message.line) && message.line > 0 && message.line <= 100_000 ? ' (fixture line ' + message.line + ')' : '';
        throw new Error('Native private-conversion verification failed at ' + failedStage + line + '.');
      } else { throw new Error('Unexpected native conversion message.'); }
    }).catch(error => { failure ??= error; cancellation.abort(); child.kill('SIGKILL'); });
  });
  const ended = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Native conversion Electron process could not be started.')));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.send({ type: 'configuration', marker, password }, error => {
    if (error) { failure ??= new Error('Native conversion configuration could not be delivered.'); child.kill('SIGKILL'); }
  });
  const finish = async () => {
    const result = await ended;
    await chain;
    if (failure) { throw failure; }
    assert.equal(result.code, 0, 'Native conversion process did not exit cleanly at ' + stage + '.');
    assert.equal(completed, true, 'Native conversion process did not complete at ' + stage + '.');
    assert.deepEqual(checkpoints.map(value => value.stage), stages);
    await scan(cancellation.signal);
    assert.ok(profileFilesScanned > 0 && encryptedFilesScanned > 0, 'Native conversion must scan its profile and encrypted output.');
  };
  try { await Promise.race([finish(), deadline]); }
  finally { clearTimeout(timer); }
}

let succeeded = false;
try {
  await run();
  succeeded = true;
  process.stdout.write(JSON.stringify({ passed: true, scans, profileFilesScanned, encryptedFilesScanned, checkpoints }) + '\n');
} finally {
  for (const bytes of forbidden) { bytes.fill(0); }
  if (succeeded) { await fs.rm(fixture, { recursive: true, force: true }); }
  else { process.stderr.write('Synthetic native-conversion fixture retained under repository tmp for diagnosis.\n'); }
}
