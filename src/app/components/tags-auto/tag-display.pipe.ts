import type { PipeTransform } from '@angular/core';
import { Pipe } from '@angular/core';

import { autoFileTagsRegex } from './autotags.service';
import { ManualTagsService } from '../tags-manual/manual-tags.service';

import { Colors } from '../../common/colors';
import type { ImageElement } from '../../../../interfaces/final-object.interface';
import type { Tag } from '../../../../interfaces/shared-interfaces';
import {
  TAG_PATH_SEPARATOR,
  getUniqueVideoTagSegments,
  tagIdentityKey,
} from '../../../../interfaces/tag-hierarchy';

@Pipe({
  standalone: false,
  name: 'tagDisplayPipe'
})
export class TagsDisplayPipe implements PipeTransform {

  constructor(private manualTagsService: ManualTagsService) { }

  transform(
    video: ImageElement,
    manualTags: boolean,
    autoFileTags: boolean,
    autoFolderTags: boolean,
    updateViewHack: boolean,
    individualTagSegments = false,
  ): Tag[] {

    const tags: Tag[] = [];

    const alreadyAdded = new Set<string>();
    const manualSegmentsByLabelIdentity = new Map<string, Tag[]>();
    const manualTagValues = Array.isArray(video.tags)
      ? video.tags
        .filter((tag: string) => typeof tag === 'string' && Boolean(tag))
        .sort((left: string, right: string) => {
          const identityComparison = tagIdentityKey(left).localeCompare(
            tagIdentityKey(right),
            'en',
            { numeric: true, sensitivity: 'base' },
          );
          return identityComparison || left.localeCompare(right, 'en', { numeric: true });
        })
      : [];

    if (manualTags) {
      if (individualTagSegments) {
        const manualSegments = getUniqueVideoTagSegments(manualTagValues);
        const segmentLabelCounts = new Map<string, number>();
        manualSegments.forEach(segment => {
          const labelIdentity = tagIdentityKey(segment.label);
          segmentLabelCounts.set(labelIdentity, (segmentLabelCounts.get(labelIdentity) || 0) + 1);
        });

        manualSegments.forEach(segment => {
          const labelIdentity = tagIdentityKey(segment.label);
          const separatorIndex = segment.colourPath.lastIndexOf(TAG_PATH_SEPARATOR);
          const parentPath = separatorIndex === -1
            ? ''
            : segment.colourPath.slice(0, separatorIndex);
          const tag: Tag = {
            colour: this.manualTagsService.getTagColor(segment.colourPath) || Colors.manualTags,
            colourPath: segment.colourPath,
            displayName: (segmentLabelCounts.get(labelIdentity) || 0) > 1 && parentPath
              ? `${segment.label} · ${parentPath}`
              : segment.label,
            name: segment.label,
            removable: true,
          };
          tags.push(tag);
          alreadyAdded.add(segment.identity);
          const matchingSegments = manualSegmentsByLabelIdentity.get(labelIdentity) || [];
          matchingSegments.push(tag);
          manualSegmentsByLabelIdentity.set(labelIdentity, matchingSegments);
        });
      } else {
        manualTagValues.forEach((tag: string) => {
          tags.push({
            name: tag,
            colour: this.manualTagsService.getTagColor(tag) || Colors.manualTags,
            removable: true
          });
          alreadyAdded.add(tagIdentityKey(tag));
        });
      }
    }

    if (autoFileTags) {
      const cleanedFileNameAsArray: string[] = video.cleanName.toLowerCase().match(autoFileTagsRegex) || [];
      cleanedFileNameAsArray.forEach(word => {
        const wordKey = tagIdentityKey(word);
        if (individualTagSegments) {
          const matchingManualTags = manualSegmentsByLabelIdentity.get(wordKey) || [];
          if (word.length >= 3) {
            matchingManualTags.forEach((matchingManualTag: Tag) => {
              matchingManualTag.autoFileMatch = true;
            });
          }
          return;
        }
        if (word.length >= 3 && !alreadyAdded.has(wordKey)) { // TODO - fix hardcoding ?
          tags.push({
            name: word,
            colour: Colors.autoFileTags,
            removable: false
          });
          alreadyAdded.add(wordKey);
        }
      });
    }

    if (autoFolderTags) {
      const cleanedFileName: string = video.partialPath.toLowerCase().replace('.', '');
      cleanedFileName.split('/').forEach(word => {
        const wordKey = tagIdentityKey(word);
        if (individualTagSegments) {
          const matchingManualTags = manualSegmentsByLabelIdentity.get(wordKey) || [];
          if (word.length >= 3) {
            matchingManualTags.forEach((matchingManualTag: Tag) => {
              matchingManualTag.autoFolderMatch = true;
            });
          }
          return;
        }
        if (word.length >= 3 && !alreadyAdded.has(wordKey)) { // TODO - fix hardcoding ?
          tags.push({
            name: word,
            colour: Colors.autoFolderTags,
            removable: false
          });
          alreadyAdded.add(wordKey);
        }
      });
    }

    return tags;
  }
}
