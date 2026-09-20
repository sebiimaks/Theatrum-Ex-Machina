import { Component, Input, input, output } from '@angular/core';

import { TranslateService } from '@ngx-translate/core';

import { ElectronService } from './../../providers/electron.service';
import { ModalService } from './../modal/modal.service';

import {
  getSettingsWorkspaceSections,
  SettingsActionKeys,
  SettingsDestructiveKeys,
  SettingsViewKeys,
  SettingsWorkspaceCategories,
} from '../../common/settings-workspace';

import type { OnChanges, SimpleChanges } from '@angular/core';
import type { OnInit } from '@angular/core';
import type { SettingsButtonKey, SettingsButtonsType } from '../../common/settings-buttons';
import type { SettingsCategoryId, SettingsWorkspaceResult } from '../../common/settings-workspace';

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
  readonly settingCategory = input<SettingsCategoryId>('appearance');
  readonly searchQuery = input('');
  readonly hasExternalSearchResults = input(false);
  @Input() settingsButtons: SettingsButtonsType;
  readonly versionNumber = input();

  additionalInput = '';
  editAdditional = false;

  readonly languages = [
    ['en', 'English'], ['ar', 'العربية'], ['bn', 'বাংলা'], ['zh', '中文'],
    ['cs', 'Česky'], ['nl', 'Nederlands'], ['fr', 'Française'], ['de', 'Deutsch'],
    ['hi', 'हिंदी'], ['it', 'Italiana'], ['ja', '日本語'], ['ko', '한국어'],
    ['ms', 'Melayu'], ['pl', 'Polski'], ['pt', 'Português'], ['ru', 'Русский'],
    ['es', 'Español'], ['tr', 'Türkçe'], ['uk', 'Українська'], ['vi', 'Tiếng Việt'],
  ];

  constructor(
    private electronService: ElectronService,
    private modalService: ModalService,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.additionalInput = this.appState.addtionalExtensions;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.settingCategory || changes.searchQuery) {
      this.scrollSettingsToTop.emit();
    }
  }

  get currentCategory() {
    return SettingsWorkspaceCategories.find((category) => category.id === this.settingCategory())
      || SettingsWorkspaceCategories[0];
  }

  get visibleSections(): SettingsWorkspaceResult[] {
    return getSettingsWorkspaceSections(
      this.settingCategory(), this.searchQuery(), this.settingsButtons,
      (key) => this.translate.instant(key),
    );
  }

  isAction(key: SettingsButtonKey): boolean {
    return SettingsActionKeys.includes(key);
  }

  isView(key: SettingsButtonKey): boolean {
    return SettingsViewKeys.includes(key);
  }

  isDestructive(key: SettingsButtonKey): boolean {
    return SettingsDestructiveKeys.includes(key);
  }

  settingActionLabel(key: SettingsButtonKey): string {
    if (key === 'makeSmaller') { return 'WORKBENCH.decrease'; }
    if (key === 'makeLarger') { return 'WORKBENCH.increase'; }
    if (key === 'showTags') { return 'WORKBENCH.open'; }
    if (key === 'startWizard') { return 'WORKBENCH.create'; }
    if (key === 'playPlaylist') { return 'WORKBENCH.play'; }
    if (key === 'shuffleGalleryNow') { return 'WORKBENCH.shuffle'; }
    if (key === 'clearHistory' || key === 'clearAllFilters') { return 'WORKBENCH.clear'; }
    if (key === 'resetSettings' || key === 'resetTimesPlayed') { return 'WORKBENCH.reset'; }
    return 'WORKBENCH.runAction';
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
