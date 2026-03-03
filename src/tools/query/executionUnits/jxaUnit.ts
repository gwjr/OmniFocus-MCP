/**
 * JXA ExecutionUnit codegen.
 *
 * Translates a JXA ExecutionUnit's EventNode SSA instructions into a
 * runnable JXA script string. The script reads from OmniFocus via Apple
 * Events and returns a JSON-serialisable result.
 */

import type { EventNode, Ref, Specifier, FourCC } from '../eventPlan.js';
import type { TargetedEventPlan } from '../targetedEventPlan.js';
import type { ExecutionUnit } from '../targetedEventPlan.js';
import { OFClass, OFTaskProp, OFProjectProp, OFFolderProp, OFTagProp } from '../../../generated/omnifocus-sdef.js';

// ── FourCC → JXA name mappings ──────────────────────────────────────────

/** Map class FourCC → JXA collection accessor on the document. */
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

/** Map property FourCC → JXA property accessor name.
 *  Merged from all entity prop tables. */
const PROP_TO_ACCESSOR: Record<FourCC, string> = buildPropMap();

function buildPropMap(): Record<FourCC, string> {
  const map: Record<FourCC, string> = {};
  // Walk all prop constants and map code → camelCase accessor name.
  // We use the *key* from the prop object as the accessor name, except
  // for a few known aliases.
  const tables: Record<string, string>[] = [
    OFTaskProp as unknown as Record<string, string>,
    OFProjectProp as unknown as Record<string, string>,
    OFFolderProp as unknown as Record<string, string>,
    OFTagProp as unknown as Record<string, string>,
  ];
  for (const table of tables) {
    for (const [key, code] of Object.entries(table)) {
      // First writer wins — keep the most common name for shared codes
      if (!map[code]) {
        map[code] = key;
      }
    }
  }
  // Explicit overrides for aliases that differ between tables
  map['ID  '] = 'id';
  map['pnam'] = 'name';
  return map;
}

/**
 * Chain accessors: property codes that require a chained AE specifier
 * path rather than a simple `.propName()` call.
 *
 * For example, `tags` on a task collection is `.tags.name()` which returns
 * nested string arrays [["tag1"], [], ["tag2","tag3"], ...].
 *
 * Each entry maps propCode → the chained suffix to append to the parent
 * expression (WITHOUT the leading dot — that's added by the caller).
 */
const CHAIN_ACCESSORS: Record<FourCC, string> = {
  [OFTaskProp.tags]:  'tags.name',   // tasks.tags → .tags.name()
};

/**
 * Post-read value transforms: property codes whose raw Apple Events
 * values must be mapped to match the application's domain model.
 *
 * Each entry maps propCode → a JS function expression that transforms
 * the raw bulk-read array. Applied after the `()` call on a Property Get.
 *
 * Example: project status returns "active status" from AE; we map to "Active".
 */
const PROP_VALUE_TRANSFORMS: Record<FourCC, string> = {
  // Project status: AE returns "active status", "done status" etc — map to domain model strings
  [OFProjectProp.status]: `.map(function(v) { return ({"active status":"Active","done status":"Done","on hold status":"OnHold","dropped status":"Dropped"})[String(v)] || String(v); })`,
  [OFProjectProp.effectiveStatus]: `.map(function(v) { return ({"active status":"Active","done status":"Done","on hold status":"OnHold","dropped status":"Dropped"})[String(v)] || String(v); })`,
  // IDs: AE returns numeric/object IDs — coerce to strings
  'ID  ': `.map(function(v) { return v ? v.toString() : null; })`,
  // Dates: AE returns Date objects — coerce to ISO strings
  [OFTaskProp.dueDate]:              `.map(function(v) { return v ? v.toISOString() : null; })`,
  [OFTaskProp.deferDate]:            `.map(function(v) { return v ? v.toISOString() : null; })`,
  [OFTaskProp.effectiveDueDate]:     `.map(function(v) { return v ? v.toISOString() : null; })`,
  [OFTaskProp.effectiveDeferDate]:   `.map(function(v) { return v ? v.toISOString() : null; })`,
  [OFTaskProp.creationDate]:         `.map(function(v) { return v ? v.toISOString() : null; })`,
  [OFTaskProp.modificationDate]:     `.map(function(v) { return v ? v.toISOString() : null; })`,
  [OFTaskProp.completionDate]:       `.map(function(v) { return v ? v.toISOString() : null; })`,
  [OFTaskProp.droppedDate]:          `.map(function(v) { return v ? v.toISOString() : null; })`,
};

