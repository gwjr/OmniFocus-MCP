/**
 * Query Planner.
 *
 * Analyzes a lowered AST and variable metadata to produce an execution plan
 * that determines how to run the query (direct JXA bulk-read vs OmniJS fallback).
 */

import { type LoweredExpr } from './fold.js';
import { getVarRegistry, computedVarDeps, type EntityType, type VarDef } from './variables.js';
import { collectVarsFromAst } from './backends/varCollector.js';
import type { PlanNode } from './planTree.js';

// ── Helpers ─────────────────────────────────────────────────────────────

interface CostClassification {
  easy: Set<string>;
  chain: Set<string>;
  perItem: Set<string>;
  expensive: Set<string>;
  computed: Set<string>;
}

function classifyVars(vars: Set<string>, registry: Record<string, VarDef>): CostClassification {
  const result: CostClassification = {
    easy: new Set(),
    chain: new Set(),
    perItem: new Set(),
    expensive: new Set(),
    computed: new Set(),
  };

  for (const name of vars) {
    // Skip 'now' — it's a special variable, not a property to read
    if (name === 'now') continue;

    const def = registry[name];
    if (!def) continue;

    switch (def.cost) {
      case 'easy': result.easy.add(name); break;
      case 'chain': result.chain.add(name); break;
      case 'per-item': result.perItem.add(name); break;
      case 'expensive': result.expensive.add(name); break;
      case 'computed': result.computed.add(name); break;
    }
  }

  return result;
}

/**
 * Expand computed var dependencies into the bulk var set.
 * Returns the full set of computed vars (from where + select).
 */
function expandComputedDeps(
  allComputed: Set<string>,
  entity: EntityType,
  bulkVarNames: Set<string>,
  registry: Record<string, VarDef>
): void {
  const entityDeps = computedVarDeps[entity];
  if (!entityDeps) return;

  for (const name of allComputed) {
    const deps = entityDeps[name];
    if (!deps) continue;
    for (const dep of deps) {
      bulkVarNames.add(dep);
    }
  }
}

// ── Plan Tree Builder ────────────────────────────────────────────────────

const PER_ITEM_THRESHOLD = 20;

/**
 * Build a PlanNode tree from a pre-lowered AST.
 * This is the new primary planning API.
 */
export function buildPlanTree(
  ast: LoweredExpr,
  entity: EntityType,
  selectVars?: string[],
  includeCompleted = false,
): PlanNode {
  // Rule 0: Perspectives → OmniJS fallback
  if (entity === 'perspectives') {
    return { kind: 'OmniJSScan', entity, filterAst: ast, includeCompleted };
  }

  // Rule 1: Tags with any container → OmniJS fallback
  if (entity === 'tags' && containsAnyContainer(ast)) {
    return { kind: 'OmniJSScan', entity, filterAst: ast, includeCompleted };
  }

  // Rule 2: folder container at any depth → OmniJS fallback
  if (containsFolderContainer(ast)) {
    return { kind: 'OmniJSScan', entity, filterAst: ast, includeCompleted };
  }

  // Collect referenced variables
  const neededVars = collectVarsFromAst(ast, entity);
  const registry = getVarRegistry(entity);
  const costMap = classifyVars(neededVars, registry);

  // Rule 3: expensive vars in the where clause → OmniJS fallback
  if (costMap.expensive.size > 0) {
    return { kind: 'OmniJSScan', entity, filterAst: ast, includeCompleted };
  }

  // Try to extract a project-scoped container
  const extraction = extractContainerScope(ast);

  // Rule 4: container present but not extractable → OmniJS fallback
  if (extraction === null && containsAnyContainer(ast)) {
    return { kind: 'OmniJSScan', entity, filterAst: ast, includeCompleted };
  }

  // Compute bulk columns (nodeKeys)
  const bulkVarNames = new Set([...costMap.easy, ...costMap.chain]);
  const perItemVars = new Set(costMap.perItem);
  const allComputed = new Set(costMap.computed);

  // Track which vars are needed for output (select)
  const selectBulkVars = new Set<string>();

  // Add select vars
  if (selectVars) {
    for (const v of selectVars) {
      const def = registry[v];
      if (!def) continue;
      if (def.cost === 'easy' || def.cost === 'chain') {
        bulkVarNames.add(v);
        selectBulkVars.add(v);
      } else if (def.cost === 'computed') {
        allComputed.add(v);
      } else if (def.cost === 'per-item' || def.cost === 'expensive') {
        perItemVars.add(v);
      }
    }
  }

  // Expand computed var dependencies into bulk vars
  expandComputedDeps(allComputed, entity, bulkVarNames, registry);

  const needsTwoPhase = perItemVars.size > 0;

  // Build column list as nodeKeys
  const columns = varNamesToColumns(bulkVarNames, registry);

  // If two-phase, need id in columns for per-item lookups
  if (needsTwoPhase && !columns.includes('id')) {
    columns.push('id');
  }

  // Build selectColumns as nodeKeys (for optimization passes to know what's output-required)
  const selectColumns = selectBulkVars.size > 0
    ? new Set(varNamesToColumns(selectBulkVars, registry))
    : undefined;

  // Use the remainder filter if project-scoped, otherwise full AST
  const filterAst = extraction ? extraction.remainder : ast;
  const projectScope = extraction?.scope;

  // Build the inner scan
  const scan: PlanNode = {
    kind: 'BulkScan',
    entity,
    columns,
    selectColumns,
    projectScope,
    includeCompleted,
    computedVars: allComputed.size > 0 ? allComputed : undefined,
  };

  if (!needsTwoPhase) {
    // Simple path: BulkScan → Filter (if needed)
    if (filterAst === true) return scan;
    return { kind: 'Filter', source: scan, predicate: filterAst, entity };
  }

  // Two-phase path
  const stubVars = new Set(costMap.perItem); // only where-clause per-item vars get stubbed

  // OmniJS fallback for if threshold is exceeded
  const fallback: PlanNode = {
    kind: 'OmniJSScan',
    entity,
    filterAst: ast, // full AST for fallback (includes container if any)
    includeCompleted,
  };

  // Build: Filter → PerItemEnrich → PreFilter → BulkScan
  const preFilter: PlanNode = stubVars.size > 0
    ? { kind: 'PreFilter', source: scan, predicate: filterAst, entity, assumeTrue: stubVars }
    : scan;

  const enrich: PlanNode = {
    kind: 'PerItemEnrich',
    source: preFilter,
    perItemVars,
    entity,
    threshold: PER_ITEM_THRESHOLD,
    fallback,
  };

  // Exact re-filter after enrichment (no stubs)
  const filter: PlanNode = {
    kind: 'Filter',
    source: enrich,
    predicate: filterAst,
    entity,
  };

  return filter;
}

