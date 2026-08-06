/** Canonical delimiter used when a manual tag represents a hierarchy path. */
export const TAG_PATH_SEPARATOR = ' > ';

/** Limits match the portable metadata format while keeping the tray navigable. */
export const TAG_PATH_MAX_DEPTH = 16;
export const TAG_PATH_MAX_LENGTH = 500;
export const TAG_PATH_MAX_SEGMENT_LENGTH = 120;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character: string) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

export interface TagHierarchySource {
  tags?: readonly string[];
}

export interface SelectedTagTarget {
  selected?: boolean;
  tags?: string[];
}

export interface ParsedStoredTagPath {
  /** The original stored value. It is never rewritten by the parser. */
  fullPath: string;
  /** True only when the stored value already uses the exact canonical format. */
  hierarchical: boolean;
  /** Canonical hierarchy segments, or the complete legacy value as one safe segment. */
  segments: string[];
}

export interface TagHierarchyNode {
  /** Canonical display path assembled from the first-seen casing of each segment. */
  fullPath: string;
  /** Leaf segment shown on this row in the hierarchy tray. */
  label: string;
  /** Whether at least one video has a tag ending exactly at this node. */
  explicit: boolean;
  /** Unique number of videos tagged exactly at this node. */
  directFrequency: number;
  /** Unique number of videos tagged at this node or anywhere below it. */
  branchFrequency: number;
  /** Exact stored spellings represented by this explicit node, including case variants. */
  explicitTagValues: string[];
  children: TagHierarchyNode[];
}

export type TagHierarchySortMode = 'alphabetical' | 'frequency';

export interface TagPathValidationResult {
  error?: string;
  normalized?: string;
  valid: boolean;
}

export interface TagBranchRemovalEntryPlan {
  index: number;
  remainingTags: string[];
  removedTags: string[];
}

export interface TagBranchRemovalPlan {
  affectedEntryCount: number;
  affectedTagValues: string[];
  branchPath: string;
  entries: TagBranchRemovalEntryPlan[];
}

export interface TagBranchMoveMapping {
  from: string;
  to: string;
}

export interface TagBranchMoveEntryPlan {
  addedTags: string[];
  index: number;
  originalTags: string[];
  removedTags: string[];
  updatedTags: string[];
}

export interface TagBranchMovePlan {
  affectedAssignmentCount: number;
  affectedEntryCount: number;
  affectedTagPathCount: number;
  deduplicatedAssignmentCount: number;
  destinationParentPath: string | null;
  destinationPath: string;
  entries: TagBranchMoveEntryPlan[];
  mappings: TagBranchMoveMapping[];
  sourcePath: string;
}

export interface TagBranchColourMovePlan {
  affectedColourPathCount: number;
  conflictCount: number;
  nextColours: Record<string, string>;
}

export interface TagDefinitionBranchMovePlan {
  affectedDefinitionCount: number;
  deduplicatedDefinitionCount: number;
  destinationPath: string;
  mappings: TagBranchMoveMapping[];
  nextDefinitions: string[];
  sourcePath: string;
}

export interface TagDefinitionRemovalPlan {
  affectedDefinitionCount: number;
  nextDefinitions: string[];
  removedDefinitions: string[];
}

/** Destructive confirmation is needed only when video assignments are affected. */
export function tagRemovalRequiresConfirmation(affectedVideoCount: number): boolean {
  return affectedVideoCount > 0;
}

/** One unique, view-only manual-tag segment shown in an individual video sheet. */
export interface VideoTagSegment {
  /** Exact hierarchy prefix represented by this segment, used for colour editing and removal. */
  colourPath: string;
  /** Case-insensitive identity of the exact hierarchy prefix, not merely its visible label. */
  identity: string;
  label: string;
  /** Exact stored tag paths in this video that contain the segment. */
  sourceTagPaths: string[];
}

/** Immutable plan for removing one displayed tag branch from one video. */
export interface VideoTagBranchRemovalPlan {
  branchPaths: string[];
  originalTags: string[];
  remainingTags: string[];
  removedTags: string[];
  segmentName: string;
}

interface MutableTagHierarchyNode {
  branchSourceIndexes: Set<number>;
  children: Map<string, MutableTagHierarchyNode>;
  directSourceIndexes: Set<number>;
  explicit: boolean;
  explicitTagValues: string[];
  explicitTagValueSet: Set<string>;
  fullPath: string;
  label: string;
}

