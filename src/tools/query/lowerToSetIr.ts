/**
 * Lowering: normalized AST → SetIR.
 *
 * This is a structural recursion — no pattern-matching, no cost analysis
 * at lowering time. The result is correct but may have redundant reads.
 * Optimizer passes (mergeSameEntityScans, etc.) clean it up.
 *
 * Core rules:
 *   and(A, B)        → Intersect(lower(A), lower(B))
 *   or(A, B)         → Union(lower(A), lower(B))
 *   not(P)           → Filter(scanVarsOf(P), not(P))   [always Node-side]
 *   simple_pred(var) → Filter(Scan(entity, [id, var]), pred)
 *   expensive(var)   → Filter(Enrich(Scan(entity, [id]), [var]), pred)
 *   container(t, p)  → Restriction(Scan(entity,[id,fk]), fk, lowerPredicate(p, containerEntity))
 *
 * Output columns are added separately at the top:
 *   cheap select cols  → Intersect(Scan(entity, [id, ...cheapCols]), filterTree)
 *   expensive select   → Enrich(plan, [expensiveCols])
 *
 * Both sides of every Intersect/Union always carry 'id' — this is the
 * join key used by the executor and the merge optimiser.
 *
 * op:'count'  → Count(filterTree)   — no output columns needed
 * op:'exists' → Limit(filterTree,1) — no output columns needed
 * op:'get'    → output columns + Sort/Limit wrappers
 */

import type { LoweredExpr, FoldOp } from './fold.js';
import { getVarRegistry, COMPUTED_VAR_SPECS, type EntityType } from './variables.js';
import { getChildToParentFk } from './aeProps.js';
import {
  walkSetIr,
  type SetIrNode,
  type ScanNode,
} from './setIr.js';

// Compile-time check: every AE-queryable entity (all EntityType values except
// 'perspectives', which has no FK relationships) must be listed here.
// TypeScript will error if EntityType gains a new member without a
// corresponding entry in this table.
const _ENTITY_TYPES_EXHAUSTIVE: Record<Exclude<EntityType, 'perspectives'>, true> = {
  tasks: true, projects: true, folders: true, tags: true,
};

/** All entity types that participate in FK relationships. */
const ENTITY_TYPES = Object.keys(_ENTITY_TYPES_EXHAUSTIVE) as Exclude<EntityType, 'perspectives'>[];

// ── Variable classification ────────────────────────────────────────────────

/**
 * Does this variable require per-row AE fetches rather than a bulk scan?
 * 'expensive' vars have no bulk accessor and are resolved via Enrich (per-item or join).
 */
function requiresEnrich(varName: string, entity: EntityType): boolean {
  const reg = getVarRegistry(entity);
  return reg[varName]?.cost === 'expensive';
}

// ── Collect variable references ────────────────────────────────────────────

/**
 * Collect all {var: "name"} references in a predicate expression.
 */
export function collectVarNames(pred: LoweredExpr): Set<string> {
  const result = new Set<string>();

  function walk(node: LoweredExpr): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const obj = node as Record<string, unknown>;
    if ('var' in obj) { result.add(obj.var as string); return; }
    if ('op' in obj) {
      const { args } = obj as { op: FoldOp; args: LoweredExpr[] };
      args.forEach(walk);
    }
  }

  walk(pred);
  return result;
}

// ── Column helpers ─────────────────────────────────────────────────────────

/**
 * Produce a Scan that reads the given columns plus 'id'.
 * If columns is empty, returns a minimal Scan([id]).
 */
function scan(entity: EntityType, columns: string[]): ScanNode {
  const cols = new Set<string>(['id', ...columns]);
  return { kind: 'Scan', entity, columns: [...cols] };
}

/**
 * Columns needed to evaluate a predicate, split by cost tier.
 */
