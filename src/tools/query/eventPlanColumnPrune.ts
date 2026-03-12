/**
 * Column Pruning Pass for EventPlan IR.
 *
 * Dead-column elimination: removes Zip columns (and their upstream Get
 * nodes) that are never consumed by any downstream node.
 *
 * Motivation: the BulkScan lowering injects extra columns for active
 * filters (completed, dropped) and project-exclusion (id). After the
 * filter/semi-join consumes them, a downstream Pick may project to a
 * narrower set, leaving the injected columns dead. Each dead JXA bulk
 * read wastes ~140ms.
 *
 * Algorithm:
 *   1. Walk backwards from the result ref, computing the set of column
 *      names needed at each row-producing node.
 *   2. At each Zip, prune columns not in the needed set.
 *   3. Collect all refs still referenced; remove dead Get nodes.
 *   4. Compact the plan (reindex refs).
 *
 * Runs after CSE, before runtime targeting.
 */

import type { EventPlan, EventNode, Ref, Specifier } from './eventPlan.js';
import type { LoweredExpr } from './fold.js';
import type { Kind } from './eventNodeRegistry.js';
import { dispatchByKind2 } from './eventNodeRegistry.js';
import { collectRefs, rewriteNode, compactPlan } from './eventPlanUtils.js';
import { computedVarDeps } from './variables.js';

// ── Predicate variable extraction ───────────────────────────────────────

/**
 * Extract all variable names referenced in a LoweredExpr predicate.
 * Simple recursive walk — no need for the full fold machinery here.
 */
function predicateVars(expr: LoweredExpr): Set<string> {
  const vars = new Set<string>();

  function walk(e: LoweredExpr): void {
    if (e === null || e === undefined) return;
    if (typeof e === 'boolean' || typeof e === 'number' || typeof e === 'string') return;
    if (Array.isArray(e)) {
      for (const item of e) walk(item);
      return;
    }
    if (typeof e === 'object') {
      const obj = e as Record<string, unknown>;
      if ('var' in obj) {
        vars.add(obj.var as string);
        return;
      }
      if ('args' in obj && Array.isArray(obj.args)) {
        for (const arg of obj.args) walk(arg as LoweredExpr);
      }
      // date literals, etc — no vars
    }
  }

  walk(expr);
  return vars;
}

// ── Column-propagation registry ─────────────────────────────────────────

type PropagateCtx = {
  myNeeded: Set<string> | null;
  needed: Map<Ref, Set<string> | null>;
};

/**
 * Typed registry defining how each EventNode kind propagates needed columns
 * upstream. Each entry receives the narrowed node type for its kind.
 * Adding a new kind without an entry is a compile error.
 */
type ColumnPropRegistry = {
  [K in Kind]: (node: Extract<EventNode, { kind: K }>, ctx: PropagateCtx) => void;
};

