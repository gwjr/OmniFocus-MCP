/**
 * Apple Events property and class-code tables.
 *
 * Shared between lowerSetIrToEventPlan and any other EventPlan-producing code.
 * Extracted from strategyToEventPlan.ts to avoid a dependency on the legacy
 * StrategyNode pipeline.
 */

import type { FourCC } from './eventPlan.js';
import type { EntityType } from './variables.js';
import { OFClass, OFTaskProp, OFProjectProp, OFFolderProp, OFTagProp } from '../../generated/omnifocus-sdef.js';

// ── Entity → class code ───────────────────────────────────────────────────

const ENTITY_CLASS_CODE: Record<string, FourCC> = {
  tasks:    OFClass.flattenedTask,
  projects: OFClass.flattenedProject,
  folders:  OFClass.flattenedFolder,
  tags:     OFClass.flattenedTag,
};

export function classCode(entity: EntityType): FourCC {
  const code = ENTITY_CLASS_CODE[entity];
  if (!code) throw new Error(`No class code for entity: ${entity}`);
  return code;
}

// ── Variable → property specifier ─────────────────────────────────────────
//
// Two shapes:
//   • Simple:  { kind: 'simple', code: FourCC }
//     → Get(Property(elements, code))  e.g. .name()
//   • Chain:   { kind: 'chain', relation: FourCC, terminal: FourCC }
//     → Get(Property(Property(elements, relation), terminal))  e.g. .containingProject.name()

export type PropSpec =
  | { kind: 'simple'; code: FourCC }
  | { kind: 'chain';  relation: FourCC; terminal: FourCC };

/** Simple property tables — direct bulk-readable AE properties. */
const SIMPLE_PROPS: Record<string, Record<string, FourCC>> = {
  tasks: {
    id:                   OFTaskProp.id,
    name:                 OFTaskProp.name,
    flagged:              OFTaskProp.flagged,
    dueDate:              OFTaskProp.dueDate,
    deferDate:            OFTaskProp.deferDate,
    plannedDate:          OFTaskProp.plannedDate,
    effectiveDueDate:     OFTaskProp.effectiveDueDate,
    effectiveDeferDate:   OFTaskProp.effectiveDeferDate,
    effectivePlannedDate: OFTaskProp.effectivePlannedDate,
    completed:            OFTaskProp.completed,
    effectivelyCompleted: OFTaskProp.effectivelyCompleted,
    dropped:              OFTaskProp.dropped,
    effectivelyDropped:   OFTaskProp.effectivelyDropped,
    blocked:              OFTaskProp.blocked,
    inInbox:              OFTaskProp.inInbox,
    sequential:           OFTaskProp.sequential,
    estimatedMinutes:     OFTaskProp.estimatedMinutes,
    note:                 OFTaskProp.note,
    numberOfTasks:        OFTaskProp.numberOfTasks,
    tags:                 OFTaskProp.tags,
    creationDate:         OFTaskProp.creationDate,
    modificationDate:     OFTaskProp.modificationDate,
    completionDate:       OFTaskProp.completionDate,
  },
  projects: {
    id:                   OFProjectProp.id,
    name:                 OFProjectProp.name,
    status:               OFProjectProp.effectiveStatus,
    flagged:              OFProjectProp.flagged,
    dueDate:              OFProjectProp.dueDate,
    deferDate:            OFProjectProp.deferDate,
    effectiveDueDate:     OFProjectProp.effectiveDueDate,
    effectiveDeferDate:   OFProjectProp.effectiveDeferDate,
    completed:            OFProjectProp.completed,
    dropped:              OFProjectProp.dropped,
    sequential:           OFProjectProp.sequential,
    estimatedMinutes:     OFProjectProp.estimatedMinutes,
    note:                 OFProjectProp.note,
    numberOfTasks:        OFProjectProp.numberOfTasks,
    activeTaskCount:      OFProjectProp.numberOfAvailableTasks,
    tags:                 OFProjectProp.tags,
    creationDate:         OFProjectProp.creationDate,
    modificationDate:     OFProjectProp.modificationDate,
    completionDate:       OFProjectProp.completionDate,
  },
  folders: {
    id:     OFFolderProp.id,
    name:   OFFolderProp.name,
    hidden: OFFolderProp.hidden,
    effectivelyHidden: OFFolderProp.effectivelyHidden,
    note:   OFFolderProp.note,
  },
  tags: {
    id:                 OFTagProp.id,
    name:               OFTagProp.name,
    allowsNextAction:   OFTagProp.allowsNextAction,
    hidden:             OFTagProp.hidden,
    effectivelyHidden:  OFTagProp.effectivelyHidden,
    availableTaskCount: OFTagProp.availableTaskCount,
    remainingTaskCount: OFTagProp.remainingTaskCount,
  },
};

