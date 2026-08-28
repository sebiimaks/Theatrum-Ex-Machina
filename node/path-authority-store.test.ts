import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  loadAuthorizedCataloguePaths,
  loadAuthorizedPlayerPaths,
  rememberCataloguePathAuthorization,
  rememberPlayerPathAuthorization,
  rememberSourceAccessDecision,
  rememberSourceWatchDecision,
  sourceAccessDecision,
  sourceWatchDecision,
} from './path-authority-store.ts';

test('persists only main-owned catalogue and source-folder authority', () => {
  const settingsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-authority-'));
  try {
    const cataloguePath = path.join(settingsPath, 'catalogue.scaena');
    const sourcePath = path.join(settingsPath, 'videos');
    const playerPath = path.join(settingsPath, 'player.app');
    rememberCataloguePathAuthorization(settingsPath, cataloguePath);
    rememberPlayerPathAuthorization(settingsPath, playerPath);
    rememberSourceAccessDecision(settingsPath, cataloguePath, sourcePath, true);
    rememberSourceWatchDecision(settingsPath, cataloguePath, sourcePath, true);

    assert.deepEqual(loadAuthorizedCataloguePaths(settingsPath), [cataloguePath]);
    assert.deepEqual(loadAuthorizedPlayerPaths(settingsPath), [playerPath]);
    assert.equal(sourceAccessDecision(settingsPath, cataloguePath, sourcePath), true);
    assert.equal(sourceWatchDecision(settingsPath, cataloguePath, sourcePath), true);
    assert.equal(sourceAccessDecision(settingsPath, cataloguePath, path.join(settingsPath, 'other')), undefined);

    rememberSourceAccessDecision(settingsPath, cataloguePath, sourcePath, false);
    rememberSourceWatchDecision(settingsPath, cataloguePath, sourcePath, false);
    assert.equal(sourceAccessDecision(settingsPath, cataloguePath, sourcePath), false);
    assert.equal(sourceWatchDecision(settingsPath, cataloguePath, sourcePath), false);
  } finally {
    fs.rmSync(settingsPath, { force: true, recursive: true });
  }
});

test('fails closed when the authority store is malformed', () => {
  const settingsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-authority-'));
  try {
    fs.writeFileSync(path.join(settingsPath, 'trusted-path-authority.json'), '{not json');
    assert.deepEqual(loadAuthorizedCataloguePaths(settingsPath), []);
    assert.equal(
      sourceAccessDecision(settingsPath, path.join(settingsPath, 'catalogue.scaena'), settingsPath),
      undefined,
    );
  } finally {
    fs.rmSync(settingsPath, { force: true, recursive: true });
  }
});
