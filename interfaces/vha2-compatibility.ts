import type {
  FinalObject,
  ImageElement,
  ImageLocation,
  InputSources,
  SourceFolder,
} from './final-object.interface';
import { getImageLocations } from './media-locations';

/**
 * Create the version-3 catalogue shape understood by Video Hub App.
 *
 * Theatrum Ex Machina stores a few fields that Video Hub App does not know
 * about. Exporting those fields would be misleading: in particular, a later
 * edit to the legacy path fields could be overridden by the fork's
 * authoritative `locations` array if the exported file were opened here
 * again. This projection therefore promotes one valid authoritative location
 * into the legacy mirror and removes fork-only state from a deep clone.
 */
export function projectFinalObjectForVha2Export(finalObject: FinalObject): FinalObject {
  const cloned = cloneJson(finalObject, 'The catalogue');
  if (!isRecord(cloned)) {
    throw new Error('The catalogue is invalid.');
  }

  const inputDirs = projectInputSources(cloned.inputDirs);
  if (!Array.isArray(cloned.images)) {
    throw new Error('The catalogue images are invalid.');
  }

  const configuredSources = new Set(Object.keys(inputDirs).map(Number));
  const images = cloned.images
    .filter((image: unknown, index: number) => {
      if (!isRecord(image)) {
        throw new Error(`Catalogue entry ${index + 1} is invalid.`);
      }
      return image.deleted !== true;
    })
    .map((image: unknown, index: number) => (
      projectImage(image, index, configuredSources)
    ));

  const projected: FinalObject = {
    ...cloned,
    images,
    inputDirs,
    numOfFolders: new Set(images.map((image: ImageElement) => image.partialPath)).size,
    version: 3,
  };
  delete projected.tagDefinitions;
  return projected;
}

function projectInputSources(value: unknown): InputSources {
  if (!isRecord(value)) {
    throw new Error('The catalogue source folders are invalid.');
  }

  const projected: InputSources = {};
  for (const [rawIndex, sourceValue] of Object.entries(value)) {
    if (!/^(0|[1-9]\d*)$/.test(rawIndex)) {
      throw new Error(`The catalogue source index "${rawIndex}" is invalid.`);
    }
    const sourceIndex = Number(rawIndex);
    if (!Number.isSafeInteger(sourceIndex)) {
      throw new Error(`The catalogue source index "${rawIndex}" is invalid.`);
    }
    if (!isRecord(sourceValue)) {
      throw new Error(`Catalogue source ${rawIndex} is invalid.`);
    }

    const source = sourceValue as Partial<SourceFolder>;
    if (
      typeof source.path !== 'string'
      || source.path.trim().length === 0
      || source.path.includes('\0')
    ) {
      throw new Error(`Catalogue source ${rawIndex} has an invalid path.`);
    }
    if (typeof source.watch !== 'boolean') {
      throw new Error(`Catalogue source ${rawIndex} has an invalid watch setting.`);
    }

    // Whitelisting the upstream fields also removes ignoredSubdirectories and
    // any future fork-only source-folder state by default.
    projected[sourceIndex] = {
      path: source.path,
      watch: source.watch,
    };
  }
  return projected;
}

function projectImage(
  value: unknown,
  index: number,
  configuredSources: ReadonlySet<number>,
): ImageElement {
  if (!isRecord(value)) {
    throw new Error(`Catalogue entry ${index + 1} is invalid.`);
  }
  const image = value as unknown as ImageElement;

  let locations: ImageLocation[];
  try {
    locations = getImageLocations(image);
  } catch (error) {
    throw new Error(
      `Catalogue entry ${index + 1} has invalid media locations: ${errorMessage(error)}`,
    );
  }
  if (locations.length === 0) {
    throw new Error(`Catalogue entry ${index + 1} has no exportable media location.`);
  }
  locations.forEach((location: ImageLocation) => {
    if (!configuredSources.has(location.inputSource)) {
      throw new Error(
        `Catalogue entry ${index + 1} references missing source ${location.inputSource}.`,
      );
    }
  });

  // The normal location writer promotes an available location over a missing
  // preferred one. Mirror that behaviour without mutating the live entry.
  const preferred = locations.find((location: ImageLocation) => location.missing !== true)
    ?? locations[0];
  image.fileName = preferred.fileName;
  image.inputSource = preferred.inputSource;
  image.partialPath = preferred.partialPath;

  delete image.locations;
  delete image.dateAdded;
  delete image.missing;
  delete image.metadataImportFailed;
  delete image.deleted;
  delete image.durationDisplay;
  delete image.fileSizeDisplay;
  delete image.index;
  delete image.resBucket;
  delete image.resolution;
  delete image.selected;
  delete image.uuid;
  return image;
}

function cloneJson<T>(value: T, label: string): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    throw new Error(`${label} cannot be exported safely: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
