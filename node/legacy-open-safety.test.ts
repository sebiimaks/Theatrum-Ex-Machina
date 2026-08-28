import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { CatalogueOpenQueue } from './catalogue-open-queue';

const mainSource = fs.readFileSync('main.ts', 'utf8');
const ipcSource = fs.readFileSync('node/main-ipc.ts', 'utf8');
const globalsSource = fs.readFileSync('node/main-globals.ts', 'utf8');
const homeSource = fs.readFileSync('src/app/components/home.component.ts', 'utf8');
const catalogueOpenServiceSource = fs.readFileSync(
  'src/app/services/catalogue-open-coordinator.service.ts',
  'utf8',
);

test('routes native catalogue choices through the renderer and validates explicit open modes', () => {
  assert.match(mainSource, /const authorizedPath = rememberCataloguePath\(chosenFile/);
  assert.match(mainSource, /event\.sender\.send\('open-catalogue-from-system', authorizedPath\)/);
  assert.match(mainSource, /requestCatalogueOpenFromSystem\(pathToVhaFile\)/);
  assert.match(
    mainSource,
    /value === 'read-only' \|\| value === 'read-write' \|\| value === 'duplicate-scaena'/,
  );
  assert.match(mainSource, /legacyCatalogue && intent === 'read-write'/);
  assert.match(mainSource, /!legacyCatalogue && intent === 'read-only'/);
});

test('queues native catalogue opens in order and requires acknowledgement between requests', () => {
  const queue = new CatalogueOpenQueue();
  queue.enqueue('/catalogues/first.vha2');
  queue.enqueue('/catalogues/second.scaena');

  assert.equal(queue.next(), '/catalogues/first.vha2');
  assert.equal(queue.next(), null);
  assert.equal(queue.waitingCount, 1);
  queue.acknowledge();
  assert.equal(queue.next(), '/catalogues/second.scaena');
  queue.requeueInFlight();
  assert.equal(queue.next(), '/catalogues/second.scaena');
});

test('routes a dropped catalogue through the Electron path resolver and existing open workflow', () => {
  const dropHandler = homeSource.slice(
    homeSource.indexOf('document.body.ondrop'),
    homeSource.indexOf('/**\n   * Tell Electron to drag a file out of the app'),
  );
  const galleryDropHandler = homeSource.slice(
    homeSource.indexOf('droppedSomethingOverVideo('),
    homeSource.indexOf('/**\n   * Low-tech debounced window resize'),
  );

  assert.match(dropHandler, /dataTransfer\?\.files\.item\(0\)/);
  assert.match(dropHandler, /electronService\.getPathForFile\(droppedFile\)/);
  assert.match(dropHandler, /isSupportedCatalogueFilePath\(fullPath\)/);
  assert.match(dropHandler, /this\.loadThisVhaFile\(fullPath\)/);
  assert.match(dropHandler, /catch \(error\)/);
  assert.doesNotMatch(dropHandler, /\bmyAPI\b/);
  assert.doesNotMatch(dropHandler, /(?:droppedFile|files(?:\.item\(0\)|\[0\]))\.path\b/);
  assert.doesNotMatch(dropHandler, /TODO: FIX - DRAG & DROP BROKEN|const fullPath = ["']TODO["']/);
  assert.match(
    galleryDropHandler,
    /if \(droppedFile\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);[\s\S]*electronService\.getPathForFile\(droppedFile\)/,
  );
});

test('dispatches startup opens after settings failure and serializes renderer ownership', () => {
  assert.match(mainSource, /rendererCanReceiveCatalogueOpenRequests = true;\s*dispatchNextCatalogueOpenRequest\(\);/);
  assert.doesNotMatch(mainSource, /requestCatalogueOpenFromSystem\(requestedCataloguePath\)/);
  assert.match(mainSource, /trustedIpcOn\('catalogue-open-request-consumed'/);
  assert.match(mainSource, /catalogueOpenOperationActive = true/);
  assert.match(mainSource, /sender\.send\('catalogue-open-request-finished'\)/);
  assert.match(catalogueOpenServiceSource, /ipcRenderer\.on\(\s*'catalogue-open-request-finished'/);
  assert.doesNotMatch(homeSource, /ipcRenderer\.on\('catalogue-open-request-finished'/);
  assert.match(
    mainSource,
    /catalogueOpenOperationActive = false;\s*GLOBALS\.catalogueTransitionActive = false;\s*activeCatalogueOpenGeneration = undefined;\s*dispatchNextCatalogueOpenRequest\(\);/,
  );
});

test('serializes catalogue transitions with a main-owned session generation', () => {
  assert.match(globalsSource, /catalogueSessionGeneration:\s*0/);
  assert.match(globalsSource, /catalogueTransitionActive:\s*false/);
  assert.match(globalsSource, /cataloguePersistenceActive:\s*false/);
  assert.match(mainSource, /activeCatalogueOpenGeneration = \+\+GLOBALS\.catalogueSessionGeneration/);
  assert.match(mainSource, /GLOBALS\.catalogueTransitionActive = true/);
  assert.match(mainSource, /GLOBALS\.catalogueTransitionActive = false/);
  assert.match(
    mainSource,
    /catalogueOpenOperationActive\s*\|\| GLOBALS\.catalogueTransitionActive\s*\|\| GLOBALS\.cataloguePersistenceActive/,
  );
  assert.match(mainSource, /Ignored concurrent renderer catalogue-open request[\s\S]*?catalogue-open-request-finished/);
  assert.match(
    mainSource,
    /function dispatchNextCatalogueOpenRequest[\s\S]*?GLOBALS\.cataloguePersistenceActive[\s\S]*?catalogueOpenQueue\.next/,
  );
  assert.match(mainSource, /GLOBALS\.requestCatalogueOpenDispatch = dispatchNextCatalogueOpenRequest/);
  assert.match(mainSource, /openThisDamnFile\(pathToVhaFile, intent, operationGeneration\)/);
  assert.match(mainSource, /finishCatalogueOpenOperation\(operationGeneration\)/);
  assert.match(mainSource, /assertCurrentCatalogueOpenOperation\(operationGeneration\);/);
  assert.match(mainSource, /writeVhaFileAndStartExtraction\(operationGeneration,\s*\{/);
});

test('upgrades and normalizes an exclusive sibling before opening it read-write', () => {
  const duplicateFunction = mainSource.slice(
    mainSource.indexOf('async function duplicateLegacyCatalogue'),
    mainSource.indexOf('function requestCatalogueOpenFromSystem'),
  );
  assert.match(mainSource, /function prepareLegacyCatalogueDuplicate[\s\S]*JSON\.parse\(JSON\.stringify\(finalObject\)\)/);
  assert.match(mainSource, /function prepareLegacyCatalogueDuplicate[\s\S]*upgradeToVersion3\(duplicateObject\)/);
  assert.match(mainSource, /function prepareLegacyCatalogueDuplicate[\s\S]*insertTemporaryFields\(initializationProbe\.images\)/);
  assert.match(duplicateFunction, /writeVhaJsonExclusively\(destination, duplicateJson\)/);
  assert.match(mainSource, /openCatalogueFile\([\s\S]*duplicateResult\.destinationPath,[\s\S]*'read-write'/);
  assert.match(mainSource, /catalogueOpenFailureSuffix\(publishedDuplicatePath/);
  assert.match(mainSource, /'legacy-catalogue-duplicated'/);
  assert.match(mainSource, /'catalogue-loaded-from-backup'/);
});

test('read-only opening never recovers catalogue or preview files and starts no scans or watchers', () => {
  assert.match(mainSource, /readResult\.source === 'backup' && accessMode === 'read-only'/);
  assert.match(
    mainSource,
    /if \(accessMode === 'read-write'\) \{\s*try \{[\s\S]*?const assetDirectory = resolveTheatrumAssetDirectory\([\s\S]*?const recovery = await recoverInterruptedPreviewTransactions/,
  );
  assert.match(mainSource, /accessMode === 'read-write',\s*\);/);
  assert.match(mainSource, /finalObjectToSave !== null && GLOBALS\.catalogueAccessMode === 'read-write'/);
});

test('read-only sessions block catalogue, source-file, scan, and preview mutations while still closing', () => {
  for (const channel of [
    'delete-video-file',
    'replace-thumbnail',
    'configure-source-folder',
    'rescan-source-folder-scope',
    'update-source-folder-ignored-subdirectories',
    'regenerate-thumbnails',
    'regenerate-folder-thumbnails',
    'clean-old-thumbnails',
    'save-current-vha-file',
    'try-to-rename-this-file',
  ]) {
    assert.match(ipcSource, new RegExp(`'${channel}'`));
  }
  assert.match(
    ipcSource,
    /finalObjectToSave === null \|\| GLOBALS\.catalogueAccessMode === 'read-only'/,
  );
  assert.match(ipcSource, /catalogue-read-only-write-blocked/);
});
