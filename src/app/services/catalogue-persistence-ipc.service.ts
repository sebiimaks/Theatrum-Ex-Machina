import { Injectable, OnDestroy } from '@angular/core';

import type { FinalObject } from '../../../interfaces/final-object.interface';
import type { SettingsObject } from '../../../interfaces/settings-object.interface';
import { CataloguePersistenceCoordinator } from '../common/catalogue-persistence-coordinator';
import type { CataloguePersistenceHooks } from '../common/catalogue-persistence-coordinator';
import { ElectronService } from '../providers/electron.service';

/** Angular/Electron adapter for catalogue save and close persistence IPC. */
@Injectable({ providedIn: 'root' })
export class CataloguePersistenceIpcService implements OnDestroy {

  private readonly coordinator: CataloguePersistenceCoordinator;

  constructor(private readonly electronService: ElectronService) {
    this.coordinator = new CataloguePersistenceCoordinator({
      onCloseCancelled: (listener): (() => void) => (
        this.electronService.ipcRenderer.on('close-window-cancelled', () => listener())
      ),
      onCloseRequested: (listener): (() => void) => (
        this.electronService.ipcRenderer.on('please-shut-down-ASAP', () => listener())
      ),
      onCloseSaveFailed: (listener): (() => void) => (
        this.electronService.ipcRenderer.on(
          'close-window-save-failed',
          (_event, message?: string) => listener(message),
        )
      ),
      onSaveFailed: (listener): (() => void) => (
        this.electronService.ipcRenderer.on(
          'current-vha-file-save-failed',
          (_event, message?: string) => listener(message),
        )
      ),
      onSaveSucceeded: (listener): (() => void) => (
        this.electronService.ipcRenderer.on('current-vha-file-saved', () => listener())
      ),
      requestClose: (settings, document): void => {
        this.electronService.ipcRenderer.send('close-window', settings, document);
      },
      saveCatalogue: (document): void => {
        this.electronService.ipcRenderer.send('save-current-vha-file', document);
      },
    });
  }

  connect(hooks: CataloguePersistenceHooks): void {
    this.coordinator.connect(hooks);
  }

  disconnect(): void {
    try {
      this.coordinator.disconnect();
    } catch (error) {
      console.error('Unable to remove a catalogue persistence listener cleanly:', error);
    }
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  requestClose(settings: SettingsObject, document: FinalObject | null): void {
    this.coordinator.requestClose(settings, document);
  }

  saveCatalogue(document: FinalObject): void {
    this.coordinator.saveCatalogue(document);
  }
}
