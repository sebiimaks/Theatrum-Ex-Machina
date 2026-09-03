import type { AfterViewInit, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { ChangeDetectorRef, NgZone, viewChild } from '@angular/core';
import { Component, HostListener } from '@angular/core';

import * as path from 'path';

import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { VirtualScrollerComponent } from '@iharbeck/ngx-virtual-scroller';

// Services
import { AutoTagsSaveService } from './tags-auto/tags-save.service';
import { CatalogueOpenCoordinatorService } from '../services/catalogue-open-coordinator.service';
import { CataloguePersistenceIpcService } from '../services/catalogue-persistence-ipc.service';
import { CatalogueSessionDocumentService } from '../services/catalogue-session-document.service';
import { ElectronService } from '../providers/electron.service';
import { FilePathService } from './views/file-path.service';
import { GalleryLayoutService } from '../services/gallery-layout.service';
import { ImageElementService } from '../services/image-element.service';
import { ManualTagsService } from './tags-manual/manual-tags.service';
import { ModalService } from './modal/modal.service';
import { PipeSideEffectService } from '../pipes/pipe-side-effect.service';
import { ResolutionFilterService } from '../pipes/resolution-filter.service';
import { ShortcutsService, CustomShortcutAction } from './shortcuts/shortcuts.service';
import { SourceFolderService } from './statistics/source-folder.service';
import { StarFilterService } from '../pipes/star-filter.service';
import { ThumbnailRegenerationIpcService } from '../services/thumbnail-regeneration-ipc.service';
import { WordFrequencyService, WordFreqAndHeight } from '../pipes/word-frequency.service';

// Components
import { SortOrderComponent } from './sort-order/sort-order.component';

// Interfaces
import type { ContextMenuCoordinate } from '../../../interfaces/shared-interfaces';
import type {
  FinalObject,
  ImageElement,
  ImageLocation,
  SourceFolder,
  ScreenshotSettings,
  ResolutionString,
} from '../../../interfaces/final-object.interface';
import { IMPORT_ERROR_TAG, isMetadataImportFailure } from '../../../interfaces/final-object.interface';
import {
  ensureDateAddedForNewEntry,
  findDeletedMetadataOrigin,
} from '../../../interfaces/date-added';
import {
  attachKnownLocationsFromSnapshot,
  copyRecoveredEntryMetadata,
  reconcileMissingFolderEntriesInScope,
  replaceRecoveredFolderEntry,
} from '../../../interfaces/folder-rescan';
import {
  attachImageLocation,
  getImageLocations,
  markImageLocationsMissingInScope,
  normalizeImageElementLocations,
  normalizeImageLocation,
  planIgnoredSourceFolderRemoval,
  promoteImageLocation,
  removeImageLocationsForSource,
  selectAvailableImageLocation,
} from '../../../interfaces/media-locations';
import type { IgnoredSourceFolderRemovalPlan } from '../../../interfaces/media-locations';
import { normalizeIgnoredSubdirectories } from '../../../interfaces/source-folder-path';
import { normalizeSourceFolderRelativePath } from '../../../interfaces/source-folder-tree';
import {
  addTagToSelectedEntries,
  isTagInBranch,
  remapTagBranchPath,
  tagPathsEqual,
} from '../../../interfaces/tag-hierarchy';
import type { ImportStage } from '../../../node/main-support';
import type {
  FolderThumbnailRegenerationProgress,
  FolderThumbnailRegenerationResult,
  ThumbnailCoreStatus,
} from '../../../interfaces/thumbnail-regeneration';
import {
  applyCustomThumbnailReplacement,
  applyRegeneratedScreenshotCount,
  applyThumbnailRegenerationFailure,
  folderThumbnailRegenerationPlansMatch,
  normalizeCatalogueThumbnailCounts,
  planFolderThumbnailRegeneration,
  withThumbnailRefreshId,
} from '../../../node/thumbnail-count';
import type { FolderScopeTarget } from './statistics/statistics.component';
import type { TagHierarchyMoveEmission } from './tag-tray/tag-tray.component';
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  shouldRevealCompactCleanNameToolbar,
} from '../../../interfaces/settings-object.interface';
import type { SettingsButtonSavedProperties, SettingsObject } from '../../../interfaces/settings-object.interface';
import type { SortType } from '../pipes/sorting.pipe';
import type { WizardOptions } from '../../../interfaces/wizard-options.interface';
import { isSupportedCatalogueFilePath } from '../../../interfaces/catalogue-file';
import type { CatalogueAccessMode } from '../../../interfaces/catalogue-session';
import type { LegacyCatalogueOpenChoice } from '../common/catalogue-open-coordinator';
import {
  classifyIndividualThumbnailRegenerationTerminal,
} from '../common/thumbnail-regeneration-ipc';
import type {
  IndividualThumbnailRegenerationStatus,
} from '../common/thumbnail-regeneration-ipc';
import {
  FolderThumbnailRegenerationSession,
} from '../common/folder-thumbnail-regeneration-session';
import type {
  FolderThumbnailRegenerationStatus,
} from '../common/folder-thumbnail-regeneration-session';
import type {
  HistoryItem,
  RenameFileResponse,
  SupportedTrayView,
  SupportedView,
  VideoClickEmit} from '../../../interfaces/shared-interfaces';
import {
  AllSupportedBottomTrayViews,
  AllSupportedViews
} from '../../../interfaces/shared-interfaces';

// Constants, etc
import type { AppStateInterface, SupportedLanguage, RowNumbers } from '../common/app-state';
import {
  AppState,
  DefaultImagesPerRow,
  normalizeGeneratePreviewsOnFolderAddition,
  normalizeHideSubdirectoriesWithNoVideos,
  normalizeScanFoldersOnAddition,
} from '../common/app-state';
import { Filters, filterKeyToIndex, FilterKeyNames } from '../common/filters';
import { GLOBALS } from '../../../node/main-globals';
import { LanguageLookup } from '../common/languages';
import type { SettingsButtonKey, SettingsButtonsType } from '../common/settings-buttons';
import { SettingsButtons, SettingsButtonsGroups } from '../common/settings-buttons';
import { getVirtualScrollBufferAmount } from '../common/virtual-scroll-layout';

// Animations
import {
  bottomTrayAnimation,
  buttonAnimation,
  donutAppear,
  filterItemAppear,
  sliderAppear,
  historyItemRemove,
  modalAnimation,
  myWizardAnimation,
  overlayAppear,
  rightClickAnimation,
  rightClickContentAnimation,
  similarResultsText,
  slowFadeIn,
  slowFadeOut,
  topAnimation
} from '../common/animations';

interface Vha2ExportResult {
  error?: string;
  fileName?: string;
  status: 'cancelled' | 'error' | 'exported' | 'read-only';
}

interface CatalogueLoadedFromBackupDetails {
  openedPath?: string;
  primaryError?: string;
  readOnly?: boolean;
  sourcePath?: string;
}

const GALLERY_LAYOUT_TRANSITION_MS = 320;
const GALLERY_RESIZE_SETTLE_MS = 60;

@Component({
  standalone: false,
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: [
    './layout.scss',
    './settings.scss',
    './buttons.scss',
    './search.scss',
    './search-input.scss',
    '../fonts/icons.scss',
    './gallery.scss',
    './wizard-button.scss',
    './resolution.scss',
    './rightclick.scss'
  ],
  animations: [
    bottomTrayAnimation,
    buttonAnimation,
    donutAppear,
    filterItemAppear,
    historyItemRemove,
    modalAnimation,
    myWizardAnimation,
    overlayAppear,
    rightClickAnimation,
    rightClickContentAnimation,
    similarResultsText,
    sliderAppear,
    slowFadeIn,
    slowFadeOut,
    topAnimation
  ]
})
export class HomeComponent implements OnInit, AfterViewInit, OnDestroy {

  readonly fuzzySearch = viewChild<ElementRef>('fuzzySearch');
  readonly startsWithSearch = viewChild<ElementRef>('startsWithSearch');
  readonly magicSearch = viewChild<ElementRef>('magicSearch');
  readonly searchRef = viewChild<ElementRef>('searchRef');
  readonly settingsModal = viewChild<ElementRef>('settingsModal');

  readonly sortOrderRef = viewChild(SortOrderComponent);

  readonly virtualScroller = viewChild(VirtualScrollerComponent);
  readonly getVirtualScrollBufferAmount = getVirtualScrollBufferAmount;

  defaultSettingsButtons = JSON.parse(JSON.stringify(SettingsButtons));
  settingsButtons: SettingsButtonsType = SettingsButtons;
  settingsButtonsGroups = SettingsButtonsGroups;
  settingTabToShow = 0;

  filters = Filters;

  // App state to save -- so it can be exported and saved when closing the app
  appState = AppState;

  macVersion = GLOBALS.macVersion;
  versionNumber = GLOBALS.version;

  vhaFileHistory: HistoryItem[] = [];

  private galleryLayoutRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
  private galleryLayoutRefreshFrame: number | undefined;
  private galleryResizeObserver: ResizeObserver | undefined;
  private observedGalleryWidth: number | undefined;
  private pendingGalleryScrollReset = false;

  newVideoImportTimeout = null;
  newVideoImportCounter = 0;

  // ========================================================================
  // App state / UI state
  // ------------------------------------------------------------------------

  isClosing = false;
  appMaximized = false;
  settingsModalOpen = false;
  flickerReduceOverlay = true;
  isFirstRunEver = false;
  private hasResolvedInitialTheme = false;

  // Tag color picker state
  showTagColorPicker = false;
  tagColorPickerPosition: ContextMenuCoordinate = { x: 0, y: 0 };
  currentTagColor = '';
  currentTagName = '';
  tagColorPickerSubscription: any;
  tagColorPersistenceSubscription: any;
  tagDefinitionsPersistenceSubscription: any;

  // ========================================================================
  // Import / extraction progress
  // ------------------------------------------------------------------------

  extractionPercent = 1;
  importStage: ImportStage = 'done';
  progressString = '';

  // ========================================================================
  // Gallery thumbnails
  // ------------------------------------------------------------------------

  currentImgsPerRow = 5;
  galleryWidth: number;
  imgsPerRow: RowNumbers = DefaultImagesPerRow;
  previewHeight = 144;
  previewHeightRelated = 144;   // For the Related Videos tab:
  previewWidth: number;
  previewWidthRelated: number;          // For the Related Videos tab:
  textPaddingHeight: number;            // for text padding below filmstrip or thumbnail element

  private readonly folderThumbnailRegenerationSession = new FolderThumbnailRegenerationSession();
  get folderThumbnailRegenerationStatus(): FolderThumbnailRegenerationStatus | null {
    return this.folderThumbnailRegenerationSession.status;
  }
  individualThumbnailRegenerationStatus: IndividualThumbnailRegenerationStatus | null = null;
  private catalogueSessionGeneration = 0;
  thumbnailRegenerationElapsedSeconds = 0;
  private thumbnailRegenerationStartedAt = 0;
  private thumbnailRegenerationTimer: number | null = null;

  // ========================================================================
  // Duration filter
  // ------------------------------------------------------------------------

  durationLeftBound = 0;
  durationOutlierCutoff = 0;
  durationRightBound = Infinity;

  // ========================================================================
  // Size filter
  // ------------------------------------------------------------------------

  sizeLeftBound = 0;
  sizeOutlierCutoff = 0;
  sizeRightBound = Infinity;

  // ========================================================================
  // Times Played filter
  // ------------------------------------------------------------------------

  timesPlayedCutoff = 0;
  timesPlayedLeftBound = -1;
  timesPlayedRightBound = Infinity;

  // ========================================================================
  // Year filter
  // ------------------------------------------------------------------------

  yearMinCutoff = 0;
  yearCutoff = 0;
  yearLeftBound = 0;
  yearRightBound = Infinity;

  // ========================================================================
  // Frequency / histogram
  // ------------------------------------------------------------------------

  resolutionFreqArr: number[];
  freqLeftBound = 0;
  freqRightBound = 4;
  resolutionNames: ResolutionString[] = ['SD', '720', '1080', '4K'];

  // ========================================================================
  // Star filter
  // ------------------------------------------------------------------------

  starRatingFreqArr: number[];
  starLeftBound = 0;
  starRightBound = 6;
  starRatingNames: string[] = ['N/A', '1', '2', '3', '4', '5'];

  // ========================================================================
  // Right-click / Renaming functionality
  // ------------------------------------------------------------------------

  currentRightClickedItem: ImageElement;
  renamingExtension: string;
  renamingNow = false;
  rightClickPosition: ContextMenuCoordinate = { x: 0, y: 0 };
  rightClickShowing = false;

  // ========================================================================
  // Thumbnail Sheet Overlay Display
  // ------------------------------------------------------------------------

  sheetItemToDisplay: ImageElement;
  sheetOverlayShowing = false;

  // ========================================================================
  // Variables for the wizard during import
  // ------------------------------------------------------------------------

  canCloseWizard = false;

  wizard: WizardOptions = {
    clipHeight: 144,
    clipSnippetLength: 1,
    clipSnippets: 3,
    extractClips: false,
    futureHubName: '',
    isFixedNumberOfScreenshots: true,
    screenshotSizeForImport: 288,
    selectedOutputFolder: '',
    selectedSourceFolder: { 0: { path: '', watch: false }},
    showWizard: false,
    ssConstant: 10,
    ssVariable: 5,
  };

  // ========================================================================
  // currently only used for the statistics page
  // && to prevent clip view from showing when no clips extracted
  // defaults set here ONLY because when starting the app in clip view
  // the app would show error in console log:
  //   `Cannot read property 'clipSnippets' of undefined`
  // ------------------------------------------------------------------------

  currentScreenshotSettings: ScreenshotSettings = {
    clipHeight: 144,
    clipSnippetLength: 1,
    clipSnippets: 0,
    fixed: true,
    height: 432,
    n: 3,
  };

  // ========================================================================
  // Miscellaneous variables
  // ------------------------------------------------------------------------

  currentClickedItem: ImageElement;
  currentClickedItemName = '';
  currentPlayingFolder = '';
  fullPathToCurrentFile = '';
  currentMediaOperationItem: ImageElement | null = null;

  catalogueEditorOpen = false;
  catalogueEditorSaveStatus = '';
  catalogueEditorSaving = false;
  catalogueAccessMode: CatalogueAccessMode = 'read-write';

  get catalogueReadOnly(): boolean {
    return this.catalogueAccessMode === 'read-only';
  }

  fuzzySearchString = '';
  startsWithSearchString = '';
  magicSearchString = '';
  regexSearchString = '';
  regexError = false; // handle pipe-side-effect BehaviorSubject

  wordFreqArr: WordFreqAndHeight[];
  numberOfVideosFound: number; // after applying all search filters

  findMostSimilar: string; // for finding similar files to this one
  showSimilar = false; // to toggle the similarity pipe

  shuffleTheViewNow = 0; // dummy number to force re-shuffle current view

  sortType: SortType = 'default';

  timeExtractionStarted;   // time remaining calculator
  timeExtractionRemaining; // time remaining calculator

  deletePipeTrigger = false; // to force deletePipe to update

  playlistViewRefresh = false; // to force playlist view to refresh, if showing

  folderNavigationScrollOffset = 0; // when in folder view and returning back to root
  folderViewNavigationPath = '';

  batchTaggingMode = false; // when batch tagging is enabled

  tagTypeAhead = '';

  allFinishedScanning = true;

  lastRenamedFileHack: ImageElement;

  tagBatchModeSelectionChangedTrigger = 0;

  // Behavior Subjects for IPC events:

  inputSorceChosenBehaviorSubject: BehaviorSubject<string> = new BehaviorSubject(undefined);
  numberScreenshotsDeletedBehaviorSubject: BehaviorSubject<number> = new BehaviorSubject(undefined);
  oldFolderReconnectedBehaviorSubject: BehaviorSubject<{source: number, path: string}> = new BehaviorSubject(undefined);
  renameFileResponseBehaviorSubject: BehaviorSubject<RenameFileResponse> = new BehaviorSubject(undefined);
  // ========================================================================
  // \/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/
  // ========================================================================


  // Listen for key presses
  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {

    if (event.ctrlKey && event.key === ' ' && this.settingsButtons['spacePlaysRandom'].toggled) {
      const randomIndex: number = Math.floor(Math.random() * this.pipeSideEffectService.galleryShowing.length);
      const video: ImageElement = this.pipeSideEffectService.galleryShowing[randomIndex];
      const randomPlayStart: number = Math.floor(Math.random() * video.screens);
      this.openVideo(video, randomPlayStart);

    // .metaKey is for Mac `command` button
    } else if (event.ctrlKey === true || event.metaKey) {

      const key: string = event.key;

      if (this.shortcutService.keyToActionMap.has(key)) {
        const shortcutAction: SettingsButtonKey | CustomShortcutAction = this.shortcutService.keyToActionMap.get(key);

        if (this.shortcutService.regularShortcuts.includes(shortcutAction as SettingsButtonKey)) {
          this.toggleButton(shortcutAction as SettingsButtonKey);
        } else {
          this.handleCustomShortcutAction(event, shortcutAction as CustomShortcutAction);
        }
      }

    } else if (event.key === 'Escape' && this.wizard.showWizard === true && this.canCloseWizard === true) {
      this.wizard.showWizard = false;
    } else if (event.key === 'Escape' && this.settingsModalOpen) {
      this.settingsModalOpen = false;
    } else if (event.key === 'Escape' && (this.rightClickShowing || this.renamingNow || this.sheetOverlayShowing)) {
      this.rightClickShowing = false;
      this.renamingNow = false;
      this.sheetOverlayShowing = false;
    } else if (event.key === 'Escape' && this.settingsButtons['showTags'].toggled) {
      this.toggleButton('showTags');
    } else if (event.key === 'Escape' && this.showTagColorPicker) {
      this.showTagColorPicker = false;
    }
  }

  @HostListener('window:resize')
  handleResizeEvent() {
    this.debounceUpdateMax();
  }

  onSettingsTabKeydown(event: KeyboardEvent): void {
    const lastTabIndex = 4;
    let nextTabIndex: number | undefined;

    if (event.key === 'ArrowRight') {
      nextTabIndex = (this.settingTabToShow + 1) % (lastTabIndex + 1);
    } else if (event.key === 'ArrowLeft') {
      nextTabIndex = (this.settingTabToShow + lastTabIndex) % (lastTabIndex + 1);
    } else if (event.key === 'Home') {
      nextTabIndex = 0;
    } else if (event.key === 'End') {
      nextTabIndex = lastTabIndex;
    }

    if (nextTabIndex === undefined) {
      return;
    }

    event.preventDefault();
    this.settingTabToShow = nextTabIndex;

    const tabList = (event.currentTarget as HTMLElement | null)?.parentElement;
    setTimeout(() => {
      (tabList?.querySelector(`#settings-tab-${nextTabIndex}`) as HTMLElement | null)?.focus();
    });
  }

  constructor(
    public autoTagsSaveService: AutoTagsSaveService,
    public catalogueOpenCoordinator: CatalogueOpenCoordinatorService,
    public cataloguePersistenceIpc: CataloguePersistenceIpcService,
    public catalogueSessionDocument: CatalogueSessionDocumentService,
    public cd: ChangeDetectorRef,
    public electronService: ElectronService,
    public filePathService: FilePathService,
    public galleryLayoutService: GalleryLayoutService,
    public imageElementService: ImageElementService,
    public manualTagsService: ManualTagsService,
    public modalService: ModalService,
    public pipeSideEffectService: PipeSideEffectService,
    public resolutionFilterService: ResolutionFilterService,
    public shortcutService: ShortcutsService,
    public sourceFolderService: SourceFolderService,
    public starFilterService: StarFilterService,
    public thumbnailRegenerationIpc: ThumbnailRegenerationIpcService,
    public translate: TranslateService,
    public wordFrequencyService: WordFrequencyService,
    public zone: NgZone,
  ) {
    this.macVersion = this.electronService.platform === 'darwin' || GLOBALS.macVersion;
  }

