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
import { collectVarsFromAst } from './backends/varCollector.js';

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

// ── Variable → property specifier ────────────────────────────────────────
//
// Two shapes:
//   • Simple:  { kind: 'simple', code: FourCC }
//     → Get(Property(elements, code))  e.g. .name()
//   • Chain:   { kind: 'chain', relation: FourCC, terminal: FourCC }
//     → Get(Property(Property(elements, relation), terminal))  e.g. .containingProject.name()

type PropSpec =
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
 */
const CHAIN_PROPS: Record<string, Record<string, { relation: FourCC; terminal: FourCC }>> = {
  tasks: {
    projectName: { relation: OFTaskProp.containingProject, terminal: OFTaskProp.name },
    projectId:   { relation: OFTaskProp.containingProject, terminal: OFTaskProp.id },
    parentId:    { relation: OFTaskProp.parentTask,         terminal: OFTaskProp.id },
  },
  projects: {
    folderId:  { relation: OFProjectProp.container, terminal: OFProjectProp.id },
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
function propSpec(entity: EntityType, varName: string): PropSpec {
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

/** Backward-compatible: resolve to a single FourCC for per-item property reads. */
function propCode(entity: EntityType, varName: string): FourCC {
  const spec = propSpec(entity, varName);
  if (spec.kind === 'simple') return spec.code;
  // For chain props in per-item context, return the relation code —
  // the terminal is read separately via a second specifier.
  return spec.relation;
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
      return { op: 'in', args: [{ var: 'status' }, ['Active', 'OnHold']] };
    case 'tags':
      return { op: 'not', args: [{ var: 'effectivelyHidden' }] };
    case 'folders':
      return true;   // Legacy has no folder active filter; pass through
    default:
      throw new Error(`No active filter for entity: ${entity}`);
  }
}

/** Variable names referenced by the active filter for a given entity. */
function activeFilterVars(entity: EntityType): string[] {
  switch (entity) {
    case 'tasks':    return ['effectivelyCompleted', 'effectivelyDropped'];
    case 'projects': return ['status'];
    case 'tags':     return ['effectivelyHidden'];
    case 'folders':  return [];          // No folder active filter
    default:         return [];
  }
}

// ── Project scope helper ─────────────────────────────────────────────────

/**
 * Parse a project scope predicate (from the planner's extractContainerScope)
 * into a match type and value string.
 *
 * Valid shapes (the only ones canCompileScope allows):
 *   { op: 'eq',       args: [{ op: 'var', args: ['name'] }, 'exact name'] }
 *   { op: 'contains', args: [{ op: 'var', args: ['name'] }, 'partial'] }
 */
function parseScopeExpr(scope: LoweredExpr): { match: 'eq' | 'contains'; value: string } {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw new Error('strategyToEventPlan: invalid projectScope — expected AST node');
  }
  const node = scope as { op: string; args: LoweredExpr[] };
  if (node.op === 'eq' || node.op === 'contains') {
    const value = node.args[1];
    if (typeof value === 'string') {
      return { match: node.op as 'eq' | 'contains', value };
    }
  }
  throw new Error(`strategyToEventPlan: unsupported projectScope op '${node.op}'`);
}

/**
 * Emit a single EventPlan Get node for a project-scoped task collection:
 *   flattenedProjects.whose({name: ...})[0].flattenedTasks
 *
 * The entire chain is encoded as a nested specifier so the JXA emitter
 * produces a single expression — no intermediate Get() materializations
 * that would break the AE reference chain.
 *
 * Returns the Ref for the task elements collection.
 */
function emitProjectScopedElements(
  push: (n: EventNode) => Ref,
  scope: LoweredExpr,
): Ref {
  const { match, value } = parseScopeExpr(scope);

  // Nested specifier:
  //   Elements(
  //     ByIndex(
  //       Whose(
  //         Elements(Document, flattenedProject),
  //         pnam, eq|contains, "value"
  //       ),
  //       0
  //     ),
  //     flattenedTask
  //   )
  return push({
    kind: 'Get',
    specifier: {
      kind: 'Elements',
      parent: {
        kind: 'ByIndex',
        parent: {
          kind: 'Whose',
          parent: {
            kind: 'Elements',
            parent: { kind: 'Document' },
            classCode: classCode('projects'),
          },
          prop: OFProjectProp.name,
          match,
          value,
        },
        index: 0,
      },
      classCode: classCode('tasks'),
    },
    effect: 'nonMutating',
  });
}

// ── Reverse MembershipScan (child→parent for "containing") ──────────────

/**
 * Mapping from (childEntity, parentEntity) to the chain property on the
 * child entity that yields the parent's ID.
 */
const REVERSE_MEMBERSHIP: Record<string, Record<string, string>> = {
  tasks:    { projects: 'projectId' },    // containingProject.id()
  projects: { folders:  'folderId' },     // container.id()
};

/**
 * Check if a MembershipScan represents a reverse (containing) direction.
 */
function isReverseMembershipScan(sourceEntity: EntityType, targetEntity: EntityType): boolean {
  return !!REVERSE_MEMBERSHIP[sourceEntity]?.[targetEntity];
}

/**
 * Lower a reverse MembershipScan into EventPlan nodes.
 *
 * Strategy: bulk-read child entities, filter by child predicate, collect
 * parent IDs via chain property, return as flat ID array for SemiJoin.
 *
 * Produces:
 *   %0 = Get(Elements(Document, childClassCode))  — all child entities
 *   %1..n = Get(Property(%0, ...))                 — columns for predicate + parent ID
 *   %zip = Zip(columns)
 *   %active = Filter(zip, activeFilter)            — exclude completed/dropped
 *   %filtered = Filter(active, predicate)          — apply child predicate
 *   %parentIds = ColumnValues(filtered, parentIdColumn)
 *   return %parentIds
 */
function lowerReverseMembershipScan(
  node: import('./strategy.js').MembershipScan,
  push: (n: EventNode) => Ref,
  nodes: EventNode[],
): Ref {
  const childEntity = node.sourceEntity;
  const parentEntity = node.targetEntity;
  const parentIdColumn = REVERSE_MEMBERSHIP[childEntity]?.[parentEntity];
  if (!parentIdColumn) {
    throw new Error(`No reverse membership relationship: ${childEntity} → ${parentEntity}`);
  }

  // Collect variables referenced by the child predicate
  const predicateVars = collectVarsFromAst(node.predicate, childEntity);

  // Build the column set: predicate vars + parent ID chain property
  const varNames = new Set<string>();
  for (const v of predicateVars) {
    if (v === 'now') continue;
    varNames.add(v);
  }
  varNames.add(parentIdColumn);

  // Add active filter vars
  if (!node.includeCompleted) {
    for (const v of activeFilterVars(childEntity)) {
      varNames.add(v);
    }
  }

  // Emit Elements(Document, childClassCode)
  const elemRef = push({
    kind: 'Get',
    specifier: {
      kind: 'Elements',
      parent: { kind: 'Document' },
      classCode: classCode(childEntity),
    },
    effect: 'nonMutating',
  });

  // Emit property reads for each column
  const colRefs: { name: string; ref: Ref }[] = [];
  for (const varName of varNames) {
    const spec = propSpec(childEntity, varName);
    let ref: Ref;
    if (spec.kind === 'simple') {
      ref = push({
        kind: 'Get',
        specifier: {
          kind: 'Property',
          parent: elemRef,
          propCode: spec.code,
        },
        effect: 'nonMutating',
      });
    } else {
      // Chain property (e.g. containingProject.id(), container.id())
      ref = push({
        kind: 'Get',
        specifier: {
          kind: 'Property',
          parent: {
            kind: 'Property',
            parent: elemRef,
            propCode: spec.relation,
          },
          propCode: spec.terminal,
        },
        effect: 'nonMutating',
      });
    }
    colRefs.push({ name: varName, ref });
  }

  // Zip
  let current = push({ kind: 'Zip', columns: colRefs });

  // Active filter
  if (!node.includeCompleted) {
    const activePred = activeFilterExpr(childEntity);
    if (activePred !== true) {
      current = push({
        kind: 'Filter',
        source: current,
        predicate: activePred,
        entity: childEntity,
      });
    }
  }

  // Filter by child predicate
  current = push({
    kind: 'Filter',
    source: current,
    predicate: node.predicate,
    entity: childEntity,
  });

  // Extract parent IDs from filtered rows
  current = push({
    kind: 'ColumnValues',
    source: current,
    field: parentIdColumn,
  });

  return current;
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
        // Build the elements specifier — either broad or project-scoped
        let elemRef: Ref;
        if (node.projectScope && node.entity === 'tasks') {
          // Project-scoped: flattenedProjects.whose({name:...})[0].flattenedTasks
          elemRef = emitProjectScopedElements(push, node.projectScope);
        } else {
          // Broad: Elements(Document, classCode)
          elemRef = push({
            kind: 'Get',
            specifier: {
              kind: 'Elements',
              parent: { kind: 'Document' },
              classCode: classCode(node.entity),
            },
            effect: 'nonMutating',
          });
        }

        // Inject active-filter variables into columns if not already present
        const colSet = new Set(node.columns);
        const allColumns = [...node.columns];
        if (!node.includeCompleted) {
          for (const v of activeFilterVars(node.entity)) {
            if (!colSet.has(v)) {
              allColumns.push(v);
            }
          }
        }

        // Tasks need id for project-exclusion anti-join
        if (node.entity === 'tasks' && !colSet.has('id')) {
          allColumns.push('id');
        }

        // For each column: emit Get(Property) or Get(Property(Property)) for chains
        const colRefs: { name: string; ref: Ref }[] = [];
        for (const col of allColumns) {
          const spec = propSpec(node.entity, col);
          let ref: Ref;
          if (spec.kind === 'simple') {
            ref = push({
              kind: 'Get',
              specifier: {
                kind: 'Property',
                parent: elemRef,
                propCode: spec.code,
              },
              effect: 'nonMutating',
            });
          } else {
            // Chain: Property(Property(elements, relation), terminal)
            // e.g. .containingProject.name() or .container.id()
            ref = push({
              kind: 'Get',
              specifier: {
                kind: 'Property',
                parent: {
                  kind: 'Property',
                  parent: elemRef,
                  propCode: spec.relation,
                },
                propCode: spec.terminal,
              },
              effect: 'nonMutating',
            });
          }
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

        // Active filter (if entity has one)
        if (!node.includeCompleted) {
          const activePred = activeFilterExpr(node.entity);
          if (activePred !== true) {
            current = push({
              kind: 'Filter',
              source: current,
              predicate: activePred,
              entity: node.entity,
            });
          }
        }

        // Task entity: exclude project root tasks (projects ARE tasks in
        // flattenedTasks — subtract flattenedProjects IDs to get pure tasks)
        if (node.entity === 'tasks') {
          // %projElems = Get(Elements(Document, flattenedProject))
          const projElemRef = push({
            kind: 'Get',
            specifier: {
              kind: 'Elements',
              parent: { kind: 'Document' },
              classCode: classCode('projects'),
            },
            effect: 'nonMutating',
          });

          // %projIds = Get(Property(projElems, id))
          const projIdsRef = push({
            kind: 'Get',
            specifier: {
              kind: 'Property',
              parent: projElemRef,
              propCode: 'ID  ',
            },
            effect: 'nonMutating',
          });

          // Anti-semi-join: exclude rows whose id is in projIds
          current = push({
            kind: 'SemiJoin',
            source: current,
            ids: projIdsRef,
            exclude: true,
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
          entity: node.entity,
        });

        return filterRef;
      }

      // ── Leaf: MembershipScan ──────────────────────────────────────
      case 'MembershipScan': {
        // Reverse MembershipScan (child→parent for "containing"):
        // Bulk-scan children, filter by predicate, collect parent IDs.
        if (isReverseMembershipScan(node.sourceEntity, node.targetEntity)) {
          return lowerReverseMembershipScan(node, push, nodes);
        }

        // Forward MembershipScan (tags→tasks, projects→tasks, folders→projects):
        // Use a Whose specifier to keep the predicate in JXA — AE specifier
        // references can't be serialised across unit boundaries, so a separate
        // Filter node (which defaults to Node runtime) would break.
        //
        // %0 = Get(Whose(Elements(Document, classCode(sourceEntity)), pnam, match, value))
        const { match, value } = parseScopeExpr(node.predicate);
        const sourceNameCode = SIMPLE_PROPS[node.sourceEntity]?.['name'];
        if (!sourceNameCode) {
          throw new Error(`strategyToEventPlan: no name property for entity '${node.sourceEntity}'`);
        }

        const filteredRef = push({
          kind: 'Get',
          specifier: {
            kind: 'Whose',
            parent: {
              kind: 'Elements',
              parent: { kind: 'Document' },
              classCode: classCode(node.sourceEntity),
            },
            prop: sourceNameCode,
            match,
            value,
          },
          effect: 'nonMutating',
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
          source: filteredRef,
          body: bodyNodes,
          collect: collectRef,
          effect: 'nonMutating',
        });

        return forEachRef;
      }

      // ── Transform: Filter ─────────────────────────────────────────
      case 'Filter': {
        const sourceRef = lower(node.source);
        // Identity filter (predicate === true or null) is a no-op — pass through
        if (node.predicate === true || node.predicate === null) return sourceRef;
        return push({
          kind: 'Filter',
          source: sourceRef,
          predicate: node.predicate,
          entity: node.entity,
        });
      }

      // ── Transform: PreFilter → Filter (dissolves) ─────────────────
      //
      // PreFilter stubs variables in `assumeTrue` as true during evaluation
      // so they pass all rows. The exact filter downstream re-checks them
      // after enrichment.
      //
      // In the EventPlan IR there is no stub concept, so we strip conjuncts
      // whose variables are entirely in the assumeTrue set. If nothing
      // remains, the PreFilter becomes a no-op.
      case 'PreFilter': {
        const sourceRef = lower(node.source);
        if (node.predicate === true || node.predicate === null) return sourceRef;

        const stripped = stripStubbedConjuncts(node.predicate, node.assumeTrue);
        if (stripped === true) return sourceRef;

        return push({
          kind: 'Filter',
          source: sourceRef,
          predicate: stripped,
          entity: node.entity,
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

// ── PreFilter predicate stripping ──────────────────────────────────────

/**
 * Collect all variable names referenced in a LoweredExpr.
 */
function collectExprVars(expr: LoweredExpr): Set<string> {
  const vars = new Set<string>();
  function walk(e: LoweredExpr): void {
    if (e === null || e === undefined) return;
    if (typeof e === 'boolean' || typeof e === 'number' || typeof e === 'string') return;
    if (Array.isArray(e)) { for (const item of e) walk(item); return; }
    if (typeof e === 'object') {
      if ('var' in e) { vars.add((e as { var: string }).var); return; }
      if ('op' in e && 'args' in e) {
        for (const arg of (e as { op: string; args: LoweredExpr[] }).args) walk(arg);
      }
    }
  }
  walk(expr);
  return vars;
}

/**
 * Strip conjuncts from a predicate whose variables are all in the stubbed set.
 *
 * - If ALL variables are stubbed, returns `true` (the PreFilter is a no-op).
 * - For top-level `and`, removes conjuncts that only reference stubbed vars
 *   and returns the remaining conjunction (or `true` if nothing remains).
 * - For non-`and` predicates, returns `true` if all vars are stubbed,
 *   otherwise returns the predicate unchanged.
 */
function stripStubbedConjuncts(pred: LoweredExpr, stubbed: Set<string>): LoweredExpr {
  // Quick check: if all vars are stubbed, the whole predicate is a no-op
  const allVars = collectExprVars(pred);
  if (allVars.size === 0) return pred; // no vars → evaluate as-is
  const allStubbed = [...allVars].every(v => stubbed.has(v));
  if (allStubbed) return true;

  // For top-level `and`, strip stubbed conjuncts
  if (typeof pred === 'object' && pred !== null && !Array.isArray(pred) &&
      'op' in pred && (pred as { op: string }).op === 'and') {
    const args = (pred as { op: string; args: LoweredExpr[] }).args;
    const kept = args.filter(arg => {
      const vars = collectExprVars(arg);
      return vars.size === 0 || ![...vars].every(v => stubbed.has(v));
    });
    if (kept.length === 0) return true;
    if (kept.length === 1) return kept[0];
    return { op: 'and', args: kept };
  }

  // Non-`and` with mixed vars — keep as-is (can't partially strip)
  return pred;
}
