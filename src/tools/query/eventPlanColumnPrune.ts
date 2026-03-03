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

      case 'Union': {
        // Union deduplicates rows by row.id (see execUnion in nodeUnit.ts).
        // Always preserve 'id' on both sides so deduplication is correct.
        const unionNeeded = myNeeded ? union(myNeeded, new Set(['id'])) : null;
        propagate(needed, node.left, unionNeeded);
        propagate(needed, node.right, unionNeeded);
        break;
      }

      case 'RowCount': {
        // RowCount only needs the row count — no column values are required.
        // Propagate an empty set so intermediate Filter/SemiJoin nodes can
        // add only the columns they actually need (predicate vars, join key).
        // This avoids the spurious 'id' bulk read that new Set(['id']) forced.
        //
        // Note: if there is no Filter/SemiJoin between RowCount and Zip (which
        // can't happen in practice because predicate===true uses the native
        // fast-path), the Zip would receive an empty needed set and produce [].
        // That edge case is already short-circuited before reaching this path.
        propagate(needed, node.source, new Set());
        break;
      }

      case 'SetOp': {
        // SetOp operates on id arrays, not row columns — propagate null (all)
        propagate(needed, node.left, null);
        propagate(needed, node.right, null);
        break;
      }

      case 'ForEach': {
        // ForEach iterates source (a flat array, e.g. from ColumnValues).
        // The source doesn't carry row columns — propagate null.
        propagate(needed, node.source, null);
        // Propagate needed columns into the body Zip (at body[collect]).
        // myNeeded tells us what columns the outer plan needs from this
        // ForEach's collected output. The body Zip produces those columns.
        // We don't recurse further into body Get nodes here — that's
        // handled by the body-pruning step in pruneColumns().
        break;
      }

      case 'Zip':
      case 'Get':
      case 'Count':
      case 'Set':
      case 'Command':
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
