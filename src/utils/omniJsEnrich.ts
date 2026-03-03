/**
 * OmniJS byIdentifier() enrichment utility.
 *
 * Given an entity type, a list of IDs, and a list of output columns,
 * generates and executes an OmniJS script that calls Entity.byIdentifier()
 * for each ID and reads the requested properties.
 *
 * This is the fast path for small result sets (<50 items) — avoids bulk-
 * scanning the entire collection when only a few rows need enriching.
 * See benchmark/REPORT.md section 8 and docs/deferred-enrichment-design.md.
 */

import type { EntityType } from '../tools/query/variables.js';
import type { Row } from '../tools/query/backends/nodeEval.js';
import { executeJXA } from './scriptExecution.js';

// ── OmniJS class names per entity ────────────────────────────────────────

const OMNIJS_CLASS: Record<string, string> = {
  tasks:    'Task',
  projects: 'Project',
  folders:  'Folder',
  tags:     'Tag',
};

// ── OmniJS property accessor mapping ─────────────────────────────────────
//
// Maps internal var names → OmniJS JavaScript expression fragments.
// The expression receives the variable `_` (the OmniJS object) and must
// return a JSON-safe value.
//
// Types:
//   'prop'   → simple property access: `_.propName`
//   'expr'   → arbitrary expression: evaluated as-is
//   'date'   → date property: `_.propName ? _.propName.toISOString() : null`
//
// The mapping is per-entity because the same var name may map to different
// OmniJS accessors depending on entity (e.g. 'status' on tasks vs projects).

interface OmniJsAccessor {
  kind: 'prop' | 'date' | 'expr';
  /** OmniJS expression fragment. `_` is the object variable. */
  expr: string;
}

const p = (name: string): OmniJsAccessor => ({ kind: 'prop', expr: `_.${name}` });
const d = (name: string): OmniJsAccessor => ({ kind: 'date', expr: `_.${name}` });
const e = (expr: string): OmniJsAccessor => ({ kind: 'expr', expr });

type AccessorMap = Record<string, OmniJsAccessor>;

const TASK_ACCESSORS: AccessorMap = {
  id:                   e('_.id.primaryKey'),
  name:                 p('name'),
  note:                 p('note'),
  flagged:              p('flagged'),
  completed:            e('_.taskStatus === Task.Status.Completed'),
  dropped:              e('_.taskStatus === Task.Status.Dropped'),
  blocked:              e('_.taskStatus === Task.Status.Blocked'),
  effectivelyCompleted: e('_.taskStatus === Task.Status.Completed'),
  effectivelyDropped:   e('_.taskStatus === Task.Status.Dropped'),
  dueDate:              d('dueDate'),
  deferDate:            d('deferDate'),
  plannedDate:          d('plannedDate'),
  effectiveDueDate:     d('effectiveDueDate'),
  effectiveDeferDate:   d('effectiveDeferDate'),
  effectivePlannedDate: d('effectivePlannedDate'),
  completionDate:       d('completionDate'),
  modificationDate:     d('modified'),
  creationDate:         d('added'),
  estimatedMinutes:     p('estimatedMinutes'),
  sequential:           p('sequential'),
  inInbox:              p('inInbox'),
  hasChildren:          p('hasChildren'),
  childCount:           e('_.children.length'),
  // taskStatus/status: OmniJS enum → string mapping
  taskStatus:           e('_tsName(_.taskStatus)'),
  status:               e('_tsName(_.taskStatus)'),
  // Chain-like: containingProject
  projectName:          e('_.containingProject ? _.containingProject.name : null'),
  projectId:            e('_.containingProject ? _.containingProject.id.primaryKey : null'),
  // Parent task
  parentId:             e('_.parent ? _.parent.id.primaryKey : null'),
  // Tags (array of names)
  tags:                 e('_.tags.map(function(t){return t.name})'),
};

