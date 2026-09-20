import type { SupportedView } from '../../../interfaces/shared-interfaces';

export type WorkspaceCollection = 'all' | 'folders' | 'favourites' | 'playlist' | 'recent';

export interface WorkspaceCollectionState {
  folders: boolean;
  favourites: boolean;
  playlist: boolean;
  recent: boolean;
}

export function activeWorkspaceCollection(state: WorkspaceCollectionState): WorkspaceCollection {
  if (state.playlist) { return 'playlist'; }
  if (state.favourites) { return 'favourites'; }
  if (state.folders) { return 'folders'; }
  return state.recent ? 'recent' : 'all';
}

/** Collection navigation changes scope without discarding the user's search filters. */
export function workspaceCollectionPlan(collection: WorkspaceCollection, view: SupportedView) {
  return {
    favourites: collection === 'favourites',
    folders: collection === 'folders',
    playlist: collection === 'playlist',
    recent: collection === 'recent',
    view: collection === 'folders'
      && !(['showThumbnails', 'showFiles', 'showClips'] as SupportedView[]).includes(view)
      ? 'showThumbnails' as SupportedView : view,
  };
}

/** A play-count reset does not erase the separately recorded playback history. */
export function filterRecentlyPlayed<T extends { lastPlayed?: number }>(videos: T[], recentOnly: boolean): T[] {
  return recentOnly
    ? videos.filter((video) => Number.isFinite(video.lastPlayed) && video.lastPlayed > 0)
    : videos;
}
