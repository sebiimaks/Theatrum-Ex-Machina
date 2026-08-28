import { Injectable } from '@angular/core';

import type { FinalObject } from '../../../interfaces/final-object.interface';
import {
  buildCatalogueDocument,
  catalogueDocumentForSave,
  collectCatalogueDocumentSource,
} from '../common/catalogue-session-document';
import type {
  CatalogueDocumentContext,
  CatalogueDocumentStateSources,
} from '../common/catalogue-session-document';
import { AutoTagsSaveService } from '../components/tags-auto/tags-save.service';
import { ManualTagsService } from '../components/tags-manual/manual-tags.service';
import { SourceFolderService } from '../components/statistics/source-folder.service';
import { ImageElementService } from './image-element.service';

/** Collects the live renderer-owned catalogue fields for persistence. */
@Injectable({ providedIn: 'root' })
export class CatalogueSessionDocumentService {

  constructor(
    private readonly autoTagsSaveService: AutoTagsSaveService,
    private readonly imageElementService: ImageElementService,
    private readonly manualTagsService: ManualTagsService,
    private readonly sourceFolderService: SourceFolderService,
  ) {}

  buildDocument(context: CatalogueDocumentContext): FinalObject {
    return buildCatalogueDocument(collectCatalogueDocumentSource(context, this.stateSources));
  }

  documentForSave(context: CatalogueDocumentContext): FinalObject | null {
    return catalogueDocumentForSave(collectCatalogueDocumentSource(context, this.stateSources));
  }

  private get stateSources(): CatalogueDocumentStateSources {
    return {
      autoTags: this.autoTagsSaveService,
      images: this.imageElementService,
      manualTags: this.manualTagsService,
      sourceFolders: this.sourceFolderService,
    };
  }
}
