import type { FinalObject } from '../../../interfaces/final-object.interface';
import type { SettingsObject } from '../../../interfaces/settings-object.interface';

export type CataloguePersistenceDisposer = () => void;

export interface CataloguePersistenceHooks {
  closeCancelled(): void;
  closeRequested(): void;
  closeSaveFailed(message?: string): void;
  saveFailed(message?: string): void;
  saveSucceeded(): void;
}

/** Semantic IPC port; Electron channel details stay in the Angular adapter. */
export interface CataloguePersistenceTransport {
  onCloseCancelled(listener: () => void): CataloguePersistenceDisposer;
  onCloseRequested(listener: () => void): CataloguePersistenceDisposer;
  onCloseSaveFailed(
    listener: (message?: string) => void,
  ): CataloguePersistenceDisposer;
  onSaveFailed(listener: (message?: string) => void): CataloguePersistenceDisposer;
  onSaveSucceeded(listener: () => void): CataloguePersistenceDisposer;
  requestClose(settings: SettingsObject, document: FinalObject | null): void;
  saveCatalogue(document: FinalObject): void;
}

/**
 * Owns the catalogue save/close listener lifecycle without depending on
 * Angular or Electron. HomeComponent remains responsible for presentation and
 * for constructing persistence snapshots before outbound requests.
 */
export class CataloguePersistenceCoordinator {

  private connectionGeneration = 0;
  private disposers: CataloguePersistenceDisposer[] = [];
  private hooks: CataloguePersistenceHooks | undefined;

  constructor(private readonly transport: CataloguePersistenceTransport) {}

  connect(hooks: CataloguePersistenceHooks): void {
    const priorCleanupError = this.clearConnection();
    if (priorCleanupError !== undefined) {
      throw priorCleanupError;
    }
    this.hooks = hooks;
    const connectionGeneration = this.connectionGeneration;

    const dispatch = (callback: (activeHooks: CataloguePersistenceHooks) => void): void => {
      if (
           connectionGeneration === this.connectionGeneration
        && this.hooks === hooks
      ) {
        callback(hooks);
      }
    };

    try {
      this.disposers.push(this.transport.onCloseRequested(() => dispatch((activeHooks) => {
        activeHooks.closeRequested();
      })));
      this.disposers.push(this.transport.onSaveSucceeded(() => dispatch((activeHooks) => {
        activeHooks.saveSucceeded();
      })));
      this.disposers.push(this.transport.onSaveFailed((message?: string) => dispatch((activeHooks) => {
        activeHooks.saveFailed(message);
      })));
      this.disposers.push(this.transport.onCloseSaveFailed((message?: string) => dispatch((activeHooks) => {
        activeHooks.closeSaveFailed(message);
      })));
      this.disposers.push(this.transport.onCloseCancelled(() => dispatch((activeHooks) => {
        activeHooks.closeCancelled();
      })));
    } catch (error) {
      // Keep the registration error as the useful failure while still making
      // a best-effort attempt to release every listener registered so far.
      this.clearConnection();
      throw error;
    }
  }

  disconnect(): void {
    const cleanupError = this.clearConnection();
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }

  private clearConnection(): unknown {
    this.connectionGeneration += 1;
    this.hooks = undefined;
    const disposers = this.disposers;
    this.disposers = [];
    let firstError: unknown;
    disposers.forEach((dispose: CataloguePersistenceDisposer) => {
      try {
        dispose();
      } catch (error) {
        firstError ??= error;
      }
    });
    return firstError;
  }

  requestClose(settings: SettingsObject, document: FinalObject | null): void {
    this.transport.requestClose(settings, document);
  }

  saveCatalogue(document: FinalObject): void {
    this.transport.saveCatalogue(document);
  }
}
