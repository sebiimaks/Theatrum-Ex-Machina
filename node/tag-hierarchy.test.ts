import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { test } from 'node:test';
import { join } from 'path';

import {
  TAG_PATH_MAX_DEPTH,
  TAG_PATH_MAX_LENGTH,
  TAG_PATH_MAX_SEGMENT_LENGTH,
  TAG_PATH_SEPARATOR,
  addTagToSelectedEntries,
  buildTagHierarchy,
  filterTagHierarchy,
  getExactTagColor,
  getTagAncestorPaths,
  getUniqueVideoTagSegments,
  isTagInBranch,
  matchesManualTagQuery,
  normalizeNewTagPath,
  normalizeTagInputPreservingExisting,
  parseStoredTagPath,
  planExactTagDefinitionRemoval,
  planTagBranchColourMove,
  planTagDefinitionBranchMove,
  planTagDefinitionBranchRemoval,
  planTagBranchMove,
  planTagBranchRemoval,
  planVideoTagBranchRemoval,
  remapTagBranchPath,
  resolveTagBranchMoveDestination,
  sortTagHierarchy,
  tagIdentityKey,
  tagPathsEqual,
  tagRemovalRequiresConfirmation,
  validateAndNormalizeNewTagPath,
} from '../interfaces/tag-hierarchy.ts';
import type { TagHierarchyNode, TagHierarchySource } from '../interfaces/tag-hierarchy.ts';

function findNode(nodes: readonly TagHierarchyNode[], fullPath: string): TagHierarchyNode {
  for (const node of nodes) {
    if (node.fullPath === fullPath) {
      return node;
    }
    const child = findNode(node.children, fullPath);
    if (child) {
      return child;
    }
  }
  return undefined;
}

test('normalizes newly entered hierarchy paths to the canonical stored delimiter', () => {
  assert.equal(TAG_PATH_SEPARATOR, ' > ');
  assert.equal(normalizeNewTagPath('  People> Family  >Children '), 'People > Family > Children');
  assert.equal(normalizeNewTagPath('Portrait'), 'Portrait');
  assert.deepEqual(validateAndNormalizeNewTagPath('Places > Europe'), {
    normalized: 'Places > Europe',
    valid: true,
  });
});

test('rejects unsafe or structurally invalid newly entered tag paths', () => {
  const invalidInputs = [
    '',
    'Parent > > Child',
    '> Child',
    'Parent >',
    'one, two',
    'line\nbreak',
    `control${String.fromCharCode(0)}value`,
    Array.from({ length: TAG_PATH_MAX_DEPTH + 1 }, (_, index) => `Level ${index}`).join('>'),
    'x'.repeat(TAG_PATH_MAX_SEGMENT_LENGTH + 1),
    Array.from({ length: 5 }, () => 'x'.repeat(101)).join('>'),
  ];

  invalidInputs.forEach((input: string) => {
    const result = validateAndNormalizeNewTagPath(input);
    assert.equal(result.valid, false, `'${input}' should be invalid`);
    assert.ok(result.error);
    assert.throws(() => normalizeNewTagPath(input));
  });

  assert.ok(Array.from({ length: 5 }, () => 'x'.repeat(101)).join(TAG_PATH_SEPARATOR).length > TAG_PATH_MAX_LENGTH);
});

test('parses only exact canonical stored paths and keeps legacy values safely flat', () => {
  assert.deepEqual(parseStoredTagPath('Parent > Child'), {
    fullPath: 'Parent > Child',
    hierarchical: true,
    segments: ['Parent', 'Child'],
  });

  [
    'Parent>Child',
    'Parent  > Child',
    'Parent >  Child',
    'Parent > > Child',
    'Parent > Child, Other',
    'Parent > Child\nLeaf',
  ].forEach((storedTag: string) => {
    const parsed = parseStoredTagPath(storedTag);
    assert.equal(parsed.hierarchical, false);
    assert.deepEqual(parsed.segments, [storedTag]);
    assert.equal(parsed.fullPath, storedTag);
  });
});

test('provides case-insensitive identity without rewriting stored display values', () => {
  const stored = 'ART > Painting';
  assert.equal(tagIdentityKey(stored), 'art > painting');
  assert.equal(tagPathsEqual(stored, 'art > PAINTING'), true);
  assert.equal(parseStoredTagPath(stored).fullPath, stored);
  assert.equal(tagPathsEqual('Art>Painting', 'Art > Painting'), false);
});

