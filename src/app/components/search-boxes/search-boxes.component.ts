import { Component, input, output } from '@angular/core';
import { filterItemAppear } from '../../common/animations';

import type { SettingsButtonsType } from '../../common/settings-buttons';
import type { FilterObject } from '../../common/filters';

interface FilterEmit {
  word: string;
  index: number;
}

@Component({
  standalone: false,
  selector: 'app-search-boxes',
  templateUrl: './search-boxes.component.html',
  styleUrls: [
      '../search.scss',
      '../search-input.scss',
      './search-boxes.component.scss'
    ],
  animations: [filterItemAppear]
})
export class SearchBoxesComponent {

  readonly checkTagTypeahead = output<string>();
  readonly onBackspace = output<FilterEmit>();
  readonly onEnterKey = output<FilterEmit>();
  readonly removeThisFilter = output<{ item: number; origin: number; }>();
  readonly typeaheadTabPressed = output<number>();

  readonly filters = input<FilterObject[]>();

  readonly settingsButtons = input<SettingsButtonsType>();

  readonly tagTypeAhead = input<string>('');

  constructor() { }

  /**
   * Choose readable text for the configured filter-chip background.
   */
  getContrastColor(hexColor: string): string {
    if (!hexColor) {
      return 'black';
    }

    const hex = hexColor.replace('#', '');
    if (hex.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(hex)) {
      return 'black';
    }

    const red = parseInt(hex.substring(0, 2), 16);
    const green = parseInt(hex.substring(2, 4), 16);
    const blue = parseInt(hex.substring(4, 6), 16);
    const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

    return luminance > 0.5 ? 'black' : 'white';
  }

  /**
   * If is tag search & user wrote text & type ahead is recommended, insert full typeahead
   * @param event
   * @param isTagSearch
   * @param filterIndex
   * @param currentText
   */
  handleTabPress(event: KeyboardEvent, isTagSearch: boolean, filterIndex: number, currentText: string): void {
    if (isTagSearch && currentText !== '' && this.tagTypeAhead() !== '') {
      event.preventDefault();
      this.typeaheadTabPressed.emit(filterIndex);
    }
  }

  /**
   * If is tag search, get new typeahead
   * @param currentText
   * @param isTagSearch
   */
  handleInputChange(currentText: string, isTagSearch: boolean): void {
    if (isTagSearch) {
      this.checkTagTypeahead.emit(currentText);
    }
  }

  isManualTagSearch(uniqueKey: string): boolean {
    return uniqueKey === 'tagUnion'
      || uniqueKey === 'tagIntersection'
      || uniqueKey === 'tagExclusion';
  }

}
