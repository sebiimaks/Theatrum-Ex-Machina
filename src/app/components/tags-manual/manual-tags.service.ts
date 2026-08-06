import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import type { ImageElement } from '../../../../interfaces/final-object.interface';
import type { ContextMenuCoordinate } from '../../../../interfaces/shared-interfaces';
import {
  getExactTagColor,
  normalizeNewTagPath,
  normalizeTagInputPreservingExisting,
  parseStoredTagPath,
  planExactTagDefinitionRemoval,
  planTagDefinitionBranchRemoval,
  TAG_PATH_SEPARATOR,
  tagIdentityKey,
  tagPathsEqual,
} from '../../../../interfaces/tag-hierarchy';

@Injectable()
export class ManualTagsService {

  pipeToggleTrigger = false;
  tagColors: Record<string, string> = {}; // map tag name to its color
  tagsFrequencyMap: Map<string, number> = new Map(); // map tag name to its frequency
  tagsList: string[] = []; // list of all tags
  private tagDefinitions: string[] = [];

  // Color picker state - shared across all components
  showColorPickerSubject = new Subject<{ tagName: string, currentColor: string, position: ContextMenuCoordinate }>();
  hideColorPickerSubject = new Subject<void>();
  tagColorUpdatedSubject = new Subject<void>(); // Notify when tag color changes
  /** Persisted colour metadata changed and the catalogue should be marked dirty. */
  tagColorPersistenceChangedSubject = new Subject<void>();
  /** Persisted tag definitions changed and the catalogue should be marked dirty. */
  tagDefinitionsPersistenceChangedSubject = new Subject<void>();

  constructor() { }

  /**
   * Update the tagsList & tagsFrequencyMap with the tag
   * @param tag - tag to be added
   */
  addTag(tag: string): void {
    if (typeof tag !== 'string' || !tag) {
      return;
    }

    const definition = this.registerTagDefinition(tag);
    const count = this.tagsFrequencyMap.get(definition);
    if (count === undefined) {
      this.tagsFrequencyMap.set(definition, 1);
    } else {
      this.tagsFrequencyMap.set(definition, count + 1);
    }
    this.forceTagSortPipeUpdate();
  }

  removeTag(tag: string): void {
    if (typeof tag !== 'string' || !tag) {
      return;
    }

    const definition = this.findTagDefinition(tag) || tag;
    const count = this.tagsFrequencyMap.get(definition);
    if (count === undefined || count <= 0) {
      return;
    }

    if (count === 1) {
      this.tagsFrequencyMap.delete(definition);
    } else {
      this.tagsFrequencyMap.set(definition, count - 1);
    }
    this.forceTagSortPipeUpdate();
  }

  removeTagGlobally(tag: string): void {
    if (typeof tag !== 'string' || !tag) {
      return;
    }

    const definition = this.findTagDefinition(tag) || tag;
    this.tagsFrequencyMap.delete(definition);
    this.removeTagDefinitions([tag]);

    const colourKey = this.findExplicitColourKey(tag);
    if (colourKey !== undefined) {
      delete this.tagColors[colourKey];
      this.notifyPersistedColourChange();
    }
    this.forceTagSortPipeUpdate();
  }

  /**
   * Removes all the existing tags in `tagList` and `tagsFrequencyMap`
   */
  removeAllTags(): void {
    this.tagsFrequencyMap.clear();
    this.tagDefinitions = [];
    this.tagsList = [];
  }

  /** Load persisted tag definitions without marking an opened catalogue dirty. */
  loadTagDefinitions(definitions: readonly string[] | undefined): void {
    this.tagDefinitions = this.deduplicateDefinitions(definitions || []);
    this.tagsList = this.tagDefinitions.slice();
    this.forceTagSortPipeUpdate();
  }

  /** Return a defensive copy of all catalogue-level tag definitions. */
  getTagDefinitions(): string[] {
    return this.tagDefinitions.slice();
  }

  hasTagDefinition(tagPath: string): boolean {
    return Boolean(this.findTagDefinition(tagPath));
  }

  /** Create a persistent tag definition without assigning it to any video. */
  addTagDefinition(input: string): string | null {
    const normalized = normalizeNewTagPath(input);
    if (this.findTagDefinition(normalized)) {
      return null;
    }

    this.tagDefinitions.push(normalized);
    this.tagsList = this.tagDefinitions.slice();
    this.notifyPersistedDefinitionChange();
    this.forceTagSortPipeUpdate();
    return normalized;
  }

  /** Remove exact persistent definitions, leaving video assignments untouched. */
  removeTagDefinitions(paths: readonly string[], refreshTagPipes = true): number {
    const nextDefinitions = paths.reduce((definitions: string[], path: string) => (
      planExactTagDefinitionRemoval(definitions, path).nextDefinitions
    ), this.tagDefinitions.slice());
    const removedCount = this.tagDefinitions.length - nextDefinitions.length;
    if (removedCount) {
      this.replaceTagDefinitions(nextDefinitions, refreshTagPipes);
    }
    return removedCount;
  }

