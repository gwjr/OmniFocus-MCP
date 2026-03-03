/**
 * OmniJS ExecutionUnit codegen.
 *
 * Translates an OmniJS ExecutionUnit's EventNode SSA instructions into
 * an OmniJS script string. OmniJS runs inside OmniFocus via
 * `evaluateJavascript()` — different from JXA in several ways:
 *
 * - No Application('OmniFocus') / app.defaultDocument — uses OmniJS
 *   globals directly: flattenedTasks, flattenedProjects, etc.
 * - Property access uses getters (no parens): item.name, not item.name()
 * - IDs: item.id.primaryKey (string), not item.id().toString()
 * - Return value passes through the JS bridge directly (no JSON.stringify needed,
 *   but we wrap in JSON.stringify for consistency with our pipeline)
 * - For iteration, standard JS array methods (.filter, .map, .forEach)
 */

import type { EventNode, Ref, Specifier, FourCC } from '../eventPlan.js';
import type { TargetedEventPlan } from '../targetedEventPlan.js';
import type { ExecutionUnit } from '../targetedEventPlan.js';
import { OFClass, OFTaskProp, OFProjectProp, OFFolderProp, OFTagProp } from '../../../generated/omnifocus-sdef.js';

// ── FourCC → OmniJS name mappings ───────────────────────────────────────

/** Map class FourCC → OmniJS global collection name. */
const CLASS_TO_COLLECTION: Record<FourCC, string> = {
  [OFClass.flattenedTask]:    'flattenedTasks',
  [OFClass.flattenedProject]: 'flattenedProjects',
  [OFClass.flattenedFolder]:  'flattenedFolders',
  [OFClass.flattenedTag]:     'flattenedTags',
  [OFClass.task]:             'tasks',
  [OFClass.project]:          'projects',
  [OFClass.folder]:           'folders',
  [OFClass.tag]:              'tags',
};

/** Map property FourCC → OmniJS property name (getter, no parens). */
const PROP_TO_ACCESSOR: Record<FourCC, string> = buildPropMap();

function buildPropMap(): Record<FourCC, string> {
  const map: Record<FourCC, string> = {};
  const tables: Record<string, string>[] = [
    OFTaskProp as unknown as Record<string, string>,
    OFProjectProp as unknown as Record<string, string>,
    OFFolderProp as unknown as Record<string, string>,
    OFTagProp as unknown as Record<string, string>,
  ];
  for (const table of tables) {
    for (const [key, code] of Object.entries(table)) {
      if (!map[code]) {
        map[code] = key;
      }
    }
  }
  map['ID  '] = 'id';
  map['pnam'] = 'name';
  return map;
}

/**
 * Chain accessors for OmniJS: property codes that require a per-item
 * mapping function rather than a simple getter.
 *
 * For tags (FCtg), each task's .tags is a Tag collection; we need to
 * map to name strings: Array.from(x.tags).map(t => t.name)
 */
const CHAIN_MAP_EXPR: Record<FourCC, string> = {
  [OFTaskProp.tags]: 'Array.from(x.tags).map(function(t) { return t.name; })',
};

// ── Emit context ────────────────────────────────────────────────────────

interface EmitCtx {
  plan: TargetedEventPlan;
  unit: ExecutionUnit;
  inputs: Map<number, string>;
  ownedRefs: Set<number>;
  lines: string[];
  vars: Map<number, string>;
  counter: number;
  forEachStack: { ref: Ref; itemVar: string }[];
}

function freshVar(ctx: EmitCtx, prefix: string): string {
  return `_${prefix}${ctx.counter++}`;
}

function refVar(ctx: EmitCtx, ref: Ref): string {
  for (let i = ctx.forEachStack.length - 1; i >= 0; i--) {
    if (ctx.forEachStack[i].ref === ref) {
      return ctx.forEachStack[i].itemVar;
    }
  }
  const v = ctx.vars.get(ref);
  if (v) return v;
  const inp = ctx.inputs.get(ref);
  if (inp) return inp;
  throw new Error(`omniJsUnit: unresolved ref %${ref}`);
}

// ── Specifier compilation (OmniJS style) ────────────────────────────────