// ── Emit context ────────────────────────────────────────────────────────

interface EmitCtx {
  plan: TargetedEventPlan;
  unit: ExecutionUnit;
  inputs: Map<number, string>;
  /** Set of refs owned by this unit (for quick membership check). */
  ownedRefs: Set<number>;
  /** Lines of emitted code. */
  lines: string[];
  /** Generated variable names per ref. */
  vars: Map<number, string>;
  /** Counter for generating unique temp vars. */
  counter: number;
  /** Stack of ForEach loop variable names (for scoped Ref resolution). */
  forEachStack: { ref: Ref; itemVar: string }[];
}

function freshVar(ctx: EmitCtx, prefix: string): string {
  return `_${prefix}${ctx.counter++}`;
}

function refVar(ctx: EmitCtx, ref: Ref): string {
  // Check ForEach stack for scoped refs (current iteration item)
  for (let i = ctx.forEachStack.length - 1; i >= 0; i--) {
    if (ctx.forEachStack[i].ref === ref) {
      return ctx.forEachStack[i].itemVar;
    }
  }
  // Check computed vars for this unit
  const v = ctx.vars.get(ref);
  if (v) return v;
  // Check cross-unit inputs
  const inp = ctx.inputs.get(ref);
  if (inp) return inp;
  throw new Error(`jxaUnit: unresolved ref %${ref}`);
}

// ── Specifier compilation ───────────────────────────────────────────────

