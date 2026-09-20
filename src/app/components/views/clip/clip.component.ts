import { ChangeDetectorRef, computed, input, output } from '@angular/core';
import type { OnInit } from '@angular/core';
import { Component, HostListener, Input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

import { FilePathService } from '../file-path.service';
import { ImageElementService } from './../../../services/image-element.service';

import type { ImageElement } from '../../../../../interfaces/final-object.interface';
import { isMetadataImportFailure } from '../../../../../interfaces/final-object.interface';
import type { RightClickEmit, VideoClickEmit } from '../../../../../interfaces/shared-interfaces';

import { metaAppear, textAppear } from '../../../common/animations';

@Component({
  standalone: false,
  selector: 'app-clip-item',
  templateUrl: './clip.component.html',
  styleUrls: [
      '../clip-and-preview.scss',
      '../time-and-rez.scss',
      './clip.component.scss',
      '../import-error-placeholder.scss',
      '../selected.scss'
    ],
  animations: [ textAppear, metaAppear ]
})
export class ClipComponent implements OnInit {

  readonly rightClick = output<RightClickEmit>();
  readonly sheetClick = output<any>(); // does not emit data of any kind
  readonly videoClick = output<VideoClickEmit>();

  @Input() video: ImageElement;

  readonly autoplay = input<boolean>();
  readonly compactView = input<boolean>();
  readonly darkMode = input<boolean>();
  readonly elHeight = input<number>();
  readonly elWidth = input<number>();
  readonly folderPath = input<string>();
  readonly forceMute = input<boolean>();
  readonly defaultThumbnailMode = input<boolean>();
  readonly returnToFirstScreenshot = input<boolean>();
  readonly hubName = input<string>();
  readonly imgHeight = input<number>();
  readonly largerFont = input<boolean>();
  readonly showMeta = input<boolean>();

  appInFocus = true;
  readonly folderPosterPaths = computed(() => this.video.hash.split(':').slice(0, 4).map(
    (hash) => this.filePathService.createFilePath(
      this.folderPath(), this.hubName(), this.defaultThumbnailMode() ? 'thumbnails' : 'clips',
      hash, false, this.video.uuid,
    ),
  ));
  readonly folderThumbPaths = computed(() => this.video.hash.split(':').slice(0, 4).map(
    (hash) => this.filePathService.createFilePath(this.folderPath(), this.hubName(), 'clips', hash, true),
  ));
  hover: boolean;
  noError = true;
  readonly pathToVideo = computed(() => this.filePathService.createFilePath(
    this.folderPath(), this.hubName(), 'clips', this.video.hash, true,
  ));
  readonly poster = computed(() => this.filePathService.createFilePath(
    this.folderPath(), this.hubName(), this.defaultThumbnailMode() ? 'thumbnails' : 'clips',
    this.video.hash, false, this.video.uuid,
  ));

  constructor(
    public cd: ChangeDetectorRef,
    public filePathService: FilePathService,
    public imageElementService: ImageElementService,
    public sanitizer: DomSanitizer
  ) { }

  @HostListener('mouseenter') onMouseEnter() {
    this.hover = true;
  }
  @HostListener('mouseleave') onMouseLeave() {
    this.hover = false;
  }
  @HostListener('window:blur', ['$event'])
  onBlur(event: any): void {
    this.appInFocus = false;
  }
  @HostListener('window:focus', ['$event'])
  onFocus(event: any): void {
    this.appInFocus = true;
  }

  stopPreview(event): any {
    if (this.defaultThumbnailMode() && this.returnToFirstScreenshot()) {
      event.target.load(); // Reload original thumbnail
    } else {
      event.target.pause();
    }
  }

  playPreview(event: Event): void {
    const preview = event.currentTarget as HTMLVideoElement | null;
    if (!preview) {
      return;
    }
    void preview.play().catch(() => preview.load());
  }

  mutePreview(event: Event): void {
    const preview = event.currentTarget as HTMLVideoElement | null;
    if (preview) {
      preview.muted = true;
    }
  }

  unmutePreview(event: Event): void {
    const preview = event.currentTarget as HTMLVideoElement | null;
    if (preview) {
      preview.muted = false;
    }
  }

  startAutoplayPreview(event: Event): void {
    const preview = event.currentTarget as HTMLVideoElement | null;
    if (!preview) {
      return;
    }
    setTimeout(() => void preview.play().catch(() => undefined), Math.floor(Math.random() * 500));
  }

  ngOnInit() {

    if (isMetadataImportFailure(this.video) || this.video.hash === undefined) {
      this.noError = false;
    }
  }

  toggleHeart(mouseClick: PointerEvent): void {
    mouseClick.stopPropagation();
    this.imageElementService.toggleHeart(this.video.index);
  }

}
