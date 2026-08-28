/** Shared names and URL construction for the app's restricted local protocol. */
export const THEATRUM_APP_PROTOCOL = 'theatrum';
export const THEATRUM_APP_HOST = 'app';
export const THEATRUM_MEDIA_ASSET_TYPES = ['thumbnails', 'filmstrips', 'clips'] as const;

export type TheatrumMediaAssetType = typeof THEATRUM_MEDIA_ASSET_TYPES[number];

export function isTheatrumMediaAssetType(value: string): value is TheatrumMediaAssetType {
  return (THEATRUM_MEDIA_ASSET_TYPES as readonly string[]).includes(value);
}

/**
 * Produce a route for a generated preview. The route contains no filesystem
 * path: the main process derives the current catalogue's asset root itself.
 */
export function createTheatrumMediaUrl(
  assetType: TheatrumMediaAssetType,
  hash: string,
  video = false,
  cacheKey?: string,
): string {
  if (
    !isTheatrumMediaAssetType(assetType)
    || !hash
    || hash.includes('\0')
    || hash.includes('/')
    || hash.includes('\\')
  ) {
    return '';
  }

  const cacheSuffix = cacheKey ? `?v=${encodeURIComponent(cacheKey)}` : '';
  const extension = video ? '.mp4' : '.jpg';
  return `${THEATRUM_APP_PROTOCOL}://${THEATRUM_APP_HOST}/media/${assetType}/${encodeURIComponent(hash)}${extension}${cacheSuffix}`;
}