function segmentIsValidForHierarchy(segment: string): boolean {
  return Boolean(segment)
    && segment.length <= TAG_PATH_MAX_SEGMENT_LENGTH
    && segment === segment.trim()
    && !segment.includes('>')
    && !segment.includes(',')
    && !containsControlCharacter(segment);
}

/**
 * Parse an already-stored tag without changing it. Only an exactly canonical
 * path is interpreted as hierarchy; every malformed or noncanonical legacy
 * value remains a single flat segment so loading cannot reinterpret metadata.
 */
export function parseStoredTagPath(storedTag: string): ParsedStoredTagPath {
  const fullPath = typeof storedTag === 'string' ? storedTag : String(storedTag ?? '');
  const candidateSegments = fullPath.split(TAG_PATH_SEPARATOR);
  const canonicalHierarchy = candidateSegments.length > 1
    && candidateSegments.length <= TAG_PATH_MAX_DEPTH
    && fullPath.length <= TAG_PATH_MAX_LENGTH
    && candidateSegments.every(segmentIsValidForHierarchy)
    && candidateSegments.join(TAG_PATH_SEPARATOR) === fullPath;

  return {
    fullPath,
    hierarchical: canonicalHierarchy,
    segments: canonicalHierarchy ? candidateSegments : [fullPath],
  };
}

/**
 * Validate and canonicalize a newly entered tag. Unlike stored-tag parsing,
 * this intentionally treats every `>` as a hierarchy separator and accepts
 * arbitrary surrounding spaces before emitting the exact stored delimiter.
 */
export function validateAndNormalizeNewTagPath(input: string): TagPathValidationResult {
  if (typeof input !== 'string') {
    return { error: 'Tag must be text.', valid: false };
  }
  if (containsControlCharacter(input)) {
    return { error: 'Tag cannot contain control characters or line breaks.', valid: false };
  }
  if (input.includes(',')) {
    return { error: 'Tag cannot contain commas.', valid: false };
  }

  const rawSegments = input.split('>');
  if (rawSegments.length > TAG_PATH_MAX_DEPTH) {
    return { error: `Tag hierarchy cannot be deeper than ${TAG_PATH_MAX_DEPTH} levels.`, valid: false };
  }

  const segments = rawSegments.map((segment: string) => segment.trim());
  if (segments.some((segment: string) => !segment)) {
    return { error: 'Tag hierarchy cannot contain an empty level.', valid: false };
  }
  if (segments.some((segment: string) => segment.length > TAG_PATH_MAX_SEGMENT_LENGTH)) {
    return {
      error: `Each tag hierarchy level must be ${TAG_PATH_MAX_SEGMENT_LENGTH} characters or fewer.`,
      valid: false,
    };
  }

  const normalized = segments.join(TAG_PATH_SEPARATOR);
  if (normalized.length > TAG_PATH_MAX_LENGTH) {
    return { error: `Tag must be ${TAG_PATH_MAX_LENGTH} characters or fewer.`, valid: false };
  }

  return { normalized, valid: true };
}

/** Return a canonical new tag or throw a human-readable validation error. */
export function normalizeNewTagPath(input: string): string {
  const validation = validateAndNormalizeNewTagPath(input);
  if (!validation.valid || validation.normalized === undefined) {
    throw new Error(validation.error || 'Tag is invalid.');
  }
  return validation.normalized;
}

/**
 * Normalize newly entered text while retaining an existing stored spelling
 * when the input already identifies that exact tag. This prevents an
 * unchanged legacy value such as `People>Family` from being silently
 * reinterpreted merely because an editor field was opened and committed.
 */
export function normalizeTagInputPreservingExisting(
  input: string,
  existingTags: readonly string[],
): string {
  const trimmed = input.trim();
  const exactStoredValue = existingTags.find((tag: string) => tag === trimmed);
  if (exactStoredValue) {
    return exactStoredValue;
  }
  const existingBeforeNormalization = existingTags.find((tag: string) => (
    typeof tag === 'string' && tagPathsEqual(tag, trimmed)
  ));
  if (existingBeforeNormalization) {
    return existingBeforeNormalization;
  }

  const normalized = normalizeNewTagPath(trimmed);
  return existingTags.find((tag: string) => (
    typeof tag === 'string' && tagPathsEqual(tag, normalized)
  )) || normalized;
}

