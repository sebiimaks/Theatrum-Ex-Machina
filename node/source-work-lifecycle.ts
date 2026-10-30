export interface AutomaticPreviewToken {
  readonly sourceIndex: number;
  readonly hash: string;
  readonly generation: number;
}

/** Source-local cancellation cannot invalidate a newer preview's hash marker. */
export class SourceWorkLifecycle {
  private readonly generations = new Map<number, number>();
  private readonly activePreviews = new Map<number, Map<string, AutomaticPreviewToken>>();

  capture(sourceIndex: number): number {
    return this.generations.get(sourceIndex) || 0;
  }

  isCurrent(sourceIndex: number, generation: number): boolean {
    return this.capture(sourceIndex) === generation;
  }

  beginPreview(sourceIndex: number, hash: string): AutomaticPreviewToken {
    let previews = this.activePreviews.get(sourceIndex);
    if (!previews) {
      previews = new Map();
      this.activePreviews.set(sourceIndex, previews);
    }
    const token = { sourceIndex, hash, generation: this.capture(sourceIndex) };
    previews.set(hash, token);
    return token;
  }

  finishPreview(token: AutomaticPreviewToken): boolean {
    const previews = this.activePreviews.get(token.sourceIndex);
    if (previews?.get(token.hash) !== token) {
      return false;
    }
    previews.delete(token.hash);
    if (previews.size === 0) {
      this.activePreviews.delete(token.sourceIndex);
    }
    return this.isCurrent(token.sourceIndex, token.generation);
  }

  cancelSource(sourceIndex: number): string[] {
    this.generations.set(sourceIndex, this.capture(sourceIndex) + 1);
    const hashes = [...(this.activePreviews.get(sourceIndex)?.keys() || [])];
    this.activePreviews.delete(sourceIndex);
    return hashes;
  }
}
