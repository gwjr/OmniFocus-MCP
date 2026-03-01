/**
 * JXA Compiler Backend.
 *
 * ExprBackend<string> that produces JXA boolean expression strings
 * for use inside a .filter() callback. Uses the fold pattern from fold.ts.
 */

import { type ExprBackend, type LoweredExpr, foldExpr } from '../fold.js';
import { getVarRegistry, type EntityType } from '../variables.js';
import { lowerExpr, LowerError } from '../lower.js';

// ── Public API ──────────────────────────────────────────────────────────

export class CompileError extends Error {
  constructor(message: string, public path: string, public node: unknown) {
    super(message);
    this.name = 'CompileError';
  }
}

export interface CompileResult {
  /** JXA boolean expression string */
  condition: string;
  /** Preamble lines to insert before the .filter() call */
  preamble: string[];
}

/**
 * Compile a `where` expression tree into a JXA filter condition.
 * Accepts compact syntax (public API) — lowers to internal AST first.
 */
export function compileWhere(where: unknown, entity: EntityType): CompileResult {
  // Phase 1: lower compact syntax → internal AST
  let lowered: LoweredExpr;
  try {
    lowered = lowerExpr(where) as LoweredExpr;
  } catch (e) {
    if (e instanceof LowerError) {
      throw new CompileError(e.message, e.path, e.node);
    }
    throw e;
  }

  // Phase 2: fold through JXA backend
  const backend = new JxaCompilerBackend('item');
  const condition = foldExpr(lowered, backend, entity);
  return { condition, preamble: backend.preamble };
}

// Re-export LowerError so callers can catch either
export { LowerError };

// ── String Escaping ─────────────────────────────────────────────────────

/**
 * Escape a string for safe embedding in a JXA double-quoted string literal.
 */
export function escapeJxaString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0');
}

// ── JXA Compiler Backend ────────────────────────────────────────────────

class JxaCompilerBackend implements ExprBackend<string> {
  private _preamble: string[] = [];
  private _counter = 0;
  private _itemVar: string;

  constructor(itemVar: string) {
    this._itemVar = itemVar;
  }

  get preamble(): string[] { return this._preamble; }

  private freshVar(prefix: string): string {
    return `_${prefix}${this._counter++}`;
  }

  // ── Leaves ──────────────────────────────────────────────────────────

