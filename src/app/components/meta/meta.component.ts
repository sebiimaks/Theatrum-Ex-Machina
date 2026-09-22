import type { OnInit, ElementRef, OnDestroy } from '@angular/core';
import { ChangeDetectorRef, input, output, viewChild } from '@angular/core';
import { Component, Input } from '@angular/core';

import type { Subscription, Observable } from 'rxjs';

import { ElectronService } from '../../providers/electron.service';
import { FilePathService } from '../views/file-path.service';
import { ImageElementService } from './../../services/image-element.service';
import { ManualTagsService } from '../tags-manual/manual-tags.service';
import { RendererMutationService } from '../../services/renderer-mutation.service';

import type { StarRating, ImageElement } from '../../../../interfaces/final-object.interface';
import {
  planVideoTagBranchRemoval,
  tagPathsEqual,
} from '../../../../interfaces/tag-hierarchy';
import type { TagEmit, RenameFileResponse } from '../../../../interfaces/shared-interfaces';

import { SettingsButtons } from '../../common/settings-buttons';


@Component({
  standalone: false,
  selector: 'app-meta-item',
  templateUrl: './meta.component.html',
  styleUrls: [ './meta.component.scss' ]
})
export class MetaComponent implements OnInit, OnDestroy {

  readonly yearInput = viewChild<ElementRef>('yearInput');

  readonly filterTag = output<TagEmit>();

  @Input() video: ImageElement;

  readonly darkMode = input<boolean>();
  readonly imgHeight = input<number>();
  readonly individualTagSegments = input<boolean>(false);
  readonly largerFont = input<boolean>();
  readonly maxWidth = input<number>();
  readonly notesPlaceholder = input<string>('TAGS.notes');
  readonly selectedSourceFolder = input<string>();
  readonly showAutoFileTags = input<boolean>();
  readonly showAutoFolderTags = input<boolean>();
  readonly showManualTags = input<boolean>();
  readonly showMeta = input<boolean>();
  readonly showVideoNotes = input<boolean>();
  readonly star = input<StarRating>();

  @Input() starRatingHack: StarRating;

  readonly renameResponse = input<Observable<RenameFileResponse>>();

  yearHack: number;

  tagViewUpdateTrigger = false;

  renamingWIP = '';
  renameError = false;

  responseSubscription: Subscription;
  tagColorSubscription: Subscription;

  sortAutoTags = SettingsButtons['sortAutoTags'].toggled;

  selectedTagForColor: string = '';
  private destroyed = false;

  constructor(
    private cd: ChangeDetectorRef,
    public electronService: ElectronService,
    public filePathService: FilePathService,
    public imageElementService: ImageElementService,
    public manualTagsService: ManualTagsService,
    private readonly mutations: RendererMutationService,
  ) { }

  ngOnInit() {
    this.starRatingHack = this.star();
    this.yearHack = this.video.year;

    this.renamingWIP = this.video.cleanName; // or should this be video.fileName (without extension!?)

    this.responseSubscription = this.renameResponse().subscribe((data: RenameFileResponse) => {
      if (data) {
        console.log('Rename response:');
        console.log(data);

        if (this.video.index === data.index) { // make sure the message is about current component's video
          if (data.success) {
            this.renamingWIP = data.renameTo.split('.').slice(0, -1).join('.'); // removes the extension (e.g. ".mp4")
            this.renameError = false;
          } else {
            this.renameError = true;
            this.cd.detectChanges();
          }
        }
      }
    });

    // Subscribe to tag color updates
    this.tagColorSubscription = this.manualTagsService.tagColorUpdatedSubject.subscribe(() => {
      this.tagViewUpdateTrigger = !this.tagViewUpdateTrigger;
      this.cd.detectChanges();
    });

  }

  addThisTag(tag: string) {
    if (!this.canMutate) { return; }
    if (this.video.tags?.some((existingTag: string) => tagPathsEqual(existingTag, tag))) {
      // console.log('TAG ALREADY ADDED!');
    } else {
      this.manualTagsService.addTag(tag);

      this.imageElementService.HandleEmission({
        index: this.video.index,
        tag: tag,
        type: 'add'
      });
    }
    this.tagViewUpdateTrigger = !this.tagViewUpdateTrigger;
  }

  filterThisTag(event: TagEmit) {
    if (!this.canMutate) { return; }
    this.filterTag.emit(event);
  }

  removeThisTag(tag: string) {
    if (!this.canMutate) { return; }
    this.manualTagsService.removeTag(tag);

    this.imageElementService.HandleEmission({
      index: this.video.index,
      tag: tag,
      type: 'remove'
    });
    this.tagViewUpdateTrigger = !this.tagViewUpdateTrigger;
  }

