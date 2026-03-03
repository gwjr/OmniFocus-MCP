/**
 * Variable registries for each entity type.
 * Maps user-facing var names to type metadata, Apple Events property names,
 * and cost classification.
 *
 * JXA accessor expressions live in backends/jxaVarAccessors.ts.
 */

export interface VarDef {
  /** Type hint for compile-time checking */
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'array';
  /** Property name in bulk-read row objects */
  nodeKey: string;
  /** Apple Events bulk property name, or null if per-item only */
  appleEventsProperty: string | null;
  /** Read cost classification */
  cost: 'easy' | 'chain' | 'per-item' | 'expensive' | 'computed';
}

export type VarCost = VarDef['cost'];

export type VarRegistry = Record<string, VarDef>;

/**
 * Dependency map for computed variables.
 * Key: entity name. Value: map of computed var name → list of dependency var names.
 * The planner adds dependencies to BulkScan columns so the executor can derive values.
 */
export const computedVarDeps: Record<string, Record<string, string[]>> = {
  tasks: {
    status: ['completed', 'dropped', 'blocked', 'dueDate'],
    taskStatus: ['completed', 'dropped', 'blocked', 'dueDate'],  // alias for status
    hasChildren: ['childCount'],
  },
  folders: {
    status: ['hidden'],
  },
};

// Helpers for concise registry definitions
const str  = (nodeKey: string, appleEventsProperty: string | null, cost: VarDef['cost']): VarDef =>
  ({ type: 'string', nodeKey, appleEventsProperty, cost });
const num  = (nodeKey: string, appleEventsProperty: string | null, cost: VarDef['cost']): VarDef =>
  ({ type: 'number', nodeKey, appleEventsProperty, cost });
const bool = (nodeKey: string, appleEventsProperty: string | null, cost: VarDef['cost']): VarDef =>
  ({ type: 'boolean', nodeKey, appleEventsProperty, cost });
const date = (nodeKey: string, appleEventsProperty: string | null, cost: VarDef['cost']): VarDef =>
  ({ type: 'date', nodeKey, appleEventsProperty, cost });
const enm  = (nodeKey: string, appleEventsProperty: string | null, cost: VarDef['cost']): VarDef =>
  ({ type: 'enum', nodeKey, appleEventsProperty, cost });
const arr  = (nodeKey: string, appleEventsProperty: string | null, cost: VarDef['cost']): VarDef =>
  ({ type: 'array', nodeKey, appleEventsProperty, cost });

export const taskVars: VarRegistry = {
  // easy: direct Apple Events bulk-readable properties
  id:                   str( 'id',                   'id',                    'easy'),
  name:                 str( 'name',                 'name',                  'easy'),
  flagged:              bool('flagged',              'flagged',               'easy'),
  dueDate:              date('dueDate',              'dueDate',               'easy'),
  deferDate:            date('deferDate',            'deferDate',             'easy'),
  plannedDate:          date('plannedDate',          'plannedDate',           'easy'),
  effectiveDueDate:     date('effectiveDueDate',     'effectiveDueDate',      'easy'),
  effectiveDeferDate:   date('effectiveDeferDate',   'effectiveDeferDate',    'easy'),
  effectivePlannedDate: date('effectivePlannedDate', 'effectivePlannedDate',  'easy'),
  completionDate:       date('completionDate',       'completionDate',        'easy'),
  modificationDate:     date('modificationDate',     'modificationDate',      'easy'),
  creationDate:         date('creationDate',         'creationDate',          'easy'),
  estimatedMinutes:     num( 'estimatedMinutes',     'estimatedMinutes',      'easy'),
  blocked:              bool('blocked',              'blocked',               'easy'),
  effectivelyCompleted: bool('effectivelyCompleted', 'effectivelyCompleted',  'easy'),
  effectivelyDropped:   bool('effectivelyDropped',   'effectivelyDropped',    'easy'),
  completed:            bool('completed',            'completed',             'easy'),
  dropped:              bool('dropped',              'dropped',               'easy'),

  // chain: requires traversing containingProject
  projectName:          str( 'projectName',          'containingProject',     'chain'),
  projectId:            str( 'projectId',            'containingProject',     'chain'),

  // easy: reclassified from per-item (verified bulk Apple Events accessors)
  inInbox:              bool('inInbox',              'inInbox',               'easy'),
  sequential:           bool('sequential',           'sequential',            'easy'),
  childCount:           num( 'childCount',           'numberOfTasks',         'easy'),

  // chain: reclassified from per-item (chained bulk Apple Events)
  parentId:             str( 'parentId',             'parentTask',            'chain'),
  tags:                 arr( 'tags',                 'tags',                  'chain'),

  // computed: derived in Node from other bulk-readable properties
  status:               enm( 'status',               null,                    'computed'),
  taskStatus:           enm( 'status',               null,                    'computed'),  // user-facing alias for status
  hasChildren:          bool('hasChildren',          null,                    'computed'),

  // expensive
  note:                 str( 'note',                 null,                    'expensive'),

  // special
  now:                  date('now',                  null,                    'easy'),
};

