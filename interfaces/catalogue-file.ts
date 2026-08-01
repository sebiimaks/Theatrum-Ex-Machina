export const CATALOGUE_FILE_EXTENSION = '.scaena';
export const LEGACY_CATALOGUE_FILE_EXTENSIONS = ['.vha2'] as const;
export const SUPPORTED_CATALOGUE_FILE_EXTENSIONS = [
  CATALOGUE_FILE_EXTENSION,
  ...LEGACY_CATALOGUE_FILE_EXTENSIONS,
] as const;
export const CATALOGUE_PICKER_EXTENSIONS = ['scaena', 'vha2', 'json'] as const;

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

export function isCataloguePickerFilePath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  return CATALOGUE_PICKER_EXTENSIONS.some((extension) => normalizedPath.endsWith(`.${extension}`));
}
