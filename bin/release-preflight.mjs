import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_BRANCH = 'main';
const EXPECTED_DIRECTORY = 'Theatrum-Ex-Machina';
const EXPECTED_ORIGIN = 'https://github.com/sebiimaks/Theatrum-Ex-Machina.git';

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`Unable to run git ${args.join(' ')}: ${detail}`);
  }
}

function optionalGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (error?.status === 1) {
      return '';
    }
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`Unable to run git ${args.join(' ')}: ${detail}`);
  }
}

function realPath(filePath) {
  return fs.realpathSync(path.resolve(filePath));
}

const failures = [];
const repositoryRoot = realPath(git(['rev-parse', '--show-toplevel']));
const currentDirectory = realPath(process.cwd());
const branch = git(['branch', '--show-current']);
const head = git(['rev-parse', 'HEAD']);
const origin = git(['remote', 'get-url', 'origin']);
const releaseWorktree = optionalGit(['config', '--worktree', '--get', 'vha.releaseWorktree']);
const status = git(['status', '--porcelain=v1', '--untracked-files=all']);

const removedDemoMarkers = new Map([
  ['node/main-extract-async.ts', ['DEMO LIMIT REACHED', 'knownPathCount']],
  ['node/main-globals.ts', ['demo: false', 'demo: boolean']],
  ['src/app/components/home.component.html', ['[demo]']],
  ['src/app/components/home.component.ts', ['GLOBALS.demo', 'slice(0, 50)']],
  ['src/app/components/settings/settings.component.html', ['limited to 50 video files']],
  ['src/app/components/settings/settings.component.ts', ['readonly demo = input']],
  ['src/app/components/title-bar/title-bar.component.html', ['limited to 50 video files']],
  ['src/app/components/title-bar/title-bar.component.ts', ['readonly demo = input']],
]);

if (currentDirectory !== repositoryRoot) {
  failures.push('Run the release command from the repository root.');
}
if (path.basename(repositoryRoot) !== EXPECTED_DIRECTORY) {
  failures.push(`Expected the canonical production directory '${EXPECTED_DIRECTORY}', found '${path.basename(repositoryRoot)}'.`);
}
if (branch !== EXPECTED_BRANCH) {
  failures.push(`Expected branch '${EXPECTED_BRANCH}', found '${branch || 'detached HEAD'}'.`);
}
if (!head) {
  failures.push('The worktree does not have an attached commit.');
}
if (origin !== EXPECTED_ORIGIN) {
  failures.push(`Expected origin '${EXPECTED_ORIGIN}', found '${origin}'.`);
}
if (releaseWorktree !== 'true') {
  failures.push('This worktree is not designated for production releases (vha.releaseWorktree=true).');
}
if (status) {
  failures.push('The production worktree is not clean. Commit or intentionally exclude every change before packaging.');
}
if (fs.existsSync(path.join(repositoryRoot, 'demo'))) {
  failures.push('The removed demo application directory has returned.');
}
for (const [relativePath, markers] of removedDemoMarkers) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`Unable to verify demo removal because '${relativePath}' is missing.`);
    continue;
  }
  const contents = fs.readFileSync(absolutePath, 'utf8');
  markers.forEach((marker) => {
    if (contents.includes(marker)) {
      failures.push(`Removed demo marker '${marker}' has returned in '${relativePath}'.`);
    }
  });
}
for (const localeFile of fs.readdirSync(path.join(repositoryRoot, 'i18n'))) {
  if (!localeFile.endsWith('.json')) {
    continue;
  }
  const translation = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'i18n', localeFile), 'utf8'),
  );
  if (Object.prototype.hasOwnProperty.call(translation.WIZARD || {}, 'demoVersion')) {
    failures.push(`Removed demo translation has returned in 'i18n/${localeFile}'.`);
  }
}

if (failures.length > 0) {
  console.error('Production release preflight failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Production release preflight passed.');
console.log(`Repository: ${repositoryRoot}`);
console.log(`Branch: ${branch}`);
console.log(`Commit: ${head}`);
console.log(`Origin: ${origin}`);
