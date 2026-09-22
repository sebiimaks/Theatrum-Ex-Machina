import { mkdirSync, realpathSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
if (process.platform !== 'darwin') {
  console.log('Touch ID native support is only built on macOS.');
  process.exit(0);
}
const output = join(root, 'build', 'privacy-tools');
mkdirSync(output, { recursive: true });
const target = join(output, 'private-touch-id.node');
const staged = target + '.building-' + process.pid;
const compiler = spawnSync('clang++', [
  '-std=c++17', '-fobjc-arc', '-fvisibility=hidden', '-Wall', '-Wextra', '-Werror',
  // The UI-fail key is deliberately retained alongside interactionNotAllowed
  // so every noninteractive query fails closed on supported macOS versions.
  '-Wno-deprecated-declarations', '-mmacosx-version-min=11.0', '-DNAPI_VERSION=8',
  '-I', join(root, 'node_modules', 'node-api-headers', 'include'),
  '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'Foundation',
  '-framework', 'Security', '-framework', 'LocalAuthentication',
  join(root, 'bin', 'private-touch-id.mm'), '-o', staged,
], { cwd: root, stdio: 'inherit' });
if (compiler.error || compiler.status !== 0) {
  throw new Error('Could not compile native Touch ID support.');
}
renameSync(staged, target);
console.log('Built native Touch ID support: ' + target);
