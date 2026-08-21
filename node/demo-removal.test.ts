import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';

const repositoryRoot = join(__dirname, '..');

function source(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8');
}

test('removes the legacy demo catalogue limit and its UI', () => {
  assert.equal(existsSync(join(repositoryRoot, 'demo')), false);

  const applicationSources = [
    'main.ts',
    'node/main-extract-async.ts',
    'node/main-globals.ts',
    'src/app/components/home.component.html',
    'src/app/components/home.component.ts',
    'src/app/components/settings/settings.component.html',
    'src/app/components/settings/settings.component.ts',
    'src/app/components/title-bar/title-bar.component.html',
    'src/app/components/title-bar/title-bar.component.ts',
  ].map(source).join('\n');

  for (const forbiddenMarker of [
    'DEMO LIMIT REACHED',
    'GLOBALS.demo',
    '[demo]',
    'demoVersion',
    'knownPathCount',
    'limited to 50 video files',
    'slice(0, 50)',
  ]) {
    assert.equal(
      applicationSources.includes(forbiddenMarker),
      false,
      `Removed demo marker returned: ${forbiddenMarker}`,
    );
  }

  assert.match(
    source('src/app/components/home.component.ts'),
    /imageElementService\.imageElements = finalObject\.images;/,
  );
});

test('removes the unused demo translation from every locale', () => {
  const localeDirectory = join(repositoryRoot, 'i18n');
  const localeFiles = readdirSync(localeDirectory)
    .filter((fileName: string) => fileName.endsWith('.json'));

  assert.ok(localeFiles.length > 0);
  localeFiles.forEach((fileName: string) => {
    const translation = JSON.parse(readFileSync(join(localeDirectory, fileName), 'utf8'));
    assert.equal(
      Object.prototype.hasOwnProperty.call(translation.WIZARD || {}, 'demoVersion'),
      false,
      `${fileName} still declares WIZARD.demoVersion`,
    );
  });
});
