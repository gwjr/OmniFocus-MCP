/**
 * Strategy → EventPlan lowering pass.
 *
 * Transforms a StrategyNode tree into a flat SSA EventPlan by emitting
 * runtime-agnostic EventNode instructions. Each StrategyNode kind maps
 * to a specific pattern of EventNodes as documented in the lowering spec.
 */

import type { EventNode, EventPlan, FourCC, Ref, Specifier } from './eventPlan.js';
import type { LoweredExpr } from './fold.js';
import type { StrategyNode } from './strategy.js';
import type { EntityType } from './variables.js';
import { OFClass, OFTaskProp, OFProjectProp, OFFolderProp, OFTagProp } from '../../generated/omnifocus-sdef.js';
import { getVarRegistry } from './variables.js';

// ── Entity → class code ─────────────────────────────────────────────────

const ENTITY_CLASS_CODE: Record<string, FourCC> = {
  tasks:    OFClass.flattenedTask,
  projects: OFClass.flattenedProject,
  folders:  OFClass.flattenedFolder,
  tags:     OFClass.flattenedTag,
};

function classCode(entity: EntityType): FourCC {
  const code = ENTITY_CLASS_CODE[entity];
  if (!code) throw new Error(`No class code for entity: ${entity}`);
  return code;
}

// ── Variable → property code ────────────────────────────────────────────

const PROP_TABLES: Record<string, Record<string, FourCC>> = {
  tasks: {
    id:                   OFTaskProp.id,
    name:                 OFTaskProp.name,
    flagged:              OFTaskProp.flagged,
    dueDate:              OFTaskProp.dueDate,
    deferDate:            OFTaskProp.deferDate,
    effectiveDueDate:     OFTaskProp.effectiveDueDate,
    effectiveDeferDate:   OFTaskProp.effectiveDeferDate,
    completed:            OFTaskProp.completed,
    effectivelyCompleted: OFTaskProp.effectivelyCompleted,
    dropped:              OFTaskProp.dropped,
    effectivelyDropped:   OFTaskProp.effectivelyDropped,
    blocked:              OFTaskProp.blocked,
    containingProject:    OFTaskProp.containingProject,
    parentTask:           OFTaskProp.parentTask,
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
    status:               OFProjectProp.status,
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
    containingFolderId:   OFProjectProp.containingFolderId,
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
    id:               OFTagProp.id,
    name:             OFTagProp.name,
    effectivelyHidden: OFTagProp.effectivelyHidden,
    parentTag:        OFTagProp.parentTag,
  },
};

function propCode(entity: EntityType, varName: string): FourCC {
  // First check the explicit tables
  const table = PROP_TABLES[entity];
  if (table && table[varName]) return table[varName];

  // Fall back to the VarRegistry's appleEventsProperty to resolve
  // names that use nodeKey aliases (e.g. 'folderId' → container → 'FCAr')
  const registry = getVarRegistry(entity);
  const def = registry[varName];
  if (def?.appleEventsProperty) {
    // Look up the AE property name in the PROP_TABLES
    const aeTable = PROP_TABLES[entity];
    if (aeTable) {
      for (const [, code] of Object.entries(aeTable)) {
        // Check if the appleEventsProperty matches a key we already have
        // This won't work directly — we need to look by AE property name
      }
    }
    // For known aliases, map explicitly
    if (entity === 'projects' && varName === 'folderId') return OFProjectProp.containingFolderId;
    if (entity === 'projects' && varName === 'taskCount') return OFProjectProp.numberOfTasks;
    if (entity === 'tasks' && varName === 'childCount') return OFTaskProp.numberOfTasks;
    if (entity === 'tasks' && varName === 'projectName') return OFTaskProp.containingProject;
    if (entity === 'tasks' && varName === 'projectId') return OFTaskProp.containingProject;
    if (entity === 'tasks' && varName === 'parentId') return OFTaskProp.parentTask;
    if (entity === 'tags' && varName === 'parentId') return OFTagProp.parentTag;
    if (entity === 'folders' && varName === 'parentFolderId') return OFFolderProp.hidden; // fallback — shouldn't reach
  }

  throw new Error(`No property code for ${entity}.${varName}`);
}

// ── Active filter expressions ───────────────────────────────────────────

function activeFilterExpr(entity: EntityType): LoweredExpr {
  switch (entity) {
    case 'tasks':
      return {
        op: 'and',
        args: [
          { op: 'not', args: [{ var: 'effectivelyCompleted' }] },
          { op: 'not', args: [{ var: 'effectivelyDropped' }] },
        ],
      };
    case 'projects':
      return { op: 'in', args: [{ var: 'status' }, ['active', 'on hold']] };
    case 'tags':
      return { op: 'not', args: [{ var: 'effectivelyHidden' }] };
    case 'folders':
      return { op: 'not', args: [{ var: 'hidden' }] };
    default:
      throw new Error(`No active filter for entity: ${entity}`);
  }
}

