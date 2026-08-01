import type { OnChanges, SimpleChanges } from '@angular/core';
import { Component, ElementRef, EventEmitter, Input, Output, QueryList, ViewChildren } from '@angular/core';

import type { ImageElement, StarRating } from '../../../../interfaces/final-object.interface';
import { formatDateAddedForInput, parseDateAddedInput } from '../../../../interfaces/date-added';
import { ImageElementService } from '../../services/image-element.service';
import { ModalService } from '../modal/modal.service';
import { ManualTagsService } from '../tags-manual/manual-tags.service';
import {
  applyCatalogueOverwrite,
  catalogueOverwriteFieldLabels,
  filterCatalogueEntries,
  validateCatalogueOverwrite,
} from './catalogue-editor.logic';
import type {
  CatalogueOverwriteField,
  CatalogueSearchCriterion,
} from './catalogue-editor.logic';

interface StarOption {
  label: string;
  value: StarRating;
}

interface OverwriteFieldOption {
  label: string;
  value: CatalogueOverwriteField;
}

@Component({
  standalone: false,
  selector: 'app-catalogue-editor',
  templateUrl: './catalogue-editor.component.html',
  styleUrls: ['./catalogue-editor.component.scss']
})
export class CatalogueEditorComponent implements OnChanges {

  @ViewChildren('searchCriterionInput')
  private searchCriterionInputs: QueryList<ElementRef<HTMLInputElement>>;

  @Input() currentVhaFile = '';
  @Input() darkMode = false;
  @Input() images: ImageElement[] = [];
  @Input() isSaving = false;
  @Input() saveStatus = '';

  @Output() closeEditor = new EventEmitter<void>();
  @Output() entriesChanged = new EventEmitter<void>();
  @Output() saveRequested = new EventEmitter<void>();

  filteredEntries: ImageElement[] = [];
  batchOverwriteDraft = '';
  batchOverwriteField: CatalogueOverwriteField | '' = '';
  batchOverwriteStatus = '';
  batchTagDraft = '';
  batchTagStatus = '';
  batchTagTypeahead = '';
  hashCopyFailedIndex: number | undefined;
  hashCopiedIndex: number | undefined;
  searchRowsStatus = '';
  searchCriteria: CatalogueSearchCriterion[] = [
    { field: 'all', id: 0, operator: 'contains', query: '' },
  ];
  showDeleted = false;

  readonly overwriteFieldOptions: OverwriteFieldOption[] = [
    { label: 'Clean Name', value: 'cleanName' },
    { label: 'Date Added', value: 'dateAdded' },
    { label: 'Stars', value: 'stars' },
    { label: 'Year', value: 'year' },
    { label: 'Times Played', value: 'timesPlayed' },
    { label: 'Default Screen', value: 'defaultScreen' },
    { label: 'Notes', value: 'notes' },
  ];

  readonly starOptions: StarOption[] = [
    { label: 'N/A', value: 0.5 },
    { label: '1', value: 1.5 },
    { label: '2', value: 2.5 },
    { label: '3', value: 3.5 },
    { label: '4', value: 4.5 },
    { label: '5', value: 5.5 },
  ];

  private tagDrafts: { [index: number]: string } = {};
  private tagTypeaheads: { [index: number]: string } = {};
  private dateAddedErrors = new WeakMap<ImageElement, string>();
  private nextSearchCriterionId = 1;