function splitColumns(
  varNames: Set<string>,
  entity: EntityType,
): { cheap: string[]; expensive: string[]; computed: string[] } {
  const reg = getVarRegistry(entity);
  const cheap: string[] = [];
  const expensive: string[] = [];
  const computed: string[] = [];

  for (const v of varNames) {
    const varDef = reg[v];
    const cost = varDef?.cost;
    if (cost === 'expensive') {
      expensive.push(v);
    } else if (cost === 'computed') {
      computed.push(v);
    } else if (varDef?.appleEventsProperty === null) {
      // Virtual variable — no AE property (e.g. 'now'). Evaluated at Node-side
      // runtime by nodeEval; must not appear in Scan columns.
    } else {
      cheap.push(v);
    }
  }

  return { cheap, expensive, computed };
}

/**
 * Build the source node for a filter: scan the required columns (expanding
 * computed var dependencies), enrich for expensive vars, then wrap with
 * AddSwitch nodes for each computed var referenced.
 */
function buildFilterSource(varNames: Set<string>, entity: EntityType): SetIrNode {
  const { cheap, expensive, computed } = splitColumns(varNames, entity);

  // Expand computed var dependencies into the cheap scan
  const allCheap = new Set(cheap);
  for (const cv of computed) {
    const spec = COMPUTED_VAR_SPECS[entity]?.[cv];
    if (spec) for (const dep of spec.deps) allCheap.add(dep);
  }

  let source: SetIrNode = scan(entity, [...allCheap]);

  if (expensive.length > 0) {
    source = { kind: 'Enrich', source, entity, columns: expensive };
  }

  // Wrap with an AddSwitch for each computed var
  for (const cv of computed) {
    const spec = COMPUTED_VAR_SPECS[entity]?.[cv];
    if (spec) {
      source = { kind: 'AddSwitch', source, entity, column: cv, cases: spec.cases, default: spec.default };
    }
  }

  return source;
}

// ── Active filters ────────────────────────────────────────────────────
//
// Default active filters by entity — mirrors the logic in queryOmnifocus.ts.
// Used by containing() to ensure child scans only match active items.

function activeFilterForEntity(entity: EntityType): LoweredExpr | null {
  switch (entity) {
    case 'tasks':
      return {
        op: 'and', args: [
          { op: 'not', args: [{ var: 'effectivelyCompleted' }] },
          { op: 'not', args: [{ var: 'effectivelyDropped' }] },
        ],
      };
    case 'projects':
      return { op: 'in', args: [{ var: 'status' }, ['Active', 'OnHold']] };
    case 'tags':
      return { op: 'not', args: [{ var: 'effectivelyHidden' }] };
    default:
      return null;
  }
}

/**
 * Merge the active filter for a child entity into a child predicate.
 * If childPred is null/true (no filter), returns just the active filter.
 * If there's no active filter for the entity, returns childPred unchanged.
 */
function mergeActiveFilter(childPred: LoweredExpr, childEntity: EntityType): LoweredExpr {
  const activeFilter = activeFilterForEntity(childEntity);
  if (!activeFilter) return childPred;
  if (childPred === true || childPred === null) return activeFilter;
  return { op: 'and', args: [childPred, activeFilter] };
}

// ── Containing helper ─────────────────────────────────────────────────────

/**
 * Build a Restriction that keeps parentEntity rows where at least one
 * childEntity row (with fkColumn pointing to parentEntity.id) satisfies childPred.
 *
 * Produces:
 *   Restriction(
 *     source:       Scan(parentEntity, [id]),
 *     fkColumn:     'id',
 *     lookup:       Intersect(Scan(childEntity, [id, fkColumn]), lowerPredicate(childPred, childEntity)),
 *     lookupColumn: fkColumn,
 *     flattenLookup: isArray,
 *   )
 *
 * The Intersect feeds the optimizer: Intersect(Scan(A,c1), Filter(Scan(A,c2),p))
 * → Filter(Scan(A, c1∪c2), p) — collapses to a single scan with both columns.
 */
function makeContainingRestriction(
  parentEntity: EntityType,
  childEntity: EntityType,
  childPred: LoweredExpr,
  fkColumn: string,
  isArray: boolean,
): SetIrNode {
  const filteredChildren: SetIrNode = {
    kind: 'Intersect',
    left:  scan(childEntity, [fkColumn]),
    right: lowerPredicate(childPred, childEntity),
  };
  return {
    kind:          'Restriction',
    source:        scan(parentEntity, []),
    fkColumn:      'id',
    lookup:        filteredChildren,
    lookupColumn:  fkColumn,
    flattenLookup: isArray || undefined,
  };
}

