/**
 * OmniFocus Apple Events FourCC constants.
 *
 * AUTO-GENERATED from OmniFocus.app sdef via scripts/gen-sdef.ts.
 * DO NOT EDIT MANUALLY -- run the generator to update.
 *
 * Source: docs/omnifocus-applescript-dictionary.sdef
 */

// -- Class codes ------------------------------------------------------------------

/** Apple Events class codes for OmniFocus entity types. */
export const OFClass = {
  /** Application/document root */
  document: 'docu',

  /** task (individual task object, non-flattened) */
  task: 'FCac',

  /** flattened task (appears in doc.flattenedTasks) */
  flattenedTask: 'FCft',

  /** project (wrapper around a root task) */
  project: 'FCpr',

  /** flattened project (appears in doc.flattenedProjects) */
  flattenedProject: 'FCfx',

  /** folder */
  folder: 'FCAr',

  /** flattened folder (appears in doc.flattenedFolders) */
  flattenedFolder: 'FCff',

  /** tag */
  tag: 'FCtg',

  /** flattened tag (appears in doc.flattenedTags) */
  flattenedTag: 'FCfc',

  /** section (folder or project) */
  section: 'FCSX',

  /** inbox task (task in document inbox) */
  inboxTask: 'FCit',

  /** available task (unblocked and incomplete) */
  availableTask: 'FCat',

  /** remaining task (incomplete but possibly blocked) */
  remainingTask: 'FC0T',

} as const satisfies Record<string, string>;

export type OFClassName = keyof typeof OFClass;

// -- Property codes -- shared -----------------------------------------------------

/** Property codes that appear on multiple entity types. */
export const OFProp = {
  /** id -- The identifier of the task. */
  id: 'ID  ',
  /** name -- The name of the task. */
  name: 'pnam',
  /** note -- The note of the task. */
  note: 'FCno',
  /** container -- The containing task, project or document. */
  container: 'ctnr',
  /** containingDocument -- The containing document or quick entry tree of the object. */
  containingDocument: 'FCCo',
} as const satisfies Record<string, string>;

// -- Property codes -- task / flattened task ----------------------------------

/** Property codes specific to task / flattened task. */
export const OFTaskProp = {
  /** id */
  id: 'ID  ',
  /** name */
  name: 'pnam',
  /** note */
  note: 'FCno',
  /** container */
  container: 'ctnr',
  /** containing project */
  containingProject: 'FCPr',
  /** parent task */
  parentTask: 'FCPt',
  /** containing document */
  containingDocument: 'FCCo',
  /** in inbox */
  inInbox: 'FCIi',
  /** primary tag */
  primaryTag: 'FCpt',
  /** completed by children */
  completedByChildren: 'FCbc',
  /** sequential */
  sequential: 'FCsq',
  /** flagged */
  flagged: 'FCfl',
  /** next */
  next: 'FCnx',
  /** blocked */
  blocked: 'FCBl',
  /** creation date */
  creationDate: 'FCDa',
  /** modification date */
  modificationDate: 'FCDm',
  /** defer date */
  deferDate: 'FCDs',
  /** effective defer date */
  effectiveDeferDate: 'FCse',
  /** planned date */
  plannedDate: 'FCDp',
  /** effective planned date */
  effectivePlannedDate: 'FCpe',
  /** due date */
  dueDate: 'FCDd',
  /** effective due date */
  effectiveDueDate: 'FCde',
  /** should use floating time zone */
  shouldUseFloatingTimeZone: 'FCtz',
  /** completion date */
  completionDate: 'FCdc',
  /** completed */
  completed: 'FCcd',
  /** effectively completed */
  effectivelyCompleted: 'FCce',
  /** dropped date */
  droppedDate: 'FCd-',
  /** dropped */
  dropped: 'FC-d',
  /** effectively dropped */
  effectivelyDropped: 'FC-e',
  /** estimated minutes */
  estimatedMinutes: 'FCEM',
  /** repetition */
  repetition: 'FCRp',
  /** repetition rule */
  repetitionRule: 'FCRR',
  /** next defer date */
  nextDeferDate: 'FCns',
  /** next planned date */
  nextPlannedDate: 'FCnp',
  /** next due date */
  nextDueDate: 'FCnd',
  /** number of tasks */
  numberOfTasks: 'FC#t',
  /** number of available tasks */
  numberOfAvailableTasks: 'FC#a',
  /** number of completed tasks */
  numberOfCompletedTasks: 'FC#c',
  /** transport text */
  transportText: 'FCTt',
  /** tags (element, not property -- returns collection via .tags.name()/.tags.id()) */
  tags: 'FCtg',
} as const satisfies Record<string, string>;

// -- Property codes -- project / flattened project ----------------------------

