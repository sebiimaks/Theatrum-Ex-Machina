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