test('preserves unchanged legacy spellings while canonicalizing genuinely new paths', () => {
  const existing = ['Art', 'art', 'People>Family', 'Topics > Art'];

  assert.equal(normalizeTagInputPreservingExisting('art', existing), 'art');

  assert.equal(
    normalizeTagInputPreservingExisting('People>Family', existing),
    'People>Family',
  );
  assert.equal(
    normalizeTagInputPreservingExisting('people>family', existing),
    'People>Family',
  );
  assert.equal(
    normalizeTagInputPreservingExisting('topics>art', existing),
    'Topics > Art',
  );
  assert.equal(
    normalizeTagInputPreservingExisting('People > Friends', existing),
    'People > Friends',
  );
});

test('adds a deep hierarchy tag to every selected entry in one observable batch', () => {
  const tagPath = 'Camera > Rangefinder > Canon > Canon P';
  const entries = Array.from({ length: 9 }, (_, index: number) => ({
    selected: true,
    tags: index === 0 ? [tagPath] : ['Existing'],
  }));
  entries.push({ selected: false, tags: ['Existing'] });

  assert.equal(addTagToSelectedEntries(entries, tagPath), 8);
  assert.equal(entries.slice(0, 9).every((entry) => (
    entry.tags.some((tag: string) => tagPathsEqual(tag, tagPath))
  )), true);
  assert.deepEqual(entries[9].tags, ['Existing']);
  assert.equal(addTagToSelectedEntries(entries, tagPath), 0);
});

test('derives ancestors and matches branches only on hierarchy segment boundaries', () => {
  assert.deepEqual(getTagAncestorPaths('Topics > Art > Painting'), [
    'Topics',
    'Topics > Art',
  ]);
  assert.deepEqual(getTagAncestorPaths('Topics > Art > Painting', true), [
    'Topics',
    'Topics > Art',
    'Topics > Art > Painting',
  ]);
  assert.deepEqual(getTagAncestorPaths('Flat Tag'), []);
  assert.deepEqual(getTagAncestorPaths('Flat Tag', true), ['Flat Tag']);

  assert.equal(isTagInBranch('Art', 'art'), true);
  assert.equal(isTagInBranch('Art > Painting', 'ART'), true);
  assert.equal(isTagInBranch('Art > Painting > Oil', 'Art > Painting'), true);
  assert.equal(isTagInBranch('Artist', 'Art'), false);
  assert.equal(isTagInBranch('Artwork > Painting', 'Art'), false);
  assert.equal(isTagInBranch('Art>Painting', 'Art'), false);
});

test('distinguishes branch filters from ordinary per-tag text searches', () => {
  const tags = ['Topics > Art > Painting', 'Camera Gear'];

  assert.equal(matchesManualTagQuery(tags, 'Topics > Art', true), true);
  assert.equal(matchesManualTagQuery(tags, 'Topics > Science', true), false);
  assert.equal(matchesManualTagQuery(['Artist'], 'Art', true), false);
  assert.equal(matchesManualTagQuery(tags, 'paint', false), true);
  assert.equal(matchesManualTagQuery(['Alpha', 'Beta'], 'a b', false), false);
  assert.equal(matchesManualTagQuery(['Art', 'Artist'], 'Art', false, true), true);
  assert.equal(matchesManualTagQuery(['Artist'], 'Art', false, true), false);
  assert.equal(matchesManualTagQuery(['Art > Painting'], 'Art', false, true), false);
  assert.doesNotThrow(() => matchesManualTagQuery(['Art', 42 as unknown as string], 'art', false));
});

test('builds a derived tree with implicit ancestors and unique-video frequencies', () => {
  const sources: TagHierarchySource[] = [
    { tags: ['Art > Painting', 'art > painting', 'Art > Sculpture'] },
    { tags: ['art > PAINTING', 'Art'] },
    { tags: ['Art > Painting > Oil', 'Artist'] },
    {},
  ];
  const original = JSON.stringify(sources);
  const tree = buildTagHierarchy(sources);

  assert.equal(JSON.stringify(sources), original, 'building the hierarchy mutated source tags');
  assert.deepEqual(tree.map((node: TagHierarchyNode) => node.label), ['Art', 'Artist']);

  const art = findNode(tree, 'Art');
  const painting = findNode(tree, 'Art > Painting');
  const oil = findNode(tree, 'Art > Painting > Oil');
  const sculpture = findNode(tree, 'Art > Sculpture');
  const artist = findNode(tree, 'Artist');

  assert.ok(art && painting && oil && sculpture && artist);
  assert.equal(art.explicit, true);
  assert.equal(art.directFrequency, 1);
  assert.equal(art.branchFrequency, 3, 'one video with multiple child tags was counted more than once');
  assert.equal(painting.directFrequency, 2, 'case variants on one video were counted more than once');
  assert.equal(painting.branchFrequency, 3);
  assert.deepEqual(painting.explicitTagValues, [
    'Art > Painting',
    'art > painting',
    'art > PAINTING',
  ]);
  assert.equal(oil.directFrequency, 1);
  assert.equal(oil.branchFrequency, 1);
  assert.equal(sculpture.directFrequency, 1);
  assert.equal(artist.branchFrequency, 1);
});

