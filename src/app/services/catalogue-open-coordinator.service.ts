import { Injectable, OnDestroy } from '@angular/core';

import {
  CatalogueOpenCoordinator,
  CatalogueOpenCoordinatorHooks,
} from '../common/catalogue-open-coordinator';
import { ElectronService } from '../providers/electron.service';

/**
 * Angular/Electron adapter for the pure catalogue-open state machine.
 */
@Injectable({ providedIn: 'root' })
export class CatalogueOpenCoordinatorService implements OnDestroy {

  private readonly coordinator: CatalogueOpenCoordinator;
  private ipcDisposers: (() => void)[] = [];

  constructor(private readonly electronService: ElectronService) {
    this.coordinator = new CatalogueOpenCoordinator({
      acknowledgeExternalRequest: (): void => {
        this.electronService.ipcRenderer.send('catalogue-open-request-consumed');
      },
      loadCatalogue: (fullPath, currentCatalogue, intent): void => {
        this.electronService.ipcRenderer.send(
          'load-this-vha-file',
          fullPath,
          currentCatalogue,
          intent,
        );
      },
      markRendererStartupComplete: (): void => {
        this.electronService.ipcRenderer.send('renderer-startup-complete');
      },
    });
  }

  connect(hooks: CatalogueOpenCoordinatorHooks): void {
    this.disconnect();
    this.coordinator.connect(hooks);
    this.ipcDisposers = [
      this.electronService.ipcRenderer.on(
        'open-catalogue-from-system',
        (_event, fullPath: string) => this.requestOpen(fullPath, true),
      ),
      this.electronService.ipcRenderer.on(
        'catalogue-open-request-finished',
        () => this.finishOpen(),
      ),
    ];
  }

  disconnect(): void {
    this.ipcDisposers.forEach((dispose: () => void) => dispose());
    this.ipcDisposers = [];
    this.coordinator.disconnect();
  }

  finishOpen(): void {
    this.coordinator.finishOpen();
  }

  markRendererStartupComplete(): void {
    this.coordinator.markRendererStartupComplete();
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  requestOpen(fullPath: string, acknowledgeExternalRequest = false): void {
    this.coordinator.requestOpen(fullPath, acknowledgeExternalRequest);
  }

  setBackupNoticeOpen(open: boolean): void {
    this.coordinator.setBackupNoticeOpen(open);
  }
}
