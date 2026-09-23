/** Narrow private-window contract. Never include keys or filesystem locations. */
export const PRIVATE_GALLERY_PAGE_SIZE = 48;
export const PRIVATE_GALLERY_CHANNELS = Object.freeze({
  list: 'private-gallery-list', detail: 'private-gallery-detail', save: 'private-gallery-save', lock: 'private-gallery-lock',
  regenerate: 'private-gallery-regenerate', cancelRegeneration: 'private-gallery-cancel-regeneration',
  protection: 'private-gallery-protection', setProtection: 'private-gallery-set-protection',
  changePassword: 'private-credentials-change-password',
  touchIdStatus: 'private-credentials-touch-id-status',
  enableTouchId: 'private-credentials-touch-id-enable',
  disableTouchId: 'private-credentials-touch-id-disable',
  createUnprotectedCopy: 'private-credentials-create-unprotected-copy',
  cancelUnprotectedCopy: 'private-credentials-cancel-unprotected-copy',
});
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
}
export type PrivateGalleryUnavailable = { status: 'busy' | 'unavailable' };
export type PrivateGalleryPage = PrivateGalleryUnavailable | {
  status: 'ready'; total: number; offset: number; items: PrivateGalleryItem[];
};
export type PrivateGallerySelection = PrivateGalleryUnavailable | { status: 'ready'; item: PrivateGalleryDetail };
export interface PrivateGalleryEdit {
  id: string;
  revision: string;
  notes: string;
  tags: string[];
}
export type PrivateGallerySave = PrivateGalleryUnavailable | { status: 'conflict' | 'invalid' }
  | { status: 'saved'; item: PrivateGalleryDetail };
export type PrivateGalleryRegeneration = PrivateGalleryUnavailable
  | { status: 'cancelled' | 'conflict' | 'source-unavailable' | 'wrong-folder' }
  | { status: 'generated'; item: PrivateGalleryDetail };
export type PrivateCredentialsPasswordChange = { status: 'changed' | 'incorrect-password' | 'invalid' | 'busy' | 'unavailable' };
export type PrivateCredentialsUnprotectedCopy = {
  status: 'copied' | 'incorrect-password' | 'cancelled' | 'failed' | 'invalid' | 'busy' | 'unavailable';
};
export type PrivateGalleryProtection = PrivateGalleryUnavailable | ({ status: 'ready' } & PrivateHubProtection);
export type PrivateGalleryProtectionSave = PrivateGalleryUnavailable | ({ status: 'saved' } & PrivateHubProtection);
import type { PrivateHubProtection } from './private-hub-protection';

export type PrivateCredentialsTouchIdStatus = { outcome: 'available'; state: 'enabled' | 'disabled' } | { outcome: 'unavailable' };
export type PrivateCredentialsTouchIdEnable = { outcome: 'enabled' | 'incorrect-password' | 'cancelled' | 'unavailable' };
export type PrivateCredentialsTouchIdDisable = { outcome: 'disabled' | 'unavailable' };
