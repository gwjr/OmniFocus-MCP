/**
 * Variable registries for each entity type.
 * Maps user-facing var names to JXA access expressions, type metadata,
 * bulk-read properties, and cost classification.
 */

export interface VarDef {
  /** JXA expression generator — takes the current item variable name */
  jxa: (itemVar: string) => string;
  /** Type hint for compile-time checking */
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'array';
  /** Property name in bulk-read row objects */
  nodeKey: string;
  /** JXA Apple Events bulk property name, or null if per-item only */
  bulk: string | null;
  /** Read cost classification */
  cost: 'easy' | 'chain' | 'per-item' | 'expensive';
}

export type VarRegistry = Record<string, VarDef>;

// Helpers for concise registry definitions
const str  = (accessor: (v: string) => string, nodeKey: string, bulk: string | null, cost: VarDef['cost']): VarDef =>
  ({ jxa: accessor, type: 'string', nodeKey, bulk, cost });
const num  = (accessor: (v: string) => string, nodeKey: string, bulk: string | null, cost: VarDef['cost']): VarDef =>
  ({ jxa: accessor, type: 'number', nodeKey, bulk, cost });
const bool = (accessor: (v: string) => string, nodeKey: string, bulk: string | null, cost: VarDef['cost']): VarDef =>
  ({ jxa: accessor, type: 'boolean', nodeKey, bulk, cost });
const date = (accessor: (v: string) => string, nodeKey: string, bulk: string | null, cost: VarDef['cost']): VarDef =>
  ({ jxa: accessor, type: 'date', nodeKey, bulk, cost });
const enm  = (accessor: (v: string) => string, nodeKey: string, bulk: string | null, cost: VarDef['cost']): VarDef =>
  ({ jxa: accessor, type: 'enum', nodeKey, bulk, cost });
const arr  = (accessor: (v: string) => string, nodeKey: string, bulk: string | null, cost: VarDef['cost']): VarDef =>
  ({ jxa: accessor, type: 'array', nodeKey, bulk, cost });

export const taskVars: VarRegistry = {
  // easy: direct Apple Events bulk-readable properties
  id:                   str(v  => `${v}.id.primaryKey`,                                                      'id',                   'id',                    'per-item'),
  name:                 str(v  => `(${v}.name || "")`,                                                       'name',                 'name',                  'easy'),
  flagged:              bool(v => `${v}.flagged`,                                                             'flagged',              'flagged',               'easy'),
  dueDate:              date(v => `${v}.dueDate`,                                                             'dueDate',              'dueDate',               'easy'),
  deferDate:            date(v => `${v}.deferDate`,                                                           'deferDate',            'deferDate',             'easy'),
  plannedDate:          date(v => `${v}.plannedDate`,                                                         'plannedDate',          'plannedDate',           'easy'),
  effectiveDueDate:     date(v => `${v}.effectiveDueDate`,                                                    'effectiveDueDate',     'effectiveDueDate',      'easy'),
  effectiveDeferDate:   date(v => `${v}.effectiveDeferDate`,                                                  'effectiveDeferDate',   'effectiveDeferDate',    'easy'),
  effectivePlannedDate: date(v => `${v}.effectivePlannedDate`,                                                'effectivePlannedDate', 'effectivePlannedDate',  'easy'),
  completionDate:       date(v => `${v}.completionDate`,                                                      'completionDate',       'completionDate',        'easy'),
  modificationDate:     date(v => `${v}.modified`,                                                            'modificationDate',     'modificationDate',      'easy'),
  creationDate:         date(v => `${v}.added`,                                                               'creationDate',         'creationDate',          'easy'),
  estimatedMinutes:     num(v  => `${v}.estimatedMinutes`,                                                    'estimatedMinutes',     'estimatedMinutes',      'easy'),
  completed:            bool(v => `(${v}.taskStatus === Task.Status.Completed)`,                              'completed',            null,                    'per-item'),
  dropped:              bool(v => `(${v}.taskStatus === Task.Status.Dropped)`,                                'dropped',              null,                    'per-item'),

  // chain: requires traversing containingProject
  projectName:          str(v  => `(${v}.containingProject ? ${v}.containingProject.name || "" : "")`,        'projectName',          'containingProject',     'chain'),
  projectId:            str(v  => `(${v}.containingProject ? ${v}.containingProject.id.primaryKey : null)`,   'projectId',            'containingProject',     'chain'),

  // per-item: requires per-item access
  status:               enm(v  => `taskStatusMap[${v}.taskStatus]`,                                           'status',               null,                    'per-item'),
  tags:                 arr(v  => `${v}.tags.map(function(t){return t.name.toLowerCase();})`,                  'tags',                 null,                    'per-item'),
  inInbox:              bool(v => `${v}.inInbox`,                                                             'inInbox',              null,                    'per-item'),
  sequential:           bool(v => `${v}.sequential`,                                                          'sequential',           null,                    'per-item'),
  hasChildren:          bool(v => `(${v}.children ? ${v}.children.length > 0 : false)`,                       'hasChildren',          null,                    'per-item'),
  childCount:           num(v  => `(${v}.children ? ${v}.children.length : 0)`,                               'childCount',           null,                    'per-item'),
  parentId:             str(v  => `(${v}.parent ? ${v}.parent.id.primaryKey : null)`,                         'parentId',             null,                    'per-item'),

  // expensive
  note:                 str(v  => `(${v}.note || "")`,                                                        'note',                 null,                    'expensive'),

  // special
  now:                  date(_ => '_now',                                                                      'now',                  null,                    'easy'),
};

