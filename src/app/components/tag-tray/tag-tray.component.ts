import { Component, effect, HostListener, input, output } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import {
  buildTagHierarchy,
  filterTagHierarchy,
  getTagAncestorPaths,
  isTagInBranch,
  parseStoredTagPath,
  planTagBranchColourMove,
  planTagDefinitionBranchMove,
  planTagBranchMove,
  planTagBranchRemoval,
  remapTagBranchPath,
  resolveTagBranchMoveDestination,
  sortTagHierarchy,
  TAG_PATH_SEPARATOR,
  tagPathsEqual,
  tagRemovalRequiresConfirmation,
  validateAndNormalizeNewTagPath,
} from '../../../../interfaces/tag-hierarchy';
import type {
  TagBranchColourMovePlan,
  TagDefinitionBranchMovePlan,
  TagBranchMovePlan,
  TagBranchRemovalPlan,
  TagHierarchyNode,
  TagHierarchySortMode,
} from '../../../../interfaces/tag-hierarchy';
import type { Tag, TagEmit } from '../../../../interfaces/shared-interfaces';
import type { AppStateInterface } from '../../common/app-state';

import { ImageElementService } from './../../services/image-element.service';
import { ModalService } from '../modal/modal.service';
import { ManualTagsService } from '../tags-manual/manual-tags.service';

import { modalAnimation } from '../../common/animations';

const TAG_BRANCH_DRAG_TYPE = 'application/x-theatrum-tag-branch';
const ROOT_DROP_TARGET = '__theatrum_tag_root__';

export interface TagHierarchyMoveEmission {
  destinationPath: string;
  sourcePath: string;
}

interface TagParentOption {
  label: string;
  path: string;
}

@Component({
  standalone: false,
  selector: 'app-tag-tray',
  templateUrl: './tag-tray.component.html',
  styleUrls: [
    '../layout.scss',
    '../settings.scss',
    '../search-input.scss',
    '../wizard-button.scss',
    './tag-tray.component.scss'
  ],
  animations: [modalAnimation]
})
export class TagTrayComponent {

  readonly toggleBatchTaggingMode = output<void>();
  readonly handleTagWordClicked = output<TagEmit>();
  readonly handleTagBranchClicked = output<TagEmit>();
  readonly selectAll = output<void>();
  readonly selectNone = output<void>();
  readonly tagHierarchyMoved = output<TagHierarchyMoveEmission>();
  readonly tagRemovedGlobally = output<void>();
  readonly closeRequested = output<void>();

  readonly appState = input<AppStateInterface>();
  readonly batchTaggingMode = input();
  readonly darkMode = input<boolean>();
  readonly verticalLayout = input<boolean>(false);
  readonly updateTotalSelectedTrigger = input<number>(0);

  manualTagFilterString = '';
  manualTagShowFrequency = true;
  recomputeTrigger = 0;
  draggedTagPath = '';
  dropTargetPath = '';
  invalidDropTargetPath = '';
  pointerDragActive = false;
  pointerDragCandidatePath = '';
  pointerDragX = 0;
  pointerDragY = 0;
  showAddTagForm = false;
  newTagName = '';
  newTagParentPath = '';
  newTagError = '';

  private pointerDragHandle: HTMLElement | undefined;
  private pointerDragPointerId: number | null = null;
  private pointerDragStartX = 0;
  private pointerDragStartY = 0;
  private pointerDropDestinationPath: string | null | undefined;
  private suppressNextTagClick = false;

  private cachedHierarchy: TagHierarchyNode[] = [];
  private hierarchyCacheInitialized = false;
  private cachedImageElementsReference: unknown;
  private cachedPipeToggleTrigger: boolean | undefined;
  private cachedTagsListLength = -1;
  private cachedDisplayedHierarchy: TagHierarchyNode[] = [];
  private cachedDisplayedSource: TagHierarchyNode[] | undefined;
  private cachedDisplayedFilter = '';
  private cachedDisplayedSortMode: TagHierarchySortMode | undefined;
  private hierarchyExpansionInitialized = false;
  private readonly expandedTagPaths = new Set<string>();

  constructor(
    public manualTagsService: ManualTagsService,
    public imageElementService: ImageElementService,
    private modalService: ModalService,
    private translate: TranslateService,
  ) {
    effect(() => {
      this.recomputeTrigger = this.updateTotalSelectedTrigger();
    });
  }

