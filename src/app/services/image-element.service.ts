import { Injectable } from '@angular/core';

import type { DefaultScreenEmission, StarEmission } from '../components/sheet/sheet.component';
import type { ImageElement } from './../../../interfaces/final-object.interface';
import type {
  TagBranchMovePlan,
  TagBranchRemovalPlan,
  VideoTagBranchRemovalPlan,
} from './../../../interfaces/tag-hierarchy';
import { tagPathsEqual } from './../../../interfaces/tag-hierarchy';
import { renameImageLocationFile } from './../../../interfaces/media-locations';
import type { TagEmission } from './../../../interfaces/shared-interfaces';
import type { YearEmission} from './../components/views/details/details.component';

@Injectable({ providedIn: 'root' })
export class ImageElementService {

  public finalArrayNeedsSaving = false;
  public forceStarFilterUpdate = true;
  public imageElements: ImageElement[] = [];

  constructor() { }

  /**
   * Update imageElements with emission of element
   * @param emission
   */
  HandleEmission(emission: YearEmission | StarEmission | TagEmission | DefaultScreenEmission): void {
    const index: number = emission.index;

    if (       'year' in emission) {

      this.imageElements[index].year =          (emission as YearEmission).year;

    } else if ('stars' in emission) {

      this.imageElements[index].stars =         (emission as StarEmission).stars;
      this.forceStarFilterUpdate = !this.forceStarFilterUpdate;

    } else if ('defaultScreen' in emission) {

      this.imageElements[index].defaultScreen = (emission as DefaultScreenEmission).defaultScreen;

    } else if ('tag' in emission) {

      this.handleTagEmission(emission as TagEmission);

    } else {
      console.log('THIS SHOULD NOT HAPPEN!');
    }

    this.finalArrayNeedsSaving = true;
  }

  /**
   * Searches through the `finalArray` and updates the file name and display name
   * Should not error out if two files have the same name
   */
  replaceFileNameInFinalArray(renameTo: string, oldFileName: string, index: number): void {

    if (this.imageElements[index].fileName === oldFileName) {
      if (!renameImageLocationFile(this.imageElements[index], oldFileName, renameTo)) {
        this.imageElements[index].fileName = renameTo;
      }
      this.imageElements[index].cleanName = renameTo.slice().substr(0, renameTo.lastIndexOf('.'));
    }

    this.finalArrayNeedsSaving = true;
  }

  /**
   * update number of times played & the `lastPlayed` date
   * @param index
   */
  updateNumberOfTimesPlayed(index: number): void {

    this.imageElements[index].lastPlayed = Date.now(); // update `lastPlayed`

    if (this.imageElements[index].timesPlayed) {
      this.imageElements[index].timesPlayed++;
    } else {
      this.imageElements[index].timesPlayed = 1;
    }

    this.finalArrayNeedsSaving = true;
  }

  /**
   * Reset the number of times played for every file in the current hub.
   */
  resetTimesPlayed(): void {
    let changed = false;

    this.imageElements.forEach((element: ImageElement) => {
      if (element.timesPlayed !== 0) {
        element.timesPlayed = 0;
        changed = true;
      }
    });

    if (changed) {
      this.imageElements = this.imageElements.slice();
      this.finalArrayNeedsSaving = true;
    }
  }

  /**
   * Remove a manual tag from every video in the current catalogue.
   * Returns the number of videos that were changed.
   */
  removeTagFromAll(tag: string): number {
    return this.removeTagsFromAll([tag]);
  }

  /** Remove several equivalent exact tag values in one catalogue pass. */
  removeTagsFromAll(tags: readonly string[]): number {
    let affectedVideoCount = 0;

    this.imageElements.forEach((element: ImageElement) => {
      if (!element.tags?.some((existingTag: string) => (
        typeof existingTag === 'string'
        && tags.some((tag: string) => tagPathsEqual(existingTag, tag))
      ))) {
        return;
      }

      element.tags = element.tags.filter((existingTag: string) => (
        typeof existingTag !== 'string'
        || !tags.some((tag: string) => tagPathsEqual(existingTag, tag))
      ));
      affectedVideoCount++;
    });

    if (affectedVideoCount > 0) {
      this.imageElements = this.imageElements.slice();
      this.finalArrayNeedsSaving = true;
    }

    return affectedVideoCount;
  }

