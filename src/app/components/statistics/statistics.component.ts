import type { DoCheck, OnInit, OnDestroy } from '@angular/core';
import { ChangeDetectorRef, input, output } from '@angular/core';
import { Component, Input } from '@angular/core';

import type { Observable, Subscription } from 'rxjs';

import { ElectronService } from '../../providers/electron.service';
import { ImageElementService } from './../../services/image-element.service';
import { SourceFolderService } from './source-folder.service';

import type { AppStateInterface } from '../../common/app-state';
import type { ImageElement, ScreenshotSettings, InputSources } from '../../../../interfaces/final-object.interface';
import { isMetadataImportFailure } from '../../../../interfaces/final-object.interface';
import { getImageLocations } from '../../../../interfaces/media-locations';
import {
  configuredSourceRootsEqual,
  normalizeIgnoredSubdirectories,
} from '../../../../interfaces/source-folder-path';
import {
  buildSourceFolderTree,
  normalizeSourceFolderRelativePath,
} from '../../../../interfaces/source-folder-tree';
import type { SourceFolderTreeNode } from '../../../../interfaces/source-folder-tree';

import { metaAppear, breadcrumbWordAppear } from '../../common/animations';

export interface FolderThumbnailRegenerationStatus {
  cancelling?: boolean;
  completedJobs: number;
  relativePath?: string;
  sourceIndex: number;
  totalJobs: number;
}

export interface FolderScopeTarget {
  relativePath: string;
  sourceIndex: number;
}

@Component({
  standalone: false,
  selector: 'app-statistics',
  templateUrl: './statistics.component.html',
  styleUrls: [
    '../wizard/wizard.component.scss',
    '../settings.scss',
    '../wizard-button.scss',
    './statistics.component.scss',
    './toggle.scss'
  ],
  animations: [metaAppear, breadcrumbWordAppear]
})
export class StatisticsComponent implements DoCheck, OnInit, OnDestroy {

  readonly deleteInputSourceFiles = output<number>();
  readonly cancelFolderThumbnailRegeneration = output<void>();
  readonly finalArrayNeedsSaving = output<any>();
  readonly regenerateFolderThumbnails = output<FolderScopeTarget>();
  readonly toggleIgnoredSubdirectory = output<FolderScopeTarget>();
  readonly exportVha2Catalogue = output<void>();

  readonly appState = input<AppStateInterface>();
  readonly catalogueReadOnly = input<boolean>(false);
  readonly darkMode = input<boolean>(false);
  readonly hubName = input<string>();
  readonly inputFolders = input<InputSources>();
  readonly folderThumbnailRegenerationStatus = input<FolderThumbnailRegenerationStatus | null>(null);
  readonly numFolders = input<number>();
  readonly pathToVhaFile = input<string>();

  @Input() screenshotSettings: ScreenshotSettings;

  readonly inputFolderChosen = input<Observable<string>>();
  readonly numberScreenshotsDeleted = input<Observable<number>>();
  readonly oldFolderReconnected = input<Observable<{ source: number; path: string; }>>();

  eventSubscriptionMap: Map<string, Subscription> = new Map();

  totalFiles: number;

  canExportVha2Copy(): boolean {
    return !this.catalogueReadOnly()
      && /\.scaena$/i.test(this.pathToVhaFile() || '');
  }

  // Length
  longest = 0;
  shortest = Infinity;
  totalLength = 0;
  avgLength: number;

  // Size
  largest = 0;
  smallest = Infinity;
  totalSize = 0;
  avgSize: number;

  // For cleaning old screenshots
  showNumberDeleted = false;
  numberOfScreensDeleted = 0;

  removeFoldersMode = false;

  objectKeys = Object.keys; // to use in template
  private expandedFolderScopes = new Set<string>();
  private folderTrees = new Map<number, SourceFolderTreeNode>();
  private lastFolderTreeElements: ImageElement[] | undefined;
  private lastFolderTreeSourceSignature = '';
  private lastFolderTreeDirectoryRevision = -1;

