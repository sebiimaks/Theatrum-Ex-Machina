import type { SettingsButtonKey, SettingsButtonsType } from './settings-buttons';

export type SettingsCategoryId = 'appearance' | 'gallery' | 'playback' | 'search' | 'sorting'
  | 'tags' | 'library' | 'import' | 'shortcuts' | 'maintenance' | 'about';

export type SettingsSectionKind = 'buttons' | 'player' | 'extensions' | 'zoom' | 'language' | 'about';

export interface SettingsWorkspaceSection {
  id: string;
  heading: string;
  buttonKeys: SettingsButtonKey[];
  kind?: SettingsSectionKind;
  searchLabels?: string[];
}

export interface SettingsWorkspaceCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  iconName: string;
  sections: SettingsWorkspaceSection[];
}

export interface SettingsWorkspaceResult extends SettingsWorkspaceSection {
  categoryId: SettingsCategoryId;
  categoryLabel: string;
}

// Every persisted setting belongs to one category. Library sources and keyboard
// shortcuts keep their existing dedicated components in the settings shell.
export const SettingsWorkspaceCategories: SettingsWorkspaceCategory[] = [
  {
    id: 'appearance', label: 'WORKBENCH.settingsAppearance', description: 'WORKBENCH.settingsAppearanceDescription', iconName: 'icon-darken',
    sections: [
      { id: 'interface', heading: 'WORKBENCH.settingsAppearance', buttonKeys: ['darkMode', 'flatIcons', 'fontSizeLarger', 'hideSidebar'] },
      { id: 'app-zoom', heading: 'SETTINGS.changeAppZoom', buttonKeys: [], kind: 'zoom', searchLabels: ['SETTINGS.resetZoom'] },
      { id: 'language', heading: 'SETTINGS.changeLanguage', buttonKeys: [], kind: 'language' },
    ],
  },
  {
    id: 'gallery', label: 'WORKBENCH.settingsGallery', description: 'WORKBENCH.settingsGalleryDescription', iconName: 'icon-show-thumbnails',
    sections: [
      { id: 'gallery-view', heading: 'SETTINGS.galleryAndView', buttonKeys: ['showThumbnails', 'showFilmstrip', 'showFullView', 'showDetails', 'showDetails2', 'showFiles', 'showClips'] },
      { id: 'gallery-layout', heading: 'SETTINGS.miscView', buttonKeys: ['compactView', 'showCleanNameInCompactView', 'showMoreInfo', 'favorites', 'makeSmaller', 'makeLarger'] },
      { id: 'gallery-browsing', heading: 'SETTINGS.folderView', buttonKeys: ['showFolders', 'randomizeFoldersScreenshots', 'showOnlyFavorites', 'showOnlyPlaylist', 'shuffleGalleryNow'] },
      { id: 'gallery-panels', heading: 'WORKBENCH.settingsPanels', buttonKeys: ['autoOpenDetails', 'showFreq', 'showRelatedVideosTray', 'showRecentlyPlayed', 'showDetailsTray'] },
      { id: 'gallery-thumbnails', heading: 'SETTINGS.thumbnailHeading', buttonKeys: ['hoverScrub', 'thumbAutoAdvance', 'returnToFirstScreenshot'] },
      { id: 'gallery-clips', heading: 'SETTINGS.clipsHeading', buttonKeys: ['muteClips', 'autoplayClips', 'clipsThumbnail'] },
    ],
  },
  {
    id: 'playback', label: 'WORKBENCH.settingsPlayback', description: 'WORKBENCH.settingsPlaybackDescription', iconName: 'icon-video-blank',
    sections: [
      { id: 'player', heading: 'BUTTONS.videoPlayerSettings', buttonKeys: [], kind: 'player', searchLabels: ['SETTINGS.preferredPlayer', 'SETTINGS.chooseVideoPlayer', 'SETTINGS.systemDefault'] },
      { id: 'playback-behavior', heading: 'WORKBENCH.settingsPlayback', buttonKeys: ['doubleClickMode', 'dragVideoOutOfApp', 'openAtTimestamp', 'spacePlaysRandom', 'playPlaylist'] },
    ],
  },
  {
    id: 'search', label: 'WORKBENCH.settingsSearch', description: 'WORKBENCH.settingsSearchDescription', iconName: 'icon-looking-glass',
    sections: [
      { id: 'search-behavior', heading: 'SETTINGS.searchAndFilter', buttonKeys: ['clearAllFilters', 'magic', 'regex', 'fuzzy', 'startsWith', 'hideOffline'] },
      { id: 'search-fields', heading: 'SETTINGS.searchFilters', buttonKeys: ['folderUnion', 'folderIntersection', 'folderExclusion', 'fileUnion', 'fileIntersection', 'exclude', 'tagUnion', 'tagIntersection', 'tagExclusion', 'videoNotes'] },
      { id: 'search-ranges', heading: 'SETTINGS.sortingFilters', buttonKeys: ['durationFilter', 'sizeFilter', 'timesPlayedFilter', 'yearFilter', 'resolutionFilter', 'starFilter'] },
      { id: 'search-duplicates', heading: 'SETTINGS.duplicateLength', buttonKeys: ['duplicateLength', 'duplicateSize', 'duplicateHash'] },
      { id: 'search-history', heading: 'BUTTONS.showRecentDescription', buttonKeys: ['showRecent'] },
    ],
  },
  {
    id: 'sorting', label: 'WORKBENCH.settingsSorting', description: 'WORKBENCH.settingsSortingDescription', iconName: 'icon-sort-order',
    sections: [
      { id: 'sort-control', heading: 'WORKBENCH.settingsSorting', buttonKeys: ['sortOrder'] },
      { id: 'sort-options', heading: 'WORKBENCH.settingsSortOptions', buttonKeys: ['sortOptionAlphabetical', 'sortOptionAlphabetical2', 'sortOptionTime', 'sortOptionSize', 'sortOptionTimesPlayed', 'sortOptionLastPlayed', 'sortOptionStar', 'sortOptionYear', 'sortOptionAdded', 'sortOptionModified', 'sortOptionCreated', 'sortOptionTags', 'sortOptionAspectRatio', 'sortOptionPlaylist', 'sortOptionFps', 'sortOptionFolderSize'] },
    ],
  },
  {
    id: 'tags', label: 'WORKBENCH.settingsTags', description: 'WORKBENCH.settingsTagsDescription', iconName: 'icon-tag-manual',
    sections: [
      { id: 'tags-and-notes', heading: 'SETTINGS.manualTags', buttonKeys: ['manualTags', 'autoFileTags', 'autoFolderTags', 'showVideoNotes', 'sortAutoTags'] },
      { id: 'tag-panels', heading: 'WORKBENCH.settingsPanels', buttonKeys: ['showTags', 'showTagTray'] },
    ],
  },
  { id: 'library', label: 'WORKBENCH.settingsLibrary', description: 'WORKBENCH.settingsLibraryDescription', iconName: 'icon-folder-blank', sections: [] },
  {
    id: 'import', label: 'WORKBENCH.settingsImport', description: 'WORKBENCH.settingsImportDescription', iconName: 'icon-plus',
    sections: [
      { id: 'new-catalogue', heading: 'WORKBENCH.settingsImport', buttonKeys: ['startWizard'] },
      { id: 'extensions', heading: 'SETTINGS.additionalExtensions', buttonKeys: [], kind: 'extensions', searchLabels: ['SETTINGS.extensions', 'SETTINGS.editExtensionsInput'] },
    ],
  },
  { id: 'shortcuts', label: 'WORKBENCH.settingsShortcuts', description: 'WORKBENCH.settingsShortcutsDescription', iconName: 'icon-clipboard', sections: [] },
  {
    id: 'maintenance', label: 'WORKBENCH.settingsMaintenance', description: 'WORKBENCH.settingsMaintenanceDescription', iconName: 'icon-gear',
    sections: [
      { id: 'maintenance', heading: 'SETTINGS.variousSettings', buttonKeys: ['resetSettings', 'resetTimesPlayed', 'clearHistory'] },
      { id: 'file-deletion', heading: 'WORKBENCH.settingsDeletion', buttonKeys: ['showDeleteOption', 'dangerousDelete'] },
    ],
  },
  {
    id: 'about', label: 'WORKBENCH.settingsAbout', description: 'WORKBENCH.settingsAboutDescription', iconName: 'icon-show-more-info',
    sections: [{ id: 'about', heading: 'WORKBENCH.settingsAbout', buttonKeys: [], kind: 'about', searchLabels: ['WORKBENCH.settingsCredits'] }],
  },
];