/** Case-insensitive identity without modifying the original display value. */
export function tagIdentityKey(tag: string): string {
  const parsed = parseStoredTagPath(tag);
  return parsed.segments.map((segment: string) => segment.toLowerCase()).join(TAG_PATH_SEPARATOR);
}

export function tagPathsEqual(left: string, right: string): boolean {
  return tagIdentityKey(left) === tagIdentityKey(right);
}

/** Resolve only an explicitly assigned colour; hierarchy ancestors are ignored. */
export function getExactTagColor(
  tagColors: Readonly<Record<string, string>>,
  tagPath: string,
): string | undefined {
  if (!tagPath) {
    return undefined;
  }
  const identity = tagIdentityKey(tagPath);
  const matchingKey = Object.keys(tagColors)
    .filter((key: string) => tagIdentityKey(key) === identity)
    .sort((left: string, right: string) => left.localeCompare(right, 'en', { numeric: true }))[0];
  return matchingKey === undefined ? undefined : tagColors[matchingKey];
}

/**
 * Project stored manual hierarchy paths into unique individual segment pills.
 * This is display-only: canonical paths remain unchanged in the catalogue,
 * while malformed legacy values remain one indivisible flat segment.
 */
export function getUniqueVideoTagSegments(tags: readonly string[]): VideoTagSegment[] {
  const segmentByBranchIdentity = new Map<string, VideoTagSegment>();

  tags.forEach((storedTag: string) => {
    if (typeof storedTag !== 'string' || !storedTag) {
      return;
    }

    const parsed = parseStoredTagPath(storedTag);
    parsed.segments.forEach((segment: string, segmentIndex: number) => {
      if (!segment) {
        return;
      }

      const colourPath = parsed.hierarchical
        ? parsed.segments.slice(0, segmentIndex + 1).join(TAG_PATH_SEPARATOR)
        : parsed.fullPath;
      const identity = tagIdentityKey(colourPath);
      const existing = segmentByBranchIdentity.get(identity);
      if (existing) {
        if (!existing.sourceTagPaths.includes(storedTag)) {
          existing.sourceTagPaths.push(storedTag);
        }
        return;
      }

      segmentByBranchIdentity.set(identity, {
        colourPath,
        identity,
        label: segment,
        sourceTagPaths: [storedTag],
      });
    });
  });

  return Array.from(segmentByBranchIdentity.values());
}

/**
 * Plan immediate removal of one exact visible branch and all of its descendants
 * from a single video. Same-named segments in unrelated branches, ancestors,
 * ordering, and legacy spellings are retained byte-for-byte.
 */
export function planVideoTagBranchRemoval(
  tags: readonly string[],
  branchPath: string,
): VideoTagBranchRemovalPlan {
  const originalTags = tags.slice();
  const removedTags = originalTags.filter((storedTag: string) => (
    typeof storedTag === 'string'
    && Boolean(branchPath)
    && isTagInBranch(storedTag, branchPath)
  ));
  const remainingTags = originalTags.filter((storedTag: string) => (
    typeof storedTag !== 'string'
    || !branchPath
    || !isTagInBranch(storedTag, branchPath)
  ));
  const parsedBranchPath = parseStoredTagPath(branchPath);
  const segmentName = parsedBranchPath.segments[parsedBranchPath.segments.length - 1] || branchPath;

  return {
    branchPaths: removedTags.length ? [branchPath] : [],
    originalTags,
    remainingTags,
    removedTags,
    segmentName,
  };
}

/**
 * Add one exact tag to selected entries in a single batch. The caller can
 * rebuild its derived tag index once, avoiding parity-sensitive UI toggles
 * when an even number of videos changes.
 */
export function addTagToSelectedEntries(
  entries: SelectedTagTarget[],
  tagPath: string,
): number {
  let affectedEntryCount = 0;

  entries.forEach((entry: SelectedTagTarget) => {
    if (!entry.selected) {
      return;
    }
    const existingTags = Array.isArray(entry.tags) ? entry.tags : [];
    if (existingTags.some((tag: string) => tagPathsEqual(tag, tagPath))) {
      return;
    }

    entry.tags = existingTags.concat(tagPath);
    affectedEntryCount++;
  });

  return affectedEntryCount;
}

/**
 * Return canonical ancestor paths ordered from root to parent. Set includeSelf
 * to include the tag itself. Flat tags have no ancestors.
 */
