/**
 * Node ExecutionUnit executor.
 *
 * Executes a Node-runtime ExecutionUnit directly against in-memory data
 * (row arrays, id sets, scalar values) produced by upstream units.
 *
 * All node-side ops: Zip, Filter, SemiJoin, HashJoin, Sort, Limit, Pick,
 * Derive, ColumnValues, Flatten.
 */

import type { EventNode, Ref } from '../eventPlan.js';
import type { TargetedEventPlan } from '../targetedEventPlan.js';
import type { ExecutionUnit } from '../targetedEventPlan.js';
import { compileNodePredicate, type Row } from '../backends/nodeEval.js';
import { getVarRegistry, type EntityType } from '../variables.js';

// ── Computed var derivers (mirrored from executor.ts) ───────────────────

const DUE_SOON_MS = 7 * 24 * 60 * 60 * 1000;

function deriveTaskStatus(row: Row): string {
  if (row.completed) return 'Completed';
  if (row.dropped) return 'Dropped';
  if (row.blocked) return 'Blocked';
  if (row.dueDate) {
    const due = new Date(row.dueDate as string).getTime();
    const now = Date.now();
    if (due < now) return 'Overdue';
    if (due < now + DUE_SOON_MS) return 'DueSoon';
  }
  return 'Next';
}

function deriveTaskHasChildren(row: Row): boolean {
  return (row.childCount as number) > 0;
}

function deriveFolderStatus(row: Row): string {
  return row.hidden ? 'Dropped' : 'Active';
}

type RowDeriver = (row: Row) => unknown;

const computedVarDerivers: Record<string, Record<string, RowDeriver>> = {
  tasks: {
    status: deriveTaskStatus,
    hasChildren: deriveTaskHasChildren,
  },
  folders: {
    status: deriveFolderStatus,
  },
};

// ── Execution context ───────────────────────────────────────────────────

interface ExecCtx {
  plan: TargetedEventPlan;
  /** Map from Ref → already-computed value (populated by upstream units and earlier nodes). */
  results: Map<number, unknown>;
}

function resolve(ctx: ExecCtx, ref: Ref): unknown {
  const val = ctx.results.get(ref);
  if (val === undefined && !ctx.results.has(ref)) {
    throw new Error(`nodeUnit: unresolved ref %${ref}`);
  }
  return val;
}

// ── Node dispatch ───────────────────────────────────────────────────────

function execNode(ctx: ExecCtx, ref: Ref): unknown {
  const node = ctx.plan.nodes[ref];

  switch (node.kind) {
    case 'Zip':          return execZip(ctx, node);
    case 'Filter':       return execFilter(ctx, ref, node);
    case 'SemiJoin':     return execSemiJoin(ctx, node);
    case 'HashJoin':     return execHashJoin(ctx, node);
    case 'Sort':         return execSort(ctx, node);
    case 'Limit':        return execLimit(ctx, node);
    case 'Pick':         return execPick(ctx, node);
    case 'Derive':       return execDerive(ctx, node);
    case 'ColumnValues': return execColumnValues(ctx, node);
    case 'Flatten':      return execFlatten(ctx, node);
    case 'Union':        return execUnion(ctx, node);
    case 'RowCount':     return execRowCount(ctx, node);
    case 'AddSwitch':    return execAddSwitch(ctx, ref, node);
    case 'SetOp':        return execSetOp(ctx, node);
    default:
      throw new Error(`nodeUnit: unexpected node kind '${node.kind}' in Node unit (ref %${ref})`);
  }
}

// ── Op implementations ──────────────────────────────────────────────────

function execZip(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'Zip' }>,
): Row[] {
  if (node.columns.length === 0) return [];

  // Resolve all column arrays
  const columns = node.columns.map(col => ({
    name: col.name,
    values: resolve(ctx, col.ref) as unknown[],
  }));

  // All columns must have the same length
  const len = columns[0].values.length;
  for (const col of columns) {
    if (col.values.length !== len) {
      throw new Error(
        `nodeUnit Zip: column '${col.name}' has length ${col.values.length}, expected ${len}`
      );
    }
  }

  const rows: Row[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const row: Row = {};
    for (const col of columns) {
      row[col.name] = col.values[i];
    }
    rows[i] = row;
  }
  return rows;
}

