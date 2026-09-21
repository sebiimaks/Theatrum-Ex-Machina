import type { PipeTransform } from '@angular/core';
import { Pipe } from '@angular/core';

import type { ImageElement } from '../../../interfaces/final-object.interface';
import { filterRecentlyPlayed } from '../common/workbench-navigation';

@Pipe({
  standalone: false,
  name: 'recentlyPlayedOnlyPipe'
})
export class RecentlyPlayedOnlyPipe implements PipeTransform {

  // Playback updates an existing item; the revision also invalidates Angular's pure-pipe cache.
  transform(videos: ImageElement[], recentOnly: boolean, playbackRevision: number): ImageElement[] {
    return filterRecentlyPlayed(videos, recentOnly);
  }

}
