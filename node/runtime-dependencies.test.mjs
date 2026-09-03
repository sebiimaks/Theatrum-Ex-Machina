import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectPackagedNodePackagePaths,
  collectRuntimePackagePaths,
} from '../bin/runtime-dependencies.mjs';

const packageLock = {
  packages: {
    '': {
      dependencies: {
        runtime: '1.0.0',
      },
      optionalDependencies: {
        'platform-helper': '1.0.0',
      },
    },
    'node_modules/runtime': {
      name: 'runtime',
      version: '1.0.0',
      dependencies: {
        'runtime-child': '1.0.0',
      },
    },
    'node_modules/runtime-child': {
      name: 'runtime-child',
      version: '1.0.0',
    },
    'node_modules/platform-helper': {
      name: 'platform-helper',
      version: '1.0.0',
      dependencies: {
        'helper-child': '1.0.0',
        shared: '1.0.0',
      },
    },
    'node_modules/helper-child': {
      name: 'helper-child',
      version: '1.0.0',
    },
    'node_modules/shared': {
      name: 'shared',
      version: '1.0.0',
    },
  },
};

test('prunes the complete closure of an optional package that is not installed', () => {
  const independentlyInstalledPaths = new Set([
    'node_modules/runtime',
    'node_modules/runtime-child',
    'node_modules/shared',
  ]);

  assert.deepEqual(
    collectPackagedNodePackagePaths(
      packageLock,
      (packagePath) => independentlyInstalledPaths.has(packagePath),
    ),
    ['node_modules/runtime', 'node_modules/runtime-child'],
  );
  assert.deepEqual(
    collectRuntimePackagePaths(packageLock),
    ['node_modules/runtime', 'node_modules/runtime-child'],
  );
});

test('retains the complete closure of an optional package that is installed', () => {
  assert.deepEqual(
    collectPackagedNodePackagePaths(packageLock, () => true),
    [
      'node_modules/helper-child',
      'node_modules/platform-helper',
      'node_modules/runtime',
      'node_modules/runtime-child',
      'node_modules/shared',
    ],
  );
});