  /** Remove this video's displayed tag level and all of its descendants. */
  removeDisplayedTag(tag: string): void {
    if (!this.canMutate) { return; }
    if (!this.individualTagSegments()) {
      this.removeThisTag(tag);
      return;
    }

    const plan = planVideoTagBranchRemoval(this.video.tags || [], tag);
    if (!plan.removedTags.length) {
      return;
    }

    const videoIndex = this.imageElementService.imageElements.indexOf(this.video);
    const applied = videoIndex !== -1
      && this.imageElementService.applyVideoTagBranchRemovalPlan(videoIndex, plan);
    if (!applied) {
      return;
    }

    this.manualTagsService.rebuildFromImages(this.imageElementService.imageElements);
    this.tagViewUpdateTrigger = !this.tagViewUpdateTrigger;
    this.cd.detectChanges();
  }

  /**
   * Handle tag right-click event - show color picker via service
   * @param event - Object containing tag and mouse event
   */
  onTagRightClick(event: { tag: any, event: PointerEvent }): void {
    if (!this.canMutate) { return; }
    const colourPath = event.tag.colourPath || event.tag.name;
    this.selectedTagForColor = colourPath;

    // Emit event to show color picker at home component level
    this.manualTagsService.showColorPickerSubject.next({
      tagName: colourPath,
      currentColor: event.tag.colour || '',
      position: {
        x: event.event.clientX,
        y: event.event.clientY
      }
    });
  }

  setStarRating(rating: StarRating): void {
    if (!this.canMutate) { return; }
    if (this.starRatingHack === rating) {
      rating = 0.5; // reset to "N/A" (not rated)
    }
    this.starRatingHack = rating; // hack for getting star opacity updated instantly
    this.imageElementService.HandleEmission({
      index: this.video.index,
      stars: rating,
    });
  }

  setHeart(): void {
    if (!this.canMutate) { return; }
    if (this.video.stars == 5.5) { // "un-favorite" the video
      this.imageElementService.HandleEmission({
        index: this.video.index,
        stars: 0.5,
      });
      this.starRatingHack = 0.5;
    } else { // "favorite" the video
      this.imageElementService.HandleEmission({
        index: this.video.index,
        stars: 5.5,
      });
      this.starRatingHack = 0.5;
    }
  }

  /**
   * Update the FinalArray with the year!
   * @param year
   */
  setYear(year: number): void {
    if (!this.canMutate) { return; }
    this.imageElementService.HandleEmission({
      index: this.video.index,
      year: year,
    });
  }

  /**
   * Prevent `e` and `.` input
   * @param event key press on the <input>
   */
  preventUnwantedKeypress(event: KeyboardEvent): void {
    if (event.key === '.'
     || event.key === 'e'
     || event.key === '-'
     || event.key === '+'
    ) {
      event.preventDefault();
    }
  }

  /**
   * Validate the year and save it to model
   * @param event
   */
  validateYear(event: any): void {
    if (!this.canMutate) { return; }
    const currVal = event.target.valueAsNumber;

    if (currVal < 1800 || currVal > 3000) {
      this.yearHack = 2000;
      this.cd.detectChanges();
    } else {
      // when deleting the year, currVal is NaN
      this.yearHack = isNaN(currVal) ? undefined : currVal;
    }
    this.yearInput().nativeElement.blur();
    this.setYear(this.yearHack);
  }

  /**
   * Auto-fill the year if it's not present
   * @param event
   */
  autoFillYear() {
    if (!this.canMutate) { return; }
    if (!this.yearHack) {
      this.yearHack = 2000;
      this.setYear(2000);
      const callback = this.mutations.capture();
      setTimeout(() => {
        if (!this.destroyed && this.mutations.isCurrent(callback)) {
          this.yearInput()?.nativeElement.select();
        }
      }, 1);
    }
  }

  /**
   * Try renaming file
   * happens on `Enter` / `Return` key press
   */
  tryRenamingFile() {
    if (!this.canMutate) { return; }
    this.renameError = false;

    const originalFile = this.video.fileName;
    const newFileName = this.renamingWIP + '.' + this.filePathService.getFileNameExtension(this.video.fileName);

    if (originalFile !== newFileName && this.renamingWIP.length !== 0) {
      this.electronService.ipcRenderer.send(
        'try-to-rename-this-file',
        this.video,
        newFileName,
        this.video.index
      );
    }
  }

  /**
   * Reset file to original name
   * happens on `Esc` key or `blur` event (focus out: via click, `tab` key, view switch, etc)
   */
  resetTitle(event): void {
    event.target.blur();
    this.renamingWIP = this.video.cleanName;
    event.stopPropagation();
    this.renameError = false;
  }

  /** Keep notes in the catalogue model before the selected video's panel closes. */
  saveVideoNotes(notes: string): void {
    if (!this.canMutate) { return; }
    if ((this.video.notes || '') === notes) {
      return;
    }
    this.video.notes = notes;
    this.imageElementService.finalArrayNeedsSaving = true;
  }

  private get canMutate(): boolean {
    return !this.destroyed && this.mutations.accepting;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.responseSubscription?.unsubscribe();
    if (this.tagColorSubscription) {
      this.tagColorSubscription.unsubscribe();
    }
  }
}
