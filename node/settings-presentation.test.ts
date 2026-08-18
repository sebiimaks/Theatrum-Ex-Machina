import { strict as assert } from 'assert';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { test } from 'node:test';
import { join } from 'path';

import {
  SettingsButtons,
  SettingsSections,
} from '../src/app/common/settings-buttons';

const repositoryRoot = join(__dirname, '..');

function source(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

test('presents every setting exactly once in explicit review-ledger sections', () => {
  const template = source('src/app/components/settings/settings.component.html');
  const styles = source('src/app/components/settings/settings.component.scss');
  const sectionKeys = SettingsSections.flatMap((tab) => (
    tab.flatMap((section) => section.buttonKeys)
  ));

  assert.equal(sectionKeys.length, Object.keys(SettingsButtons).length);
  assert.equal(new Set(sectionKeys).size, sectionKeys.length);
  assert.match(template, /class="settings-ledger__index"/);
  assert.match(template, /formatSectionIndex\(sectionIndex\)/);
  assert.match(template, /class="settings-ledger__section-content"/);
  assert.match(template, /class="settings-ledger__column-headings"/);
  assert.doesNotMatch(template, /<br\s*\/?\s*>/i);
  assert.match(styles, /grid-template-columns:\s*140px minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*grid-template-columns:\s*1fr/);
});

test('keeps setting actions, toolbar visibility, and Main Settings controls wired', () => {
  const template = source('src/app/components/settings/settings.component.html');

  assert.match(template, /\(toggleButton\)="toggleButton\.emit\(\$event\)"/);
  assert.match(template, /\(click\)="toggleHideButton\.emit\(buttonKey\)"/);
  assert.match(template, /\(click\)="chooseDefaultVideoPlayer\.emit\(\)"/);
  assert.match(template, /\[\(ngModel\)\]="appState\.videoPlayerArgs"/);
  assert.match(template, /\[\(ngModel\)\]="additionalInput"/);
  assert.match(template, /\(click\)="decreaseZoomLevel\.emit\(\)"/);
  assert.match(template, /\(click\)="resetZoomLevel\.emit\(\)"/);
  assert.match(template, /\(click\)="increaseZoomLevel\.emit\(\)"/);
  assert.match(template, /aria-label="Decrease zoom"[\s\S]*class="zoom-icon-button"/);
  assert.match(template, /class="zoom-control-symbol" aria-hidden="true">−<\/span>/);
  assert.match(template, /aria-label="Increase zoom"[\s\S]*class="zoom-icon-button"/);
  assert.match(template, /class="zoom-control-symbol" aria-hidden="true">\+<\/span>/);
  assert.equal((template.match(/'SETTINGS\.changeAppZoom'/g) || []).length, 1);
  assert.equal((template.match(/'SETTINGS\.changeLanguage'/g) || []).length, 1);
  assert.equal((template.match(/settings-ledger__detail-row--controls-only/g) || []).length, 2);
  assert.match(template, /\(change\)="changeLanguage\.emit\(langSelect\.value\)"/);
  assert.match(template, /openExternalLink\(\$event, 'https:\/\/github\.com\/sebiimaks\/Theatrum-Ex-Machina'\)/);
});

test('uses one keyboard-accessible five-tab settings shell', () => {
  const template = source('src/app/components/home.component.html');
  const component = source('src/app/components/home.component.ts');

  assert.equal((template.match(/role="tab"/g) || []).length, 5);
  assert.match(template, /role="tablist"/);
  assert.match(template, /role="tabpanel"/);
  assert.equal((template.match(/\[attr\.tabindex\]/g) || []).length, 5);
  assert.equal((template.match(/onSettingsTabKeydown\(\$event\)/g) || []).length, 5);
  assert.match(component, /event\.key === 'ArrowRight'/);
  assert.match(component, /event\.key === 'ArrowLeft'/);
  assert.match(component, /event\.key === 'Home'/);
  assert.match(component, /event\.key === 'End'/);
});

test('keeps Current Hub operations inside three responsive ledger sections', () => {
  const template = source('src/app/components/statistics/statistics.component.html');
  const component = source('src/app/components/statistics/statistics.component.ts');
  const homeTemplate = source('src/app/components/home.component.html');
  const homeComponent = source('src/app/components/home.component.ts');
  const styles = source('src/app/components/statistics/statistics.component.scss');
  const toggleStyles = source('src/app/components/statistics/toggle.scss');

  assert.equal((template.match(/<section class="ledger-section/g) || []).length, 3);
  assert.match(template, /rescanFolder\(/);
  assert.match(template, /reconnectThisFolder\(/);
  assert.match(template, /regenerateFolderThumbnails\.emit\(/);
  assert.match(template, /addAnotherFolder\(/);
  assert.match(template, /cleanScreenshotFolder\(/);
  assert.doesNotMatch(template, /STATISTICS\.server/);
  assert.doesNotMatch(template, /startServer\(/);
  assert.doesNotMatch(template, /port-select|qrcode|server-unavailable/);
  assert.match(template, /<span class="ledger-number">03<\/span>[\s\S]*<h3>Catalogue Summary<\/h3>/);
  assert.match(template, /class="folder-row-actions"/);
  assert.match(template, /class="watch-folder-control"/);
  assert.match(template, /class="folder-disclosure"/);
  assert.match(template, /\[attr\.aria-expanded\]/);
  assert.match(template, /visibleFolderRows\(item\.key\)/);
  assert.match(template, /rescanFolder\(target\)/);
  assert.match(template, /regenerateFolderThumbnails\.emit\(target\)/);
  assert.match(template, /class="scan-on-addition-control"/);
  assert.match(template, /appState\(\)\.scanFoldersOnAddition/);
  assert.match(template, /class="generate-on-addition-control"/);
  assert.match(template, /appState\(\)\.generatePreviewsOnFolderAddition/);
  assert.match(template, /class="hide-empty-subdirectories-control"/);
  assert.match(template, /appState\(\)\.hideSubdirectoriesWithNoVideos/);
  assert.match(template, /class="ignore-subdirectory-control"/);
  assert.match(template, /@if \(!isRoot\) \{[\s\S]*class="ignore-subdirectory-control"/);
  assert.doesNotMatch(template, /@if \(!isRoot && removeFoldersMode\)/);
  assert.match(template, /toggleIgnoredSubdirectory\.emit\(target\)/);
  assert.match(template, /\[attr\.aria-pressed\]="row\.ignored"/);
  assert.match(template, /icon-eye-closed/);
  assert.match(template, /icon-eye-open/);
  assert.match(component, /node\.recursiveVideoCount > 0[\s\S]*node\.containsIgnoredScope/);
  assert.match(component, /'rescan-source-folder-scope',[\s\S]*generatePreviewsOnFolderAddition/);
  assert.match(homeTemplate, /\(toggleIgnoredSubdirectory\)="toggleIgnoredSubdirectory\(\$event\)"/);
  assert.match(homeComponent, /planIgnoredSourceFolderRemoval\(/);
  assert.match(homeComponent, /plan\.metadataAffectedEntryCount === 0/);
  assert.match(homeComponent, /openConfirmationDialog\(\{[\s\S]*tone: 'destructive'/);
  assert.match(homeComponent, /'update-source-folder-ignored-subdirectories'/);
  assert.match(
    source('i18n/en.json'),
    /"generatePreviewsOnFolderAddition": "Generate thumbnails\/clips when adding folder\/rescan"/,
  );
  assert.match(
    source('i18n/en.json'),
    /"hideSubdirectoriesWithNoVideos": "Hide subdirectories with no videos"/,
  );
  assert.match(template, /class="ledger-heading-line">Catalogue</);
  assert.match(template, /class="ledger-heading-line">File</);
  assert.match(template, /class="ledger-heading-line">Video</);
  assert.match(template, /class="ledger-heading-line">Location</);
  assert.match(template, /<span>Folders<\/span>/);
  assert.match(template, /<span>files<\/span>/);
  assert.match(styles, /\.ledger-heading-line\s*\{[^}]*display:\s*block/);
  assert.match(styles, /\.ledger-chip\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*text-align:\s*center/);
  assert.match(styles, /\.input-sources-row,[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.folder-row-actions[\s\S]*grid-column:\s*2/);
  assert.match(styles, /\.folder-path-cell[\s\S]*grid-column:\s*1/);
  assert.match(styles, /\.input-sources-row-child/);
  assert.match(toggleStyles, /\.switch[\s\S]*position:\s*relative/);
  assert.doesNotMatch(toggleStyles, /\.switch\s*\{[^}]*position:\s*absolute/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.ledger-section[\s\S]*grid-template-columns:\s*1fr/);
});

test('removes the optional local server implementation and its user interface', () => {
  const packageJson = JSON.parse(source('package.json'));
  const mainProcess = source('main.ts');
  const homeComponent = source('src/app/components/home.component.ts');
  const statisticsComponent = source('src/app/components/statistics/statistics.component.ts');
  const statisticsTemplate = source('src/app/components/statistics/statistics.component.html');
  const removedRuntimePackages = ['an-qrcode', 'body-parser', 'express', 'ip', 'ws'];
  const removedSourcePaths = [
    'bin/hasRemoteCheck.sh',
    'node/server.ts',
    'remote/README.md',
  ];

  for (const packageName of removedRuntimePackages) {
    assert.equal(packageJson.dependencies?.[packageName], undefined);
  }
  for (const relativePath of removedSourcePaths) {
    assert.equal(existsSync(join(repositoryRoot, relativePath)), false);
  }

  assert.doesNotMatch(mainProcess, /setUpIpcForServer|node\/server/);
  assert.doesNotMatch(
    homeComponent,
    /start-server|stop-server|remote-open-video|remote-ip-address|remote-save-settings|remote-send-new-data/,
  );
  assert.doesNotMatch(
    statisticsComponent,
    /ServerDetails|startServerOnPort|selectedPort|serverRunning|serverInfo/,
  );
  assert.doesNotMatch(statisticsTemplate, /STATISTICS\.server|port-select|qrcode/);

  const removedTranslationKey = /"server(?:MoreInfo|OnPort|Or|Running|Start|Stop)?"\s*:/;
  for (const translationFile of readdirSync(join(repositoryRoot, 'i18n'))) {
    if (translationFile.endsWith('.json')) {
      assert.doesNotMatch(source(`i18n/${translationFile}`), removedTranslationKey);
    }
  }
});

test('keeps every shortcut and its modifier guidance in the review ledger', () => {
  const template = source('src/app/components/shortcuts/shortcuts.component.html');
  const component = source('src/app/components/shortcuts/shortcuts.component.ts');

  assert.match(template, /@for \(section of shortcutSections/);
  assert.match(template, /changeThisShortcut\(item\)/);
  assert.match(template, /SHORTCUTS\.hold/);
  assert.match(template, /SHORTCUTS\.andPress/);
  assert.match(template, /class="shortcut-key disabled">w/);
  assert.match(template, /class="shortcut-key disabled">q/);
  assert.match(component, /event\.preventDefault\(\)/);
  assert.match(component, /document\.activeElement/);
});

test('presents the wizard as a responsive settings-style ledger', () => {
  const template = source('src/app/components/wizard/wizard.component.html');
  const styles = source('src/app/components/wizard/wizard.component.scss');

  assert.equal((template.match(/<section class="wizard-ledger__section/g) || []).length, 2);
  assert.equal((template.match(/<article class="wizard-step-card/g) || []).length, 6);
  assert.match(template, /class="wizard-ledger__index"/);
  assert.match(template, /class="wizard-ledger__section-content/);
  assert.match(template, /type="button"[\s\S]*class="close-wizard"/);
  assert.doesNotMatch(template, /\sstyle="/);
  assert.doesNotMatch(template, /<br\s*\/?\s*>/i);

  assert.match(styles, /\.wizard-ledger__section\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*140px minmax\(0, 1fr\)/);
  assert.match(styles, /\.wizard-step-card\s*\{[^}]*background:\s*var\(--app-elevated-background\)[^}]*border:\s*1px solid var\(--app-border-subtle\)[^}]*border-radius:\s*var\(--app-panel-radius\)/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.wizard-ledger__section[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.wizard-options-grid[\s\S]*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(styles, /\bfloat\s*:/);
});

test('keeps every wizard action and option wired after the ledger restyle', () => {
  const template = source('src/app/components/wizard/wizard.component.html');
  const requiredBindings = [
    /hideWizard\.emit\(\)/,
    /loadFromFile\.emit\(\)/,
    /openFromHistory\.emit\(i\)/,
    /removeHistoryItem\(\$event, i\)/,
    /clearRecentlyViewedHistory\.emit\(\)/,
    /\[\(ngModel\)\]="wizard\.futureHubName"/,
    /validateHubName\(\$event\)/,
    /selectSourceDirectory\.emit\(\)/,
    /selectOutputDirectory\.emit\(\)/,
    /setScreensPerVideo\(true\)/,
    /setScreensPerVideo\(false\)/,
    /selectNumOfScreens\(/,
    /selectScreenshotSize\(/,
    /\[\(ngModel\)\]="wizard\.extractClips"/,
    /selectNumOfClipSnippets\(/,
    /selectLengthOfClipSnippets\(/,
    /selectClipSize\(/,
    /importFresh\.emit\(\)/,
  ];

  requiredBindings.forEach((binding) => assert.match(template, binding));
  assert.equal((template.match(/type="radio"/g) || []).length, 2);
  assert.match(template, /'current-step':/);
  assert.match(template, /'fulfilled':/);
});

test('keeps wizard theme assets, readable paths, and narrow-window layout', () => {
  const template = source('src/app/components/wizard/wizard.component.html');
  const styles = source('src/app/components/wizard/wizard.component.scss');

  assert.match(template, /\[class\.wizard-dark\]="darkMode\(\)"/);
  assert.match(template, /\[src\]="darkMode\(\) \? '\.\/assets\/logo-dark\.png' : '\.\/assets\/logo-light\.png'"/);
  assert.match(styles, /\.wizard\.wizard-dark\s*\{[^}]*color-scheme:\s*dark/);
  assert.match(styles, /\.path\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('keeps the 1.0.0 release identity and fork attribution aligned', () => {
  const packageJson = JSON.parse(source('package.json'));
  const packageLock = JSON.parse(source('package-lock.json'));
  const builder = JSON.parse(source('electron-builder.json'));
  const globals = source('node/main-globals.ts');
  const template = source('src/app/components/settings/settings.component.html');
  const expectedAttribution = 'Theatrum Ex Machina is a personal fork of Video Hub App. '
    + 'Fork changes are made utilising LLMs. The fork is not supported or endorsed by the original developer. '
    + 'Use at your own risk.';

  assert.equal(packageJson.version, '1.0.0');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(globals, /version:\s*'1\.0\.0'/);
  assert.ok(template.includes(`<strong>${expectedAttribution}</strong>`));
  assert.equal(builder.linux.synopsis, 'Personal fork of Video Hub App');
  assert.ok(builder.linux.description.includes(expectedAttribution));

  for (const currentDescription of [
    packageJson.description,
    builder.linux.synopsis,
    builder.linux.description,
    template,
  ]) {
    assert.doesNotMatch(currentDescription, /unsupported personal fork/i);
    assert.doesNotMatch(currentDescription, /Video Hub App 3/);
  }
});
