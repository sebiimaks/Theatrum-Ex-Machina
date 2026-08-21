import type { OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { Component, ElementRef, EventEmitter, Input, Output, QueryList, ViewChildren } from '@angular/core';

import type { ImageElement, StarRating } from '../../../../interfaces/final-object.interface';
import { formatDateAddedForInput, parseDateAddedInput } from '../../../../interfaces/date-added';
import { tagIdentityKey } from '../../../../interfaces/tag-hierarchy';
import {
  normalizeImageLocation,
  updatePreferredImageLocationFields,
} from '../../../../interfaces/media-locations';
import {
  applyCatalogueMetadataImportPlan,
  buildCatalogueMetadataImportPlan,
  catalogueMetadataCategories,
  catalogueMetadataCategoryLabels,
  createCatalogueMetadataExport,
  isCatalogueMetadataImportTarget,
} from '../../../../interfaces/catalogue-metadata-transfer';
import type {
  CatalogueMetadataCategory,
  CatalogueMetadataImportPlan,
  CatalogueMetadataUpdate,
} from '../../../../interfaces/catalogue-metadata-transfer';
import { ElectronService } from '../../providers/electron.service';
import { ImageElementService } from '../../services/image-element.service';
import { ModalService } from '../modal/modal.service';
import { ManualTagsService } from '../tags-manual/manual-tags.service';
import {
  applyCatalogueOverwrite,
  catalogueOverwriteFieldLabels,
  filterCatalogueEntries,
  resolveMetadataImportSaveNotice,
  validateCatalogueOverwrite,
} from './catalogue-editor.logic';
import type {
  CatalogueAvailabilityFilter,
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

interface MetadataFileResult {
  contents?: string;
  error?: string;
  fileName?: string;
  status: 'cancelled' | 'error' | 'success';
}

interface MetadataChangePreview {
  category: CatalogueMetadataCategory;
  fullValue: string;
  label: string;
  value: string;
}

interface TagDraftParseResult {
  error?: string;
  tags: string[];
}

type CatalogueLocationField = 'fileName' | 'partialPath';

@Component({
  standalone: false,
  selector: 'app-catalogue-editor',
  templateUrl: './catalogue-editor.component.html',
  styleUrls: ['./catalogue-editor.component.scss']
})
export class CatalogueEditorComponent implements OnChanges, OnDestroy {

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
  availabilityFilter: CatalogueAvailabilityFilter = 'all';
  batchOverwriteDraft = '';
  batchOverwriteField: CatalogueOverwriteField | '' = '';
  batchOverwriteStatus = '';
  batchTagDraft = '';
  batchTagStatus = '';
  batchTagTypeahead = '';
  hashCopyFailedIndex: number | undefined;
  hashCopiedIndex: number | undefined;
  metadataImportFileName = '';
  metadataImportPlan: CatalogueMetadataImportPlan | undefined;
  metadataImportSelection: Record<CatalogueMetadataCategory, boolean> = {
    dateAdded: true,
    notes: true,
    stars: true,
    tags: true,
    timesPlayed: true,
    year: true,
  };
  metadataTransferBusy = false;
  metadataTransferError = false;
  metadataTransferStatus = '';
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

  readonly metadataCategoryOptions = catalogueMetadataCategories.map((value: CatalogueMetadataCategory) => ({
    label: catalogueMetadataCategoryLabels[value],
    value,
  }));

  readonly starOptions: StarOption[] = [
    { label: 'N/A', value: 0.5 },
    { label: '1', value: 1.5 },
    { label: '2', value: 2.5 },
    { label: '3', value: 3.5 },
    { label: '4', value: 4.5 },
    { label: '5', value: 5.5 },
  ];

  private tagDrafts: { [index: number]: string } = {};
  private tagValidationErrors: { [index: number]: string } = {};
  private tagTypeaheads: { [index: number]: string } = {};
  private dateAddedErrors = new WeakMap<ImageElement, string>();
  private locationFieldErrors = new WeakMap<
    ImageElement,
    Partial<Record<CatalogueLocationField, string>>
  >();
  private destroyed = false;
  private metadataImportJson = '';
  private metadataImportPreviews = new WeakMap<ImageElement, MetadataChangePreview[]>();
  private metadataImportResultSummary = '';
  private metadataImportSaveNoticeActive = false;
  private metadataImportScope: ImageElement[] = [];
  private metadataImportUpdates = new WeakMap<ImageElement, CatalogueMetadataUpdate>();
  private nextSearchCriterionId = 1;

  constructor(
    private electronService: ElectronService,
    public imageElementService: ImageElementService,
    public manualTagsService: ManualTagsService,
    private modalService: ModalService,
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.images) {
      const importScopeIsCurrent = this.metadataImportScope.every(
        (item: ImageElement) => this.images.includes(item)
      );
      if (this.metadataImportFileName && !importScopeIsCurrent) {
        this.clearPendingMetadataImport();
        this.setMetadataTransferStatus(
          'The catalogue entries changed while metadata import was pending. Select the metadata file again to create a current filtered scope.',
          true,
        );
      } else {
        this.refreshFilteredEntries();
      }
    }
    if (changes.saveStatus) {
      this.handleMetadataImportSaveStatus(changes.saveStatus.currentValue);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
  }

  get activeCount(): number {
    return this.images.filter((element: ImageElement) => !element.deleted && !element.missing).length;
  }

  get batchAutocompleteDraft(): string {
    return this.getAutocompleteDraft(this.batchTagDraft, this.batchTagTypeahead);
  }

  get canApplyBatchTags(): boolean {
    const parsed = this.parseTagDraft(this.batchTagDraft);
    return this.filteredEntries.length > 0 && !parsed.error && parsed.tags.length > 0;
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

  get missingCount(): number {
    return this.images.filter((element: ImageElement) => !element.deleted && element.missing).length;
  }

  get selectedMetadataCategories(): CatalogueMetadataCategory[] {
    return catalogueMetadataCategories.filter((category: CatalogueMetadataCategory) => (
      this.metadataImportSelection[category]
    ));
  }

  get metadataImportPreviewActive(): boolean {
    return Boolean(this.metadataImportPlan);
  }

  get metadataImportScopeCount(): number {
    return this.metadataImportScope.length;
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
    if (this.isSaving || this.metadataTransferBusy) {
      return;
    }

    if (!this.commitAllTagDrafts()) {
      this.setMetadataTransferStatus(
        'The editor remains open because one or more tag fields contain an invalid path. Clear the search filters to reveal and correct the highlighted field.',
        true,
      );
      return;
    }
    this.closeEditor.emit();
  }

  async exportMetadata(): Promise<void> {
    if (this.metadataTransferBusy || this.isSaving) {
      return;
    }

    if (!this.commitAllTagDrafts()) {
      this.setMetadataTransferStatus('Correct invalid tag paths before exporting metadata.', true);
      return;
    }
    let exportResult: ReturnType<typeof createCatalogueMetadataExport>;
    try {
      exportResult = createCatalogueMetadataExport(this.images);
    } catch (error) {
      this.setMetadataTransferStatus(this.transferErrorMessage(error, 'Metadata export failed.'), true);
      return;
    }
    if (exportResult.document.entries.length === 0) {
      this.setMetadataTransferStatus(
        'No active video has a unique hash, so there is no metadata that can be exported safely.',
        true,
      );
      return;
    }
    this.metadataTransferBusy = true;
    this.setMetadataTransferStatus('Choose where to save the metadata export.');

    try {
      const result = await this.electronService.ipcRenderer.invoke(
        'export-catalogue-metadata',
        exportResult.document,
      ) as MetadataFileResult;

      if (this.destroyed) {
        return;
      }

      if (result.status === 'cancelled') {
        this.setMetadataTransferStatus('Metadata export cancelled.');
        return;
      }
      if (result.status !== 'success') {
        this.setMetadataTransferStatus(result.error || 'Metadata export failed.', true);
        return;
      }

      const skipped: string[] = [];
      if (exportResult.missingHashEntryCount) {
        skipped.push(`${exportResult.missingHashEntryCount} without a hash`);
      }
      if (exportResult.ambiguousHashEntryCount) {
        skipped.push(`${exportResult.ambiguousHashEntryCount} with a duplicated hash`);
      }
      if (exportResult.deletedEntryCount) {
        skipped.push(`${exportResult.deletedEntryCount} pending deletion`);
      }
      const skippedSummary = skipped.length ? ` Skipped ${skipped.join(' and ')}.` : '';
      this.setMetadataTransferStatus(
        `Exported ${exportResult.document.entries.length} metadata ${exportResult.document.entries.length === 1 ? 'entry' : 'entries'} to '${result.fileName}'.${skippedSummary}`,
      );
    } catch (error) {
      if (!this.destroyed) {
        this.setMetadataTransferStatus(this.transferErrorMessage(error, 'Metadata export failed.'), true);
      }
    } finally {
      if (!this.destroyed) {
        this.metadataTransferBusy = false;
      }
    }
  }

  async chooseMetadataImport(): Promise<void> {
    if (this.metadataTransferBusy || this.isSaving) {
      return;
    }

    if (!this.commitAllTagDrafts()) {
      this.setMetadataTransferStatus('Correct invalid tag paths before importing metadata.', true);
      return;
    }
    this.clearPendingMetadataImport();
    const cataloguePath = this.currentVhaFile;
    const filteredImportScope = this.filteredEntries.filter(isCatalogueMetadataImportTarget);
    if (filteredImportScope.length === 0) {
      this.setMetadataTransferStatus(
        'No active video entries with a usable hash are displayed by the current filters. Adjust or clear the filters before importing metadata.',
        true,
      );
      return;
    }

    this.metadataTransferBusy = true;
    this.setMetadataTransferStatus('Choose a metadata JSON file to import.');

    try {
      const result = await this.electronService.ipcRenderer.invoke('import-catalogue-metadata') as MetadataFileResult;

      if (this.destroyed) {
        return;
      }

      if (result.status === 'cancelled') {
        this.setMetadataTransferStatus('Metadata import cancelled.');
        return;
      }
      if (result.status !== 'success' || typeof result.contents !== 'string') {
        this.setMetadataTransferStatus(result.error || 'Metadata import failed.', true);
        return;
      }
      if (this.currentVhaFile !== cataloguePath) {
        this.setMetadataTransferStatus(
          'The open catalogue changed while the metadata file was being selected. Select the file again in the intended catalogue.',
          true,
        );
        return;
      }

      this.metadataImportFileName = result.fileName || 'Selected metadata file';
      this.metadataImportJson = result.contents;
      this.metadataImportScope = filteredImportScope;
      this.selectAllMetadataCategories();
      this.refreshMetadataImportPlan();
    } catch (error) {
      if (!this.destroyed) {
        this.setMetadataTransferStatus(this.transferErrorMessage(error, 'Metadata import failed.'), true);
      }
    } finally {
      if (!this.destroyed) {
        this.metadataTransferBusy = false;
      }
    }
  }

  cancelMetadataImport(): void {
    this.clearPendingMetadataImport();
    this.setMetadataTransferStatus('Metadata import cancelled.');
  }

  clearMetadataCategories(): void {
    catalogueMetadataCategories.forEach((category: CatalogueMetadataCategory) => {
      this.metadataImportSelection[category] = false;
    });
    this.invalidateMetadataImportPlan();
  }

  selectAllMetadataCategories(): void {
    catalogueMetadataCategories.forEach((category: CatalogueMetadataCategory) => {
      this.metadataImportSelection[category] = true;
    });
    this.invalidateMetadataImportPlan();
  }

  toggleMetadataCategory(category: CatalogueMetadataCategory, checked: boolean): void {
    this.metadataImportSelection[category] = checked;
    this.invalidateMetadataImportPlan();
  }

  previewMetadataImport(): void {
    if (this.metadataTransferBusy || !this.metadataImportJson) {
      return;
    }

    if (!this.commitAllTagDrafts()) {
      this.setMetadataTransferStatus('Correct invalid tag paths before previewing metadata.', true);
      return;
    }
    this.refreshMetadataImportPlan();
  }

  requestMetadataImport(): void {
    if (this.metadataTransferBusy || !this.metadataImportJson) {
      return;
    }

    const categories = this.selectedMetadataCategories;
    const cataloguePath = this.currentVhaFile;
    const reviewedPlan = this.metadataImportPlan;
    let plan: CatalogueMetadataImportPlan;
    try {
      if (!this.commitAllTagDrafts()) {
        this.setMetadataTransferStatus('Correct invalid tag paths before importing metadata.', true);
        return;
      }
      plan = buildCatalogueMetadataImportPlan(
        this.images,
        this.metadataImportJson,
        categories,
        this.metadataImportScope,
      );
      this.setMetadataImportPlan(plan);
    } catch (error) {
      this.clearMetadataImportPreview();
      this.setMetadataTransferStatus(this.transferErrorMessage(error, 'The metadata file cannot be imported.'), true);
      return;
    }

    if (!reviewedPlan || !this.metadataImportPlansMatch(reviewedPlan, plan)) {
      this.setMetadataTransferStatus(
        'The catalogue changed after the metadata preview was prepared. The preview has been refreshed; review the highlighted changes and apply again.',
      );
      return;
    }

    if (plan.changedEntryCount === 0) {
      const message = plan.matchedRecordCount
        ? `No selected metadata values would change. ${plan.matchedRecordCount} ${plan.matchedRecordCount === 1 ? 'record matches' : 'records match'} this catalogue.`
        : 'No metadata records match a unique, active catalogue hash.';
      this.setMetadataTransferStatus(message);
      return;
    }

    const categoryNames = categories.map((category: CatalogueMetadataCategory) => (
      catalogueMetadataCategoryLabels[category]
    ));
    const categorySummary = categoryNames.join(', ');
    const entryLabel = plan.changedEntryCount === 1 ? 'entry' : 'entries';
    const fieldLabel = plan.changedFieldCount === 1 ? 'value' : 'values';
    const skippedCount = plan.unmatchedRecordCount
      + plan.missingHashRecordCount
      + plan.duplicateHashRecordCount
      + plan.ambiguousCatalogueRecordCount;
    this.metadataTransferBusy = true;
    this.modalService.openConfirmationDialog({
      cancelLabel: 'Cancel',
      confirmLabel: `Import into ${plan.changedEntryCount} ${entryLabel}`,
      facts: [
        { label: 'Categories', value: categorySummary },
        { label: 'Imported records skipped', value: skippedCount },
        { label: 'Matches outside displayed results', value: plan.outsideScopeRecordCount },
        { label: 'Matching method', value: 'File hash only' },
      ],
      summary: `${plan.changedFieldCount} selected metadata ${fieldLabel} across ${plan.changedEntryCount} displayed ${entryLabel} will be replaced.`,
      supportingText: 'Only the currently displayed results are in scope. Filenames are reference-only and are never used for matching.',
      title: 'Import Selected Metadata?',
      tone: 'warning',
    }).subscribe((confirmed: boolean) => {
      if (this.destroyed) {
        return;
      }
      if (this.currentVhaFile !== cataloguePath) {
        this.metadataTransferBusy = false;
        this.setMetadataTransferStatus(
          'The open catalogue changed before the metadata import was confirmed. No metadata was imported.',
          true,
        );
        return;
      }
      if (!confirmed) {
        this.metadataTransferBusy = false;
        this.setMetadataTransferStatus('Metadata import cancelled.');
        return;
      }

      try {
        if (!this.commitAllTagDrafts()) {
          this.setMetadataTransferStatus('Correct invalid tag paths before importing metadata.', true);
          return;
        }
        if (this.currentVhaFile !== cataloguePath) {
          this.setMetadataTransferStatus(
            'The open catalogue changed before the metadata import was applied. No metadata was imported.',
            true,
          );
          return;
        }
        const confirmedPlan = buildCatalogueMetadataImportPlan(
          this.images,
          this.metadataImportJson,
          categories,
          this.metadataImportScope,
        );
        if (!this.metadataImportPlansMatch(plan, confirmedPlan)) {
          this.setMetadataImportPlan(confirmedPlan);
          this.setMetadataTransferStatus(
            'The catalogue changed while confirmation was open. Nothing was imported. Review the refreshed preview and apply again.',
          );
          return;
        }
        const result = applyCatalogueMetadataImportPlan(confirmedPlan);

        this.tagDrafts = {};
        this.tagTypeaheads = {};
        if (result.starsChanged) {
          this.imageElementService.forceStarFilterUpdate = !this.imageElementService.forceStarFilterUpdate;
        }
        if (result.updatedEntryCount > 0) {
          this.markDirty(result.tagsChanged);
          this.refreshFilteredEntries();
        }

        const importedFileName = this.metadataImportFileName;
        this.clearPendingMetadataImport();
        this.metadataImportResultSummary = `Imported ${result.updatedFieldCount} metadata ${result.updatedFieldCount === 1 ? 'value' : 'values'} into ${result.updatedEntryCount} ${result.updatedEntryCount === 1 ? 'entry' : 'entries'} from '${importedFileName}'`;
        this.setMetadataTransferStatus(
          `${this.metadataImportResultSummary}. Changes are not saved yet.`,
          false,
          true,
        );
      } catch (error) {
        this.setMetadataTransferStatus(this.transferErrorMessage(error, 'Metadata import failed.'), true);
      } finally {
        if (!this.destroyed) {
          this.metadataTransferBusy = false;
        }
      }
    });
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
    if (!this.commitAllTagDrafts()) {
      this.batchTagStatus = 'Correct invalid tag paths in the displayed entries before applying batch tags.';
      return;
    }

    const parsedBatchTags = this.parseTagDraft(this.batchTagDraft);
    if (parsedBatchTags.error) {
      this.batchTagStatus = parsedBatchTags.error;
      return;
    }
    const tagsToAdd = parsedBatchTags.tags;
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
    const entryPossessive = entryCount === 1 ? 'its' : 'their';
    const clearingField = validation.action === 'clear';
    const title = clearingField
      ? `Clear ${fieldLabel} for Displayed Results?`
      : `Overwrite ${fieldLabel} for Displayed Results?`;
    const displayValuePreview = this.getOverwriteConfirmationPreview(validation.displayValue);
    const confirmLabel = clearingField
      ? `Clear ${entryCount} ${entryLabel}`
      : `Overwrite ${entryCount} ${entryLabel}`;

    this.modalService.openConfirmationDialog({
      cancelLabel: 'Cancel',
      confirmLabel,
      facts: [
        { label: 'Displayed entries', value: entryCount },
        { label: 'Field', value: fieldLabel },
        { label: clearingField ? 'Action' : 'New value', value: clearingField ? 'Clear field' : displayValuePreview },
      ],
      summary: clearingField
        ? `${entryCount} displayed ${entryLabel} will have ${entryPossessive} ${fieldLabel} value cleared.`
        : `${entryCount} displayed ${entryLabel} will have ${entryPossessive} ${fieldLabel} value overwritten.`,
      supportingText: clearingField
        ? 'Existing values in this field will be removed.'
        : 'Existing values in this field will be replaced.',
      title,
      tone: clearingField ? 'destructive' : 'warning',
      transition: {
        from: fieldLabel,
        fromLabel: 'Field',
        to: clearingField ? 'Cleared' : displayValuePreview,
        toLabel: clearingField ? 'Action' : 'New value',
      },
    }).subscribe((confirmed: boolean) => {
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
      if (!this.commitAllTagDrafts()) {
        this.batchOverwriteStatus = 'Correct invalid tag paths before overwriting displayed results.';
        return;
      }

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
    if (!this.commitTags(item)) {
      return;
    }
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
    if (this.metadataImportPlan) {
      this.filteredEntries = this.metadataImportPlan.changes.map(change => change.target);
      return;
    }
    if (this.metadataImportFileName) {
      this.filteredEntries = [];
      return;
    }

    this.filteredEntries = filterCatalogueEntries(
      this.images,
      this.searchCriteria,
      this.showDeleted,
      this.availabilityFilter,
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
    if (!this.commitAllTagDrafts()) {
      this.setMetadataTransferStatus(
        'The catalogue was not saved because one or more tag fields contain an invalid path. Clear the search filters to reveal and correct the highlighted field.',
        true,
      );
      return;
    }
    this.saveRequested.emit();
  }

  metadataChangesFor(item: ImageElement): MetadataChangePreview[] {
    return this.metadataImportPreviews.get(item) || [];
  }

  metadataFieldWillChange(item: ImageElement, category: CatalogueMetadataCategory): boolean {
    const updates = this.metadataImportUpdates.get(item);
    return Boolean(updates && Object.prototype.hasOwnProperty.call(updates, category));
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

  tagValidationErrorFor(item: ImageElement): string {
    return this.tagValidationErrors[item.index] || '';
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

  locationFieldErrorFor(item: ImageElement, field: CatalogueLocationField): string {
    return this.locationFieldErrors.get(item)?.[field] || '';
  }

  updateStringField(item: ImageElement, field: 'cleanName' | CatalogueLocationField, value: string): void {
    const nextValue = value || '';

    if (field === 'cleanName') {
      if (item.cleanName !== nextValue) {
        item.cleanName = nextValue;
        this.markDirty();
        this.refreshFilteredEntries();
      }
      return;
    }

    let normalizedValue: string;
    try {
      const normalizedLocation = normalizeImageLocation({
        fileName: field === 'fileName' ? nextValue : item.fileName,
        inputSource: item.inputSource,
        partialPath: field === 'partialPath' ? nextValue : item.partialPath,
      });
      normalizedValue = normalizedLocation[field];
      this.clearLocationFieldError(item, field);
    } catch {
      this.setLocationFieldError(
        item,
        field,
        field === 'fileName'
          ? 'Enter a file name without folder separators.'
          : 'Enter a folder inside the configured video location.',
      );
      return;
    }

    if (item[field] === normalizedValue) {
      return;
    }

    try {
      if (item.locations !== undefined) {
        updatePreferredImageLocationFields(item, { [field]: normalizedValue });
      } else {
        item[field] = normalizedValue;
      }
    } catch {
      this.setLocationFieldError(item, field, 'This media location cannot be updated safely.');
      return;
    }

    this.clearLocationFieldError(item, field);
    this.markDirty();
    this.refreshFilteredEntries();
  }

  private clearLocationFieldError(item: ImageElement, field: CatalogueLocationField): void {
    const current = this.locationFieldErrors.get(item);
    if (!current) {
      return;
    }
    delete current[field];
    if (Object.keys(current).length === 0) {
      this.locationFieldErrors.delete(item);
    }
  }

  private setLocationFieldError(
    item: ImageElement,
    field: CatalogueLocationField,
    message: string,
  ): void {
    const current = this.locationFieldErrors.get(item) || {};
    current[field] = message;
    this.locationFieldErrors.set(item, current);
  }

  updateTagDraft(item: ImageElement, value: string): void {
    this.tagDrafts[item.index] = value;
    delete this.tagValidationErrors[item.index];
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

  private commitAllTagDrafts(): boolean {
    let valid = true;
    Object.keys(this.tagDrafts).forEach((indexString: string) => {
      const itemIndex = parseInt(indexString, 10);
      const item = this.images.find((element: ImageElement) => element.index === itemIndex);

      if (item && !this.commitTags(item)) {
        valid = false;
      }
    });
    return valid;
  }

  commitTags(item: ImageElement): boolean {
    const currentTags = item.tags || [];
    const parsed = this.parseTagDraft(this.tagDrafts[item.index] || '');
    if (parsed.error) {
      this.tagValidationErrors[item.index] = parsed.error;
      this.tagTypeaheads[item.index] = '';
      return false;
    }
    const nextTags = parsed.tags;

    this.tagDrafts[item.index] = nextTags.join(', ');
    delete this.tagValidationErrors[item.index];
    this.tagTypeaheads[item.index] = '';

    if (this.tagsMatch(currentTags, nextTags)) {
      return true;
    }

    if (nextTags.length) {
      item.tags = nextTags;
    } else {
      delete item.tags;
    }

    this.markDirty(true);
    this.refreshFilteredEntries();
    return true;
  }

  private completeTagDraft(tagText: string, typeahead: string): string {
    const lastCommaIndex = tagText.lastIndexOf(',');
    const completedDraft = lastCommaIndex === -1
      ? typeahead
      : `${tagText.slice(0, lastCommaIndex)}, ${typeahead}`;

    const parsed = this.parseTagDraft(completedDraft);
    return parsed.error ? tagText : parsed.tags.join(', ');
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

  private clearPendingMetadataImport(): void {
    this.metadataImportFileName = '';
    this.metadataImportJson = '';
    this.metadataImportScope = [];
    this.clearMetadataImportPreview();
  }

  private clearMetadataImportPreview(): void {
    this.metadataImportPlan = undefined;
    this.metadataImportPreviews = new WeakMap<ImageElement, MetadataChangePreview[]>();
    this.metadataImportUpdates = new WeakMap<ImageElement, CatalogueMetadataUpdate>();
    this.refreshFilteredEntries();
  }

  private invalidateMetadataImportPlan(): void {
    this.clearMetadataImportPreview();
    if (this.metadataImportJson) {
      this.setMetadataTransferStatus(
        `Category selection changed for '${this.metadataImportFileName}'. Select Preview Selected Metadata to recalculate the changes.`,
      );
    }
  }

  private refreshMetadataImportPlan(): void {
    if (!this.metadataImportJson) {
      this.metadataImportPlan = undefined;
      return;
    }

    try {
      const plan = buildCatalogueMetadataImportPlan(
        this.images,
        this.metadataImportJson,
        this.selectedMetadataCategories,
        this.metadataImportScope,
      );
      this.setMetadataImportPlan(plan);
      const previewSummary = plan.changedEntryCount
        ? `Previewing ${plan.changedFieldCount} metadata ${plan.changedFieldCount === 1 ? 'change' : 'changes'} across ${plan.changedEntryCount} of ${this.metadataImportScope.length} filtered ${this.metadataImportScope.length === 1 ? 'entry' : 'entries'} from '${this.metadataImportFileName}'. Review the highlighted fields before applying.`
        : `No selected metadata values from '${this.metadataImportFileName}' would change the ${this.metadataImportScope.length} filtered ${this.metadataImportScope.length === 1 ? 'entry' : 'entries'}.`;
      this.setMetadataTransferStatus(previewSummary);
    } catch (error) {
      this.clearMetadataImportPreview();
      this.setMetadataTransferStatus(this.transferErrorMessage(error, 'The metadata file cannot be imported.'), true);
    }
  }

  private setMetadataImportPlan(plan: CatalogueMetadataImportPlan): void {
    this.metadataImportPlan = plan;
    this.metadataImportPreviews = new WeakMap<ImageElement, MetadataChangePreview[]>();
    this.metadataImportUpdates = new WeakMap<ImageElement, CatalogueMetadataUpdate>();

    plan.changes.forEach(change => {
      this.metadataImportUpdates.set(change.target, change.updates);
      const previews = plan.categories
        .filter(category => Object.prototype.hasOwnProperty.call(change.updates, category))
        .map(category => this.createMetadataChangePreview(category, change.updates));
      this.metadataImportPreviews.set(change.target, previews);
    });

    this.refreshFilteredEntries();
  }

  private createMetadataChangePreview(
    category: CatalogueMetadataCategory,
    updates: CatalogueMetadataUpdate,
  ): MetadataChangePreview {
    const incoming = (updates as Record<string, unknown>)[category];
    let fullValue: string;

    if (incoming === null) {
      fullValue = category === 'tags' ? 'Clear all tags' : 'Clear current value';
    } else if (category === 'stars') {
      fullValue = Number(incoming) === 0.5 ? 'N/A' : String(Number(incoming) - 0.5);
    } else if (category === 'dateAdded') {
      fullValue = new Date(Number(incoming)).toLocaleString();
    } else if (category === 'tags') {
      const tags = incoming as string[];
      fullValue = tags.length ? tags.join(', ') : 'Clear all tags';
    } else {
      fullValue = String(incoming);
    }

    const singleLineValue = fullValue.replace(/\s+/g, ' ').trim();
    const value = singleLineValue.length > 160
      ? `${singleLineValue.slice(0, 159)}…`
      : singleLineValue;

    return {
      category,
      fullValue,
      label: catalogueMetadataCategoryLabels[category],
      value,
    };
  }

  private metadataImportPlansMatch(
    left: CatalogueMetadataImportPlan,
    right: CatalogueMetadataImportPlan,
  ): boolean {
    if (
      left.ambiguousCatalogueRecordCount !== right.ambiguousCatalogueRecordCount
      || left.changedEntryCount !== right.changedEntryCount
      || left.changedFieldCount !== right.changedFieldCount
      || left.duplicateHashRecordCount !== right.duplicateHashRecordCount
      || left.entriesRead !== right.entriesRead
      || left.matchedRecordCount !== right.matchedRecordCount
      || left.missingHashRecordCount !== right.missingHashRecordCount
      || left.outsideScopeRecordCount !== right.outsideScopeRecordCount
      || left.unmatchedRecordCount !== right.unmatchedRecordCount
      || left.categories.join('|') !== right.categories.join('|')
      || left.changes.length !== right.changes.length
    ) {
      return false;
    }

    return left.changes.every((change, index) => (
      change.target === right.changes[index].target
      && JSON.stringify(change.updates) === JSON.stringify(right.changes[index].updates)
    ));
  }

  private handleMetadataImportSaveStatus(saveStatus: unknown): void {
    if (!this.metadataImportSaveNoticeActive) {
      return;
    }

    const notice = resolveMetadataImportSaveNotice(saveStatus, this.metadataImportResultSummary);
    if (notice) {
      this.setMetadataTransferStatus(notice.message, notice.error, !notice.complete);
    }
  }

  private setMetadataTransferStatus(message: string, error = false, tracksUnsavedImport = false): void {
    this.metadataTransferError = error;
    this.metadataTransferStatus = message;
    this.metadataImportSaveNoticeActive = tracksUnsavedImport;
  }

  private transferErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  private parseTagDraft(tagText: string): TagDraftParseResult {
    const seen = new Set<string>();
    const tags: string[] = [];

    for (const draftTag of tagText.split(',')) {
      const trimmed = draftTag.trim();
      if (!trimmed) {
        continue;
      }

      let normalized: string;
      try {
        normalized = this.manualTagsService.normalizeTagInput(trimmed);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'Tag is invalid.',
          tags: [],
        };
      }

      const key = tagIdentityKey(normalized);
      if (!seen.has(key)) {
        seen.add(key);
        tags.push(normalized);
      }
    }

    return { tags };
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
