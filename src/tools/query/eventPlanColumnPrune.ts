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

import type { EventPlan, EventNode, Ref } from './eventPlan.js';
import type { LoweredExpr } from './fold.js';
import { collectRefs, rewriteNode } from './eventPlanUtils.js';
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

    switch (node.kind) {
      case 'Pick': {
        // Pick narrows to specific fields — propagate only those upstream
        const fields = new Set(node.fields);
        propagate(needed, node.source, fields);
        break;
      }

      case 'Filter': {
        // Filter needs its predicate vars plus whatever downstream needs
        const predVars = predicateVars(node.predicate);
        const combined = myNeeded ? union(myNeeded, predVars) : null;
        propagate(needed, node.source, combined);
        break;
      }

      case 'Sort': {
        // Sort needs its `by` column plus downstream
        const sortVars = new Set([node.by]);
        const combined = myNeeded ? union(myNeeded, sortVars) : null;
        propagate(needed, node.source, combined);
        break;
      }

      case 'Limit': {
        // Pass-through
        propagate(needed, node.source, myNeeded);
        break;
      }

      case 'SemiJoin': {
        // SemiJoin needs the join field (default 'id') plus downstream columns
        const joinField = node.field ?? 'id';
        const joinVars = new Set([joinField]);
        const combined = myNeeded ? union(myNeeded, joinVars) : null;
        propagate(needed, node.source, combined);
        // ids ref is a separate data flow (not row columns)
        propagate(needed, node.ids, null);
        break;
      }

      case 'HashJoin': {
        // Source needs sourceKey + downstream columns (minus fields added by join)
        const addedFields = new Set(Object.values(node.fieldMap));
        const sourceVars = new Set([node.sourceKey]);
        let combined: Set<string> | null;
        if (myNeeded) {
          // Remove fields that the join adds (they come from lookup, not source)
          const fromSource = new Set([...myNeeded].filter(f => !addedFields.has(f)));
          combined = union(fromSource, sourceVars);
        } else {
          combined = null;
        }
        propagate(needed, node.source, combined);
        // Lookup needs lookupKey + the lookup-side fields from fieldMap
        const lookupVars = new Set([node.lookupKey, ...Object.keys(node.fieldMap)]);
        propagate(needed, node.lookup, lookupVars);
        break;
      }

      case 'Derive': {
        // Derive adds computed columns. It needs its dependency columns
        // plus whatever downstream needs (minus derived columns that
        // downstream doesn't need).
        let combined: Set<string> | null;
        if (myNeeded) {
          combined = new Set(myNeeded);
          for (const spec of node.derivations) {
            // If the derived var is needed, add its dependencies
            if (combined.has(spec.var)) {
              const deps = computedVarDeps[spec.entity]?.[spec.var];
              if (deps) {
                for (const d of deps) combined.add(d);
              }
            }
          }
        } else {
          combined = null;
        }
        propagate(needed, node.source, combined);
        break;
      }

      case 'ColumnValues': {
        // Needs its specific field from the source
        const fields = new Set([node.field]);
        propagate(needed, node.source, fields);
        break;
      }

      case 'Flatten': {
        propagate(needed, node.source, myNeeded);
        break;
      }

      case 'AddSwitch': {
        // AddSwitch adds node.column to rows from source.
        // Source needs: downstream columns (minus node.column, which AddSwitch provides)
        // plus all variables referenced in the case predicates.
        if (myNeeded === null) {
          propagate(needed, node.source, null);
        } else {
          const fromSource = new Set([...myNeeded].filter(f => f !== node.column));
          for (const c of node.cases) {
            for (const v of predicateVars(c.predicate)) fromSource.add(v);
          }
          propagate(needed, node.source, fromSource);
        }
        break;
      }

      case 'Zip':
      case 'Get':
      case 'Count':
      case 'Set':
      case 'Command':
      case 'ForEach':
        // These are terminals or don't propagate column needs
        break;
    }
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

// ── Main pass ───────────────────────────────────────────────────────────

export function pruneColumns(plan: EventPlan): EventPlan {
  const { nodes, result } = plan;
  if (nodes.length === 0) return plan;

  // Step 1: compute needed columns at each node
  const neededAt = computeNeededColumns(nodes, result);

  // Step 2: prune Zip columns
  let changed = false;
  const pruned = nodes.map((node, i) => {
    if (node.kind !== 'Zip') return node;

    const needed = neededAt.get(i);
    if (needed === null || needed === undefined) return node; // need all or not referenced

    const keptColumns = node.columns.filter(c => needed.has(c.name));
    if (keptColumns.length === node.columns.length) return node; // nothing to prune

    changed = true;
    return { ...node, columns: keptColumns } as EventNode;
  });

  if (!changed) return plan;

  // Step 3: find dead refs (refs no longer referenced by any node or result)
  const alive = new Set<Ref>();
  alive.add(result);
  for (let i = 0; i < pruned.length; i++) {
    if (!alive.has(i) && i !== result) {
      // Check if any other node references this one
    }
  }

  // Rebuild the alive set by walking from the result
  const reachable = new Set<Ref>();
  function markReachable(ref: Ref): void {
    if (reachable.has(ref)) return;
    if (ref < 0 || ref >= pruned.length) return;
    reachable.add(ref);
    const node = pruned[ref];
    for (const r of collectRefs(node)) {
      markReachable(r);
    }
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

  // Build compaction map
  const compact = new Map<Ref, Ref>();
  for (let newIdx = 0; newIdx < survivors.length; newIdx++) {
    compact.set(survivors[newIdx], newIdx);
  }

  function compactRef(r: Ref): Ref {
    const mapped = compact.get(r);
    if (mapped === undefined) {
      throw new Error(`pruneColumns: dangling ref ${r}`);
    }
    return mapped;
  }

  const compactedNodes = survivors.map(oldIdx =>
    rewriteNode(pruned[oldIdx], compactRef)
  );

  return {
    nodes: compactedNodes,
    result: compactRef(result),
  };
}