const COLUMN_PROPAGATION: ColumnPropRegistry = {

  Pick: (node, { needed }) => {
    propagate(needed, node.source, new Set(node.fields));
  },

  Filter: (node, { myNeeded, needed }) => {
    const predVars = predicateVars(node.predicate);
    propagate(needed, node.source, myNeeded ? union(myNeeded, predVars) : null);
  },

  Sort: (node, { myNeeded, needed }) => {
    const sortVars = new Set([node.by]);
    propagate(needed, node.source, myNeeded ? union(myNeeded, sortVars) : null);
  },

  Limit: (node, { myNeeded, needed }) => {
    propagate(needed, node.source, myNeeded);
  },

  SemiJoin: (node, { myNeeded, needed }) => {
    const joinField = node.field ?? 'id';
    const joinVars = new Set([joinField]);
    propagate(needed, node.source, myNeeded ? union(myNeeded, joinVars) : null);
    propagate(needed, node.ids, null);
  },

  HashJoin: (node, { myNeeded, needed }) => {
    const addedFields = new Set(Object.values(node.fieldMap));
    const sourceVars = new Set([node.sourceKey]);
    let combined: Set<string> | null;
    if (myNeeded) {
      const fromSource = new Set([...myNeeded].filter(f => !addedFields.has(f)));
      combined = union(fromSource, sourceVars);
    } else {
      combined = null;
    }
    propagate(needed, node.source, combined);
    const lookupVars = new Set([node.lookupKey, ...Object.keys(node.fieldMap)]);
    propagate(needed, node.lookup, lookupVars);
  },

  Derive: (node, { myNeeded, needed }) => {
    let combined: Set<string> | null;
    if (myNeeded) {
      combined = new Set(myNeeded);
      for (const spec of node.derivations) {
        if (combined.has(spec.var)) {
          const deps = computedVarDeps(spec.entity, spec.var);
          if (deps) {
            for (const d of deps) combined.add(d);
          }
        }
      }
    } else {
      combined = null;
    }
    propagate(needed, node.source, combined);
  },

  ColumnValues: (node, { needed }) => {
    propagate(needed, node.source, new Set([node.field]));
  },

  Flatten: (node, { myNeeded, needed }) => {
    propagate(needed, node.source, myNeeded);
  },

  AddSwitch: (node, { myNeeded, needed }) => {
    if (myNeeded === null) {
      propagate(needed, node.source, null);
    } else {
      const fromSource = new Set([...myNeeded].filter(f => f !== node.column));
      for (const c of node.cases) {
        for (const v of predicateVars(c.predicate)) fromSource.add(v);
      }
      propagate(needed, node.source, fromSource);
    }
  },

  Union: (node, { myNeeded, needed }) => {
    const unionNeeded = myNeeded ? union(myNeeded, new Set(['id'])) : null;
    propagate(needed, node.left, unionNeeded);
    propagate(needed, node.right, unionNeeded);
  },

  RowCount: (node, { needed }) => {
    propagate(needed, node.source, new Set());
  },

  SetOp: (node, { needed }) => {
    propagate(needed, node.left, null);
    propagate(needed, node.right, null);
  },

  ForEach: (node, { needed }) => {
    propagate(needed, node.source, null);
  },

  SemanticSearch: (node, { needed }) => {
    propagate(needed, node.embeddingRef, null);
  },

  // Terminals — don't propagate column needs
  Zip:     () => { /* terminal */ },
  Get:     () => { /* terminal */ },
  Count:   () => { /* terminal */ },
  Set:     () => { /* terminal */ },
  Command: () => { /* terminal */ },
  Embed:   () => { /* terminal */ },
};

// ── Needed-columns analysis ─────────────────────────────────────────────

/**
 * Compute needed column names at each node. Returns a Map from Ref to the
 * set of column names that must be present in the row at that point.
 *
 * "All columns" is represented by null (meaning we can't prune).
 */
function computeNeededColumns(
  nodes: EventNode[],
  result: Ref,
): Map<Ref, Set<string> | null> {
  const needed = new Map<Ref, Set<string> | null>();

  // Start from the result: all columns are needed (we don't know what
  // the consumer wants unless there's a Pick).
  needed.set(result, null);

  // Walk backwards through SSA order
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const myNeeded = needed.get(i);

    // If this node isn't needed at all, skip it
    if (myNeeded === undefined) continue;

    const ctx: PropagateCtx = { myNeeded, needed };
    dispatchByKind2(COLUMN_PROPAGATION, node, ctx);
  }

  return needed;
}

function propagate(
  needed: Map<Ref, Set<string> | null>,
  ref: Ref,
  columns: Set<string> | null,
): void {
  const existing = needed.get(ref);
  if (existing === null) return; // already needs all columns
  if (columns === null) {
    needed.set(ref, null);
    return;
  }
  if (existing === undefined) {
    needed.set(ref, new Set(columns));
  } else {
    // Union
    for (const c of columns) existing.add(c);
  }
}

function union(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set(a);
  for (const v of b) result.add(v);
  return result;
}

// ── ForEach body helpers ─────────────────────────────────────────────────

/**
 * Collect body-local Ref indices from a specifier.
 * Body Get nodes reference other body nodes (e.g. ByID parent = body[0])
 * via numeric Ref values that are body-local indices.
 *
 * We walk the specifier tree and mark any numeric parent/id as reachable,
 * then recurse so that transitive body refs are also captured.
 */
function collectBodySpecRefs(spec: Specifier, reachable: Set<number>): void {
  if (spec.kind === 'Document') return;
  if (typeof spec.parent === 'number') {
    reachable.add(spec.parent);
  } else {
    collectBodySpecRefs(spec.parent, reachable);
  }
  if (spec.kind === 'ByID' && typeof spec.id === 'number') {
    reachable.add(spec.id);
  }
}

// ── Main pass ───────────────────────────────────────────────────────────