export function getTagAncestorPaths(tag: string, includeSelf = false): string[] {
  const parsed = parseStoredTagPath(tag);
  if (!parsed.hierarchical) {
    return includeSelf && parsed.fullPath ? [parsed.fullPath] : [];
  }

  const finalLength = includeSelf ? parsed.segments.length : parsed.segments.length - 1;
  const ancestors: string[] = [];
  for (let length = 1; length <= finalLength; length++) {
    ancestors.push(parsed.segments.slice(0, length).join(TAG_PATH_SEPARATOR));
  }
  return ancestors;
}

/** Match a tag to an exact branch or descendant on segment boundaries. */
export function isTagInBranch(tag: string, branchPath: string): boolean {
  const tagSegments = parseStoredTagPath(tag).segments;
  const branchSegments = parseStoredTagPath(branchPath).segments;
  if (!branchSegments[0] || branchSegments.length > tagSegments.length) {
    return false;
  }

  return branchSegments.every((segment: string, index: number) => (
    segment.toLowerCase() === tagSegments[index].toLowerCase()
  ));
}

/** Match one manual-tag filter without joining adjacent tag values together. */
export function matchesManualTagQuery(
  tags: readonly string[] | undefined,
  query: string,
  branchMatch: boolean,
  exactMatch = false,
): boolean {
  if (!Array.isArray(tags) || !query) {
    return false;
  }

  if (branchMatch) {
    return tags.some((tag: string) => typeof tag === 'string' && isTagInBranch(tag, query));
  }

  if (exactMatch) {
    return tags.some((tag: string) => typeof tag === 'string' && tagPathsEqual(tag, query));
  }

  const needle = query.toLowerCase();
  return tags.some((tag: string) => typeof tag === 'string' && tag.toLowerCase().includes(needle));
}

function mutableNode(label: string, fullPath: string): MutableTagHierarchyNode {
  return {
    branchSourceIndexes: new Set<number>(),
    children: new Map<string, MutableTagHierarchyNode>(),
    directSourceIndexes: new Set<number>(),
    explicit: false,
    explicitTagValues: [],
    explicitTagValueSet: new Set<string>(),
    fullPath,
    label,
  };
}

function materializeNode(node: MutableTagHierarchyNode): TagHierarchyNode {
  return {
    branchFrequency: node.branchSourceIndexes.size,
    children: Array.from(node.children.values()).map(materializeNode),
    directFrequency: node.directSourceIndexes.size,
    explicit: node.explicit,
    explicitTagValues: node.explicitTagValues.slice(),
    fullPath: node.fullPath,
    label: node.label,
  };
}

/** Build a derived hierarchy without mutating tags or adding implicit ancestors. */
export function buildTagHierarchy(
  sources: readonly TagHierarchySource[],
  definitions: readonly string[] = [],
): TagHierarchyNode[] {
  const roots = new Map<string, MutableTagHierarchyNode>();

  const insertTagPath = (storedTag: string, sourceIndex?: number): void => {
    if (typeof storedTag !== 'string' || !storedTag) {
      return;
    }

    const parsed = parseStoredTagPath(storedTag);
    let siblings = roots;
    let parentPath = '';
    let leaf: MutableTagHierarchyNode | undefined;

    parsed.segments.forEach((segment: string) => {
      const segmentKey = segment.toLowerCase();
      let node = siblings.get(segmentKey);
      if (!node) {
        const fullPath = parentPath ? `${parentPath}${TAG_PATH_SEPARATOR}${segment}` : segment;
        node = mutableNode(segment, fullPath);
        siblings.set(segmentKey, node);
      }
      if (sourceIndex !== undefined) {
        node.branchSourceIndexes.add(sourceIndex);
      }
      leaf = node;
      parentPath = node.fullPath;
      siblings = node.children;
    });

    if (leaf) {
      leaf.explicit = true;
      if (sourceIndex !== undefined) {
        leaf.directSourceIndexes.add(sourceIndex);
      }
      if (!leaf.explicitTagValueSet.has(storedTag)) {
        leaf.explicitTagValueSet.add(storedTag);
        leaf.explicitTagValues.push(storedTag);
      }
    }
  };

  definitions.forEach((definition: string) => insertTagPath(definition));

  sources.forEach((source: TagHierarchySource, sourceIndex: number) => {
    if (!Array.isArray(source.tags)) {
      return;
    }

    source.tags.forEach((storedTag: string) => {
      if (typeof storedTag !== 'string' || !storedTag) {
        return;
      }

      insertTagPath(storedTag, sourceIndex);
    });
  });

  return sortTagHierarchy(Array.from(roots.values()).map(materializeNode), 'alphabetical');
}

