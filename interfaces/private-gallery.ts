/** Narrow private-window contract. Never include keys or filesystem locations. */
export const PRIVATE_GALLERY_PAGE_SIZE = 48;
export const PRIVATE_GALLERY_SOURCE_LIMIT = 256;
export const PRIVATE_GALLERY_IMPORT_LIMIT = 100;
export const PRIVATE_GALLERY_CHANNELS = Object.freeze({
  list: 'private-gallery-list', detail: 'private-gallery-detail', save: 'private-gallery-save', lock: 'private-gallery-lock',
  sources: 'private-gallery-sources', addSource: 'private-gallery-add-source', connectSource: 'private-gallery-connect-source',
  relocateSource: 'private-gallery-relocate-source',
  scanSource: 'private-gallery-scan-source', checkSource: 'private-gallery-check-source',
  importVideo: 'private-gallery-import-video', importProgress: 'private-gallery-import-progress', cancelImport: 'private-gallery-cancel-import',
  disconnectSource: 'private-gallery-disconnect-source', cancelSourceConnection: 'private-gallery-cancel-source-connection',
  playOriginal: 'private-gallery-play-original', stopOriginal: 'private-gallery-stop-original',
  ackOriginalPlayback: 'private-gallery-ack-original-playback',
  resetPlaybackHistory: 'private-gallery-reset-playback-history',
  regenerate: 'private-gallery-regenerate', refreshVideo: 'private-gallery-refresh-video', setCustomThumbnail: 'private-gallery-set-custom-thumbnail', cancelRegeneration: 'private-gallery-cancel-regeneration',
  protection: 'private-gallery-protection', setProtection: 'private-gallery-set-protection',
  changePassword: 'private-credentials-change-password',
  resumePasswordChange: 'private-credentials-resume-password-change',
  touchIdStatus: 'private-credentials-touch-id-status',
  enableTouchId: 'private-credentials-touch-id-enable',
  disableTouchId: 'private-credentials-touch-id-disable',
  createUnprotectedCopy: 'private-credentials-create-unprotected-copy',
  cancelUnprotectedCopy: 'private-credentials-cancel-unprotected-copy',
});
export type PrivateGalleryCollection = 'all' | 'favourites' | 'recent';
export type PrivateGallerySort = 'catalogue' | 'name' | 'date-added' | 'last-played' | 'rating' | 'duration' | 'file-size';
export type PrivateGallerySortDirection = 'asc' | 'desc';
export interface PrivateGalleryQuery {
  query: string;
  offset: number;
  collection?: PrivateGalleryCollection;
  sort?: PrivateGallerySort;
  direction?: PrivateGallerySortDirection;
}
export interface PrivateGalleryItem {
  id: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  rating: number;
  favourite: boolean;
  tags: string[];
  thumbnailUrl: string;
}
export interface PrivateGalleryDetail extends PrivateGalleryItem {
  notes: string;
  clipUrl: string;
  posterUrl: string;
  filmstripUrl: string;
  truncated: boolean;
  editable: boolean;
  revision: string;
  regenerable: boolean;
  refreshable: boolean;
  thumbnailEditable: boolean;
  playable: boolean;
}
export type PrivateGalleryUnavailable = { status: 'busy' | 'unavailable' };
export interface PrivateGallerySource {
  id: string;
  title: string;
  videoCount: number;
  connected: boolean;
}
export type PrivateGallerySources = PrivateGalleryUnavailable | { status: 'ready'; items: PrivateGallerySource[] };
export type PrivateGallerySourceAddition = PrivateGalleryUnavailable
  | { status: 'added' | 'cancelled' | 'conflict' | 'invalid' | 'duplicate' | 'limit' | 'source-unavailable' };
export type PrivateGallerySourceConnection = PrivateGalleryUnavailable
  | { status: 'cancelled' | 'conflict' | 'wrong-folder' | 'source-unavailable' }
  | { status: 'connected'; item: PrivateGallerySource };
export type PrivateGallerySourceDisconnection = PrivateGalleryUnavailable | { status: 'conflict' }
  | { status: 'disconnected'; item: PrivateGallerySource };
export type PrivateGallerySourceRelocation = PrivateGalleryUnavailable
  | { status: 'relocated' | 'cancelled' | 'conflict' | 'invalid' | 'source-unavailable' };
