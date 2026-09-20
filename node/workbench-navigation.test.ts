import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';
import type { WorkspaceCollection } from '../src/app/common/workbench-navigation';
import { activeWorkspaceCollection, filterRecentlyPlayed, workspaceCollectionPlan } from '../src/app/common/workbench-navigation';

test('collection selection is derived from existing filter state', () => {
  assert.equal(activeWorkspaceCollection({ folders: false, favourites: true, playlist: false, recent: false }), 'favourites');
  assert.equal(activeWorkspaceCollection({ folders: true, favourites: false, playlist: false, recent: false }), 'folders');
  assert.equal(activeWorkspaceCollection({ folders: false, favourites: false, playlist: false, recent: true }), 'recent');
});

test('changing a collection never requests a search reset', () => {
  assert.deepEqual(workspaceCollectionPlan('playlist', 'showFilmstrip'), {
    favourites: false, folders: false, playlist: true, recent: false, view: 'showFilmstrip',
  });
  assert.deepEqual(workspaceCollectionPlan('all', 'showFiles'), {
    favourites: false, folders: false, playlist: false, recent: false, view: 'showFiles',
  });
});

test('recent collection identity is independent of the chosen sorting order', () => {
  for (const sort of ['default', 'lastPlayedDesc', 'alphabetAsc', 'random']) {
    const state = { folders: false, favourites: false, playlist: false, recent: true, sort };
    assert.equal(activeWorkspaceCollection(state), 'recent');
    assert.equal(activeWorkspaceCollection({ ...state, recent: false }), 'all');
  }
});

test('switching collections clears recent scope while preserving search and independent sort state', () => {
  const initialState = {
    ...workspaceCollectionPlan('recent', 'showFilmstrip'),
    query: 'Harbour',
    tags: ['Places > Coast'],
    sort: 'alphabetAsc',
  };
  assert.equal(initialState.recent, true);

  for (const collection of ['all', 'folders', 'favourites', 'playlist'] as WorkspaceCollection[]) {
    const next = { ...initialState, ...workspaceCollectionPlan(collection, initialState.view) };
    assert.equal(next.recent, false);
    assert.equal(activeWorkspaceCollection(next), collection);
    assert.equal(next.query, initialState.query);
    assert.equal(next.tags, initialState.tags);
    assert.equal(next.sort, initialState.sort);
  }
});

test('recent collection includes only recorded playback and rejects absent or invalid dates', () => {
  const videos = [
    { id: 'unplayed', lastPlayed: 0 },
    { id: 'played', lastPlayed: 1_700_000_000_000 },
    { id: 'legacy-missing' },
    { id: 'negative', lastPlayed: -1 },
    { id: 'infinite', lastPlayed: Infinity },
    { id: 'nan', lastPlayed: NaN },
  ];
  assert.deepEqual(filterRecentlyPlayed(videos, true).map((video) => video.id), ['played']);
  assert.equal(filterRecentlyPlayed(videos, false), videos);
  assert.deepEqual(filterRecentlyPlayed([], true), []);
});

test('play-count reset preserves playback history and recent selection', () => {
  const videos = [{ id: 'played', lastPlayed: 1_700_000_000_000, timesPlayed: 4 }];
  videos[0].timesPlayed = 0;
  assert.deepEqual(filterRecentlyPlayed(videos, true), videos);
});

test('recent filtering composes with search and preserves the supplied order without mutating the catalogue', () => {
  const videos = [
    { name: 'Harbour night', lastPlayed: 300 },
    { name: 'Forest', lastPlayed: 400 },
    { name: 'Harbour dawn', lastPlayed: 100 },
    { name: 'Harbour unseen', lastPlayed: 0 },
  ];
  const alphabetical = videos.slice().sort((a, b) => a.name.localeCompare(b.name));
  const selected = filterRecentlyPlayed(alphabetical, true).filter((video) => video.name.includes('Harbour'));
  assert.deepEqual(selected.map((video) => video.name), ['Harbour dawn', 'Harbour night']);
  assert.equal(videos.length, 4);
  assert.equal(videos[0].name, 'Harbour night');
  assert.equal(selected[0], videos[2]);
});

test('playback changes refresh the recent pipeline before search, counting and sorting', () => {
  const home = readFileSync(join(__dirname, '../src/app/components/home.component.ts'), 'utf8');
  const template = readFileSync(join(__dirname, '../src/app/components/home.component.html'), 'utf8');
  const recentPosition = template.indexOf('| recentlyPlayedOnlyPipe : showRecentlyPlayedOnly : playbackRevision');
  assert.ok(recentPosition > 0);
  assert.ok(recentPosition < template.indexOf('| magicSearchPipe'));
  assert.ok(recentPosition < template.indexOf('| countPipe'));
  assert.ok(recentPosition < template.indexOf('| sortingPipe'));
  assert.match(home, /updateNumberOfTimesPlayed\(item\.index\);\s*this\.playbackRevision\+\+;/);

  const videos = [{ lastPlayed: 0 }];
  assert.equal(filterRecentlyPlayed(videos, true).length, 0);
  videos[0].lastPlayed = 1_700_000_000_000;
  assert.deepEqual(filterRecentlyPlayed(videos, true), videos);
});

test('folder navigation chooses a supported view and preserves supported current views', () => {
  assert.equal(workspaceCollectionPlan('folders', 'showFullView').view, 'showThumbnails');
  assert.equal(workspaceCollectionPlan('folders', 'showDetails').view, 'showThumbnails');
  assert.equal(workspaceCollectionPlan('folders', 'showFiles').view, 'showFiles');
  assert.equal(workspaceCollectionPlan('folders', 'showClips').view, 'showClips');
});
