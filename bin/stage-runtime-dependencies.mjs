import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRuntimePackagePaths } from './runtime-dependencies.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const packageLock = JSON.parse(
  fs.readFileSync(path.join(projectDirectory, 'package-lock.json'), 'utf8'),
);
const obsoleteStagingDirectory = path.join(projectDirectory, 'build', 'runtime-node-modules');
const stagingRoot = path.join(projectDirectory, 'build', 'runtime-dependencies');
const stagingDirectory = path.join(stagingRoot, 'node_modules');
const runtimePackagePaths = collectRuntimePackagePaths(packageLock);

fs.rmSync(obsoleteStagingDirectory, { force: true, recursive: true });
fs.rmSync(stagingRoot, { force: true, recursive: true });
fs.mkdirSync(stagingDirectory, { recursive: true });

for (const packagePath of runtimePackagePaths) {
  const sourcePath = path.join(projectDirectory, packagePath);
  if (!fs.existsSync(path.join(sourcePath, 'package.json'))) {
    throw new Error(`Runtime dependency is not installed: ${packagePath}`);
  }

  const relativePackagePath = packagePath.slice('node_modules/'.length);
  const destinationPath = path.join(stagingDirectory, relativePackagePath);
  const nestedNodeModulesPath = path.join(sourcePath, 'node_modules');
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.cpSync(sourcePath, destinationPath, {
    dereference: true,
    filter: (candidatePath) => {
      return candidatePath !== nestedNodeModulesPath
        && !candidatePath.startsWith(`${nestedNodeModulesPath}${path.sep}`);
    },
    recursive: true,
  });
}

console.log(`Staged ${runtimePackagePaths.length} runtime packages for deterministic packaging.`);