export const projectVars: VarRegistry = {
  // easy: bulk Apple Events readable properties
  id:                 str( 'id',                 'id',                    'easy'),
  name:               str( 'name',               'name',                  'easy'),
  status:             enm( 'status',             'effectiveStatus',       'easy'),
  flagged:            bool('flagged',            'flagged',               'easy'),
  completed:          bool('completed',          'completed',             'easy'),
  dueDate:            date('dueDate',            'dueDate',               'easy'),
  deferDate:          date('deferDate',          'deferDate',             'easy'),
  effectiveDueDate:   date('effectiveDueDate',   'effectiveDueDate',      'easy'),
  effectiveDeferDate: date('effectiveDeferDate', 'effectiveDeferDate',    'easy'),
  completionDate:     date('completionDate',     'completionDate',        'easy'),
  modificationDate:   date('modificationDate',   'modificationDate',      'easy'),
  creationDate:       date('creationDate',       'creationDate',          'easy'),
  estimatedMinutes:   num( 'estimatedMinutes',   'estimatedMinutes',      'easy'),
  sequential:         bool('sequential',         'sequential',            'easy'),
  taskCount:          num( 'taskCount',          'numberOfTasks',         'easy'),
  activeTaskCount:    num( 'activeTaskCount',    'numberOfAvailableTasks','easy'),

  // chain: chained bulk via container.id() (Apple Events)
  // Note: root-level projects have the document as container, not a folder — callers
  // must cross-reference against known folder IDs and treat non-folder containers as null.
  folderId:           str( 'folderId',           'container',             'chain'),

  // per-item: container.name() — null for root-level projects (container is the document).
  // The legacy pipeline routes this through PerItemEnrich; the SetIR pipeline routes it
  // through Enrich, which uses the chain prop spec from strategyToEventPlan.ts.
  folderName:         str( 'folderName',         null,                    'per-item'),

  // expensive
  note:               str( 'note',               null,                    'expensive'),

  // special
  now:                date('now',                null,                    'easy'),
};

export const folderVars: VarRegistry = {
  // easy: bulk Apple Events readable
  id:             str( 'id',             'id',       'easy'),
  name:           str( 'name',           'name',     'easy'),
  hidden:         bool('hidden',         'hidden',   'easy'),

  // chain: chained bulk via container
  parentFolderId: str( 'parentFolderId', 'container','chain'),

  // per-item: resolved by crossEntityJoinPass
  projectCount:   num( 'projectCount',   null,       'per-item'),

  // computed: derived in Node from bulk-readable hidden property
  status:         enm( 'status',         null,       'computed'),

  // special
  now:            date('now',            null,       'easy'),
};

export const perspectiveVars: VarRegistry = {
  id:   str('id',   'id',   'easy'),
  name: str('name', 'name', 'easy'),
};

export const tagVars: VarRegistry = {
  // easy: direct Apple Events bulk-readable properties
  id:                 str( 'id',                 'id',                  'easy'),
  name:               str( 'name',               'name',                'easy'),
  allowsNextAction:   bool('allowsNextAction',   'allowsNextAction',    'easy'),
  hidden:             bool('hidden',             'hidden',              'easy'),
  effectivelyHidden:  bool('effectivelyHidden',  'effectivelyHidden',   'easy'),
  availableTaskCount: num( 'availableTaskCount', 'availableTaskCount',  'easy'),
  remainingTaskCount: num( 'remainingTaskCount', 'remainingTaskCount',  'easy'),

  // chain: chained bulk via container.id() (parent tag ID)
  parentId:           str( 'parentId',           'container',           'chain'),

  // per-item: requires per-item access
  parentName:         str( 'parentName',         null,                  'per-item'),

  // expensive
  note:               str( 'note',               null,                  'expensive'),

  // special
  now:                date('now',                null,                  'easy'),
};

export type EntityType = 'tasks' | 'projects' | 'folders' | 'tags' | 'perspectives';

export function getVarRegistry(entity: EntityType): VarRegistry {
  switch (entity) {
    case 'tasks':        return taskVars;
    case 'projects':     return projectVars;
    case 'folders':      return folderVars;
    case 'tags':         return tagVars;
    case 'perspectives': return perspectiveVars;
  }
}

export function getVarNames(entity: EntityType): string[] {
  return Object.keys(getVarRegistry(entity)).sort();
}

/**
 * Check if a variable name refers to an array-typed variable for the given entity.
 */
export function isArrayVar(varName: string, entity: EntityType): boolean {
  const registry = getVarRegistry(entity);
  return registry[varName]?.type === 'array';
}
