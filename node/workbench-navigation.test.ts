import { strict as assert } from 'assert';
import { test } from 'node:test';
import { activeWorkspaceCollection, workspaceCollectionPlan } from '../src/app/common/workbench-navigation';

test('collection selection is derived from existing filter state', () => {
  assert.equal(activeWorkspaceCollection({ folders: false, favourites: true, playlist: false, sort: 'default' }), 'favourites');
  assert.equal(activeWorkspaceCollection({ folders: true, favourites: false, playlist: false, sort: 'default' }), 'folders');
  assert.equal(activeWorkspaceCollection({ folders: false, favourites: false, playlist: false, sort: 'lastPlayedDesc' }), 'recent');
});

test('changing a collection never requests a search reset', () => {
  assert.deepEqual(workspaceCollectionPlan('playlist', 'showFilmstrip'), {
    favourites: false, folders: false, playlist: true, view: 'showFilmstrip',
  });
  assert.deepEqual(workspaceCollectionPlan('all', 'showFiles'), {
    favourites: false, folders: false, playlist: false, view: 'showFiles',
  });
});

test('folder navigation chooses a supported view and preserves supported current views', () => {
  assert.equal(workspaceCollectionPlan('folders', 'showFullView').view, 'showThumbnails');
  assert.equal(workspaceCollectionPlan('folders', 'showDetails').view, 'showThumbnails');
  assert.equal(workspaceCollectionPlan('folders', 'showFiles').view, 'showFiles');
  assert.equal(workspaceCollectionPlan('folders', 'showClips').view, 'showClips');
});