/** Property codes specific to project / flattened project. */
export const OFProjectProp = {
  /** id */
  id: 'ID  ',
  /** next task */
  nextTask: 'FCna',
  /** last review date */
  lastReviewDate: 'FCDr',
  /** next review date */
  nextReviewDate: 'FCDR',
  /** review interval */
  reviewInterval: 'FCRI',
  /** status */
  status: 'FCPs',
  /** effective status */
  effectiveStatus: 'FCPS',
  /** singleton action holder */
  singletonActionHolder: 'FC.A',
  /** default singleton action holder */
  defaultSingletonActionHolder: 'FCd.',
  /** container */
  container: 'ctnr',
  /** folder */
  folder: 'FCAr',
  /** name */
  name: 'pnam',
  /** note */
  note: 'FCno',
  /** containing document */
  containingDocument: 'FCCo',
  /** primary tag */
  primaryTag: 'FCpt',
  /** completed by children */
  completedByChildren: 'FCbc',
  /** sequential */
  sequential: 'FCsq',
  /** flagged */
  flagged: 'FCfl',
  /** blocked */
  blocked: 'FCBl',
  /** creation date */
  creationDate: 'FCDa',
  /** modification date */
  modificationDate: 'FCDm',
  /** defer date */
  deferDate: 'FCDs',
  /** effective defer date */
  effectiveDeferDate: 'FCse',
  /** planned date */
  plannedDate: 'FCDp',
  /** effective planned date */
  effectivePlannedDate: 'FCpe',
  /** due date */
  dueDate: 'FCDd',
  /** effective due date */
  effectiveDueDate: 'FCde',
  /** should use floating time zone */
  shouldUseFloatingTimeZone: 'FCtz',
  /** completion date */
  completionDate: 'FCdc',
  /** completed */
  completed: 'FCcd',
  /** effectively completed */
  effectivelyCompleted: 'FCce',
  /** dropped date */
  droppedDate: 'FCd-',
  /** dropped */
  dropped: 'FC-d',
  /** effectively dropped */
  effectivelyDropped: 'FC-e',
  /** estimated minutes */
  estimatedMinutes: 'FCEM',
  /** repetition */
  repetition: 'FCRp',
  /** repetition rule */
  repetitionRule: 'FCRR',
  /** next defer date */
  nextDeferDate: 'FCns',
  /** next planned date */
  nextPlannedDate: 'FCnp',
  /** next due date */
  nextDueDate: 'FCnd',
  /** number of tasks */
  numberOfTasks: 'FC#t',
  /** number of available tasks */
  numberOfAvailableTasks: 'FC#a',
  /** number of completed tasks */
  numberOfCompletedTasks: 'FC#c',
  /** root task */
  rootTask: 'FCrt',
  /** containing folder (alias for folder property -- used for folder relationship traversal) */
  containingFolderId: 'FCAr',
  /** tags (element, not property -- returns collection) */
  tags: 'FCtg',
} as const satisfies Record<string, string>;

// -- Property codes -- folder / flattened folder ------------------------------

/** Property codes specific to folder / flattened folder. */
export const OFFolderProp = {
  /** id */
  id: 'ID  ',
  /** name */
  name: 'pnam',
  /** note */
  note: 'FCno',
  /** hidden */
  hidden: 'FCHi',
  /** effectively hidden */
  effectivelyHidden: 'FCHe',
  /** creation date */
  creationDate: 'FCDa',
  /** modification date */
  modificationDate: 'FCDm',
  /** container */
  container: 'ctnr',
  /** containing document */
  containingDocument: 'FCCo',
} as const satisfies Record<string, string>;

// -- Property codes -- tag / flattened tag ------------------------------------

/** Property codes specific to tag / flattened tag. */
export const OFTagProp = {
  /** id */
  id: 'ID  ',
  /** name */
  name: 'pnam',
  /** note */
  note: 'FCno',
  /** allows next action */
  allowsNextAction: 'FCNA',
  /** hidden */
  hidden: 'FCHi',
  /** effectively hidden */
  effectivelyHidden: 'FCHe',
  /** container */
  container: 'ctnr',
  /** available task count */
  availableTaskCount: 'FCa#',
  /** remaining task count */
  remainingTaskCount: 'FCr#',
  /** containing document */
  containingDocument: 'FCCo',
  /** location */
  location: 'FClo',
  /** parent tag (alias for container property -- tag-specific name for the parent relationship) */
  parentTag: 'FCtg',
} as const satisfies Record<string, string>;

// -- Element class codes -- relationships ------------------------------------------

/**
 * Element class codes used in membership/traversal relationships.
 * e.g. Elements(tagRef, OFElement.flattenedTask) -> tasks belonging to that tag.
 */
export const OFElement = {
  /** flattenedTask -- elements of tag, project, folder */
  flattenedTask: 'FCft',

  /** flattenedProject -- elements of folder */
  flattenedProject: 'FCfx',

  /** flattenedFolder -- elements of folder */
  flattenedFolder: 'FCff',

  /** flattenedTag -- elements of tag (child tags) */
  flattenedTag: 'FCfc',

  /** tag -- elements of task or project */
  tag: 'FCtg',

  /** task -- elements of tag, project, task */
  task: 'FCac',

  /** project -- elements of folder, document */
  project: 'FCpr',

  /** folder -- elements of folder, document */
  folder: 'FCAr',

  /** inboxTask -- elements of document */
  inboxTask: 'FCit',

  /** availableTask -- elements of tag, project, task */
  availableTask: 'FCat',

  /** remainingTask -- elements of tag, project, task */
  remainingTask: 'FC0T',

  /** section -- elements of folder, document */
  section: 'FCSX',

} as const satisfies Record<string, string>;
