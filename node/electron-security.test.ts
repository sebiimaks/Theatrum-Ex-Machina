import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  MAIN_TO_RENDERER_CHANNELS,
  RENDERER_TO_MAIN_CHANNELS,
  RENDERER_TO_MAIN_INVOKE_CHANNELS,
} from '../interfaces/electron-bridge.ts';

const repositoryRoot = join(__dirname, '..');
const source = (relativePath: string): string => readFileSync(join(repositoryRoot, relativePath), 'utf8');

function preloadChannels(preloadSource: string, declaration: string): string[] {
  const list = preloadSource.match(new RegExp(
    `const ${declaration} = new Set<string>\\(\\[([\\s\\S]*?)\\]\\);`,
  ));
  if (!list) {
    throw new Error(`Unable to find ${declaration} in preload.ts.`);
  }
  return Array.from(list[1].matchAll(/'([^']+)'/g), (match) => match[1]).sort();
}

test('uses a context-isolated, sandboxed renderer with a restricted app protocol', () => {
  const mainProcess = source('main.ts');

  assert.match(mainProcess, /nodeIntegration:\s*false/);
  assert.match(mainProcess, /contextIsolation:\s*true/);
  assert.match(mainProcess, /sandbox:\s*true/);
  assert.match(mainProcess, /webSecurity:\s*true/);
  assert.match(mainProcess, /allowRunningInsecureContent:\s*false/);
  assert.match(mainProcess, /preload:\s*path\.join\(__dirname, 'preload\.js'\)/);
  assert.match(mainProcess, /protocol\.registerSchemesAsPrivileged/);
  assert.match(mainProcess, /registerTheatrumProtocols/);
  assert.match(mainProcess, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(mainProcess, /will-navigate/);
  assert.match(mainProcess, /will-attach-webview/);
  assert.match(mainProcess, /setPermissionRequestHandler/);
  assert.doesNotMatch(mainProcess, /ELECTRON_DISABLE_SECURITY_WARNINGS/);
  assert.doesNotMatch(mainProcess, /nodeIntegration:\s*true/);
  assert.doesNotMatch(mainProcess, /webSecurity:\s*false/);
});

test('renderer code has no direct Electron or Node escape hatch', () => {
  const rendererSources = [
    source('src/app/providers/electron.service.ts'),
    source('src/app/components/catalogue-editor/catalogue-editor.component.ts'),
    source('src/app/components/home.component.ts'),
    source('src/app/components/views/file-path.service.ts'),
  ].join('\n');
  const sharedRendererSources = [
    source('interfaces/folder-rescan.ts'),
    source('interfaces/source-folder-path.ts'),
  ].join('\n');

  assert.doesNotMatch(rendererSources, /window\.require/);
  assert.doesNotMatch(rendererSources, /window\.process/);
  assert.doesNotMatch(source('src/typings.d.ts'), /interface Window[\s\S]*\b(?:require|process)\b/);
  assert.match(sharedRendererSources, /typeof process !== 'undefined' && process\.platform/);
  assert.match(source('src/polyfills.ts'), /Object\.freeze\(\{ platform:/);
  assert.match(source('preload.ts'), /contextBridge\.exposeInMainWorld\('theatrum'/);
  assert.match(source('interfaces/electron-bridge.ts'), /RENDERER_TO_MAIN_CHANNELS/);
  assert.match(source('src/app/components/views/file-path.service.ts'), /createTheatrumMediaUrl/);
});

test('the renderer has a restrictive CSP and no inline event handlers', () => {
  const document = source('src/index.html');
  const templates = [
    source('src/app/components/views/clip/clip.component.html'),
    source('src/app/components/wizard/wizard.component.html'),
  ].join('\n');

  assert.match(document, /Content-Security-Policy/);
  assert.match(document, /script-src 'self'/);
  assert.match(document, /object-src 'none'/);
  assert.doesNotMatch(document, /unsafe-eval/);
  assert.doesNotMatch(document, /file:/);
  assert.doesNotMatch(templates, /\son[a-z]+\s*=/i);
  assert.match(source('angular.json'), /"inlineCritical": false/);
});

test('preload allowlists stay exactly aligned with the reviewed bridge contract', () => {
  const preload = source('preload.ts');

  assert.deepEqual(
    preloadChannels(preload, 'sendChannels'),
    [...RENDERER_TO_MAIN_CHANNELS].sort(),
  );
  assert.deepEqual(
    preloadChannels(preload, 'invokeChannels'),
    [...RENDERER_TO_MAIN_INVOKE_CHANNELS].sort(),
  );
  assert.deepEqual(
    preloadChannels(preload, 'eventChannels'),
    [...MAIN_TO_RENDERER_CHANNELS].sort(),
  );
});

test('persisted media-folder access and automatic watching use separate main-owned capabilities', () => {
  const mainProcess = source('main.ts');
  const mainSupport = source('node/main-support.ts');
  const extraction = source('node/main-extract-async.ts');

  assert.match(mainProcess, /authorizePersistedSourceAccess/);
  assert.match(mainProcess, /authorizePersistedSourceWatches/);
  assert.match(
    mainProcess,
    /const sourceAccess = await authorizePersistedSourceAccess\([\s\S]*?closeAllWatchers\(\);\s*resetAllQueues\(\);\s*GLOBALS\.catalogueAccessMode = accessMode/,
  );
  assert.match(mainProcess, /sourceAccessDecision/);
  assert.match(mainProcess, /sourceWatchDecision/);
  assert.match(mainProcess, /const pathsToRecord = allow \? batch : unknownPaths\.slice\(start\)/);
  assert.match(mainProcess, /const pathsToRecord = allow \? batch : unknownWatchPaths\.slice\(start\)/);
  assert.match(mainSupport, /GLOBALS\.authorizedSourceWatchPaths\.has\(pathToDir\)/);
  assert.match(
    extraction,
    /if \(persistent && !GLOBALS\.authorizedSourceWatchPaths\.has\(authorizedSourcePath\)\)/,
  );
});

test('renderer-requested destructive media operations require native confirmation', () => {
  const ipc = source('node/main-ipc.ts');
  const packageJson = JSON.parse(source('package.json'));

  assert.match(ipc, /trustedIpcOn\('delete-video-file', async/);
  assert.match(ipc, /'Delete Permanently' : 'Move to Trash'/);
  assert.match(ipc, /The media file changed while confirmation was open/);
  assert.match(ipc, /await shell\.trashItem\(fileToDelete\)/);
  assert.doesNotMatch(ipc, /require\(['"]trash['"]\)/);
  assert.equal(packageJson.dependencies.trash, undefined);
  assert.match(ipc, /trustedIpcOn\('try-to-rename-this-file', async/);
  assert.match(ipc, /message: 'Rename this media file\?'/);
  assert.match(ipc, /reconcileSelectedSourceFolders/);
  assert.match(ipc, /GLOBALS\.authorizedSourceWatchPaths\.delete\(currentPath\)/);
});

test('native-selected executables are pinned to their canonical filesystem identity', () => {
  const mainProcess = source('main.ts');
  const ipc = source('node/main-ipc.ts');

  assert.match(mainProcess, /const cataloguePath = fs\.realpathSync\.native\(selectedCataloguePath\)/);
  assert.match(mainProcess, /const cataloguePath = fs\.realpathSync\.native\(requestedCataloguePath\)/);
  assert.match(mainProcess, /const canonicalSavedPlayer = savedPlayer \? fs\.realpathSync\.native\(savedPlayer\) : ''/);
  assert.match(ipc, /const canonicalPlayer = fs\.realpathSync\.native\(normalizedPlayer\)/);
  assert.match(ipc, /selections\.add\(canonicalDirectory\)/);
  assert.match(ipc, /rememberPlayerPathAuthorization\(GLOBALS\.settingsPath, canonicalPlayer\)/);
});

test('renderer media requests cannot mint authority through secondary workflows', () => {
  const mainProcess = source('main.ts');
  const extraction = source('node/main-extract-async.ts');
  const ipc = source('node/main-ipc.ts');
  const support = source('node/main-support.ts');
  const protocolSource = source('node/theatrum-protocol.ts');

  assert.match(
    mainProcess,
    /GLOBALS\.authorizedCatalogueMediaLocations = buildCatalogueMediaLocationAuthority\([\s\S]*?GLOBALS\.authorizedCatalogueImageHashes = catalogueMediaAuthorityHashes\(\s*GLOBALS\.authorizedCatalogueMediaLocations,?\s*\)/,
  );
  assert.match(
    ipc,
    /postChangeCatalogue\.length > maximumEntries[\s\S]*?rendererWriteMediaAuthority\(cacheCatalogue\)[\s\S]*?removeCatalogueMediaAuthorityForSourceScopes/,
  );
  assert.match(ipc, /finalArray\.length > authorizedHashes\.size \+ 10_000/);
  assert.match(ipc, /survivingHashes\.add\(hash\)/);
  assert.match(ipc, /beginCatalogueMaintenance\(\)[\s\S]*?await removeThumbnailsNotInHub\([\s\S]*?finishCatalogueMaintenance\(\)/);
  assert.match(ipc, /const playlistKeys = new Set<string>\(\)/);
  assert.match(ipc, /catalogueSessionIsCurrent\(playlistSession\)/);
  assert.match(ipc, /fs\.promises\.mkdtemp\(path\.join\(GLOBALS\.settingsPath, 'playlist-'\)\)/);
  assert.match(support, /flag: 'wx'/);
  assert.match(support, /mode: 0o600/);
  assert.match(ipc, /configuredMediaFileExtensions\(GLOBALS\.additionalExtensions\)/);
  assert.match(ipc, /isDefaultOpenMediaExtension\(path\.extname\(normalizedMediaPath\)\)/);
  assert.match(extraction, /removeThumbnailsNotInHub[\s\S]*?fs\.promises\.opendir/);
  assert.match(protocolSource, /GLOBALS\.authorizedCatalogueImageHashes\.has\(hash\)/);
  assert.match(protocolSource, /GLOBALS\.authorizedCatalogueImageHashes === authorizedHashes/);
  assert.match(protocolSource, /authorizedHashes\.has\(mediaHash\)/);
});