  constructor(
    public cd: ChangeDetectorRef,
    public electronService: ElectronService,
    public sourceFolderService: SourceFolderService,
    public imageElementService: ImageElementService
  ) { }

  ngOnInit() {
    console.log('booting up!');
    this.computeAverages();


    this.eventSubscriptionMap.set('inputFolder', this.inputFolderChosen().subscribe((folderPath: string) => {
      if (folderPath) { // first emit from subscription is `undefined`
        this.handleInputFolderChosen(folderPath);
      }
    }));

    this.eventSubscriptionMap.set('folderReconnect', this.oldFolderReconnected().subscribe((data) => {
      if (data) { // first emit from subscription is `undefined`
        this.handleOldFolderReconnected(data.source, data.path);
      }
    }));

    this.eventSubscriptionMap.set('numberOfScreenshotsDeleted', this.numberScreenshotsDeleted().subscribe((deleted: number) => {
      if (deleted !== undefined) { // first emit from subscription is `undefined`
        this.handleScreenshotsDeleted(deleted);
      }
    }));
  }

  /**
   * After booting up, compute all the totals and averages to display
   */
  computeAverages() {
    console.log(this.inputFolders());

    this.longest = 0;
    this.shortest = Infinity;
    this.totalLength = 0;
    this.largest = 0;
    this.smallest = Infinity;
    this.totalSize = 0;
    let filesWithDurationMetadata = 0;

    this.imageElementService.imageElements.forEach((element: ImageElement): void => {
      if (!isMetadataImportFailure(element)) {
        this.shortest = Math.min(element.duration, this.shortest);
        this.longest = Math.max(element.duration, this.longest);
        this.totalLength += element.duration;
        filesWithDurationMetadata++;
      }

      this.smallest = Math.min(element.fileSize, this.smallest);
      this.largest = Math.max(element.fileSize, this.largest);
      this.totalSize += element.fileSize;
    });

    this.totalFiles = this.imageElementService.imageElements.length;

    if (this.shortest === Infinity) {
      this.shortest = 0;
    }
    if (this.smallest === Infinity) {
      this.smallest = 0;
    }
    this.avgLength = filesWithDurationMetadata > 0
      ? Math.round(this.totalLength / filesWithDurationMetadata)
      : 0;
    this.avgSize = this.totalFiles > 0
      ? Math.round(this.totalSize / this.totalFiles)
      : 0;
  }

  /**
   * Notify user of how many screenshots were deleted
   * @param numDeleted
   */
  handleScreenshotsDeleted(numDeleted: number) {
    console.log('deleted', numDeleted, 'screenshots');
    setTimeout(() => {

      this.numberOfScreensDeleted = numDeleted;
      this.showNumberDeleted = true;
      this.cd.detectChanges();
      setTimeout(() => {
        this.showNumberDeleted = false;
        this.cd.detectChanges();
      }, 3000);

    }, 1000); // make sure it doesn't appear instantly -- feels like an error if it happens to quickly :P
  }

  /**
   * Handle when old folder reconnects
   * @param sourceIndex
   * @param newPath
   */
  handleOldFolderReconnected(sourceIndex: number, newPath: string) {
    console.log('NEW FOLDER CHOSEN !!!');
    console.log(sourceIndex);
    console.log(newPath);
    this.inputFolders()[sourceIndex] = {
      ...this.inputFolders()[sourceIndex],
      path: newPath,
      watch: false,
    };
    this.sourceFolderService.clearSourceState(sourceIndex);
    this.sourceFolderService.sourceFolderConnected[sourceIndex] = false;
    this.finalArrayNeedsSaving.emit(true);
    this.electronService.ipcRenderer.send(
      'configure-source-folder',
      sourceIndex,
      newPath,
      true,
      this.appState().generatePreviewsOnFolderAddition,
    );
    setTimeout(() => {
      this.cd.detectChanges();
    }, 1);
  }