  /** Apply a freshly revalidated hierarchy-removal plan in one transaction. */
  applyTagBranchRemovalPlan(plan: TagBranchRemovalPlan): number {
    let affectedVideoCount = 0;

    plan.entries.forEach((entry) => {
      const element = this.imageElements[entry.index];
      if (!element || !entry.removedTags.length) {
        return;
      }
      element.tags = entry.remainingTags.slice();
      affectedVideoCount++;
    });

    if (affectedVideoCount > 0) {
      this.imageElements = this.imageElements.slice();
      this.finalArrayNeedsSaving = true;
    }

    return affectedVideoCount;
  }

  /** Apply a freshly revalidated hierarchy-move plan in one transaction. */
  applyTagBranchMovePlan(plan: TagBranchMovePlan): number {
    const planIsCurrent = plan.entries.every((entry) => {
      const currentTags = this.imageElements[entry.index]?.tags;
      return Array.isArray(currentTags)
        && currentTags.length === entry.originalTags.length
        && currentTags.every((tag: string, index: number) => tag === entry.originalTags[index]);
    });

    if (!planIsCurrent) {
      return 0;
    }

    plan.entries.forEach((entry) => {
      this.imageElements[entry.index].tags = entry.updatedTags.slice();
    });

    if (plan.entries.length > 0) {
      this.imageElements = this.imageElements.slice();
      this.finalArrayNeedsSaving = true;
    }

    return plan.entries.length;
  }

  /** Apply a revalidated hierarchy-branch removal to one exact video. */
  applyVideoTagBranchRemovalPlan(
    index: number,
    plan: VideoTagBranchRemovalPlan,
  ): boolean {
    const element = this.imageElements[index];
    const currentTags = element?.tags;
    const planIsCurrent = Array.isArray(currentTags)
      && currentTags.length === plan.originalTags.length
      && currentTags.every((tag: string, tagIndex: number) => (
        tag === plan.originalTags[tagIndex]
      ));

    if (!element || !plan.removedTags.length || !planIsCurrent) {
      return false;
    }

    element.tags = plan.remainingTags.slice();
    this.imageElements = this.imageElements.slice();
    this.finalArrayNeedsSaving = true;
    return true;
  }

  /**
   * Toggle heart
   */
  toggleHeart(index: number): void {
    if (this.imageElements[index].stars == 5.5) { // "un-favorite" the video
      this.HandleEmission({
        index: index,
        stars: 0.5
      });
    } else { // "favorite" the video
      this.HandleEmission({
        index: index,
        stars: 5.5
      });
    }
  }

  /**
   * Update playlist field
   */
  updatePlaylist(index: number): void {

    if (this.imageElements[index].playlist) {
      delete this.imageElements[index].playlist;
    } else {
      this.imageElements[index].playlist = Date.now();
    }

    this.finalArrayNeedsSaving = true;
  }

  /**
   * Clear out the playlist
   */
  emptyPlaylist(): void {
    this.imageElements.forEach((element) => {
      delete element.playlist;
    });

    this.finalArrayNeedsSaving = true;
  }

  private handleTagEmission(emission: TagEmission): void {
    const position: number = emission.index;
    const element = this.imageElements[position];
    if (!element) {
      return;
    }

    if (emission.type === 'add') {
      if (element.tags) {
        if (!element.tags.some((existingTag: string) => (
          typeof existingTag === 'string' && tagPathsEqual(existingTag, emission.tag)
        ))) {
          element.tags.push(emission.tag);
        }
      } else {
        element.tags = [emission.tag];
      }
    } else {
      const tagIndex = element.tags?.indexOf(emission.tag) ?? -1;
      if (tagIndex !== -1) {
        element.tags.splice(tagIndex, 1);
      }
    }
  }

}