test('sorts cloned sibling trees without mutating the input hierarchy', () => {
  const tree = buildTagHierarchy([
    { tags: ['Alpha', 'Zed > Second', 'Zed > First'] },
    { tags: ['Zed > Second'] },
  ]);
  const snapshot = JSON.stringify(tree);
  const frequencySorted = sortTagHierarchy(tree, 'frequency');

  assert.deepEqual(frequencySorted.map((node: TagHierarchyNode) => node.label), ['Zed', 'Alpha']);
  assert.deepEqual(frequencySorted[0].children.map((node: TagHierarchyNode) => node.label), ['Second', 'First']);
  assert.equal(JSON.stringify(tree), snapshot);
  assert.notEqual(frequencySorted, tree);
  assert.notEqual(frequencySorted[0].children, tree[1].children);
});

test('filters cloned hierarchies while retaining ancestors and useful parent subtrees', () => {
  const tree = buildTagHierarchy([
    { tags: ['Topics > Art > Painting', 'Topics > Science', 'Artist'] },
  ]);
  const snapshot = JSON.stringify(tree);
  const leafResult = filterTagHierarchy(tree, 'painting');
  const parentResult = filterTagHierarchy(tree, 'topics');

  assert.deepEqual(leafResult.map((node: TagHierarchyNode) => node.fullPath), ['Topics']);
  assert.deepEqual(leafResult[0].children.map((node: TagHierarchyNode) => node.fullPath), ['Topics > Art']);
  assert.deepEqual(
    leafResult[0].children[0].children.map((node: TagHierarchyNode) => node.fullPath),
    ['Topics > Art > Painting'],
  );
  assert.deepEqual(parentResult[0].children.map((node: TagHierarchyNode) => node.label), ['Art', 'Science']);
  assert.deepEqual(filterTagHierarchy(tree, 'does not exist'), []);
  assert.equal(JSON.stringify(tree), snapshot);
  assert.notEqual(parentResult[0], tree.find((node: TagHierarchyNode) => node.fullPath === 'Topics'));
});

test('plans branch removal without touching similarly prefixed or noncanonical flat tags', () => {
  const sources: TagHierarchySource[] = [
    { tags: ['Art', 'Art > Painting', 'Artist'] },
    { tags: ['art > Sculpture', 'Other'] },
    { tags: ['Art > Painting > Oil', 'Art>Legacy'] },
    { tags: ['Artist > Portrait'] },
  ];
  const snapshot = JSON.stringify(sources);
  const plan = planTagBranchRemoval(sources, 'ART');

  assert.equal(plan.branchPath, 'ART');
  assert.equal(plan.affectedEntryCount, 3);
  assert.deepEqual(plan.affectedTagValues, [
    'Art',
    'Art > Painting',
    'art > Sculpture',
    'Art > Painting > Oil',
  ]);
  assert.deepEqual(plan.entries, [
    { index: 0, remainingTags: ['Artist'], removedTags: ['Art', 'Art > Painting'] },
    { index: 1, remainingTags: ['Other'], removedTags: ['art > Sculpture'] },
    { index: 2, remainingTags: ['Art>Legacy'], removedTags: ['Art > Painting > Oil'] },
  ]);
  assert.equal(JSON.stringify(sources), snapshot);
  assert.deepEqual(planTagBranchRemoval(sources, '').entries, []);
});

