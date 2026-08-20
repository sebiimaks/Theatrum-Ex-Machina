/**
 * FIFO queue for catalogue paths received from Finder, command-line launch,
 * or another app instance before the renderer can safely present them.
 *
 * Only one request is handed to the renderer at a time. The renderer must
 * acknowledge that request before the next is dispatched so multiple native
 * open events cannot replace one another or stack overlapping choice dialogs.
 */
export class CatalogueOpenQueue {
  private inFlightPath: string | null = null;
  private readonly pending: string[] = [];

  enqueue(filePath: string): void {
    if (!filePath) {
      return;
    }
    this.pending.push(filePath);
  }

  acknowledge(): void {
    this.inFlightPath = null;
  }

  next(): string | null {
    if (this.inFlightPath !== null) {
      return null;
    }
    const nextPath = this.pending.shift();
    if (!nextPath) {
      return null;
    }
    this.inFlightPath = nextPath;
    return nextPath;
  }

  requeueInFlight(): void {
    if (this.inFlightPath === null) {
      return;
    }
    this.pending.unshift(this.inFlightPath);
    this.inFlightPath = null;
  }

  get waitingCount(): number {
    return this.pending.length;
  }

  get hasInFlightRequest(): boolean {
    return this.inFlightPath !== null;
  }
}