/**
 * Chain property table — properties that require chained AE specifiers.
 * e.g. `folderId` → `.container.id()` → Property(Property(elems, container), id)
 *
 * Fields:
 *   relation  — AE property code for the intermediate relation
 *   terminal  — AE property code for the terminal value
 *   refersTo  — Entity this column points to (FK annotation for getChildToParentFk).
 *               Only set on chain props that read an id.
 *   isArray   — True when the relation is to-many (result is a nested array, e.g. tags.id()).
 */
interface ChainProp {
  relation: FourCC;
  terminal: FourCC;
  refersTo?: EntityType;
  isArray?: boolean;
}

const CHAIN_PROPS: Record<string, Record<string, ChainProp>> = {
  tasks: {
    projectName: { relation: OFTaskProp.containingProject, terminal: OFTaskProp.name },
    projectId:   { relation: OFTaskProp.containingProject, terminal: OFTaskProp.id,  refersTo: 'projects' },
    parentId:    { relation: OFTaskProp.parentTask,         terminal: OFTaskProp.id,  refersTo: 'tasks'    },
    // task.tags.id() — bulk nested-array read: [['tagId1','tagId2'], [], ...] aligned with tasks
    tagIds:      { relation: OFTaskProp.tags,               terminal: OFTagProp.id,  refersTo: 'tags', isArray: true },
  },
  projects: {
    folderId:   { relation: OFProjectProp.container, terminal: OFProjectProp.id,   refersTo: 'folders' },
    folderName: { relation: OFProjectProp.container, terminal: OFProjectProp.name },
  },
  folders: {
    parentFolderId: { relation: OFFolderProp.container, terminal: OFFolderProp.id },
  },
  tags: {
    parentId:   { relation: OFTagProp.container, terminal: OFTagProp.id },
    parentName: { relation: OFTagProp.container, terminal: OFTagProp.name },
  },
};

/** Resolve a variable name to a PropSpec (simple or chain). */
export function propSpec(entity: EntityType, varName: string): PropSpec {
  // Check chain properties first (more specific)
  const chainTable = CHAIN_PROPS[entity];
  if (chainTable && chainTable[varName]) {
    const { relation, terminal } = chainTable[varName];
    return { kind: 'chain', relation, terminal };
  }

  // Check simple properties
  const simpleTable = SIMPLE_PROPS[entity];
  if (simpleTable && simpleTable[varName]) {
    return { kind: 'simple', code: simpleTable[varName] };
  }

  // Aliases for nodeKey → propCode (e.g. taskCount → numberOfTasks)
  if (entity === 'projects' && varName === 'taskCount') return { kind: 'simple', code: OFProjectProp.numberOfTasks };
  if (entity === 'tasks' && varName === 'childCount') return { kind: 'simple', code: OFTaskProp.numberOfTasks };

  throw new Error(`No property spec for ${entity}.${varName}`);
}

/**
 * Look up the FK column in `childEntity` that points to `parentEntity`.
 *
 * Searches CHAIN_PROPS[childEntity] for the first entry with refersTo === parentEntity.
 * Returns { fkColumn, isArray } or null if no FK relationship exists.
 *
 * Used by lowerToSetIr to build containing() restrictions generically.
 */
export function getChildToParentFk(
  childEntity: EntityType,
  parentEntity: EntityType,
): { fkColumn: string; isArray: boolean } | null {
  const chainTable = CHAIN_PROPS[childEntity];
  if (!chainTable) return null;
  for (const [colName, entry] of Object.entries(chainTable)) {
    if (entry.refersTo === parentEntity) {
      return { fkColumn: colName, isArray: entry.isArray ?? false };
    }
  }
  return null;
}
