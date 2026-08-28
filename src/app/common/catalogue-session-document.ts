import type { CatalogueAccessMode } from '../../../interfaces/catalogue-session';
import type {
  FinalObject,
  ImageElement,
  InputSources,
  ScreenshotSettings,
} from '../../../interfaces/final-object.interface';

export interface CatalogueDocumentContent {
  addTags: string[];
  hubName: string;
  images: ImageElement[];
  inputDirs: InputSources;
  numOfFolders: number;
  removeTags: string[];
  screenshotSettings: ScreenshotSettings;
  tagColors: Record<string, string>;
  tagDefinitions: string[];
}

export interface CatalogueDocumentSaveSource extends CatalogueDocumentContent {
  accessMode: CatalogueAccessMode;
  autoTagsDirty: boolean;
  imagesDirty: boolean;
}

export interface CatalogueDocumentContext {
  accessMode: CatalogueAccessMode;
  hubName: string;
  numOfFolders: number;
  screenshotSettings: ScreenshotSettings;
}

export interface CatalogueDocumentStateSources {
  autoTags: {
    getAddTags(): string[];
    getRemoveTags(): string[];
    needToSave(): boolean;
  };
  images: {
    finalArrayNeedsSaving: boolean;
    imageElements: ImageElement[];
  };
  manualTags: {
    getTagColors(): Record<string, string>;
    getTagDefinitions(): string[];
  };
  sourceFolders: {
    selectedSourceFolder: InputSources;
  };
}

/** Read one coherent persistence projection from the renderer's live stores. */
export function collectCatalogueDocumentSource(
  context: CatalogueDocumentContext,
  sources: CatalogueDocumentStateSources,
): CatalogueDocumentSaveSource {
  return {
    accessMode: context.accessMode,
    addTags: sources.autoTags.getAddTags(),
    autoTagsDirty: sources.autoTags.needToSave(),
    hubName: context.hubName,
    images: sources.images.imageElements,
    imagesDirty: sources.images.finalArrayNeedsSaving,
    inputDirs: sources.sourceFolders.selectedSourceFolder,
    numOfFolders: context.numOfFolders,
    removeTags: sources.autoTags.getRemoveTags(),
    screenshotSettings: context.screenshotSettings,
    tagColors: sources.manualTags.getTagColors(),
    tagDefinitions: sources.manualTags.getTagDefinitions(),
  };
}

/**
 * Project the live catalogue state into its persistence document. References
 * are deliberately preserved; validation and normalization are owned by the
 * trusted main-process persistence boundary.
 */
export function buildCatalogueDocument(source: CatalogueDocumentContent): FinalObject {
  return {
    addTags: source.addTags,
    hubName: source.hubName,
    images: source.images,
    inputDirs: source.inputDirs,
    numOfFolders: source.numOfFolders,
    removeTags: source.removeTags,
    screenshotSettings: source.screenshotSettings,
    tagColors: source.tagColors,
    tagDefinitions: source.tagDefinitions,
    version: 3,
  };
}

/** Return a document only when the writable catalogue has unsaved changes. */
export function catalogueDocumentForSave(
  source: CatalogueDocumentSaveSource,
): FinalObject | null {
  if (
       source.accessMode === 'read-only'
    || (!source.imagesDirty && !source.autoTagsDirty)
  ) {
    return null;
  }

  return buildCatalogueDocument(source);
}