  ngOnInit() {
    this.catalogueOpenCoordinator.connect({
      canBeginOpen: () => !this.blockActionDuringFolderThumbnailRegeneration(),
      chooseLegacyCatalogueOpen: (fullPath: string) => this.chooseLegacyCatalogueOpen(fullPath),
      getCurrentCatalogueForSave: () => this.getFinalObjectForSaving(),
      legacyOpenCancelled: (fullPath: string) => this.handleLegacyCatalogueOpenCancelled(fullPath),
    });
    this.cataloguePersistenceIpc.connect({
      closeCancelled: (): void => {
        this.isClosing = false;
        this.cd.detectChanges();
      },
      closeRequested: (): void => {
        if (!this.isClosing) {
          this.initiateClose();
        }
      },
      closeSaveFailed: (errorMessage?: string): void => {
        this.isClosing = false;
        this.catalogueEditorSaving = false;
        this.catalogueEditorSaveStatus = errorMessage ? 'Save failed: ' + errorMessage : 'Save failed';
        this.cd.detectChanges();
      },
      saveFailed: (errorMessage?: string): void => {
        this.catalogueEditorSaving = false;
        this.catalogueEditorSaveStatus = errorMessage ? 'Save failed: ' + errorMessage : 'Save failed';
        this.catalogueOpenCoordinator.finishOpen();
        this.cd.detectChanges();
      },
      saveSucceeded: (): void => {
        this.catalogueEditorSaving = false;
        this.catalogueEditorSaveStatus = 'Saved';
        this.imageElementService.finalArrayNeedsSaving = false;
        this.autoTagsSaveService.restoreSavedTags(
          this.autoTagsSaveService.getAddTags(),
          this.autoTagsSaveService.getRemoveTags()
        );
        this.cd.detectChanges();
      },
    });

    this.translate.setDefaultLang('en');
    this.changeLanguage('en');

    // this.modalService.openWelcomeMessage(); // WIP

    // Subscribe to tag color picker events
    this.tagColorPickerSubscription = this.manualTagsService.showColorPickerSubject.subscribe((data) => {
      this.currentTagName = data.tagName;
      this.currentTagColor = data.currentColor;
      this.tagColorPickerPosition = data.position;
      this.showTagColorPicker = true;
      this.cd.detectChanges();
    });
    this.tagColorPersistenceSubscription = this.manualTagsService.tagColorPersistenceChangedSubject.subscribe(() => {
      this.imageElementService.finalArrayNeedsSaving = true;
    });
    this.tagDefinitionsPersistenceSubscription = this.manualTagsService.tagDefinitionsPersistenceChangedSubject.subscribe(() => {
      this.imageElementService.finalArrayNeedsSaving = true;
    });

    setTimeout(() => {
      this.wordFrequencyService.finalMapBehaviorSubject.subscribe((value: WordFreqAndHeight[]) => {
        this.wordFreqArr = value;
      });
      this.resolutionFilterService.finalResolutionMapBehaviorSubject.subscribe((value) => {
        this.resolutionFreqArr = value;
        this.cd.detectChanges(); // prevent `ExpressionChangedAfterItHasBeenCheckedError`
      });
      this.starFilterService.finalStarMapBehaviorSubject.subscribe((value) => {
        this.starRatingFreqArr = value;
        this.cd.detectChanges(); // prevent `ExpressionChangedAfterItHasBeenCheckedError`
      });
      this.pipeSideEffectService.searchResults.subscribe((value: number) => {
        this.numberOfVideosFound = value;
        this.cd.detectChanges(); // prevent `ExpressionChangedAfterItHasBeenCheckedError`
      });
      this.pipeSideEffectService.regexError.subscribe((value: boolean) => {
        this.regexError = value;
      });

    }, 100);

    // for statistics.component
    this.electronService.ipcRenderer.on('number-of-screenshots-deleted', (event, totalDeleted: number) => {
      this.numberScreenshotsDeletedBehaviorSubject.next(totalDeleted);
      this.numberScreenshotsDeletedBehaviorSubject.next(undefined); // allways remove right away
    });

    // for statistics.component
    this.electronService.ipcRenderer.on('old-folder-reconnected', (event, sourceIndex: number, newPath: string) => {
      this.oldFolderReconnectedBehaviorSubject.next({ source: sourceIndex, path: newPath });
      this.oldFolderReconnectedBehaviorSubject.next(undefined); // allways remove right away
    });

    // Returning Input
    this.electronService.ipcRenderer.on('input-folder-chosen', (event, filePath) => {
      // if this happens when CURRENT HUB is open
      this.inputSorceChosenBehaviorSubject.next(filePath);
      this.inputSorceChosenBehaviorSubject.next(undefined); // allways remove right away

      // if this happens during WIZARD stage
      this.wizard.selectedSourceFolder[0].path = filePath;
      this.wizard.selectedOutputFolder = filePath;
      this.cd.detectChanges();
    });

    // Returning Output
    this.electronService.ipcRenderer.on('output-folder-chosen', (event, filePath) => {
      this.wizard.selectedOutputFolder = filePath;
      this.cd.detectChanges();
    });

    // Happens if a file with the same hub name already exists in the directory
    this.electronService.ipcRenderer.on('please-fix-hub-name', (event) => {
      this.importStage = 'done';
      this.cd.detectChanges();
    });

    // Generic messaging from Node
    this.electronService.ipcRenderer.on('show-msg-dialog', (event,  title: string, content: string, details: string ) => {
      this.zone.run(() => {
        this.modalService.openDialog(title, content, details);
      });
    });

    // When clicking to open a file and it turns out no longer present there
    this.electronService.ipcRenderer.on('file-not-found', (event) => {
      this.zone.run(() => {
        this.modalService.openSnackbar(this.translate.instant('SETTINGS.fileNotFound'));
      });
    });


    // When Node succeeds or fails to rename a file that Angular requested to rename
    this.electronService.ipcRenderer.on(
      'rename-file-response', (
          event,
          index: number,
          success: boolean,
          renameTo: string,
          oldFileName: string,
          errMsg?: string
        ) => {

          this.renameFileResponseBehaviorSubject.next({
            index: index,
            success: success,
            renameTo: renameTo,
            oldFileName: oldFileName,
            errMsg: errMsg,
          });
          this.renameFileResponseBehaviorSubject.next(undefined); // allways remove right away

          if (success) {
            // Update the final array, close rename dialog if open
            // the error messaging is handled by `rename-file.component` or `meta.component` if it happens
            this.imageElementService.replaceFileNameInFinalArray(renameTo, oldFileName, index);
            this.closeRename();

            // if successful rename, and `watch` directory enabled, this video might appear twice
            // use `lastRenamedFileHack` to prevent it!
            const renamedFile: ImageElement = this.imageElementService.imageElements[index];
            console.log('Rename success:');
            console.log(renamedFile);
            this.lastRenamedFileHack = renamedFile;
          }

    });

    this.electronService.ipcRenderer.on('custom-thumbnail-replaced', (event, fileHash: string) => {
      this.zone.run(() => {
        const catalogueChanged = applyCustomThumbnailReplacement(
          this.imageElementService.imageElements,
          fileHash,
          Date.now(),
        );

        this.electronService.webFrame.clearCache();
        this.imageElementService.imageElements = this.imageElementService.imageElements.slice();
        if (catalogueChanged) {
          this.imageElementService.finalArrayNeedsSaving = true;
        }

        if (this.currentClickedItem && this.currentClickedItem.hash === fileHash) {
          this.updateCurrentClickedItem(this.currentClickedItem);
        }
      });
    });

    this.thumbnailRegenerationIpc.connect({
      folderCompleted: (requestId, sourceIndex, result): void => {
        this.zone.run(() => {
          this.handleFolderThumbnailRegenerationComplete(requestId, sourceIndex, result);
        });
      },
      folderFailed: (requestId, sourceIndex): void => {
        this.zone.run(() => {
          this.handleFolderThumbnailRegenerationFailure(requestId, sourceIndex);
        });
      },
      folderProgress: (requestId, sourceIndex, progress): void => {
        this.zone.run(() => {
          this.handleFolderThumbnailRegenerationProgress(requestId, sourceIndex, progress);
        });
      },
      folderProgressRejected: (requestId, sourceIndex): void => {
        this.zone.run(() => {
          this.handleFolderThumbnailRegenerationProgressRejected(requestId, sourceIndex);
        });
      },
      individualAssetsReplaced: (): void => {
        this.electronService.webFrame.clearCache();
      },
      individualCompleted: (fileHash, screenshotCount): void => {
        this.zone.run(() => {
          if (!this.clearIndividualThumbnailRegeneration(fileHash)) {
            return;
          }
          this.applyThumbnailRegenerationResult(fileHash, screenshotCount, true);
          this.modalService.openSnackbar(
            this.translate.instant('RIGHTCLICK.thumbnailRegenerationComplete'),
          );
        });
      },
      individualFailed: (
        fileHash: string,
        reason?: string,
        coreStatus?: ThumbnailCoreStatus,
      ): void => {
        this.zone.run(() => {
          if (!this.clearIndividualThumbnailRegeneration(fileHash)) {
            return;
          }
          const catalogueChanged = applyThumbnailRegenerationFailure(
            this.imageElementService.imageElements,
            fileHash,
            coreStatus,
            Date.now(),
          );
          this.electronService.webFrame.clearCache();
          this.imageElementService.imageElements = this.imageElementService.imageElements.slice();
          if (catalogueChanged) {
            this.imageElementService.finalArrayNeedsSaving = true;
          }
          if (this.currentClickedItem && this.currentClickedItem.hash === fileHash) {
            this.updateCurrentClickedItem(this.currentClickedItem);
          }

          const message = this.translate.instant('RIGHTCLICK.thumbnailRegenerationFailed');
          this.modalService.openSnackbar(reason ? `${message}: ${reason}` : message);
        });
      },
    });

    this.electronService.ipcRenderer.on('touchBar-to-app', (event, changesFromTouchBar: SettingsButtonKey | SupportedView) => {
      if (changesFromTouchBar) {
        this.toggleButton(changesFromTouchBar, true);
      }
    });

    this.electronService.ipcRenderer.on('preferred-video-player-returning', (event, filePath) => {

      this.appState.preferredVideoPlayer = filePath;
      this.appState.videoPlayerArgs = '';

      // Hardcode for MAC & VLC
      if (this.macVersion && this.appState.preferredVideoPlayer.toLowerCase().includes('vlc')) {
        this.appState.preferredVideoPlayer = '/Applications/VLC.app/Contents/MacOS/VLC';
      }

      this.cd.detectChanges();
    });

    // Happens on a Mac when the OS Dark Mode is enabled/disabled
    this.electronService.ipcRenderer.on('os-dark-mode-change', (event, desiredMode: string) => {

      const darkModeOn: boolean = this.settingsButtons['darkMode'].toggled;

      if (darkModeOn && desiredMode === 'light') {
        this.toggleButton('darkMode');
        this.cd.detectChanges();
      } else if (!darkModeOn && desiredMode === 'dark') {
        this.toggleButton('darkMode');
        this.cd.detectChanges();
      }
    });

    // TODO -- update 'source connected' thingy
    this.electronService.ipcRenderer.on('directory-now-connected', (event, sourceIndex: number, sourcePath: string) => {

      // TODO -- if this error never happens, all is well; remove the `sourcePath` from this method :)
      if (this.sourceFolderService.selectedSourceFolder[sourceIndex]?.path !== sourcePath) {
        console.log('WARNING HUGE ERROR HERE !!!!!! MUST NEVER HAPPEN !!!');
        return;
      }

      this.sourceFolderService.sourceFolderConnected[sourceIndex] = true;

      let preferredLocationChanged = false;
      this.imageElementService.imageElements.forEach((element: ImageElement) => {
        try {
          const availableLocation = selectAvailableImageLocation(
            element,
            (candidateSourceIndex: number) => (
              this.sourceFolderService.sourceFolderConnected[candidateSourceIndex] === true
            ),
          );
          if (availableLocation && promoteImageLocation(element, availableLocation)) {
            preferredLocationChanged = true;
          }
        } catch {
          return;
        }
      });
      if (preferredLocationChanged) {
        this.imageElementService.finalArrayNeedsSaving = true;
        this.resetFinalArrayRef();
      }
    });

    this.electronService.ipcRenderer.on('started-watching-this-dir', (
      event,
      sourceIndex: number,
      relativeScope = '',
    ) => {
      if (
        !this.sourceFolderService.selectedSourceFolder[sourceIndex]
        || !this.sourceFolderService.setActiveScanScope(sourceIndex, relativeScope)
      ) {
        console.error('Ignoring an invalid folder scan start:', sourceIndex, relativeScope);
        return;
      }
      this.allFinishedScanning = false;
      this.sourceFolderService.addCurrentScanning(sourceIndex);
    });

    // Only a complete successful scan can mark catalogue paths as missing.
    // Missing entries remain saved so temporary storage outages are reversible.
    this.electronService.ipcRenderer.on('all-files-found-in-dir', (
      event,
      sourceIndex: number,
      allFilesMap: Map<string, 1>,
      scannedSourcePath?: string,
      relativeScope = '',
      discoveredRelativeFolders: string[] = [],
    ) => {
      let normalizedScope: string;
      try {
        normalizedScope = normalizeSourceFolderRelativePath(relativeScope);
      } catch {
        console.error('Ignoring a folder scan result with an invalid scope:', sourceIndex, relativeScope);
        return;
      }

      if (this.sourceFolderService.getActiveScanScope(sourceIndex) !== normalizedScope) {
        console.warn('Ignoring a stale folder scan result:', sourceIndex, normalizedScope);
        return;
      }

      const sourceFolder = this.sourceFolderService.selectedSourceFolder[sourceIndex];
      if (
        !(allFilesMap instanceof Map)
        || !sourceFolder
        || !Array.isArray(discoveredRelativeFolders)
        || !this.folderScanPathMatches(sourceIndex, scannedSourcePath)
      ) {
        console.error('Ignoring an invalid folder scan result:', sourceIndex);
        this.finishFolderScan(sourceIndex, normalizedScope);
        return;
      }

      const attachmentResult = attachKnownLocationsFromSnapshot(
        this.imageElementService.imageElements,
        sourceIndex,
        this.sourceFolderService.selectedSourceFolder,
        allFilesMap,
      );
      const missingResult = reconcileMissingFolderEntriesInScope(
        this.imageElementService.imageElements,
        sourceIndex,
        sourceFolder.path,
        normalizedScope,
        allFilesMap,
      );
      this.sourceFolderService.replaceDiscoveredDirectoriesInScope(
        sourceIndex,
        normalizedScope,
        discoveredRelativeFolders,
      );
      this.finishFolderScan(sourceIndex, normalizedScope);

      if (attachmentResult.ambiguousPaths > 0) {
        console.warn(
          'Some overlapping media paths matched multiple catalogue entries and were not merged:',
          attachmentResult.ambiguousPaths,
        );
      }
      if (attachmentResult.changedEntries > 0 || missingResult.changedEntries > 0) {
        this.imageElementService.finalArrayNeedsSaving = true;
        this.deletePipeTrigger = !this.deletePipeTrigger;
        this.resetFinalArrayRef();
      }
    });

    // A persistent watcher can discover an exact path already represented by
    // another configured source after its initial scan. Attach that one alias
    // without rerunning metadata or thumbnail extraction.
    this.electronService.ipcRenderer.on('known-source-location-found', (
      event,
      sourceIndex: number,
      fullPath: string,
      scannedSourcePath?: string,
    ) => {
      if (
        typeof fullPath !== 'string'
        || !this.folderScanPathMatches(sourceIndex, scannedSourcePath)
      ) {
        return;
      }
      const result = attachKnownLocationsFromSnapshot(
        this.imageElementService.imageElements,
        sourceIndex,
        this.sourceFolderService.selectedSourceFolder,
        new Map<string, 1>([[fullPath, 1]]),
      );
      if (result.changedEntries > 0) {
        this.imageElementService.finalArrayNeedsSaving = true;
        this.deletePipeTrigger = !this.deletePipeTrigger;
        this.debounceImport();
      }
    });

    this.electronService.ipcRenderer.on('folder-scan-failed', (
      event,
      sourceIndex: number,
      message: string,
      relativeScope = '',
    ) => {
      console.warn('Folder scan did not complete; catalogue entries were left unchanged:', message);
      let normalizedScope: string;
      try {
        normalizedScope = normalizeSourceFolderRelativePath(relativeScope);
      } catch {
        return;
      }
      this.finishFolderScan(sourceIndex, normalizedScope);
    });

    this.electronService.ipcRenderer.on('folder-watch-error', (
      event,
      sourceIndex: number,
      message: string,
    ) => {
      console.warn(
        'The active folder watcher reported a transient error; catalogue metadata was left unchanged:',
        sourceIndex,
        message,
      );
    });

    this.electronService.ipcRenderer.on('folder-scan-request-rejected', (
      event,
      sourceIndex: number,
      message: string,
    ) => {
      console.warn('Folder scan request was rejected:', sourceIndex, message);
      this.zone.run(() => {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.folderScanBusy'),
        );
      });
    });

    this.electronService.ipcRenderer.on('source-folder-directories-updated', (
      event,
      sourceIndex: number,
      discoveredRelativeFolders: string[],
    ) => {
      if (
        !this.sourceFolderService.selectedSourceFolder[sourceIndex]
        || !Array.isArray(discoveredRelativeFolders)
      ) {
        return;
      }
      if (this.sourceFolderService.replaceDiscoveredDirectoriesInScope(
        sourceIndex,
        '',
        discoveredRelativeFolders,
      )) {
        this.cd.detectChanges();
      }
    });

    // When `watch` folder and `chokidar` detects a file was deleted (can happen when renamed too!)
    // mark the element as missing without discarding its saved metadata.
    this.electronService.ipcRenderer.on('single-file-deleted', (event, sourceIndex: number, partialPath: string) => {
      let normalizedDeletedPath: string;
      let deletedPhysicalPath: string;
      try {
        normalizedDeletedPath = normalizeSourceFolderRelativePath(partialPath);
        const sourceFolder = this.sourceFolderService.selectedSourceFolder[Number(sourceIndex)];
        if (!sourceFolder?.path) {
          throw new Error('The deleted file source is no longer configured.');
        }
        deletedPhysicalPath = this.normalizePhysicalPathKey(
          path.resolve(sourceFolder.path, normalizedDeletedPath),
        );
      } catch {
        console.warn('Ignoring a deleted-file notification with an invalid path.');
        return;
      }

      let changed = false;
      this.imageElementService.imageElements.forEach((element: ImageElement) => {
        if (element.deleted === true) {
          return;
        }
        let matchingLocations: ImageLocation[];
        try {
          matchingLocations = getImageLocations(element)
            .filter((location: ImageLocation) => (
              this.physicalPathKey(location) === deletedPhysicalPath
            ));
        } catch {
          return;
        }
        if (matchingLocations.length === 0) {
          return;
        }
        matchingLocations.forEach((matchingLocation: ImageLocation) => {
          const didChange = markImageLocationsMissingInScope(
            element,
            matchingLocation.inputSource,
            '',
            (location: ImageLocation) => this.physicalPathKey(location) !== deletedPhysicalPath,
          );
          changed = didChange || changed;
        });
      });

      if (changed) {
        console.log('FILE MISSING:', partialPath);
        this.imageElementService.finalArrayNeedsSaving = true;
        this.deletePipeTrigger = !this.deletePipeTrigger;
      }
    });

