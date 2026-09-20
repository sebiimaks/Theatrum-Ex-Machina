import { isTagInBranch, remapTagBranchPath } from '../../../interfaces/tag-hierarchy';

/** Search reveals matches without overwriting the ordinary tree's expansion state. */
export class TagTreeExpansionState {
  private readonly expandedPaths = new Set<string>();
  private readonly collapsedSearchPaths = new Set<string>();
  private query = '';

  setFilter(query: string): void {
    const normalized = query.trim().toLowerCase();
    if (normalized !== this.query) {
      this.query = normalized;
      this.collapsedSearchPaths.clear();
    }
  }

  isExpanded(path: string): boolean {
    return this.query ? !this.collapsedSearchPaths.has(path) : this.expandedPaths.has(path);
  }

  toggle(path: string): void {
    const paths = this.query ? this.collapsedSearchPaths : this.expandedPaths;
    if (paths.has(path)) {
      paths.delete(path);
    } else {
      paths.add(path);
    }
  }

  /** Used for initial roots and revealing a newly created tag outside search. */
  rememberExpanded(path: string): void {
    this.expandedPaths.add(path);
  }

  expandAll(branchPaths: readonly string[]): void {
    if (this.query) {
      this.collapsedSearchPaths.clear();
    } else {
      branchPaths.forEach((path) => this.expandedPaths.add(path));
    }
  }

  collapseAll(branchPaths: readonly string[]): void {
    if (this.query) {
      branchPaths.forEach((path) => this.collapsedSearchPaths.add(path));
    } else {
      this.expandedPaths.clear();
    }
  }

  remapBranch(sourcePath: string, destinationPath: string): void {
    [this.expandedPaths, this.collapsedSearchPaths].forEach((paths) => {
      const remapped = Array.from(paths).map((path) => (
        isTagInBranch(path, sourcePath)
          ? remapTagBranchPath(path, sourcePath, destinationPath)
          : path
      ));
      paths.clear();
      remapped.forEach((path) => paths.add(path));
    });
    this.expandedPaths.add(destinationPath);
    this.collapsedSearchPaths.delete(destinationPath);
  }
}
