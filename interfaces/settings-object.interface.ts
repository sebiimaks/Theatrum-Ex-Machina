import type { AppStateInterface } from '../src/app/common/app-state';
import type { CustomShortcutAction } from '../src/app/components/shortcuts/shortcuts.service';
import type { SettingsButtonKey } from '../src/app/common/settings-buttons';
import type { HistoryItem } from './shared-interfaces';
import type { WizardOptions } from './wizard-options.interface';

export interface SettingsButtonSavedProperties {
  hidden: boolean;
  toggled: boolean;
}

export interface SettingsObject {
  appState: AppStateInterface;
  buttonSettings: Record<SettingsButtonKey, SettingsButtonSavedProperties>;
  shortcuts: Map<string, SettingsButtonKey | CustomShortcutAction>;
  vhaFileHistory: HistoryItem[];
  wizardOptions: WizardOptions;
}