/**
 * Compile a Specifier to an OmniJS expression.
 *
 * Key difference from JXA: OmniJS uses global collections (flattenedTasks)
 * instead of doc.flattenedTasks, and property access is via getters not
 * method calls.
 */
function emitSpecifier(ctx: EmitCtx, spec: Specifier): string {
  switch (spec.kind) {
    case 'Document':
      // In OmniJS, there's no explicit document reference for collections —
      // they're globals. Return empty string; Elements will use global directly.
      return '';
    case 'Elements': {
      const parent = emitParent(ctx, spec.parent);
      const collection = CLASS_TO_COLLECTION[spec.classCode];
      if (!collection) {
        throw new Error(`omniJsUnit: unknown class code '${spec.classCode}'`);
      }
      // If parent is empty (Document), use the global collection
      return parent ? `${parent}.${collection}` : collection;
    }
    case 'Property': {
      const parent = emitParent(ctx, spec.parent);
      const prop = PROP_TO_ACCESSOR[spec.propCode];
      if (!prop) {
        throw new Error(`omniJsUnit: unknown property code '${spec.propCode}'`);
      }
      // OmniJS: property access via getter (no parens)
      return `${parent}.${prop}`;
    }
    case 'ByID': {
      // OmniJS: use Class.byIdentifier(id) for lookup
      const parent = emitParent(ctx, spec.parent);
      const idExpr = typeof spec.id === 'number' ? refVar(ctx, spec.id) : JSON.stringify(spec.id);
      // The parent should be a collection expression; we need the class name for byIdentifier
      // For now, use .find() as a generic approach
      return `${parent}.find(function(x) { return x.id.primaryKey === ${idExpr}; })`;
    }
    case 'ByName': {
      const parent = emitParent(ctx, spec.parent);
      const nameExpr = typeof spec.name === 'number' ? refVar(ctx, spec.name) : JSON.stringify(spec.name);
      return `${parent}.find(function(x) { return x.name === ${nameExpr}; })`;
    }
    case 'ByIndex': {
      const parent = emitParent(ctx, spec.parent);
      return `${parent}[${spec.index}]`;
    }
    case 'Whose': {
      const parent = emitParent(ctx, spec.parent);
      const prop = PROP_TO_ACCESSOR[spec.prop];
      if (!prop) {
        throw new Error(`omniJsUnit: unknown property code '${spec.prop}' in Whose`);
      }
      const escaped = JSON.stringify(spec.value);
      if (spec.match === 'eq') {
        return `${parent}.filter(function(x) { return x.${prop} === ${escaped}; })`;
      } else {
        return `${parent}.filter(function(x) { return x.${prop}.toLowerCase().indexOf(${escaped}.toLowerCase()) !== -1; })`;
      }
    }
  }
}

function emitParent(ctx: EmitCtx, parent: Specifier | Ref): string {
  if (typeof parent === 'number') {
    return refVar(ctx, parent);
  }
  return emitSpecifier(ctx, parent);
}

// ── Node emission ───────────────────────────────────────────────────────

