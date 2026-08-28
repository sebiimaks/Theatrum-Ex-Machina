import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  configuredMediaFileExtensions,
  isDefaultOpenMediaExtension,
} from './main-filenames.ts';

test('configured media extensions retain media types and normalize custom values', () => {
  const configured = configuredMediaFileExtensions(['MP4', 'MOD', 'mod', 'not-valid!']);
  assert.equal(configured.includes('mp4'), true);
  assert.equal(configured.includes('mod'), true);
  assert.equal(configured.filter(value => value === 'mod').length, 1);
  assert.equal(configured.includes('not-valid!'), false);
});

test('configured media extensions never admit OS launchable custom types', () => {
  const configured = configuredMediaFileExtensions([
    'app',
    'appinstaller',
    'application',
    'appx',
    'appxbundle',
    'BAT',
    'chm',
    'cjs',
    'command',
    'cpl',
    'dmg',
    'exe',
    'gadget',
    'inetloc',
    'jar',
    'js',
    'lnk',
    'mjs',
    'msh',
    'msh1',
    'msh1xml',
    'msh2',
    'msh2xml',
    'mshxml',
    'msc',
    'msix',
    'msixbundle',
    'pif',
    'pkg',
    'ps1',
    'psc1',
    'psc2',
    'sh',
    'tool',
    'terminal',
    'url',
    'webloc',
    'xbap',
  ]);
  for (const blocked of [
    'app',
    'appinstaller',
    'application',
    'appx',
    'appxbundle',
    'bat',
    'chm',
    'cjs',
    'command',
    'cpl',
    'dmg',
    'exe',
    'gadget',
    'inetloc',
    'jar',
    'js',
    'lnk',
    'mjs',
    'msh',
    'msh1',
    'msh1xml',
    'msh2',
    'msh2xml',
    'mshxml',
    'msc',
    'msix',
    'msixbundle',
    'pif',
    'pkg',
    'ps1',
    'psc1',
    'psc2',
    'sh',
    'tool',
    'terminal',
    'url',
    'webloc',
    'xbap',
  ]) {
    assert.equal(configured.includes(blocked), false, blocked);
  }
});

test('only built-in media types can use an operating-system default association', () => {
  assert.equal(isDefaultOpenMediaExtension('.MP4'), true);
  assert.equal(isDefaultOpenMediaExtension('mkv'), true);
  assert.equal(isDefaultOpenMediaExtension('mod'), false);
  assert.equal(isDefaultOpenMediaExtension('terminal'), false);
  assert.equal(isDefaultOpenMediaExtension(undefined), false);
});