const PROJECT_ACCESSORS: AccessorMap = {
  id:                 e('_.id.primaryKey'),
  name:               p('name'),
  note:               p('note'),
  status:             e('_psName(_.status)'),
  flagged:            p('flagged'),
  completed:          e('_.status === Project.Status.Done'),
  dueDate:            d('dueDate'),
  deferDate:          d('deferDate'),
  effectiveDueDate:   d('effectiveDueDate'),
  effectiveDeferDate: d('effectiveDeferDate'),
  completionDate:     d('completionDate'),
  modificationDate:   d('modified'),
  creationDate:       d('added'),
  estimatedMinutes:   p('estimatedMinutes'),
  sequential:         p('sequential'),
  taskCount:          e('_.flattenedTasks.length'),
  activeTaskCount:    e('_.flattenedTasks.filter(function(t){return t.taskStatus===Task.Status.Available||t.taskStatus===Task.Status.Next}).length'),
  folderId:           e('_.parentFolder ? _.parentFolder.id.primaryKey : null'),
  folderName:         e('_.parentFolder ? _.parentFolder.name : null'),
};

const TAG_ACCESSORS: AccessorMap = {
  id:                 e('_.id.primaryKey'),
  name:               p('name'),
  note:               e('""'),  // Tags don't have notes in OmniJS — return empty
  allowsNextAction:   p('allowsNextAction'),
  hidden:             e('_.status !== Tag.Status.Active'),
  effectivelyHidden:  e('!_.effectiveActive'),
  availableTaskCount: e('_.availableTasks.length'),
  remainingTaskCount: e('_.remainingTasks.length'),
  parentId:           e('_.parent ? _.parent.id.primaryKey : null'),
  parentName:         e('_.parent ? _.parent.name : null'),
};

const FOLDER_ACCESSORS: AccessorMap = {
  id:              e('_.id.primaryKey'),
  name:            p('name'),
  hidden:          e('_.status === Folder.Status.Dropped'),
  status:          e('_.status === Folder.Status.Dropped ? "Dropped" : "Active"'),
  parentFolderId:  e('_.parent ? _.parent.id.primaryKey : null'),
  projectCount:    e('_.flattenedProjects.length'),
};

const ACCESSOR_MAP: Record<string, AccessorMap> = {
  tasks:    TASK_ACCESSORS,
  projects: PROJECT_ACCESSORS,
  folders:  FOLDER_ACCESSORS,
  tags:     TAG_ACCESSORS,
};

// ── Script generation ─────────────────────────────────────────────────────

/**
 * Build the OmniJS expression for a single column accessor.
 * Returns a JS expression string that, given `_` as the object,
 * produces a JSON-safe value.
 */
function accessorExpr(accessor: OmniJsAccessor): string {
  switch (accessor.kind) {
    case 'prop':
      return accessor.expr;
    case 'date':
      return `(${accessor.expr} ? ${accessor.expr}.toISOString() : null)`;
    case 'expr':
      return accessor.expr;
  }
}

/**
 * Generate the OmniJS script body that fetches columns for a set of IDs.
 *
 * The generated script:
 * 1. Defines enum-name helper functions (taskStatus, project status)
 * 2. Iterates over the ID array
 * 3. For each ID, calls Entity.byIdentifier(id)
 * 4. Reads the requested columns
 * 5. Returns JSON.stringify(results)
 *
 * Exported for testing — not part of the public API.
 */
