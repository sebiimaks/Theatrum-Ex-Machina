// Huge thank you to @ErikDvorcak for creating the entirety of the Touch Bar functionality
// see Video-Hub-App/pull/299
// This code was once in `main.ts` but was moved to keep the `main.ts` file smaller

import { app, TouchBar } from 'electron';
import * as path from 'path';
import { GLOBALS } from './main-globals';

import { AllSupportedViews, SupportedView } from '../interfaces/shared-interfaces';

// TODO -- deduplicate the imports code
const codeRunningOnMac: boolean = process.platform === 'darwin';
const args = process.argv.slice(1);
const serve: boolean = !app.isPackaged && args.some(val => val === '--serve');

// =================================================================================================
const nativeImage = require('electron').nativeImage;
const { TouchBarPopover, TouchBarSegmentedControl } = TouchBar;
const resourcePath = serve
                     ? path.join(__dirname, 'src/assets/icons/mac/touch-bar/')
                     : path.join(process.resourcesPath, 'assets/');

let touchBar,
    segmentedAnotherViewsControl,
    segmentedFolderControl,
    segmentedPopover,
    segmentedViewControl,
    zoomSegmented;

/**
 * Synchronize the optional macOS Touch Bar after the main process has already
 * verified that the update came from the active renderer. Keeping this as an
 * ordinary function prevents the Touch Bar from creating an unchecked second
 * IPC entry point.
 */
export function updateTouchBarFromApp(changesFromApp: unknown): void {
  if (!codeRunningOnMac || typeof changesFromApp !== 'string') {
    return;
  }

  if (AllSupportedViews.includes(<SupportedView>changesFromApp) && segmentedViewControl) {
    segmentedViewControl.selectedIndex = AllSupportedViews.indexOf(<SupportedView>changesFromApp);
  } else if (changesFromApp === 'showFreq' && segmentedFolderControl) {
    segmentedFolderControl.selectedIndex = 0;
  } else if (changesFromApp === 'showRecent' && segmentedFolderControl) {
    segmentedFolderControl.selectedIndex = 1;
  } else if (changesFromApp === 'compactView' && segmentedAnotherViewsControl) {
    segmentedAnotherViewsControl.selectedIndex = 0;
  } else if (changesFromApp === 'showMoreInfo' && segmentedAnotherViewsControl) {
    segmentedAnotherViewsControl.selectedIndex = 1;
  }
}

/**
 * Void function for creating touchBar for MAC OS X
 */
export function createTouchBar() {

  // recent and freq views
  segmentedFolderControl = new TouchBarSegmentedControl({
    mode: 'multiple',
    selectedIndex: -1,
    segments: [
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-cloud.png'))
                         .resize({ width: 22, height: 16 })},
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-recent-history.png'))
                         .resize({ width: 18, height: 18 }) }
    ],
    change: selectedIndex => {
      if (selectedIndex === 0) {
        GLOBALS.angularApp.sender.send('touchBar-to-app', 'showFreq');
      } else {
        GLOBALS.angularApp.sender.send('touchBar-to-app', 'showRecent');
      }
    }
  });

  // segmentedControl for views
  segmentedViewControl = new TouchBarSegmentedControl({
    segments: [
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-show-thumbnails.png'))
                         .resize({ width: 15, height: 15 })},
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-show-filmstrip.png'))
                         .resize({ width: 20, height: 15 })},
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-show-full-view.png'))
                         .resize({ width: 15, height: 15 })},
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-show-details.png'))
                         .resize({ width: 15, height: 15 })},
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-show-filenames.png'))
                         .resize({ width: 15, height: 15 })},
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-video-blank.png'))
                         .resize({ width: 15, height: 15 })},
    ],
    change: selectedIndex => {
      GLOBALS.angularApp.sender.send('touchBar-to-app', AllSupportedViews[selectedIndex]);
    }
  });

  // Popover button for segmentedControl
  segmentedPopover = new TouchBarPopover({
    label: 'Views',
    items: new TouchBar(
      {
        items: [segmentedViewControl]
      }
    )
  });

  // Segment with compat view and show more info
  segmentedAnotherViewsControl = new TouchBarSegmentedControl({
    mode: 'multiple',
    selectedIndex: -1,
    segments: [
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-compat-view.png'))
                         .resize({ width: 16, height: 16 })},
      { icon: nativeImage.createFromPath(path.join(resourcePath, 'icon-show-more-info.png'))
                         .resize({ width: 18, height: 20 })},
    ],
    change: selectedIndex => {
      if (selectedIndex === 0) {
        GLOBALS.angularApp.sender.send('touchBar-to-app', 'compactView');
      } else {
        GLOBALS.angularApp.sender.send('touchBar-to-app', 'showMoreInfo');
      }
    }
  });

  // touchBar segment with zoom options
  zoomSegmented = new TouchBarSegmentedControl({
    mode: 'buttons',
    segments: [
      {label: '-'},
      {label: '+'}
    ],
    change: selectedIndex => {
      if (selectedIndex === 0) {
        GLOBALS.angularApp.sender.send('touchBar-to-app', 'makeSmaller');
      } else {
        GLOBALS.angularApp.sender.send('touchBar-to-app', 'makeLarger');
      }
    }
  });

  // creating touchBar from existing items
  touchBar = new TouchBar({
    items: [
      segmentedFolderControl,
      segmentedPopover,
      segmentedAnotherViewsControl,
      zoomSegmented
    ]
  });

  return touchBar;
}