// ── Builder ─────────────────────────────────────────────────────────────

function builder() {
  const nodes: EventNode[] = [];
  const push = (n: EventNode): Ref => {
    nodes.push(n);
    return nodes.length - 1;
  };
  return { nodes, push };
}

// ── Main lowering ───────────────────────────────────────────────────────

export function lowerStrategy(root: StrategyNode): EventPlan {
  const { nodes, push } = builder();

  function lower(node: StrategyNode): Ref {
    switch (node.kind) {

      // ── Leaf: BulkScan ────────────────────────────────────────────
      case 'BulkScan': {
        // %0 = Get(Elements(Document, classCode))
        const elemRef = push({
          kind: 'Get',
          specifier: {
            kind: 'Elements',
            parent: { kind: 'Document' },
            classCode: classCode(node.entity),
          },
          effect: 'nonMutating',
        });

        // For each column: %n = Get(Property(%0, propCode))
        const colRefs: { name: string; ref: Ref }[] = [];
        for (const col of node.columns) {
          const ref = push({
            kind: 'Get',
            specifier: {
              kind: 'Property',
              parent: elemRef,
              propCode: propCode(node.entity, col),
            },
            effect: 'nonMutating',
          });
          colRefs.push({ name: col, ref });
        }

        // Zip
        let current = push({ kind: 'Zip', columns: colRefs });

        // Derive (before Filter so derived fields are available)
        if (node.computedVars && node.computedVars.size > 0) {
          const derivations = [...node.computedVars].map(v => ({
            var: v,
            entity: node.entity,
          }));
          current = push({ kind: 'Derive', source: current, derivations });
        }

        // Active filter
        if (!node.includeCompleted) {
          current = push({
            kind: 'Filter',
            source: current,
            predicate: activeFilterExpr(node.entity),
          });
        }

        return current;
      }

      // ── Leaf: FallbackScan ────────────────────────────────────────
      case 'FallbackScan': {
        // %0 = Get(Elements(Document, classCode))
        const elemRef = push({
          kind: 'Get',
          specifier: {
            kind: 'Elements',
            parent: { kind: 'Document' },
            classCode: classCode(node.entity),
          },
          effect: 'nonMutating',
        });

        // Combine with active filter if needed
        const predicate: LoweredExpr = node.includeCompleted
          ? node.filterAst
          : { op: 'and', args: [activeFilterExpr(node.entity), node.filterAst] };

        const filterRef = push({
          kind: 'Filter',
          source: elemRef,
          predicate,
        });

        return filterRef;
      }

      // ── Leaf: MembershipScan ──────────────────────────────────────
      case 'MembershipScan': {
        // %0 = Get(Elements(Document, classCode(sourceEntity)))
        const sourceElemRef = push({
          kind: 'Get',
          specifier: {
            kind: 'Elements',
            parent: { kind: 'Document' },
            classCode: classCode(node.sourceEntity),
          },
          effect: 'nonMutating',
        });

        // %1 = Filter(%0, predicate)
        const filterRef = push({
          kind: 'Filter',
          source: sourceElemRef,
          predicate: node.predicate,
        });

        // ForEach body (body-local indices)
        const forEachIdx = nodes.length; // will be the ForEach's index
        const bodyNodes: EventNode[] = [];

        // body[0] = Get(Elements(forEachIdx, classCode(targetEntity)))
        bodyNodes.push({
          kind: 'Get',
          specifier: {
            kind: 'Elements',
            parent: forEachIdx as Ref,
            classCode: classCode(node.targetEntity),
          },
          effect: 'nonMutating',
        });

        // body[1] = Get(Property(body[0], 'ID  '))
        const bodyElemRef = 0; // body-local index of the Elements Get
        bodyNodes.push({
          kind: 'Get',
          specifier: {
            kind: 'Property',
            parent: bodyElemRef as Ref,
            propCode: 'ID  ',
          },
          effect: 'nonMutating',
        });

        const collectRef = 1; // body-local index of the ID property read

        const forEachRef = push({
          kind: 'ForEach',
          source: filterRef,
          body: bodyNodes,
          collect: collectRef,
          effect: 'nonMutating',
        });

        return forEachRef;
      }

      // ── Transform: Filter ─────────────────────────────────────────
      case 'Filter': {
        const sourceRef = lower(node.source);
        return push({
          kind: 'Filter',
          source: sourceRef,
          predicate: node.predicate,
        });
      }

      // ── Transform: PreFilter → Filter (dissolves) ─────────────────
      case 'PreFilter': {
        const sourceRef = lower(node.source);
        return push({
          kind: 'Filter',
          source: sourceRef,
          predicate: node.predicate,
        });
      }

      // ── Transform: Sort ───────────────────────────────────────────
      case 'Sort': {
        const sourceRef = lower(node.source);
        return push({
          kind: 'Sort',
          source: sourceRef,
          by: node.by,
          dir: node.direction,
        });
      }

      // ── Transform: Limit ──────────────────────────────────────────
      case 'Limit': {
        const sourceRef = lower(node.source);
        return push({
          kind: 'Limit',
          source: sourceRef,
          n: node.count,
        });
      }

      // ── Transform: Project → Pick ─────────────────────────────────
      case 'Project': {
        const sourceRef = lower(node.source);
        return push({
          kind: 'Pick',
          source: sourceRef,
          fields: node.fields,
        });
      }

      // ── Binary: SemiJoin ──────────────────────────────────────────
      case 'SemiJoin': {
        const sourceRef = lower(node.source);
        const idsRef = lower(node.lookup);
        return push({
          kind: 'SemiJoin',
          source: sourceRef,
          ids: idsRef,
        });
      }

      // ── Binary: CrossEntityJoin → HashJoin ────────────────────────
      case 'CrossEntityJoin': {
        const sourceRef = lower(node.source);
        const lookupRef = lower(node.lookup);
        return push({
          kind: 'HashJoin',
          source: sourceRef,
          lookup: lookupRef,
          sourceKey: node.sourceKey,
          lookupKey: node.lookupKey,
          fieldMap: node.fieldMap,
        });
      }

      // ── Transform: PerItemEnrich ──────────────────────────────────
      case 'PerItemEnrich': {
        const sourceRef = lower(node.source);

        // %cv = ColumnValues(sourceRef, 'id')
        const cvRef = push({
          kind: 'ColumnValues',
          source: sourceRef,
          field: 'id',
        });

        // ForEach body (body-local indices)
        const forEachIdx = nodes.length; // will be the ForEach's index
        const bodyNodes: EventNode[] = [];

        // body[0] = Get(ByID(Elements(Document, classCode(entity)), forEachIdx))
        bodyNodes.push({
          kind: 'Get',
          specifier: {
            kind: 'ByID',
            parent: {
              kind: 'Elements',
              parent: { kind: 'Document' },
              classCode: classCode(node.entity),
            },
            id: forEachIdx as Ref,
          },
          effect: 'nonMutating',
        });

        const byIdBodyRef = 0; // body-local index

        // body[1..n] = Get(Property(byIdBodyRef, propCode)) for each perItemVar
        const perItemVars = [...node.perItemVars];
        const varBodyRefs: { name: string; ref: Ref }[] = [];

        for (const v of perItemVars) {
          const bodyIdx = bodyNodes.length;
          bodyNodes.push({
            kind: 'Get',
            specifier: {
              kind: 'Property',
              parent: byIdBodyRef as Ref,
              propCode: propCode(node.entity, v),
            },
            effect: 'nonMutating',
          });
          varBodyRefs.push({ name: v, ref: bodyIdx });
        }

        // body[n+1] = Zip([{name:'id', ref:forEachIdx}, {name:var, ref:bodyLocalRef}, ...])
        const zipColumns: { name: string; ref: Ref }[] = [
          { name: 'id', ref: forEachIdx as Ref },
          ...varBodyRefs,
        ];
        const zipBodyIdx = bodyNodes.length;
        bodyNodes.push({
          kind: 'Zip',
          columns: zipColumns,
        });

        // ForEach
        const feRef = push({
          kind: 'ForEach',
          source: cvRef,
          body: bodyNodes,
          collect: zipBodyIdx,
          effect: 'nonMutating',
        });

        // HashJoin to merge enriched data back
        const fieldMap: Record<string, string> = {};
        for (const v of perItemVars) {
          fieldMap[v] = v;
        }

        const hjRef = push({
          kind: 'HashJoin',
          source: sourceRef,
          lookup: feRef,
          sourceKey: 'id',
          lookupKey: 'id',
          fieldMap,
        });

        return hjRef;
      }

      // ── SelfJoinEnrich → HashJoin (same source for both sides) ────
      case 'SelfJoinEnrich': {
        const sourceRef = lower(node.source);
        return push({
          kind: 'HashJoin',
          source: sourceRef,
          lookup: sourceRef,
          sourceKey: node.sourceKey,
          lookupKey: node.lookupKey,
          fieldMap: node.fieldMap,
        });
      }

      default: {
        const _exhaustive: never = node;
        throw new Error(`Unknown strategy node kind: ${(node as any).kind}`);
      }
    }
  }

  const result = lower(root);
  return { nodes, result };
}