  literal(value: string | number | boolean | null): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${escapeJxaString(value)}"`;
    return String(value);
  }

  variable(name: string, entity: EntityType): string {
    const registry = getVarRegistry(entity);
    const varDef = registry[name];

    if (!varDef) {
      const suggestion = getVarSuggestion(name, entity);
      throw new CompileError(
        `Unknown variable "${name}" for entity "${entity}". ${suggestion}Available vars: ${Object.keys(registry).join(', ')}`,
        'where',
        { var: name }
      );
    }

    return varDef.jxa(this._itemVar);
  }

  dateLiteral(isoDate: string): string {
    const dVar = this.freshVar('d');
    this._preamble.push(`var ${dVar}=new Date("${escapeJxaString(isoDate)}");`);
    return dVar;
  }

  arrayLiteral(elements: string[]): string {
    return `[${elements.join(',')}]`;
  }

  // ── Logical ─────────────────────────────────────────────────────────

  and(args: string[]): string {
    return `(${args.join(' && ')})`;
  }

  or(args: string[]): string {
    return `(${args.join(' || ')})`;
  }

  not(arg: string): string {
    return `(!(${arg}))`;
  }

  // ── Comparison ──────────────────────────────────────────────────────

  comparison(op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte', left: string, right: string): string {
    switch (op) {
      case 'eq':
        return `_eq(${left},${right})`;
      case 'neq':
        return `(!_eq(${left},${right}))`;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const jsOp = op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : '<=';
        return `(${left} != null && ${right} != null && ${left} ${jsOp} ${right})`;
      }
    }
  }

  // ── Range ───────────────────────────────────────────────────────────

  between(value: string, low: string, high: string): string {
    // Desugar to gte + lte with null guards
    return `(${value} != null && ${low} != null && ${high} != null && ${value} >= ${low} && ${value} <= ${high})`;
  }

  // ── Set Membership ──────────────────────────────────────────────────

  inArray(value: string, array: string): string {
    return `(${array}.indexOf(${value}) !== -1)`;
  }

  // ── String/Array Ops ────────────────────────────────────────────────

  contains(haystack: string, needle: string, haystackIsArray: boolean): string {
    if (haystackIsArray) {
      // Array contains — array is already lowercased
      const raw = extractJxaStringLiteral(needle);
      if (raw !== null) {
        // Compile-time lowercase the search term
        return `(${haystack}.indexOf("${escapeJxaString(raw.toLowerCase())}") !== -1)`;
      }
      return `(${haystack}.indexOf(${needle}.toLowerCase()) !== -1)`;
    }
    // String contains — case-insensitive
    const raw = extractJxaStringLiteral(needle);
    if (raw !== null) {
      return `(${haystack}.toLowerCase().indexOf("${escapeJxaString(raw.toLowerCase())}") !== -1)`;
    }
    return `(${haystack}.toLowerCase().indexOf(${needle}.toLowerCase()) !== -1)`;
  }

  startsWith(str: string, prefix: string): string {
    const raw = extractJxaStringLiteral(prefix);
    if (raw !== null) {
      return `(${str}.toLowerCase().lastIndexOf("${escapeJxaString(raw.toLowerCase())}",0) === 0)`;
    }
    return `(${str}.toLowerCase().lastIndexOf(${prefix}.toLowerCase(),0) === 0)`;
  }

  endsWith(str: string, suffix: string): string {
    const raw = extractJxaStringLiteral(suffix);
    if (raw !== null) {
      const lowered = escapeJxaString(raw.toLowerCase());
      return `(function(){var _s=${str}.toLowerCase();return _s.length>=${raw.length}&&_s.indexOf("${lowered}",_s.length-${raw.length})!==-1;})()`;
    }
    return `(function(){var _s=${str}.toLowerCase(),_p=${suffix}.toLowerCase();return _s.length>=_p.length&&_s.indexOf(_p,_s.length-_p.length)!==-1;})()`;
  }

  matches(str: string, pattern: string): string {
    const rVar = this.freshVar('r');
    this._preamble.push(`var ${rVar}=new RegExp("${escapeJxaString(pattern)}","i");`);
    return `(${rVar}.test(${str}))`;
  }

  // ── Date Arithmetic ─────────────────────────────────────────────────

  offset(date: string, days: number): string {
    const dVar = this.freshVar('d');
    this._preamble.push(`var ${dVar}=new Date(${date}.getTime());${dVar}.setDate(${dVar}.getDate()+${days});`);
    return dVar;
  }

  // ── Container Scoping ───────────────────────────────────────────────

  container(
    type: 'project' | 'folder' | 'tag',
    subExpr: LoweredExpr,
    fromEntity: EntityType,
    toEntity: EntityType,
    fold: (node: LoweredExpr, entity: EntityType) => string
  ): string {
    // Tag containers: only valid for tags entity, walk parent tag chain
    if (type === 'tag') {
      if (fromEntity !== 'tags') {
        throw new CompileError(`"container" with "tag" is not valid for entity "${fromEntity}"`, 'where', { op: 'container' });
      }
      const cVar = this.freshVar('c');
      const saved = this._itemVar;
      this._itemVar = cVar;
      const compiled = fold(subExpr, toEntity);
      this._itemVar = saved;
      return `(function(){` +
        `var ${cVar}=${saved}.parent;` +
        `while(${cVar}!=null){` +
          `if(${compiled})return true;` +
          `${cVar}=${cVar}.parent;` +
        `}` +
        `return false;` +
        `})()`;
    }

    // Project/folder containers are not valid for tags entity
    if (fromEntity === 'tags') {
      throw new CompileError(`"container" with "${type}" is not valid for entity "tags"`, 'where', { op: 'container' });
    }

    if (fromEntity === 'tasks') {
      if (type === 'project') {
        const cVar = this.freshVar('c');
        // Temporarily switch the item var for the inner expression
        const saved = this._itemVar;
        this._itemVar = cVar;
        const compiled = fold(subExpr, toEntity);
        this._itemVar = saved;
        return `(function(){` +
          `var ${cVar}=${saved}.containingProject;` +
          `if(${cVar}==null)return false;` +
          `return(${compiled});` +
          `})()`;
      }

      if (type === 'folder') {
        const cVar = this.freshVar('c');
        const saved = this._itemVar;
        this._itemVar = cVar;
        const compiled = fold(subExpr, toEntity);
        this._itemVar = saved;
        return `(function(){` +
          `var ${cVar}=${saved}.containingProject;` +
          `if(${cVar}==null)return false;` +
          `${cVar}=${cVar}.parentFolder;` +
          `while(${cVar}!=null){` +
            `if(${compiled})return true;` +
            `${cVar}=${cVar}.parent;` +
          `}` +
          `return false;` +
          `})()`;
      }
    }

    if (fromEntity === 'projects') {
      if (type === 'project') {
        throw new CompileError('"container" with "project" is not valid for entity "projects"', 'where', { op: 'container' });
      }
      // folder: walk parentFolder chain
      const cVar = this.freshVar('c');
      const saved = this._itemVar;
      this._itemVar = cVar;
      const compiled = fold(subExpr, toEntity);
      this._itemVar = saved;
      return `(function(){` +
        `var ${cVar}=${saved}.parentFolder;` +
        `while(${cVar}!=null){` +
          `if(${compiled})return true;` +
          `${cVar}=${cVar}.parent;` +
        `}` +
        `return false;` +
        `})()`;
    }

    if (fromEntity === 'folders') {
      if (type === 'project') {
        throw new CompileError('"container" with "project" is not valid for entity "folders"', 'where', { op: 'container' });
      }
      // folder: walk parent chain
      const cVar = this.freshVar('c');
      const saved = this._itemVar;
      this._itemVar = cVar;
      const compiled = fold(subExpr, toEntity);
      this._itemVar = saved;
      return `(function(){` +
        `var ${cVar}=${saved}.parent;` +
        `while(${cVar}!=null){` +
          `if(${compiled})return true;` +
          `${cVar}=${cVar}.parent;` +
        `}` +
        `return false;` +
        `})()`;
    }

    throw new CompileError(`"container" is not supported for entity "${fromEntity}"`, 'where', { op: 'container' });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * If expr is a JXA string literal (e.g. `"hello"` or `"a\\"b"`), extract and return
 * the raw string value. Otherwise return null.
 */
function extractJxaStringLiteral(expr: string): string | null {
  if (expr.length >= 2 && expr[0] === '"' && expr[expr.length - 1] === '"') {
    // Unescape the JXA string to get the raw value
    return expr.slice(1, -1)
      .replace(/\\0/g, '\0')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return null;
}

function getVarSuggestion(varName: string, entity: EntityType): string {
  if (entity === 'tasks') {
    if (varName === 'project') {
      return 'Use {container: ["project", {contains: [{var: "name"}, "..."]}]} to filter by project. ';
    }
    if (varName === 'folderName' || varName === 'folder') {
      return 'Use {container: ["folder", {contains: [{var: "name"}, "..."]}]} to filter by folder. ';
    }
  }
  if (entity === 'projects' && (varName === 'folderName' || varName === 'folder')) {
    return 'Use {container: ["folder", {contains: [{var: "name"}, "..."]}]} to filter by folder. ';
  }
  return '';
}
