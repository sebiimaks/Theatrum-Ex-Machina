import { Component, Input, input, output } from '@angular/core';
import { buttonAnimation } from '../../common/animations';
import type { SettingsButtonsType, SettingsButtonKey } from '../../common/settings-buttons';

@Component({
  standalone: false,
  selector: 'app-ribbon',
  templateUrl: './ribbon.component.html',
  styleUrls: [
    '../buttons.scss',
    './ribbon.component.scss'
  ],
  animations: [buttonAnimation]
})
export class RibbonComponent {

  readonly toggleButton = output<string>();

  readonly appState = input();
  @Input() settingsButtons: SettingsButtonsType;
  readonly settingsButtonsGroups = input<SettingsButtonKey[][]>();

  activeButtonKey: SettingsButtonKey | null = null;
  focusedButtonKey: SettingsButtonKey | null = null;
  hoveredButtonKey: SettingsButtonKey | null = null;

  constructor() { }

  clearFocusedButtonLabel(buttonKey: SettingsButtonKey): void {
    if (this.focusedButtonKey === buttonKey) {
      this.focusedButtonKey = null;

      if (this.activeButtonKey === buttonKey) {
        this.activeButtonKey = this.hoveredButtonKey;
      }
    }
  }

  clearHoveredButtonLabel(buttonKey: SettingsButtonKey): void {
    if (this.hoveredButtonKey === buttonKey) {
      this.hoveredButtonKey = null;

      if (this.activeButtonKey === buttonKey) {
        this.activeButtonKey = this.focusedButtonKey;
      }
    }
  }

  showFocusedButtonLabel(buttonKey: SettingsButtonKey, event: FocusEvent): void {
    const target = event.currentTarget as HTMLElement | null;

    if (!target?.matches(':focus-visible')) {
      return;
    }

    this.focusedButtonKey = buttonKey;
    this.activeButtonKey = buttonKey;
  }

  showHoveredButtonLabel(buttonKey: SettingsButtonKey): void {
    this.hoveredButtonKey = buttonKey;
    this.activeButtonKey = buttonKey;
  }

}
