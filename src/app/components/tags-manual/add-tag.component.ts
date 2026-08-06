import { Component, input, output } from '@angular/core';

import { ManualTagsService } from './manual-tags.service';

@Component({
  standalone: false,
  selector: 'app-add-tag-component',
  templateUrl: 'add-tag.component.html',
  styleUrls: ['../search-input.scss',
              'add-tag.component.scss']
})
export class AddTagComponent {

  readonly darkMode = input<boolean>();

  readonly tag = output<string>();

  currentText = '';
  tagValidationError = '';
  typeAhead = '';

  constructor(
    public manualTagsService: ManualTagsService
  ) { }

  emitTag(text: string): void {
    if (typeof text !== 'string' || !text.trim()) {
      return;
    }

    try {
      const normalizedTag = this.manualTagsService.normalizeTagInput(text);
      if (normalizedTag) {
        this.tag.emit(normalizedTag);
        this.tagValidationError = '';
        this.currentText = '';
        this.typeAhead = '';
      }
    } catch (error) {
      this.tagValidationError = error instanceof Error ? error.message : 'Tag is invalid.';
      this.typeAhead = '';
    }
  }

  checkTypeahead(text: string): void {
    this.tagValidationError = '';
    this.typeAhead = this.manualTagsService.getTypeahead(text);
  }

  tabPressed(keypress: KeyboardEvent): void {
    if (this.typeAhead !== '') {
      this.emitTag(this.typeAhead);
      keypress.preventDefault();
    }
  }

  /**
   * User pressed the `esc` key
   */
  escape(): void {
    this.currentText = '';
    this.tagValidationError = '';
    this.typeAhead = '';
  }

}