export function pruneColumns(plan: EventPlan): EventPlan {
  const { nodes, result } = plan;
  if (nodes.length === 0) return plan;

  // Step 1: compute needed columns at each node
  const neededAt = computeNeededColumns(nodes, result);

  // Step 2: prune Zip columns (outer plan + ForEach bodies)
  let changed = false;
  const pruned = nodes.map((node, i) => {
    if (node.kind === 'Zip') {
      const needed = neededAt.get(i);
      if (needed === null || needed === undefined) return node;

      const keptColumns = node.columns.filter(c => needed.has(c.name));
      if (keptColumns.length === node.columns.length) return node;

      changed = true;
      return { ...node, columns: keptColumns } as EventNode;
    }

    if (node.kind === 'ForEach') {
      const forEachNeeded = neededAt.get(i);
      // forEachNeeded = column set the outer plan needs from this ForEach
      if (forEachNeeded === null || forEachNeeded === undefined) return node;

      const bodyZip = node.body[node.collect];
      if (!bodyZip || bodyZip.kind !== 'Zip') return node;

      const keptColumns = bodyZip.columns.filter(c => forEachNeeded.has(c.name));
      if (keptColumns.length === bodyZip.columns.length) return node;

      changed = true;

      // Build body-local reachability from the pruned Zip
      const keptRefs = new Set<Ref>(keptColumns.map(c => c.ref));
      // body[0] (ByID Get) is always needed if any column survives
      const bodyReachable = new Set<number>();
      bodyReachable.add(node.collect); // the Zip itself
      for (const ref of keptRefs) {
        bodyReachable.add(ref as number);
        // PropertyGets reference body[0] (ByID) via specifier parent
        // Walk specifier refs for the kept Get nodes
        const bodyNode = node.body[ref as number];
        if (bodyNode && bodyNode.kind === 'Get') {
          collectBodySpecRefs(bodyNode.specifier, bodyReachable);
        }
      }

      // Compact the body: keep only reachable nodes, reindex
      const bodySurvivors: number[] = [];
      for (let j = 0; j < node.body.length; j++) {
        if (bodyReachable.has(j)) bodySurvivors.push(j);
      }

      if (bodySurvivors.length === node.body.length) {
        // Nothing removed from body, just prune the Zip columns
        const newBody = [...node.body];
        newBody[node.collect] = { ...bodyZip, columns: keptColumns };
        return { ...node, body: newBody, collect: node.collect } as EventNode;
      }

      // Build body compaction map
      const bodyCompact = new Map<number, number>();
      for (let j = 0; j < bodySurvivors.length; j++) {
        bodyCompact.set(bodySurvivors[j], j);
      }
      const remapBody = (r: Ref): Ref => {
        // Body refs that point to the ForEach index itself (the loop var)
        // are NOT body-local — they reference the outer ForEach node.
        // These must be preserved as-is (remapped separately by the outer
        // ForEach's index in the plan if outer compaction occurs).
        // In the body, the ForEach's own index is used as "current item".
        // We only remap body-local indices here.
        const mapped = bodyCompact.get(r as number);
        if (mapped !== undefined) return mapped as Ref;
        return r; // non-body ref (e.g. forEachIdx for loop var)
      };
      const newBody = bodySurvivors.map(oldIdx =>
        rewriteNode(node.body[oldIdx], remapBody)
      );
      const newCollect = bodyCompact.get(node.collect);
      // Update the pruned Zip columns with remapped refs
      const prunedZipIdx = newCollect!;
      newBody[prunedZipIdx] = {
        ...bodyZip,
        columns: keptColumns.map(c => ({ ...c, ref: remapBody(c.ref) })),
      };

      return { ...node, body: newBody, collect: newCollect as Ref } as EventNode;
    }

    return node;
  });

  if (!changed) return plan;

  // Step 3: walk from result to find reachable nodes
  const reachable = new Set<Ref>();
  function markReachable(ref: Ref): void {
    if (reachable.has(ref)) return;
    if (ref < 0 || ref >= pruned.length) return;
    reachable.add(ref);
    for (const r of collectRefs(pruned[ref])) markReachable(r);
  }
  markReachable(result);

  // Step 4: compact — remove unreachable nodes
  const survivors: number[] = [];
  for (let i = 0; i < pruned.length; i++) {
    if (reachable.has(i)) survivors.push(i);
  }

  if (survivors.length === pruned.length) {
    // Nothing was removed, just return pruned Zips
    return { nodes: pruned, result };
  }

  return compactPlan(pruned, result, survivors, 'pruneColumns');
}
