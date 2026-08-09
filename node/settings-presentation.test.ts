import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
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

test('keeps Current Hub operations inside four responsive ledger sections', () => {
  const template = source('src/app/components/statistics/statistics.component.html');
  const component = source('src/app/components/statistics/statistics.component.ts');
  const homeTemplate = source('src/app/components/home.component.html');
  const homeComponent = source('src/app/components/home.component.ts');
  const styles = source('src/app/components/statistics/statistics.component.scss');
  const toggleStyles = source('src/app/components/statistics/toggle.scss');

  assert.equal((template.match(/<section class="ledger-section/g) || []).length, 4);
  assert.match(template, /rescanFolder\(/);
  assert.match(template, /reconnectThisFolder\(/);
  assert.match(template, /regenerateFolderThumbnails\.emit\(/);
  assert.match(template, /addAnotherFolder\(/);
  assert.match(template, /cleanScreenshotFolder\(/);
  assert.match(template, /startServer\(/);
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
