import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Explicit native verification, separate from the headless regression suite.
// Only a disposable, synthetic ordinary hub and profile are ever opened.
const repository = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const workspace = '/Users/sm/Workspace';
assert.ok(repository.startsWith(workspace + path.sep));
const require = createRequire(import.meta.url);
const electronPackage = path.dirname(require.resolve('electron/package.json'));
const relative = (await fs.readFile(path.join(electronPackage, 'path.txt'), 'utf8')).trim();
assert.ok(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'));
const executable = await fs.realpath(path.join(electronPackage, 'dist', relative));
assert.ok(executable.startsWith(workspace + path.sep), 'An existing Workspace Electron runtime is required.');
await fs.mkdir(path.join(repository, 'tmp'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(repository, 'tmp', 'normal-protocol-native-'));
const profile = path.join(fixture, 'profile');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
for (const name of ['ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'CHROME_LOG_FILE', 'FFREPORT']) { delete environment[name]; }
environment.VIDEO_HUB_APP_SIN_MEDIA_TOOLS = path.join(repository, 'build', 'media-tools');
environment.TMPDIR = path.join(profile, 'temporary');
environment.TEMP = environment.TMPDIR;
environment.TMP = environment.TMPDIR;
await fs.mkdir(environment.TMPDIR, { recursive: true });
const stages = ['native-responses', 'renderer-media', 'unread-drain', 'active-read-drain',
  'late-fetch-drain', 'renderer-drain', 'fresh-reopen'];
const checkpoints = [];
let succeeded = false;
try {
  const child = spawn(executable, [path.join(repository, 'node', 'normal-protocol-native.cjs'),
    '--normal-protocol-fixture=' + fixture,
    '--user-data-dir=' + path.join(profile, 'user-data'), '--disk-cache-dir=' + path.join(profile, 'disk-cache'),
    '--crash-dumps-dir=' + path.join(profile, 'crash-dumps')], {
    cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Keep native diagnostics out of reports; failures name only fixture stages.
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  let failure;
  let complete = false;
  const timeout = setTimeout(() => {
    failure = new Error('Native ordinary-protocol verification timed out.');
    child.kill('SIGKILL');
  }, 60_000);
  child.on('message', message => {
    if (message?.type === 'checkpoint' && message.stage === stages[checkpoints.length]) {
      checkpoints.push({ stage: message.stage, checks: message.checks });
    } else if (message?.type === 'complete') {
      complete = true;
    } else {
      const stage = typeof message?.stage === 'string' && /^[a-z-]{1,50}$/.test(message.stage) ? message.stage : 'unknown';
      failure = new Error('Native ordinary-protocol verification failed at ' + stage + '.');
      child.kill('SIGKILL');
    }
  });
  const ended = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (failure) { throw failure; }
  assert.equal(ended.code, 0, 'Native Electron fixture did not exit cleanly.');
  assert.equal(complete, true);
  assert.deepEqual(checkpoints.map(value => value.stage), stages);
  succeeded = true;
  process.stdout.write(JSON.stringify({ passed: true, phases: 1, checkpoints,
    boundary: 'JavaScript fetch/read/cancel settlement; no Chromium or OS cache-erasure claim' }) + '\n');
} finally {
  if (succeeded) { await fs.rm(fixture, { recursive: true, force: true }); }
  else { process.stderr.write('Synthetic native-test fixture retained under repository tmp for diagnosis.\n'); }
}