test('moves a tag branch beneath another tag and consolidates destination collisions', () => {
  const sources: TagHierarchySource[] = [
    { tags: ['Alice', 'People > Alice', 'Other'] },
    { tags: ['Alice', 'Archive > Existing'] },
    { tags: ['Unrelated'] },
  ];
  const snapshot = JSON.stringify(sources);
  const plan = planTagBranchMove(sources, 'Alice', 'People');

  assert.equal(plan.destinationPath, 'People > Alice');
  assert.equal(plan.affectedEntryCount, 2);
  assert.equal(plan.affectedTagPathCount, 1);
  assert.deepEqual(plan.entries, [
    {
      addedTags: [],
      index: 0,
      originalTags: ['Alice', 'People > Alice', 'Other'],
      removedTags: ['Alice'],
      updatedTags: ['People > Alice', 'Other'],
    },
    {
      addedTags: ['People > Alice'],
      index: 1,
      originalTags: ['Alice', 'Archive > Existing'],
      removedTags: ['Alice'],
      updatedTags: ['Archive > Existing', 'People > Alice'],
    },
  ]);
  assert.equal(plan.affectedAssignmentCount, 2);
  assert.equal(plan.deduplicatedAssignmentCount, 1);
  assert.equal(JSON.stringify(sources), snapshot);
});

test('moves a nested branch and all descendants back to the root', () => {
  const sources: TagHierarchySource[] = [
    { tags: ['People > Family', 'People > Family > Alice', 'People > Friends'] },
    { tags: ['people > family > Bob'] },
  ];
  const plan = planTagBranchMove(sources, 'People > Family', null);

  assert.equal(resolveTagBranchMoveDestination('People > Family', null), 'Family');
  assert.equal(remapTagBranchPath(
    'People > Family > Alice',
    'People > Family',
    'Family',
  ), 'Family > Alice');
  assert.equal(plan.destinationPath, 'Family');
  assert.equal(plan.affectedEntryCount, 2);
  assert.equal(plan.affectedTagPathCount, 3);
  assert.deepEqual(plan.entries[0].updatedTags, [
    'People > Friends',
    'Family',
    'Family > Alice',
  ]);
  assert.deepEqual(plan.entries[1].updatedTags, ['Family > Bob']);
});

test('rejects cycles and ambiguous legacy hierarchy moves without mutating entries', () => {
  const sources: TagHierarchySource[] = [{ tags: ['People > Family > Alice', 'People>Legacy'] }];
  const snapshot = JSON.stringify(sources);

  assert.throws(
    () => planTagBranchMove(sources, 'People', 'People > Family'),
    /cannot be moved into itself or one of its descendants/,
  );
  assert.throws(
    () => planTagBranchMove(sources, 'People>Legacy', 'People'),
    /legacy non-hierarchical/,
  );
  assert.throws(
    () => planTagBranchMove(sources, 'People', 'People>Legacy'),
    /legacy non-hierarchical/,
  );
  assert.equal(JSON.stringify(sources), snapshot);
});

test('returns an empty plan when a branch is dropped at its current location', () => {
  const plan = planTagBranchMove(
    [{ tags: ['People > Family', 'People > Family > Alice'] }],
    'People > Family',
    'People',
  );

  assert.equal(plan.destinationPath, 'People > Family');
  assert.equal(plan.affectedEntryCount, 0);
  assert.equal(plan.affectedTagPathCount, 0);
  assert.deepEqual(plan.entries, []);
});

test('moves explicit branch colours while retaining destination colours on conflicts', () => {
  const originalColours = {
    Alice: '#111111',
    'Alice > Portraits': '#222222',
    'People > Alice': '#333333',
    Unrelated: '#444444',
  };
  const snapshot = JSON.stringify(originalColours);
  const colourPlan = planTagBranchColourMove(
    originalColours,
    'Alice',
    'People > Alice',
  );

  assert.deepEqual(colourPlan, {
    affectedColourPathCount: 2,
    conflictCount: 1,
    nextColours: {
      'People > Alice': '#333333',
      Unrelated: '#444444',
      'People > Alice > Portraits': '#222222',
    },
  });
  assert.equal(JSON.stringify(originalColours), snapshot);
});

test('rejects a move when a descendant would exceed hierarchy limits', () => {
  const sourcePath = 'Source';
  const deepestPath = [sourcePath]
    .concat(Array.from(
      { length: TAG_PATH_MAX_DEPTH - 1 },
      (_, index: number) => `Level ${index}`,
    ))
    .join(TAG_PATH_SEPARATOR);
  const sources = [{ tags: [deepestPath] }];

  assert.throws(
    () => planTagBranchMove(sources, sourcePath, 'Destination'),
    /deeper than/,
  );
});