function cloneNode(node: TagHierarchyNode, children = node.children): TagHierarchyNode {
  return {
    branchFrequency: node.branchFrequency,
    children,
    directFrequency: node.directFrequency,
    explicit: node.explicit,
    explicitTagValues: node.explicitTagValues.slice(),
    fullPath: node.fullPath,
    label: node.label,
  };
}

/** Deep-sort a cloned hierarchy; neither the node array nor children are mutated. */
export function sortTagHierarchy(
  nodes: readonly TagHierarchyNode[],
  mode: TagHierarchySortMode,
): TagHierarchyNode[] {
  const sorted = nodes.map((node: TagHierarchyNode) => (
    cloneNode(node, sortTagHierarchy(node.children, mode))
  ));

  return sorted.sort((left: TagHierarchyNode, right: TagHierarchyNode) => {
    if (mode === 'frequency' && left.branchFrequency !== right.branchFrequency) {
      return right.branchFrequency - left.branchFrequency;
    }
    return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
  });
}

function cloneTree(nodes: readonly TagHierarchyNode[]): TagHierarchyNode[] {
  return nodes.map((node: TagHierarchyNode) => cloneNode(node, cloneTree(node.children)));
}

/**
 * Return a cloned filtered tree. Ancestors of matches are retained; a matching
 * parent keeps its complete subtree so the result remains useful for browsing.
 */
export function filterTagHierarchy(nodes: readonly TagHierarchyNode[], query: string): TagHierarchyNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return cloneTree(nodes);
  }

  const filtered: TagHierarchyNode[] = [];
  nodes.forEach((node: TagHierarchyNode) => {
    const nodeMatches = node.label.toLowerCase().includes(needle)
      || node.fullPath.toLowerCase().includes(needle);
    if (nodeMatches) {
      filtered.push(cloneNode(node, cloneTree(node.children)));
      return;
    }

    const matchingChildren = filterTagHierarchy(node.children, query);
    if (matchingChildren.length) {
      filtered.push(cloneNode(node, matchingChildren));
    }
  });
  return filtered;
}

/**
 * Plan removal of an exact branch and all descendants without mutating source
 * entries. Exact stored values are retained in the plan so case variants can
 * be removed safely.
 */
export function planTagBranchRemoval(
  sources: readonly TagHierarchySource[],
  branchPath: string,
): TagBranchRemovalPlan {
  const entries: TagBranchRemovalEntryPlan[] = [];
  const affectedTagValueSet = new Set<string>();

  if (!branchPath) {
    return { affectedEntryCount: 0, affectedTagValues: [], branchPath, entries };
  }

  sources.forEach((source: TagHierarchySource, index: number) => {
    if (!Array.isArray(source.tags)) {
      return;
    }

    const removedTags = source.tags.filter((tag: string) => isTagInBranch(tag, branchPath));
    if (!removedTags.length) {
      return;
    }
    removedTags.forEach((tag: string) => affectedTagValueSet.add(tag));
    entries.push({
      index,
      remainingTags: source.tags.filter((tag: string) => !isTagInBranch(tag, branchPath)),
      removedTags: removedTags.slice(),
    });
  });

  return {
    affectedEntryCount: entries.length,
    affectedTagValues: Array.from(affectedTagValueSet),
    branchPath,
    entries,
  };
}

function assertMovableHierarchyPath(path: string, role: 'source' | 'destination'): ParsedStoredTagPath {
  const parsed = parseStoredTagPath(path);
  if (!parsed.fullPath) {
    throw new Error(`The ${role} tag path is empty.`);
  }
  if (!parsed.hierarchical && parsed.fullPath.includes('>')) {
    throw new Error(
      `The ${role} tag uses a legacy non-hierarchical “>” value and cannot be moved as a hierarchy.`,
    );
  }
  return parsed;
}

/** Resolve the new base path for a branch moved beneath a parent or back to the root. */
export function resolveTagBranchMoveDestination(
  sourcePath: string,
  destinationParentPath: string | null,
): string {
  const source = assertMovableHierarchyPath(sourcePath, 'source');
  const sourceLabel = source.segments[source.segments.length - 1];

  if (destinationParentPath === null) {
    return normalizeNewTagPath(sourceLabel);
  }

  const destinationParent = assertMovableHierarchyPath(destinationParentPath, 'destination');
  if (isTagInBranch(destinationParent.fullPath, source.fullPath)) {
    throw new Error('A tag branch cannot be moved into itself or one of its descendants.');
  }

  return normalizeNewTagPath(
    `${destinationParent.fullPath}${TAG_PATH_SEPARATOR}${sourceLabel}`,
  );
}