// ── Predicate lowering ────────────────────────────────────────────────────

/**
 * Lower a single predicate to a SetIR subtree.
 *
 * The result is a node that produces rows satisfying `pred`.
 * All result rows include 'id'.
 *
 * This is purely structural — no cost analysis, no merging.
 * The optimizer handles redundant reads.
 */
export function lowerPredicate(pred: LoweredExpr, entity: EntityType): SetIrNode {
  // No predicate — return everything
  if (pred === true || pred === null) {
    return scan(entity, []);
  }

  if (typeof pred === 'boolean') {
    // false would mean no rows — not a valid top-level predicate normally
    return scan(entity, []);
  }

  if (typeof pred !== 'object' || Array.isArray(pred)) {
    return scan(entity, []);
  }

  const obj = pred as Record<string, unknown>;

  if (!('op' in obj)) {
    return scan(entity, []);
  }

  const { op, args } = obj as { op: FoldOp; args: LoweredExpr[] };

  switch (op) {
    case 'and': {
      // Structural AND → nested Intersects.
      // and(A, B, C) → Intersect(Intersect(lower(A), lower(B)), lower(C))
      // Both sides carry 'id' — the join key.
      const branches = args.map(a => lowerPredicate(a, entity));
      return branches.reduce((acc, cur): SetIrNode =>
        ({ kind: 'Intersect', left: acc, right: cur })
      );
    }

    case 'or': {
      // Structural OR → nested Unions.
      // Both sides carry 'id' — the join key for dedup.
      const branches = args.map(a => lowerPredicate(a, entity));
      return branches.reduce((acc, cur): SetIrNode =>
        ({ kind: 'Union', left: acc, right: cur })
      );
    }

    case 'not': {
      // not(P) — always handled as Node-side filter.
      // We scan the columns P references, then filter with not(P).
      // This is always correct; the optimizer can improve for structural P.
      const vars = collectVarNames(pred);
      const source = buildFilterSource(vars, entity);
      return { kind: 'Filter', source, predicate: pred, entity };
    }

    case 'container': {
      // container(type, subPred) — FK-based restriction (relational semi-join).
      // Keeps rows of `entity` where the FK column references a container matching subPred.
      const containerType = args[0] as 'tag' | 'folder' | 'project';
      const containerPred = args[1] as LoweredExpr;

      switch (containerType) {
        case 'project': {
          // tasks/projects whose containingProject satisfies containerPred
          const source = scan(entity, ['projectId']);
          const lookup = lowerPredicate(containerPred, 'projects');
          return { kind: 'Restriction', source, fkColumn: 'projectId', lookup };
        }

        case 'folder': {
          if (entity === 'tasks') {
            // tasks → projects via projectId, projects → folders via folderId
            const projectSource = scan('projects', ['folderId']);
            const folderLookup  = lowerPredicate(containerPred, 'folders');
            const projectsInFolder: SetIrNode = { kind: 'Restriction', source: projectSource, fkColumn: 'folderId', lookup: folderLookup };
            const taskSource = scan(entity, ['projectId']);
            return { kind: 'Restriction', source: taskSource, fkColumn: 'projectId', lookup: projectsInFolder };
          }
          if (entity === 'projects') {
            const source = scan(entity, ['folderId']);
            const lookup = lowerPredicate(containerPred, 'folders');
            return { kind: 'Restriction', source, fkColumn: 'folderId', lookup };
          }
          // Fallback: Node-side filter (shouldn't arise in practice)
          const varsFb = collectVarNames(pred);
          const sourceFb = buildFilterSource(varsFb, entity);
          return { kind: 'Filter', source: sourceFb, predicate: pred, entity };
        }

        case 'tag': {
          // tasks/projects whose tag set intersects the tags matching containerPred.
          // tagIds = task.tags.id() — bulk nested-array chain read.
          const source = scan(entity, ['tagIds']);
          const lookup = lowerPredicate(containerPred, 'tags');
          return { kind: 'Restriction', source, fkColumn: 'tagIds', lookup, arrayFk: true };
        }
      }
    }

    case 'containing': {
      // containing(childEntity, childPred) — FK-inverse restriction.
      // Keeps rows of `entity` where entity.id appears in {child[childFk] | child matches childPred}.
      // This is the transpose of `container`: instead of "tasks in project X", it's
      // "projects that contain tasks matching X".
      //
      // FK graph: look up metadata in aeProps to find the FK column generically.
      // Supports both direct (one FK hop) and indirect (two FK hops) relationships.
      const childEntity = args[0] as EntityType;
      const childPred   = mergeActiveFilter(args[1] as LoweredExpr, childEntity);

      // Direct FK: childEntity has a column pointing to entity.
      // e.g. tasks.projectId → 'projects', tasks.tagIds → 'tags'
      const direct = getChildToParentFk(childEntity, entity);
      if (direct) {
        return makeContainingRestriction(entity, childEntity, childPred, direct.fkColumn, direct.isArray);
      }

      // One-hop: childEntity → intermediate → entity.
      // e.g. tasks → projects (projectId) → folders (folderId)
      for (const intermediate of ENTITY_TYPES) {
        const leg1 = getChildToParentFk(childEntity, intermediate);
        const leg2 = getChildToParentFk(intermediate, entity);
        if (leg1 && leg2 && !leg1.isArray && !leg2.isArray) {
          // Step 1: intermediate rows containing matching children.
          // Include leg2.fkColumn in the intermediate scan so step2 can extract it.
          const childLookup: SetIrNode = {
            kind: 'Intersect',
            left:  scan(childEntity, [leg1.fkColumn]),
            right: lowerPredicate(childPred, childEntity),
          };
          const intermediateWithFk: SetIrNode = {
            kind:        'Restriction',
            source:      scan(intermediate, [leg2.fkColumn]),  // leg2.fkColumn needed by step 2
            fkColumn:    'id',
            lookup:      childLookup,
            lookupColumn: leg1.fkColumn,
          };
          // Step 2: parent rows containing those intermediates.
          return {
            kind:        'Restriction',
            source:      scan(entity, []),
            fkColumn:    'id',
            lookup:      intermediateWithFk,
            lookupColumn: leg2.fkColumn,
          };
        }
      }

      // Fallback for unhandled combinations — Node-side filter (may not produce
      // correct results for cross-entity predicates, but avoids a crash).
      const vars = collectVarNames(pred);
      const source = buildFilterSource(vars, entity);
      return { kind: 'Filter', source, predicate: pred, entity };
    }

    default: {
      // Simple comparison / string op / null check / count-predicate.
      // Scan columns needed, apply Node-side filter.
      const vars = collectVarNames(pred);
      const source = buildFilterSource(vars, entity);
      return { kind: 'Filter', source, predicate: pred, entity };
    }
  }
}

