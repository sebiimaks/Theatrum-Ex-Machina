import type { PipeTransform } from '@angular/core';
import { Pipe } from '@angular/core';

import { ManualTagsService } from '../components/tags-manual/manual-tags.service';
import { tagIdentityKey } from '../../../interfaces/tag-hierarchy';

@Pipe({
  standalone: false,
  name: 'manualTagSortPipe'
})
export class ManualTagSortPipe implements PipeTransform {

  constructor(
    public manualTagService: ManualTagsService
  ) {}

  /**
   * Return all the tags by frequency or in alphabetical order
   * @param allTags
   * @param filterString    - remove all tags that do not contain this string
   * @param sortByFrequency - if false, will sort alphabetically
   * @param forceUpdateHack - boolean that is toggled manually to force updating the list
   */
  transform(allTags: string[], filterString: string, sortByFrequency: boolean, forceUpdateHack: boolean): string[] {
    const normalizedFilter = filterString.trim().normalize('NFC').toLowerCase();
    const filteredTags = normalizedFilter
      ? allTags.filter((tag: string) => tagIdentityKey(tag).includes(normalizedFilter))
      : allTags.slice();

    return filteredTags.sort((left: string, right: string) => {
      if (sortByFrequency) {
        const frequencyDifference = (this.manualTagService.tagsFrequencyMap.get(right) || 0)
          - (this.manualTagService.tagsFrequencyMap.get(left) || 0);
        if (frequencyDifference !== 0) {
          return frequencyDifference;
        }
      }

      const identityComparison = tagIdentityKey(left).localeCompare(
        tagIdentityKey(right),
        'en',
        { numeric: true, sensitivity: 'base' },
      );
      return identityComparison || left.localeCompare(right, 'en', { numeric: true });
    });
  }

}
