import { Injectable } from '@angular/core';

import * as path from 'path';

import { SourceFolderService } from '../statistics/source-folder.service';

import type { ImageElement, ImageLocation } from '../../../../interfaces/final-object.interface';
import {
  imageElementAtLocation,
  selectAvailableImageLocation,
} from '../../../../interfaces/media-locations';

type FolderType = 'thumbnails' | 'filmstrips' | 'clips';

@Injectable()
export class FilePathService {

  replaceMap: any = {
    ' ': '%20',
    '(': '%28',
    ')': '%29',
  };

  constructor(
    public sourceFolderService: SourceFolderService,
  ) { }

  /**
   * Build the browser-friendly path based on the input (only `/` and `%20`), prepend with `file://`
   * @param folderPath - path to where `vha-folder` is stored
   * @param hubName    - name of hub (to pick the correct `vha-folder` name)
   * @param subfolder  - whether `thumbnails`, `filmstrips`, or `clips`
   * @param hash       - file hash
   * @param video      - boolean -- if true then extension is `.mp4`
   * @param cacheKey   - optional value used to force Chromium to reload a replaced image
   */
  createFilePath(
    folderPath: string,
    hubName: string,
    subfolder: FolderType,
    hash: string,
    video?: boolean,
    cacheKey?: string,
  ): string {
    const filePath = 'file://' + path.normalize(path.join(
      folderPath,
      'vha-' + hubName,
      subfolder,
      hash + (video ? '.mp4' : '.jpg')
    )).replace(/\\/g, '/')
      .replace(/[ ()]/g, (match) => { return this.replaceMap[match]; });
      //         ^^^^^ replace the ` ` (space) as well as parentheses `(` and `)` with URL encoding from the `replaceMap`

    return cacheKey ? `${filePath}?v=${encodeURIComponent(cacheKey)}` : filePath;
  }

  /**
   * return file name without extension
   * e.g. `video.mp4` => `video`
   */
  getFileNameWithoutExtension(fileName: string): string {
    return fileName.slice().substr(0, fileName.lastIndexOf('.'));
  }

  /**
   * return extension without file name
   * e.g. `video.mp4` => `.mp4`
   */
  getFileNameExtension(fileName: string): string {
    return fileName.slice().split('.').pop();
  }

  /**
   * Return full filesystem path to video file
   */
  getPathFromImageElement(item: ImageElement): string {
    const location = this.getAvailableImageLocation(item);
    if (!location) {
      throw new Error('No available source location exists for this catalogue entry.');
    }
    return this.getPathFromImageLocation(location);
  }

  getAvailableImageLocation(item: ImageElement): ImageLocation | undefined {
    return selectAvailableImageLocation(item, (sourceIndex: number) => (
      Boolean(this.sourceFolderService.selectedSourceFolder[sourceIndex])
      && this.sourceFolderService.sourceFolderConnected[sourceIndex] === true
    ));
  }

  getPathFromImageLocation(location: ImageLocation): string {
    const source = this.sourceFolderService.selectedSourceFolder[location.inputSource];
    if (!source?.path) {
      throw new Error('The source folder for this media location is unavailable.');
    }
    return path.join(
      source.path,
      location.partialPath,
      location.fileName,
    );
  }

  projectToAvailableImageLocation(item: ImageElement): ImageElement | undefined {
    const location = this.getAvailableImageLocation(item);
    return location ? imageElementAtLocation(item, location) : undefined;
  }

}