// ── Top-level query lowering ──────────────────────────────────────────────

export interface LowerToSetIrParams {
  predicate: LoweredExpr;
  entity: EntityType;
  op: 'get' | 'count' | 'exists';
  select?: string[];
  sort?: { by: string; direction?: 'asc' | 'desc' };
  limit?: number;
}

/**
 * Lower a full query to a SetIR plan.
 *
 * Steps:
 *   1. Lower the WHERE predicate to a filter tree (structural recursion).
 *   2. For 'get': attach output columns by Intersecting a column-scan with the filter.
 *      For 'count'/'exists': no output columns needed — skip.
 *   3. Wrap with Count / Limit / Sort as appropriate for the op.
 *
 * The result may contain redundant reads (e.g. Intersect of two Scans of the
 * same entity). The optimizer passes (see optimizeSetIr.ts) collapse these.
 */
export function lowerToSetIr(params: LowerToSetIrParams): SetIrNode {
  const { predicate, entity, op, select, sort, limit } = params;

  // Step 1: Lower predicate
  let plan: SetIrNode = lowerPredicate(predicate, entity);

  // Step 2: For 'get', attach output columns.
  // We add a separate Scan for the output columns and Intersect it with the
  // filter plan. The merge-scan optimizer will collapse this if both scans
  // are over the same entity.
  if (op === 'get') {
    if (select && select.length > 0) {
      const { cheap: cheapOut, expensive: expensiveOut, computed: computedOut } = splitColumns(
        new Set(select), entity
      );

      // Expand computed var dependencies into the cheap output scan
      const allCheapOut = new Set(cheapOut);
      for (const cv of computedOut) {
        const spec = COMPUTED_VAR_SPECS[entity]?.[cv];
        if (spec) for (const dep of spec.deps) allCheapOut.add(dep);
      }

      if (allCheapOut.size > 0) {
        // Output scan carries id + cheap output cols.
        // Intersect: keep output scan rows whose id is in the filter result.
        const outputScan = scan(entity, [...allCheapOut]);
        plan = { kind: 'Intersect', left: outputScan, right: plan };
      }

      if (expensiveOut.length > 0) {
        // Enrich surviving rows with expensive output columns.
        plan = { kind: 'Enrich', source: plan, entity, columns: expensiveOut };
      }

      // Wrap with AddSwitch for computed output vars
      for (const cv of computedOut) {
        const spec = COMPUTED_VAR_SPECS[entity]?.[cv];
        if (spec) {
          plan = { kind: 'AddSwitch', source: plan, entity, column: cv, cases: spec.cases, default: spec.default };
        }
      }
    }
    // (If select is omitted, the filter scan already carries what's needed.
    //  The executor would return all scanned columns — user gets whatever the
    //  filter referenced plus 'id'. Full column selection is a later pass.)
  }

  // Step 3: Wrap for op
  switch (op) {
    case 'count':
      // count(x) → rowcount(get(x, id))
      // The filter plan already produces {id}-only rows by default.
      plan = { kind: 'Count', source: plan };
      break;

    case 'exists':
      // exists(x) → gt(count(x), 0) — but simplified to Limit(1).
      // If the executor finds one row, exists = true.
      plan = { kind: 'Limit', source: plan, n: 1 };
      break;

    case 'get':
      // Sort then limit for 'get'.
      if (sort) {
        plan = {
          kind: 'Sort',
          source: plan,
          by: sort.by,
          direction: sort.direction ?? 'asc',
          entity,
        };
      }
      if (limit) {
        plan = { kind: 'Limit', source: plan, n: limit };
      }
      break;
  }

  return plan;
}

