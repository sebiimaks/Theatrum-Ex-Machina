import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { test } from 'node:test';
import { join } from 'path';

const repositoryRoot = join(__dirname, '..');

function source(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

test('renders confirmations with the progressive Option E hierarchy', () => {
  const service = source('src/app/components/modal/modal.service.ts');
  const template = source('src/app/components/modal/modal.component.html');
  const styles = source('src/app/components/modal/modal.component.scss');

  assert.match(service, /openConfirmationDialog\(options: ConfirmationDialogOptions\)/);
  assert.match(service, /result === true/);
  assert.match(service, /width: '620px'/);
  assert.match(service, /maxWidth: 'calc\(100vw - 32px\)'/);
  assert.match(template, /class="dialog-transition"/);
  assert.match(template, /class="dialog-summary"/);
  assert.match(template, /class="dialog-supporting-text"/);
  assert.match(template, /<details class="dialog-disclosure">/);
  assert.match(template, /data\.detailsLabel \|\| 'Show full impact'/);
  assert.match(template, /class="dialog-fact"/);
  assert.ok(
    template.indexOf('close(false)') < template.indexOf('close(true)'),
    'Cancel must remain before the confirming action in keyboard order.',
  );
  assert.match(styles, /\.dialog-content[\s\S]*overflow: auto;/);
  assert.match(styles, /\.dialog-actions[\s\S]*border-top:/);
  assert.match(styles, /\.dialog-shell-destructive/);
});

test('uses structured data for every renderer confirmation family', () => {
  const catalogueEditor = source('src/app/components/catalogue-editor/catalogue-editor.component.ts');
  const home = source('src/app/components/home.component.ts');
  const tagTray = source('src/app/components/tag-tray/tag-tray.component.ts');
  const combined = `${catalogueEditor}\n${home}\n${tagTray}`;
  const structuredCalls = combined.match(/openConfirmationDialog\(\{/g) || [];

  assert.equal(structuredCalls.length, 8);
  assert.match(catalogueEditor, /Imported records skipped/);
  assert.match(catalogueEditor, /Matches outside displayed results/);
  assert.match(catalogueEditor, /transition: \{[\s\S]*New value/);
  assert.match(home, /Eligible videos/);
  assert.match(home, /tone: dangerously \? 'destructive' : 'warning'/);
  assert.match(home, /Metadata-bearing entries removed/);
  assert.match(home, /currentPlan\.nextElements\.forEach\([\s\S]*element\.index = index/);
  assert.match(home, /ipcRenderer\.invoke\([\s\S]*update-source-folder-ignored-subdirectories/);
  assert.match(tagTray, /Duplicate assignments consolidated/);
  assert.match(tagTray, /Temporarily unavailable videos/);
  assert.match(tagTray, /transition: \{[\s\S]*from: plan\.sourcePath[\s\S]*to: plan\.destinationPath/);
});

test('keeps startup and shutdown confirmations native', () => {
  const main = source('main.ts');
  const mainIpc = source('node/main-ipc.ts');

  assert.match(main, /title: 'Recover Catalogue'/);
  assert.match(mainIpc, /title: 'Cancel Thumbnail Generation\?'/);
  assert.match(mainIpc, /dialog\.showMessageBox/);
});