function varNamesToColumns(varNames: Set<string>, registry: Record<string, VarDef>): string[] {
  const columns: string[] = [];
  for (const name of varNames) {
    if (name === 'now') continue;
    const def = registry[name];
    if (!def) continue;
    if (!columns.includes(def.nodeKey)) {
      columns.push(def.nodeKey);
    }
  }
  return columns;
}

// ── Scope Compilation Check ─────────────────────────────────────────────

/** Check if a scope expression can be compiled to a .whose() clause by generateScopeWhose */
function canCompileScope(scope: LoweredExpr): boolean {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return false;
  if (!('op' in scope)) return false;
  const node = scope as { op: string; args: LoweredExpr[] };
  if ((node.op === 'eq' || node.op === 'contains') &&
      isVarRef(node.args[0], 'name') && typeof node.args[1] === 'string') {
    return true;
  }
  return false;
}

function isVarRef(node: LoweredExpr, name: string): boolean {
  return typeof node === 'object' && node !== null && !Array.isArray(node) &&
    'var' in node && (node as { var: string }).var === name;
}

// ── Container Extraction ────────────────────────────────────────────────

interface ContainerExtraction {
  /** The project-scope predicate */
  scope: LoweredExpr;
  /** Remainder filter (literal true if nothing left) */
  remainder: LoweredExpr;
}

/**
 * Opportunistic container extraction — syntactically obvious only.
 *
 * - Top-level container("project", ...) → extract
 * - Top-level and([..., container("project", ...), ...]) → extract container, keep rest
 * - Under or, not, nested and → do not attempt
 *
 * Never changes semantics: if extraction fails, query runs via broad path.
 */
export function extractContainerScope(ast: LoweredExpr): ContainerExtraction | null {
  if (typeof ast !== 'object' || ast === null || Array.isArray(ast)) return null;
  if (!('op' in ast)) return null;

  const node = ast as { op: string; args: LoweredExpr[] };

  // Top-level container("project", ...)
  if (node.op === 'container') {
    const containerType = node.args[0] as unknown as string;
    if (containerType === 'project') {
      if (!canCompileScope(node.args[1])) return null;
      return {
        scope: node.args[1],
        remainder: true
      };
    }
    return null;
  }

  // Top-level and — look for a container("project", ...) conjunct
  if (node.op === 'and') {
    const containerIdx = node.args.findIndex(arg => {
      if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return false;
      if (!('op' in arg)) return false;
      const a = arg as { op: string; args: LoweredExpr[] };
      return a.op === 'container' && (a.args[0] as unknown as string) === 'project' &&
        canCompileScope(a.args[1]);
    });

    if (containerIdx === -1) return null;

    const containerNode = node.args[containerIdx] as { op: string; args: LoweredExpr[] };
    const remaining = node.args.filter((_, i) => i !== containerIdx);

    return {
      scope: containerNode.args[1],
      remainder: remaining.length === 1 ? remaining[0] : { op: 'and', args: remaining }
    };
  }

  return null;
}

// ── Container Detection ─────────────────────────────────────────────────

/**
 * Check if an AST contains any container node at any depth.
 */
function containsAnyContainer(ast: LoweredExpr): boolean {
  if (typeof ast !== 'object' || ast === null) return false;
  if (Array.isArray(ast)) return ast.some(containsAnyContainer);

  const obj = ast as Record<string, unknown>;

  if ('op' in obj) {
    const node = obj as { op: string; args: LoweredExpr[] };
    if (node.op === 'container') return true;
    return node.args.some(containsAnyContainer);
  }

  return false;
}

/**
 * Check if an AST contains a folder container at any depth.
 */
function containsFolderContainer(ast: LoweredExpr): boolean {
  if (typeof ast !== 'object' || ast === null) return false;
  if (Array.isArray(ast)) return ast.some(containsFolderContainer);

  const obj = ast as Record<string, unknown>;

  if ('op' in obj) {
    const node = obj as { op: string; args: LoweredExpr[] };
    if (node.op === 'container') {
      return (node.args[0] as unknown as string) === 'folder';
    }
    return node.args.some(containsFolderContainer);
  }

  return false;
}
