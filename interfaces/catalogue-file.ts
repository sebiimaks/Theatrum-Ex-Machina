export const CATALOGUE_FILE_EXTENSION = '.scaena';
export const LEGACY_CATALOGUE_FILE_EXTENSIONS = ['.vha2'] as const;
export const SUPPORTED_CATALOGUE_FILE_EXTENSIONS = [
  CATALOGUE_FILE_EXTENSION,
  ...LEGACY_CATALOGUE_FILE_EXTENSIONS,
] as const;
export const CATALOGUE_PICKER_EXTENSIONS = ['scaena', 'vha2', 'json'] as const;

/**
 * A new catalogue name becomes both a filename and a generated-assets folder
 * name. Keep it to one ordinary path segment before the main process creates
 * anything on disk.
 */
export function isSafeCatalogueHubName(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 200
    && value !== '.'
    && value !== '..'
    && !value.includes('\0')
    && !value.includes('/')
    && !value.includes('\\');
}

export function catalogueFileName(hubName: string): string {
  return `${hubName}${CATALOGUE_FILE_EXTENSION}`;
}

export function catalogueFileCandidates(hubName: string): string[] {
  return SUPPORTED_CATALOGUE_FILE_EXTENSIONS.map((extension) => `${hubName}${extension}`);
}

export function hasCatalogueOrAssetNameCollision(
  hubName: string,
  directoryEntries: string[],
): boolean {
  const reservedNames = new Set([
    ...catalogueFileCandidates(hubName),
    `vha-${hubName}`,
  ].map((entry) => entry.toLowerCase()));
  return directoryEntries.some((entry) => reservedNames.has(entry.toLowerCase()));
}

export function isSupportedCatalogueFilePath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  return SUPPORTED_CATALOGUE_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension));
}

export function isLegacyCatalogueFilePath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  return LEGACY_CATALOGUE_FILE_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension));
}

export function isCataloguePickerFilePath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  return CATALOGUE_PICKER_EXTENSIONS.some((extension) => normalizedPath.endsWith(`.${extension}`));
}
