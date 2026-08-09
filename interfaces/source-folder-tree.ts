import type { ImageElement } from './final-object.interface';
import { isMetadataImportFailure } from './final-object.interface';
import { getImageLocations, imageElementAtLocation } from './media-locations';
import {
  isSourceFolderWithinScope,
  normalizeIgnoredSubdirectories,
  normalizeSourceFolderRelativePath,
} from './source-folder-path';

export {
  isSourceFolderWithinScope,
  normalizeSourceFolderRelativePath,
} from './source-folder-path';

export interface SourceFolderTreeNode {
  children: SourceFolderTreeNode[];
  containsIgnoredScope: boolean;
  depth: number;
  directEligibleThumbnailCount: number;
  directVideoCount: number;
  eligibleThumbnailCount: number;
  ignored: boolean;
  name: string;
  recursiveVideoCount: number;
  relativePath: string;
  sourceIndex: number;
}

interface MutableSourceFolderTreeNode {
  childPaths: Set<string>;
  containsIgnoredScope: boolean;
  depth: number;
  directEligibleThumbnailCount: number;
  directVideoCount: number;
  eligibleThumbnailCount: number;
  ignored: boolean;
  name: string;
  recursiveVideoCount: number;
  relativePath: string;
  sourceIndex: number;
}

function compareStableFolderNames(
  left: MutableSourceFolderTreeNode,
  right: MutableSourceFolderTreeNode,
): number {
  const leftFolded = left.name.toLocaleLowerCase('en-US');
  const rightFolded = right.name.toLocaleLowerCase('en-US');
  if (leftFolded < rightFolded) {
    return -1;
  }
  if (leftFolded > rightFolded) {
    return 1;
  }
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  return left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath ? 1 : 0;
}

function eligibleForThumbnailRegeneration(element: ImageElement): boolean {
  return element.missing !== true
    && !isMetadataImportFailure(element)
    && typeof element.hash === 'string'
    && /^[a-zA-Z0-9_-]+$/.test(element.hash);
}

/**
 * Build a display-only tree for one configured source. Discovered directory
 * paths may include empty folders, but they never become independent source
 * roots. Catalogue entries marked temporarily unavailable remain represented.
 */
export function buildSourceFolderTree(
  elements: readonly ImageElement[],
  sourceIndex: number,
  discoveredRelativePaths: readonly string[] = [],
  ignoredRelativePaths: readonly string[] = [],
): SourceFolderTreeNode {
  if (!Number.isInteger(sourceIndex)) {
    throw new Error('The source index is invalid.');
  }

  const nodes = new Map<string, MutableSourceFolderTreeNode>();
  const createNode = (relativePath: string): MutableSourceFolderTreeNode => {
    const existing = nodes.get(relativePath);
    if (existing) {
      return existing;
    }
    const segments = relativePath === '' ? [] : relativePath.split('/');
    const node: MutableSourceFolderTreeNode = {
      childPaths: new Set<string>(),
      containsIgnoredScope: false,
      depth: segments.length,
      directEligibleThumbnailCount: 0,
      directVideoCount: 0,
      eligibleThumbnailCount: 0,
      ignored: false,
      name: segments.length > 0 ? segments[segments.length - 1] : '',
      recursiveVideoCount: 0,
      relativePath,
      sourceIndex,
    };
    nodes.set(relativePath, node);
    return node;
  };

  const ensurePath = (rawPath: unknown): MutableSourceFolderTreeNode[] => {
    const relativePath = normalizeSourceFolderRelativePath(rawPath);
    const lineage: MutableSourceFolderTreeNode[] = [createNode('')];
    if (relativePath === '') {
      return lineage;
    }

    const segments = relativePath.split('/');
    let parentPath = '';
    segments.forEach((segment: string) => {
      const childPath = parentPath ? `${parentPath}/${segment}` : segment;
      const parent = createNode(parentPath);
      parent.childPaths.add(childPath);
      lineage.push(createNode(childPath));
      parentPath = childPath;
    });
    return lineage;
  };

  createNode('');
  discoveredRelativePaths.forEach((relativePath: string) => ensurePath(relativePath));
  normalizeIgnoredSubdirectories(ignoredRelativePaths).forEach((relativePath: string) => {
    const lineage = ensurePath(relativePath);
    lineage.forEach((node: MutableSourceFolderTreeNode) => {
      node.containsIgnoredScope = true;
    });
    lineage[lineage.length - 1].ignored = true;
  });

  elements.forEach((element: ImageElement) => {
    if (element.deleted === true || element.cleanName === '*FOLDER*') {
      return;
    }

    getImageLocations(element)
      .filter(location => Number(location.inputSource) === sourceIndex)
      .forEach((location) => {
        const projectedElement = imageElementAtLocation(element, location);
        const lineage = ensurePath(location.partialPath);
        const leaf = lineage[lineage.length - 1];
        const eligible = eligibleForThumbnailRegeneration(projectedElement);
        leaf.directVideoCount++;
        if (eligible) {
          leaf.directEligibleThumbnailCount++;
        }
        lineage.forEach((node: MutableSourceFolderTreeNode) => {
          node.recursiveVideoCount++;
          if (eligible) {
            node.eligibleThumbnailCount++;
          }
        });
      });
  });

  const materialize = (node: MutableSourceFolderTreeNode): SourceFolderTreeNode => ({
    children: (node.ignored ? [] : Array.from(node.childPaths))
      .map((childPath: string) => nodes.get(childPath))
      .filter((child): child is MutableSourceFolderTreeNode => child !== undefined)
      .sort(compareStableFolderNames)
      .map(materialize),
    containsIgnoredScope: node.containsIgnoredScope,
    depth: node.depth,
    directEligibleThumbnailCount: node.directEligibleThumbnailCount,
    directVideoCount: node.directVideoCount,
    eligibleThumbnailCount: node.eligibleThumbnailCount,
    ignored: node.ignored,
    name: node.name,
    recursiveVideoCount: node.recursiveVideoCount,
    relativePath: node.relativePath,
    sourceIndex: node.sourceIndex,
  });

  return materialize(nodes.get(''));
}