test('projects one video hierarchy into unique individual segment pills without mutation', () => {
  const tags = [
    'camera > rangefinder',
    'camera > rangefinder > canon',
    'camera > rangefinder > canon > canon vl2',
    'camera > rangefinder > nikon > nikon sp',
    'People>Legacy',
  ];
  const snapshot = JSON.stringify(tags);
  const segments = getUniqueVideoTagSegments(tags);

  assert.deepEqual(segments.map((segment) => segment.label), [
    'camera',
    'rangefinder',
    'canon',
    'canon vl2',
    'nikon',
    'nikon sp',
    'People>Legacy',
  ]);
  assert.equal(segments.find((segment) => segment.label === 'rangefinder')?.colourPath, 'camera > rangefinder');
  assert.deepEqual(
    segments.find((segment) => segment.label === 'rangefinder')?.sourceTagPaths,
    tags.slice(0, 4),
  );
  assert.equal(JSON.stringify(tags), snapshot);
});

test('keeps same-named video tag segments scoped to their distinct hierarchy branches', () => {
  const segments = getUniqueVideoTagSegments([
    'People > Portrait > Alice',
    'Genres > Portrait > Studio',
  ]);
  const portraits = segments.filter((segment) => segment.label === 'Portrait');

  assert.equal(portraits.length, 2);
  assert.deepEqual(portraits.map((segment) => segment.colourPath), [
    'People > Portrait',
    'Genres > Portrait',
  ]);
  assert.notEqual(portraits[0].identity, portraits[1].identity);
});

test('removes one displayed video tag branch and all attached descendants', () => {
  const tags = [
    'camera > rangefinder',
    'camera > rangefinder > canon',
    'camera > rangefinder > canon > canon vl2',
    'camera > rangefinder > nikon > nikon sp',
  ];
  const snapshot = JSON.stringify(tags);
  const plan = planVideoTagBranchRemoval(tags, 'camera > rangefinder > CANON');

  assert.deepEqual(plan.branchPaths, ['camera > rangefinder > CANON']);
  assert.deepEqual(plan.removedTags, [
    'camera > rangefinder > canon',
    'camera > rangefinder > canon > canon vl2',
  ]);
  assert.deepEqual(plan.remainingTags, [
    'camera > rangefinder',
    'camera > rangefinder > nikon > nikon sp',
  ]);
  assert.equal(JSON.stringify(tags), snapshot);
});

test('removes a standalone video tag immediately without treating legacy text as hierarchy', () => {
  const tags = ['contax IIa', 'A>B>C', 'Other'];
  const snapshot = JSON.stringify(tags);
  const plan = planVideoTagBranchRemoval(tags, 'CONTAX IIA');

  assert.deepEqual(plan.branchPaths, ['CONTAX IIA']);
  assert.deepEqual(plan.removedTags, ['contax IIa']);
  assert.deepEqual(plan.remainingTags, ['A>B>C', 'Other']);
  assert.equal(JSON.stringify(tags), snapshot);
});

test('removes only the selected same-named branch while preserving unrelated metadata exactly', () => {
  const tags = [
    'People > Portrait',
    'People > Portrait > Alice',
    'Genres > Portrait > Studio',
    'Other',
    'other',
  ];
  const snapshot = JSON.stringify(tags);
  const plan = planVideoTagBranchRemoval(tags, 'People > Portrait');

  assert.deepEqual(plan.branchPaths, ['People > Portrait']);
  assert.deepEqual(plan.removedTags, tags.slice(0, 2));
  assert.deepEqual(plan.remainingTags, ['Genres > Portrait > Studio', 'Other', 'other']);
  assert.deepEqual(planVideoTagBranchRemoval(tags, 'missing').remainingTags, tags);
  assert.equal(JSON.stringify(tags), snapshot);
});

test('keeps flat and nested same-named video tags isolated during removal', () => {
  const tags = [
    'Portrait',
    'People > Portrait',
    'People > Portrait > Alice',
    'Other',
  ];

  const flatPlan = planVideoTagBranchRemoval(tags, 'portrait');
  assert.deepEqual(flatPlan.removedTags, ['Portrait']);
  assert.deepEqual(flatPlan.remainingTags, tags.slice(1));

  const nestedPlan = planVideoTagBranchRemoval(tags, 'PEOPLE > PORTRAIT');
  assert.deepEqual(nestedPlan.removedTags, [
    'People > Portrait',
    'People > Portrait > Alice',
  ]);
  assert.deepEqual(nestedPlan.remainingTags, ['Portrait', 'Other']);
});