function emitNode(ctx: EmitCtx, ref: Ref): void {
  const node = ctx.plan.nodes[ref];
  const varName = freshVar(ctx, 'r');
  ctx.vars.set(ref, varName);

  switch (node.kind) {
    case 'Get': {
      const specExpr = emitSpecifier(ctx, node.specifier);
      // OmniJS: for Elements (collections), they're already array-like.
      // For Properties, they're getter accesses — no parens needed.
      // Distinguish: if the specifier is Elements, wrap in Array.from() for
      // safety; if it's Property, just access the getter.
      if (node.specifier.kind === 'Elements') {
        // Collections in OmniJS are array-like; slice to get a real array
        ctx.lines.push(`var ${varName} = Array.from(${specExpr});`);
      } else if (node.specifier.kind === 'Property') {
        // Bulk property read: in OmniJS, we need to .map() over the parent
        // collection to read a property from each element
        const parentRef = node.specifier.parent;
        const prop = PROP_TO_ACCESSOR[node.specifier.propCode];
        if (typeof parentRef === 'number') {
          const parentVar = refVar(ctx, parentRef);
          // Check for chain map expressions (e.g., tags → Array.from(x.tags).map(t => t.name))
          const chainExpr = CHAIN_MAP_EXPR[node.specifier.propCode];
          if (chainExpr) {
            ctx.lines.push(`var ${varName} = ${parentVar}.map(function(x) { return ${chainExpr}; });`);
          } else if (prop === 'id') {
            // IDs need .primaryKey extraction
            ctx.lines.push(`var ${varName} = ${parentVar}.map(function(x) { return x.id.primaryKey; });`);
          } else {
            ctx.lines.push(`var ${varName} = ${parentVar}.map(function(x) { return x.${prop}; });`);
          }
        } else {
          // Nested specifier (e.g., Property of Elements of Document)
          ctx.lines.push(`var ${varName} = ${specExpr};`);
        }
      } else {
        // ByID, ByName, ByIndex — single object lookup
        ctx.lines.push(`var ${varName} = ${specExpr};`);
      }
      break;
    }

    case 'Count': {
      const specExpr = emitSpecifier(ctx, node.specifier);
      ctx.lines.push(`var ${varName} = ${specExpr}.length;`);
      break;
    }

    case 'Set': {
      const specExpr = emitSpecifier(ctx, node.specifier);
      const valueExpr = refVar(ctx, node.value);
      // OmniJS: direct property assignment
      ctx.lines.push(`${specExpr} = ${valueExpr};`);
      ctx.lines.push(`var ${varName} = ${valueExpr};`);
      break;
    }

    case 'Command': {
      // OmniJS: method calls on objects
      const targetExpr = emitSpecifier(ctx, node.target);
      const argExprs = Object.entries(node.args).map(([k, v]) => {
        return typeof v === 'number' ? refVar(ctx, v) : JSON.stringify(v);
      });
      ctx.lines.push(`var ${varName} = ${targetExpr}.${node.fourCC}(${argExprs.join(', ')});`);
      break;
    }

    case 'ForEach': {
      emitForEach(ctx, ref, node, varName);
      break;
    }

    case 'Filter': {
      // Filter can appear in OmniJS units for FallbackScan paths
      const sourceVar = refVar(ctx, node.source);
      // For OmniJS filters, we compile the predicate to a JS function
      // using the JXA compiler backend (it produces JS-compatible expressions)
      // For now, emit a .filter() with the predicate inlined
      const predStr = JSON.stringify(node.predicate);
      ctx.lines.push(`// Filter predicate: ${predStr}`);
      ctx.lines.push(`var ${varName} = ${sourceVar}; // TODO: compile predicate for OmniJS`);
      break;
    }

    default:
      throw new Error(`omniJsUnit: unexpected node kind '${node.kind}' in OmniJS unit (ref %${ref})`);
  }
}

function emitForEach(
  ctx: EmitCtx,
  feRef: Ref,
  node: Extract<EventNode, { kind: 'ForEach' }>,
  resultVar: string,
): void {
  const sourceVar = refVar(ctx, node.source);
  const accVar = freshVar(ctx, 'acc');
  const idxVar = freshVar(ctx, 'i');
  const itemVar = freshVar(ctx, 'item');

  ctx.lines.push(`var ${accVar} = [];`);
  ctx.lines.push(`for (var ${idxVar} = 0; ${idxVar} < ${sourceVar}.length; ${idxVar}++) {`);
  ctx.lines.push(`  var ${itemVar} = ${sourceVar}[${idxVar}];`);

  ctx.forEachStack.push({ ref: feRef, itemVar });

  const bodyVars = new Map<number, string>();
  const savedVars = new Map(ctx.vars);

  for (let i = 0; i < node.body.length; i++) {
    const bodyNode = node.body[i];
    const bodyVarName = freshVar(ctx, 'b');
    bodyVars.set(i, bodyVarName);
    ctx.vars.set(i, bodyVarName);
    emitBodyNode(ctx, bodyNode, bodyVarName);
  }

  const collectVar = bodyVars.get(node.collect);
  if (!collectVar) {
    throw new Error(`omniJsUnit: ForEach collect ref ${node.collect} not found in body`);
  }
  ctx.lines.push(`  ${accVar}.push(${collectVar});`);
  ctx.lines.push(`}`);
  ctx.lines.push(`var ${resultVar} = [].concat.apply([], ${accVar});`);

  ctx.forEachStack.pop();
  ctx.vars.clear();
  for (const [k, v] of savedVars) ctx.vars.set(k, v);
  ctx.vars.set(feRef, resultVar);
}

