/**
 * Query Planner.
 *
 * Analyzes a lowered AST and variable metadata to produce an execution plan
 * that determines how to run the query (direct JXA bulk-read vs OmniJS fallback).
 */

import { type LoweredExpr } from './fold.js';
import { getVarRegistry, type EntityType, type VarDef } from './variables.js';
import { collectVarsFromAst } from './backends/varCollector.js';
import { lowerExpr } from './lower.js';

// ── Types ───────────────────────────────────────────────────────────────

export type ExecutionPath = 'project-scoped' | 'broad' | 'two-phase' | 'omnijs-fallback';

export interface ExecutionPlan {
  path: ExecutionPath;
  /** Project scope predicate (lowered AST), if path is 'project-scoped' */
  projectScope?: LoweredExpr;
  /** Filter AST (full filter, literal(true) if none) */
  filterAst: LoweredExpr;
  /** All vars referenced in the filter */
  neededVars: Set<string>;
  /** Vars to bulk-read in phase 1 */
  bulkVars: Set<string>;
  /** Vars to read per-item in phase 2 (two-phase only) */
  perItemVars?: Set<string>;
  /** Vars to stub as true in phase 1 eval (two-phase only) */
  stubVars?: Set<string>;
  /** Entity type */
  entity: EntityType;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Plan the execution strategy for a query.
 * Accepts compact syntax where clause and entity type.
 */
export function planExecution(
  where: unknown,
  entity: EntityType,
  selectVars?: string[]
): ExecutionPlan {
  const ast = (where != null ? lowerExpr(where) : true) as LoweredExpr;
  return planFromAst(ast, entity, selectVars);
}

/**
 * Plan from a pre-lowered AST.
 */
export function planFromAst(
  ast: LoweredExpr,
  entity: EntityType,
  selectVars?: string[]
): ExecutionPlan {
  // Rule 1: Non-task entities → OmniJS fallback
  if (entity === 'projects' || entity === 'folders') {
    return fallbackPlan(ast, entity);
  }

  // Rule 2: folder container at any depth → OmniJS fallback
  if (containsFolderContainer(ast)) {
    return fallbackPlan(ast, entity);
  }

  // Collect referenced variables
  const neededVars = collectVarsFromAst(ast, entity);
  const registry = getVarRegistry(entity);

  // Check var costs
  const costMap = classifyVars(neededVars, registry);

  // Rule 3: expensive vars in the where clause → OmniJS fallback
  if (costMap.expensive.size > 0) {
    return fallbackPlan(ast, entity);
  }

  // Try to extract a project-scoped container
  const extraction = extractContainerScope(ast);

  // Compute bulk vars: all easy + chain vars
  const bulkVars = new Set([...costMap.easy, ...costMap.chain]);

  // Collect per-item vars needed: from where + from select
  const perItemVars = new Set(costMap.perItem);

  // Add select vars to appropriate sets
  if (selectVars) {
    for (const v of selectVars) {
      const def = registry[v];
      if (!def) continue;
      if (def.cost === 'easy' || def.cost === 'chain') {
        bulkVars.add(v);
      } else if (def.cost === 'per-item' || def.cost === 'expensive') {
        perItemVars.add(v);
      }
    }
  }

  // Determine if we need two-phase (per-item vars in where OR in select)
  const needsTwoPhase = perItemVars.size > 0;

  if (needsTwoPhase) {
    // Two-phase: stub per-item where vars in phase 1, load all per-item in phase 2
    // Only stub vars that are actually in the where clause (not select-only vars)
    const stubVars = new Set(costMap.perItem);

    if (extraction) {
      return {
        path: 'project-scoped',
        projectScope: extraction.scope,
        filterAst: extraction.remainder,
        neededVars,
        bulkVars,
        perItemVars,
        stubVars,
        entity
      };
    }

    return {
      path: 'two-phase',
      filterAst: ast,
      neededVars,
      bulkVars,
      perItemVars,
      stubVars,
      entity
    };
  }

  // All easy/chain vars — broad or project-scoped
  if (extraction) {
    return {
      path: 'project-scoped',
      projectScope: extraction.scope,
      filterAst: extraction.remainder,
      neededVars,
      bulkVars,
      entity
    };
  }

  return {
    path: 'broad',
    filterAst: ast,
    neededVars,
    bulkVars,
    entity
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function fallbackPlan(ast: LoweredExpr, entity: EntityType): ExecutionPlan {
  return {
    path: 'omnijs-fallback',
    filterAst: ast,
    neededVars: new Set(),
    bulkVars: new Set(),
    entity
  };
}

interface CostClassification {
  easy: Set<string>;
  chain: Set<string>;
  perItem: Set<string>;
  expensive: Set<string>;
}

function classifyVars(vars: Set<string>, registry: Record<string, VarDef>): CostClassification {
  const result: CostClassification = {
    easy: new Set(),
    chain: new Set(),
    perItem: new Set(),
    expensive: new Set()
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
    }
  }

  return result;
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
      return a.op === 'container' && (a.args[0] as unknown as string) === 'project';
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

// ── Folder Container Detection ──────────────────────────────────────────

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