/**
 * Plan the matching definition-registry rewrite for a hierarchy move. Existing
 * destination definitions retain their spelling and equivalent moved paths are
 * consolidated without changing any video assignments.
 */
export function planTagDefinitionBranchMove(
  definitions: readonly string[],
  sourcePath: string,
  destinationParentPath: string | null,
): TagDefinitionBranchMovePlan {
  const destinationPath = resolveTagBranchMoveDestination(sourcePath, destinationParentPath);
  if (tagPathsEqual(sourcePath, destinationPath)) {
    return {
      affectedDefinitionCount: 0,
      deduplicatedDefinitionCount: 0,
      destinationPath,
      mappings: [],
      nextDefinitions: definitions.slice(),
      sourcePath,
    };
  }
  const retainedDefinitions = definitions.filter((definition: string) => (
    typeof definition !== 'string' || !isTagInBranch(definition, sourcePath)
  ));
  const movedDefinitions = definitions.filter((definition: string) => (
    typeof definition === 'string' && isTagInBranch(definition, sourcePath)
  ));
  const nextDefinitions = retainedDefinitions.slice();
  const seenIdentities = new Set<string>();
  nextDefinitions.forEach((definition: string) => {
    if (typeof definition === 'string' && definition) {
      seenIdentities.add(tagIdentityKey(definition));
    }
  });
  const mappings: TagBranchMoveMapping[] = [];
  let deduplicatedDefinitionCount = 0;

  movedDefinitions.forEach((definition: string) => {
    const movedDefinition = remapTagBranchPath(definition, sourcePath, destinationPath);
    mappings.push({ from: definition, to: movedDefinition });
    const identity = tagIdentityKey(movedDefinition);
    if (seenIdentities.has(identity)) {
      deduplicatedDefinitionCount++;
      return;
    }
    seenIdentities.add(identity);
    nextDefinitions.push(movedDefinition);
  });

  return {
    affectedDefinitionCount: movedDefinitions.length,
    deduplicatedDefinitionCount,
    destinationPath,
    mappings,
    nextDefinitions,
    sourcePath,
  };
}

/** Plan removal of one exact persistent definition without changing descendants. */
export function planExactTagDefinitionRemoval(
  definitions: readonly string[],
  tagPath: string,
): TagDefinitionRemovalPlan {
  const removedDefinitions = definitions.filter((definition: string) => (
    typeof definition === 'string' && tagPathsEqual(definition, tagPath)
  ));
  return {
    affectedDefinitionCount: removedDefinitions.length,
    nextDefinitions: definitions.filter((definition: string) => (
      typeof definition !== 'string' || !tagPathsEqual(definition, tagPath)
    )),
    removedDefinitions,
  };
}

/** Plan removal of every persistent definition in a hierarchy branch. */
export function planTagDefinitionBranchRemoval(
  definitions: readonly string[],
  branchPath: string,
): TagDefinitionRemovalPlan {
  const removedDefinitions = definitions.filter((definition: string) => (
    typeof definition === 'string' && isTagInBranch(definition, branchPath)
  ));
  return {
    affectedDefinitionCount: removedDefinitions.length,
    nextDefinitions: definitions.filter((definition: string) => (
      typeof definition !== 'string' || !isTagInBranch(definition, branchPath)
    )),
    removedDefinitions,
  };
}

/** Remap one exact tag path while retaining its suffix below the moved branch. */
export function remapTagBranchPath(
  tagPath: string,
  sourcePath: string,
  destinationPath: string,
): string {
  if (!isTagInBranch(tagPath, sourcePath)) {
    return tagPath;
  }

  const tag = parseStoredTagPath(tagPath);
  const source = assertMovableHierarchyPath(sourcePath, 'source');
  const destination = assertMovableHierarchyPath(destinationPath, 'destination');
  const suffix = tag.segments.slice(source.segments.length);
  return normalizeNewTagPath(destination.segments.concat(suffix).join(TAG_PATH_SEPARATOR));
}

