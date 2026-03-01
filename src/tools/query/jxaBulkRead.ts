/**
 * JXA Bulk-Read Script Generator.
 *
 * Generates direct JXA Apple Events scripts that bulk-read task properties
 * without going through OmniJS evaluateJavascript. This avoids the ~880ms
 * OmniJS overhead.
 *
 * Properties are read via Apple Events bulk accessors like tasks.name(),
 * which return arrays in parallel alignment. An alignment check is included
 * to detect mismatches.
 */

import { getVarRegistry, type EntityType, type VarDef } from './variables.js';
import type { ExecutionPlan } from './planner.js';
import type { LoweredExpr } from './fold.js';
import { escapeJxaString } from './backends/jxaCompiler.js';

// ── Types ───────────────────────────────────────────────────────────────

interface BulkReadConfig {
  /** Variables to read */
  vars: Set<string>;
  /** Include id in the read (needed for two-phase) */
  includeId: boolean;
  /** Project scope predicate for narrowing the source collection */
  projectScope?: LoweredExpr;
  /** Whether to include completed/dropped tasks */
  includeCompleted: boolean;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate a JXA script for phase 1 bulk-read of task properties.
 */
export function generateBulkReadScript(plan: ExecutionPlan, includeCompleted = false): string {
  const varsToRead = new Set(plan.bulkVars);

  // Two-phase needs id for phase 2 lookups
  const includeId = plan.path === 'two-phase';
  if (includeId) varsToRead.add('id');

  return generateScript({
    vars: varsToRead,
    includeId,
    projectScope: plan.projectScope,
    includeCompleted
  });
}

/**
 * Generate a JXA script for phase 2 per-item reads by ID.
 */
export function generatePerItemReadScript(ids: string[], perItemVars: Set<string>): string {
  const registry = getVarRegistry('tasks');
  const varEntries = [...perItemVars].map(name => {
    const def = registry[name];
    if (!def) throw new Error(`Unknown variable "${name}" for per-item read`);
    return { name, def };
  });

  // Generate per-item accessor code for each var
  const accessors = varEntries.map(({ name, def }) => {
    return `        "${name}": ${generatePerItemAccessor(name, def)}`;
  });

  const idsJson = JSON.stringify(ids);

  return `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;

  var ids = ${idsJson};
  var results = [];

  for (var i = 0; i < ids.length; i++) {
    var matches = doc.flattenedTasks.whose({id: ids[i]});
    if (matches.length === 0) continue;
    var task = matches[0];
    results.push({
      id: ids[i],
${accessors.join(',\n')}
    });
  }

  return JSON.stringify(results);
})()`;
}

// ── Internal ────────────────────────────────────────────────────────────

function generateScript(config: BulkReadConfig): string {
  const registry = getVarRegistry('tasks');

  // Group vars by their bulk-read method
  const directProps: { name: string; bulk: string; def: VarDef }[] = [];
  const chainProps: { name: string; def: VarDef }[] = [];

  for (const varName of config.vars) {
    if (varName === 'now') continue; // special, not a property
    const def = registry[varName];
    if (!def) continue;

    if (def.bulk && def.cost === 'easy') {
      directProps.push({ name: varName, bulk: def.bulk, def });
    } else if (def.cost === 'chain') {
      chainProps.push({ name: varName, def });
    }
    // per-item and expensive vars are not bulk-read
  }

  // Determine the source collection expression
  let sourceExpr: string;
  if (config.projectScope) {
    const scopeJxa = generateScopeWhose(config.projectScope);
    sourceExpr = `doc.flattenedProjects.whose(${scopeJxa})[0].flattenedTasks`;
  } else {
    sourceExpr = `doc.flattenedTasks`;
  }

  // Generate bulk read lines for direct properties
  const readLines = directProps.map(({ name, bulk, def }) => {
    const isDate = def.type === 'date';
    if (isDate) {
      return `  var ${name}Arr = tasks.${bulk}();
  var ${name}Iso = ${name}Arr.map(function(v) { return v ? v.toISOString() : null; });`;
    }
    if (name === 'id') {
      return `  var idArr = tasks.id();
  var idKeys = idArr.map(function(v) { return v ? v.toString() : null; });`;
    }
    return `  var ${name}Arr = tasks.${bulk}();`;
  });

  // Chain properties use chained bulk accessors (tasks.containingProject.name())
  // which are ~20x faster than tasks.containingProject() + map(name()).
  // Benchmarked: chained = ~250ms, map = ~4700ms for 2124 tasks.
  const chainLines = chainProps.map(({ name }) => {
    if (name === 'projectName') {
      return `  var projectNameArr = tasks.containingProject.name();`;
    }
    if (name === 'projectId') {
      return `  var _projIds = tasks.containingProject.id();
  var projectIdArr = _projIds.map(function(v) { return v ? v.toString() : null; });`;
    }
    return '';
  }).filter(Boolean);

  // Build alignment check
  const allArrayNames = [
    ...directProps.map(p => p.name === 'id' ? 'idKeys' : `${p.name}Arr`),
    ...chainProps.map(p => `${p.name}Arr`)
  ];

  // Build row construction
  const rowProps = [
    ...directProps.map(({ name, def }) => {
      if (def.type === 'date') return `"${name}": ${name}Iso[i]`;
      if (name === 'id') return `"id": idKeys[i]`;
      return `"${name}": ${name}Arr[i]`;
    }),
    ...chainProps.map(({ name }) => `"${name}": ${name}Arr[i]`)
  ];

  // Include completed filter
  const completedFilter = config.includeCompleted ? '' : `
  // Filter out completed/dropped tasks
  var statusArr = tasks.completed();
  var len = statusArr.length;
  var activeIndices = [];
  for (var j = 0; j < len; j++) {
    if (!statusArr[j]) activeIndices.push(j);
  }`;

  const indexVar = config.includeCompleted ? 'i' : 'activeIndices[i]';
  const loopLen = config.includeCompleted ? `${allArrayNames[0] || 'idKeys'}.length` : 'activeIndices.length';

  // Build the row construction with correct indexing
  const rowPropsIndexed = [
    ...directProps.map(({ name, def }) => {
      if (def.type === 'date') return `"${name}": ${name}Iso[${indexVar}]`;
      if (name === 'id') return `"id": idKeys[${indexVar}]`;
      return `"${name}": ${name}Arr[${indexVar}]`;
    }),
    ...chainProps.map(({ name }) => `"${name}": ${name}Arr[${indexVar}]`)
  ];

  return `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;

  var tasks = ${sourceExpr};

  // Bulk-read properties via Apple Events
${readLines.join('\n')}
${chainLines.join('\n')}

  // Alignment check
  var _lens = {${allArrayNames.map(a => `"${a}": ${a}.length`).join(', ')}};
  var _first = _lens["${allArrayNames[0]}"];
  for (var _k in _lens) {
    if (_lens[_k] !== _first) {
      return JSON.stringify({error: "alignment mismatch", properties: Object.keys(_lens), lengths: _lens});
    }
  }
${completedFilter}

  // Build row objects
  var rows = [];
  for (var i = 0; i < ${loopLen}; i++) {
    rows.push({${rowPropsIndexed.join(', ')}});
  }

  return JSON.stringify(rows);
})()`;
}

/**
 * Generate a .whose() predicate for project scoping.
 * Handles simple name-matching patterns from the extracted container scope.
 */
function generateScopeWhose(scopeExpr: LoweredExpr): string {
  // The scope is the sub-expression from inside container("project", <here>)
  // Common patterns: {contains: [{var:"name"}, "text"]}, {eq: [{var:"name"}, "text"]}
  if (typeof scopeExpr !== 'object' || scopeExpr === null || Array.isArray(scopeExpr)) {
    // Fallback: can't convert to .whose() — use a broad match
    return '{_match: true}';
  }

  const node = scopeExpr as { op: string; args: LoweredExpr[] };
  if (!('op' in node)) return '{_match: true}';

  // {eq: [{var: "name"}, "literal"]}
  if (node.op === 'eq' && isVarNode(node.args[0], 'name') && typeof node.args[1] === 'string') {
    return `{name: "${escapeJxaString(node.args[1])}"}`;
  }

  // {contains: [{var: "name"}, "literal"]} → use _match
  if (node.op === 'contains' && isVarNode(node.args[0], 'name') && typeof node.args[1] === 'string') {
    return `{name: {_match: "*${escapeJxaString(node.args[1])}*"}}`;
  }

  // Can't express this as a .whose() — fall back
  return '{_match: true}';
}

function isVarNode(node: LoweredExpr, expectedName?: string): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  if (!('var' in node)) return false;
  if (expectedName) return (node as { var: string }).var === expectedName;
  return true;
}

function generatePerItemAccessor(name: string, def: VarDef): string {
  // Generate the JXA accessor for per-item reads
  switch (name) {
    case 'tags':
      return 'task.tags().map(function(t) { return t.name().toLowerCase(); })';
    case 'status':
      return '(function() { var s = task.completed() ? "Completed" : task.flagged() ? "Flagged" : "Available"; return s; })()';
    case 'inInbox':
      return 'task.inInbox()';
    case 'sequential':
      return 'task.sequential()';
    case 'hasChildren':
      return 'task.tasks().length > 0';
    case 'childCount':
      return 'task.tasks().length';
    case 'parentId':
      return '(function() { var p = task.parentTask(); return p ? p.id().toString() : null; })()';
    case 'id':
      return 'task.id().toString()';
    case 'note':
      return '(task.note() || "")';
    case 'completed':
      return 'task.completed()';
    case 'dropped':
      return '(task.dropped ? task.dropped() : false)';
    default:
      // For date properties, serialize to ISO
      if (def.type === 'date') {
        return `(function() { var v = task.${def.bulk || name}(); return v ? v.toISOString() : null; })()`;
      }
      return `task.${def.bulk || name}()`;
  }
}