export const SettingsActionKeys: readonly SettingsButtonKey[] = [
  'clearAllFilters', 'clearHistory', 'makeSmaller', 'makeLarger', 'playPlaylist',
  'resetSettings', 'resetTimesPlayed', 'shuffleGalleryNow', 'startWizard', 'showTags',
];

export const SettingsViewKeys: readonly SettingsButtonKey[] = [
  'showThumbnails', 'showFilmstrip', 'showFullView', 'showDetails', 'showDetails2', 'showFiles', 'showClips',
];

export const SettingsDestructiveKeys: readonly SettingsButtonKey[] = [
  'clearHistory', 'resetSettings', 'resetTimesPlayed', 'dangerousDelete',
];

function normalizeSearchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}

/** Search localized labels and help text, including custom controls, without
 * changing settings or conflating a setting's value with toolbar visibility. */
export function getSettingsWorkspaceSections(
  categoryId: SettingsCategoryId,
  query: string,
  settingsButtons: SettingsButtonsType,
  translate: (key: string) => string,
): SettingsWorkspaceResult[] {
  const words = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
  // Some existing sorting controls deliberately have an empty tooltip title.
  // TranslateService.instant rejects empty keys, so omit absent metadata.
  const translateLabel = (key: string | undefined): string => key ? translate(key) : '';
  const matches = (labels: string[]) => {
    const text = normalizeSearchText(labels.join(' '));
    return words.every((word) => text.includes(word));
  };

  return SettingsWorkspaceCategories.flatMap((category) => {
    if (!words.length && category.id !== categoryId) {
      return [];
    }
    return category.sections.flatMap((section) => {
      const commonLabels = [translateLabel(category.label), translateLabel(section.heading)];
      const buttonKeys = words.length ? section.buttonKeys.filter((key) => {
        const button = settingsButtons[key];
        return matches([
          ...commonLabels, key.replace(/([a-z])([A-Z])/g, '$1 $2'),
          translateLabel(button.description), translateLabel(button.title),
          translateLabel(button.moreInfo),
        ]);
      }) : section.buttonKeys;

      const customMatches = section.kind && section.kind !== 'buttons'
        && matches([...commonLabels, ...(section.searchLabels || []).map(translateLabel)]);
      if (!buttonKeys.length && !customMatches) {
        return [];
      }
      return [{ ...section, buttonKeys, categoryId: category.id, categoryLabel: category.label }];
    });
  });
}
