import { mkdirSync, realpathSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error('Private hub storage currently requires macOS or Linux advisory locks.');
}
const output = join(root, 'build', 'privacy-tools');
mkdirSync(output, { recursive: true });
const target = join(output, 'private-hub-lock');
const staged = target + '.building-' + process.pid;
const compiler = spawnSync('cc', [
  '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  join(root, 'bin', 'private-hub-lock.c'), '-o', staged,
], { cwd: root, stdio: 'inherit' });
if (compiler.error || compiler.status !== 0) {
  throw new Error('Could not compile the private hub advisory-lock helper.', { cause: compiler.error });
}
renameSync(staged, target);
console.log('Built private hub advisory-lock helper: ' + target);