test('scopes individual segment display and automatic-match markers to the video sheet', () => {
  const sheetTemplate = readFileSync(
    join(__dirname, '../src/app/components/sheet/sheet.component.html'),
    'utf8',
  );
  const metaTemplate = readFileSync(
    join(__dirname, '../src/app/components/meta/meta.component.html'),
    'utf8',
  );
  const metaComponent = readFileSync(
    join(__dirname, '../src/app/components/meta/meta.component.ts'),
    'utf8',
  );
  const tagTemplate = readFileSync(
    join(__dirname, '../src/app/components/tags-manual/view-tags.component.html'),
    'utf8',
  );
  const tagPipe = readFileSync(
    join(__dirname, '../src/app/components/tags-auto/tag-display.pipe.ts'),
    'utf8',
  );

  assert.match(sheetTemplate, /\[individualTagSegments\]="true"/);
  assert.match(metaTemplate, /tagDisplayPipe[\s\S]*individualTagSegments\(\)/);
  assert.match(metaTemplate, /removeDisplayedTag\(\$event\)/);
  assert.match(metaComponent, /planVideoTagBranchRemoval/);
  assert.match(metaComponent, /applyVideoTagBranchRemovalPlan/);
  assert.doesNotMatch(metaComponent, /openConfirmationDialog/);
  assert.match(tagTemplate, /tag\.displayName \|\| tag\.name/);
  assert.match(tagTemplate, /removeTag\(tag\.colourPath \|\| tag\.name\)/);
  assert.match(tagTemplate, /tag-auto-file-match/);
  assert.match(tagTemplate, /tag-auto-folder-match/);
  assert.match(tagPipe, /individualTagSegments[\s\S]*matchingManualTag\.autoFileMatch = true/);
  assert.match(tagPipe, /individualTagSegments[\s\S]*matchingManualTag\.autoFolderMatch = true/);
});