function emitSpecifier(ctx: EmitCtx, spec: Specifier): string {
  switch (spec.kind) {
    case 'Document':
      return 'doc';
    case 'Elements': {
      const parent = emitParent(ctx, spec.parent);
      const collection = CLASS_TO_COLLECTION[spec.classCode];
      if (!collection) {
        throw new Error(`jxaUnit: unknown class code '${spec.classCode}'`);
      }
      return `${parent}.${collection}`;
    }
    case 'Property': {
      const parent = emitParent(ctx, spec.parent);
      // Check for chain accessors (e.g., tags → .tags.name)
      const chain = CHAIN_ACCESSORS[spec.propCode];
      if (chain) {
        return `${parent}.${chain}`;
      }
      const prop = PROP_TO_ACCESSOR[spec.propCode];
      if (!prop) {
        throw new Error(`jxaUnit: unknown property code '${spec.propCode}'`);
      }
      return `${parent}.${prop}`;
    }
    case 'ByID': {
      const parent = emitParent(ctx, spec.parent);
      const idExpr = typeof spec.id === 'number' ? refVar(ctx, spec.id) : JSON.stringify(spec.id);
      return `${parent}.byId(${idExpr})`;
    }
    case 'ByName': {
      const parent = emitParent(ctx, spec.parent);
      const nameExpr = typeof spec.name === 'number' ? refVar(ctx, spec.name) : JSON.stringify(spec.name);
      return `${parent}.byName(${nameExpr})`;
    }
    case 'ByIndex': {
      const parent = emitParent(ctx, spec.parent);
      return `${parent}[${spec.index}]`;
    }
    case 'Whose': {
      const parent = emitParent(ctx, spec.parent);
      const prop = PROP_TO_ACCESSOR[spec.prop];
      if (!prop) {
        throw new Error(`jxaUnit: unknown property code '${spec.prop}' in Whose`);
      }
      const escaped = spec.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      if (spec.match === 'eq') {
        return `${parent}.whose({${prop}: '${escaped}'})`;
      } else {
        return `${parent}.whose({${prop}: {_contains: '${escaped}'}})`;
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
      // Only Property reads materialise with () — Elements, ByID, ByName,
      // ByIndex produce AE specifier references that downstream nodes chain
      // onto. Calling () on Elements would materialise the collection as a
      // JS array, breaking subsequent bulk reads like .name().
      if (node.specifier.kind === 'Property') {
        const transform = PROP_VALUE_TRANSFORMS[node.specifier.propCode] ?? '';
        ctx.lines.push(`var ${varName} = ${specExpr}()${transform};`);
      } else {
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
      ctx.lines.push(`${specExpr}.set(${valueExpr});`);
      ctx.lines.push(`var ${varName} = ${valueExpr};`);
      break;
    }

    case 'Command': {
      const targetExpr = emitSpecifier(ctx, node.target);
      const args = Object.entries(node.args).map(([k, v]) => {
        const val = typeof v === 'number' ? refVar(ctx, v) : JSON.stringify(v);
        return `${k}: ${val}`;
      }).join(', ');
      ctx.lines.push(`var ${varName} = ${targetExpr}['${node.fourCC}']({${args}});`);
      break;
    }

    case 'ForEach': {
      emitForEach(ctx, ref, node, varName);
      break;
    }

    default:
      // Node-side ops should not appear in JXA units
      throw new Error(`jxaUnit: unexpected node kind '${node.kind}' in JXA unit (ref %${ref})`);
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

  // Push scoped ForEach ref → item var binding
  ctx.forEachStack.push({ ref: feRef, itemVar });

  // Emit body nodes. Body nodes use body-local indices for intra-body refs,
  // but the ForEach's own ref (feRef) maps to the current iteration item.
  const bodyVars = new Map<number, string>();
  const savedVars = new Map(ctx.vars);

  for (let i = 0; i < node.body.length; i++) {
    const bodyNode = node.body[i];
    const bodyVarName = freshVar(ctx, 'b');
    bodyVars.set(i, bodyVarName);
    // Body-local refs: body nodes reference each other by body-local index
    ctx.vars.set(i, bodyVarName);

    emitBodyNode(ctx, bodyNode, bodyVarName);
  }

  // Collect result
  const collectVar = bodyVars.get(node.collect);
  if (!collectVar) {
    throw new Error(`jxaUnit: ForEach collect ref ${node.collect} not found in body`);
  }
  ctx.lines.push(`  ${accVar}.push(${collectVar});`);
  ctx.lines.push(`}`);

  // Flatten the accumulated results (ForEach collects produce arrays of arrays)
  ctx.lines.push(`var ${resultVar} = [].concat.apply([], ${accVar});`);

  // Pop ForEach scope and restore vars
  ctx.forEachStack.pop();
  // Restore outer scope vars (remove body-local refs)
  ctx.vars.clear();
  for (const [k, v] of savedVars) ctx.vars.set(k, v);
  ctx.vars.set(feRef, resultVar);
}

function emitBodyNode(ctx: EmitCtx, node: EventNode, varName: string): void {
  switch (node.kind) {
    case 'Get': {
      const specExpr = emitSpecifier(ctx, node.specifier);
      if (node.specifier.kind === 'Property') {
        const transform = PROP_VALUE_TRANSFORMS[node.specifier.propCode] ?? '';
        ctx.lines.push(`  var ${varName} = ${specExpr}()${transform};`);
      } else {
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
      throw new Error(`jxaUnit: unsupported body node kind '${node.kind}'`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate a JXA script string for the given ExecutionUnit.
 *
 * The script reads from OmniFocus via Apple Events and returns
 * the result value as a JSON-serialisable structure.
 *
 * @param unit   The ExecutionUnit to codegen (runtime must be 'jxa')
 * @param plan   The full TargetedEventPlan (for node lookup by Ref)
 * @param inputs Map from cross-unit input Ref → variable name in script
 */
/**
 * @param exports Optional list of refs this unit must return to the
 *                orchestrator. When omitted or single-element, the script
 *                returns the single result value. When multiple, the script
 *                returns an object keyed by ref number string.
 */
export function emitJxaUnit(
  unit: ExecutionUnit,
  plan: TargetedEventPlan,
  inputs: Map<number, string>,
  exports?: number[],
): string {
  if (unit.runtime !== 'jxa') {
    throw new Error(`emitJxaUnit: expected runtime 'jxa', got '${unit.runtime}'`);
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

  // Emit nodes in SSA order
  for (const ref of unit.nodes) {
    emitNode(ctx, ref);
  }

  // Build the return expression
  const effectiveExports = exports && exports.length > 1 ? exports : null;
  let returnExpr: string;

  if (effectiveExports) {
    // Multi-export: return an object keyed by ref number
    const entries = effectiveExports.map(ref => {
      const v = ctx.vars.get(ref);
      if (!v) throw new Error(`jxaUnit: exported ref %${ref} was not emitted`);
      return `${JSON.stringify(String(ref))}: ${v}`;
    });
    returnExpr = `{${entries.join(', ')}}`;
  } else {
    const resultVar = ctx.vars.get(unit.result);
    if (!resultVar) {
      throw new Error(`jxaUnit: result ref %${unit.result} was not emitted`);
    }
    returnExpr = resultVar;
  }

  const body = ctx.lines.map(l => `  ${l}`).join('\n');

  return `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;
${body}
  return JSON.stringify(${returnExpr});
})()`;
}