// ── Merge-scan optimizer ──────────────────────────────────────────────────

/**
 * Optimiser pass: merge Intersect(Scan(A, cols1), Scan(A, cols2)) into
 * a single Scan(A, cols1 ∪ cols2).
 *
 * More precisely: merge any Intersect where both sides are Scans over the
 * same entity. The Filter nodes above the Scans are then combined with and().
 * (Full predicate merging is a subsequent pass; this handles the column merge.)
 *
 * Applied bottom-up by walkSetIr.
 */
export function mergeSameEntityScans(node: SetIrNode): SetIrNode {
  // Algebraic Error rules: Error is ⊥ (bottom) for set operations.
  // Union absorbs Error (contributes no rows); Intersect propagates Error.
  if (node.kind === 'Union') {
    if (node.left.kind === 'Error')  return node.right;
    if (node.right.kind === 'Error') return node.left;
  }
  if (node.kind === 'Intersect') {
    if (node.left.kind === 'Error')  return node.left;
    if (node.right.kind === 'Error') return node.right;
  }

  if (node.kind !== 'Intersect') return node;

  const { left, right } = node;

  // Case: Intersect(Scan(A, c1), Scan(A, c2)) → Scan(A, c1 ∪ c2)
  if (left.kind === 'Scan' && right.kind === 'Scan' && left.entity === right.entity) {
    const merged = new Set<string>([...left.columns, ...right.columns]);
    return { kind: 'Scan', entity: left.entity, columns: [...merged] };
  }

  // Case: Intersect(Filter(Scan(A, c1), p1), Filter(Scan(A, c2), p2))
  //   → Filter(Scan(A, c1 ∪ c2), and(p1, p2))
  if (
    left.kind === 'Filter' && left.source.kind === 'Scan' &&
    right.kind === 'Filter' && right.source.kind === 'Scan' &&
    left.source.entity === right.source.entity
  ) {
    const entity = left.source.entity;
    const merged = new Set<string>([...left.source.columns, ...right.source.columns]);
    const mergedScan: ScanNode = { kind: 'Scan', entity, columns: [...merged] };
    const combinedPred: LoweredExpr = {
      op: 'and',
      args: [left.predicate, right.predicate],
    };
    return { kind: 'Filter', source: mergedScan, predicate: combinedPred, entity };
  }

  // Case: Intersect(Filter(Scan(A, c1), p1), Scan(A, c2))
  //   → Filter(Scan(A, c1 ∪ c2), p1)
  if (
    left.kind === 'Filter' && left.source.kind === 'Scan' &&
    right.kind === 'Scan' &&
    left.source.entity === right.entity
  ) {
    const merged = new Set<string>([...left.source.columns, ...right.columns]);
    const mergedScan: ScanNode = { kind: 'Scan', entity: left.source.entity, columns: [...merged] };
    return { kind: 'Filter', source: mergedScan, predicate: left.predicate, entity: left.entity };
  }

  // Case: Intersect(Scan(A, c1), Filter(Scan(A, c2), p2))
  //   → Filter(Scan(A, c1 ∪ c2), p2)
  if (
    left.kind === 'Scan' &&
    right.kind === 'Filter' && right.source.kind === 'Scan' &&
    left.entity === right.source.entity
  ) {
    const merged = new Set<string>([...left.columns, ...right.source.columns]);
    const mergedScan: ScanNode = { kind: 'Scan', entity: left.entity, columns: [...merged] };
    return { kind: 'Filter', source: mergedScan, predicate: right.predicate, entity: right.entity };
  }

  return node;
}

