import type { ScreenshotSettings, InputSources } from '../interfaces/final-object.interface';
import type { CatalogueAccessMode } from '../interfaces/catalogue-session';

export type { CatalogueAccessMode } from '../interfaces/catalogue-session';

// For release, update the version below and in package.json in tandem.

export const GLOBALS: VhaGlobals = {
  angularApp: null,            // reference used to send messages back to Angular App
  catalogueAccessMode: 'read-write',
  cataloguePersistenceActive: false,
  catalogueSessionGeneration: 0,
  catalogueTransitionActive: false,
  currentlyOpenVhaFile: '',    // OFFICAL DECREE IN NODE WHICH FILE IS CURRENTLY OPEN !!!
  debug: false,
  hubName: 'untitled',         // in case user doesn't name their hub any name
  macVersion: false,           // auto updated by `main.ts`
  authorizedCataloguePaths: new Set<string>(),
  authorizedCatalogueImageHashes: new Set<string>(),
  authorizedCatalogueMediaLocations: new Set<string>(),
  authorizedSourceFolderPaths: new Set<string>(),
  authorizedSourceFolderRealPaths: new Map<string, string>(),
  authorizedSourceWatchPaths: new Set<string>(),
  pendingInputDirectorySelections: new Set<string>(),
  pendingOutputDirectorySelections: new Set<string>(),
  pendingUserFileSelections: new Set<string>(),
  preferredVideoPlayer: '',
  preferredVideoPlayerArguments: '',
  readyToQuit: false,          // hack to quit gracefully
  requestCatalogueOpenDispatch: undefined,
  selectedOutputFolder: '',
  selectedSourceFolders: {},
  settingsPath: '',            // to differentiate between standard & Windows Portable settings location
  version: '1.1.1',            // see instructions above to update `package.json` in tandem               <---- !!! RELEASE !!!!
  vhaFileVersion: 3,
  winRef: null,
  screenshotSettings: {
    clipHeight: 144,           // default clip height
    clipSnippetLength: 1,      // the length of each snippet in the clip
    clipSnippets: 0,           // the number of video snippets in every clip; 0 == no clip extracted
    fixed: true,               // true => N screenshots per video; false => 1 screenshot every N minutes
    height: 288,
    n: 10,
  },
  additionalExtensions: [],
};

export interface VhaGlobals {
  additionalExtensions: string[];
  angularApp: any;
  authorizedCataloguePaths: Set<string>;
  authorizedCatalogueImageHashes: Set<string>;
  authorizedCatalogueMediaLocations: Set<string>;
  authorizedSourceFolderPaths: Set<string>;
  authorizedSourceFolderRealPaths: Map<string, string>;
  authorizedSourceWatchPaths: Set<string>;
  catalogueAccessMode: CatalogueAccessMode;
  cataloguePersistenceActive: boolean;
  catalogueSessionGeneration: number;
  catalogueTransitionActive: boolean;
  currentlyOpenVhaFile: string;
  debug: boolean;
  hubName: string;
  macVersion: boolean;
  pendingInputDirectorySelections: Set<string>;
  pendingOutputDirectorySelections: Set<string>;
  pendingUserFileSelections: Set<string>;
  preferredVideoPlayer: string;
  preferredVideoPlayerArguments: string;
  readyToQuit: boolean;
  requestCatalogueOpenDispatch?: () => void;
  screenshotSettings: ScreenshotSettings;
  selectedOutputFolder: string;
  selectedSourceFolders: InputSources;
  settingsPath: string;
  version: string;
  vhaFileVersion: number;
  winRef: any;
}