  /**
   * DO STUFF WHEN INPUT FOLDER WAS CHOSEN !!!
   * @param filePath
   */
  handleInputFolderChosen(filePath: string) {
    console.log('IT WORKS !!!!!');
    console.log('chosen: ', filePath);

    let pathAlreadyExists = false;

    Object.keys(this.inputFolders()).forEach((key: string) => {
      if (configuredSourceRootsEqual(this.inputFolders()[key].path, filePath)) {
        pathAlreadyExists = true;
      }
    });

    if (!pathAlreadyExists) {
      const nextIndex: number = this.pickNextIndex(this.inputFolders());
      this.inputFolders()[nextIndex] = { path: filePath, watch: false };
      this.sourceFolderService.clearSourceState(nextIndex);
      this.sourceFolderService.sourceFolderConnected[nextIndex] = false;
      this.finalArrayNeedsSaving.emit(true);
      this.electronService.ipcRenderer.send(
        'configure-source-folder',
        nextIndex,
        filePath,
        this.appState().scanFoldersOnAddition,
        this.appState().generatePreviewsOnFolderAddition,
      );
    }

    this.cd.detectChanges();

  }


  /**
   * Determine and return the next index for inputSource
   * Simply the next integer larger than the largest currently used index
   * @param inputSource
   */
  pickNextIndex(inputSource: InputSources) {
    const indexesAsStrings: string[] = Object.keys(inputSource);
    const indexesAsNumbers: number[] = indexesAsStrings.map((item: string) => parseInt(item, 10));

    return indexesAsNumbers.length > 0 ? Math.max(...indexesAsNumbers) + 1 : 0;
  }

  folderSourceIndex(itemSourceKey: string | number): number {
    return Number(itemSourceKey);
  }

