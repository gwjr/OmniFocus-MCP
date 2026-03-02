/**
 * OmniFocus Apple Events FourCC constants.
 *
 * AUTO-GENERATED from OmniFocus.app sdef via scripts/gen-sdef.py.
 * DO NOT EDIT MANUALLY — run the generator to update.
 *
 * Hand-stubbed until the generator is written.
 * Source: OmniFocus 3.x scripting dictionary.
 */

// ── Class codes ──────────────────────────────────────────────────────────────

/** Apple Events class codes for OmniFocus entity types. */
export const OFClass = {
  /** Application/document root */
  document:         'docu',

  /** task (individual task object, non-flattened) */
  task:             'FCac',

  /** flattened task (appears in doc.flattenedTasks) */
  flattenedTask:    'FCft',

  /** project (wrapper around a root task) */
  project:          'FCpr',

  /** flattened project (appears in doc.flattenedProjects) */
  flattenedProject: 'FCfx',

  /** folder */
  folder:           'FCAr',

  /** flattened folder (appears in doc.flattenedFolders) */
  flattenedFolder:  'FCff',

  /** tag */
  tag:              'FCtg',

  /** flattened tag (appears in doc.flattenedTags) */
  flattenedTag:     'FCfc',
} as const satisfies Record<string, string>;

export type OFClassName = keyof typeof OFClass;

// ── Property codes — shared ──────────────────────────────────────────────────

/** Property codes that appear on multiple entity types. */
export const OFProp = {
  /** id (primary key) — note: 4 chars including 2 trailing spaces */
  id:   'ID  ',
  /** name */
  name: 'pnam',
  /** note */
  note: 'FCno',
} as const satisfies Record<string, string>;

// ── Property codes — task ────────────────────────────────────────────────────

/** Property codes specific to task / flattened task. */
export const OFTaskProp = {
  /** id (primary key) */
  id:                   'ID  ',
  /** name */
  name:                 'pnam',
  /** flagged */
  flagged:              'FCfl',
  /** due date */
  dueDate:              'FCDd',
  /** defer date */
  deferDate:            'FCDs',
  /** effective due date */
  effectiveDueDate:     'FCde',
  /** effective defer date */
  effectiveDeferDate:   'FCse',
  /** completed */
  completed:            'FCcd',
  /** effectively completed */
  effectivelyCompleted: 'FCce',
  /** dropped */
  dropped:              'FC-d',
  /** effectively dropped */
  effectivelyDropped:   'FC-e',
  /** blocked */
  blocked:              'FCBl',
  /** containing project */
  containingProject:    'FCPr',
  /** parent task */
  parentTask:           'FCPt',
  /** in inbox */
  inInbox:              'FCIi',
  /** sequential */
  sequential:           'FCsq',
  /** estimated minutes */
  estimatedMinutes:     'FCEM',
  /** note */
  note:                 'FCno',
  /** number of child tasks */
  numberOfTasks:        'FC#t',
  /** tags (element, not property — returns collection) */
  tags:                 'FCtg',
  /** creation date */
  creationDate:         'ascd',
  /** modification date */
  modificationDate:     'asmo',
  /** completion date */
  completionDate:       'FCDc',
} as const satisfies Record<string, string>;

// ── Property codes — project ─────────────────────────────────────────────────

/** Property codes specific to project / flattened project. */
export const OFProjectProp = {
  /** id */
  id:                   'ID  ',
  /** name */
  name:                 'pnam',
  /** status (active status, done status, dropped status, on hold status) */
  status:               'FCst',
  /** flagged */
  flagged:              'FCfl',
  /** due date */
  dueDate:              'FCDd',
  /** defer date */
  deferDate:            'FCDs',
  /** effective due date */
  effectiveDueDate:     'FCde',
  /** effective defer date */
  effectiveDeferDate:   'FCse',
  /** completed */
  completed:            'FCcd',
  /** dropped */
  dropped:              'FC-d',
  /** sequential */
  sequential:           'FCsq',
  /** estimated minutes */
  estimatedMinutes:     'FCEM',
  /** note */
  note:                 'FCno',
  /** number of tasks */
  numberOfTasks:        'FC#t',
  /** containing folder id — resolved via containing folder element */
  containingFolderId:   'FCAr',
  /** tags */
  tags:                 'FCtg',
  /** creation date */
  creationDate:         'ascd',
  /** modification date */
  modificationDate:     'asmo',
  /** completion date */
  completionDate:       'FCDc',
} as const satisfies Record<string, string>;

// ── Property codes — folder ──────────────────────────────────────────────────

/** Property codes specific to folder / flattened folder. */
export const OFFolderProp = {
  /** id */
  id:     'ID  ',
  /** name */
  name:   'pnam',
  /** hidden */
  hidden: 'pvis',
  /** effectively hidden */
  effectivelyHidden: 'FCeh',
  /** note */
  note:   'FCno',
} as const satisfies Record<string, string>;

// ── Property codes — tag ─────────────────────────────────────────────────────

/** Property codes specific to tag / flattened tag. */
export const OFTagProp = {
  /** id */
  id:               'ID  ',
  /** name */
  name:             'pnam',
  /** effectively hidden */
  effectivelyHidden: 'FCeh',
  /** parent tag (element) */
  parentTag:        'FCtg',
} as const satisfies Record<string, string>;

// ── Element class codes — relationships ──────────────────────────────────────

/**
 * Element class codes used in membership/traversal relationships.
 * e.g. Elements(tagRef, OFElement.flattenedTask) → tasks belonging to that tag.
 */
export const OFElement = {
  /** flattenedTask — elements of tag, project, folder */
  flattenedTask:    'FCft',
  /** flattenedProject — elements of folder */
  flattenedProject: 'FCfx',
  /** flattenedFolder — elements of folder */
  flattenedFolder:  'FCff',
  /** flattenedTag — elements of tag (child tags) */
  flattenedTag:     'FCfc',
  /** tag — elements of task or project */
  tag:              'FCtg',
} as const satisfies Record<string, string>;
