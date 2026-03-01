/**
 * Variable Collector Backend.
 *
 * ExprBackend<Set<string>> that collects all variable names referenced
 * in an expression tree. Used by the planner to determine which properties
 * need to be bulk-read.
 */

import { type ExprBackend, type LoweredExpr, foldExpr } from '../fold.js';
import { type EntityType } from '../variables.js';
import { lowerExpr } from '../lower.js';

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Collect all variable names referenced in an expression.
 * Accepts compact syntax — lowers first.
 */
export function collectVars(where: unknown, entity: EntityType): Set<string> {
  const lowered = lowerExpr(where) as LoweredExpr;
  return collectVarsFromAst(lowered, entity);
}

/**
 * Collect all variable names from a lowered AST.
 */
export function collectVarsFromAst(ast: LoweredExpr, entity: EntityType): Set<string> {
  const backend = new VarCollectorBackend();
  return foldExpr(ast, backend, entity);
}

// ── Backend ─────────────────────────────────────────────────────────────

class VarCollectorBackend implements ExprBackend<Set<string>> {
  literal(): Set<string> {
    return new Set();
  }

  variable(name: string): Set<string> {
    return new Set([name]);
  }

  dateLiteral(): Set<string> {
    return new Set();
  }

  arrayLiteral(elements: Set<string>[]): Set<string> {
    return union(elements);
  }

  and(args: Set<string>[]): Set<string> {
    return union(args);
  }

  or(args: Set<string>[]): Set<string> {
    return union(args);
  }

  not(arg: Set<string>): Set<string> {
    return arg;
  }

  comparison(_op: string, left: Set<string>, right: Set<string>): Set<string> {
    return union([left, right]);
  }

  between(value: Set<string>, low: Set<string>, high: Set<string>): Set<string> {
    return union([value, low, high]);
  }

  inArray(value: Set<string>, array: Set<string>): Set<string> {
    return union([value, array]);
  }

  contains(haystack: Set<string>, needle: Set<string>): Set<string> {
    return union([haystack, needle]);
  }

  startsWith(str: Set<string>, prefix: Set<string>): Set<string> {
    return union([str, prefix]);
  }

  endsWith(str: Set<string>, suffix: Set<string>): Set<string> {
    return union([str, suffix]);
  }

  matches(str: Set<string>): Set<string> {
    return str;
  }

  offset(date: Set<string>): Set<string> {
    return date;
  }

  container(
    _type: 'project' | 'folder' | 'tag',
    subExpr: LoweredExpr,
    _fromEntity: EntityType,
    toEntity: EntityType,
    fold: (node: LoweredExpr, entity: EntityType) => Set<string>
  ): Set<string> {
    return fold(subExpr, toEntity);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function union(sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const s of sets) {
    for (const v of s) result.add(v);
  }
  return result;
}