/**
 * Apply all optimizer passes over the tree.
 *
 * Pass order:
 *   1. mergeSameEntityScans — collapse Intersect(Scan(A,c1), Scan(A,c2))
 *   2. widenScansToUnion    — widen all Scans for the same entity to the
 *      same column set, enabling EventPlan CSE to deduplicate the
 *      resulting identical Get+Zip chains
 */
export function optimizeSetIr(plan: SetIrNode): SetIrNode {
  // similarShortcut runs before merge-scan: the merge pass collapses
  // Intersect(Filter(Scan,p1), Filter(Scan,p2)) into Filter(Scan, and(p1,p2)),
  // burying `similar` inside nested and() where extraction is harder.
  let result = similarShortcut(plan);
  result = applyMergeScanPass(result);
  result = tagNameShortcut(result);
  result = widenScansToUnion(result);
  return result;
}

function applyMergeScanPass(node: SetIrNode): SetIrNode {
  // Rebuild children first (bottom-up)
  let rebuilt = rebuildChildren(node);
  // Apply the merge rule
  return mergeSameEntityScans(rebuilt);
}

function rebuildChildren(node: SetIrNode): SetIrNode {
  switch (node.kind) {
    case 'Scan':
    case 'Error':
    case 'TagNameTaskIds':
    case 'SimilarItems':
      return node;
    case 'Restriction':
      return { ...node, source: applyMergeScanPass(node.source), lookup: applyMergeScanPass(node.lookup) };
    case 'Filter':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Enrich':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Count':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Sort':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Limit':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'AddSwitch':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Intersect':
    case 'Union':
    case 'Difference':
      return {
        ...node,
        left: applyMergeScanPass(node.left),
        right: applyMergeScanPass(node.right),
      };
  }
}

// ── Scan subsumption ──────────────────────────────────────────────────────