function execFilter(
  ctx: ExecCtx,
  ref: Ref,
  node: Extract<EventNode, { kind: 'Filter' }>,
  limit?: number,
): Row[] {
  const source = resolve(ctx, node.source) as Row[];

  // Defensive: identity filter (null/true predicate) passes through unchanged.
  // Should be eliminated earlier by normalize or lowering, but guard here too.
  if (node.predicate === null || node.predicate === true) {
    return limit !== undefined ? source.slice(0, limit) : source;
  }

  // Use entity annotation if present; fall back to inference
  const entity = node.entity ?? inferEntity(ctx, node.source);
  const predicate = compileNodePredicate(node.predicate, entity);

  // Short-circuit: stop after `limit` matches when fused with a downstream Limit
  if (limit !== undefined) {
    const result: Row[] = [];
    for (const row of source) {
      if (predicate(row)) {
        result.push(row);
        if (result.length >= limit) break;
      }
    }
    return result;
  }

  return source.filter(row => !!predicate(row));
}

function execSemiJoin(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'SemiJoin' }>,
): Row[] {
  const source = resolve(ctx, node.source) as Row[];
  const idsRaw = resolve(ctx, node.ids);
  const ids = idsRaw instanceof Set
    ? idsRaw as Set<string>
    : new Set(idsRaw as string[]);

  const field      = node.field ?? 'id';
  const arrayField = node.arrayField ?? false;

  if (node.exclude) {
    return source.filter(row => {
      const fk = row[field];
      if (arrayField) {
        if (!Array.isArray(fk) || fk.length === 0) return true;
        return !(fk as string[]).some(v => ids.has(v));
      }
      return fk == null || !ids.has(fk as string);
    });
  }

  return source.filter(row => {
    const fk = row[field];
    if (arrayField) {
      if (!Array.isArray(fk) || fk.length === 0) return false;
      return (fk as string[]).some(v => ids.has(v));
    }
    return fk != null && ids.has(fk as string);
  });
}

function execHashJoin(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'HashJoin' }>,
): Row[] {
  const source = resolve(ctx, node.source) as Row[];
  const lookup = resolve(ctx, node.lookup) as Row[];

  // Mutates source rows in place (row[outputField] = value). Safe because the
  // EventPlan SSA invariant guarantees each Ref has exactly one consumer —
  // CSE eliminates structural duplicates before targeting, so no two HashJoin
  // nodes can share the same source Ref and observe each other's mutations.

  // Check for count-aggregation mode: fieldMap = {'*': outputVarName}
  if ('*' in node.fieldMap) {
    const outputVar = node.fieldMap['*'];
    const countMap = new Map<string, number>();
    for (const row of lookup) {
      const key = row[node.lookupKey];
      if (key != null) {
        const k = String(key);
        countMap.set(k, (countMap.get(k) || 0) + 1);
      }
    }
    for (const row of source) {
      const sk = row[node.sourceKey];
      row[outputVar] = sk != null ? (countMap.get(String(sk)) || 0) : 0;
    }
    return source;
  }

  // Direct join mode: build lookup index
  const lookupMap = new Map<string, Row>();
  for (const row of lookup) {
    const key = row[node.lookupKey];
    if (key != null) {
      lookupMap.set(String(key), row);
    }
  }

  for (const row of source) {
    const fk = row[node.sourceKey];
    if (fk != null) {
      const lookupRow = lookupMap.get(String(fk));
      if (lookupRow) {
        for (const [lookupField, outputField] of Object.entries(node.fieldMap)) {
          row[outputField] = lookupRow[lookupField];
        }
      } else {
        for (const outputField of Object.values(node.fieldMap)) {
          row[outputField] = null;
        }
      }
    } else {
      for (const outputField of Object.values(node.fieldMap)) {
        row[outputField] = null;
      }
    }
  }
  return source;
}

function execSort(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'Sort' }>,
): Row[] {
  const source = resolve(ctx, node.source) as Row[];
  const rows = [...source]; // clone to avoid mutation
  const order = node.dir === 'desc' ? -1 : 1;
  const key = node.by;

  rows.sort((a, b) => {
    let aVal = a[key] as any;
    let bVal = b[key] as any;

    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      const at = Date.parse(aVal);
      const bt = Date.parse(bVal);
      if (!isNaN(at) && !isNaN(bt)) return (at - bt) * order;
      return aVal.localeCompare(bVal) * order;
    }

    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return (aVal - bVal) * order;
    }

    return 0;
  });

  return rows;
}

function execLimit(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'Limit' }>,
): Row[] {
  const source = resolve(ctx, node.source) as Row[];
  return source.slice(0, node.n);
}

function execPick(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'Pick' }>,
): Row[] {
  const source = resolve(ctx, node.source) as Row[];
  return source.map(row => {
    const picked: Row = {};
    for (const field of node.fields) {
      if (field in row) {
        picked[field] = row[field];
      }
    }
    return picked;
  });
}

