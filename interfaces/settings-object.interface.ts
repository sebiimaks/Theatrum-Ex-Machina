import type { AppStateInterface } from '../src/app/common/app-state';
import type { CustomShortcutAction } from '../src/app/components/shortcuts/shortcuts.service';
import type { SettingsButtonKey } from '../src/app/common/settings-buttons';
import type { HistoryItem } from './shared-interfaces';
import type { WizardOptions } from './wizard-options.interface';

export interface SettingsButtonSavedProperties {
  hidden: boolean;
  toggled: boolean;
}

export const CURRENT_SETTINGS_SCHEMA_VERSION = 1;

export function shouldRevealCompactCleanNameToolbar(settingsSchemaVersion: unknown): boolean {
  return typeof settingsSchemaVersion !== 'number'
    || !Number.isFinite(settingsSchemaVersion)
    || settingsSchemaVersion < CURRENT_SETTINGS_SCHEMA_VERSION;
}

export interface SettingsObject {
  appState: AppStateInterface;
  buttonSettings: Record<SettingsButtonKey, SettingsButtonSavedProperties>;
  settingsSchemaVersion?: number;
  shortcuts: Map<string, SettingsButtonKey | CustomShortcutAction>;
  vhaFileHistory: HistoryItem[];
  wizardOptions: WizardOptions;
}
