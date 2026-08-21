import { Component, Input, input, output, viewChild } from '@angular/core';

import { TranslateService } from '@ngx-translate/core';

import { ElectronService } from './../../providers/electron.service';
import { ModalService } from './../modal/modal.service';

import { SettingsMetaGroupLabels, SettingsSections } from '../../common/settings-buttons';

import type { OnChanges, SimpleChanges } from '@angular/core';
import type { OnInit } from '@angular/core';
import type { SettingsButtonsType } from '../../common/settings-buttons';

@Component({
  standalone: false,
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  styleUrls: [
    '../buttons.scss',
    '../settings.scss',
    '../search-input.scss',
    './settings.component.scss'
  ]
})
export class SettingsComponent implements OnInit, OnChanges {

  readonly changeLanguage = output<string>();
  readonly chooseDefaultVideoPlayer = output<any>();
  readonly decreaseZoomLevel = output<any>();
  readonly increaseZoomLevel = output<any>();
  readonly resetZoomLevel = output<any>();
  readonly scrollSettingsToTop = output<void>();
  readonly toggleButton = output<string>();
  readonly toggleHideButton = output<string>();

  @Input() appState;
  readonly settingTabToShow = input();
  @Input() settingsButtons: SettingsButtonsType;
  readonly versionNumber = input();

  readonly settingsModal = viewChild('settingsModal');

  additionalInput = '';
  editAdditional = false;
  settingsMetaGroupLabels = SettingsMetaGroupLabels;
  settingsSections = SettingsSections;

  constructor(
    private electronService: ElectronService,
    private modalService: ModalService,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.additionalInput = this.appState.addtionalExtensions;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.settingTabToShow) {
      this.scrollSettingsToTop.emit();
    }
  }

  editAdditionalExtensions() {
    this.editAdditional = !this.editAdditional;
    this.additionalInput = this.appState.addtionalExtensions;
  }

  applyAdditionalExtensions() {
    if (this.isAdditionalInputValid(this.additionalInput)) {
      this.appState.addtionalExtensions = this.additionalInput;
      this.electronService.ipcRenderer.send('update-additional-extensions', this.additionalInput);
      this.editAdditional = false;
    } else {
      this.modalService.openSnackbar(this.translate.instant('SETTINGS.extensionsInputError'));
    }
  }

  formatSectionIndex(index: number): string {
    return String(index + 1).padStart(2, '0');
  }

  openExternalLink(event: MouseEvent, url: string): void {
    event.preventDefault();
    this.electronService.ipcRenderer.send('please-open-url', url);
  }

  private isAdditionalInputValid(input: string): boolean {
    let valid = true;
    input.split(',').forEach(element => {
      if (/[^A-Za-z0-9]/.test(element.trim())) {
        valid = false;
      }
    });

    return valid;
  }

}
