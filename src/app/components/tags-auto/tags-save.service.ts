import { Injectable } from '@angular/core';
import { RendererMutationService } from '../../services/renderer-mutation.service';

@Injectable()
export class AutoTagsSaveService {

  addTags: string[] = [];
  removeTags: string[] = [];

  private tagsNeedSaving = false;

  constructor(private readonly mutations: RendererMutationService) {}

  get needToSaveTags(): boolean {
    return this.tagsNeedSaving;
  }

  set needToSaveTags(value: boolean) {
    if (value) { this.mutations.changed(); }
    this.tagsNeedSaving = value;
  }

  /** A confirmed save changes bookkeeping only; it does not replace tag data. */
  public markSaved(): void {
    this.tagsNeedSaving = false;
  }

  /**
   * Return `true` if tags have been updated
   */
  public needToSave(): boolean {
    return this.needToSaveTags;
  }

  /**
   * Add an `add` tag
   * @param tag
   */
  public addAddTag(tag: string): void {
    this.mutations.assertAccepting();
    this.needToSaveTags = true;

    const index = this.removeTags.indexOf(tag);

    if (index > -1) {
      this.removeTags.splice(index, 1);
    }

    if (this.addTags.indexOf(tag) === -1) {
      this.addTags.push(tag);
    }

    // console.log(this.addTags);
  }

  /**
   * Add a `remove` tag
   * @param tag
   */
  public addRemoveTag(tag: string): void {
    this.mutations.assertAccepting();
    this.needToSaveTags = true;

    const index = this.addTags.indexOf(tag);

    if (index > -1) {
      this.addTags.splice(index, 1);
    }

    if (this.removeTags.indexOf(tag) === -1) {
      this.removeTags.push(tag);
    }

    // console.log(this.removeTags);
  }

  /**
   * Get current add tags
   */
  public getAddTags(): string[] {
    return this.addTags;
  }

  /**
   * get current remove tags
   */
  public getRemoveTags(): string[] {
    return this.removeTags;
  }

  /**
   * Load `addTags` and `removeTags` from the .vha file
   * @param savedAddTags
   * @param savedRemoveTags
   */
  public restoreSavedTags(savedAddTags: string[], savedRemoveTags: string[]): void {
    this.mutations.assertAccepting();
    this.mutations.changed();
    this.addTags = savedAddTags.slice();
    this.removeTags = savedRemoveTags.slice();
    this.needToSaveTags = false;
  }

}