function execDerive(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'Derive' }>,
): Row[] {
  const source = resolve(ctx, node.source) as Row[];

  for (const spec of node.derivations) {
    const derivers = computedVarDerivers[spec.entity];
    if (!derivers) continue;
    const derive = derivers[spec.var];
    if (!derive) continue;
    for (const row of source) {
      row[spec.var] = derive(row);
    }
  }

  return source;
}

function execColumnValues(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'ColumnValues' }>,
): unknown[] {
  const source = resolve(ctx, node.source) as Row[];
  return source.map(row => row[node.field]);
}

function execFlatten(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'Flatten' }>,
): unknown[] {
  const source = resolve(ctx, node.source) as unknown[][];
  return ([] as unknown[]).concat(...source);
}

function execUnion(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'Union' }>,
): Row[] {
  const left  = resolve(ctx, node.left)  as Row[];
  const right = resolve(ctx, node.right) as Row[];
  const seen   = new Set<string>();
  const result: Row[] = [];
  for (const row of left) {
    const id = row.id as string;
    if (!seen.has(id)) { seen.add(id); result.push(row); }
  }
  for (const row of right) {
    const id = row.id as string;
    if (!seen.has(id)) { seen.add(id); result.push(row); }
  }
  return result;
}

function execAddSwitch(
  ctx: ExecCtx,
  ref: Ref,
  node: Extract<EventNode, { kind: 'AddSwitch' }>,
): Row[] {
  const source = resolve(ctx, node.source) as Row[];
  const entity = node.entity ?? inferEntity(ctx, node.source);

  // Pre-compile all case predicates once
  const compiledCases = node.cases.map(c => ({
    test: compileNodePredicate(c.predicate, entity),
    value: c.value,
  }));

  const isError = node.default === 'error';

  for (const row of source) {
    let matched = false;
    for (const { test, value } of compiledCases) {
      if (test(row)) {
        row[node.column] = evalSwitchValue(value);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (isError) {
        throw new Error(
          `AddSwitch: exhaustive switch on '${node.column}' had no matching case ` +
          `(ref %${ref})`
        );
      }
      row[node.column] = evalSwitchValue(node.default as import('../fold.js').LoweredExpr);
    }
  }

  return source;
}

/** Evaluate a literal LoweredExpr value (string, number, boolean, null only). */
function evalSwitchValue(expr: import('../fold.js').LoweredExpr): unknown {
  if (expr === null || typeof expr === 'boolean' || typeof expr === 'number' || typeof expr === 'string') {
    return expr;
  }
  throw new Error(`AddSwitch: unsupported non-literal value expression: ${JSON.stringify(expr)}`);
}

function execRowCount(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'RowCount' }>,
): number {
  return (resolve(ctx, node.source) as Row[]).length;
}

function execSetOp(
  ctx: ExecCtx,
  node: Extract<EventNode, { kind: 'SetOp' }>,
): Set<string> {
  const leftRaw  = resolve(ctx, node.left);
  const rightRaw = resolve(ctx, node.right);

  const leftSet  = leftRaw  instanceof Set ? leftRaw  as Set<string> : new Set(leftRaw  as string[]);
  const rightSet = rightRaw instanceof Set ? rightRaw as Set<string> : new Set(rightRaw as string[]);

  if (node.op === 'intersect') {
    // Return elements in both sets
    const result = new Set<string>();
    for (const v of leftSet) {
      if (rightSet.has(v)) result.add(v);
    }
    return result;
  }

  // subtract: left \ right
  const result = new Set<string>();
  for (const v of leftSet) {
    if (!rightSet.has(v)) result.add(v);
  }
  return result;
}

// ── Entity inference ────────────────────────────────────────────────────

/**
 * Walk the source chain backwards to find a Derive node that carries entity
 * info, and return its entity type.
 *
 * For Filter and AddSwitch nodes, we need to know the entity to compile the
 * predicate. The lowering pass injects `entity` directly on all Filter and
 * AddSwitch nodes it emits, so in practice this function is never called on
 * a node that actually needs inference. If it ever is — because a future
 * caller omits the entity annotation — it throws rather than silently
 * returning 'tasks' (which would produce wrong predicate behaviour for
 * non-task entities).
 */
