import type { SupportedView } from '../../../interfaces/shared-interfaces';

export type WorkspaceCollection = 'all' | 'folders' | 'favourites' | 'playlist' | 'recent';

export interface WorkspaceCollectionState {
  folders: boolean;
  favourites: boolean;
  playlist: boolean;
  sort: string;
}

export function activeWorkspaceCollection(state: WorkspaceCollectionState): WorkspaceCollection {
  if (state.playlist) { return 'playlist'; }
  if (state.favourites) { return 'favourites'; }
  if (state.folders) { return 'folders'; }
  return state.sort === 'lastPlayedDesc' ? 'recent' : 'all';
}

/** Collection navigation changes scope without discarding the user's search filters. */
export function workspaceCollectionPlan(collection: WorkspaceCollection, view: SupportedView) {
  return {
    favourites: collection === 'favourites',
    folders: collection === 'folders',
    playlist: collection === 'playlist',
    view: collection === 'folders'
      && !(['showThumbnails', 'showFiles', 'showClips'] as SupportedView[]).includes(view)
      ? 'showThumbnails' as SupportedView : view,
  };
}