export function generateEnrichScript(
  entity: EntityType,
  ids: string[],
  columns: string[],
): string {
  const className = OMNIJS_CLASS[entity];
  if (!className) {
    throw new Error(`omniJsEnrich: unsupported entity '${entity}'`);
  }

  const accessors = ACCESSOR_MAP[entity];
  if (!accessors) {
    throw new Error(`omniJsEnrich: no accessor map for entity '${entity}'`);
  }

  // Validate all requested columns have accessors
  const missing = columns.filter(c => !accessors[c]);
  if (missing.length > 0) {
    throw new Error(
      `omniJsEnrich: no OmniJS accessor for ${entity} columns: ${missing.join(', ')}`
    );
  }

  // Build the property extraction fragment for each column
  const propLines = columns.map(col => {
    const expr = accessorExpr(accessors[col]);
    return `      ${JSON.stringify(col)}: ${expr}`;
  });

  // Task status enum → string helper
  const taskStatusHelper = `
function _tsName(s) {
  if (s === Task.Status.Completed) return "Completed";
  if (s === Task.Status.Dropped)   return "Dropped";
  if (s === Task.Status.Blocked)   return "Blocked";
  if (s === Task.Status.Overdue)   return "Overdue";
  if (s === Task.Status.DueSoon)   return "DueSoon";
  if (s === Task.Status.Next)      return "Next";
  if (s === Task.Status.Available) return "Available";
  return "Unknown";
}`;

  // Project status enum → string helper
  const projectStatusHelper = `
function _psName(s) {
  if (s === Project.Status.Active)  return "Active";
  if (s === Project.Status.OnHold)  return "OnHold";
  if (s === Project.Status.Done)    return "Done";
  if (s === Project.Status.Dropped) return "Dropped";
  return "Unknown";
}`;

  // Include helpers only when needed
  const needsTaskStatus = columns.some(c => {
    const a = accessors[c];
    return a.kind === 'expr' && a.expr.includes('_tsName');
  });
  const needsProjectStatus = columns.some(c => {
    const a = accessors[c];
    return a.kind === 'expr' && a.expr.includes('_psName');
  });

  const helpers: string[] = [];
  if (needsTaskStatus)    helpers.push(taskStatusHelper);
  if (needsProjectStatus) helpers.push(projectStatusHelper);

  const idsJson = JSON.stringify(ids);

  return `(function() {
${helpers.join('\n')}
  var _ids = ${idsJson};
  var _out = [];
  for (var _i = 0; _i < _ids.length; _i++) {
    var _ = ${className}.byIdentifier(_ids[_i]);
    if (!_) { _out.push(null); continue; }
    _out.push({
${propLines.join(',\n')}
    });
  }
  return JSON.stringify(_out);
})()`;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Enrich a set of IDs with output columns via OmniJS byIdentifier().
 *
 * Returns rows in the same order as the input IDs. If an ID is not found
 * (deleted between filter and enrich), the corresponding row is null.
 *
 * @param entity  - Entity type to look up
 * @param ids     - Array of primary key strings
 * @param columns - Column names to read (from the internal var registry)
 * @returns Row[] aligned with the input ID array (nulls for not-found items)
 */
export async function enrichByIdentifier(
  entity: EntityType,
  ids: string[],
  columns: string[],
): Promise<(Row | null)[]> {
  if (ids.length === 0) return [];

  // Always include 'id' in the output for downstream join/merge operations
  const colSet = new Set(columns);
  colSet.add('id');
  const allColumns = [...colSet];

  const omniJsScript = generateEnrichScript(entity, ids, allColumns);

  // Wrap the OmniJS script in a JXA evaluateJavascript call
  const jxaScript = `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  return app.evaluateJavascript(${JSON.stringify(omniJsScript)});
})()`;

  const result = await executeJXA(jxaScript);

  // Result is an array aligned with the input IDs
  if (!Array.isArray(result)) {
    throw new Error('omniJsEnrich: OmniJS script did not return an array');
  }

  return result as (Row | null)[];
}

/**
 * Check whether a column can be enriched via OmniJS for a given entity.
 */
export function canEnrichColumn(entity: EntityType, column: string): boolean {
  return !!ACCESSOR_MAP[entity]?.[column];
}

/**
 * Get the list of columns that can be enriched for a given entity.
 */
export function enrichableColumns(entity: EntityType): string[] {
  const map = ACCESSOR_MAP[entity];
  return map ? Object.keys(map) : [];
}