  ngDoCheck(): void {
    const inputFolders = this.inputFolders();
    if (this.lastFolderTreeElements !== this.imageElementService.imageElements) {
      this.computeAverages();
    }
    const sourceSignature = Object.keys(inputFolders)
      .sort((left: string, right: string) => Number(left) - Number(right))
      .map((sourceKey: string) => {
        const folder = inputFolders[sourceKey];
        const ignoredSubdirectories = normalizeIgnoredSubdirectories(
          folder?.ignoredSubdirectories,
        );
        return `${sourceKey}\0${folder?.path || ''}\0${ignoredSubdirectories.join('\0')}`;
      })
      .join('\0');
    const directoryRevision = this.sourceFolderService.getDiscoveredDirectoryRevision();
    if (
      this.lastFolderTreeElements === this.imageElementService.imageElements
      && this.lastFolderTreeSourceSignature === sourceSignature
      && this.lastFolderTreeDirectoryRevision === directoryRevision
    ) {
      return;
    }

    this.lastFolderTreeElements = this.imageElementService.imageElements;
    this.lastFolderTreeSourceSignature = sourceSignature;
    this.lastFolderTreeDirectoryRevision = directoryRevision;
    const nextTrees = new Map<number, SourceFolderTreeNode>();
    Object.keys(inputFolders).forEach((sourceKey: string) => {
      const sourceIndex = this.folderSourceIndex(sourceKey);
      if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
        return;
      }

      // A hand-edited legacy catalogue must not make the Current Hub panel
      // unusable. Invalid relative paths remain untouched in the catalogue,
      // but are excluded from this display-only folder tree.
      const validTreeElements = this.imageElementService.imageElements.filter(
        (element: ImageElement): boolean => {
          let matchingLocations;
          try {
            matchingLocations = getImageLocations(element).filter(location => (
              Number(location.inputSource) === sourceIndex
            ));
          } catch {
            return false;
          }
          if (matchingLocations.length === 0) {
            return false;
          }
          try {
            matchingLocations.forEach(location => (
              normalizeSourceFolderRelativePath(location.partialPath)
            ));
            return true;
          } catch {
            return false;
          }
        },
      );
      nextTrees.set(sourceIndex, buildSourceFolderTree(
        validTreeElements,
        sourceIndex,
        this.sourceFolderService.getDiscoveredDirectories(sourceIndex),
        normalizeIgnoredSubdirectories(inputFolders[sourceKey]?.ignoredSubdirectories),
      ));
    });
    this.folderTrees = nextTrees;
  }

  folderScopeTarget(sourceIndex: string | number, relativePath = ''): FolderScopeTarget {
    return {
      relativePath: normalizeSourceFolderRelativePath(relativePath),
      sourceIndex: this.folderSourceIndex(sourceIndex),
    };
  }

  folderDisplayName(target: FolderScopeTarget): string {
    if (target.relativePath) {
      const segments = target.relativePath.split('/');
      return segments[segments.length - 1];
    }
    const folder = this.inputFolders()[target.sourceIndex];
    const folderPath = folder && folder.path ? folder.path : '';
    const segments = folderPath.split(/[\\/]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : folderPath;
  }

  folderRowTrackBy(_index: number, row: SourceFolderTreeNode): string {
    return this.folderScopeKey(row.sourceIndex, row.relativePath);
  }

  visibleFolderRows(itemSourceKey: string | number): SourceFolderTreeNode[] {
    const sourceIndex = this.folderSourceIndex(itemSourceKey);
    const root = this.folderTrees.get(sourceIndex);
    if (!root) {
      return [];
    }

    const visibleRows: SourceFolderTreeNode[] = [];
    const appendVisible = (node: SourceFolderTreeNode): void => {
      const hideEmpty = this.appState().hideSubdirectoriesWithNoVideos;
      const shouldDisplay = node.relativePath === ''
        || !hideEmpty
        || node.recursiveVideoCount > 0
        || node.ignored
        || node.containsIgnoredScope;
      if (!shouldDisplay) {
        return;
      }
      visibleRows.push(node);
      if (
        node.ignored
        || !this.isFolderScopeExpanded(node.sourceIndex, node.relativePath)
      ) {
        return;
      }
      node.children.forEach(appendVisible);
    };
    appendVisible(root);
    return visibleRows;
  }

  toggleFolderScope(row: SourceFolderTreeNode): void {
    if (row.ignored || row.children.length === 0) {
      return;
    }
    const key = this.folderScopeKey(row.sourceIndex, row.relativePath);
    if (this.expandedFolderScopes.has(key)) {
      this.expandedFolderScopes.delete(key);
    } else {
      this.expandedFolderScopes.add(key);
    }
  }

  isFolderScopeExpanded(sourceIndex: number, relativePath: string): boolean {
    return this.expandedFolderScopes.has(this.folderScopeKey(sourceIndex, relativePath));
  }

  folderScopeIsScanning(target: FolderScopeTarget): boolean {
    return this.sourceFolderService.currentlyScanning.get(target.sourceIndex) === true
      && this.sourceFolderService.getActiveScanScope(target.sourceIndex) === target.relativePath;
  }

  folderSourceIsBusy(sourceIndex: number): boolean {
    return this.sourceFolderService.currentlyScanning.get(sourceIndex) === true;
  }

  folderRegenerationMatches(target: FolderScopeTarget): boolean {
    const status = this.folderThumbnailRegenerationStatus();
    return status?.sourceIndex === target.sourceIndex
      && normalizeSourceFolderRelativePath(status.relativePath || '') === target.relativePath;
  }

  private folderScopeKey(sourceIndex: number, relativePath: string): string {
    return `${sourceIndex}:${normalizeSourceFolderRelativePath(relativePath)}`;
  }

  /**
   * Notify Node of watch status change
   * toggled via checkbox input in template
   */
  folderWatchStatusChange(index: number, shouldWatch: boolean) {
    this.finalArrayNeedsSaving.emit(true);
    console.log(index);
    console.log(shouldWatch);
    if (shouldWatch) {
      const inputFolders = this.inputFolders();
      console.log(inputFolders[index].path);
      this.tellNodeStartWatching(index, inputFolders[index].path, shouldWatch);
    } else {
      this.tellNodeStopWatching(index);
    }
  }

  /**
   * Single scan to add any new videos
   * @param index
   */
  rescanFolder(target: FolderScopeTarget) {
    this.electronService.ipcRenderer.send(
      'rescan-source-folder-scope',
      target.sourceIndex,
      target.relativePath,
      this.appState().generatePreviewsOnFolderAddition,
    );
    setTimeout(() => {
      this.cd.detectChanges(); // to update template whether to show "Rescan" or not
    }, 1);
  }

  /**
   * Add any missing thumbnails / resume thumbnail import
   * Tell node to find and extract all missing thumbnails
   */
  addMissingThumbnails() {
    console.log('trying to extract missing thumbnails');
    this.electronService.ipcRenderer.send(
      'add-missing-thumbnails',
      this.imageElementService.imageElements,
      this.screenshotSettings.clipSnippets > 0);
  }

  /**
   * Summon system modal to select folder
   */
  addAnotherFolder() {
    this.electronService.ipcRenderer.send('choose-input');
  }

  reconnectThisFolder(itemSourceKey: number) {
    console.log('RECONNECT this folder:', itemSourceKey);
    this.electronService.ipcRenderer.send('reconnect-this-folder', itemSourceKey);
  }

  /**
   * Delete an item source
   * @param itemSourceKey
   */
  deleteInputSource(itemSourceKey: number) {
    if (this.folderThumbnailRegenerationStatus()) {
      return;
    }
    console.log(itemSourceKey);
    const inputFolders = this.inputFolders();
    console.log(inputFolders[itemSourceKey]);
    this.tellNodeStopWatching(itemSourceKey);
    delete inputFolders[itemSourceKey];
    this.sourceFolderService.clearSourceState(itemSourceKey);
    this.deleteInputSourceFiles.emit(itemSourceKey);
  }

  /**
   * Tell node to delete all screenshots that are no longer in the hub
   */
  cleanScreenshotFolder(): void {
    console.log('cleaning screenshots!');
    this.electronService.ipcRenderer.send('clean-old-thumbnails', this.imageElementService.imageElements);
  }

  /**
   * Tell node to stop watching a particular folder
   * @param itemSourceKey from InputSources
   */
  tellNodeStopWatching(itemSourceKey: number) {
    this.electronService.ipcRenderer.send('stop-watching-folder', itemSourceKey);
  }

  /**
   * Tell node to start watching a particular folder
   * @param itemSourceKey from InputSources
   */
  tellNodeStartWatching(itemSourceKey: number, path: string, persistent: boolean) {
    this.electronService.ipcRenderer.send(
      'start-watching-folder',
      itemSourceKey,
      path,
      persistent,
      this.appState().generatePreviewsOnFolderAddition,
    );
  }

  trackByFn(index, item) {
    return(item.key);
  }

  /**
   * Show the gradient swipe-back-and-forth-animation for 3 seconds after clicking "rescan"
   * @param event
   */
  animateThis(event) {
    event.srcElement.classList.add('progress-gradient-animation');
    setTimeout(() => {
      if (event.srcElement.classList) { // this might not even be needed it seems
        event.srcElement.classList.remove('progress-gradient-animation');
      }
    }, 3000); // apparently nothing breaks if the component is closed before timeout finishes :)
  }


  /**
   * Unsubscribe from all the electron ipc events
   */
  ngOnDestroy() {
    this.eventSubscriptionMap.forEach((value) => {
      value.unsubscribe();
    });
  }

}
