import { Component, Input, input, output, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import { ManualTagsService } from './manual-tags.service';

import type { Tag, TagEmit } from '../../../../interfaces/shared-interfaces';

@Component({
  standalone: false,
  selector: 'app-view-tags-component',
  templateUrl: 'view-tags.component.html',
  styleUrls: ['../search.scss',
              'view-tags.component.scss',
              '../../fonts/icons.scss']
})
export class ViewTagsComponent {

  _tags: Tag[];
  allowTagRemovalValue = false;
  tagsAreStrings = false;
  toogleBatchModeValue: boolean = false;

  @Input()
  set tags(tags: Tag[] | string[]) {
    if (!tags || tags.length === 0) {
      this.tagsAreStrings = false;
      this._tags = [];
    } else if ((typeof tags[0]) === 'string') {
      this.tagsAreStrings = true;
      this._tags = this.stringToTagObject(<string[]>tags); // happens only in tag tray
    } else {
      this.tagsAreStrings = false;
      this._tags = <Tag[]>tags; // happens in details & meta view
    }
  }

  //set the removable property of the selected tag based on the batchmode is enabled or disabled
  @Input()
  set tagsOnToggleBatch(toggleBatchMode: boolean) {
    this.toogleBatchModeValue = toggleBatchMode;
    this.updateRemovability();
  }

  @Input()
  set allowTagRemoval(allowTagRemoval: boolean) {
    this.allowTagRemovalValue = allowTagRemoval;
    this.updateRemovability();
  }

  readonly darkMode = input<boolean>();
  readonly displayFrequency = input<boolean>();
  readonly draggable = input<boolean>();
  readonly enableColorPicker = input<boolean>(false);

  readonly removeTagEmit = output<string>();
  readonly tagClicked = output<TagEmit>();
  readonly tagRightClick = output<{ tag: Tag; event: PointerEvent; }>();

  readonly dragHack = viewChild<ElementRef>('dragHack');

  constructor(
    public tagService: ManualTagsService,
    private translate: TranslateService,
  ) { }

  getAutoMatchDescription(tag: Tag): string | null {
    if (tag.autoFileMatch && tag.autoFolderMatch) {
      return this.translate.instant('TAGS.manualTagAutoFileAndFolderMatch');
    }
    if (tag.autoFileMatch) {
      return this.translate.instant('TAGS.manualTagAutoFileMatch');
    }
    if (tag.autoFolderMatch) {
      return this.translate.instant('TAGS.manualTagAutoFolderMatch');
    }
    return null;
  }

  getTagAriaLabel(tag: Tag): string {
    const autoMatchDescription = this.getAutoMatchDescription(tag);
    const pathDescription = tag.colourPath && tag.colourPath !== tag.name
      ? `${tag.displayName || tag.name}. ${tag.colourPath}`
      : tag.displayName || tag.name;
    return autoMatchDescription
      ? `${pathDescription}. ${autoMatchDescription}`
      : pathDescription;
  }

  getTagTitle(tag: Tag): string | null {
    const details: string[] = [];
    if (tag.colourPath && tag.colourPath !== tag.name) {
      details.push(tag.colourPath);
    }
    const autoMatchDescription = this.getAutoMatchDescription(tag);
    if (autoMatchDescription) {
      details.push(autoMatchDescription);
    }
    return details.length ? details.join(' — ') : null;
  }

  /**
   * Emit to parent component a tag has been clicked
   */
  tagClick(tag: Tag, event: PointerEvent): void {
    this.tagClicked.emit({ tag, event });
  }

  /**
   * Emit to parent component that a tag should be removed
   */
  removeTag(tag: string): void {
    this.removeTagEmit.emit(tag);
  }

  /**
   * Create tag objects from a string[]
   */
  stringToTagObject(tagList: string[]): Tag[] {
    const hackList: Tag[] = [];

    tagList.forEach((tag) => {
      hackList.push({
        name: tag,
        removable: this.allowTagRemovalValue || this.toogleBatchModeValue,
        colour: this.tagService.getTagColor(tag),
      });
    });

    return hackList;
  }

  private updateRemovability(): void {
    if (!this.tagsAreStrings || !this._tags) {
      return;
    }

    const removable = this.allowTagRemovalValue || this.toogleBatchModeValue;
    this._tags.forEach((item) => {
      item.removable = removable;
    });
  }

  /**
   * Set the dataTransfer with the current tag - to drop over video
   * @param event - DragEvent
   */
  tagDragStart(event: DragEvent, tag: Tag): void {
    if (!event.dataTransfer) {
      return;
    }

    event.dataTransfer.setData('text/plain', tag.name);

    const quickHack: HTMLElement = this.dragHack().nativeElement;

    quickHack.innerText = tag.name;
    quickHack.style.backgroundColor = tag.colour ? tag.colour : "#f5f5f5";

    event.dataTransfer.setDragImage(quickHack, event.offsetX * 1.5, 21);
  }

  /**
   * Handle right-click on tag - emit to parent to handle color picker
   * @param event - PointerEvent
   * @param tag - Tag
   */
  onTagRightClick(event: PointerEvent, tag: Tag): void {
    if (!this.enableColorPicker()) {
      return;
    }

    // Only allow color picking for manual (removable) tags
    if (!tag.removable) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    // Emit to parent component to handle color picker
    this.tagRightClick.emit({ tag, event });
  }

  /**
   * Calculate contrast color (white or black) based on background color luminance
   * @param hexColor - Hex color code (e.g., '#FF6B6B')
   * @returns 'white' or 'black' for optimal contrast
   */
  getContrastColor(hexColor: string): string {
    if (!hexColor) {
      return 'black';
    }

    // Remove # if present
    const hex = hexColor.replace('#', '');

    // Validate hex format (must be 6 characters)
    if (hex.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(hex)) {
      return 'black';
    }

    // Convert to RGB
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    // Calculate relative luminance using WCAG formula
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    // Return white for dark backgrounds, black for light backgrounds
    return luminance > 0.5 ? 'black' : 'white';
  }

}