    /**
     * Update thumbnail extraction progress when node sends update
     * @param current - the current number that finished extracting
     * @param total   - the total number of files to be extracted
     * @param stage   - `ImportStage` type
     */
    this.electronService.ipcRenderer.on('import-progress-update', (
      event,
      current: number,
      total: number,
      stage: ImportStage
    ) => {

      this.importStage = stage;

      if (this.isFirstRunEver) {
        this.showFirstRunMessage();
      }

      if (current === 1) {
        this.timeExtractionStarted = new Date().getTime();
      }

      if (current > 3) {
        const thisInstant = new Date().getTime();
        const timeElapsed = thisInstant - this.timeExtractionStarted;
        this.timeExtractionRemaining = Math.round((total - current) * (timeElapsed / current) / 1000); // convert MS to seconds
        if (this.timeExtractionRemaining < 1) {
          this.timeExtractionRemaining = 0;
        }
      }

      const percentProgress: number = Math.round(100 * current / total);
      this.progressString = 'loading - ' + percentProgress + '%';
      this.extractionPercent = percentProgress;

      this.cd.detectChanges(); // seems needed to update the donut
    });

    // Final object returns
    this.electronService.ipcRenderer.on('final-object-returning', (
      event,
      finalObject: FinalObject,
      pathToFile: string,
      outputFolderPath: string,
      catalogueSettingsNormalized = false,
      catalogueAccessMode: CatalogueAccessMode = 'read-write',
    ) => {

      // Treat every returned document as a new session, even when reloading
      // the same path. Keep any cancelled regeneration as a blocking
      // tombstone until its terminal callback arrives, because the existing
      // main-process protocol does not echo an individual request ID.
      this.catalogueSessionGeneration += 1;
      this.cancelIndividualThumbnailRegenerationForCatalogueLoad();

      // console.log('input dirs', finalObject.inputDirs);
      // reset to initial
      this.currentClickedItem = undefined;
      this.lastRenamedFileHack = undefined;
      this.imageElementService.finalArrayNeedsSaving = false;
      this.catalogueAccessMode = catalogueAccessMode === 'read-only' ? 'read-only' : 'read-write';
      this.catalogueEditorOpen = false;

      this.currentScreenshotSettings = finalObject.screenshotSettings;
      const thumbnailMetadataNormalized = normalizeCatalogueThumbnailCounts(
        finalObject.images,
        finalObject.screenshotSettings,
      );

      this.appState.currentVhaFile = pathToFile;
      this.appState.selectedOutputFolder = outputFolderPath;

      this.appState.hubName = finalObject.hubName;
      this.appState.numOfFolders = finalObject.numOfFolders;

      this.sourceFolderService.resetTransientState();
      this.sourceFolderService.selectedSourceFolder = finalObject.inputDirs;
      this.sourceFolderService.resetConnected();

      // Update history of opened files
      this.updateVhaFileHistory(pathToFile, finalObject.hubName);

      this.folderViewNavigationPath = '';

      this.manualTagsService.removeAllTags();
      this.manualTagsService.loadTagDefinitions(finalObject.tagDefinitions);
      this.manualTagsService.populateManualTagsService(finalObject.images);
      this.manualTagsService.loadTagColors(finalObject.tagColors);

      this.setTags(finalObject.addTags, finalObject.removeTags); // auto-tags

      this.imageElementService.imageElements = finalObject.images;
      if (!this.catalogueReadOnly && (thumbnailMetadataNormalized || catalogueSettingsNormalized)) {
        this.imageElementService.finalArrayNeedsSaving = true;
      }

      this.canCloseWizard = true;
      this.wizard.showWizard = false;
      this.flickerReduceOverlay = false;

      // reset the Word Cloud
      this.wordFrequencyService.computeFrequencyArray(this.imageElementService.imageElements.length, 165);

      this.fixManualTagTrayBreakingBug(); // hack -- TODO: fix

      this.setUpDurationFilterValues(this.imageElementService.imageElements);
      this.setUpSizeFilterValues(this.imageElementService.imageElements);
      this.setUpTimesPlayedFilterValues(this.imageElementService.imageElements);
      this.setUpYearFilterValues(this.imageElementService.imageElements);

      const sortOrderRef = this.sortOrderRef();
      const sortFilterElement = sortOrderRef.sortFilterElement();
      if (sortFilterElement) {
        sortFilterElement.nativeElement.value = this.sortType;
      }

      this.cd.detectChanges();
      this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
      this.catalogueOpenCoordinator.markRendererStartupComplete();
      this.catalogueOpenCoordinator.finishOpen();
    });

    // If no previously saved settings exist, this gets sent over
    this.electronService.ipcRenderer.on('set-language-based-off-system-locale', (event, localeString: string) => {
      if (!this.hasResolvedInitialTheme) {
        this.settingsButtons['darkMode'].toggled = true;
        this.hasResolvedInitialTheme = true;
        this.syncAppIconTheme();
      }
      if (localeString) {
        this.setOrRestoreLanguage(undefined, localeString);
      }
    });

    // Returning settings
    this.electronService.ipcRenderer.on('settings-returning', (
      event,
      settingsObject: SettingsObject,
      locale: string,
      requestedCataloguePath?: string,
    ) => {
      this.vhaFileHistory = (settingsObject.vhaFileHistory || []);
      const hasSavedTheme = typeof settingsObject.buttonSettings?.darkMode?.toggled === 'boolean';
      this.restoreSettingsFromBefore(settingsObject);
      if (!hasSavedTheme) {
        this.settingsButtons['darkMode'].toggled = true;
      }
      this.hasResolvedInitialTheme = true;
      this.syncAppIconTheme();
      this.setOrRestoreLanguage(settingsObject.appState.language, locale);
      if (settingsObject.wizardOptions) {
        this.wizard = settingsObject.wizardOptions;
      }
      if (this.appState.currentZoomLevel !== 1) {
        this.electronService.webFrame.setZoomFactor(this.appState.currentZoomLevel);
        this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
      }
      const cataloguePathToOpen = requestedCataloguePath || settingsObject.appState.currentVhaFile;
      if (cataloguePathToOpen) {
        this.loadThisVhaFile(cataloguePathToOpen);
      } else {
        this.showOpeningWizard(false);
        this.catalogueOpenCoordinator.markRendererStartupComplete();
      }
      if (settingsObject.shortcuts) {
        this.shortcutService.initializeFromSaved(settingsObject.shortcuts);
      }
    });

    this.electronService.ipcRenderer.on('please-open-wizard', (event, firstRun, failedPath?: string) => {
      // Correlated with the first time ever starting the app !!!
      // Can happen when no settings present
      // Can happen when trying to open a catalogue file that no longer exists
      this.showOpeningWizard(firstRun, failedPath);
      this.catalogueOpenCoordinator.markRendererStartupComplete();
      this.catalogueOpenCoordinator.finishOpen();
    });

    this.electronService.ipcRenderer.on('legacy-catalogue-duplicated', (event, fileName: string) => {
      this.zone.run(() => {
        this.modalService.openSnackbar(this.translate.instant(
          'SYSTEM.legacyCatalogueDuplicateSuccess',
          { fileName },
        ));
      });
    });

    this.electronService.ipcRenderer.on('catalogue-loaded-from-backup', (
      event,
      details: CatalogueLoadedFromBackupDetails = {},
    ) => {
      this.zone.run(() => this.showCatalogueLoadedFromBackup(details));
    });

    this.electronService.ipcRenderer.on('catalogue-read-only-write-blocked', (event, channel?: string) => {
      this.zone.run(() => {
        this.unwindReadOnlyMutationState(channel);
        this.showReadOnlyActionBlocked();
      });
    });

    // gets called if `trash` successfully removed the file
    this.electronService.ipcRenderer.on('file-deleted', (event, element: ImageElement) => {
      // spot check it's the same element
      // just in case the message comes back after user has switched to view another hub
      if (element.fileName === this.imageElementService.imageElements[element.index].fileName) {
        this.imageElementService.imageElements[element.index].deleted = true;
        this.deletePipeTrigger = !this.deletePipeTrigger;
        this.imageElementService.finalArrayNeedsSaving = true;
        this.cd.detectChanges();
      }
    });

    // gets called for every element that node extracted metadata for (screenshots not yet extracted)
    this.electronService.ipcRenderer.on('new-video-meta', (
      event,
      element: ImageElement,
      scannedSourcePath?: string,
    ) => {

      if (!this.folderScanPathMatches(Number(element.inputSource), scannedSourcePath)) {
        console.warn('Ignoring metadata returned for a source folder that has since changed.');
        return;
      }

      // if this video was just renamed from within the app do not add the element, skip it
      if (   this.lastRenamedFileHack // undefined unless file recently renamed
          && this.lastRenamedFileHack.inputSource === element.inputSource
          && this.lastRenamedFileHack.partialPath === element.partialPath
          && this.lastRenamedFileHack.fileName    === element.fileName
      ) {
        console.log('SKIPPING THIS -- was just renamed !!!');
        return;
      }

      if (this.attachOverlappingSourceLocation(element)) {
        return;
      }

      // A failed path is intentionally rescanned. Replace its path-only entry
      // rather than appending a duplicate, preserving any user-entered data.
      const existingFailureIndex = this.imageElementService.imageElements.findIndex((currentElement) => {
        return isMetadataImportFailure(currentElement)
          && Number(currentElement.inputSource) === Number(element.inputSource)
          && currentElement.partialPath === element.partialPath
          && currentElement.fileName === element.fileName;
      });

      if (existingFailureIndex !== -1) {
        const existingFailure = this.imageElementService.imageElements[existingFailureIndex];
        const probeStillFailed = isMetadataImportFailure(element);
        copyRecoveredEntryMetadata(element, existingFailure);
        element.tags = (existingFailure.tags || []).filter((tag) => {
          return probeStillFailed || tag !== IMPORT_ERROR_TAG;
        });

        if (probeStillFailed && !element.tags.includes(IMPORT_ERROR_TAG)) {
          element.tags.push(IMPORT_ERROR_TAG);
        }
        if (!probeStillFailed) {
          delete element.metadataImportFailed;
          if (this.manualTagsService.tagsFrequencyMap.has(IMPORT_ERROR_TAG)) {
            this.manualTagsService.removeTag(IMPORT_ERROR_TAG);
          }
        }

        element.index = existingFailureIndex;
        this.imageElementService.imageElements[existingFailureIndex] = element;
        this.imageElementService.finalArrayNeedsSaving = true;
        this.resetFinalArrayRef();
        return;
      }

      // if the element is part of any of the deleted videos, copy over the metadata into it !
      // important for when user renames a folder for example
      const deletedOrigin = findDeletedMetadataOrigin(
        element,
        this.imageElementService.imageElements,
      );
      const inheritedExistingMetadata = deletedOrigin !== undefined;
      const probeStillFailed = isMetadataImportFailure(element);
      if (deletedOrigin) {
        copyRecoveredEntryMetadata(element, deletedOrigin);
      }

      if (!inheritedExistingMetadata) {
        ensureDateAddedForNewEntry(element);
      }
      if (probeStillFailed) {
        element.metadataImportFailed = true;
        element.tags = element.tags || [];
        if (!element.tags.includes(IMPORT_ERROR_TAG)) {
          element.tags.push(IMPORT_ERROR_TAG);
        }
        this.manualTagsService.addTag(IMPORT_ERROR_TAG);
      } else if (element.tags?.includes(IMPORT_ERROR_TAG)) {
        delete element.metadataImportFailed;
        element.tags = element.tags.filter((tag: string) => tag !== IMPORT_ERROR_TAG);
        if (this.manualTagsService.tagsFrequencyMap.has(IMPORT_ERROR_TAG)) {
          this.manualTagsService.removeTag(IMPORT_ERROR_TAG);
        }
      }

      if (
        deletedOrigin
        && replaceRecoveredFolderEntry(
          this.imageElementService.imageElements,
          element,
          deletedOrigin,
        ) !== undefined
      ) {
        this.imageElementService.finalArrayNeedsSaving = true;
        this.resetFinalArrayRef();
        return;
      }

      element.index = this.imageElementService.imageElements.length;
      this.imageElementService.imageElements.push(element); // not enough for view to update; we need `.slice()`
      this.imageElementService.finalArrayNeedsSaving = true;
      this.debounceImport();
    });

