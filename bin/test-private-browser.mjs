import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// This launches a hidden native Electron window. It deliberately is not part of
// the headless unit suite; run only through the explicit native-test command.
const repository = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const workspace = '/Users/sm/Workspace';
assert.ok(repository.startsWith(workspace + path.sep), 'Native fixture must remain in the authorized workspace.');
const require = createRequire(import.meta.url);
// Do not load Electron's Node entry point: it can install/download a missing
// runtime. This test requires an already-present Workspace executable.
const electronPackage = path.dirname(require.resolve('electron/package.json'));
const binaryRelative = (await fs.readFile(path.join(electronPackage, 'path.txt'), 'utf8')).trim();
assert.ok(binaryRelative && !path.isAbsolute(binaryRelative) && !binaryRelative.split(/[\\/]/).includes('..'));
const executable = await fs.realpath(path.join(electronPackage, 'dist', binaryRelative));
assert.ok(executable.startsWith(workspace + path.sep), 'Use the existing Workspace Electron installation.');
await fs.mkdir(path.join(repository, 'tmp'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(repository, 'tmp', 'private-browser-native-'));
const profile = path.join(fixture, 'profile');
const appDirectory = path.join(fixture, 'app');
await fs.mkdir(appDirectory);
await fs.mkdir(profile);
await fs.writeFile(path.join(appDirectory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Private browser fixture</title><script src="app.js" defer></script></head><body><main id="fixture">Synthetic fixture</main></body></html>');
await fs.writeFile(path.join(appDirectory, 'app.js'), 'globalThis.fixtureReady = true;');
await fs.writeFile(path.join(appDirectory, 'worker.js'), 'postMessage("synthetic worker");');
await fs.writeFile(path.join(appDirectory, 'probe.txt'), 'Synthetic public file-access probe.');

const marker = 'NATIVE_PRIVATE_CANARY_' + randomBytes(24).toString('hex');
const password = 'Native synthetic password ' + randomBytes(24).toString('hex');
const newPassword = 'Native replacement password ' + randomBytes(24).toString('hex');
const forbidden = [marker, password, newPassword].flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le')]);
const network = { connections: 0, http: 0, websocket: 0, udp: 0 };
const sockets = new Set();
const endpoint = http.createServer((_request, response) => { network.http++; response.writeHead(204); response.end(); });
endpoint.on('connection', socket => {
  network.connections++;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
endpoint.on('upgrade', (_request, socket) => { network.websocket++; socket.destroy(); });
endpoint.on('clientError', (_error, socket) => socket.destroy());
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
const datagrams = dgram.createSocket('udp4');
datagrams.on('message', () => { network.udp++; });
await new Promise(resolve => datagrams.bind(0, '127.0.0.1', resolve));
const ports = { http: endpoint.address().port, udp: datagrams.address().port };
let scans = 0;
let scannedFiles = 0;
let encryptedFilesScanned = 0;
const checkpoints = [];

// Checkpoints are the only native details printed by this harness. Reject new
// fields or free-form strings before a private value can reach its output.
const checkpointFields = {
  'password-entry': 'surface clipboard credentialPasteAllowed nonCredentialPasteDenied restrictedApplicationMenu persistent cacheBytes',
  'password-submitted': 'destroyed originalMenuRestored cacheBytes',
  'password-cancelled': 'destroyed freshPartition originalMenuRestored syntheticTouchIdChoiceAvailable touchIdUnlockFits',
  unlocked: 'preview storage gates downloads persistent cacheBytes defaultRequests',
  locked: 'destroyed locked originalMenuRestored menuHeldUntilCleanup externalStorageDrainHeldMenu cleanupFailed cacheBytes',
  reopened: 'fresh newPartition persistent cacheBytes',
  'workspace-opened': 'opened surface clipboard metadataPasteDenied restrictedApplicationMenu pageSize pagination search notes encryptedImageDecoded encryptedClipPlayed encryptedMetadataSaved tagNormalized dirtyCloseGuard discardReloaded sourcePickerCancelledThenGranted encryptedPreviewsRegenerated refreshedPreviewWidth sourceUnchanged noRegenerationAutoplay encryptedProtectionSaved protectionMinimumWindowFits cacheBytes',
  'unprotected-copy-created': 'passwordBeforePicker cancelledPickerNoOutput copyCredentialsCleared catalogueByteIdentical generatedPreviewsIdentical encryptedSourceUnchanged sourceRemainsUnlocked restrictedMenuRetained intentionalPlaintextDestination',
  'workspace-closed': 'uiLock synchronousRevocation drained freshGalleryPartition savedMetadataReopened generatedSetReopened generatedMediaMarkersStripped nativeInputRenewsDeadline syntheticDomDoesNotRenew automaticLockDrained deadlineClock passwordChangeFormCleared passwordMismatchRejected incorrectCurrentRetryable passwordChangeLocked oldPasswordRejected newPasswordReopened systemLockDrained originalMenuRestored privateMenuObservations restoredMenuObservations credentialPasteAllowed wrongPassword retryAvailable',
  'touch-id-synthetic': 'touchIdControlsSyntheticProvider wrongPasswordBeforeEnrollment credentialCleared enrollmentDisableAndReenable passwordFallbackVisible promptDrainedBeforeUnlock reopenedCatalogue temporarySecretsWiped compactEnrollmentFits credentialPasteAllowed originalMenuRestored',
  restarted: 'fresh persistent cacheBytes savedMetadataPersisted generatedSetPersisted protectionPersisted changedPasswordPersisted unrelatedMetadataPreserved defaultRequests',
};
const nestedFields = {
  surface: 'methods credentials ordinary unlock node process masked overflow',
  clipboard: 'copyPreventedInCapture cutPreventedInCapture cutKeptDraft nativeExportShortcutsDenied userClipboardUntouched',
  preview: 'width height comment noStore',
  storage: 'local session indexed cache cookie mainCookie',
  gates: 'http file websocket popup worker sharedWorker serviceWorker rtcAvailable',
  fresh: 'local session indexed cache cookie',
};
const statusWords = new Set(['undefined', 'stored', 'blocked', 'unavailable', 'advanced in main test', 'excluded from private profile scan']);
const methodWords = new Set(['cancel', 'submit', 'cancelRegeneration', 'detail', 'list', 'lock', 'protection', 'regenerate', 'save', 'setProtection',
  'cancelUnprotectedCopy', 'changePassword', 'createUnprotectedCopy', 'touchIdStatus', 'enableTouchId', 'disableTouchId', 'touchIdAvailable', 'useTouchId']);
function safeCheckpointChecks(stage, checks) {
  const validate = (object, fields) => {
    assert.ok(object && typeof object === 'object' && !Array.isArray(object));
    const allowed = new Set(fields.split(' '));
    for (const [key, value] of Object.entries(object)) {
      assert.ok(allowed.has(key), 'Unexpected native checkpoint field.');
      if (nestedFields[key]) { validate(value, nestedFields[key]); }
      else if (key === 'methods' || key === 'credentials') {
        assert.ok(Array.isArray(value) && value.length <= 12 && value.every(method => methodWords.has(method)));
      } else {
        assert.ok(typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
          || (typeof value === 'string' && statusWords.has(value)), 'Unbounded native checkpoint content.');
      }
    }
  };
  assert.ok(Object.hasOwn(checkpointFields, stage), 'Unexpected native checkpoint stage.');
  validate(checks, checkpointFields[stage]);
  return checks;
}

async function scanProfile() {
  const visit = async (directory, encrypted = false) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'A native profile fixture must not escape through a symlink.');
      if (entry.isDirectory()) { await visit(file, encrypted); continue; }
      if (!entry.isFile()) { continue; }
      let bytes;
      try { bytes = await fs.readFile(file); }
      catch (error) { if (error.code === 'ENOENT') { continue; } throw error; }
      if (encrypted) { encryptedFilesScanned++; } else { scannedFiles++; }
      assert.ok(!forbidden.some(value => bytes.includes(value)), 'Private synthetic content appeared in a persistent file.');
    }
  };
  await visit(profile);
  try { await visit(path.join(fixture, 'private-hub'), true); }
  catch (error) { if (error.code !== 'ENOENT') { throw error; } }
  scans++;
}

async function run(phase) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const name of ['ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'CHROME_LOG_FILE', 'FFREPORT']) { delete environment[name]; }
  environment.VIDEO_HUB_APP_SIN_MEDIA_TOOLS = path.join(repository, 'build', 'media-tools');
  environment.TMPDIR = path.join(profile, 'temporary');
  environment.TEMP = environment.TMPDIR;
  environment.TMP = environment.TMPDIR;
  await fs.mkdir(environment.TMPDIR, { recursive: true });
  // Paths identify only a newly created synthetic fixture, never a source hub.
  const child = spawn(executable, [path.join(repository, 'node', 'private-browser-native.cjs'),
    '--private-browser-fixture=' + fixture, '--private-browser-phase=' + phase,
    '--user-data-dir=' + path.join(profile, 'user-data'), '--disk-cache-dir=' + path.join(profile, 'disk-cache'),
    '--crash-dumps-dir=' + path.join(profile, 'crash-dumps')], {
    cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Electron diagnostics can contain resource URLs. Consume but never forward
  // them or retain unbounded output; failures below contain only stage names.
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  let completed = false;
  let lastStage = phase;
  let failure;
  let chain = Promise.resolve();
  const timeout = setTimeout(() => {
    failure = new Error('Native private-browser verification timed out at ' + lastStage + '.');
    child.kill('SIGKILL');
  }, 60_000);
  child.on('message', message => {
    chain = chain.then(async () => {
      if (message?.type === 'progress') {
        if (typeof message.stage === 'string' && /^[a-z-]{1,50}$/.test(message.stage)) { lastStage = message.stage; }
      } else if (message?.type === 'checkpoint') {
        assert.ok(['password-entry', 'password-submitted', 'password-cancelled', 'unlocked', 'locked', 'reopened', 'workspace-opened', 'unprotected-copy-created', 'workspace-closed', 'touch-id-synthetic', 'restarted'].includes(message.stage), 'Invalid native-test stage.');
        if (message.previewPatterns !== undefined) {
          assert.ok(['workspace-closed', 'unprotected-copy-created'].includes(message.stage));
          assert.ok(Array.isArray(message.previewPatterns) && message.previewPatterns.length === 4);
          for (const pattern of message.previewPatterns) {
            assert.ok(typeof pattern === 'string' && pattern.length < 1_500_000);
            const bytes = Buffer.from(pattern, 'base64');
            assert.ok(bytes.length > 32 && bytes.length <= 1024 * 1024);
            forbidden.push(bytes);
          }
        }
        await scanProfile();
        assert.deepEqual(network, { connections: 0, http: 0, websocket: 0, udp: 0 }, 'A private renderer reached a loopback network probe.');
        checkpoints.push({ stage: message.stage, checks: safeCheckpointChecks(message.stage, message.checks) });
        child.send({ type: 'continue', stage: message.stage });
      } else if (message?.type === 'complete') {
        completed = true;
      } else if (message?.type === 'failed') {
        const stage = typeof message.stage === 'string' && /^[a-z-]{1,50}$/.test(message.stage) ? message.stage : 'unknown';
        throw new Error('Native private-browser verification failed at ' + stage + '.');
      }
    }).catch(error => { failure ??= error; child.kill('SIGKILL'); });
  });
  child.send({ type: 'configuration', marker, password, newPassword, ports });
  const ended = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  await chain;
  if (failure) { throw failure; }
  assert.equal(ended.code, 0, 'Native Electron fixture did not exit cleanly.');
  assert.equal(completed, true, 'Native Electron fixture did not finish its checks.');
  await scanProfile();
}

let succeeded = false;
try {
  await run('initial');
  await run('restart');
  assert.deepEqual(checkpoints.map(item => item.stage), ['password-entry', 'password-submitted', 'password-cancelled', 'unlocked', 'locked', 'reopened', 'workspace-opened', 'unprotected-copy-created', 'workspace-closed', 'touch-id-synthetic', 'restarted']);
  assert.deepEqual(network, { connections: 0, http: 0, websocket: 0, udp: 0 });
  succeeded = true;
  process.stdout.write(JSON.stringify({ passed: true, phases: 2, scans, scannedFiles, encryptedFilesScanned, checkpoints, network }) + '\n');
} finally {
  for (const socket of sockets) { socket.destroy(); }
  await new Promise(resolve => endpoint.close(resolve));
  datagrams.close();
  if (succeeded) { await fs.rm(fixture, { recursive: true, force: true }); }
  else { process.stderr.write('Synthetic native-test fixture retained under repository tmp for diagnosis.\n'); }
}
