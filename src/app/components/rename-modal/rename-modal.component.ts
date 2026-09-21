import { Component, input, output, viewChild } from '@angular/core';

import { RenameFileComponent } from '../rename-file/rename-file.component';

import type { BehaviorSubject } from 'rxjs';

import type { AppStateInterface } from '../../common/app-state';
import type { ImageElement } from '../../../../interfaces/final-object.interface';
import type { RenameFileResponse } from '../../../../interfaces/shared-interfaces';
import type { SettingsButtonsType } from '../../common/settings-buttons';

@Component({
  standalone: false,
  selector: 'app-rename-modal',
  templateUrl: './rename-modal.component.html',
  styleUrls: [
    '../buttons.scss',  // only for `close-modal-icon` class
    '../settings.scss', // only for `close-settings` class
    './rename-modal.component.scss'
  ]
})
export class RenameModalComponent {

  readonly closeRename = output<void>();
  readonly renameFile = viewChild(RenameFileComponent);

  readonly appState = input<AppStateInterface>();
  readonly basePath = input<string>();
  readonly currentRightClickedItem = input<ImageElement>();
  readonly macVersion = input<boolean>();
  readonly settingsButtons = input<SettingsButtonsType>();

  readonly renameResponse = input<BehaviorSubject<RenameFileResponse>>();

  requestClose(): void {
    if (!this.renameFile()?.nodeRenamingFile) {
      this.closeRename.emit();
    }
  }

  constructor() { }

}