  get displayedTagHierarchy(): TagHierarchyNode[] {
    const sortMode: TagHierarchySortMode = this.appState().sortTagsByFrequency
      ? 'frequency'
      : 'alphabetical';
    const hierarchy = this.getHierarchy();
    if (
      this.cachedDisplayedSource === hierarchy
      && this.cachedDisplayedFilter === this.manualTagFilterString
      && this.cachedDisplayedSortMode === sortMode
    ) {
      return this.cachedDisplayedHierarchy;
    }

    const filtered = filterTagHierarchy(hierarchy, this.manualTagFilterString);
    this.cachedDisplayedHierarchy = sortTagHierarchy(filtered, sortMode);
    this.cachedDisplayedSource = hierarchy;
    this.cachedDisplayedFilter = this.manualTagFilterString;
    this.cachedDisplayedSortMode = sortMode;
    return this.cachedDisplayedHierarchy;
  }

  get tagFilterActive(): boolean {
    return Boolean(this.manualTagFilterString.trim());
  }

  get tagParentOptions(): TagParentOption[] {
    const options: TagParentOption[] = [];
    const addNodes = (nodes: readonly TagHierarchyNode[], depth: number): void => {
      nodes.forEach((node: TagHierarchyNode) => {
        const parsed = parseStoredTagPath(node.fullPath);
        if (parsed.hierarchical || !node.fullPath.includes('>')) {
          options.push({
            label: `${'— '.repeat(depth)}${node.label}`,
            path: node.fullPath,
          });
          addNodes(node.children, depth + 1);
        }
      });
    };
    addNodes(this.getHierarchy(), 0);
    return options;
  }

  toggleAddTagForm(): void {
    this.showAddTagForm = !this.showAddTagForm;
    this.newTagError = '';
    if (!this.showAddTagForm) {
      this.newTagName = '';
      this.newTagParentPath = '';
    }
  }

  cancelAddTagForm(): void {
    this.showAddTagForm = false;
    this.newTagName = '';
    this.newTagParentPath = '';
    this.newTagError = '';
  }

  createTagDefinition(): void {
    const nameValidation = validateAndNormalizeNewTagPath(this.newTagName);
    if (!nameValidation.valid || !nameValidation.normalized) {
      this.newTagError = nameValidation.error || this.translate.instant('TAGS.tagDefinitionInvalid');
      return;
    }
    if (nameValidation.normalized.includes(TAG_PATH_SEPARATOR)) {
      this.newTagError = this.translate.instant('TAGS.tagDefinitionOneLevel');
      return;
    }

    const candidate = this.newTagParentPath
      ? `${this.newTagParentPath}${TAG_PATH_SEPARATOR}${nameValidation.normalized}`
      : nameValidation.normalized;
    try {
      const addedTag = this.manualTagsService.addTagDefinition(candidate);
      if (!addedTag) {
        this.newTagError = this.translate.instant('TAGS.tagDefinitionExists');
        return;
      }

      getTagAncestorPaths(addedTag, true).forEach((path: string) => {
        this.expandedTagPaths.add(path);
      });
      this.manualTagFilterString = '';
      this.invalidateHierarchy();
      this.cancelAddTagForm();
    } catch (error) {
      this.newTagError = error instanceof Error
        ? error.message
        : this.translate.instant('TAGS.tagDefinitionInvalid');
    }
  }

  selectAllPressed(): void {
    this.recomputeTrigger = Date.now();
    this.selectAll.emit();
  }

  deselectAllPressed(): void {
    this.recomputeTrigger = Date.now();
    this.selectNone.emit();
  }

  toggleBranch(node: TagHierarchyNode): void {
    if (!node.children.length || this.tagFilterActive) {
      return;
    }

    if (this.expandedTagPaths.has(node.fullPath)) {
      this.expandedTagPaths.delete(node.fullPath);
    } else {
      this.expandedTagPaths.add(node.fullPath);
    }
  }

  branchIsExpanded(node: TagHierarchyNode): boolean {
    return this.tagFilterActive || this.expandedTagPaths.has(node.fullPath);
  }

  expandAll(): void {
    this.visitHierarchy(this.getHierarchy(), (node: TagHierarchyNode) => {
      if (node.children.length) {
        this.expandedTagPaths.add(node.fullPath);
      }
    });
  }

  collapseAll(): void {
    this.expandedTagPaths.clear();
  }