  /** Remove every persistent definition in a hierarchy branch. */
  removeTagDefinitionBranch(branchPath: string, refreshTagPipes = true): number {
    const plan = planTagDefinitionBranchRemoval(this.tagDefinitions, branchPath);
    const removedCount = plan.affectedDefinitionCount;
    if (!removedCount) {
      return 0;
    }
    this.replaceTagDefinitions(plan.nextDefinitions, refreshTagPipes);
    return removedCount;
  }

  /** Replace the persisted definition registry after a global hierarchy edit. */
  replaceTagDefinitions(
    definitions: readonly string[],
    refreshTagPipes = true,
  ): boolean {
    const nextDefinitions = this.deduplicateDefinitions(definitions);
    const changed = nextDefinitions.length !== this.tagDefinitions.length
      || nextDefinitions.some((definition: string, index: number) => (
        definition !== this.tagDefinitions[index]
      ));
    if (!changed) {
      return false;
    }

    this.tagDefinitions = nextDefinitions;
    this.tagsList = nextDefinitions.slice();
    this.notifyPersistedDefinitionChange();
    if (refreshTagPipes) {
      this.forceTagSortPipeUpdate();
    }
    return true;
  }

  /**
   * Get the most likely tag - returning the most common tag that starts with input string
   * @param text - input from user
   */
  getTypeahead(text: string): string {
    if (typeof text !== 'string' || !text.trim()) {
      return '';
    }

    const normalizedQuery = text
      .trim()
      .replace(/\s*>\s*/g, TAG_PATH_SEPARATOR)
      .normalize('NFC')
      .toLowerCase();
    const queryIncludesPath = text.includes('>');

    const matches = this.tagsList.filter((tag: string) => {
      if (typeof tag !== 'string' || !tag) {
        return false;
      }

      const parsed = parseStoredTagPath(tag);
      const fullPathMatches = tagIdentityKey(tag).startsWith(normalizedQuery);
      if (queryIncludesPath || fullPathMatches) {
        return fullPathMatches;
      }

      const leaf = parsed.segments[parsed.segments.length - 1] || '';
      return leaf.normalize('NFC').toLowerCase().startsWith(normalizedQuery);
    });

    matches.sort((left: string, right: string) => {
      const leftFullPathMatch = tagIdentityKey(left).startsWith(normalizedQuery);
      const rightFullPathMatch = tagIdentityKey(right).startsWith(normalizedQuery);
      if (leftFullPathMatch !== rightFullPathMatch) {
        return leftFullPathMatch ? -1 : 1;
      }

      const frequencyDifference = (this.tagsFrequencyMap.get(right) || 0)
        - (this.tagsFrequencyMap.get(left) || 0);
      if (frequencyDifference !== 0) {
        return frequencyDifference;
      }

      const identityComparison = tagIdentityKey(left).localeCompare(
        tagIdentityKey(right),
        'en',
        { numeric: true, sensitivity: 'base' },
      );
      return identityComparison || left.localeCompare(right, 'en', { numeric: true });
    });

    return matches[0] || '';
  }

  /**
   * Validate a newly entered tag and preserve the established spelling when
   * the catalogue already contains the same case-insensitive path.
   */
  normalizeTagInput(text: string): string {
    const normalized = normalizeTagInputPreservingExisting(text, this.tagsList);
    const existingMatches = this.tagsList
      .filter((tag: string) => tagPathsEqual(tag, normalized))
      .sort((left: string, right: string) => {
        const frequencyDifference = (this.tagsFrequencyMap.get(right) || 0)
          - (this.tagsFrequencyMap.get(left) || 0);
        return frequencyDifference || left.localeCompare(right, 'en', { numeric: true });
      });

    return existingMatches[0] || normalized;
  }

  /**
   * Generate the tagsList and tagsFrequencyMap the first time a hub is opened
   * @param allFiles - ImageElement array
   */
  populateManualTagsService(allFiles: ImageElement[]): void {
    allFiles.forEach((element: ImageElement): void => {
      if (element.tags) {
        element.tags.forEach((tag: string): void => {
          this.addTag(tag);
        });
      }
    });
  }