    this.justStarted();
  }

  private finishFolderScan(sourceIndex: number, expectedScope?: string): void {
    if (
      expectedScope !== undefined
      && this.sourceFolderService.getActiveScanScope(sourceIndex) !== expectedScope
    ) {
      return;
    }
    this.sourceFolderService.clearActiveScanScope(sourceIndex);
    this.sourceFolderService.removeCurrentScanning(sourceIndex);
    this.allFinishedScanning = this.sourceFolderService.areAllFinishedScanning();
    if (this.allFinishedScanning) {
      console.log('Folder scanning complete.');
    }
    this.cd.detectChanges();
  }

  private folderScanPathMatches(sourceIndex: number, scannedSourcePath?: string): boolean {
    if (!scannedSourcePath) {
      return true;
    }
    const currentSourcePath = this.sourceFolderService.selectedSourceFolder[sourceIndex]?.path;
    return Boolean(currentSourcePath)
      && path.normalize(currentSourcePath) === path.normalize(scannedSourcePath);
  }

  /**
   * A parent and child source can resolve to the same physical video. Keep one
   * logical entry and attach the newly verified source location instead of
   * duplicating user metadata. Hash equality corroborates path identity; hash
   * equality alone is deliberately insufficient because identical copies are
   * legitimate separate files.
   */
  private attachOverlappingSourceLocation(incomingElement: ImageElement): boolean {
    let incomingLocation: ImageLocation;
    let incomingPhysicalPath: string;
    try {
      incomingLocation = normalizeImageLocation(incomingElement);
      incomingPhysicalPath = this.physicalPathKey(incomingLocation);
    } catch {
      return false;
    }

    const matches = this.imageElementService.imageElements.filter((candidate: ImageElement) => {
      if (candidate.deleted === true) {
        return false;
      }
      try {
        return getImageLocations(candidate).some((location: ImageLocation) => (
          this.physicalPathKey(location) === incomingPhysicalPath
        ));
      } catch {
        return false;
      }
    });

    if (matches.length > 1) {
      console.warn(
        'An overlapping import matched multiple existing entries; the incoming duplicate was suppressed.',
        incomingPhysicalPath,
      );
      return true;
    }
    if (matches.length === 0) {
      return false;
    }

    const target = matches[0];
    const incomingFailed = isMetadataImportFailure(incomingElement);
    const targetFailed = isMetadataImportFailure(target);

    if (!incomingFailed && (targetFailed || target.hash !== incomingElement.hash)) {
      const targetIndex = this.imageElementService.imageElements.indexOf(target);
      copyRecoveredEntryMetadata(incomingElement, target);
      incomingElement.locations = getImageLocations(target);
      normalizeImageElementLocations(incomingElement);
      attachImageLocation(incomingElement, incomingLocation);
      incomingElement.tags = (incomingElement.tags || []).filter((tag: string) => (
        tag !== IMPORT_ERROR_TAG
      ));
      delete incomingElement.metadataImportFailed;
      incomingElement.index = target.index;
      this.imageElementService.imageElements[targetIndex] = incomingElement;
      this.imageElementService.finalArrayNeedsSaving = true;
      this.deletePipeTrigger = !this.deletePipeTrigger;
      this.debounceImport();
      return true;
    }

    const changed = attachImageLocation(target, incomingLocation);
    if (changed) {
      this.imageElementService.finalArrayNeedsSaving = true;
      this.deletePipeTrigger = !this.deletePipeTrigger;
      this.debounceImport();
    }
    return true;
  }

  private physicalPathKey(location: ImageLocation): string {
    const source = this.sourceFolderService.selectedSourceFolder[location.inputSource];
    if (!source?.path) {
      throw new Error('The media source no longer exists.');
    }
    const relativeFolder = normalizeSourceFolderRelativePath(location.partialPath);
    return this.normalizePhysicalPathKey(
      path.resolve(source.path, relativeFolder, location.fileName),
    );
  }

  private normalizePhysicalPathKey(value: string): string {
    const resolvedPath = path.normalize(value);
    return this.electronService.platform === 'win32'
      ? resolvedPath.toLocaleLowerCase('en-US')
      : resolvedPath;
  }

  // =======================================================================================================================================
  // =======================================================================================================================================
  // =======================================================================================================================================

  ngAfterViewInit() {
    const gallery = document.getElementById('scrollDiv');
    if (gallery && typeof ResizeObserver !== 'undefined') {
      this.observedGalleryWidth = gallery.getBoundingClientRect().width;
      this.galleryResizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]) => {
        const width = entries.find((entry: ResizeObserverEntry) => entry.target === gallery)
          ?.contentRect.width;
        if (
          width === undefined
          || !Number.isFinite(width)
          || width <= 0
          || Math.abs(width - this.observedGalleryWidth) < 0.5
        ) {
          return;
        }
        this.observedGalleryWidth = width;
        this.scheduleGalleryLayoutRefresh(GALLERY_RESIZE_SETTLE_MS);
      });
      this.galleryResizeObserver.observe(gallery);
    }
    this.scheduleGalleryLayoutRefresh();

    // this is required, otherwise when user drops the file, it opens as plaintext
    document.ondragover = document.ondrop = (ev) => {
      ev.preventDefault();
    };
    document.body.ondrop = (ev) => {
      const droppedFile = ev.dataTransfer?.files.item(0);
      if (!droppedFile) {
        return;
      }

      ev.preventDefault();
      try {
        const fullPath = this.electronService.getPathForFile(droppedFile);
        if (isSupportedCatalogueFilePath(fullPath)) {
          this.loadThisVhaFile(fullPath);
        }
      } catch (error) {
        console.error('Unable to resolve the dropped catalogue path:', error);
      }
    };
  }

  ngOnDestroy(): void {
    this.catalogueOpenCoordinator.disconnect();
    this.cataloguePersistenceIpc.disconnect();
    this.thumbnailRegenerationIpc.disconnect();
    this.folderThumbnailRegenerationSession.clear();
    this.individualThumbnailRegenerationStatus = null;
    this.stopThumbnailRegenerationClockIfIdle();
    this.galleryResizeObserver?.disconnect();
    clearTimeout(this.galleryLayoutRefreshTimeout);
    if (this.galleryLayoutRefreshFrame !== undefined) {
      cancelAnimationFrame(this.galleryLayoutRefreshFrame);
      this.galleryLayoutRefreshFrame = undefined;
    }
  }

  /**
   * Tell Electron to drag a file out of the app into the system
   * Used for dragging videos into video editors like Vgeas and Premiere
   */
  draggingVideoFile(event, item: ImageElement): void {
    event.preventDefault();
    const projectedItem = this.filePathService.projectToAvailableImageLocation(item);
    if (!projectedItem) {
      this.modalService.openSnackbar(this.translate.instant('SETTINGS.rootFolderNotLive'));
      return;
    }
    this.electronService.ipcRenderer.send('drag-video-out-of-electron', projectedItem);
  }

  /**
   * Only update the view after enough changes occurred
   * - update after every new element when < 20 elements total
   * - update every 20 new elements after until 100; every 100 thereafter
   * - update at most 3 seconds after the last element arrived
   */
  public debounceImport(): void {
    this.newVideoImportCounter++;

    clearTimeout(this.newVideoImportTimeout);

    if (    this.imageElementService.imageElements.length < 20
        || (this.imageElementService.imageElements.length < 100 && this.newVideoImportCounter === 20)
        || this.newVideoImportCounter === 100
    ) {
      this.resetFinalArrayRef();
    } else {
      this.newVideoImportTimeout = setTimeout(() => {
        this.resetFinalArrayRef();
      }, 3000);
    }
  }

  /**
   * Helper method only to be used by `debounceImport()`
   */
  private resetFinalArrayRef(): void {
    clearTimeout(this.newVideoImportTimeout);
    this.newVideoImportTimeout = null;
    this.newVideoImportCounter = 0;
    this.imageElementService.imageElements = this.imageElementService.imageElements.slice();
    this.cd.detectChanges();
  }

  /**
   * Delete from finalArray all the video files with particular source index
   * @param sourceIndex
   */
  deleteInputSourceFiles(sourceIndex: number): void {
    this.imageElementService.imageElements.forEach((element: ImageElement) => {
      try {
        const result = removeImageLocationsForSource(element, Number(sourceIndex));
        if (!result.changed) {
          return;
        }
        if (result.survivingLocationCount === 0) {
          element.deleted = true;
        } else {
          delete element.deleted;
        }
        this.imageElementService.finalArrayNeedsSaving = true;
      } catch (error) {
        console.warn('Unable to detach an invalid media location safely:', error);
      }
    });
    this.deletePipeTrigger = !this.deletePipeTrigger;
  }

  /**
   * Include or ignore one non-root source subtree. Ignoring first builds a
   * non-mutating catalogue plan so the source preference and media locations
   * can be applied together after any required metadata warning.
   */
  toggleIgnoredSubdirectory(target: FolderScopeTarget): void {
    const sourceIndex = Number(target?.sourceIndex);
    let relativePath: string;
    try {
      relativePath = normalizeSourceFolderRelativePath(target?.relativePath);
    } catch {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.ignoredSubdirectoryUnavailable'),
      );
      return;
    }

    const sourceFolder = this.sourceFolderService.selectedSourceFolder[sourceIndex];
    if (
      !Number.isSafeInteger(sourceIndex)
      || sourceIndex < 0
      || relativePath === ''
      || !sourceFolder
      || this.folderThumbnailRegenerationStatus !== null
      || this.sourceFolderService.currentlyScanning.get(sourceIndex) === true
    ) {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.ignoredSubdirectoryUnavailable'),
      );
      return;
    }

    let currentIgnored: string[];
    try {
      currentIgnored = normalizeIgnoredSubdirectories(sourceFolder.ignoredSubdirectories);
    } catch {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.ignoredSubdirectoryUnavailable'),
      );
      return;
    }

    if (currentIgnored.includes(relativePath)) {
      const nextIgnored = normalizeIgnoredSubdirectories(
        currentIgnored.filter((scope: string) => scope !== relativePath),
      );
      const expectedHubFile = this.appState.currentVhaFile;
      const sourcePath = sourceFolder.path;
      void this.requestIgnoredSubdirectoryUpdate(
        sourceIndex,
        nextIgnored,
        this.imageElementService.imageElements,
      ).then((result) => {
        const currentFolder = this.sourceFolderService.selectedSourceFolder[sourceIndex];
        if (
          this.appState.currentVhaFile !== expectedHubFile
          || !currentFolder
          || currentFolder.path !== sourcePath
        ) {
          this.modalService.openSnackbar(
            this.translate.instant('STATISTICS.ignoredSubdirectorySelectionChanged'),
          );
          return;
        }
        this.writeIgnoredSubdirectories(currentFolder, nextIgnored);
        this.imageElementService.finalArrayNeedsSaving = true;
        this.restartSourceAfterIgnoredSubdirectoryUpdate(
          sourceIndex,
          sourcePath,
          result.wasWatching,
          relativePath,
        );
        this.cd.detectChanges();
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.includeSubdirectoryComplete'),
        );
      }).catch(() => {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.ignoredSubdirectoryUnavailable'),
        );
      });
      return;
    }

    let plan: IgnoredSourceFolderRemovalPlan;
    let nextIgnored: string[];
    try {
      plan = planIgnoredSourceFolderRemoval(
        this.imageElementService.imageElements,
        sourceIndex,
        relativePath,
      );
      nextIgnored = normalizeIgnoredSubdirectories([...currentIgnored, relativePath]);
    } catch {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.ignoredSubdirectoryUnavailable'),
      );
      return;
    }

    const sourcePath = sourceFolder.path;
    const expectedHubFile = this.appState.currentVhaFile;
    const expectedIgnored = currentIgnored.join('\0');
    const applyPlan = async (currentPlan: IgnoredSourceFolderRemovalPlan): Promise<void> => {
      const currentFolder = this.sourceFolderService.selectedSourceFolder[sourceIndex];
      if (
        this.appState.currentVhaFile !== expectedHubFile
        || !currentFolder
        || currentFolder.path !== sourcePath
      ) {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.ignoredSubdirectorySelectionChanged'),
        );
        return;
      }

      let result: { applied: true; ignoredSubdirectories: string[]; wasWatching: boolean };
      try {
        result = await this.requestIgnoredSubdirectoryUpdate(
          sourceIndex,
          nextIgnored,
          currentPlan.nextElements,
        );
      } catch {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.ignoredSubdirectoryUnavailable'),
        );
        return;
      }

      const folderAfterUpdate = this.sourceFolderService.selectedSourceFolder[sourceIndex];
      if (
        this.appState.currentVhaFile !== expectedHubFile
        || !folderAfterUpdate
        || folderAfterUpdate.path !== sourcePath
      ) {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.ignoredSubdirectorySelectionChanged'),
        );
        return;
      }

      this.writeIgnoredSubdirectories(folderAfterUpdate, nextIgnored);
      currentPlan.nextElements.forEach((element: ImageElement, index: number) => {
        element.index = index;
      });
      this.imageElementService.imageElements = currentPlan.nextElements;
      this.imageElementService.finalArrayNeedsSaving = true;
      this.restartSourceAfterIgnoredSubdirectoryUpdate(
        sourceIndex,
        sourcePath,
        result.wasWatching,
      );
      this.refreshAfterIgnoredSubdirectoryRemoval();
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.ignoredSubdirectoryComplete'),
      );
    };

    if (plan.metadataAffectedEntryCount === 0) {
      void applyPlan(plan);
      return;
    }

    const folderPath = path.join(sourcePath, ...relativePath.split('/'));
    const folderName = path.basename(folderPath) || folderPath;
    this.modalService.openConfirmationDialog({
      cancelLabel: this.translate.instant('SYSTEM.cancel'),
      confirmLabel: this.translate.instant('STATISTICS.ignoreSubdirectory'),
      facts: [
        { label: 'Folder', value: folderPath },
        { label: 'Source locations removed', value: plan.removedLocationCount },
        { label: 'Catalogue entries removed', value: plan.removedEntryCount },
        { label: 'Entries kept via another location', value: plan.retainedSharedEntryCount },
        { label: 'Metadata-bearing entries removed', value: plan.metadataRemovedEntryCount },
        { label: 'Metadata preserved via another location', value: plan.metadataRetainedSharedEntryCount },
      ],
      summary: this.translate.instant('STATISTICS.confirmIgnoreSubdirectorySummary', {
        folderName,
      }),
      supportingText: `${this.translate.instant(
        'STATISTICS.ignoredSubdirectoryMetadataWarning',
        { count: plan.metadataAffectedEntryCount },
      )} ${this.translate.instant('STATISTICS.confirmIgnoreSubdirectorySupportingText')}`,
      title: this.translate.instant('STATISTICS.confirmIgnoreSubdirectoryTitle'),
      tone: 'destructive',
    }).subscribe((confirmed: boolean) => {
      if (!confirmed || this.appState.currentVhaFile !== expectedHubFile) {
        return;
      }

      const currentFolder = this.sourceFolderService.selectedSourceFolder[sourceIndex];
      let currentPlan: IgnoredSourceFolderRemovalPlan;
      try {
        if (
          !currentFolder
          || currentFolder.path !== sourcePath
          || this.sourceFolderService.currentlyScanning.get(sourceIndex) === true
          || normalizeIgnoredSubdirectories(currentFolder.ignoredSubdirectories).join('\0') !== expectedIgnored
        ) {
          throw new Error('The source folder changed.');
        }
        currentPlan = planIgnoredSourceFolderRemoval(
          this.imageElementService.imageElements,
          sourceIndex,
          relativePath,
        );
      } catch {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.ignoredSubdirectorySelectionChanged'),
        );
        return;
      }

      if (!this.ignoredSourceFolderPlansMatch(plan, currentPlan)) {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.ignoredSubdirectorySelectionChanged'),
        );
        return;
      }
      void applyPlan(currentPlan);
    });
  }

  private requestIgnoredSubdirectoryUpdate(
    sourceIndex: number,
    ignoredSubdirectories: string[],
    postChangeCatalogue: ImageElement[],
  ): Promise<{ applied: true; ignoredSubdirectories: string[]; wasWatching: boolean }> {
    return this.electronService.ipcRenderer.invoke(
      'update-source-folder-ignored-subdirectories',
      sourceIndex,
      ignoredSubdirectories,
      postChangeCatalogue,
    ).then((result) => {
      if (
        result?.applied !== true
        || typeof result.wasWatching !== 'boolean'
        || normalizeIgnoredSubdirectories(result.ignoredSubdirectories).join('\0')
          !== ignoredSubdirectories.join('\0')
      ) {
        throw new Error('The source-folder exclusion update was not acknowledged.');
      }
      return result;
    });
  }

  private restartSourceAfterIgnoredSubdirectoryUpdate(
    sourceIndex: number,
    sourcePath: string,
    wasWatching: boolean,
    rescanRelativePath?: string,
  ): void {
    if (wasWatching) {
      this.electronService.ipcRenderer.send(
        'start-watching-folder',
        sourceIndex,
        sourcePath,
        true,
        this.appState.generatePreviewsOnFolderAddition,
      );
      return;
    }
    if (rescanRelativePath !== undefined) {
      this.electronService.ipcRenderer.send(
        'rescan-source-folder-scope',
        sourceIndex,
        rescanRelativePath,
        this.appState.generatePreviewsOnFolderAddition,
      );
    }
  }

  private writeIgnoredSubdirectories(folder: SourceFolder, scopes: string[]): void {
    if (scopes.length === 0) {
      delete folder.ignoredSubdirectories;
    } else {
      folder.ignoredSubdirectories = scopes;
    }
  }

  private ignoredSourceFolderPlansMatch(
    expected: IgnoredSourceFolderRemovalPlan,
    current: IgnoredSourceFolderRemovalPlan,
  ): boolean {
    return expected.affectedEntryCount === current.affectedEntryCount
      && expected.affectedEntrySignatures.join('\0') === current.affectedEntrySignatures.join('\0')
      && expected.metadataAffectedEntryCount === current.metadataAffectedEntryCount
      && expected.metadataRemovedEntryCount === current.metadataRemovedEntryCount
      && expected.metadataRetainedSharedEntryCount === current.metadataRetainedSharedEntryCount
      && expected.removedEntryCount === current.removedEntryCount
      && expected.removedLocationCount === current.removedLocationCount
      && expected.retainedSharedEntryCount === current.retainedSharedEntryCount;
  }

  private refreshAfterIgnoredSubdirectoryRemoval(): void {
    const previouslySelected = this.currentClickedItem;
    this.deletePipeTrigger = !this.deletePipeTrigger;
    this.manualTagsService.rebuildFromImages(this.imageElementService.imageElements);
    this.wordFrequencyService.computeFrequencyArray(this.imageElementService.imageElements.length, 165);
    this.ifShowDetailsViewRefreshTags();

    if (previouslySelected) {
      const replacement = this.imageElementService.imageElements.find((element: ImageElement) => (
        element.uuid === previouslySelected.uuid
      ));
      if (replacement) {
        this.currentClickedItemName = replacement.cleanName;
        this.updateCurrentClickedItem(replacement);
      } else {
        this.currentClickedItem = undefined;
        this.currentClickedItemName = '';
      }
    }

    this.cd.detectChanges();
    setTimeout(() => this.virtualScroller()?.refresh(), 0);
  }

  /**
   * Handle dropping something over an item in the gallery
   * Used to handle dropping a .jpg file to replace preview!
   * @param event         drop event - containing path to possible jpg file
   * @param galleryItem   item in the gallery over which jpg was dropped
   */
  droppedSomethingOverVideo(event: DragEvent, galleryItem: ImageElement): void {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return;
    }

    const droppedFile = dataTransfer.files.item(0);
    if (droppedFile) {
      event.preventDefault();
      event.stopPropagation();

      if (galleryItem.cleanName === '*FOLDER*') {
        return;
      }

      try {
        const pathToNewImage = this.electronService.getPathForFile(droppedFile);
        const extension = path.extname(pathToNewImage).toLowerCase();
        if (['.jpg', '.jpeg', '.png'].includes(extension)) {
          if (this.blockActionDuringFolderThumbnailRegeneration()) {
            return;
          }
          this.electronService.ipcRenderer.send('replace-thumbnail', pathToNewImage, galleryItem);
        }
      } catch (error) {
        console.error('Unable to resolve the dropped image path:', error);
      }
      return;
    }

    // this occurs when a tag is dropped on a video from the tag tray
    if (dataTransfer.getData('text')) {
      // tag previously set by `dragStart` in `view-tags.component`
      const tag: string = dataTransfer.getData('text');

      this.addTagToThisElement(tag, galleryItem);

      this.ifShowDetailsViewRefreshTags();

      return;
    }
  }

  /**
   * Low-tech debounced window resize
   * @param msDelay - number of milliseconds to debounce; defaults to the gallery transition time
   */
  public debounceUpdateMax(msDelay?: number): void {
    const delay = msDelay !== undefined ? msDelay : GALLERY_LAYOUT_TRANSITION_MS;
    this.scheduleGalleryLayoutRefresh(delay);
  }

  /**
   * Recalculate gallery geometry before clearing cached row measurements.
   * ngx-virtual-scroller performs its own refresh after invalidation, so a
   * second `refresh()` would incorrectly report an items-array change.
   */
  private scheduleGalleryLayoutRefresh(delay = 0, resetScroll = false): void {
    this.pendingGalleryScrollReset ||= resetScroll;
    clearTimeout(this.galleryLayoutRefreshTimeout);
    if (this.galleryLayoutRefreshFrame !== undefined) {
      cancelAnimationFrame(this.galleryLayoutRefreshFrame);
      this.galleryLayoutRefreshFrame = undefined;
    }
    this.galleryLayoutRefreshTimeout = setTimeout(() => {
      const gallery = document.getElementById('scrollDiv');
      const scroller = this.virtualScroller();
      if (!gallery || !scroller) {
        this.pendingGalleryScrollReset = false;
        return;
      }

      this.computePreviewWidth();
      this.cd.detectChanges();
      this.galleryLayoutRefreshFrame = requestAnimationFrame(() => {
        scroller.invalidateAllCachedMeasurements();
        if (this.pendingGalleryScrollReset) {
          gallery.scrollTop = 0;
        }
        this.pendingGalleryScrollReset = false;
        this.galleryLayoutRefreshFrame = undefined;
      });
    }, delay);
  }

  /**
   * Summon a dialog to open a default video player
   */
  public chooseDefaultVideoPlayer(): void {
    this.electronService.ipcRenderer.send('select-default-video-player');
  }

  // ---------------- INTERACT WITH ELECTRON ------------------ //

  /**
   * Send initial `hello` message
   * triggers function that grabs settings and sends them back with `settings-returning`
   */
  public justStarted(): void {
    this.electronService.ipcRenderer.send('just-started');
  }

  public loadThisVhaFile(fullPath: string): void {
    this.catalogueOpenCoordinator.requestOpen(fullPath);
  }

  private chooseLegacyCatalogueOpen(
    fullPath: string,
  ): Promise<LegacyCatalogueOpenChoice | undefined> {
    return this.zone.run(() => {
      // A restored legacy catalogue needs a fresh access decision. Reveal the
      // decision before opening it so the startup cover cannot hide the modal.
      if (this.flickerReduceOverlay) {
        this.flickerReduceOverlay = false;
        this.cd.detectChanges();
      }
      return firstValueFrom(
        this.modalService.openChoiceDialog<LegacyCatalogueOpenChoice>({
          cancelLabel: this.translate.instant('SYSTEM.cancel'),
          choices: [
            {
              description: this.translate.instant('SYSTEM.legacyCatalogueReadOnlyDescription'),
              id: 'read-only',
              label: this.translate.instant('SYSTEM.legacyCatalogueReadOnlyLabel'),
            },
            {
              description: this.translate.instant('SYSTEM.legacyCatalogueDuplicateDescription'),
              id: 'duplicate-scaena',
              label: this.translate.instant('SYSTEM.legacyCatalogueDuplicateLabel'),
              primary: true,
            },
          ],
          summary: this.translate.instant('SYSTEM.legacyCatalogueDialogSummary', {
            fileName: path.basename(fullPath),
          }),
          supportingText: this.translate.instant('SYSTEM.legacyCatalogueDialogSupportingText'),
          title: this.translate.instant('SYSTEM.legacyCatalogueDialogTitle'),
        }),
      );
    });
  }

  private handleLegacyCatalogueOpenCancelled(fullPath: string): void {
    // Cancelling a manual switch keeps the existing catalogue. During initial
    // startup there is no committed session to return to, so show the wizard.
    if (this.catalogueSessionGeneration === 0) {
      this.showOpeningWizard(false, fullPath);
    }
  }

  public loadFromFile(): void {
    if (this.blockActionDuringFolderThumbnailRegeneration()) {
      return;
    }
    this.electronService.ipcRenderer.send('system-open-file-through-modal');
  }

  private showOpeningWizard(firstRun: boolean, failedPath?: string): void {
    this.zone.run(() => {
      if (!this.hasResolvedInitialTheme) {
        this.settingsButtons['darkMode'].toggled = true;
        this.hasResolvedInitialTheme = true;
        this.syncAppIconTheme();
      }
      if (firstRun) {
        this.firstRunLogic();
      }

      this.importStage = 'done';
      this.catalogueEditorOpen = false;
      this.settingsModalOpen = false;
      this.flickerReduceOverlay = false;
      if (
        failedPath
        && this.appState.currentVhaFile === failedPath
        && this.imageElementService.imageElements.length === 0
      ) {
        this.appState.currentVhaFile = '';
      }
      this.wizard.showWizard = true;
      this.cd.detectChanges();
    });
  }

  public saveCurrentVhaFile(): void {
    if (this.catalogueEditorSaving || this.blockActionDuringFolderThumbnailRegeneration()) {
      return;
    }

    if (this.catalogueReadOnly) {
      this.catalogueEditorSaveStatus = 'Read only';
      this.showReadOnlyActionBlocked();
      return;
    }

    const finalObjectToSave = this.getFinalObjectForSaving();

    if (finalObjectToSave === null) {
      this.catalogueEditorSaveStatus = 'No changes to save';
      return;
    }

    this.catalogueEditorSaving = true;
    this.catalogueEditorSaveStatus = '';
    this.cataloguePersistenceIpc.saveCatalogue(finalObjectToSave);
  }

  public selectSourceDirectory(): void {
    this.electronService.ipcRenderer.send('choose-input');
  }

  public selectOutputDirectory(): void {
    this.electronService.ipcRenderer.send('choose-output');
  }

  public importFresh(): void {
    if (this.blockActionDuringFolderThumbnailRegeneration()) {
      return;
    }
    this.sourceFolderService.resetTransientState();
    this.sourceFolderService.selectedSourceFolder = this.wizard.selectedSourceFolder;
    this.appState.selectedOutputFolder = this.wizard.selectedOutputFolder;
    this.electronService.ipcRenderer.send('start-the-import', this.wizard);
  }

  public cancelCurrentImport(): void {
    this.electronService.ipcRenderer.send('cancel-current-import');
    setTimeout(() => {
      this.importStage = 'done';
      this.cd.detectChanges();
    }, 10); // just in case delay
  }

  public initiateMinimize(): void {
    this.electronService.ipcRenderer.send('minimize-window');
  }

  public initiateMaximize(): void {
    if (this.appMaximized) {
      this.electronService.ipcRenderer.send('un-maximize-window');
      this.appMaximized = false;
    } else {
      this.electronService.ipcRenderer.send('maximize-window');
      this.appMaximized = true;
    }
  }

  public initiateClose(): void {
    this.isClosing = true;
    this.savePreviousViewSize();
    this.appState.imgsPerRow = this.imgsPerRow;
    this.cataloguePersistenceIpc.requestClose(
      this.getSettingsForSave(),
      this.getFinalObjectForSaving(),
    );
  }

  /**
   * Returns the finalArray if needed, otherwise returns `null`
   * completely depends on global variable `finalArrayNeedsSaving` or if any tags were added/removed in auto-tag-service
   */
  public getFinalObjectForSaving(): FinalObject | null {
    return this.catalogueSessionDocument.documentForSave({
      accessMode: this.catalogueAccessMode,
      hubName: this.appState.hubName,
      numOfFolders: this.appState.numOfFolders,
      screenshotSettings: this.currentScreenshotSettings,
    });
  }

  public async exportVha2Catalogue(): Promise<void> {
    if (this.catalogueReadOnly || !/\.scaena$/i.test(this.appState.currentVhaFile || '')) {
      this.showReadOnlyActionBlocked();
      return;
    }

    const confirmed = await firstValueFrom(this.modalService.openConfirmationDialog({
      cancelLabel: this.translate.instant('SYSTEM.cancel'),
      confirmLabel: this.translate.instant('SYSTEM.exportVha2ConfirmLabel'),
      detailsLabel: this.translate.instant('SYSTEM.exportVha2ImpactDetailsLabel'),
      facts: [
        {
          label: this.translate.instant('SYSTEM.exportVha2FormatLabel'),
          value: this.translate.instant('SYSTEM.exportVha2FormatValue'),
        },
        {
          label: this.translate.instant('SYSTEM.exportVha2DeletedEntriesLabel'),
          value: this.translate.instant('SYSTEM.exportVha2OmittedValue'),
        },
        {
          label: this.translate.instant('SYSTEM.exportVha2ForkMetadataLabel'),
          value: this.translate.instant('SYSTEM.exportVha2NotIncludedValue'),
        },
      ],
      summary: this.translate.instant('SYSTEM.exportVha2ConfirmSummary'),
      supportingText: this.translate.instant('SYSTEM.exportVha2CompatibilityWarning'),
      title: this.translate.instant('SYSTEM.exportVha2ConfirmTitle'),
      tone: 'warning',
    }));
    if (!confirmed) {
      return;
    }

    try {
      const result = await this.electronService.ipcRenderer.invoke(
        'export-vha2-catalogue',
        this.catalogueSessionDocument.buildDocument({
          accessMode: this.catalogueAccessMode,
          hubName: this.appState.hubName,
          numOfFolders: this.appState.numOfFolders,
          screenshotSettings: this.currentScreenshotSettings,
        }),
      ) as Vha2ExportResult;
      if (result.status === 'exported' && result.fileName) {
        this.modalService.openSnackbar(this.translate.instant('SYSTEM.exportVha2Success', {
          fileName: result.fileName,
        }));
      } else if (result.status === 'error' || result.status === 'read-only') {
        this.modalService.openSnackbar(result.error || this.translate.instant('SYSTEM.exportVha2Failed'));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || '');
      this.modalService.openSnackbar(
        detail
          ? `${this.translate.instant('SYSTEM.exportVha2Failed')}: ${detail}`
          : this.translate.instant('SYSTEM.exportVha2Failed'),
      );
    }
  }

  /**
   * Handle clicking on an item in the gallery
   *
   * @param eventObject - VideoClickEmit
   * @param item        - ImageElement
   * @param doubleClick - boolean -- happens only on `app-file-item` -- added as a quick hack
   */
  public handleClick(eventObject: VideoClickEmit, item: ImageElement, doubleClick?: boolean) {

    console.log(item);

    if (this.batchTaggingMode) {
      this.tagBatchModeSelectionChangedTrigger = Date.now();
      item.selected = !item.selected;

      return;
    }

    if (this.settingsButtons.doubleClickMode.toggled && !(eventObject.doubleClick || doubleClick)) {
      // when double-clicking, this runs twice anyway
      this.assignSelectedFile(item);

      return;
    }

    // ctrl + shift => set thumbnail as favorite
    if (eventObject.mouseEvent.ctrlKey === true && eventObject.mouseEvent.shiftKey) {
      this.imageElementService.HandleEmission({
        index: item.index,
        defaultScreen: eventObject.thumbIndex as number
      });

      return;
    }

    // ctrl/cmd + click for thumbnail sheet
    if (eventObject.mouseEvent.ctrlKey === true || eventObject.mouseEvent.metaKey) {
      this.openThumbnailSheet(item);
    } else if (eventObject.mouseEvent.shiftKey === true) {
      // If Shift key is pressed, open the file in the explorer
      this.currentRightClickedItem = item; // to make `openContainingFolderNow()` work correctly
      this.openContainingFolderNow();
    }else {
      this.openVideo(item, eventObject.thumbIndex);
      //  `openVideo` method handles the `not connected` case
    }
  }

  /**
   * Open the video with user's default media player
   * or with their preferred media player, if chosen
   *
   * @param item                  clicked ImageElement
   * @param clickedThumbnailIndex an index of the thumbnail clicked
   */
  public openVideo(item: ImageElement, clickedThumbnailIndex?: number): void {

    const location = this.filePathService.getAvailableImageLocation(item);
    if (!location) {
      console.log('not connected!');
      this.modalService.openSnackbar(this.translate.instant('SETTINGS.rootFolderNotLive'));

      return;
    }

    this.imageElementService.updateNumberOfTimesPlayed(item.index);

    this.updateCurrentClickedItem(item);

    this.currentPlayingFolder = location.partialPath;
    this.currentClickedItemName = item.cleanName;
    const projectedItem = this.filePathService.projectToAvailableImageLocation(item);
    if (!projectedItem) {
      this.modalService.openSnackbar(this.translate.instant('SETTINGS.rootFolderNotLive'));
      return;
    }
    const fullPath = this.filePathService.getPathFromImageLocation(location);
    this.fullPathToCurrentFile = fullPath;
    this.currentMediaOperationItem = projectedItem;

    if (this.appState.preferredVideoPlayer) {
      const time: number = clickedThumbnailIndex
        ? item.duration / (item.screens + 1) * ((clickedThumbnailIndex) + 1)
        : 0;

      const timestamp = this.settingsButtons['openAtTimestamp'].toggled ? time : 0;
      this.electronService.ipcRenderer.send('open-media-file-at-timestamp', projectedItem, timestamp);
    } else {
      this.electronService.ipcRenderer.send('open-media-file', projectedItem);
    }
  }

  /**
   * handle right-click and `Open folder`
   */
  openContainingFolderNow(): void {
    const location = this.filePathService.getAvailableImageLocation(this.currentRightClickedItem);
    if (!location) {
      this.modalService.openSnackbar(this.translate.instant('SETTINGS.rootFolderNotLive'));
      return;
    }
    this.fullPathToCurrentFile = this.filePathService.getPathFromImageLocation(location);
    this.currentMediaOperationItem = this.filePathService.projectToAvailableImageLocation(
      this.currentRightClickedItem,
    ) || null;
    this.openInExplorer();
  }

  public increaseZoomLevel(): void {
    if (this.appState.currentZoomLevel < 2.5) {
      this.appState.currentZoomLevel = this.appState.currentZoomLevel + 0.1;
      this.electronService.webFrame.setZoomFactor(this.appState.currentZoomLevel);
      this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
    }
  }

  public decreaseZoomLevel(): void {
    if (this.appState.currentZoomLevel > 0.6) {
      this.appState.currentZoomLevel = this.appState.currentZoomLevel - 0.1;
      this.electronService.webFrame.setZoomFactor(this.appState.currentZoomLevel);
      this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
    }
  }

  public resetZoomLevel(): void {
    if (this.appState.currentZoomLevel !== 1) {
      this.appState.currentZoomLevel = 1;
      this.electronService.webFrame.setZoomFactor(this.appState.currentZoomLevel);
      this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
    }
  }

  // -----------------------------------------------------------------------------------------------

  /**
   * Add filter to tag search when word in word cloud or tag tray is clicked
   * @param filter - particular tag clicked
   */
  handleTagWordClicked(
    filter: string,
    event?: PointerEvent,
    branchMatch = false,
    exactMatch = false,
  ): void {
    if (this.batchTaggingMode) {
      this.addTagToManyVideos(filter);
      return;
    }

    if (branchMatch && !this.settingsButtons['manualTags'].toggled) {
      this.settingsButtons['manualTags'].toggled = true;
    }

    if (  // if all tags disabled, perform a FILE search
         !branchMatch
      && !this.settingsButtons['manualTags'].toggled
      && !this.settingsButtons['autoFileTags'].toggled
      && !this.settingsButtons['autoFolderTags'].toggled
    ) {
      this.handleFileWordClicked(filter, event);
      return;
    }

    this.showSidebar();
    if (event && event.shiftKey) { // Shift click to exclude tag!
      if (!this.settingsButtons['tagExclusion'].toggled) {
        this.settingsButtons['tagExclusion'].toggled = true;
      }
      this.onEnterKey(filter, 8, branchMatch, exactMatch); // 8th item is the `tagExclusion` filter
    } else {
      if (!this.settingsButtons['tagIntersection'].toggled) {
        this.settingsButtons['tagIntersection'].toggled = true;
      }
      this.onEnterKey(filter, 7, branchMatch, exactMatch); // 7th item is the `tagIntersection` filter
    }
  }

  /** Keep structured tag filters aligned after a hierarchy branch is moved. */
  handleTagHierarchyMoved(move: TagHierarchyMoveEmission): void {
    let filtersChanged = false;

    [6, 7, 8].forEach((filterIndex: number) => {
      const filter = this.filters[filterIndex];
      const originalBranchPaths = filter.branchPaths || [];
      const originalExactPaths = filter.exactPaths || [];
      const originalStructuredPaths = originalBranchPaths.concat(originalExactPaths);
      const remapPath = (path: string): string => (
        isTagInBranch(path, move.sourcePath)
          ? remapTagBranchPath(path, move.sourcePath, move.destinationPath)
          : path
      );
      const nextBranchPaths = this.uniqueTagPaths(originalBranchPaths.map(remapPath));
      const nextExactPaths = this.uniqueTagPaths(originalExactPaths.map(remapPath))
        .filter((exactPath: string) => !nextBranchPaths.some((branchPath: string) => (
          tagPathsEqual(branchPath, exactPath)
        )));
      const nextArray: string[] = [];

      filter.array.forEach((value: string) => {
        const structuredPath = originalStructuredPaths.find((path: string) => (
          tagPathsEqual(path, value)
        ));
        const nextValue = structuredPath ? remapPath(structuredPath) : value;
        if (!nextArray.some((existingValue: string) => (
          structuredPath
            ? tagPathsEqual(existingValue, nextValue)
            : existingValue === nextValue
        ))) {
          nextArray.push(nextValue);
        }
      });

      nextBranchPaths.concat(nextExactPaths).forEach((path: string) => {
        if (!nextArray.some((value: string) => tagPathsEqual(value, path))) {
          nextArray.push(path);
        }
      });

      const changed = JSON.stringify(filter.array) !== JSON.stringify(nextArray)
        || JSON.stringify(originalBranchPaths) !== JSON.stringify(nextBranchPaths)
        || JSON.stringify(originalExactPaths) !== JSON.stringify(nextExactPaths);
      if (!changed) {
        return;
      }

      filter.array = nextArray;
      filter.branchPaths = nextBranchPaths;
      filter.exactPaths = nextExactPaths;
      filter.bool = !filter.bool;
      filtersChanged = true;
    });

    this.tagTypeAhead = '';
    this.ifShowDetailsViewRefreshTags();
    if (filtersChanged) {
      this.scrollToTop();
    }
  }

  private uniqueTagPaths(paths: readonly string[]): string[] {
    return paths.reduce((uniquePaths: string[], path: string) => {
      if (!uniquePaths.some((existingPath: string) => tagPathsEqual(existingPath, path))) {
        uniquePaths.push(path);
      }
      return uniquePaths;
    }, []);
  }

  /**
   * Add filter to FILE search when word in file is clicked
   * @param filter
   */
  handleFileWordClicked(filter: string, event?): void {
    this.showSidebar();
    if (event && event.shiftKey) { // Shift click to exclude tag!
      if (!this.settingsButtons['exclude'].toggled) {
        this.settingsButtons['exclude'].toggled = true;
      }
      this.onEnterKey(filter, 5); // 5th item is the `exclude` filter in `FilterKeyNames`
    } else {
      if (!this.settingsButtons['fileIntersection'].toggled) {
        this.settingsButtons['fileIntersection'].toggled = true;
      }
      this.onEnterKey(filter, 4); // 4th item is the `fileIntersection` filter in `FilterKeyNames`
    }
  }

  /**
   * Add filter to FOLDER search when word in folder is clicked
   * @param filter
   */
  handleFolderWordClicked(filter: string, event?): void {
    this.showSidebar();
    if (event && event.shiftKey) { // Shift click to exclude tag!
      if (!this.settingsButtons['folderExclusion'].toggled) {
        this.settingsButtons['folderExclusion'].toggled = true;
      }
      this.onEnterKey(filter, 2); // 2nd item is the `folderExclusion` filter in `FilterKeyNames`
    } else {
      if (!this.settingsButtons['folderIntersection'].toggled) {
        this.settingsButtons['folderIntersection'].toggled = true;
      }
      this.onEnterKey(filter, 1); // 1st item is the `folder` filter
    }
  }
  /**
   * Handle clicking on FOLDER in gallery, or the folder icon in breadcrumbs, or the `UP` folder
   * @param filter
   */
  handleFolderIconClicked(filter: string): void {
    if (this.folderNavigationScrollOffset === 0) {
      this.folderNavigationScrollOffset = this.virtualScroller().viewPortInfo.scrollStartPosition;
    }

    this.folderViewNavigationPath = filter;

    this.scrollAppropriately(filter);
  }

  /**
   * Handle clicking on a particular breadcrumb
   * @param idx is roughly index of the folder depth clicked
   */
  handleBbreadcrumbClicked(idx: number): void {
    this.folderViewNavigationPath = this.folderViewNavigationPath.split('/').slice(0, idx + 1).join('/');
    this.scrollToTop();
  }

  /**
   * Scroll appropriately after navigating back to root folder
   *
   * Rather hacky thing, but works in the basic case
   * Fails if user enters folder, changes some search or sort filter, and navigates back
   */
  scrollAppropriately(filter: string) {
    if (filter === '') {
      setTimeout(() => {
        this.virtualScroller().scrollToPosition(this.folderNavigationScrollOffset, 0);
        this.folderNavigationScrollOffset = 0;
      }, 1);
    } else {
      this.scrollToTop();
    }
  }

  /**
   * Go back to root and scroll to last-seen location
   */
  breadcrumbHomeIconClick(): void {
    this.folderViewNavigationPath = '';
    this.scrollAppropriately('');
  }

  /**
   * Open folder that contains the (current) clicked file
   */
  openInExplorer(): void {
    if (this.currentMediaOperationItem) {
      this.electronService.ipcRenderer.send('open-in-explorer', this.currentMediaOperationItem);
    }
  }

  /**
   * Show sidebar if it's closed
   */
  showSidebar(): void {
    if (this.settingsButtons['hideSidebar'].toggled) {
      this.toggleButton('hideSidebar');
      this.computePreviewWidth();
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Interaction functions

  /**
   * Add this file to the recently opened list
   * @param file full path to file name
   */
  updateVhaFileHistory(pathToVhaFile: string, hubName: string): void {

    const newHistoryItem = {
      vhaFilePath: pathToVhaFile,
      hubName: (hubName || 'untitled')
    };

    let matchFound = false;

    (this.vhaFileHistory || []).forEach((element: any, index: number) => {
      if (element.vhaFilePath === pathToVhaFile) {
        matchFound = true;
        // remove from current position
        this.vhaFileHistory.splice(index, 1);
        this.vhaFileHistory.splice(0, 0, newHistoryItem);
      }
    });

    if (!matchFound) {
      this.vhaFileHistory.unshift(newHistoryItem);
    }
  }

  /**
   * Handle click from html to open a recently-opened VHA file
   * @param index - index of the file from `vhaFileHistory`
   */
  openFromHistory(index: number): void {
    this.loadThisVhaFile(this.vhaFileHistory[index].vhaFilePath);
  }

  /**
   * Handle click from html to open a recently-opened VHA file
   * @param index - index of the file from `vhaFileHistory`
   */
  removeFromHistory(index: number): void {
    this.vhaFileHistory.splice(index, 1);
  }

  /**
   * Clear out the recently-viewed history
   */
  clearRecentlyViewedHistory(): void {
    this.vhaFileHistory = [];
    this.electronService.ipcRenderer.send('clear-recent-documents');
  }

  /**
   * Reset the Times Played metric for every file in the current hub.
   */
  resetTimesPlayed(): void {
    this.imageElementService.resetTimesPlayed();
    this.timesPlayedCutoff = 0;
    this.timesPlayedLeftBound = -1;
    this.timesPlayedRightBound = Infinity;
    this.modalService.openSnackbar(this.translate.instant('SETTINGS.timesPlayedReset'));
  }

  /**
   * Show or hide settings
   */
  toggleSettings(): void {
    this.settingTabToShow = 2;
    this.settingsModalOpen = !this.settingsModalOpen;
  }

  hideWizard(): void {
    this.wizard.showWizard = false;
  }

  /**
   * Handle auto-generated tag clicked: add it to file search filter
   * @param event
   */
  autoTagClicked(event: string): void {
    this.handleFileWordClicked(event);
    this.toggleButton('showTags'); // close the modal
  }

  /**
   * Toggles all views buttons off
   * A helper function for `toggleBotton`
   */
  toggleAllViewsButtonsOff(): void {
    this.settingsButtons['showClips'].toggled = false;
    this.settingsButtons['showDetails'].toggled = false;
    this.settingsButtons['showDetails2'].toggled = false;
    this.settingsButtons['showFiles'].toggled = false;
    this.settingsButtons['showFilmstrip'].toggled = false;
    this.settingsButtons['showFullView'].toggled = false;
    this.settingsButtons['showThumbnails'].toggled = false;
  }

  /**
   * Toggles all TRAY views buttons off
   * A helper function for `toggleBotton`
   */
  toggleAllTrayViewsButtonsOff(): void {
    this.settingsButtons['showDetailsTray'].toggled = false;
    this.settingsButtons['showFreq'].toggled = false;
    this.settingsButtons['showRecentlyPlayed'].toggled = false;
    this.settingsButtons['showRelatedVideosTray'].toggled = false;
    this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
  }

  /**
   * Helper method for `toggleButton` to set `toggled` boolean true
   * @param uniqueKey
   */
  toggleButtonTrue(uniqueKey: SettingsButtonKey): void {
    this.settingsButtons[uniqueKey].toggled = true;
  }

  /**
   * Helper method for `toggleButton` to set `toggled` boolean to its opposite
   * @param uniqueKey
   */
  toggleButtonOpposite(uniqueKey: SettingsButtonKey): void {
    this.settingsButtons[uniqueKey].toggled = !this.settingsButtons[uniqueKey].toggled;
  }

  /**
   * Save the current view image size
   */
  savePreviousViewSize(): void {
    this.imgsPerRow[this.appState.currentView] = this.currentImgsPerRow;
  }

  /**
   * Restore the image height for the particular view
   */
  restoreViewSize(view: string): void {
    this.currentImgsPerRow = this.imgsPerRow[view] || 5; // showDetails2 view does not exist when upgrading to 2.2.3
  }

  /**
   * Handle custom shortcut action
   * summoned via `handleKeyboardEvent`
   * @param event - keyboard event
   * @param shortcutAction - CustomShortcutAction
   */
  handleCustomShortcutAction(event: KeyboardEvent, shortcutAction: CustomShortcutAction): void {
    switch (shortcutAction) {

      case ('toggleSettings'):
        if (this.wizard.showWizard === false) {
          this.toggleSettings();
        }
        break;

      case ('showAutoTags'):
        if (!this.wizard.showWizard) {
          this.toggleButton('showTags');
        }
        break;

      case ('showTagTray'):
        if (!this.wizard.showWizard) {
          this.toggleButton('showTagTray');
        }
        break;

      case ('quit'):
        event.preventDefault();
        event.stopPropagation();
        this.initiateClose();
        break;

      case ('startWizard'):
        this.startWizard();
        this.settingsModalOpen = false;
        this.settingsButtons['showTags'].toggled = false;
        break;

      case ('toggleMinimalMode'):
        this.toggleButton('hideTop');
        this.toggleButton('hideSidebar');
        this.toggleButtonOff('showTagTray');
        this.toggleRibbon();
        this.toggleButton('showMoreInfo');
        break;

      case ('focusOnFile'):
        if (this.settingsButtons['fileIntersection'].toggled === false) {
          this.settingsButtons['fileIntersection'].toggled = true;
        }
        this.showSidebar();
        setTimeout(() => {
          const searchRef = this.searchRef();
          if (searchRef.nativeElement.querySelector('#fileIntersection')) {
            searchRef.nativeElement.querySelector('#fileIntersection').focus();
          }
        }, 1);
        break;

      case ('focusOnMagic'):
        if (!this.settingsButtons['magic'].toggled) {
          this.settingsButtons['magic'].toggled = true;
        }
        this.showSidebar();
        setTimeout(() => {
          this.magicSearch().nativeElement.focus();
        }, 1);
        break;

      case ('fuzzySearch'):
        if (!this.settingsButtons['fuzzy'].toggled) {
          this.settingsButtons['fuzzy'].toggled = true;
        }
        this.showSidebar();
        setTimeout(() => {
          this.fuzzySearch().nativeElement.focus();
        }, 1);
        break;
    }

  }

  /**
   * Perform appropriate action when a button is clicked
   * @param   uniqueKey   the uniqueKey string of the button
   * @param   fromIpc     boolean value indicate, call from IPC
   */
  toggleButton(uniqueKey: SettingsButtonKey | SupportedView | SupportedTrayView, fromIpc = false): void {
    // ======== View buttons ================
    if (AllSupportedViews.includes(<SupportedView>uniqueKey)) {
      this.savePreviousViewSize();
      this.toggleAllViewsButtonsOff();
      this.toggleButtonTrue(uniqueKey);
      this.restoreViewSize(uniqueKey);
      this.appState.currentView = <SupportedView>uniqueKey;
      this.computeTextBufferAmount();
      this.scheduleGalleryLayoutRefresh(0, true);

      // ======== Right-side tag panel ===============================
    } else if (uniqueKey === 'showTagTray') {
      const openingTagPanel = !this.settingsButtons['showTagTray'].toggled;
      if (!openingTagPanel && this.batchTaggingMode) {
        this.toggleBatchTaggingMode();
      }
      this.settingsButtons['showTagTray'].toggled = openingTagPanel;
      this.cd.detectChanges();
      this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);

      // ======== Bottom tray views buttons =========================
    } else if (AllSupportedBottomTrayViews.includes(<SupportedTrayView>uniqueKey)) {
      const stateBeforeClick: boolean = this.settingsButtons[uniqueKey].toggled;
      this.toggleAllTrayViewsButtonsOff();
      if (this.batchTaggingMode) {
        this.toggleBatchTaggingMode();
      }
      this.settingsButtons[uniqueKey].toggled = !stateBeforeClick;

      if (
             (uniqueKey === 'showRelatedVideosTray' && this.settingsButtons['showRelatedVideosTray'].toggled)
          || (uniqueKey === 'showRecentlyPlayed'    && this.settingsButtons['showRecentlyPlayed'].toggled)
      ) {
        this.computePreviewWidth();
      }
      this.cd.detectChanges();

      // ======== Filter buttons =========================
    } else if (FilterKeyNames.includes(uniqueKey)) {
      const filter = this.filters[filterKeyToIndex[uniqueKey]];
      filter.array = [];
      filter.branchPaths = [];
      filter.exactPaths = [];
      filter.bool = !filter.bool;
      this.toggleButtonOpposite(uniqueKey);
    } else if (uniqueKey === 'magic') {
      this.magicSearchString = '';
      this.toggleButtonOpposite(uniqueKey);
    } else if (uniqueKey === 'fuzzy') {
      this.fuzzySearchString = '';
      this.toggleButtonOpposite(uniqueKey);
    } else if (uniqueKey === 'startsWith') {
      this.startsWithSearchString = '';
      this.toggleButtonOpposite(uniqueKey);
      // ======== Other buttons ========================
    } else if (uniqueKey === 'compactView') {
      this.toggleButtonOpposite(uniqueKey);
      this.computeTextBufferAmount();
      this.scheduleGalleryLayoutRefresh();
    } else if (uniqueKey === 'showFolders') {
      this.toggleButtonOpposite('showFolders');
      if (!this.settingsButtons['showFolders'].toggled) {
        this.folderViewNavigationPath = '';
      }
      this.scrollToTop();
    } else if (uniqueKey === 'makeSmaller') {
      this.decreaseSize();
    } else if (uniqueKey === 'makeLarger') {
      this.increaseSize();
    } else if (uniqueKey === 'startWizard') {
      this.startWizard();
    } else if (uniqueKey === 'clearHistory') {
      this.clearRecentlyViewedHistory();
    } else if (uniqueKey === 'resetSettings') {
      this.resetSettingsToDefault();
    } else if (uniqueKey === 'resetTimesPlayed') {
      this.resetTimesPlayed();
    } else if (uniqueKey === 'showTags') {
      if (this.settingsModalOpen) {
        this.settingsModalOpen = false;
      }
      this.toggleButtonOpposite('showTags');
    } else if (uniqueKey === 'playPlaylist') {
      const availablePlaylist = this.pipeSideEffectService.galleryShowing
        .map((item: ImageElement): ImageElement | undefined => {
          try {
            return this.filePathService.projectToAvailableImageLocation(item);
          } catch {
            return undefined;
          }
        })
        .filter((item: ImageElement | undefined): item is ImageElement => item !== undefined);
      this.electronService.ipcRenderer.send(
        'please-create-playlist',
        availablePlaylist,
      );
    } else if (uniqueKey === 'sortOrder') {
      this.toggleButtonOpposite(uniqueKey);
      setTimeout(() => {
        const sortOrderRef = this.sortOrderRef();
        const sortFilterElement = sortOrderRef.sortFilterElement();
        if (sortFilterElement) { // just in case, perform check
          sortFilterElement.nativeElement.value = this.sortType;
        }
      });
    } else if (uniqueKey === 'shuffleGalleryNow') {
      this.sortType = 'random';
      this.shuffleTheViewNow++;
      this.scrollToTop();
      // if sort filter is NOT showin on the sidebar, enable
      if (!this.sortOrderRef().sortFilterElement()) {
        this.settingsButtons['sortOrder'].toggled = true;
      }
      // and set the setting-option to `Random' after timeout to update view
      setTimeout(() => {
        const sortOrderRef = this.sortOrderRef();
        const sortFilterElement = sortOrderRef.sortFilterElement();
        if (sortFilterElement) { // just in case, perform check
          sortFilterElement.nativeElement.value = 'random';
        }
      });
    }
    else if(uniqueKey === 'clearAllFilters'){
      this.clearAllFilters();
    }
    else {
      this.toggleButtonOpposite(uniqueKey);
      if (uniqueKey === 'showMoreInfo') {
        this.computeTextBufferAmount();
        this.scheduleGalleryLayoutRefresh();
      }
      if (uniqueKey === 'hideSidebar') {
        this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
      }
      if (uniqueKey === 'hideTop') {
        this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
      }
    }
    if (uniqueKey === 'darkMode') {
      this.syncAppIconTheme();
    }
    if (!fromIpc) {
      this.electronService.ipcRenderer.send('app-to-touchBar', uniqueKey);
    } else {
      this.cd.detectChanges();
    }
  }

  public toggleButtonOff(uniqueKey: SettingsButtonKey | SupportedView | SupportedTrayView): void {
    if (this.settingsButtons[uniqueKey].toggled) {
      this.settingsButtons[uniqueKey].toggled = false;
    }
  }

  /**
   * scroll to the top of the gallery
   */
  public scrollToTop(): void {
    document.getElementById('scrollDiv').scrollTop = 0;
  }

  /**
   * Start the wizard again
   */
  public startWizard(): void {
    if (this.blockActionDuringFolderThumbnailRegeneration()) {
      return;
    }
    this.wizard = {
      clipHeight: 144, // default = half the screenshot height
      clipSnippetLength: 1,
      clipSnippets: 5,
      extractClips: false,
      futureHubName: '',
      isFixedNumberOfScreenshots: this.wizard.isFixedNumberOfScreenshots ?? true,
      screenshotSizeForImport: this.wizard.screenshotSizeForImport ?? 288, // default
      selectedOutputFolder: '',
      selectedSourceFolder: { 0: { path: '', watch: false }},
      showWizard: true,
      ssConstant: this.wizard.ssConstant ?? 10,
      ssVariable: this.wizard.ssVariable ?? 5,
    };
    this.toggleSettings();
  }


  // ==========================================================================================
  // Methods for RESCAN
  // ==========================================================================================

  /**
   * Decrease preview size
   */
  public decreaseSize(): void {
    if (this.appState.currentView === 'showFiles') {
      return;
    }
    this.currentImgsPerRow++;
    this.scheduleGalleryLayoutRefresh();
  }

  /**
   * Increase preview size
   */
  public increaseSize(): void {
    if (this.appState.currentView === 'showFiles') {
      return;
    }
    if (this.appState.currentView === 'showDetails') {
      if (this.currentImgsPerRow > 2) {
        this.currentImgsPerRow--;
      }
    } else if (this.appState.currentView === 'showDetails2') {
      if (this.currentImgsPerRow > 3) {
        this.currentImgsPerRow--;
      }
    } else if (this.currentImgsPerRow > 1) {
      this.currentImgsPerRow--;
    }
    this.scheduleGalleryLayoutRefresh();
  }

  /**
   * Computes the preview width for thumbnails view
   */
  public computePreviewWidth(): void {
    const gallery = document.getElementById('scrollDiv');
    if (!gallery) {
      return;
    }

    const geometry = this.galleryLayoutService.calculateGeometry({
      compactView: this.settingsButtons.compactView.toggled,
      containerWidth: gallery.getBoundingClientRect().width,
      currentPreviewWidth: this.previewWidth,
      imagesPerRow: this.currentImgsPerRow,
      relatedTrayVisible:
           this.settingsButtons.showRelatedVideosTray.toggled
        || this.settingsButtons.showRecentlyPlayed.toggled,
      view: this.appState.currentView,
    });

    if (geometry.galleryWidth !== undefined) {
      this.galleryWidth = geometry.galleryWidth;
    }
    if (geometry.previewWidth !== undefined) {
      this.previewWidth = geometry.previewWidth;
    }
    if (geometry.previewHeight !== undefined) {
      this.previewHeight = geometry.previewHeight;
    }
    if (geometry.previewWidthRelated !== undefined) {
      this.previewWidthRelated = geometry.previewWidthRelated;
    }
    if (geometry.previewHeightRelated !== undefined) {
      this.previewHeightRelated = geometry.previewHeightRelated;
    }
  }

  /**
   * Compute the number of pixels needed to add to the preview item
   * Thumbnails need more space for the text
   * Filmstrip needs less
   */
  public computeTextBufferAmount(): void {
    this.computePreviewWidth();

    const textPaddingHeight = this.galleryLayoutService.calculateTextPadding({
      compactView: this.settingsButtons.compactView.toggled,
      showMoreInfo: this.settingsButtons.showMoreInfo.toggled,
      view: this.appState.currentView,
    });
    if (textPaddingHeight !== undefined) {
      this.textPaddingHeight = textPaddingHeight;
    }
  }

  /**
   * Add search string to filter array
   * When user presses the `ENTER` key
   * @param value  -- the string to filter
   * @param origin -- number in filter array of the filter to target
   */
  onEnterKey(value: string, origin: number, branchMatch = false, exactMatch = false): void {
    const trimmed = value.trim();
    const tagFilter = origin >= 6 && origin <= 8;

    if (tagFilter) {
      this.tagTypeAhead = '';
    }

    if (trimmed) {
      const filter = this.filters[origin];
      const existingIndex = filter.array.findIndex((existing: string) => (
        tagFilter ? tagPathsEqual(existing, trimmed) : existing === trimmed
      ));
      let changed = false;

      if (existingIndex === -1) {
        filter.array.push(trimmed);
        changed = true;
      }
      if (branchMatch) {
        const previousExactCount = (filter.exactPaths || []).length;
        filter.exactPaths = (filter.exactPaths || [])
          .filter((path: string) => !tagPathsEqual(path, trimmed));
        if (filter.exactPaths.length !== previousExactCount) {
          changed = true;
        }
        if (!(filter.branchPaths || []).some((branch: string) => tagPathsEqual(branch, trimmed))) {
          filter.branchPaths = [...(filter.branchPaths || []), trimmed];
          changed = true;
        }
      } else if (exactMatch) {
        const previousBranchCount = (filter.branchPaths || []).length;
        filter.branchPaths = (filter.branchPaths || [])
          .filter((path: string) => !tagPathsEqual(path, trimmed));
        if (filter.branchPaths.length !== previousBranchCount) {
          changed = true;
        }
        if (!(filter.exactPaths || []).some((path: string) => tagPathsEqual(path, trimmed))) {
          filter.exactPaths = [...(filter.exactPaths || []), trimmed];
          changed = true;
        }
      }

      if (changed) {
        filter.bool = !filter.bool;
        this.scrollToTop();
      }
      filter.string = '';
    }
  }

  /**
   * Removes last-added filter
   * When user presses the `BACKSPACE` key
   * @param origin  -- array from which to .pop()
   */
  onBackspace(value: string, origin: number): void {
    if (value === '' && this.filters[origin].array.length > 0) {
      const filter = this.filters[origin];
      const removed = filter.array.pop();
      if (removed) {
        filter.branchPaths = (filter.branchPaths || [])
          .filter((branch: string) => !tagPathsEqual(branch, removed));
        filter.exactPaths = (filter.exactPaths || [])
          .filter((path: string) => !tagPathsEqual(path, removed));
      }
      filter.bool = !filter.bool;
    }
  }

  /**
   * Removes item from particular search array
   * When user clicks on a particular search word
   * @param item    {number}  index within array of search strings
   * @param origin  {number}  index within filters array
   */
  removeThisFilter(item: number, origin: number): void {
    const filter = this.filters[origin];
    const [removed] = filter.array.splice(item, 1);
    if (removed) {
      filter.branchPaths = (filter.branchPaths || [])
        .filter((branch: string) => !tagPathsEqual(branch, removed));
      filter.exactPaths = (filter.exactPaths || [])
        .filter((path: string) => !tagPathsEqual(path, removed));
    }
    filter.bool = !filter.bool;
  }

  /**
   * Toggle the visibility of the settings button
   * @param item  -- index within the searchButtons array to toggle
   */
  toggleHideButton(item: string): void {
    this.settingsButtons[item].hidden = !this.settingsButtons[item].hidden;
  }

  /**
   * Show or hide the ribbon
   */
  toggleRibbon(): void {
    this.appState.menuHidden = !this.appState.menuHidden;
    this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
  }

  openCatalogueEditor(): void {
    if (this.blockActionDuringFolderThumbnailRegeneration()) {
      return;
    }
    if (this.catalogueReadOnly) {
      this.showReadOnlyActionBlocked();
      return;
    }
    this.catalogueEditorOpen = true;
    this.catalogueEditorSaveStatus = '';
  }

  closeCatalogueEditor(): void {
    if (this.catalogueEditorSaving) {
      return;
    }

    this.catalogueEditorOpen = false;

    // The gallery uses pure pipes, so provide a new array reference after editor mutations.
    this.imageElementService.imageElements = this.imageElementService.imageElements.slice();
    this.ifShowDetailsViewRefreshTags();

    // Recreate the bottom Details tray when its selected item was edited.
    if (this.currentClickedItem) {
      this.currentClickedItemName = this.currentClickedItem.cleanName;
      this.updateCurrentClickedItem(this.currentClickedItem);
    }

    this.cd.detectChanges();
    setTimeout(() => {
      this.virtualScroller()?.refresh();
    }, 0);
  }

  handleCatalogueEntriesChanged(): void {
    if (this.catalogueReadOnly) {
      return;
    }
    const activeImages = this.imageElementService.imageElements.filter((element: ImageElement) => (
      !element.deleted && !element.missing
    ));

    if (!this.catalogueEditorSaving) {
      this.catalogueEditorSaveStatus = 'Unsaved Changes';
    }

    this.deletePipeTrigger = !this.deletePipeTrigger;
    this.setUpTimesPlayedFilterValues(activeImages);
    this.setUpYearFilterValues(activeImages);
  }

  private showReadOnlyActionBlocked(): void {
    this.modalService.openSnackbar(
      this.translate.instant('SYSTEM.catalogueReadOnlyActionBlocked'),
    );
  }

  private unwindReadOnlyMutationState(channel?: string): void {
    if (channel === 'try-to-rename-this-file' && this.currentRightClickedItem) {
      const item = this.currentRightClickedItem;
      this.renameFileResponseBehaviorSubject.next({
        errMsg: 'SYSTEM.catalogueReadOnlyActionBlocked',
        index: item.index,
        oldFileName: item.fileName,
        renameTo: item.fileName,
        success: false,
      });
      this.renameFileResponseBehaviorSubject.next(undefined);
    }

    if (channel === 'regenerate-thumbnails' && this.individualThumbnailRegenerationStatus) {
      this.clearIndividualThumbnailRegeneration(
        this.individualThumbnailRegenerationStatus.fileHash,
      );
    }

    if (channel === 'regenerate-folder-thumbnails') {
      this.clearFolderThumbnailRegenerationRequest();
    }

    if (channel === 'save-current-vha-file') {
      this.catalogueEditorSaving = false;
      this.catalogueEditorSaveStatus = 'Read only';
    }

    this.cd.detectChanges();
  }

  private showCatalogueLoadedFromBackup(details: CatalogueLoadedFromBackupDetails): void {
    this.catalogueOpenCoordinator.setBackupNoticeOpen(true);
    const readOnly = details.readOnly === true;
    const sourcePath = details.sourcePath || this.appState.currentVhaFile || 'Unknown';
    const openedPath = details.openedPath || this.appState.currentVhaFile || sourcePath;
    const primaryError = details.primaryError || this.translate.instant(
      'SYSTEM.catalogueLoadedFromBackupUnknownError',
    );

    this.modalService.openDialog(
      this.translate.instant('SYSTEM.catalogueLoadedFromBackupTitle'),
      this.translate.instant(
        readOnly
          ? 'SYSTEM.catalogueLoadedFromBackupReadOnlySummary'
          : 'SYSTEM.catalogueLoadedFromBackupCopySummary',
      ),
      this.translate.instant('SYSTEM.catalogueLoadedFromBackupDetails', {
        openedPath,
        primaryError,
        sourcePath,
      }),
    ).subscribe(() => {
      this.catalogueOpenCoordinator.setBackupNoticeOpen(false);
    });
  }

  // ---- HANDLE EXTRACTING AND RESTORING SETTINGS ON OPEN AND BEFORE CLOSE ------

  /**
   * Prepare and return the settings object for saving
   * happens right before closing the app !!!
   */
  getSettingsForSave(): SettingsObject {

    const buttonSettings = {} as Record<SettingsButtonKey, SettingsButtonSavedProperties>;

    this.grabAllSettingsKeys().forEach((key: SettingsButtonKey) => {
      buttonSettings[key] = {
        toggled: this.settingsButtons[key].toggled,
        hidden: this.settingsButtons[key].hidden,
      } as SettingsButtonSavedProperties;
    });

    return {
      appState: this.appState,
      buttonSettings: buttonSettings,
      settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      shortcuts: this.shortcutService.keyToActionMap,
      vhaFileHistory: this.vhaFileHistory,
      wizardOptions: this.wizard
    };
  }

  /**
   * Return all keys from the settings-buttons
   */
  grabAllSettingsKeys(): SettingsButtonKey[] {
    const objectKeys: SettingsButtonKey[] = [];

    this.settingsButtonsGroups.forEach(element => {
      element.forEach(key => {
        objectKeys.push(key);
      });
    });

    return (objectKeys);
  }

  /**
   * Restore settings to their default values
   */
  resetSettingsToDefault(): void {
    this.settingsButtons = JSON.parse(JSON.stringify(this.defaultSettingsButtons)); // JSON hack to allow resetting more than once
    this.toggleButton('showThumbnails');
    this.syncAppIconTheme();
  }

  private syncAppIconTheme(): void {
    if (!this.macVersion || !this.hasResolvedInitialTheme) {
      return;
    }
    this.electronService.ipcRenderer.send(
      'set-app-icon-theme',
      this.settingsButtons['darkMode'].toggled ? 'dark' : 'light',
    );
  }

  /**
   * restore settings from saved file
   */
  restoreSettingsFromBefore(settingsObject: SettingsObject): void {
    const revealCompactCleanNameToolbar = shouldRevealCompactCleanNameToolbar(
      settingsObject.settingsSchemaVersion,
    );

    if (settingsObject.appState) {
      this.appState = settingsObject.appState;
      delete (this.appState as AppStateInterface & { port?: unknown }).port;
      this.appState.scanFoldersOnAddition = normalizeScanFoldersOnAddition(
        settingsObject.appState.scanFoldersOnAddition,
      );
      this.appState.generatePreviewsOnFolderAddition = normalizeGeneratePreviewsOnFolderAddition(
        settingsObject.appState.generatePreviewsOnFolderAddition,
      );
      this.appState.hideSubdirectoriesWithNoVideos = normalizeHideSubdirectoriesWithNoVideos(
        settingsObject.appState.hideSubdirectoriesWithNoVideos,
      );
      if (!settingsObject.appState.currentZoomLevel) {  // catch error <-- old VHA apps didn't have `currentZoomLevel`
        this.appState.currentZoomLevel = 1;             // TODO -- remove whole block -- not needed any more !?!?!?!??!?! -----------------!
      }
      if (!settingsObject.appState.imgsPerRow) {
        this.appState.imgsPerRow = DefaultImagesPerRow;
      }
    }
    this.sortType = this.appState.currentSort;
    this.imgsPerRow = this.appState.imgsPerRow;
    this.currentImgsPerRow = this.imgsPerRow[this.appState.currentView];
    this.grabAllSettingsKeys().forEach(element => {
      if (settingsObject.buttonSettings[element]) {
        this.settingsButtons[element].toggled = settingsObject.buttonSettings[element].toggled;
        this.settingsButtons[element].hidden = element === 'showCleanNameInCompactView'
          && revealCompactCleanNameToolbar
          ? false
          : settingsObject.buttonSettings[element].hidden;
        // retrieving state of buttons for touchBar
        if (this.settingsButtons[element].toggled) {
          this.electronService.ipcRenderer.send('app-to-touchBar', element);
        }
      }
    });
    this.settingsButtons['showTags'].toggled = false; // never show tags on load (they don't load right anyway)

    const reopenTagTray = this.settingsButtons['showTagTray'].toggled;
    if (reopenTagTray) {
      this.settingsButtons['showTagTray'].toggled = false;
    }

    // Render restored layout classes before measuring the gallery. IPC callbacks
    // can otherwise leave compact view using the default panel/sidebar width.
    this.cd.detectChanges();
    this.computeTextBufferAmount();
    this.cd.detectChanges();
    this.scheduleGalleryLayoutRefresh();

    if (reopenTagTray) {
      setTimeout(() => {
        this.zone.run(() => {
          this.settingsButtons['showTagTray'].toggled = true; // needs a delay to show up correctly
          this.cd.detectChanges();
          this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
        });
      }, 100);
    }
  }

  /**
   * Restore the language from settings or try to set it from the user's locale
   * @param storedSetting the `language` attribute in AppState
   * @param locale the string that comes from `app.getLocale()`
   * List of locales is here: https://github.com/electron/electron/blob/master/docs/api/locales.md
   */
  setOrRestoreLanguage(chosenLanguage: SupportedLanguage, locale: string): void {
    if (chosenLanguage) {
      this.changeLanguage(chosenLanguage);
    } else if (<any>locale.substring(0, 2)) {
      this.changeLanguage(<any>locale.substring(0, 2));
    } else {
      this.changeLanguage('en');
    }
  }

  /**
   * Update the min and max resolution for the resolution filter
   * @param selection
   */
  newResFilterSelected(selection: number[]): void {
    this.freqLeftBound = selection[0];
    this.freqRightBound = selection[1];
  }

  /**
   * Update the min and max star rating for the star filter
   * @param selection
   */
  newStarFilterSelected(selection: number[]): void {
    this.starLeftBound = selection[0];
    this.starRightBound = selection[1];
  }

  /**
   * Handle right-click and `Show similar`
   */
  showSimilarNow(): void {
    this.findMostSimilar = this.currentRightClickedItem.cleanName;
    this.showSimilar = true;
  }

  /**
   * Handle right-click on file and `view folder`
   */
  showOnlyThisFolderNow(): void {
    this.handleFolderWordClicked(this.currentRightClickedItem.partialPath);
  }

  beginRenameFromContextMenu(): void {
    if (this.catalogueReadOnly) {
      this.showReadOnlyActionBlocked();
      return;
    }
    if (!this.sourceFolderService.sourceFolderConnected[this.currentRightClickedItem.inputSource]) {
      return;
    }
    this.renamingNow = true;
  }

  rightMouseClicked(event: PointerEvent, item: ImageElement): void {
    this.currentRightClickedItem = item;

    const winWidth: number = window.innerWidth;
    const clientX: number = event.clientX;
    const howFarFromRight: number = winWidth - clientX;

    // handle top-offset if clicking close to the bottom
    const winHeight: number = window.innerHeight;
    const clientY: number = event.clientY;
    const howFarFromBottom: number = winHeight - clientY;

    this.rightClickPosition.x = (howFarFromRight < 180) ? clientX - 180 + (howFarFromRight) : clientX;
    this.rightClickPosition.y = (howFarFromBottom < 240) ? clientY - 240 + (howFarFromBottom) : clientY;

    this.rightClickShowing = true;
  }

  /**
   * When in double-click mode and a video is clicked - `currentClickedItemName` updated
   * @param item
   */
  assignSelectedFile(item: ImageElement): void {
    this.currentClickedItemName = item.cleanName;
    this.updateCurrentClickedItem(item);
  }

  /**
   * If the `showDetailsTray` is open, update the `currentClickedItem`
   * @param item
   */
  updateCurrentClickedItem(item: ImageElement): void {
    // to update the view, we must first destroy the component with `null` since component sets thumbnail at `ngOnInit`
    this.currentClickedItem = null;
    setTimeout(() => {
      this.currentClickedItem = item;
    });
  }

  /**
   * Opens the thumbnail sheet for the selected video
   */
  openThumbnailSheet(item: ImageElement): void {
    this.sheetItemToDisplay = item;
    this.sheetOverlayShowing = true;
  }

  /**
   * Recreate all generated preview assets for the selected video.
   */
  regenerateThumbnails(item: ImageElement): void {
    if (this.catalogueReadOnly) {
      this.showReadOnlyActionBlocked();
      return;
    }
    if (this.thumbnailRegenerationActive) {
      this.modalService.openSnackbar(
        this.translate.instant('RIGHTCLICK.thumbnailRegenerationBusy'),
      );
      return;
    }
    const projectedItem = this.filePathService.projectToAvailableImageLocation(item);
    if (!projectedItem) {
      this.modalService.openSnackbar(this.translate.instant('SETTINGS.rootFolderNotLive'));
      return;
    }
    this.individualThumbnailRegenerationStatus = {
      catalogueSessionGeneration: this.catalogueSessionGeneration,
      cancelling: false,
      fileHash: item.hash,
      fileName: projectedItem.fileName,
      hubFile: this.appState.currentVhaFile,
    };
    this.startThumbnailRegenerationClock();
    this.thumbnailRegenerationIpc.regenerateIndividual(projectedItem);
  }

  /**
   * Confirm and start one sequential preview-regeneration batch for a source
   * folder. The eligible set is recalculated after confirmation so a delayed
   * response cannot operate on stale catalogue entries.
   */
  confirmRegenerateFolderThumbnails(target: FolderScopeTarget): void {
    if (this.catalogueReadOnly) {
      this.showReadOnlyActionBlocked();
      return;
    }
    if (this.thumbnailRegenerationActive) {
      this.modalService.openSnackbar(
        this.translate.instant('RIGHTCLICK.thumbnailRegenerationBusy'),
      );
      return;
    }

    let relativePath: string;
    try {
      relativePath = normalizeSourceFolderRelativePath(target?.relativePath || '');
    } catch {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.folderThumbnailRegenerationUnavailable'),
      );
      return;
    }
    const sourceIndex = Number(target?.sourceIndex);

    const folder = this.sourceFolderService.selectedSourceFolder[sourceIndex];
    if (
      !Number.isInteger(sourceIndex)
      || !folder
      || this.sourceFolderService.sourceFolderConnected[sourceIndex] !== true
    ) {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.folderThumbnailRegenerationUnavailable'),
      );
      return;
    }

    const plan = planFolderThumbnailRegeneration(
      this.imageElementService.imageElements,
      sourceIndex,
      relativePath,
    );
    if (plan.targets.length === 0) {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.noFolderThumbnailsToRegenerate'),
      );
      return;
    }

    const sourceFolderPath = folder.path;
    const folderPath = relativePath
      ? path.join(sourceFolderPath, ...relativePath.split('/'))
      : sourceFolderPath;
    const folderName = path.basename(folderPath) || folderPath;
    const videoLabel = plan.videoCount === 1 ? 'video' : 'videos';

    const hubFile = this.appState.currentVhaFile;
    this.modalService.openConfirmationDialog({
      cancelLabel: this.translate.instant('SYSTEM.cancel'),
      confirmLabel: this.translate.instant('STATISTICS.regenerateFolderThumbnails'),
      facts: [
        { label: 'Folder', value: folderPath },
        { label: 'Eligible videos', value: plan.videoCount },
        { label: 'Skipped videos', value: plan.skippedVideos },
        { label: 'Extraction settings', value: 'Current catalogue settings' },
      ],
      summary: `${plan.videoCount} eligible ${videoLabel} in “${folderName}” will have thumbnails regenerated.`,
      supportingText: 'Existing thumbnails will be replaced using the catalogue’s current extraction settings. This may take some time.',
      title: this.translate.instant('STATISTICS.confirmRegenerateFolderThumbnailsTitle'),
      tone: 'warning',
    }).subscribe((confirmed: boolean) => {
      if (!confirmed || this.appState.currentVhaFile !== hubFile) {
        return;
      }
      if (this.catalogueReadOnly) {
        this.showReadOnlyActionBlocked();
        return;
      }
      if (this.thumbnailRegenerationActive) {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.folderThumbnailRegenerationBusy'),
        );
        return;
      }

      const currentFolder = this.sourceFolderService.selectedSourceFolder[sourceIndex];
      if (
        !currentFolder
        || currentFolder.path !== sourceFolderPath
        || this.sourceFolderService.sourceFolderConnected[sourceIndex] !== true
      ) {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.folderThumbnailRegenerationUnavailable'),
        );
        return;
      }

      const currentPlan = planFolderThumbnailRegeneration(
        this.imageElementService.imageElements,
        sourceIndex,
        relativePath,
      );
      if (!folderThumbnailRegenerationPlansMatch(plan, currentPlan)) {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.folderThumbnailRegenerationSelectionChanged'),
        );
        return;
      }
      if (currentPlan.targets.length === 0) {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.noFolderThumbnailsToRegenerate'),
        );
        return;
      }

      const start = this.folderThumbnailRegenerationSession.begin({
        hubFile,
        relativePath,
        skippedVideos: currentPlan.skippedVideos,
        sourceFolderPath,
        sourceIndex,
        totalJobs: currentPlan.targets.length,
        videoCountsByHash: currentPlan.videoCountsByHash,
      });
      if (!start) {
        this.modalService.openSnackbar(
          this.translate.instant('STATISTICS.folderThumbnailRegenerationBusy'),
        );
        return;
      }
      this.startThumbnailRegenerationClock();
      this.thumbnailRegenerationIpc.regenerateFolder({
        cataloguePath: hubFile,
        eligibleVideos: currentPlan.eligibleVideos,
        relativePath,
        requestId: start.requestId,
        sourceIndex,
      });
    });
  }

  cancelFolderThumbnailRegeneration(): void {
    const cancellation = this.folderThumbnailRegenerationSession.markCancelling();
    if (!cancellation.changed) {
      return;
    }
    this.thumbnailRegenerationIpc.cancelFolder();
  }

  cancelThumbnailRegeneration(): void {
    if (this.folderThumbnailRegenerationSession.active) {
      this.cancelFolderThumbnailRegeneration();
      return;
    }
    if (!this.individualThumbnailRegenerationStatus) {
      return;
    }
    this.individualThumbnailRegenerationStatus = {
      ...this.individualThumbnailRegenerationStatus,
      cancelling: true,
    };
    this.thumbnailRegenerationIpc.cancelIndividual();
  }

  get thumbnailRegenerationActive(): boolean {
    return this.individualThumbnailRegenerationStatus !== null
      || this.folderThumbnailRegenerationSession.active;
  }

  get thumbnailRegenerationCancelling(): boolean {
    return this.individualThumbnailRegenerationStatus?.cancelling === true
      || this.folderThumbnailRegenerationStatus?.cancelling === true;
  }

  get thumbnailRegenerationFolderName(): string {
    const status = this.folderThumbnailRegenerationStatus;
    const sourceFolderPath = status === null || status === undefined
      ? ''
      : this.sourceFolderService.selectedSourceFolder[status.sourceIndex]?.path;
    const folderPath = sourceFolderPath && status?.relativePath
      ? path.join(sourceFolderPath, ...status.relativePath.split('/'))
      : sourceFolderPath;
    return folderPath ? path.basename(folderPath) || folderPath : '';
  }

  get thumbnailRegenerationElapsedLabel(): string {
    const minutes = Math.floor(this.thumbnailRegenerationElapsedSeconds / 60);
    const seconds = this.thumbnailRegenerationElapsedSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private blockActionDuringFolderThumbnailRegeneration(): boolean {
    if (!this.folderThumbnailRegenerationSession.active) {
      return false;
    }
    this.modalService.openSnackbar(
      this.translate.instant('STATISTICS.folderThumbnailRegenerationActionBlocked'),
    );
    return true;
  }

  private applyThumbnailRegenerationResult(
    fileHash: string,
    screenshotCount: number,
    refreshPresentation: boolean,
  ): void {
    const catalogueChanged = applyRegeneratedScreenshotCount(
      this.imageElementService.imageElements,
      fileHash,
      screenshotCount,
    );
    const refreshId = Date.now();
    this.imageElementService.imageElements
      .filter((element: ImageElement) => element.hash === fileHash)
      .forEach((element: ImageElement) => {
        element.uuid = withThumbnailRefreshId(element.uuid, 'thumbnail', refreshId);
      });

    if (catalogueChanged) {
      this.imageElementService.finalArrayNeedsSaving = true;
    }
    if (!refreshPresentation) {
      return;
    }

    this.imageElementService.imageElements = this.imageElementService.imageElements.slice();
    if (this.currentClickedItem && this.currentClickedItem.hash === fileHash) {
      this.updateCurrentClickedItem(this.currentClickedItem);
    }
  }

  private handleFolderThumbnailRegenerationProgress(
    requestId: number,
    sourceIndex: number,
    progress: FolderThumbnailRegenerationProgress,
  ): void {
    const decision = this.folderThumbnailRegenerationSession.acceptProgress({
      currentHubFile: this.appState.currentVhaFile,
      currentSourceFolderPath: this.sourceFolderService.selectedSourceFolder[sourceIndex]?.path,
      progress,
      requestId,
      sourceIndex,
    });
    if (!decision.accepted) {
      this.stopThumbnailRegenerationClockIfIdle();
      return;
    }

    if (decision.successfulUpdate) {
      this.applyThumbnailRegenerationResult(
        decision.successfulUpdate.fileHash,
        decision.successfulUpdate.screenshotCount,
        false,
      );
    }
  }

  private handleFolderThumbnailRegenerationProgressRejected(
    requestId: number,
    sourceIndex: number,
  ): void {
    const accepted = this.folderThumbnailRegenerationSession.fail({
      currentHubFile: this.appState.currentVhaFile,
      currentSourceFolderPath: this.sourceFolderService.selectedSourceFolder[sourceIndex]?.path,
      requestId,
      sourceIndex,
    });
    if (!accepted) {
      return;
    }

    // Only a malformed event correlated to the active local session may
    // cancel the global main-process batch. Send cancellation synchronously
    // before returning control to the UI after releasing local state.
    this.thumbnailRegenerationIpc.cancelFolder();
    this.stopThumbnailRegenerationClockIfIdle();
    this.modalService.openSnackbar(
      this.translate.instant('STATISTICS.folderThumbnailRegenerationFailed'),
    );
  }

  private handleFolderThumbnailRegenerationComplete(
    requestId: number,
    sourceIndex: number,
    result: FolderThumbnailRegenerationResult,
  ): void {
    const completion = this.folderThumbnailRegenerationSession.complete({
      cancelled: result.cancelled,
      currentHubFile: this.appState.currentVhaFile,
      currentSourceFolderPath: this.sourceFolderService.selectedSourceFolder[sourceIndex]?.path,
      requestId,
      sourceIndex,
    });
    if (!completion.accepted) {
      this.stopThumbnailRegenerationClockIfIdle();
      return;
    }

    if (completion.updatedHashes.size > 0) {
      this.electronService.webFrame.clearCache();
      this.imageElementService.imageElements = this.imageElementService.imageElements.slice();
      if (this.currentClickedItem && completion.updatedHashes.has(this.currentClickedItem.hash)) {
        this.updateCurrentClickedItem(this.currentClickedItem);
      }
    }

    this.stopThumbnailRegenerationClockIfIdle();

    if (completion.outcome === 'cancelled') {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.folderThumbnailRegenerationCancelled'),
      );
    } else if (completion.outcome === 'partial') {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.folderThumbnailRegenerationSummary', {
          failed: completion.failedVideos,
          skipped: completion.skippedVideos,
          succeeded: completion.succeededVideos,
        }),
      );
    } else {
      this.modalService.openSnackbar(
        this.translate.instant('STATISTICS.folderThumbnailRegenerationComplete', {
          count: completion.succeededVideos,
        }),
      );
    }
  }

  private handleFolderThumbnailRegenerationFailure(requestId: number, sourceIndex: number): void {
    const accepted = this.folderThumbnailRegenerationSession.fail({
      currentHubFile: this.appState.currentVhaFile,
      currentSourceFolderPath: this.sourceFolderService.selectedSourceFolder[sourceIndex]?.path,
      requestId,
      sourceIndex,
    });
    if (!accepted) {
      this.stopThumbnailRegenerationClockIfIdle();
      return;
    }

    this.stopThumbnailRegenerationClockIfIdle();
    this.modalService.openSnackbar(
      this.translate.instant('STATISTICS.folderThumbnailRegenerationFailed'),
    );
  }

  private clearFolderThumbnailRegenerationRequest(): void {
    this.folderThumbnailRegenerationSession.clear();
    this.stopThumbnailRegenerationClockIfIdle();
  }

  private clearIndividualThumbnailRegeneration(fileHash: string): boolean {
    const status = this.individualThumbnailRegenerationStatus;
    if (!status) {
      return false;
    }
    const disposition = classifyIndividualThumbnailRegenerationTerminal(
      status,
      fileHash,
      this.appState.currentVhaFile,
      this.catalogueSessionGeneration,
    );
    if (disposition === 'ignore') {
      return false;
    }
    if (disposition === 'stale-session') {
      this.individualThumbnailRegenerationStatus = null;
      this.stopThumbnailRegenerationClockIfIdle();
      return false;
    }
    this.individualThumbnailRegenerationStatus = null;
    this.stopThumbnailRegenerationClockIfIdle();
    return true;
  }

  private cancelIndividualThumbnailRegenerationForCatalogueLoad(): void {
    const status = this.individualThumbnailRegenerationStatus;
    if (!status || status.cancelling) {
      return;
    }
    this.individualThumbnailRegenerationStatus = {
      ...status,
      cancelling: true,
    };
    this.thumbnailRegenerationIpc.cancelIndividual();
  }

  private startThumbnailRegenerationClock(): void {
    if (this.thumbnailRegenerationTimer !== null) {
      window.clearInterval(this.thumbnailRegenerationTimer);
    }
    this.thumbnailRegenerationStartedAt = Date.now();
    this.thumbnailRegenerationElapsedSeconds = 0;
    this.thumbnailRegenerationTimer = window.setInterval(() => {
      this.thumbnailRegenerationElapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - this.thumbnailRegenerationStartedAt) / 1000),
      );
      this.cd.detectChanges();
    }, 1000);
  }

  private stopThumbnailRegenerationClockIfIdle(): void {
    if (this.thumbnailRegenerationActive) {
      return;
    }
    if (this.thumbnailRegenerationTimer !== null) {
      window.clearInterval(this.thumbnailRegenerationTimer);
      this.thumbnailRegenerationTimer = null;
    }
    this.thumbnailRegenerationStartedAt = 0;
    this.thumbnailRegenerationElapsedSeconds = 0;
  }

  /**
   * Deletes a file (moves to recycling bin / trash) or dangerously deletes (bypassing trash)
   */
  deleteThisFile(item: ImageElement): void {
    if (this.catalogueReadOnly) {
      this.showReadOnlyActionBlocked();
      return;
    }
    const dangerously: boolean = this.settingsButtons['dangerousDelete'].toggled;
    const messageKey: string = dangerously
      ? 'RIGHTCLICK.confirmPermanentDeleteMessage'
      : 'RIGHTCLICK.confirmDeleteMessage';

    this.modalService.openConfirmationDialog({
      cancelLabel: this.translate.instant('SYSTEM.cancel'),
      confirmLabel: this.translate.instant('RIGHTCLICK.delete'),
      facts: [
        { label: 'File', value: item.fileName },
        {
          label: 'Action',
          value: dangerously ? 'Permanent deletion' : 'Move to Trash / Recycle Bin',
        },
      ],
      summary: this.translate.instant(messageKey, { fileName: item.fileName }),
      supportingText: dangerously
        ? 'This action bypasses the Trash / Recycle Bin.'
        : 'The operating system will move the file to the Trash / Recycle Bin.',
      title: this.translate.instant('RIGHTCLICK.confirmDeleteTitle'),
      tone: dangerously ? 'destructive' : 'warning',
      transition: {
        from: item.fileName,
        fromLabel: 'File',
        to: dangerously ? 'Permanently deleted' : 'Trash / Recycle Bin',
        toLabel: 'Destination',
      },
    }).subscribe((confirmed: boolean) => {
      if (!confirmed) {
        return;
      }

      const projectedItem = this.filePathService.projectToAvailableImageLocation(item);
      if (!projectedItem) {
        this.modalService.openSnackbar(this.translate.instant('SETTINGS.rootFolderNotLive'));
        return;
      }
      this.electronService.ipcRenderer.send('delete-video-file', projectedItem, dangerously);
    });
  }

  /**
   * Close the rename dialog
   */
  closeRename() {
    this.renamingNow = false;
    this.cd.detectChanges();
  }

  /**
   * For ternary in `home.component` template when right-clicking on folder instead of file
   */
  doNothing(): void {
    // do nothing
  }

  /**
   * Add and remove tags from the AutoTagsSaveService
   * triggered on vha file load
   * @param addTags
   * @param removeTags
   */
  setTags(addTags: string[], removeTags: string[]): void {
    this.autoTagsSaveService.restoreSavedTags(
      addTags ? addTags : [],
      removeTags ? removeTags : []
    );
  }

  /**
   * Change the language via ngx-translate
   * `en` is the default
   * @param language
   */
  changeLanguage(language: SupportedLanguage): void {
    this.translate.use(language);
    this.translate.setTranslation(language, LanguageLookup[language]);
    this.appState.language = language;

    this.updateSystemMessages();
  }

  /**
   * Update the systemMessages `main.ts`
   * so that ... i18n everywhere!
   */
  updateSystemMessages() {
    const newMessages = {};

    for (const key in LanguageLookup['en'].SYSTEM) {
      if (LanguageLookup['en'].SYSTEM[key]) {
        newMessages[key] = this.translate.instant('SYSTEM.' + key);
      }
    }

    this.electronService.ipcRenderer.send(
      'system-messages-updated', newMessages
    );
  }

  /**
   * Run when user starts the app for the first time
   * Gets triggered when the settings.json is missing from the app folder
   */
  firstRunLogic(): void {
    console.log('WELCOME TO THEATRUM EX MACHINA!');
    console.log('this is the first time you are running this app');
    this.isFirstRunEver = true;
  }

  /**
   * Select a particular sort order (star rating, number of times played, etc)
   * @param type
   */
  selectFilterOrder(type: SortType): void {
    this.sortType = type;
    this.appState.currentSort = type;
  }

  /**
   * Sort by most-recent
   */
  sortByRecentlyPlayed(): void {
    this.settingsButtons['sortOptionLastPlayed'].toggled = true;

    this.selectFilterOrder('lastPlayedDesc');

    setTimeout(() => {
      const sortOrderRef = this.sortOrderRef();
      const sortFilterElement = sortOrderRef.sortFilterElement();
      if (sortFilterElement) { // just in case, perform check
        sortFilterElement.nativeElement.value = 'lastPlayedDesc';
      }
    });
  }

  /**
   * Check type-ahead for the manually-added tags!
   * @param text     input text to check type-ahead
   * @param compute  whether or not to perform the lookup
   */
  checkTagTypeahead(text: string) {
    this.tagTypeAhead = this.manualTagsService.getTypeahead(text);
  }

  /**
   * Add tag to search when pressing tab
   * !!! but only when on the tag search field !!!
   * @param origin -- the `j` in the template, just pass it on to the `onEnterKey`
   */
  typeaheadTabPressed(origin: number): void {
    if (this.tagTypeAhead !== '') {
      this.onEnterKey(this.tagTypeAhead, origin);
      this.tagTypeAhead = '';
    }
  }

  /*
   * Update the min and max resolution for the resolution filter
   * hacked to set rightBound to Infinity when close-enough to the right side
   * @param selection
   */
  newLengthFilterSelected(selection: number[]): void {
    this.durationLeftBound = selection[0];

    if (selection[1] > this.durationOutlierCutoff - 10) {
      this.durationRightBound = Infinity;
    } else {
      this.durationRightBound = selection[1];
    }
  }

  newSizeFilterSelected(selection: number[]): void {

    this.sizeLeftBound = selection[0];

    if (selection[1] > this.sizeOutlierCutoff - 10) {
      this.sizeRightBound = Infinity;
    } else {
      this.sizeRightBound = selection[1];
    }

  }

  newTimesPlayedFilterSelected(selection: number[]): void {

    this.timesPlayedLeftBound = selection[0];
    this.timesPlayedRightBound = selection[1];

  }

  newYearFilterSelected(selection: number[]): void {

      this.yearLeftBound = selection[0];
      this.yearRightBound = selection[1];

  }

  setUpDurationFilterValues(finalArray: ImageElement[]): void {
    const durations: number[] = finalArray.map((element) => { return element.duration; });

    const cutoff = this.getOutlierCutoff(durations);

    this.durationOutlierCutoff = Math.floor(cutoff);
  }

  setUpSizeFilterValues(finalArray: ImageElement[]): void {
    const fileSizes: number[] = finalArray.map((element) => { return element.fileSize; });

    this.sizeOutlierCutoff = Math.max(...fileSizes);
  }

  setUpTimesPlayedFilterValues(finalArray: ImageElement[]): void {
    const timesPlayed: number[] = finalArray.map((element) => { return element.timesPlayed || 0; });

    this.timesPlayedCutoff = Math.max(0, ...timesPlayed);
  }

  // need to filter otherwise cutoff will be NaN
  setUpYearFilterValues(finalArray: ImageElement[]): void {
    const year: number[] = finalArray.map((element) => { return element.year; });
    const filtrate = el => Number.isInteger(el) && el > 0;
    const yearFiltered = year.filter(filtrate);
    this.yearMinCutoff = Math.min(...yearFiltered) - 1;
    this.yearCutoff = Math.max(...yearFiltered);
  }
  /**
   * Given an array of numbers
   * returns the cutoff for outliers
   * defined unconventionally as "anything beyond the 3rd quartile + 3 * IQR (the inter-quartile range)"
   *   cutoff may be the max number if the other computation returns a number too high
   * @param someArray
   */
  getOutlierCutoff(someArray: number[]): number {
    const values = someArray.slice();
    const max = Math.max(...values);
    values.sort((a, b) => { return a - b; });

    const q1 = values[Math.floor((values.length / 4))];
    const q3 = values[Math.ceil((values.length * (3 / 4)))];
    const iqr = q3 - q1;

    return Math.min((q3 + iqr * 3), max);
  }

  addTagToManyVideos(tag: string): void {
    const existingTag = this.manualTagsService.tagsList.find((knownTag: string) => (
      tagPathsEqual(knownTag, tag)
    ));
    let normalizedTag: string;
    try {
      normalizedTag = existingTag || this.manualTagsService.normalizeTagInput(tag);
    } catch {
      return;
    }

    const affectedEntryCount = addTagToSelectedEntries(
      this.imageElementService.imageElements,
      normalizedTag,
    );
    if (affectedEntryCount > 0) {
      this.imageElementService.imageElements = this.imageElementService.imageElements.slice();
      this.imageElementService.finalArrayNeedsSaving = true;
      this.manualTagsService.rebuildFromImages(this.imageElementService.imageElements);
    }

    this.ifShowDetailsViewRefreshTags();
  }

  /**
   * Add a tag to some element
   * Also updates the tag count in `manualTagsService`
   * @param tag
   * @param element
   */
  addTagToThisElement(tag: string, element: ImageElement): void {
    const existingTag = this.manualTagsService.tagsList.find((knownTag: string) => knownTag === tag);
    let normalizedTag: string;
    try {
      normalizedTag = existingTag || this.manualTagsService.normalizeTagInput(tag);
    } catch {
      return;
    }

    if (!element.tags || !element.tags.some((currentTag: string) => tagPathsEqual(currentTag, normalizedTag))) {

      this.manualTagsService.addTag(normalizedTag); // only updates the count in the tray, nothing else!

      this.imageElementService.HandleEmission({
        type: 'add',
        index: element.index,
        tag: normalizedTag
      });
    }
  }

  /**
   * If current view is `showDetails` refresh all showing tags
   * hack to make newly-added tags appear next to videos
   */
  ifShowDetailsViewRefreshTags(): void {
    if (   this.appState.currentView === 'showDetails'
        || this.appState.currentView === 'showDetails2') {
      // details view shows tags but they don't update without some code that forces a refresh :(
      // hack-y code simply hides manual tags and then shows them again
      this.settingsButtons.manualTags.toggled = !this.settingsButtons.manualTags.toggled;
      this.cd.detectChanges();
      this.settingsButtons.manualTags.toggled = !this.settingsButtons.manualTags.toggled;
    }
  }

  /**
   * Toggle between batch tag edit mode and normal mode
   */
  toggleBatchTaggingMode(): void {
    if (this.batchTaggingMode) {
      this.imageElementService.imageElements.forEach((element: ImageElement) => {
        element.selected = false;
      });
    }
    this.batchTaggingMode = !this.batchTaggingMode;
  }

  /**
   * Select all visible videos for batch tagging
   */
  selectAllVisible(): void {
    this.pipeSideEffectService.selectAll();
  }

  /**
   * Deselect all videos for batch tagging
   */
  unselectAllTags(): void {
    this.pipeSideEffectService.selectNone();
  }

  /**
   * Open modal with instructions for how to use the app. Only runs when `settings.json` is not found
   */
  showFirstRunMessage(): void {
    this.toggleButton('showThumbnails');
    this.isFirstRunEver = false;
    this.modalService.openWelcomeMessage();
  }


  /**
   * Scroll the settings modal to the top
   */
  scrollSettingsToTop(): void {
    if (this.settingsModal) {
      this.settingsModal().nativeElement.scrollTop = 0;
    }
  }

  /**
   * Clear all filters and search strings
   * This is used when the user clicks the "Clear All Filters" button
   * It resets all filter arrays, bounds, and toggles all filter buttons off
   */
  clearAllFilters(): void {
    // Clear all filter arrays and bools
    this.filters.forEach((filter) => {
      filter.array = [];
      filter.branchPaths = [];
      filter.exactPaths = [];
      filter.bool = false;
      filter.string = '';
    });

    // Clear Duration filter
    this.durationLeftBound = 0;
    this.durationRightBound = Infinity;
    this.toggleButtonOff('durationFilter');

    // Clear Size filter
    this.sizeLeftBound = 0;
    this.sizeRightBound = Infinity;
    this.toggleButtonOff('sizeFilter');

    // Clear Times Played filter
    this.timesPlayedLeftBound = -1;
    this.timesPlayedRightBound = Infinity;
    this.toggleButtonOff('timesPlayedFilter');

    // Clear Resolution filter
    this.freqLeftBound = 0;
    this.freqRightBound = Infinity;
    this.toggleButtonOff('resolutionFilter');

    // Clear Year filter
    this.yearLeftBound = 0;
    this.yearRightBound = Infinity;
    this.toggleButtonOff('yearFilter');

    // Clear Star filter
    this.starLeftBound = 0;
    this.starRightBound = Infinity;
    this.toggleButtonOff('starFilter');

    // Clear starts-with filter
    this.startsWithSearchString = '';

    // Clear search strings
    this.fuzzySearchString = '';
    this.magicSearchString = '';
    this.regexSearchString = '';

    if (this.settingsButtons['showOnlyPlaylist'].toggled) {
      this.settingsButtons['showOnlyPlaylist'].toggled = false;
    }

    if (this.settingsButtons['showOnlyFavorites'].toggled) {
      this.settingsButtons['showOnlyFavorites'].toggled = false;
    }

    // Prevent ExpressionChangedAfterItHasBeenCheckedError
    this.cd.detectChanges();
  }

  /**
   * Handle tag color selection from color picker
   */
  onTagColorSelected(color: string | null): void {
    this.manualTagsService.setTagColor(this.currentTagName, color);
    this.showTagColorPicker = false;
    // setTagColor will trigger tagColorUpdatedSubject which updates all views
  }

  /**
   * Close tag color picker
   */
  onTagColorPickerClose(): void {
    this.showTagColorPicker = false;
    this.cd.detectChanges();
  }

  emptyPlaylist(): void {
    this.imageElementService.emptyPlaylist();
    this.settingsButtons['showOnlyPlaylist'].toggled = false;
  }

  refreshPlaylistIfShowing(): void {
    if (this.settingsButtons['showOnlyPlaylist'].toggled) {
      this.playlistViewRefresh = !this.playlistViewRefresh;
    }
  }

  /**
   * HACK to avoid a bug that's hard to diagnose
   * without it, switching from one hub to another breaks tags (!)
   * while tray updates, clicking on a tag doesn't auto-show it
   * worse-yet, afterwards the tag in sidebar search isn't clickable
   * that is - change happens, but UI doesn't update until you hover over thumbnail (or similar UI interaction)
   *
   * simplest replication:
   * 1) start app
   * 2) open tags (or have it open by default)
   * 3) switch to another hub (notice tags update)
   * 4) click a tag - it doesn't update until change-detection runs (hover over video)
   */
  fixManualTagTrayBreakingBug(): void {
      if (this.settingsButtons['showTagTray'].toggled) {
        this.settingsButtons['showTagTray'].toggled = false;
        this.cd.detectChanges();
        setTimeout(() => {
          this.zone.run(() => {
            this.settingsButtons['showTagTray'].toggled = true;
            this.cd.detectChanges();
            this.scheduleGalleryLayoutRefresh(GALLERY_LAYOUT_TRANSITION_MS);
          });
        }, 0);
      }
  }

}
