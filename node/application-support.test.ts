import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';

import { APPLICATION_SUPPORT_DIRECTORY_NAME, prepareApplicationSupport } from './application-support';

const temporaryDirectories: string[] = [];
const fixtureRoot = path.resolve(__dirname, '..', 'tmp', 'application-support-tests');
const authorityName = 'trusted-path-authority.json';

function fixture(): string {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureRoot, 'case-'));
  temporaryDirectories.push(directory);
  return directory;
}

function save(directory: string, folder: string, bytes: string, modified = 100, filename = 'settings.json'): string {
  const destination = path.join(directory, folder, filename);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  fs.utimesSync(destination, modified, modified);
  return destination;
}

function settings(marker: string): string {
  return JSON.stringify({ appState: { currentVhaFile: `/synthetic/${marker}.scaena` }, buttonSettings: {} }, null, 2) + '\n';
}

function authority(allowed = true): string {
  return JSON.stringify({
    version: 1,
    cataloguePaths: ['/synthetic/catalogue.scaena'],
    playerPaths: [],
    sourceDecisions: { ['a'.repeat(64)]: allowed },
    watchDecisions: {},
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('creates the canonical folder and preserves existing settings, including malformed files', () => {
  for (const bytes of [settings('canonical'), '{malformed']) {
    const directory = fixture();
    save(directory, APPLICATION_SUPPORT_DIRECTORY_NAME, bytes);
    save(directory, 'theatrum-ex-machina', settings('newer'), 500);
    save(directory, 'theatrum-ex-machina', authority(), 500, authorityName);
    const target = prepareApplicationSupport(directory);
    assert.equal(target, path.join(directory, APPLICATION_SUPPORT_DIRECTORY_NAME));
    assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(target, authorityName)), false, 'must not resurrect deleted permissions');
  }
});

test('recovers the newest valid settings by file modification time and preserves exact bytes and legacy files', () => {
  const directory = fixture();
  const old = save(directory, 'video-hub-app-2', settings('old'), 100);
  const newest = save(directory, 'Video Hub App SIN', settings('newest'), 300);
  save(directory, 'theatrum-ex-machina', settings('middle'), 200);
  fs.utimesSync(path.dirname(old), 900, 900);
  fs.utimesSync(path.dirname(newest), 1, 1);
  const originals = [old, newest].map((filename) => ({ filename, bytes: fs.readFileSync(filename), stats: fs.statSync(filename) }));
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), settings('newest'));
  for (const original of originals) {
    assert.deepEqual(fs.readFileSync(original.filename), original.bytes);
    assert.equal(fs.statSync(original.filename).mtimeMs, original.stats.mtimeMs);
  }
  assert.deepEqual(fs.readdirSync(target), ['settings.json']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(target, 'settings.json')).mode & 0o777, 0o600);
  }
});

test('uses deterministic precedence when modification times tie', () => {
  const directory = fixture();
  save(directory, 'Video Hub App SIN', settings('other'), 100);
  save(directory, 'theatrum-ex-machina', settings('fork'), 100);
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), settings('fork'));
});

test('recognizes the explicit historical folder names without scanning arbitrary directories', () => {
  for (const name of [
    'theatrum-ex-machina', 'video-hub-app-2', 'Video-hub-app-2', 'video-hub-app-3',
    'Video Hub App 3', 'Video Hub App SIN', 'video-hub-app-sin',
  ]) {
    const directory = fixture();
    save(directory, name, settings(name));
    save(directory, 'unrelated-app', settings('unrelated'), 1000);
    const target = prepareApplicationSupport(directory);
    assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), settings(name));
  }
});

test('skips malformed, oversized and invalid-shape newer settings', () => {
  for (const invalid of [
    '{bad', 'null', '[]', '{}', '{"appState":[]}', '{"appState":null}',
    '{"appState":{},"buttonSettings":[]}', '{"appState":{},"buttonSettings":{"darkMode":{"toggled":"yes"}}}',
    '{"appState":{},"shortcuts":[]}', '{"appState":{},"shortcuts":{"a":4}}',
    '{"appState":{},"wizardOptions":[]}', '{"appState":{},"vhaFileHistory":{}}',
    JSON.stringify({ appState: {}, padding: 'a'.repeat(8 * 1024 * 1024) }),
  ]) {
    const directory = fixture();
    save(directory, 'video-hub-app-2', settings('valid'), 100);
    save(directory, 'Video Hub App SIN', invalid, 200);
    const target = prepareApplicationSupport(directory);
    assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), settings('valid'));
  }
});

test('skips legacy symlink files and directories', () => {
  const directory = fixture();
  save(directory, 'video-hub-app-2', settings('valid'));
  const outside = save(directory, 'unrelated-app', settings('symlink'), 1000);
  fs.mkdirSync(path.join(directory, 'Video Hub App SIN'));
  fs.symlinkSync(outside, path.join(directory, 'Video Hub App SIN', 'settings.json'));
  fs.symlinkSync(path.dirname(outside), path.join(directory, 'video-hub-app-3'), 'dir');
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), settings('valid'));
});