/** Counts of saved file locations, not unique catalogue videos. */
export interface PrivateGallerySourceCheckCounts {
  total: number;
  sameSize: number;
  differentSize: number;
  missing: number;
  unverified: number;
  ignored: number;
}
export type PrivateGallerySourceCheck = PrivateGalleryUnavailable
  | { status: 'cancelled' | 'conflict' | 'invalid' | 'limit' | 'wrong-folder' | 'source-unavailable' }
  | ({ status: 'checked' } & PrivateGallerySourceCheckCounts);
export interface PrivateGalleryImportCounts {
  total: number;
  processed: number;
  imported: number;
  duplicates: number;
  failed: number;
}
export type PrivateGalleryImportProgress = { status: 'idle' | 'unavailable' }
  | ({ status: 'running' } & PrivateGalleryImportCounts);
export type PrivateGalleryImportResponse = PrivateGalleryUnavailable
  | { status: 'cancelled' | 'conflict' | 'invalid' | 'duplicate' | 'limit' | 'nothing-new' | 'scan-limit' | 'source-unavailable' | 'wrong-folder' }
  | ({ status: 'finished'; outcome: 'completed' | 'cancelled' | 'stopped' } & PrivateGalleryImportCounts);
export type PrivateGalleryPage = PrivateGalleryUnavailable | {
  status: 'ready'; total: number; offset: number; items: PrivateGalleryItem[];
};
export type PrivateGallerySelection = PrivateGalleryUnavailable | { status: 'ready'; item: PrivateGalleryDetail };
export interface PrivateGalleryEdit {
  id: string;
  revision: string;
  notes: string;
  tags: string[];
  /** Explicit user intent only; omission preserves the stored legacy stars. */
  rating?: number;
}
export type PrivateGallerySave = PrivateGalleryUnavailable | { status: 'conflict' | 'invalid' }
  | { status: 'saved'; item: PrivateGalleryDetail };
export type PrivateGalleryOriginalPlayback = PrivateGalleryUnavailable
  | { status: 'cancelled' | 'conflict' | 'source-unavailable' | 'wrong-folder' | 'unsupported' }
  | { status: 'ready'; url: string };
export type PrivateGalleryPlaybackAcknowledgement = PrivateGalleryUnavailable
  | { status: 'recorded' | 'disabled' | 'ignored' | 'conflict' | 'invalid' };
export type PrivateGalleryPlaybackHistoryMetric = 'lastPlayed' | 'timesPlayed';
export type PrivateGalleryPlaybackHistoryReset = PrivateGalleryUnavailable
  | { status: 'unchanged' | 'cancelled' | 'invalid' }
  | { status: 'reset'; count: number };
export type PrivateGalleryRegeneration = PrivateGalleryUnavailable
  | { status: 'cancelled' | 'conflict' | 'source-unavailable' | 'wrong-folder' }
  | { status: 'generated'; item: PrivateGalleryDetail };
export type PrivateGalleryRefresh = PrivateGalleryUnavailable
  | { status: 'cancelled' | 'conflict' | 'invalid' | 'source-unavailable' | 'wrong-folder' }
  | { status: 'refreshed'; item: PrivateGalleryDetail };
export type PrivateGalleryCustomThumbnail = PrivateGalleryUnavailable
  | { status: 'cancelled' | 'conflict' | 'invalid' | 'source-unavailable' }
  | { status: 'updated'; item: PrivateGalleryDetail };
export type PrivateCredentialsPasswordChange = { status: 'changed' | 'incorrect-password' | 'invalid' | 'busy' | 'unavailable' };
export type PrivateCredentialsPasswordRecovery = { status: 'changed' | 'incorrect-password' | 'not-found' | 'cancelled' | 'invalid' | 'busy' | 'unavailable' };
export type PrivateCredentialsUnprotectedCopy = {
  status: 'copied' | 'incorrect-password' | 'cancelled' | 'failed' | 'invalid' | 'busy' | 'unavailable';
};
export type PrivateGalleryProtection = PrivateGalleryUnavailable | ({ status: 'ready' } & PrivateHubProtection);
export type PrivateGalleryProtectionSave = PrivateGalleryUnavailable | ({ status: 'saved' } & PrivateHubProtection);
import type { PrivateHubProtection } from './private-hub-protection';

export type PrivateCredentialsTouchIdStatus = { outcome: 'available'; state: 'enabled' | 'disabled' } | { outcome: 'unavailable' };
export type PrivateCredentialsTouchIdEnable = { outcome: 'enabled' | 'incorrect-password' | 'cancelled' | 'unavailable' };
export type PrivateCredentialsTouchIdDisable = { outcome: 'disabled' | 'unavailable' };