  /** Rebuild autocomplete and frequency data in one update after a global edit. */
  rebuildFromImages(allFiles: readonly ImageElement[]): void {
    const nextFrequencyMap = new Map<string, number>();
    const nextDefinitions = this.tagDefinitions.slice();

    allFiles.forEach((element: ImageElement) => {
      if (element.deleted || !Array.isArray(element.tags)) {
        return;
      }
      element.tags.forEach((tag: string) => {
        if (typeof tag !== 'string' || !tag) {
          return;
        }
        let definition = nextDefinitions.find((candidate: string) => tagPathsEqual(candidate, tag));
        if (!definition) {
          definition = tag;
          nextDefinitions.push(tag);
        }
        const count = nextFrequencyMap.get(definition);
        if (count === undefined) {
          nextFrequencyMap.set(definition, 1);
        } else {
          nextFrequencyMap.set(definition, count + 1);
        }
      });
    });

    this.tagsFrequencyMap = nextFrequencyMap;
    this.tagDefinitions = nextDefinitions;
    this.tagsList = nextDefinitions.slice();
    this.forceTagSortPipeUpdate();
  }

  forceTagSortPipeUpdate(): void {
    this.pipeToggleTrigger = !this.pipeToggleTrigger;
  }

  /**
   * Set the color for a tag
   * @param tagName - name of the tag
   * @param color - color hex code or null to remove color
   */
  setTagColor(tagName: string, color: string | null): void {
    if (typeof tagName !== 'string' || !tagName) {
      return;
    }

    const existingKey = this.findExplicitColourKey(tagName);
    const colourKey = existingKey || tagName;
    let changed = false;

    if (color === null || color === undefined) {
      if (existingKey !== undefined) {
        delete this.tagColors[existingKey];
        changed = true;
      }
    } else if (this.tagColors[colourKey] !== color) {
      this.tagColors[colourKey] = color;
      changed = true;
    }

    if (changed) {
      this.notifyPersistedColourChange();
      this.forceTagSortPipeUpdate();
    }
  }

  /**
   * Get the color for a tag
   * @param tagName - name of the tag
   * @returns color hex code or undefined if no color set
   */
  getTagColor(tagName: string): string | undefined {
    if (typeof tagName !== 'string' || !tagName) {
      return undefined;
    }

    return this.getExplicitTagColor(tagName);
  }

  /** Return only the colour assigned directly to this path, without inheritance. */
  getExplicitTagColor(tagName: string): string | undefined {
    if (typeof tagName !== 'string' || !tagName) {
      return undefined;
    }

    return getExactTagColor(this.tagColors, tagName);
  }

  /**
   * Load tag colors from saved data
   * @param tagColors - Record of tag name to color mapping
   */
  loadTagColors(tagColors: Record<string, string> | undefined): void {
    this.tagColors = tagColors ? { ...tagColors } : {};
  }

  /**
   * Get all tag colors for saving
   * @returns Record of tag name to color mapping
   */
  getTagColors(): Record<string, string> {
    return this.tagColors;
  }

  /** Replace the complete persisted colour map and notify subscribers once. */
  replaceTagColors(
    tagColors: Readonly<Record<string, string>>,
    refreshTagPipes = true,
  ): boolean {
    const currentKeys = Object.keys(this.tagColors);
    const nextKeys = Object.keys(tagColors);
    const changed = currentKeys.length !== nextKeys.length
      || currentKeys.some((key: string) => tagColors[key] !== this.tagColors[key]);

    if (!changed) {
      return false;
    }

    this.tagColors = { ...tagColors };
    this.notifyPersistedColourChange();
    if (refreshTagPipes) {
      this.forceTagSortPipeUpdate();
    }
    return true;
  }

  private findExplicitColourKey(tagName: string): string | undefined {
    if (Object.prototype.hasOwnProperty.call(this.tagColors, tagName)) {
      return tagName;
    }

    const identity = tagIdentityKey(tagName);
    return Object.keys(this.tagColors)
      .filter((key: string) => tagIdentityKey(key) === identity)
      .sort((left: string, right: string) => left.localeCompare(right, 'en', { numeric: true }))[0];
  }

  private findTagDefinition(tagName: string): string | undefined {
    return this.tagDefinitions.find((definition: string) => tagPathsEqual(definition, tagName));
  }

  private registerTagDefinition(tagName: string): string {
    const existing = this.findTagDefinition(tagName);
    if (existing) {
      return existing;
    }
    this.tagDefinitions.push(tagName);
    this.tagsList = this.tagDefinitions.slice();
    return tagName;
  }

  private deduplicateDefinitions(definitions: readonly string[]): string[] {
    const unique: string[] = [];
    definitions.forEach((definition: string) => {
      if (
        typeof definition === 'string'
        && definition
        && !unique.some((candidate: string) => tagPathsEqual(candidate, definition))
      ) {
        unique.push(definition);
      }
    });
    return unique;
  }

  private notifyPersistedDefinitionChange(): void {
    this.tagDefinitionsPersistenceChangedSubject.next();
  }

  private notifyPersistedColourChange(): void {
    this.tagColorUpdatedSubject.next();
    this.tagColorPersistenceChangedSubject.next();
  }

}