test('does not follow or replace a canonical settings symlink', () => {
  const directory = fixture();
  const existing = save(directory, 'unrelated-app', settings('existing'));
  fs.mkdirSync(path.join(directory, APPLICATION_SUPPORT_DIRECTORY_NAME));
  fs.symlinkSync(existing, path.join(directory, APPLICATION_SUPPORT_DIRECTORY_NAME, 'settings.json'));
  save(directory, 'theatrum-ex-machina', settings('legacy'), 300);
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.lstatSync(path.join(target, 'settings.json')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(existing, 'utf8'), settings('existing'));
});

test('portable mode neither reads legacy settings nor creates the canonical folder', () => {
  const directory = fixture();
  save(directory, 'theatrum-ex-machina', settings('legacy'));
  const portable = path.join(directory, 'portable');
  assert.equal(prepareApplicationSupport(directory, portable), portable);
  assert.equal(fs.existsSync(portable), false);
  assert.equal(fs.existsSync(path.join(directory, APPLICATION_SUPPORT_DIRECTORY_NAME)), false);
});

test('skips a source file that changes during its bounded read', (context) => {
  const directory = fixture();
  const changing = save(directory, 'theatrum-ex-machina', settings('changing'), 300);
  save(directory, 'video-hub-app-2', settings('stable'), 100);
  const originalRead = fs.readSync;
  let changed = false;
  context.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const count = originalRead(...args);
    if (!changed) {
      changed = true;
      fs.appendFileSync(changing, ' ');
    }
    return count;
  });
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), settings('stable'));
});

test('publication does not overwrite another instance or migrate authority after losing the settings race', (context) => {
  const directory = fixture();
  save(directory, 'theatrum-ex-machina', settings('legacy'));
  save(directory, 'theatrum-ex-machina', authority(), 100, authorityName);
  const originalLink = fs.linkSync;
  context.mock.method(fs, 'linkSync', (source: fs.PathLike, destination: fs.PathLike) => {
    fs.writeFileSync(destination, settings('other-instance'), { flag: 'wx' });
    originalLink(source, destination);
  });
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), settings('other-instance'));
  assert.deepEqual(fs.readdirSync(target), ['settings.json']);
});

test('initial settings recovery can preserve only this fork\'s valid existing authority', () => {
  const directory = fixture();
  save(directory, 'Video Hub App SIN', settings('preferences'));
  save(directory, 'theatrum-ex-machina', authority(false), 100, authorityName);
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.readFileSync(path.join(target, authorityName), 'utf8'), authority(false));
  fs.unlinkSync(path.join(target, authorityName));
  prepareApplicationSupport(directory);
  assert.equal(fs.existsSync(path.join(target, authorityName)), false, 'subsequent launches must not restore removed grants');
});

test('existing canonical authority, including denied decisions, always wins', () => {
  const directory = fixture();
  save(directory, APPLICATION_SUPPORT_DIRECTORY_NAME, authority(false), 100, authorityName);
  save(directory, 'theatrum-ex-machina', settings('preferences'));
  save(directory, 'theatrum-ex-machina', authority(true), 200, authorityName);
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.readFileSync(path.join(target, authorityName), 'utf8'), authority(false));
});

test('does not migrate authority from upstream or SIN profiles or derive it from preferences', () => {
  const directory = fixture();
  save(directory, 'Video Hub App SIN', settings('preferences'));
  save(directory, 'Video Hub App SIN', authority(), 200, authorityName);
  save(directory, 'video-hub-app-2', authority(), 200, authorityName);
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.existsSync(path.join(target, authorityName)), false);
});

test('skips malformed, oversized, unsupported and symlinked fork authority', () => {
  const valid = JSON.parse(authority());
  for (const invalid of [
    '{bad', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, cataloguePaths: 'all' }),
    JSON.stringify({ ...valid, playerPaths: ['relative-player'] }),
    JSON.stringify({ ...valid, sourceDecisions: { ['a'.repeat(64)]: 'yes' } }),
    JSON.stringify({ ...valid, watchDecisions: { invalid: true } }),
    JSON.stringify({ ...valid, padding: 'a'.repeat(1024 * 1024) }),
  ]) {
    const directory = fixture();
    save(directory, 'theatrum-ex-machina', settings('preferences'));
    save(directory, 'theatrum-ex-machina', invalid, 100, authorityName);
    const target = prepareApplicationSupport(directory);
    assert.equal(fs.existsSync(path.join(target, authorityName)), false);
  }
  const directory = fixture();
  save(directory, 'theatrum-ex-machina', settings('preferences'));
  const otherAuthority = save(directory, 'unrelated-app', authority(), 100, authorityName);
  fs.symlinkSync(otherAuthority, path.join(directory, 'theatrum-ex-machina', authorityName));
  const target = prepareApplicationSupport(directory);
  assert.equal(fs.existsSync(path.join(target, authorityName)), false);
});
