import type { OnInit, ElementRef} from '@angular/core';
import { Component, input, output, viewChild } from '@angular/core';

import { FilePathService } from '../file-path.service';

import { metaAppear, textAppear } from '../../../common/animations';

import type { ImageElement } from '../../../../../interfaces/final-object.interface';
import { calculateFilmstripHoverPosition } from '../../../../../node/thumbnail-count';
import { ImageElementService } from './../../../services/image-element.service';
import type { RightClickEmit, VideoClickEmit } from '../../../../../interfaces/shared-interfaces';

@Component({
  standalone: false,
  selector: 'app-filmstrip-item',
  templateUrl: './filmstrip.component.html',
  styleUrls: [
      '../film-and-full.scss',
      '../time-and-rez.scss',
      '../selected.scss',
      '../import-error-placeholder.scss',
      './filmstrip.component.scss'
    ],
  animations: [ textAppear, metaAppear ]
})
export class FilmstripComponent implements OnInit {

  readonly filmstripHolder = viewChild<ElementRef>('filmstripHolder');

  readonly videoClick = output<VideoClickEmit>();
  readonly rightClick = output<RightClickEmit>();

  readonly video = input<ImageElement>();

  readonly compactView = input<boolean>();
  readonly darkMode = input<boolean>();
  readonly elHeight = input<number>();
  readonly folderPath = input<string>();
  readonly hoverScrub = input<boolean>();
  readonly hubName = input<string>();
  readonly imgHeight = input<number>();
  readonly largerFont = input<boolean>();
  readonly showMeta = input<boolean>();
  readonly showFavorites = input<boolean>();

  fullFilePath = '';
  filmXoffset = 0;
  indexToShow = 1;

  constructor(
    public filePathService: FilePathService,
    public imageElementService: ImageElementService
  ) { }

  ngOnInit() {
    this.fullFilePath = this.filePathService.createFilePath(this.folderPath(), this.hubName(), 'filmstrips', this.video().hash);
  }

  updateFilmXoffset(mouseMove: PointerEvent) {
    if (this.hoverScrub() && this.video().screens > 0) {
      const imgWidth = this.imgHeight() * (16 / 9); // hardcoded aspect ratio
      const holderBounds = this.filmstripHolder().nativeElement.getBoundingClientRect();
      const position = calculateFilmstripHoverPosition(
        this.video().screens,
        imgWidth,
        holderBounds.width,
        mouseMove.clientX - holderBounds.left,
      );
      this.indexToShow = position.frameIndex;
      this.filmXoffset = position.offset;
    }
  }

  toggleHeart(mouseClick: PointerEvent): void {
    mouseClick.stopPropagation();
    this.imageElementService.toggleHeart(this.video().index);
  }
}