/**
 * Widen all Scan nodes for the same entity to the union of their column
 * sets. This makes structurally identical Scans that differ only by having
 * a subset of columns — e.g. Scan(projects,[id]) vs Scan(projects,[id,name])
 * — produce the same column set, enabling EventPlan CSE to deduplicate
 * the downstream Get+Zip chains into a single AE round-trip.
 *
 * Safety: Scan is a pure bulk read. Wider columns add data but never change
 * which rows are returned. The column pruner strips unused columns before
 * execution, so the only cost is a transient wider intermediate.
 */
function widenScansToUnion(plan: SetIrNode): SetIrNode {
  // Pass 1: collect all column sets per entity
  const entityColumns = new Map<string, Set<string>>();
  walkSetIr(plan, (node) => {
    if (node.kind === 'Scan') {
      const existing = entityColumns.get(node.entity);
      if (existing) {
        for (const col of node.columns) existing.add(col);
      } else {
        entityColumns.set(node.entity, new Set(node.columns));
      }
    }
    return node;
  });

  // Check if any entity has multiple scans that would benefit from widening
  // (i.e. at least one entity has columns that differ between scan sites).
  // If not, skip the rewrite pass.
  let needsRewrite = false;
  walkSetIr(plan, (node) => {
    if (node.kind === 'Scan') {
      const widened = entityColumns.get(node.entity)!;
      if (widened.size > node.columns.length) needsRewrite = true;
    }
    return node;
  });
  if (!needsRewrite) return plan;

  // Pass 2: rewrite Scan nodes to use the widened column set
  return walkSetIr(plan, (node) => {
    if (node.kind === 'Scan') {
      const widened = entityColumns.get(node.entity)!;
      if (widened.size > node.columns.length) {
        return { kind: 'Scan', entity: node.entity, columns: [...widened] };
      }
    }
    return node;
  });
}

// ── Tag-name shortcut ─────────────────────────────────────────────────────

/**
 * Extract a literal tag-name equality from a predicate.
 *
 * Matches:   eq(name, 'literal')  or  eq('literal', name)
 * Returns the literal string, or null if the predicate isn't a simple tag-name eq.
 */
function extractTagNameLiteral(pred: LoweredExpr): string | null {
  if (pred === null || pred === true || typeof pred !== 'object' || Array.isArray(pred)) return null;
  const obj = pred as Record<string, unknown>;
  if (obj.op !== 'eq') return null;
  const args = obj.args as LoweredExpr[];
  if (!Array.isArray(args) || args.length !== 2) return null;

  // eq({var:'name'}, 'literal')
  if (isVarRef(args[0], 'name') && typeof args[1] === 'string') return args[1];
  // eq('literal', {var:'name'})
  if (typeof args[0] === 'string' && isVarRef(args[1], 'name')) return args[0];
  return null;
}

function isVarRef(node: LoweredExpr, name: string): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  return (node as Record<string, unknown>).var === name;
}

/**
 * Strip a column from all Scan nodes in a subtree.
 * Used to remove 'tagIds' from the source when the tag-name shortcut
 * replaces the FK-based SemiJoin with an id-based Intersect.
 */
function stripColumnFromScans(node: SetIrNode, column: string): SetIrNode {
  return walkSetIr(node, (n) => {
    if (n.kind === 'Scan' && n.columns.includes(column)) {
      const filtered = n.columns.filter(c => c !== column);
      return { kind: 'Scan', entity: n.entity, columns: filtered };
    }
    return n;
  });
}

/**
 * Optimizer pass: rewrite tag-container Restrictions that filter by tag name
 * to use an AE Whose-based lookup instead of the expensive tagIds bulk read.
 *
 * Pattern matched (after merge-scan):
 *   Restriction(
 *     source: (any node — usually Scan(tasks, [id, tagIds, ...])),
 *     fkColumn: 'tagIds',
 *     lookup: Filter(Scan(tags, [id, name, ...]), eq(name, LITERAL)),
 *     arrayFk: true
 *   )
 *
 * Rewritten to:
 *   Intersect(
 *     source (with 'tagIds' stripped from Scan columns),
 *     TagNameTaskIds(LITERAL, 'eq')
 *   )
 *
 * The TagNameTaskIds node is lowered to EventPlan as:
 *   Whose(flattenedTags, name, eq, literal) → Elements(result, flattenedTask) → Property(id)
 *
 * This replaces 4 AE round-trips (~500ms: tagIds + tag id + tag name + tag SemiJoin)
 * with 2 (~278ms: whose + relationship traversal), saving ~200ms.
 */