test('uses pointer-driven hierarchy dragging without covering tag rows', () => {
  const template = readFileSync(
    join(__dirname, '../src/app/components/tag-tray/tag-tray.component.html'),
    'utf8',
  );
  const styles = readFileSync(
    join(__dirname, '../src/app/components/tag-tray/tag-tray.component.scss'),
    'utf8',
  );
  const component = readFileSync(
    join(__dirname, '../src/app/components/tag-tray/tag-tray.component.ts'),
    'utf8',
  );
  const homeComponent = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );

  assert.match(template, /class="tag-root-drop-zone"/);
  assert.match(template, /tag-root-drop-zone-visible/);
  assert.doesNotMatch(template, /@if \(draggedTagPath\)[\s\S]*tag-root-drop-zone/);
  assert.match(template, /class="tag-drag-handle"[\s\S]*\(pointerdown\)="beginTagPointerDrag/);
  const handleStart = template.indexOf('class="tag-drag-handle"');
  const handleEnd = template.indexOf('</span>', handleStart);
  const handleMarkup = template.slice(handleStart, handleEnd);
  assert.doesNotMatch(handleMarkup, /\[draggable\]="true"/);
  assert.match(template, /class="tag-tree-row"[\s\S]*\[attr\.data-tag-path\]="node\.fullPath"/);
  assert.ok(
    template.indexOf('class="tag-root-drop-zone"')
      < template.indexOf('class="tag-tree-scroll-region"'),
  );
  assert.match(styles, /\.tag-root-drop-zone\s*\{[\s\S]*position: absolute;/);
  assert.match(styles, /\.tag-root-drop-zone-visible\s*\{[\s\S]*pointer-events: auto;/);
  assert.match(styles, /\.tag-pointer-drag-preview\s*\{[\s\S]*pointer-events: none;/);
  assert.match(
    styles,
    /grid-template-columns: repeat\(auto-fill, minmax\(min\(220px, 100%\), 1fr\)\);/,
  );
  assert.match(template, /class="tag-node-branch-glyph"/);
  assert.doesNotMatch(template, /TAGS\.(tagActionShort|branchActionShort)/);
  assert.match(
    template,
    /\[draggable\]="!batchTaggingMode\(\) && !verticalLayout\(\)"/,
  );
  assert.match(
    template,
    /\(pointerdown\)="verticalLayout\(\) \? beginTagPointerDrag\(\$event, node\) : null"/,
  );
  assert.match(
    homeComponent,
    /addTagToSelectedEntries[\s\S]*rebuildFromImages\(this\.imageElementService\.imageElements\)/,
  );
  assert.match(component, /event\.dataTransfer\.effectAllowed = 'copyMove';/);
  assert.match(component, /@HostListener\('document:pointermove'/);
  assert.match(component, /@HostListener\('document:pointerup'/);
  assert.match(component, /@HostListener\('window:blur'/);
  assert.match(component, /suppressNextTagClick/);
  assert.match(
    component,
    /finishTagPointerDrag[\s\S]*updatePointerDropTarget\(event\.clientX, event\.clientY\)/,
  );
  assert.match(component, /document\.elementFromPoint\(clientX, clientY\)/);
  assert.doesNotMatch(component, /hierarchyMoveEnabled = !this\.batchTaggingMode\(\)/);
});

test('renders the hierarchy as an independent vertical right-side panel', () => {
  const homeTemplate = readFileSync(
    join(__dirname, '../src/app/components/home.component.html'),
    'utf8',
  );
  const homeComponent = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );
  const layoutStyles = readFileSync(
    join(__dirname, '../src/app/components/layout.scss'),
    'utf8',
  );
  const tagStyles = readFileSync(
    join(__dirname, '../src/app/components/tag-tray/tag-tray.component.scss'),
    'utf8',
  );
  const sharedInterfaces = readFileSync(
    join(__dirname, '../interfaces/shared-interfaces.ts'),
    'utf8',
  );

  const panelStart = homeTemplate.indexOf('class="right-tag-panel"');
  const bottomTrayStart = homeTemplate.indexOf('class="bottom-tray"');
  const bottomTabsStart = homeTemplate.indexOf('class="all-settings-tabs bottom-tray-tabs"');
  const floatingButtonStart = homeTemplate.indexOf('class="catalogueEditorButton tag-panel-button"');
  const panelGuardStart = homeTemplate.lastIndexOf('@if (', panelStart);
  const floatingButtonGuardStart = homeTemplate.lastIndexOf('@if (', floatingButtonStart);
  const windowContentEnd = homeTemplate.indexOf('end of window-content');
  assert.ok(panelStart > -1);
  assert.ok(panelStart < bottomTrayStart);
  assert.match(
    homeTemplate.slice(panelStart, bottomTrayStart),
    /<app-tag-tray[\s\S]*\[verticalLayout\]="true"/,
  );
  assert.doesNotMatch(homeTemplate.slice(bottomTrayStart), /<app-tag-tray/);
  assert.ok(floatingButtonStart > panelStart);
  assert.ok(floatingButtonStart > windowContentEnd);
  assert.match(
    homeTemplate.slice(panelGuardStart, panelStart),
    /!wizard\.showWizard/,
  );
  assert.match(
    homeTemplate.slice(floatingButtonGuardStart, floatingButtonStart),
    /!wizard\.showWizard/,
  );
  assert.doesNotMatch(
    homeTemplate.slice(bottomTabsStart),
    /toggleButton\('showTagTray'\)/,
  );
  assert.match(
    homeTemplate.slice(panelStart, bottomTabsStart),
    /!settingsButtons\['showTagTray'\]\.toggled[\s\S]*toggleButton\('showTagTray'\)/,
  );
  assert.match(homeComponent, /uniqueKey === 'showTagTray'[\s\S]*scheduleGalleryLayoutRefresh/);
  assert.match(layoutStyles, /--app-tag-panel-width: #\{variables\.\$sidebar-width\};/);
  assert.match(
    homeTemplate.slice(floatingButtonStart),
    /<app-icon[^>]*\[icon\]="'icon-tag'"[\s\S]*SETTINGS\.trayTags/,
  );
  assert.match(layoutStyles, /\.catalogueEditorButton\.tag-panel-button\s*\{[\s\S]*bottom: 12px;[\s\S]*color: var\(--app-accent-text\);[\s\S]*font-weight: 700;[\s\S]*right: 12px;[\s\S]*width: 72px;/);
  assert.match(layoutStyles, /\.gallery-container-tag-panel-open\s*\{/);
  assert.match(layoutStyles, /\.right-tag-panel\s*\{[\s\S]*position: absolute;/);
  assert.match(tagStyles, /\.manual-tag-tray-vertical\s*\{[\s\S]*flex-direction: column;/);
  assert.match(tagStyles, /\.manual-tag-tray-vertical[\s\S]*\.tag-tree-root\s*\{[\s\S]*display: block;/);

  const bottomTrayViews = sharedInterfaces.slice(
    sharedInterfaces.indexOf('export const AllSupportedBottomTrayViews'),
    sharedInterfaces.indexOf('// Mouse click events'),
  );
  assert.doesNotMatch(bottomTrayViews, /showTagTray/);
});

test('keeps zero-frequency catalogue tag definitions visible and separate from assignments', () => {
  const sources: TagHierarchySource[] = [{ tags: ['Camera > Canon'] }];
  const hierarchy = buildTagHierarchy(sources, [
    'Camera',
    'Camera > Nikon',
    'Unassigned',
  ]);

  const camera = findNode(hierarchy, 'Camera');
  const canon = findNode(hierarchy, 'Camera > Canon');
  const nikon = findNode(hierarchy, 'Camera > Nikon');
  const unassigned = findNode(hierarchy, 'Unassigned');

  assert.equal(camera.explicit, true);
  assert.equal(camera.directFrequency, 0);
  assert.equal(camera.branchFrequency, 1);
  assert.equal(canon.directFrequency, 1);
  assert.equal(nikon.explicit, true);
  assert.equal(nikon.directFrequency, 0);
  assert.equal(nikon.branchFrequency, 0);
  assert.equal(unassigned.explicit, true);
  assert.equal(unassigned.directFrequency, 0);
});

test('moves persistent tag definitions without requiring a video assignment', () => {
  const definitions = [
    'Camera',
    'Camera > Canon',
    'Camera > Canon > Rangefinder',
    'Archive > Canon',
  ];
  const original = definitions.slice();
  const plan = planTagDefinitionBranchMove(definitions, 'Camera > Canon', 'Archive');

  assert.deepEqual(definitions, original);
  assert.equal(plan.affectedDefinitionCount, 2);
  assert.equal(plan.deduplicatedDefinitionCount, 1);
  assert.deepEqual(plan.nextDefinitions, [
    'Camera',
    'Archive > Canon',
    'Archive > Canon > Rangefinder',
  ]);
});

test('preserves definition order for a semantic no-op move', () => {
  const definitions = ['People', 'People > Family', 'Places'];
  const plan = planTagDefinitionBranchMove(definitions, 'People > Family', 'People');

  assert.equal(plan.affectedDefinitionCount, 0);
  assert.equal(plan.deduplicatedDefinitionCount, 0);
  assert.deepEqual(plan.mappings, []);
  assert.deepEqual(plan.nextDefinitions, definitions);
  assert.notEqual(plan.nextDefinitions, definitions);
});

test('plans exact and branch definition removal without reinterpreting legacy values', () => {
  const definitions = [
    'Camera',
    'Camera > Canon',
    'Camera > Canon > Rangefinder',
    'Artist',
    'Camera>Legacy',
  ];
  const exactPlan = planExactTagDefinitionRemoval(definitions, 'camera');
  const exactHierarchy = buildTagHierarchy([], exactPlan.nextDefinitions);

  assert.deepEqual(exactPlan.removedDefinitions, ['Camera']);
  assert.equal(findNode(exactHierarchy, 'Camera').explicit, false);
  assert.equal(findNode(exactHierarchy, 'Camera > Canon').explicit, true);

  const branchPlan = planTagDefinitionBranchRemoval(definitions, 'Camera');
  assert.deepEqual(branchPlan.removedDefinitions, [
    'Camera',
    'Camera > Canon',
    'Camera > Canon > Rangefinder',
  ]);
  assert.deepEqual(branchPlan.nextDefinitions, ['Artist', 'Camera>Legacy']);
  assert.deepEqual(definitions, [
    'Camera',
    'Camera > Canon',
    'Camera > Canon > Rangefinder',
    'Artist',
    'Camera>Legacy',
  ]);
});

test('resolves tag colours only from the exact tag path', () => {
  const colors = {
    Camera: '#A0C4FF',
    'Camera > Canon': '#FFD6A5',
  };

  assert.equal(getExactTagColor(colors, 'camera'), '#A0C4FF');
  assert.equal(getExactTagColor(colors, 'Camera > Canon'), '#FFD6A5');
  assert.equal(getExactTagColor(colors, 'Camera > Nikon'), undefined);
  assert.equal(getExactTagColor(colors, 'Camera > Canon > Rangefinder'), undefined);
});

test('requires tag-removal confirmation only when video assignments are affected', () => {
  assert.equal(tagRemovalRequiresConfirmation(0), false);
  assert.equal(tagRemovalRequiresConfirmation(1), true);
  assert.equal(tagRemovalRequiresConfirmation(25), true);
});
