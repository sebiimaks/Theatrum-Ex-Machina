import type { OnInit} from '@angular/core';
import { Component, Input, input, output } from '@angular/core';

import { FilePathService } from '../file-path.service';

import { metaAppear, textAppear } from '../../../common/animations';
import { calculateFullViewLayout } from '../../../common/virtual-scroll-layout';

import type { ImageElement } from '../../../../../interfaces/final-object.interface';
import { isMetadataImportFailure } from '../../../../../interfaces/final-object.interface';
import { ImageElementService } from './../../../services/image-element.service';
import type { RightClickEmit, VideoClickEmit } from '../../../../../interfaces/shared-interfaces';

@Component({
  standalone: false,
  selector: 'app-full-item',
  host: {
    '[style.display]': "'block'",
    '[style.height.px]': 'measuredContentHeight',
    '[style.margin]': "'20px 20px 5px'",
  },
  templateUrl: './full.component.html',
  styleUrls: [
      '../time-and-rez.scss',
      '../film-and-full.scss',
      '../selected.scss',
      '../import-error-placeholder.scss',
      './full.component.scss'
    ],
  animations: [ textAppear, metaAppear ]
})
export class FullViewComponent implements OnInit {

  readonly videoClick = output<VideoClickEmit>();
  readonly rightClick = output<RightClickEmit>();

  @Input()
  set galleryWidth(galleryWidth: number) {
    this._metaWidth = galleryWidth;
    this.render();
  }

  @Input()
  set imgHeight(imageHeight: number) {
    this._imgHeight = imageHeight;
    this.render();
  }

  readonly video = input<ImageElement>();

  readonly darkMode = input<boolean>();
  readonly elHeight = input<number>();
  readonly folderPath = input<string>();
  readonly hubName = input<string>();
  readonly largerFont = input<boolean>();
  readonly showMeta = input<boolean>();
  readonly showFavorites = input<boolean>();

  _imgHeight: number;
  _metaWidth: number;
  computedWidth = 0;
  fullFilePath = '';
  rowOffsets: number[] = [];

  constructor(
    public filePathService: FilePathService,
    public imageElementService: ImageElementService
  ) { }

  ngOnInit() {
    this.fullFilePath = this.filePathService.createFilePath(this.folderPath(), this.hubName(), 'filmstrips', this.video().hash);
    this.render();
  }

  render(): void {
    const layout = calculateFullViewLayout(
      this._metaWidth,
      this._imgHeight,
      this.video()?.screens ?? 0,
    );
    this.computedWidth = layout.computedWidth;
    this.rowOffsets = layout.rowOffsets;
  }

  get measuredContentHeight(): number {
    if (!Number.isFinite(this._imgHeight) || this._imgHeight <= 0) {
      return 0;
    }

    const video = this.video();
    const imageRowsHeight = video && isMetadataImportFailure(video)
      ? this._imgHeight
      : this.rowOffsets.length * this._imgHeight;
    return imageRowsHeight + 30;
  }

  isImportFailure(): boolean {
    return isMetadataImportFailure(this.video());
  }

  toggleHeart(mouseClick: PointerEvent): void {
    mouseClick.stopPropagation();
    this.imageElementService.toggleHeart(this.video().index);
  }
}