function tagNameShortcut(plan: SetIrNode): SetIrNode {
  return walkSetIr(plan, (node) => {
    if (
      node.kind !== 'Restriction' ||
      node.fkColumn !== 'tagIds' ||
      !node.arrayFk
    ) {
      return node;
    }

    // The lookup must be a Filter with a tag-name eq predicate.
    // After merge-scan, the lookup is typically Filter(Scan(tags,...), pred).
    const lookup = node.lookup;
    if (lookup.kind !== 'Filter') return node;

    const tagName = extractTagNameLiteral(lookup.predicate);
    if (tagName === null) return node;

    // Rewrite: replace Restriction with Intersect(source, TagNameTaskIds)
    const cleanedSource = stripColumnFromScans(node.source, 'tagIds');
    return {
      kind: 'Intersect',
      left:  cleanedSource,
      right: { kind: 'TagNameTaskIds', tagName, match: 'eq' } as SetIrNode,
    };
  });
}

// ── Similar shortcut ──────────────────────────────────────────────────────

/**
 * Extract a `similar` op from a predicate expression.
 *
 * Returns the query string if found at the top level, or null.
 * For composed predicates (and(similar(..), other)), returns
 * { query, remaining } where remaining is the predicate without the similar op.
 */
function extractSimilar(pred: LoweredExpr): { query: string; remaining: LoweredExpr | null } | null {
  if (pred === null || pred === true || typeof pred !== 'object' || Array.isArray(pred)) return null;
  const obj = pred as Record<string, unknown>;
  if (!('op' in obj)) return null;

  const { op, args } = obj as { op: string; args: LoweredExpr[] };

  // Direct similar: {op: 'similar', args: ["query"]}
  if (op === 'similar' && args.length === 1 && typeof args[0] === 'string') {
    return { query: args[0], remaining: null };
  }

  // Inside and(): extract similar from conjuncts
  if (op === 'and') {
    for (let i = 0; i < args.length; i++) {
      const inner = args[i];
      if (typeof inner === 'object' && inner !== null && !Array.isArray(inner) &&
          'op' in (inner as Record<string, unknown>)) {
        const innerObj = inner as { op: string; args: LoweredExpr[] };
        if (innerObj.op === 'similar' && innerObj.args.length === 1 && typeof innerObj.args[0] === 'string') {
          const rest = args.filter((_, j) => j !== i);
          const remaining = rest.length === 1 ? rest[0] : { op: 'and', args: rest } as LoweredExpr;
          return { query: innerObj.args[0], remaining };
        }
      }
    }
  }

  return null;
}

/**
 * Optimizer pass: extract `similar` op from Filter predicates and rewrite
 * to SimilarItems leaf node.
 *
 * Patterns:
 *   Filter(Scan(entity, cols), similar("q"))
 *     → SimilarItems(entity, "q")
 *
 *   Filter(Scan(entity, cols), and(similar("q"), otherPred))
 *     → Intersect(SimilarItems(entity, "q"), Filter(Scan(entity, cols), otherPred))
 *     SimilarItems on LEFT preserves semantic ordering through SemiJoin.
 */
function similarShortcut(plan: SetIrNode): SetIrNode {
  return walkSetIr(plan, (node) => {
    if (node.kind !== 'Filter') return node;

    const extracted = extractSimilar(node.predicate);
    if (!extracted) return node;

    const entity = node.entity;
    const similarNode: SetIrNode = { kind: 'SimilarItems', entity, query: extracted.query };

    if (extracted.remaining === null) {
      // Standalone similar — replace Filter entirely
      return similarNode;
    }

    // Composed: SimilarItems on LEFT preserves semantic ordering
    const filteredSource: SetIrNode = { kind: 'Filter', source: node.source, predicate: extracted.remaining, entity };
    return { kind: 'Intersect', left: similarNode, right: filteredSource };
  });
}
