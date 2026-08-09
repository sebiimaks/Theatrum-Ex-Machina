import { Component, HostListener, input } from '@angular/core';
import { ShortcutsService, CustomShortcutAction } from './shortcuts.service';
import type { SettingsButtonKey } from '../../common/settings-buttons';

@Component({
  standalone: false,
  selector: 'app-shortcuts',
  templateUrl: './shortcuts.component.html',
  styleUrls: ['./shortcuts.component.scss']
})
export class ShortcutsComponent {

  readonly macVersion = input<boolean>();

  isReadyToReceiveKey = false;
  shortcutToChange: SettingsButtonKey | CustomShortcutAction;

  @HostListener('window:keydown', ['$event'])
  handleThisEvent(event: KeyboardEvent) {
    if (this.isReadyToReceiveKey) {
      // Prevent Enter or Space from activating the focused shortcut button a
      // second time after it has just been accepted as the new binding.
      event.preventDefault();
      event.stopPropagation();
      this.shortcutService.setNewKeyBinding(event.key, this.shortcutToChange);
      this.isReadyToReceiveKey = false;
      this.shortcutToChange = undefined;
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  // Do not alphabetize!
  shortcutsInOrder: (SettingsButtonKey | CustomShortcutAction)[] = [
    'showThumbnails',    // 1
    'showFilmstrip',     // 2
    'showFullView',      // 3
    'showDetails',       // 4
    'showDetails2',      // 5
    'showFiles',         // 6
    'showClips',         // 7 - space after

    'focusOnFile',       // f
    'focusOnMagic',      // g
    'fuzzySearch',       // r - space after

    'makeSmaller',       // z
    'makeLarger',        // x
    'shuffleGalleryNow', // s - space after

    'toggleSettings',    // o
    'hideSidebar',       // b
    'clearAllFilters',   // 0
    'showTagTray',       // y
    'showAutoTags',      // t - space after

    'showMoreInfo',      // i
    'compactView',       // l
    'toggleMinimalMode', // k
    'darkMode',          // d - space after

    'startWizard',       // n - space after

    // 'quit',           // w - hardcoded in template
    // 'quit',           // q - hardcoded in template
  ];

  readonly shortcutSections: {
    heading: string;
    actions: (SettingsButtonKey | CustomShortcutAction)[];
  }[] = [
    {
      heading: 'Gallery Views',
      actions: this.shortcutsInOrder.slice(0, 7)
    },
    {
      heading: 'Search and Focus',
      actions: this.shortcutsInOrder.slice(7, 10)
    },
    {
      heading: 'Scaling and Order',
      actions: this.shortcutsInOrder.slice(10, 13)
    },
    {
      heading: 'Workspace',
      actions: this.shortcutsInOrder.slice(13, 18)
    },
    {
      heading: 'Layout and Appearance',
      actions: this.shortcutsInOrder.slice(18, 22)
    },
    {
      heading: 'Catalogue',
      actions: this.shortcutsInOrder.slice(22)
    }
  ];

  constructor(
    public shortcutService: ShortcutsService
  ) { }

  changeThisShortcut(shortcutToChange: SettingsButtonKey | CustomShortcutAction): void {
    this.shortcutToChange = shortcutToChange;
    this.isReadyToReceiveKey = true;
  }

}
