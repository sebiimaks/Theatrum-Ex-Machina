import { Injectable } from '@angular/core';

import {
  calculateGalleryGeometry,
  calculateGalleryTextPadding,
} from '../common/gallery-layout';
import type {
  GalleryGeometryInput,
  GalleryGeometryResult,
  GalleryTextPaddingInput,
} from '../common/gallery-layout';

/**
 * Stateless layout policy for gallery cards. DOM measurement and render
 * scheduling remain in HomeComponent, where their lifecycle is observable.
 */
@Injectable({ providedIn: 'root' })
export class GalleryLayoutService {

  calculateGeometry(input: GalleryGeometryInput): GalleryGeometryResult {
    return calculateGalleryGeometry(input);
  }

  calculateTextPadding(input: GalleryTextPaddingInput): number | undefined {
    return calculateGalleryTextPadding(input);
  }
}