/**
 * Plan a global branch move without mutating catalogue entries. Existing tags
 * at the destination win spelling conflicts and equivalent moved duplicates
 * are consolidated per video.
 */
export function planTagBranchMove(
  sources: readonly TagHierarchySource[],
  sourcePath: string,
  destinationParentPath: string | null,
): TagBranchMovePlan {
  const destinationPath = resolveTagBranchMoveDestination(sourcePath, destinationParentPath);
  const entries: TagBranchMoveEntryPlan[] = [];
  const mappings = new Map<string, TagBranchMoveMapping>();
  const affectedPathIdentities = new Set<string>();
  let affectedAssignmentCount = 0;
  let deduplicatedAssignmentCount = 0;

  if (tagPathsEqual(sourcePath, destinationPath)) {
    return {
      affectedAssignmentCount: 0,
      affectedEntryCount: 0,
      affectedTagPathCount: 0,
      deduplicatedAssignmentCount: 0,
      destinationParentPath,
      destinationPath,
      entries,
      mappings: [],
      sourcePath,
    };
  }

  sources.forEach((source: TagHierarchySource, index: number) => {
    if (!Array.isArray(source.tags)) {
      return;
    }

    const removedTags = source.tags.filter((tag: string) => (
      typeof tag === 'string' && isTagInBranch(tag, sourcePath)
    ));
    if (!removedTags.length) {
      return;
    }

    const remainingTags = source.tags.filter((tag: string) => (
      typeof tag !== 'string' || !isTagInBranch(tag, sourcePath)
    ));
    const updatedTags = remainingTags.slice();
    const seenDestinationIdentities = new Set<string>();
    remainingTags.forEach((tag: string) => {
      if (typeof tag === 'string') {
        seenDestinationIdentities.add(tagIdentityKey(tag));
      }
    });
    const addedTags: string[] = [];

    removedTags.forEach((tag: string) => {
      const movedTag = remapTagBranchPath(tag, sourcePath, destinationPath);
      const sourceIdentity = tagIdentityKey(tag);
      const destinationIdentity = tagIdentityKey(movedTag);
      affectedPathIdentities.add(sourceIdentity);
      if (!mappings.has(tag)) {
        mappings.set(tag, { from: tag, to: movedTag });
      }
      if (!seenDestinationIdentities.has(destinationIdentity)) {
        seenDestinationIdentities.add(destinationIdentity);
        updatedTags.push(movedTag);
        addedTags.push(movedTag);
      }
    });
    affectedAssignmentCount += removedTags.length;
    deduplicatedAssignmentCount += removedTags.length - addedTags.length;

    entries.push({
      addedTags,
      index,
      originalTags: source.tags.slice(),
      removedTags: removedTags.slice(),
      updatedTags,
    });
  });

  return {
    affectedAssignmentCount,
    affectedEntryCount: entries.length,
    affectedTagPathCount: affectedPathIdentities.size,
    deduplicatedAssignmentCount,
    destinationParentPath,
    destinationPath,
    entries,
    mappings: Array.from(mappings.values()),
    sourcePath,
  };
}

/**
 * Plan explicit colour-key migration for a branch move. Existing destination
 * colours win conflicts so a hierarchy change never silently overwrites them.
 */
export function planTagBranchColourMove(
  colours: Readonly<Record<string, string>>,
  sourcePath: string,
  destinationPath: string,
): TagBranchColourMovePlan {
  const sourceEntries = Object.entries(colours)
    .filter(([tagPath]: [string, string]) => isTagInBranch(tagPath, sourcePath));
  const nextColours: Record<string, string> = {};

  Object.entries(colours).forEach(([tagPath, colour]: [string, string]) => {
    if (!isTagInBranch(tagPath, sourcePath)) {
      nextColours[tagPath] = colour;
    }
  });

  let conflictCount = 0;
  sourceEntries.forEach(([tagPath, colour]: [string, string]) => {
    const destinationColourPath = remapTagBranchPath(tagPath, sourcePath, destinationPath);
    const existingDestinationKey = Object.keys(nextColours)
      .find((existingPath: string) => tagPathsEqual(existingPath, destinationColourPath));

    if (existingDestinationKey !== undefined) {
      if (nextColours[existingDestinationKey] !== colour) {
        conflictCount++;
      }
      return;
    }
    nextColours[destinationColourPath] = colour;
  });

  return {
    affectedColourPathCount: sourceEntries.length,
    conflictCount,
    nextColours,
  };
}