export const projectVars: VarRegistry = {
  id:                 str(v  => `${v}.id.primaryKey`,                                                          'id',               'id',                    'per-item'),
  name:               str(v  => `(${v}.name || "")`,                                                           'name',             'name',                  'easy'),
  status:             enm(v  => `projectStatusMap[${v}.status]`,                                                'status',           null,                    'per-item'),
  flagged:            bool(v => `${v}.flagged`,                                                                 'flagged',          'flagged',               'easy'),
  dueDate:            date(v => `${v}.dueDate`,                                                                 'dueDate',          'dueDate',               'easy'),
  deferDate:          date(v => `${v}.deferDate`,                                                               'deferDate',        'deferDate',             'easy'),
  effectiveDueDate:   date(v => `${v}.effectiveDueDate`,                                                        'effectiveDueDate', 'effectiveDueDate',      'easy'),
  effectiveDeferDate: date(v => `${v}.effectiveDeferDate`,                                                      'effectiveDeferDate','effectiveDeferDate',   'easy'),
  modificationDate:   date(v => `${v}.task.modified`,                                                           'modificationDate', null,                    'per-item'),
  creationDate:       date(v => `${v}.task.added`,                                                              'creationDate',     null,                    'per-item'),
  estimatedMinutes:   num(v  => `${v}.estimatedMinutes`,                                                        'estimatedMinutes', 'estimatedMinutes',      'easy'),
  sequential:         bool(v => `${v}.sequential`,                                                              'sequential',       null,                    'per-item'),
  folderId:           str(v  => `(${v}.parentFolder ? ${v}.parentFolder.id.primaryKey : null)`,                 'folderId',         null,                    'per-item'),
  taskCount:          num(v  => `(${v}.tasks ? ${v}.tasks.length : 0)`,                                         'taskCount',        null,                    'per-item'),
  activeTaskCount:    num(v  => `(${v}.tasks ? ${v}.tasks.filter(t => t.taskStatus !== Task.Status.Completed && t.taskStatus !== Task.Status.Dropped).length : 0)`, 'activeTaskCount', null, 'per-item'),
  note:               str(v  => `(${v}.note || "")`,                                                            'note',             null,                    'expensive'),
  now:                date(_ => '_now',                                                                          'now',              null,                    'easy'),
};

export const folderVars: VarRegistry = {
  id:             str(v  => `${v}.id.primaryKey`,                                                               'id',               'id',                    'per-item'),
  name:           str(v  => `(${v}.name || "")`,                                                                'name',             'name',                  'easy'),
  status:         enm(v  => `folderStatusMap[${v}.status]`,                                                     'status',           null,                    'per-item'),
  parentFolderId: str(v  => `(${v}.parent ? ${v}.parent.id.primaryKey : null)`,                                 'parentFolderId',   null,                    'per-item'),
  projectCount:   num(v  => `(${v}.projects ? ${v}.projects.length : 0)`,                                       'projectCount',     null,                    'per-item'),
  path:           str(v  => `(${v}.container ? ${v}.container.name + "/" + ${v}.name : ${v}.name)`,             'path',             null,                    'per-item'),
  now:            date(_ => '_now',                                                                              'now',              null,                    'easy'),
};

export const tagVars: VarRegistry = {
  // easy: direct Apple Events bulk-readable properties
  id:                 str(v  => `${v}.id.primaryKey`,                                                            'id',                'id',                   'per-item'),
  name:               str(v  => `(${v}.name || "")`,                                                             'name',              'name',                 'easy'),
  allowsNextAction:   bool(v => `${v}.allowsNextAction`,                                                         'allowsNextAction',  'allowsNextAction',     'easy'),
  hidden:             bool(v => `${v}.hidden`,                                                                   'hidden',            'hidden',               'easy'),
  effectivelyHidden:  bool(v => `${v}.effectivelyHidden`,                                                        'effectivelyHidden', 'effectivelyHidden',    'easy'),
  availableTaskCount: num(v  => `(${v}.availableTasks ? ${v}.availableTasks.length : 0)`,                         'availableTaskCount','availableTaskCount',   'easy'),
  remainingTaskCount: num(v  => `(${v}.remainingTasks ? ${v}.remainingTasks.length : 0)`,                         'remainingTaskCount','remainingTaskCount',   'easy'),

  // per-item: requires per-item access
  parentName:         str(v  => `(${v}.parent ? ${v}.parent.name : null)`,                                        'parentName',        null,                   'per-item'),

  // expensive
  note:               str(v  => `(${v}.note || "")`,                                                              'note',              null,                   'expensive'),

  // special
  now:                date(_ => '_now',                                                                            'now',               null,                   'easy'),
};

export type EntityType = 'tasks' | 'projects' | 'folders' | 'tags';

export function getVarRegistry(entity: EntityType): VarRegistry {
  switch (entity) {
    case 'tasks':    return taskVars;
    case 'projects': return projectVars;
    case 'folders':  return folderVars;
    case 'tags':     return tagVars;
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