function emitBodyNode(ctx: EmitCtx, node: EventNode, varName: string): void {
  switch (node.kind) {
    case 'Get': {
      if (node.specifier.kind === 'Elements') {
        const specExpr = emitSpecifier(ctx, node.specifier);
        ctx.lines.push(`  var ${varName} = Array.from(${specExpr});`);
      } else if (node.specifier.kind === 'Property') {
        const parent = node.specifier.parent;
        const prop = PROP_TO_ACCESSOR[node.specifier.propCode];
        if (typeof parent === 'number') {
          const parentVar = refVar(ctx, parent);
          if (prop === 'id') {
            ctx.lines.push(`  var ${varName} = ${parentVar}.map(function(x) { return x.id.primaryKey; });`);
          } else {
            ctx.lines.push(`  var ${varName} = ${parentVar}.map(function(x) { return x.${prop}; });`);
          }
        } else {
          const specExpr = emitSpecifier(ctx, node.specifier);
          ctx.lines.push(`  var ${varName} = ${specExpr};`);
        }
      } else {
        const specExpr = emitSpecifier(ctx, node.specifier);
        ctx.lines.push(`  var ${varName} = ${specExpr};`);
      }
      break;
    }
    case 'Count': {
      const specExpr = emitSpecifier(ctx, node.specifier);
      ctx.lines.push(`  var ${varName} = ${specExpr}.length;`);
      break;
    }
    case 'Zip': {
      const cols = node.columns.map(c => `${JSON.stringify(c.name)}: ${refVar(ctx, c.ref)}`).join(', ');
      ctx.lines.push(`  var ${varName} = {${cols}};`);
      break;
    }
    default:
      throw new Error(`omniJsUnit: unsupported body node kind '${node.kind}'`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate an OmniJS script string for the given ExecutionUnit.
 *
 * The script runs inside OmniFocus via evaluateJavascript() and returns
 * a JSON-serialisable result.
 *
 * @param unit   The ExecutionUnit to codegen (runtime must be 'omniJS')
 * @param plan   The full TargetedEventPlan (for node lookup by Ref)
 * @param inputs Map from cross-unit input Ref → variable name in script
 */
/**
 * @param exports Optional list of refs this unit must return. When multiple,
 *                returns an object keyed by ref number string.
 */
export function emitOmniJsUnit(
  unit: ExecutionUnit,
  plan: TargetedEventPlan,
  inputs: Map<number, string>,
  exports?: number[],
): string {
  if (unit.runtime !== 'omniJS') {
    throw new Error(`emitOmniJsUnit: expected runtime 'omniJS', got '${unit.runtime}'`);
  }

  const ctx: EmitCtx = {
    plan,
    unit,
    inputs,
    ownedRefs: new Set(unit.nodes),
    lines: [],
    vars: new Map(),
    counter: 0,
    forEachStack: [],
  };

  for (const ref of unit.nodes) {
    emitNode(ctx, ref);
  }

  const effectiveExports = exports && exports.length > 1 ? exports : null;
  let returnExpr: string;

  if (effectiveExports) {
    const entries = effectiveExports.map(ref => {
      const v = ctx.vars.get(ref);
      if (!v) throw new Error(`omniJsUnit: exported ref %${ref} was not emitted`);
      return `${JSON.stringify(String(ref))}: ${v}`;
    });
    returnExpr = `{${entries.join(', ')}}`;
  } else {
    const resultVar = ctx.vars.get(unit.result);
    if (!resultVar) {
      throw new Error(`omniJsUnit: result ref %${unit.result} was not emitted`);
    }
    returnExpr = resultVar;
  }

  const body = ctx.lines.map(l => `  ${l}`).join('\n');

  // OmniJS script wrapped in an IIFE with try/catch.
  // Returns JSON.stringify for pipeline consistency.
  return `(() => {
  try {
${body}
    return JSON.stringify(${returnExpr});
  } catch (error) {
    return JSON.stringify({ error: error.toString() });
  }
})()`;
}