  tagClicked(node: TagHierarchyNode, event: PointerEvent): void {
    if (this.suppressNextTagClick) {
      this.suppressNextTagClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const tagValue = this.getExactTagValue(node);
    const tagEvent: TagEmit = {
      event,
      tag: this.toTag(tagValue),
    };

    if (node.children.length && !this.batchTaggingMode()) {
      this.handleTagBranchClicked.emit(tagEvent);
    } else {
      this.handleTagWordClicked.emit(tagEvent);
    }
  }

  tagDragStart(event: DragEvent, node: TagHierarchyNode): void {
    if (!event.dataTransfer) {
      event.preventDefault();
      return;
    }

    const tagValue = this.getExactTagValue(node);
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', tagValue);
    event.dataTransfer.setData('application/x-theatrum-tag', tagValue);
    this.draggedTagPath = node.fullPath;
    this.dropTargetPath = '';
    event.dataTransfer.setData(TAG_BRANCH_DRAG_TYPE, node.fullPath);
  }

  tagDragEnd(): void {
    this.clearTagDragState();
  }

  beginTagPointerDrag(event: PointerEvent, node: TagHierarchyNode): void {
    if (!event.isPrimary || event.button !== 0) {
      return;
    }

    this.clearTagDragState();
    this.pointerDragCandidatePath = node.fullPath;
    this.pointerDragPointerId = event.pointerId;
    this.pointerDragStartX = event.clientX;
    this.pointerDragStartY = event.clientY;
    this.pointerDragX = event.clientX;
    this.pointerDragY = event.clientY;
    this.pointerDragHandle = event.currentTarget as HTMLElement;

    try {
      this.pointerDragHandle.setPointerCapture(event.pointerId);
    } catch {
      // The document-level listeners still complete the drag if capture is unavailable.
    }
  }

  @HostListener('document:pointermove', ['$event'])
  handleTagPointerMove(event: PointerEvent): void {
    if (
      this.pointerDragPointerId !== event.pointerId
      || !this.pointerDragCandidatePath
    ) {
      return;
    }

    this.pointerDragX = event.clientX;
    this.pointerDragY = event.clientY;
    if (!this.pointerDragActive) {
      const distance = Math.hypot(
        event.clientX - this.pointerDragStartX,
        event.clientY - this.pointerDragStartY,
      );
      if (distance < 5) {
        return;
      }
      this.pointerDragActive = true;
      this.draggedTagPath = this.pointerDragCandidatePath;
    }

    event.preventDefault();
    this.updatePointerDropTarget(event.clientX, event.clientY);
  }

  @HostListener('document:pointerup', ['$event'])
  finishTagPointerDrag(event: PointerEvent): void {
    if (this.pointerDragPointerId !== event.pointerId) {
      return;
    }

    if (this.pointerDragActive) {
      event.preventDefault();
      event.stopPropagation();
      this.updatePointerDropTarget(event.clientX, event.clientY);
      this.suppressNextTagClick = true;
      setTimeout(() => {
        this.suppressNextTagClick = false;
      });
    }
    const active = this.pointerDragActive;
    const sourcePath = this.pointerDragCandidatePath;
    const destinationPath = this.pointerDropDestinationPath;
    const invalidDestinationPath = this.invalidDropTargetPath;
    this.clearTagDragState();

    if (!active || !sourcePath) {
      return;
    }
    if (destinationPath !== undefined) {
      this.confirmTagBranchMove(sourcePath, destinationPath);
      return;
    }
    if (invalidDestinationPath) {
      this.showRejectedTagMove(sourcePath, invalidDestinationPath);
    }
  }

  @HostListener('document:pointercancel', ['$event'])
  cancelTagPointerDrag(event: PointerEvent): void {
    if (this.pointerDragPointerId === event.pointerId) {
      this.clearTagDragState();
    }
  }

  @HostListener('document:keydown.escape')
  cancelTagPointerDragWithEscape(): void {
    if (this.showAddTagForm) {
      this.cancelAddTagForm();
    }
    this.clearTagDragState();
  }

  @HostListener('window:blur')
  cancelTagPointerDragOnWindowBlur(): void {
    this.clearTagDragState();
  }

  allowTagHierarchyDrop(event: DragEvent, destinationNode: TagHierarchyNode): void {
    if (!this.draggedTagPath) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const validDestination = this.canMoveTagBranchTo(destinationNode.fullPath);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dropTargetPath = validDestination ? destinationNode.fullPath : '';
    this.invalidDropTargetPath = validDestination ? '' : destinationNode.fullPath;
  }

  allowTagRootDrop(event: DragEvent): void {
    if (!this.draggedTagPath) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const validDestination = this.canMoveTagBranchTo(null);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dropTargetPath = validDestination ? ROOT_DROP_TARGET : '';
    this.invalidDropTargetPath = '';
  }

  dropTagOnNode(event: DragEvent, destinationNode: TagHierarchyNode): void {
    if (!this.draggedTagPath) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const sourcePath = this.getDraggedTagBranch(event);
    if (!sourcePath) {
      return;
    }

    this.clearTagDragState();
    if (!this.canMoveTagBranchTo(destinationNode.fullPath, sourcePath)) {
      this.showRejectedTagMove(sourcePath, destinationNode.fullPath);
      return;
    }
    this.confirmTagBranchMove(sourcePath, destinationNode.fullPath);
  }

  dropTagAtRoot(event: DragEvent): void {
    const sourcePath = this.getDraggedTagBranch(event);
    if (!sourcePath) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.clearTagDragState();
    if (!this.canMoveTagBranchTo(null, sourcePath)) {
      this.showRejectedTagMove(sourcePath, null);
      return;
    }
    this.confirmTagBranchMove(sourcePath, null);
  }

  tagRowIsDropTarget(node: TagHierarchyNode): boolean {
    return Boolean(this.draggedTagPath) && tagPathsEqual(this.dropTargetPath, node.fullPath);
  }

  tagRowIsInvalidDropTarget(node: TagHierarchyNode): boolean {
    return Boolean(this.draggedTagPath)
      && tagPathsEqual(this.invalidDropTargetPath, node.fullPath);
  }

  tagRowIsDragging(node: TagHierarchyNode): boolean {
    return Boolean(this.pointerDragActive)
      && tagPathsEqual(this.pointerDragCandidatePath, node.fullPath);
  }

  rootIsDropTarget(): boolean {
    return this.dropTargetPath === ROOT_DROP_TARGET;
  }

  onTagRightClick(event: PointerEvent, node: TagHierarchyNode): void {
    event.preventDefault();
    event.stopPropagation();

    const tagValue = this.getExactTagValue(node);
    this.manualTagsService.showColorPickerSubject.next({
      tagName: tagValue,
      currentColor: this.manualTagsService.getTagColor(tagValue) || '',
      position: {
        x: event.clientX,
        y: event.clientY,
      },
    });
  }

  getTagColor(node: TagHierarchyNode): string | undefined {
    for (const tagValue of node.explicitTagValues) {
      const color = this.manualTagsService.getTagColor(tagValue);
      if (color) {
        return color;
      }
    }

    return this.manualTagsService.getTagColor(node.fullPath);
  }

  getContrastColor(hexColor: string): 'black' | 'white' {
    const hex = hexColor?.replace('#', '');
    if (!hex || hex.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(hex)) {
      return 'black';
    }

    const red = parseInt(hex.substring(0, 2), 16);
    const green = parseInt(hex.substring(2, 4), 16);
    const blue = parseInt(hex.substring(4, 6), 16);
    const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

    return luminance > 0.5 ? 'black' : 'white';
  }

  frequencyLabel(node: TagHierarchyNode): string {
    if (node.children.length) {
      return this.translate.instant('TAGS.branchFrequencyLabel', {
        branchCount: node.branchFrequency,
        directCount: node.directFrequency,
        tagName: node.fullPath,
      });
    }

    return this.translate.instant('TAGS.tagFrequencyLabel', {
      count: node.directFrequency,
      tagName: node.fullPath,
    });
  }

  tagActionLabel(node: TagHierarchyNode): string {
    if (this.batchTaggingMode()) {
      return this.translate.instant('TAGS.addTagToSelection', { tagName: node.fullPath });
    }
    if (node.children.length) {
      return this.translate.instant('TAGS.filterTagBranch', { tagName: node.fullPath });
    }

    return this.translate.instant('TAGS.filterExactTag', { tagName: node.fullPath });
  }

  removeExactTag(node: TagHierarchyNode): void {
    if (!node.explicit) {
      return;
    }

    this.confirmExactRemoval(node.fullPath);
  }

  private confirmExactRemoval(tagPath: string): void {
    const exactValues = this.currentExactTagValues(tagPath);
    const affectedVideoCount = this.exactAffectedVideoCount(tagPath);
    const definitionCount = this.manualTagsService.hasTagDefinition(tagPath) ? 1 : 0;
    if (!affectedVideoCount && !definitionCount) {
      return;
    }
    if (!tagRemovalRequiresConfirmation(affectedVideoCount)) {
      this.removeExactTagValues(exactValues, tagPath);
      return;
    }
    const confirmedScopeSignature = this.exactRemovalSignature(tagPath);
    const videoLabel = affectedVideoCount === 1 ? 'video' : 'videos';

    this.modalService.openConfirmationDialog({
      cancelLabel: this.translate.instant('SYSTEM.cancel'),
      confirmLabel: this.translate.instant('TAGS.removeFromCatalogue'),
      facts: [
        { label: 'Tag', value: tagPath },
        { label: 'Videos affected', value: affectedVideoCount },
        { label: 'Catalogue definitions removed', value: definitionCount },
      ],
      summary: `“${tagPath}” will be removed from ${affectedVideoCount} ${videoLabel}.`,
      supportingText: 'This cannot be undone.',
      title: this.translate.instant('TAGS.confirmRemoveTagTitle'),
      tone: 'destructive',
    }).subscribe((confirmed: boolean) => {
      if (!confirmed) {
        return;
      }

      if (this.exactRemovalSignature(tagPath) !== confirmedScopeSignature) {
        this.confirmExactRemoval(tagPath);
        return;
      }
      this.removeExactTagValues(exactValues, tagPath);
    });
  }

  removeBranch(node: TagHierarchyNode): void {
    if (!node.children.length) {
      return;
    }

    this.confirmBranchRemoval(node.fullPath);
  }

  private confirmBranchRemoval(branchPath: string): void {
    const plan = planTagBranchRemoval(this.imageElementService.imageElements, branchPath);
    const definitionCount = this.manualTagsService.getTagDefinitions().filter((definition: string) => (
      isTagInBranch(definition, branchPath)
    )).length;
    if (!plan.affectedEntryCount && !definitionCount) {
      return;
    }
    if (!tagRemovalRequiresConfirmation(plan.affectedEntryCount)) {
      this.applyBranchRemoval(plan);
      return;
    }
    const confirmedScopeSignature = this.branchRemovalSignature(plan);
    const videoLabel = plan.affectedEntryCount === 1 ? 'video' : 'videos';

    this.modalService.openConfirmationDialog({
      cancelLabel: this.translate.instant('SYSTEM.cancel'),
      confirmLabel: this.translate.instant('TAGS.removeBranchFromCatalogue'),
      facts: [
        { label: 'Tag branch', value: branchPath },
        { label: 'Videos affected', value: plan.affectedEntryCount },
        { label: 'Exact tag paths removed', value: plan.affectedTagValues.length },
        { label: 'Catalogue definitions removed', value: definitionCount },
      ],
      summary: `The “${branchPath}” branch will be removed from ${plan.affectedEntryCount} ${videoLabel}.`,
      supportingText: 'Every descendant in this branch will be removed. This cannot be undone.',
      title: this.translate.instant('TAGS.confirmRemoveBranchTitle'),
      tone: 'destructive',
    }).subscribe((confirmed: boolean) => {
      if (!confirmed) {
        return;
      }

      const currentPlan = planTagBranchRemoval(this.imageElementService.imageElements, branchPath);
      if (this.branchRemovalSignature(currentPlan) !== confirmedScopeSignature) {
        this.confirmBranchRemoval(branchPath);
        return;
      }
      this.applyBranchRemoval(currentPlan);
    });
  }

  private getHierarchy(): TagHierarchyNode[] {
    const imageElementsReference = this.imageElementService.imageElements;
    const pipeToggleTrigger = this.manualTagsService.pipeToggleTrigger;
    const tagsListLength = this.manualTagsService.tagsList.length;
    const hierarchyChanged = imageElementsReference !== this.cachedImageElementsReference
      || pipeToggleTrigger !== this.cachedPipeToggleTrigger
      || tagsListLength !== this.cachedTagsListLength;

    if (hierarchyChanged || !this.hierarchyCacheInitialized) {
      this.cachedHierarchy = buildTagHierarchy(
        imageElementsReference.filter((element) => !element.deleted),
        this.manualTagsService.getTagDefinitions(),
      );
      this.hierarchyCacheInitialized = true;
      this.cachedImageElementsReference = imageElementsReference;
      this.cachedPipeToggleTrigger = pipeToggleTrigger;
      this.cachedTagsListLength = tagsListLength;
      this.cachedDisplayedSource = undefined;

      if (!this.hierarchyExpansionInitialized) {
        this.cachedHierarchy.forEach((node: TagHierarchyNode) => {
          if (node.children.length) {
            this.expandedTagPaths.add(node.fullPath);
          }
        });
        this.hierarchyExpansionInitialized = true;
      }
    }

    return this.cachedHierarchy;
  }

  private getExactTagValue(node: TagHierarchyNode): string {
    return node.explicitTagValues[0] || node.fullPath;
  }

  private toTag(tagValue: string): Tag {
    return {
      colour: this.manualTagsService.getTagColor(tagValue) || '',
      name: tagValue,
      removable: true,
    };
  }

  private removeExactTagValues(tagValues: readonly string[], definitionPath: string): void {
    const retainedColors = Object.fromEntries(
      Object.entries(this.manualTagsService.getTagColors()).filter(([colorPath]: [string, string]) => (
        !tagPathsEqual(colorPath, definitionPath)
        && !tagValues.some((tagValue: string) => tagPathsEqual(colorPath, tagValue))
      )),
    );
    this.manualTagsService.replaceTagColors(retainedColors, false);

    this.manualTagsService.removeTagDefinitions([definitionPath, ...tagValues], false);
    this.imageElementService.removeTagsFromAll(tagValues);
    this.rebuildTagIndex();

    this.invalidateHierarchy();
    this.tagRemovedGlobally.emit();
  }

  private applyBranchRemoval(plan: TagBranchRemovalPlan): void {
    const retainedColors = Object.fromEntries(
      Object.entries(this.manualTagsService.getTagColors()).filter(([tagPath]: [string, string]) => (
        !isTagInBranch(tagPath, plan.branchPath)
      )),
    );
    this.manualTagsService.replaceTagColors(retainedColors, false);
    this.manualTagsService.removeTagDefinitionBranch(plan.branchPath, false);
    this.imageElementService.applyTagBranchRemovalPlan(plan);
    this.rebuildTagIndex();
    this.invalidateHierarchy();
    this.tagRemovedGlobally.emit();
  }

  private confirmTagBranchMove(sourcePath: string, destinationParentPath: string | null): void {
    let plan: TagBranchMovePlan;
    try {
      plan = planTagBranchMove(
        this.imageElementService.imageElements,
        sourcePath,
        destinationParentPath,
      );
    } catch (error) {
      this.showInvalidTagMove(error);
      return;
    }

    const definitionPlan = planTagDefinitionBranchMove(
      this.manualTagsService.getTagDefinitions(),
      plan.sourcePath,
      destinationParentPath,
    );
    const colourPlan = planTagBranchColourMove(
      this.manualTagsService.getTagColors(),
      plan.sourcePath,
      plan.destinationPath,
    );
    if (
      !plan.affectedEntryCount
      && !definitionPlan.affectedDefinitionCount
      && !colourPlan.affectedColourPathCount
    ) {
      this.modalService.openSnackbar(this.translate.instant('TAGS.tagMoveNoChanges'));
      return;
    }
    const unavailableCount = plan.entries.filter((entry) => (
      Boolean(this.imageElementService.imageElements[entry.index]?.missing)
    )).length;
    const pendingDeletionCount = plan.entries.filter((entry) => (
      Boolean(this.imageElementService.imageElements[entry.index]?.deleted)
    )).length;
    const combinesBranches = plan.deduplicatedAssignmentCount > 0
      || definitionPlan.deduplicatedDefinitionCount > 0
      || colourPlan.conflictCount > 0;
    const titleKey = destinationParentPath === null
      ? 'TAGS.confirmMoveBranchToRootTitle'
      : combinesBranches
        ? 'TAGS.confirmCombineBranchesTitle'
        : 'TAGS.confirmMoveBranchTitle';
    const confirmKey = destinationParentPath === null
      ? 'TAGS.moveToTopLevel'
      : combinesBranches
        ? 'TAGS.combineBranches'
        : 'TAGS.moveBranch';
    const confirmedScopeSignature = this.tagBranchMoveSignature(plan, colourPlan, definitionPlan);

    const videoLabel = plan.affectedEntryCount === 1 ? 'video' : 'videos';
    const pathLabel = plan.affectedTagPathCount === 1 ? 'path' : 'paths';
    const assignmentLabel = plan.affectedAssignmentCount === 1 ? 'assignment' : 'assignments';
    const definitionLabel = definitionPlan.affectedDefinitionCount === 1
      ? 'catalogue definition'
      : 'catalogue definitions';

    this.modalService.openConfirmationDialog({
      cancelLabel: this.translate.instant('SYSTEM.cancel'),
      confirmLabel: this.translate.instant(confirmKey),
      facts: [
        { label: 'Videos affected', value: plan.affectedEntryCount },
        { label: 'Tag paths affected', value: plan.affectedTagPathCount },
        { label: 'Tag assignments rewritten', value: plan.affectedAssignmentCount },
        { label: 'Duplicate assignments consolidated', value: plan.deduplicatedAssignmentCount },
        { label: 'Catalogue tag definitions moved', value: definitionPlan.affectedDefinitionCount },
        { label: 'Equivalent definitions consolidated', value: definitionPlan.deduplicatedDefinitionCount },
        { label: 'Existing destination colours retained', value: colourPlan.conflictCount },
        { label: 'Temporarily unavailable videos', value: unavailableCount },
        { label: 'Entries pending deletion', value: pendingDeletionCount },
      ],
      summary: `${plan.affectedEntryCount} ${videoLabel}, ${plan.affectedTagPathCount} ${pathLabel}, and ${plan.affectedAssignmentCount} ${assignmentLabel} will change.`,
      supportingText: `${definitionPlan.affectedDefinitionCount} ${definitionLabel} and all descendants will move with the branch.`,
      title: this.translate.instant(titleKey),
      tone: combinesBranches ? 'warning' : 'primary',
      transition: {
        from: plan.sourcePath,
        fromLabel: 'Current',
        to: plan.destinationPath,
        toLabel: destinationParentPath === null ? 'Top level' : 'After',
      },
    }).subscribe((confirmed: boolean) => {
      if (!confirmed) {
        return;
      }

      let currentPlan: TagBranchMovePlan;
      try {
        currentPlan = planTagBranchMove(
          this.imageElementService.imageElements,
          sourcePath,
          destinationParentPath,
        );
      } catch (error) {
        this.showInvalidTagMove(error);
        return;
      }
      const currentColourPlan = planTagBranchColourMove(
        this.manualTagsService.getTagColors(),
        currentPlan.sourcePath,
        currentPlan.destinationPath,
      );
      const currentDefinitionPlan = planTagDefinitionBranchMove(
        this.manualTagsService.getTagDefinitions(),
        currentPlan.sourcePath,
        destinationParentPath,
      );
      if (
        this.tagBranchMoveSignature(currentPlan, currentColourPlan, currentDefinitionPlan)
        !== confirmedScopeSignature
      ) {
        this.confirmTagBranchMove(sourcePath, destinationParentPath);
        return;
      }

      if (
        currentPlan.affectedEntryCount
        && this.imageElementService.applyTagBranchMovePlan(currentPlan) !== currentPlan.affectedEntryCount
      ) {
        this.confirmTagBranchMove(sourcePath, destinationParentPath);
        return;
      }

      this.manualTagsService.replaceTagDefinitions(currentDefinitionPlan.nextDefinitions, false);
      this.manualTagsService.replaceTagColors(currentColourPlan.nextColours, false);
      this.remapExpandedTagPaths(currentPlan.sourcePath, currentPlan.destinationPath);
      this.rebuildTagIndex();
      this.invalidateHierarchy();
      this.tagHierarchyMoved.emit({
        destinationPath: currentPlan.destinationPath,
        sourcePath: currentPlan.sourcePath,
      });
    });
  }

  private currentExactTagValues(tagPath: string): string[] {
    const values = new Set<string>();
    this.imageElementService.imageElements.forEach((element) => {
      element.tags?.forEach((tag: string) => {
        if (typeof tag === 'string' && tagPathsEqual(tag, tagPath)) {
          values.add(tag);
        }
      });
    });
    return Array.from(values);
  }

  private exactAffectedVideoCount(tagPath: string): number {
    return this.imageElementService.imageElements.filter((element) => (
      element.tags?.some((tag: string) => (
        typeof tag === 'string' && tagPathsEqual(tag, tagPath)
      ))
    )).length;
  }

  private exactRemovalSignature(tagPath: string): string {
    return JSON.stringify({
      definitions: this.manualTagsService.getTagDefinitions()
        .filter((definition: string) => tagPathsEqual(definition, tagPath)),
      entries: this.imageElementService.imageElements.flatMap((element, index: number) => {
      const matchingTags = (element.tags || []).filter((tag: string) => (
        typeof tag === 'string'
        && tagPathsEqual(tag, tagPath)
      ));
      return matchingTags.length
        ? [[index, element.hash || '', element.fileName || '', matchingTags.slice().sort()]]
        : [];
      }),
    });
  }

  private branchRemovalSignature(plan: TagBranchRemovalPlan): string {
    return JSON.stringify({
      definitions: this.manualTagsService.getTagDefinitions()
        .filter((definition: string) => isTagInBranch(definition, plan.branchPath)),
      entries: plan.entries.map((entry) => {
        const element = this.imageElementService.imageElements[entry.index];
        return [
          entry.index,
          element?.hash || '',
          element?.fileName || '',
          entry.removedTags.slice().sort(),
        ];
      }),
    });
  }

  private tagBranchMoveSignature(
    plan: TagBranchMovePlan,
    colourPlan: TagBranchColourMovePlan,
    definitionPlan: TagDefinitionBranchMovePlan,
  ): string {
    return JSON.stringify({
      affectedColourPathCount: colourPlan.affectedColourPathCount,
      colourConflictCount: colourPlan.conflictCount,
      colours: Object.entries(colourPlan.nextColours)
        .sort(([left]: [string, string], [right]: [string, string]) => left.localeCompare(right)),
      definitions: definitionPlan.nextDefinitions,
      definitionMappings: definitionPlan.mappings,
      destinationPath: plan.destinationPath,
      entries: plan.entries.map((entry) => {
        const element = this.imageElementService.imageElements[entry.index];
        return [
          entry.index,
          element?.hash || '',
          element?.fileName || '',
          Boolean(element?.missing),
          Boolean(element?.deleted),
          entry.originalTags,
          entry.updatedTags,
        ];
      }),
      sourcePath: plan.sourcePath,
    });
  }

  private rebuildTagIndex(): void {
    this.manualTagsService.rebuildFromImages(this.imageElementService.imageElements);
  }

  private invalidateHierarchy(): void {
    this.cachedHierarchy = [];
    this.hierarchyCacheInitialized = false;
    this.cachedPipeToggleTrigger = this.manualTagsService.pipeToggleTrigger;
    this.cachedTagsListLength = this.manualTagsService.tagsList.length;
    this.cachedDisplayedSource = undefined;
  }

  private visitHierarchy(
    nodes: readonly TagHierarchyNode[],
    visitor: (node: TagHierarchyNode) => void,
  ): void {
    nodes.forEach((node: TagHierarchyNode) => {
      visitor(node);
      this.visitHierarchy(node.children, visitor);
    });
  }

  private canMoveTagBranchTo(
    destinationParentPath: string | null,
    sourcePath = this.draggedTagPath,
  ): boolean {
    if (!sourcePath) {
      return false;
    }

    try {
      const destinationPath = resolveTagBranchMoveDestination(sourcePath, destinationParentPath);
      return !tagPathsEqual(sourcePath, destinationPath);
    } catch {
      return false;
    }
  }

  private getDraggedTagBranch(event: DragEvent): string {
    const payload = event.dataTransfer?.getData(TAG_BRANCH_DRAG_TYPE) || '';
    return this.draggedTagPath && (!payload || tagPathsEqual(payload, this.draggedTagPath))
      ? this.draggedTagPath
      : '';
  }

  private clearTagDragState(): void {
    if (this.pointerDragHandle && this.pointerDragPointerId !== null) {
      try {
        if (this.pointerDragHandle.hasPointerCapture(this.pointerDragPointerId)) {
          this.pointerDragHandle.releasePointerCapture(this.pointerDragPointerId);
        }
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    }
    this.draggedTagPath = '';
    this.dropTargetPath = '';
    this.invalidDropTargetPath = '';
    this.pointerDragActive = false;
    this.pointerDragCandidatePath = '';
    this.pointerDragHandle = undefined;
    this.pointerDragPointerId = null;
    this.pointerDropDestinationPath = undefined;
  }

  private updatePointerDropTarget(clientX: number, clientY: number): void {
    const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const row = element?.closest<HTMLElement>('.tag-tree-row[data-tag-path]');
    if (row?.dataset.tagPath) {
      const destinationPath = row.dataset.tagPath;
      const validDestination = this.canMoveTagBranchTo(
        destinationPath,
        this.pointerDragCandidatePath,
      );
      this.pointerDropDestinationPath = validDestination ? destinationPath : undefined;
      this.dropTargetPath = validDestination ? destinationPath : '';
      this.invalidDropTargetPath = validDestination ? '' : destinationPath;
      return;
    }

    const rootTarget = element?.closest('.tag-root-drop-zone, .tag-tree-scroll-region');
    if (rootTarget) {
      const validDestination = this.canMoveTagBranchTo(null, this.pointerDragCandidatePath);
      this.pointerDropDestinationPath = validDestination ? null : undefined;
      this.dropTargetPath = validDestination ? ROOT_DROP_TARGET : '';
      this.invalidDropTargetPath = '';
      return;
    }

    this.pointerDropDestinationPath = undefined;
    this.dropTargetPath = '';
    this.invalidDropTargetPath = '';
  }

  private remapExpandedTagPaths(sourcePath: string, destinationPath: string): void {
    const remappedPaths = Array.from(this.expandedTagPaths).map((path: string) => (
      isTagInBranch(path, sourcePath)
        ? remapTagBranchPath(path, sourcePath, destinationPath)
        : path
    ));
    this.expandedTagPaths.clear();
    remappedPaths.forEach((path: string) => this.expandedTagPaths.add(path));
    this.expandedTagPaths.add(destinationPath);
  }

  private showInvalidTagMove(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.modalService.openSnackbar(this.translate.instant('TAGS.invalidTagMove', { reason }));
  }

  private showRejectedTagMove(sourcePath: string, destinationParentPath: string | null): void {
    try {
      const destinationPath = resolveTagBranchMoveDestination(sourcePath, destinationParentPath);
      if (tagPathsEqual(sourcePath, destinationPath)) {
        this.modalService.openSnackbar(this.translate.instant('TAGS.tagMoveNoChanges'));
      }
    } catch (error) {
      this.showInvalidTagMove(error);
    }
  }
}