  constructor(
    public imageElementService: ImageElementService,
    public manualTagsService: ManualTagsService,
    private modalService: ModalService,
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.images) {
      this.refreshFilteredEntries();
    }
  }

  get activeCount(): number {
    return this.images.filter((element: ImageElement) => !element.deleted).length;
  }

  get batchAutocompleteDraft(): string {
    return this.getAutocompleteDraft(this.batchTagDraft, this.batchTagTypeahead);
  }

  get canApplyBatchTags(): boolean {
    return this.filteredEntries.length > 0 && this.parseTags(this.batchTagDraft).length > 0;
  }

  get canRequestBatchOverwrite(): boolean {
    return Boolean(this.batchOverwriteField) && this.filteredEntries.length > 0;
  }

  get batchOverwritePlaceholder(): string {
    if (this.batchOverwriteField === 'dateAdded') {
      return 'New local date and time, or leave blank to clear';
    }

    if (this.batchOverwriteField === 'year' || this.batchOverwriteField === 'defaultScreen') {
      return 'New value, or leave blank to clear';
    }

    if (this.batchOverwriteField === 'notes') {
      return 'New notes, or leave blank to clear';
    }

    return this.batchOverwriteField ? 'New value' : 'Select a field first';
  }

  get batchOverwriteUsesNumericInput(): boolean {
    return this.batchOverwriteField === 'year'
      || this.batchOverwriteField === 'timesPlayed'
      || this.batchOverwriteField === 'defaultScreen';
  }

  get batchOverwriteUsesDateInput(): boolean {
    return this.batchOverwriteField === 'dateAdded';
  }

  get deletedCount(): number {
    return this.images.filter((element: ImageElement) => element.deleted).length;
  }

  get totalCount(): number {
    return this.images.length;
  }

  addSearchCriterion(): void {
    const criterionId = this.nextSearchCriterionId++;

    this.searchCriteria.push({
      field: 'all',
      id: criterionId,
      operator: 'contains',
      query: '',
    });
    this.searchRowsStatus = `Search line ${this.searchCriteria.length} added. All completed search lines must match.`;

    setTimeout(() => this.focusSearchCriterion(criterionId), 0);
  }

  close(): void {
    if (this.isSaving) {
      return;
    }

    this.commitAllTagDrafts();
    this.closeEditor.emit();
  }

  async copyHash(item: ImageElement): Promise<void> {
    const hash = item.hash || '';

    if (!hash) {
      return;
    }

    this.hashCopiedIndex = undefined;
    this.hashCopyFailedIndex = undefined;

    try {
      await navigator.clipboard.writeText(hash);
      this.hashCopiedIndex = item.index;
    } catch {
      try {
        window.require('electron').clipboard.writeText(hash);
        this.hashCopiedIndex = item.index;
      } catch {
        this.hashCopyFailedIndex = item.index;
      }
    }
  }

  hashCopyButtonText(item: ImageElement): string {
    if (this.hashCopiedIndex === item.index) {
      return 'Copied';
    }

    if (this.hashCopyFailedIndex === item.index) {
      return 'Copy failed';
    }

    return 'Copy';
  }

  acceptBatchTagTypeahead(event: KeyboardEvent): void {
    if (!this.batchTagTypeahead) {
      return;
    }

    event.preventDefault();
    this.batchTagDraft = this.completeTagDraft(this.batchTagDraft, this.batchTagTypeahead);
    this.batchTagTypeahead = '';
  }

  acceptTagTypeahead(item: ImageElement, event: KeyboardEvent): void {
    const typeahead = this.tagTypeaheads[item.index];

    if (!typeahead) {
      return;
    }

    event.preventDefault();
    this.tagDrafts[item.index] = this.completeTagDraft(this.tagDraftFor(item), typeahead);
    this.tagTypeaheads[item.index] = '';
  }

  applyBatchTags(): void {
    const targetEntries = this.filteredEntries.slice();

    if (!targetEntries.length || !this.batchTagDraft.trim()) {
      return;
    }

    // Commit open row edits first so a later blur or save cannot overwrite batch additions.
    this.commitAllTagDrafts();

    const tagsToAdd = this.parseTags(this.batchTagDraft);
    if (!tagsToAdd.length) {
      return;
    }

    let updatedEntryCount = 0;

    targetEntries.forEach((item: ImageElement) => {
      const currentTags = item.tags || [];
      const nextTags = currentTags.slice();

      tagsToAdd.forEach((tag: string) => {
        const tagAlreadyPresent = nextTags.some(
          (existingTag: string) => existingTag.toLowerCase() === tag.toLowerCase()
        );

        if (!tagAlreadyPresent) {
          nextTags.push(tag);
        }
      });

      if (this.tagsMatch(currentTags, nextTags)) {
        return;
      }

      item.tags = nextTags;
      this.tagDrafts[item.index] = this.tagsToString(item);
      this.tagTypeaheads[item.index] = '';
      updatedEntryCount++;
    });

    this.batchTagDraft = '';
    this.batchTagTypeahead = '';

    if (updatedEntryCount === 0) {
      this.batchTagStatus = 'All displayed entries already have these tags.';
      return;
    }

    const entryLabel = updatedEntryCount === 1 ? 'entry' : 'entries';
    this.batchTagStatus = `Updated ${updatedEntryCount} displayed ${entryLabel}.`;
    this.markDirty(true);
    this.refreshFilteredEntries();
  }

  requestBatchOverwrite(): void {
    const field = this.batchOverwriteField;
    const overwriteDraft = this.batchOverwriteDraft;
    const targetEntries = this.filteredEntries.slice();

    if (!field || targetEntries.length === 0) {
      return;
    }

    const validation = validateCatalogueOverwrite(field, overwriteDraft, targetEntries);

    if (!validation.valid) {
      this.batchOverwriteStatus = validation.error || 'Enter a valid value.';
      return;
    }

    const fieldLabel = catalogueOverwriteFieldLabels[field];
    const entryCount = targetEntries.length;
    const entryLabel = entryCount === 1 ? 'entry' : 'entries';
    const clearingField = validation.action === 'clear';
    const title = clearingField
      ? `Clear ${fieldLabel} for Displayed Results?`
      : `Overwrite ${fieldLabel} for Displayed Results?`;
    const displayValuePreview = this.getOverwriteConfirmationPreview(validation.displayValue);
    const content = clearingField
      ? `Clear '${fieldLabel}' from all ${entryCount} currently displayed ${entryLabel}? Existing values in this field will be removed.`
      : `Set '${fieldLabel}' to '${displayValuePreview}' for all ${entryCount} currently displayed ${entryLabel}? Existing values in this field will be replaced.`;
    const confirmLabel = clearingField
      ? `Clear ${entryCount} ${entryLabel}`
      : `Overwrite ${entryCount} ${entryLabel}`;

    this.modalService.openConfirmationDialog(
      title,
      content,
      confirmLabel,
      'Cancel',
    ).subscribe((confirmed: boolean) => {
      if (!confirmed) {
        return;
      }

      const targetsStillCurrent = targetEntries.every((item: ImageElement) => this.images.includes(item));

      if (!targetsStillCurrent) {
        this.batchOverwriteStatus = 'Displayed results changed while confirmation was open. Review the results and try again.';
        this.refreshFilteredEntries();
        return;
      }

      const confirmedValidation = validateCatalogueOverwrite(field, overwriteDraft, targetEntries);

      if (!confirmedValidation.valid) {
        this.batchOverwriteStatus = confirmedValidation.error
          ? `Displayed results changed: ${confirmedValidation.error}`
          : 'Displayed results changed. Review the results and try again.';
        this.refreshFilteredEntries();
        return;
      }

      // Commit open tag edits so a later blur or save cannot restore stale row data.
      this.commitAllTagDrafts();

      const updatedEntryCount = applyCatalogueOverwrite(targetEntries, field, confirmedValidation.value);

      if (updatedEntryCount === 0) {
        this.batchOverwriteStatus = clearingField
          ? `The displayed entries already have no ${fieldLabel} value.`
          : `All displayed entries already have this ${fieldLabel} value.`;
        return;
      }

      if (field === 'stars') {
        this.imageElementService.forceStarFilterUpdate = !this.imageElementService.forceStarFilterUpdate;
      }

      const updatedEntryLabel = updatedEntryCount === 1 ? 'entry' : 'entries';
      this.batchOverwriteStatus = clearingField
        ? `Cleared ${fieldLabel} from ${updatedEntryCount} displayed ${updatedEntryLabel}.`
        : `Updated ${fieldLabel} for ${updatedEntryCount} displayed ${updatedEntryLabel}.`;
      this.markDirty();
      this.refreshFilteredEntries();
    });
  }

  deleteEntry(item: ImageElement): void {
    this.commitTags(item);
    item.deleted = true;
    this.markDirty(true);
    this.refreshFilteredEntries();
  }

  restoreEntry(item: ImageElement): void {
    item.deleted = false;
    this.markDirty(true);
    this.refreshFilteredEntries();
  }

  refreshFilteredEntries(): void {
    this.filteredEntries = filterCatalogueEntries(
      this.images,
      this.searchCriteria,
      this.showDeleted,
    );
  }

  removeSearchCriterion(criterionId: number): void {
    if (this.searchCriteria.length === 1) {
      return;
    }

    const removedCriterionIndex = this.searchCriteria.findIndex(
      (criterion: CatalogueSearchCriterion) => criterion.id === criterionId
    );
    const remainingCriteria = this.searchCriteria.filter(
      (criterion: CatalogueSearchCriterion) => criterion.id !== criterionId
    );
    const focusIndex = Math.min(
      Math.max(removedCriterionIndex, 0),
      remainingCriteria.length - 1,
    );

    this.searchCriteria = remainingCriteria;
    this.searchRowsStatus = `Search line removed. ${remainingCriteria.length} search ${remainingCriteria.length === 1 ? 'line remains' : 'lines remain'}.`;
    this.refreshFilteredEntries();

    setTimeout(() => this.focusSearchCriterion(remainingCriteria[focusIndex].id), 0);
  }

  requestSave(): void {
    this.commitAllTagDrafts();
    this.saveRequested.emit();
  }

  tagDraftFor(item: ImageElement): string {
    if (this.tagDrafts[item.index] === undefined) {
      this.tagDrafts[item.index] = this.tagsToString(item);
    }

    return this.tagDrafts[item.index];
  }

  tagAutocompleteDraftFor(item: ImageElement): string {
    return this.getAutocompleteDraft(
      this.tagDraftFor(item),
      this.tagTypeaheads[item.index] || ''
    );
  }

  tagTypeaheadFor(item: ImageElement): string {
    return this.tagTypeaheads[item.index] || '';
  }

  trackByImageIndex(index: number, item: ImageElement): number {
    return item.index === undefined ? index : item.index;
  }

  trackBySearchCriterionId(index: number, criterion: CatalogueSearchCriterion): number {
    return criterion.id === undefined ? index : criterion.id;
  }

  updateBatchOverwriteDraft(value: string): void {
    this.batchOverwriteDraft = value;
    this.batchOverwriteStatus = '';
  }

  updateBatchOverwriteField(field: CatalogueOverwriteField | ''): void {
    this.batchOverwriteField = field;
    this.batchOverwriteDraft = field === 'stars' ? '0.5' : '';
    this.batchOverwriteStatus = '';
  }

  updateDefaultScreen(item: ImageElement, value: string | number): void {
    const parsed = this.toOptionalInteger(value);

    if (parsed === undefined) {
      if (item.defaultScreen !== undefined) {
        delete item.defaultScreen;
        this.markDirty();
      }
      return;
    }

    if (item.defaultScreen !== parsed) {
      item.defaultScreen = parsed;
      this.markDirty();
    }
  }

  dateAddedInputValue(item: ImageElement): string {
    return formatDateAddedForInput(item.dateAdded);
  }

  dateAddedErrorFor(item: ImageElement): string {
    return this.dateAddedErrors.get(item) || '';
  }

  updateDateAdded(item: ImageElement, value: string, input?: HTMLInputElement): void {
    const parsed = parseDateAddedInput(value);

    if (parsed === null) {
      this.dateAddedErrors.set(item, 'Enter a valid local date and time.');
      if (input) {
        input.value = formatDateAddedForInput(item.dateAdded);
      }
      return;
    }

    this.dateAddedErrors.delete(item);

    if (parsed === undefined) {
      if (item.dateAdded !== undefined) {
        delete item.dateAdded;
        this.markDirty();
      }
      return;
    }

    if (item.dateAdded !== parsed) {
      item.dateAdded = parsed;
      this.markDirty();
    }
  }

  updateNotes(item: ImageElement, value: string): void {
    if (value) {
      if (item.notes !== value) {
        item.notes = value;
        this.markDirty();
      }
    } else if (item.notes !== undefined) {
      delete item.notes;
      this.markDirty();
    }
  }

  updateNumberField(item: ImageElement, field: 'timesPlayed', value: string | number): void {
    const parsed = Math.max(0, this.toOptionalInteger(value) || 0);

    if (item[field] !== parsed) {
      item[field] = parsed;
      this.markDirty();
    }
  }

  updateStar(item: ImageElement, value: StarRating): void {
    if (item.stars !== value) {
      item.stars = value;
      this.imageElementService.forceStarFilterUpdate = !this.imageElementService.forceStarFilterUpdate;
      this.markDirty();
    }
  }

  updateStringField(item: ImageElement, field: 'cleanName' | 'fileName' | 'partialPath', value: string): void {
    const nextValue = value || '';

    if (item[field] !== nextValue) {
      item[field] = nextValue;
      this.markDirty();
      this.refreshFilteredEntries();
    }
  }

  updateTagDraft(item: ImageElement, value: string): void {
    this.tagDrafts[item.index] = value;
    this.tagTypeaheads[item.index] = this.getTagTypeahead(value);
  }

  updateBatchTagDraft(value: string): void {
    this.batchTagDraft = value;
    this.batchTagTypeahead = this.getTagTypeahead(value);
    this.batchTagStatus = '';
  }

  updateYear(item: ImageElement, value: string | number): void {
    const parsed = this.toOptionalInteger(value);

    if (parsed === undefined) {
      if (item.year !== undefined) {
        delete item.year;
        this.markDirty();
      }
      return;
    }

    if (item.year !== parsed) {
      item.year = parsed;
      this.markDirty();
    }
  }

  private commitAllTagDrafts(): void {
    Object.keys(this.tagDrafts).forEach((indexString: string) => {
      const itemIndex = parseInt(indexString, 10);
      const item = this.images.find((element: ImageElement) => element.index === itemIndex);

      if (item) {
        this.commitTags(item);
      }
    });
  }

  commitTags(item: ImageElement): void {
    const currentTags = item.tags || [];
    const nextTags = this.parseTags(this.tagDrafts[item.index] || '');

    this.tagDrafts[item.index] = nextTags.join(', ');
    this.tagTypeaheads[item.index] = '';

    if (this.tagsMatch(currentTags, nextTags)) {
      return;
    }

    if (nextTags.length) {
      item.tags = nextTags;
    } else {
      delete item.tags;
    }

    this.markDirty(true);
    this.refreshFilteredEntries();
  }

  private completeTagDraft(tagText: string, typeahead: string): string {
    const lastCommaIndex = tagText.lastIndexOf(',');
    const completedDraft = lastCommaIndex === -1
      ? typeahead
      : `${tagText.slice(0, lastCommaIndex)}, ${typeahead}`;

    return this.parseTags(completedDraft).join(', ');
  }

  private getActiveTagFragment(tagText: string): string {
    return tagText.slice(tagText.lastIndexOf(',') + 1).trim();
  }

  private getAutocompleteDraft(tagText: string, typeahead: string): string {
    if (!typeahead) {
      return '';
    }

    const activeFragment = this.getActiveTagFragment(tagText);
    return tagText + typeahead.slice(activeFragment.length);
  }

  private focusSearchCriterion(criterionId: number): void {
    const input = this.searchCriterionInputs
      ?.toArray()
      .find((element: ElementRef<HTMLInputElement>) => (
        Number(element.nativeElement.dataset.searchCriterionId) === criterionId
      ));

    input?.nativeElement.focus();
  }

  private getOverwriteConfirmationPreview(value: string): string {
    const normalizedValue = value.replace(/\s+/g, ' ').trim();

    return normalizedValue.length > 160
      ? `${normalizedValue.slice(0, 159)}…`
      : normalizedValue;
  }

  private markDirty(rebuildTags = false): void {
    this.imageElementService.finalArrayNeedsSaving = true;

    if (rebuildTags) {
      this.manualTagsService.removeAllTags();
      this.manualTagsService.populateManualTagsService(
        this.images.filter((element: ImageElement) => !element.deleted)
      );
    }

    this.entriesChanged.emit();
  }

  private parseTags(tagText: string): string[] {
    const seen = new Set<string>();
    const knownTags = new Map<string, string>();

    this.manualTagsService.tagsList.forEach((tag: string) => {
      knownTags.set(tag.toLowerCase(), tag);
    });

    return tagText
      .split(',')
      .map((tag: string) => tag.trim())
      .map((tag: string) => knownTags.get(tag.toLowerCase()) || tag)
      .filter((tag: string) => {
        const key = tag.toLowerCase();

        if (!tag || seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });
  }

  private getTagTypeahead(tagText: string): string {
    const activeFragment = this.getActiveTagFragment(tagText);

    if (!activeFragment) {
      return '';
    }

    const typeahead = this.manualTagsService.getTypeahead(activeFragment);
    return typeahead === activeFragment ? '' : typeahead;
  }

  private tagsMatch(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((tag: string, index: number) => tag === right[index]);
  }

  private tagsToString(item: ImageElement): string {
    return (item.tags || []).join(', ');
  }

  private toOptionalInteger(value: string | number): number | undefined {
    if (value === '' || value === null || value === undefined) {
      return undefined;
    }

    const parsed = Math.floor(Number(value));

    return Number.isFinite(parsed) ? parsed : undefined;
  }

}
