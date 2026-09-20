import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { test } from 'node:test';
import { join } from 'path';

import { SettingsButtons } from '../src/app/common/settings-buttons';
import {
  getSettingsWorkspaceSections,
  SettingsActionKeys,
  SettingsViewKeys,
  SettingsWorkspaceCategories,
} from '../src/app/common/settings-workspace';
import type { SettingsCategoryId } from '../src/app/common/settings-workspace';

const english = JSON.parse(readFileSync(join(__dirname, '../i18n/en.json'), 'utf8'));
const translate = (key: string): string => key.split('.').reduce((value, part) => value?.[part], english) || key;
const search = (query: string, category: SettingsCategoryId = 'appearance') => (
  getSettingsWorkspaceSections(category, query, SettingsButtons, translate)
);

test('organizes all 94 persisted settings exactly once across the settings workspace', () => {
  const keys = SettingsWorkspaceCategories.flatMap((category) => category.sections.flatMap((section) => section.buttonKeys));
  assert.equal(keys.length, 94);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), Object.keys(SettingsButtons).sort());
  assert.equal(new Set(SettingsWorkspaceCategories.map((category) => category.id)).size, 11);
  assert.deepEqual(SettingsWorkspaceCategories.filter((category) => !category.sections.length).map((category) => category.id), ['library', 'shortcuts']);
});

test('an empty search only shows the active category including its custom controls', () => {
  assert.ok(search('', 'gallery').every((section) => section.categoryId === 'gallery'));
  assert.deepEqual(search('   ', 'appearance').map((section) => section.id), ['interface', 'app-zoom', 'language']);
  assert.deepEqual(search('', 'library'), []);
  assert.deepEqual(search('', 'shortcuts'), []);
  assert.equal(search('', 'playback').find((section) => section.kind === 'player')?.categoryId, 'playback');
  assert.equal(search('', 'import').find((section) => section.kind === 'extensions')?.categoryId, 'import');
  assert.equal(search('', 'about').find((section) => section.kind === 'about')?.categoryId, 'about');
});

test('search finds localized titles, descriptions and explanatory text in every category', () => {
  const expected = {
    'BUTTONS.openAtTimestampDescription': 'Reprendre la lecture',
    'BUTTONS.openAtTimestampHint': 'Début précis',
    'BUTTONS.openAtTimestampMoreInfo': 'Commencer à la position sélectionnée',
  };
  const lookup = (key: string): string => expected[key] || translate(key);
  for (const query of ['reprendre', '  PRECIS  ', 'position selectionnee']) {
    const results = getSettingsWorkspaceSections('maintenance', query, SettingsButtons, lookup);
    assert.deepEqual(results.flatMap((section) => section.buttonKeys), ['openAtTimestamp']);
    assert.equal(results[0].categoryId, 'playback');
  }
});

test('custom player, extension, language, zoom and about controls participate in search', () => {
  const queries = [
    ['SETTINGS.preferredPlayer', 'player'],
    ['SETTINGS.additionalExtensions', 'extensions'],
    ['SETTINGS.changeLanguage', 'language'],
    ['SETTINGS.changeAppZoom', 'zoom'],
    ['WORKBENCH.settingsCredits', 'about'],
  ];
  for (const [key, kind] of queries) {
    assert.ok(search(translate(key), 'gallery').some((section) => section.kind === kind), `${kind} must be searchable`);
  }
});

test('search preserves setting values and toolbar visibility and includes hidden controls', () => {
  const buttons = structuredClone(SettingsButtons);
  buttons.openAtTimestamp.hidden = true;
  buttons.openAtTimestamp.toggled = false;
  const before = structuredClone(buttons);
  const results = getSettingsWorkspaceSections('gallery', 'open at timestamp', buttons, translate);
  assert.ok(results.some((section) => section.buttonKeys.includes('openAtTimestamp')));
  assert.deepEqual(buttons, before);
  assert.deepEqual(search('no-setting-has-this-unmatched-name'), []);
});

test('search never passes absent setting titles to the translation service', () => {
  assert.equal(SettingsButtons.sortOptionAlphabetical.title, '');
  const rejectEmptyKeys = (key: string): string => {
    assert.ok(key, 'TranslateService.instant rejects an empty key');
    return translate(key);
  };
  const sortingResults = getSettingsWorkspaceSections('appearance', 'alphabetical', SettingsButtons, rejectEmptyKeys);
  assert.ok(sortingResults.some((section) => section.buttonKeys.includes('sortOptionAlphabetical')));
  assert.deepEqual(getSettingsWorkspaceSections('appearance', 'rescan', SettingsButtons, rejectEmptyKeys), []);
});

test('imperative actions and gallery choices are represented separately from boolean switches', () => {
  for (const action of ['clearHistory', 'resetSettings', 'resetTimesPlayed', 'makeSmaller', 'makeLarger', 'playPlaylist', 'shuffleGalleryNow', 'startWizard', 'clearAllFilters']) {
    assert.ok(SettingsActionKeys.includes(action as typeof SettingsActionKeys[number]));
  }
  assert.equal(SettingsViewKeys.length, 7);
  assert.ok(SettingsViewKeys.every((key) => !SettingsActionKeys.includes(key)));
});