function inferEntity(ctx: ExecCtx, ref: Ref): EntityType {
  const visited = new Set<Ref>();
  let current: Ref | null = ref;

  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const node = ctx.plan.nodes[current];

    // Derive nodes carry entity info
    if (node.kind === 'Derive' && node.derivations.length > 0) {
      return node.derivations[0].entity;
    }

    // Walk source chain
    if ('source' in node && typeof (node as any).source === 'number') {
      current = (node as any).source as Ref;
    } else {
      current = null;
    }
  }

  // The lowering pass injects `entity` on all Filter/AddSwitch nodes it
  // emits, so this should never be reached. If it is, the caller omitted
  // an entity annotation — throw rather than silently returning the wrong entity.
  throw new Error(
    `nodeUnit: cannot infer entity for ref %${ref} — ` +
    `Filter and AddSwitch nodes must carry an explicit 'entity' annotation. ` +
    `This is a lowering bug.`
  );
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Execute a Node ExecutionUnit directly against in-memory row arrays.
 *
 * @param unit    The ExecutionUnit to execute (runtime must be 'node')
 * @param plan    The full TargetedEventPlan (for node lookup by Ref)
 * @param results Map from Ref → already-computed value (populated by upstream units)
 * @returns       The result value (row array or scalar)
 */
export function executeNodeUnit(
  unit: ExecutionUnit,
  plan: TargetedEventPlan,
  results: Map<number, unknown>,
): unknown {
  if (unit.runtime !== 'node') {
    throw new Error(`executeNodeUnit: expected runtime 'node', got '${unit.runtime}'`);
  }

  const ctx: ExecCtx = { plan, results };

  // Pre-compute Filter+Limit fusion opportunities.
  // A Filter can be fused with a downstream Limit if:
  //   (1) the Limit's source is the Filter's ref
  //   (2) no other node in the unit consumes the Filter's ref
  const fusedFilters = detectFilterLimitFusion(unit, plan);

  // Execute nodes in SSA order
  for (const ref of unit.nodes) {
    // Skip Filter nodes that will be fused into their downstream Limit
    if (fusedFilters.has(ref)) continue;

    const node = plan.nodes[ref];

    // Fused Limit: execute the source Filter with a limit hint
    if (node.kind === 'Limit' && fusedFilters.has(node.source)) {
      const filterNode = plan.nodes[node.source] as Extract<EventNode, { kind: 'Filter' }>;
      const filterResult = execFilter(ctx, node.source, filterNode, node.n);
      results.set(node.source, filterResult);
      results.set(ref, filterResult);  // Limit result = fused result (already truncated)
      continue;
    }

    const value = execNode(ctx, ref);
    results.set(ref, value);
  }

  return results.get(unit.result);
}

/**
 * Detect Filter refs that can be fused with a downstream Limit.
 *
 * A Filter at ref F is fusable if:
 *   - There exists a Limit node L in the same unit with L.source === F
 *   - No other node in the unit references F (the Filter result is only
 *     consumed by the Limit, so short-circuiting doesn't drop rows that
 *     another node needs)
 *
 * Returns a Set of Filter refs that should be fused (skipped during
 * standalone execution and handled by their Limit instead).
 */
function detectFilterLimitFusion(
  unit: ExecutionUnit,
  plan: TargetedEventPlan,
): Set<Ref> {
  const unitNodes = new Set(unit.nodes);
  const fused = new Set<Ref>();

  // Count how many times each ref is consumed within this unit
  const refConsumers = new Map<Ref, number>();
  for (const ref of unit.nodes) {
    const node = plan.nodes[ref];
    for (const inputRef of collectNodeInputRefs(node)) {
      if (unitNodes.has(inputRef)) {
        refConsumers.set(inputRef, (refConsumers.get(inputRef) || 0) + 1);
      }
    }
  }

  // Find Limit nodes whose source is a Filter with exactly 1 consumer (the Limit itself)
  for (const ref of unit.nodes) {
    const node = plan.nodes[ref];
    if (node.kind !== 'Limit') continue;
    if (!unitNodes.has(node.source)) continue;

    const sourceNode = plan.nodes[node.source];
    if (sourceNode.kind !== 'Filter') continue;

    const consumers = refConsumers.get(node.source) || 0;
    if (consumers === 1) {
      fused.add(node.source);
    }
  }

  return fused;
}

/** Extract input refs from a node (subset of collectRefs from eventPlanUtils). */
function collectNodeInputRefs(node: EventNode): Ref[] {
  switch (node.kind) {
    case 'Filter':
    case 'Sort':
    case 'Limit':
    case 'Pick':
    case 'Derive':
    case 'ColumnValues':
    case 'Flatten':
    case 'RowCount':
    case 'AddSwitch':
      return [(node as { source: Ref }).source];
    case 'SemiJoin':
      return [node.source, node.ids];
    case 'HashJoin':
      return [node.source, node.lookup];
    case 'Union':
    case 'SetOp':
      return [(node as { left: Ref }).left, (node as { right: Ref }).right];
    case 'Zip':
      return node.columns.map(c => c.ref);
    case 'ForEach':
      return [node.source];
    default:
      return [];
  }
}
