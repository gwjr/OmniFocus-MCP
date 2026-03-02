/**
 * JXA Bulk-Read Script Generator.
 *
 * Generates direct JXA Apple Events scripts that bulk-read entity properties
 * without going through OmniJS evaluateJavascript. This avoids the ~880ms
 * OmniJS overhead.
 *
 * Properties are read via Apple Events bulk accessors like items.name(),
 * which return arrays in parallel alignment. An alignment check is included
 * to detect mismatches.
 */

import { getVarRegistry, type EntityType, type VarDef } from './variables.js';
import type { ExecutionPlan } from './planner.js';
import type { LoweredExpr } from './fold.js';
import { escapeJxaString } from './backends/jxaCompiler.js';
import type { BulkScan, MembershipScan, WhoseFilter } from './planTree.js';

// ── Entity Configuration ────────────────────────────────────────────────

interface EntityJxaConfig {
  /** Apple Events collection path (relative to doc) */
  collection: string;
  /** Active-item filter: bulk property name and condition for keeping an item */
  activeFilter: {
    bulkProperty: string;
    /** 'false'/'true' for boolean check, 'active' for project status string match */
    keepWhen: 'false' | 'true' | 'active';
  } | null;
}

const entityConfigs: Record<EntityType, EntityJxaConfig> = {
  tasks: {
    collection: 'doc.flattenedTasks',
    activeFilter: { bulkProperty: 'completed', keepWhen: 'false' },
  },
  tags: {
    collection: 'doc.flattenedTags',
    activeFilter: { bulkProperty: 'effectivelyHidden', keepWhen: 'false' },
  },
  projects: {
    collection: 'doc.flattenedProjects',
    activeFilter: { bulkProperty: 'status', keepWhen: 'active' },
  },
  folders: {
    collection: 'doc.flattenedFolders',
    activeFilter: null,
  },
  perspectives: {
    collection: '', // perspectives don't use bulk-read; always OmniJS fallback
    activeFilter: null,
  },
};

/**
 * Per-item accessor overrides by entity.
 * Keys are variable names, values generate JXA accessor code for `item`.
 * Properties not listed here fall through to the generic accessor.
 */
const perItemOverrides: Record<EntityType, Record<string, string>> = {
  tasks: {
    tags:       'item.tags().map(function(t) { return t.name().toLowerCase(); })',
    status:     '(function() { var s = item.completed() ? "Completed" : item.flagged() ? "Flagged" : "Available"; return s; })()',
    inInbox:    'item.inInbox()',
    sequential: 'item.sequential()',
    hasChildren:'item.tasks().length > 0',
    childCount: 'item.tasks().length',
    parentId:   '(function() { var p = item.parentTask(); return p ? p.id().toString() : null; })()',
    id:         'item.id().toString()',
    note:       '(item.note() || "")',
    completed:  'item.completed()',
    dropped:    '(item.dropped ? item.dropped() : false)',
  },
  tags: {
    parentName: '(function() { var c = item.container(); return c ? c.name() : null; })()',
    id:         'item.id().toString()',
    note:       '(item.note() || "")',
  },
  projects: {
    folderName: '(function() { var f = item.parentFolder(); return f ? f.name() : null; })()',
    id:         'item.id().toString()',
    note:       '(item.note() || "")',
  },
  folders: {
    status:       '(function() { try { var s = item.status(); return {"active status":"Active","dropped status":"Dropped"}[String(s)] || String(s); } catch(e) { return "Active"; } })()',
    projectCount: '(function() { try { return item.projects().length; } catch(e) { return 0; } })()',
  },
  perspectives: {},
};

/**
 * Chain property bulk-read lines by entity.
 * Chain properties use chained bulk accessors (e.g. items.containingProject.name())
 * which are ~20x faster than items.containingProject() + map(name()).
 */
const chainAccessors: Record<EntityType, Record<string, string>> = {
  tasks: {
    projectName: '  var projectNameArr = items.containingProject.name();',
    projectId:   `  var _projIds = items.containingProject.id();
  var projectIdArr = _projIds.map(function(v) { return v ? v.toString() : null; });`,
  },
  tags: {
    parentId: `  var _containerIds = items.container.id();
  var parentIdArr = _containerIds.map(function(v) { return v ? v.toString() : null; });`,
  },
  projects: {
    folderId:   `  var _folderIds = items.container.id();
  var folderIdArr = _folderIds.map(function(v) { return v ? v.toString() : null; });`,
  },
  folders: {
    parentFolderId: `  var _containerIds = items.container.id();
  var parentFolderIdArr = _containerIds.map(function(v) { return v ? v.toString() : null; });`,
  },
  perspectives: {},
};

// ── Types ───────────────────────────────────────────────────────────────

interface BulkReadConfig {
  /** Variables to read */
  vars: Set<string>;
  /** Include id in the read (needed for two-phase) */
  includeId: boolean;
  /** Project scope predicate for narrowing the source collection */
  projectScope?: LoweredExpr;
  /** Whether to include completed/dropped/hidden items */
  includeCompleted: boolean;
  /** Entity type */
  entity: EntityType;
  /** Pushed-down .whose() filters from predicate pushdown pass */
  whoseFilters?: WhoseFilter[];
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate a JXA script for phase 1 bulk-read of entity properties.
 */
export function generateBulkReadScript(plan: ExecutionPlan, includeCompleted = false): string {
  const varsToRead = new Set(plan.bulkVars);

  // Two-phase and project-scoped need id for phase 2 lookups
  const includeId = plan.path === 'two-phase' || plan.path === 'project-scoped';
  if (includeId) varsToRead.add('id');

  return generateScript({
    vars: varsToRead,
    includeId,
    projectScope: plan.projectScope,
    includeCompleted,
    entity: plan.entity
  });
}

/**
 * Generate a JXA script for phase 2 per-item reads by ID.
 */
export function generatePerItemReadScript(ids: string[], perItemVars: Set<string>, entity: EntityType = 'tasks'): string {
  const registry = getVarRegistry(entity);
  const config = entityConfigs[entity];
  const varEntries = [...perItemVars].map(name => {
    const def = registry[name];
    if (!def) throw new Error(`Unknown variable "${name}" for per-item read (entity: ${entity})`);
    return { name, def };
  });

  // Generate per-item accessor code for each var
  const accessors = varEntries.map(({ name, def }) => {
    return `        "${name}": ${generatePerItemAccessor(name, def, entity)}`;
  });

  const idsJson = JSON.stringify(ids);

  return `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;

  var ids = ${idsJson};
  var results = [];

  for (var i = 0; i < ids.length; i++) {
    var matches = ${config.collection}.whose({id: ids[i]});
    if (matches.length === 0) continue;
    var item = matches[0];
    results.push({
      id: ids[i],
${accessors.join(',\n')}
    });
  }

  return JSON.stringify(results);
})()`;
}

/**
 * Generate a JXA bulk-read script from a BulkScan plan node.
 * Columns are explicit nodeKey names — the planner is responsible for
 * including `id` when needed by downstream nodes.
 */
export function generateBulkReadFromColumns(node: BulkScan): string {
  const registry = getVarRegistry(node.entity);

  // Map column names to var names (columns use nodeKeys)
  const vars = new Set<string>();
  let needsId = false;
  for (const col of node.columns) {
    // Find the var whose nodeKey matches
    const varName = Object.keys(registry).find(k => registry[k].nodeKey === col);
    if (varName) {
      vars.add(varName);
      if (col === 'id') needsId = true;
    }
  }

  return generateScript({
    vars,
    includeId: needsId,
    projectScope: node.projectScope,
    includeCompleted: node.includeCompleted,
    entity: node.entity,
    whoseFilters: node.whoseFilters,
  });
}

/**
 * Generate a JXA script that looks up task IDs belonging to tags
 * matching a predicate. Returns a JSON array of task ID strings.
 *
 * The tag predicate is a simple {eq: [{var:'name'}, 'value']} for now.
 * Apple Events .whose({name:}) is case-insensitive by default.
 */
// ── Membership Scan ─────────────────────────────────────────────────────

/**
 * Relationship config: how entity A relates to entity B via Apple Events.
 *
 * The JXA accessor is the property on a source entity item that yields
 * the related target entity items (e.g., tag.tasks, project.flattenedTasks).
 */
interface RelationshipConfig {
  /** JXA property on a source item to traverse to target items */
  accessor: string;
  /** Active-item filter on the target entity (null = no filter) */
  activeFilter: {
    bulkProperty: string;
    keepWhen: 'false' | 'active';
  } | null;
}

const relationships: Record<string, Record<string, RelationshipConfig>> = {
  tags: {
    tasks: { accessor: 'tasks', activeFilter: { bulkProperty: 'completed', keepWhen: 'false' } },
  },
  projects: {
    tasks: { accessor: 'flattenedTasks', activeFilter: { bulkProperty: 'completed', keepWhen: 'false' } },
  },
  folders: {
    projects: { accessor: 'flattenedProjects', activeFilter: { bulkProperty: 'status', keepWhen: 'active' } },
  },
};

export function generateMembershipScript(node: MembershipScan): string {
  // Look up relationship config
  const rel = relationships[node.sourceEntity]?.[node.targetEntity];
  if (!rel) {
    throw new Error(
      `No relationship defined: ${node.sourceEntity} → ${node.targetEntity}`
    );
  }

  // Extract name from predicate — currently supports {op:'eq', args:[{var:'name'}, literal]}
  const pred = node.predicate as { op: string; args: unknown[] };
  if (pred.op !== 'eq') {
    throw new Error(`MembershipScan predicate must be {eq: [name, value]}, got op="${pred.op}"`);
  }
  const nameValue = pred.args[1] as string;
  const escaped = escapeJxaString(nameValue);

  const sourceConfig = entityConfigs[node.sourceEntity as EntityType];
  if (!sourceConfig?.collection) {
    throw new Error(`No collection path for entity: ${node.sourceEntity}`);
  }

  // Active filter on target entity items
  let activeFilterCode = '';
  if (!node.includeCompleted && rel.activeFilter) {
    const { bulkProperty, keepWhen } = rel.activeFilter;
    const condition = keepWhen === 'false'
      ? `!filterArr[j]`
      : `String(filterArr[j]).indexOf("active") === 0 || String(filterArr[j]).indexOf("on hold") === 0`;
    activeFilterCode = `
    var filterArr = items.${bulkProperty}();
    var filtered = [];
    for (var j = 0; j < itemIds.length; j++) {
      if (${condition}) filtered.push(itemIds[j]);
    }
    itemIds = filtered;`;
  }

  return `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;

  var matches = ${sourceConfig.collection}.whose({name: "${escaped}"});
  var ids = [];
  for (var i = 0; i < matches.length; i++) {
    var items = matches[i].${rel.accessor};
    var itemIds = items.id();
    ${activeFilterCode}
    for (var j = 0; j < itemIds.length; j++) {
      ids.push(itemIds[j].toString());
    }
  }

  return JSON.stringify(ids);
})()`;
}

// ── Internal ────────────────────────────────────────────────────────────

function generateScript(config: BulkReadConfig): string {
  const registry = getVarRegistry(config.entity);
  const entityConfig = entityConfigs[config.entity];
  const entityChains = chainAccessors[config.entity];

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

  // id is always bulk-readable via items.id() even when classified per-item
  // (the per-item classification reflects that other per-item operations need
  // an ID-based .whose() lookup, not that id itself can't be bulk-read).
  // Two-phase needs IDs from bulk read for phase 2 lookups.
  if (config.includeId && !directProps.some(p => p.name === 'id')) {
    const idDef = registry['id'];
    if (idDef) directProps.push({ name: 'id', bulk: idDef.bulk || 'id', def: idDef });
  }

  // Determine the source collection expression
  let sourceExpr: string;
  if (config.projectScope) {
    const scopeJxa = generateScopeWhose(config.projectScope);
    if (scopeJxa) {
      sourceExpr = `doc.flattenedProjects.whose(${scopeJxa})[0].flattenedTasks`;
    } else {
      sourceExpr = entityConfig.collection;
    }
  } else {
    sourceExpr = entityConfig.collection;
  }

  // Apply pushed-down .whose() filters if present
  if (config.whoseFilters && config.whoseFilters.length > 0) {
    const whoseObj = compileWhoseFilters(config.whoseFilters);
    sourceExpr = `${sourceExpr}.whose(${whoseObj})`;
  }

  // Apple Events status mapping: raw descriptors → user-facing strings
  const PROJECT_STATUS_MAP = '{"active status":"Active","done status":"Done","on hold status":"OnHold","dropped status":"Dropped"}';

  // Generate bulk read lines for direct properties
  const readLines = directProps.map(({ name, bulk, def }) => {
    const isDate = def.type === 'date';
    if (isDate) {
      return `  var ${name}Arr = items.${bulk}();
  var ${name}Iso = ${name}Arr.map(function(v) { return v ? v.toISOString() : null; });`;
    }
    if (name === 'id') {
      return `  var idArr = items.id();
  var idKeys = idArr.map(function(v) { return v ? v.toString() : null; });`;
    }
    // Project status: map Apple Events descriptor strings to user-facing values
    if (name === 'status' && config.entity === 'projects') {
      return `  var _rawStatusArr = items.${bulk}();
  var _statusMap = ${PROJECT_STATUS_MAP};
  var statusArr = _rawStatusArr.map(function(v) { return _statusMap[String(v)] || String(v); });`;
    }
    return `  var ${name}Arr = items.${bulk}();`;
  });

  // Chain properties — entity-specific chained bulk accessors
  const chainLines = chainProps
    .map(({ name }) => entityChains[name] || '')
    .filter(Boolean);

  // Build alignment check
  const allArrayNames = [
    ...directProps.map(p => p.name === 'id' ? 'idKeys' : `${p.name}Arr`),
    ...chainProps.map(p => `${p.name}Arr`)
  ];

  // Active-item filter
  let activeFilter: string;
  if (config.includeCompleted || !entityConfig.activeFilter) {
    activeFilter = '';
  } else {
    const { bulkProperty, keepWhen } = entityConfig.activeFilter;
    if (keepWhen === 'active') {
      // Project status: Apple Events returns strings like "active status", "done status", etc.
      // Keep only items whose status starts with "active" (covers "active status")
      activeFilter = `
  // Filter to active projects only
  var _filterArr = items.${bulkProperty}();
  var len = _filterArr.length;
  var activeIndices = [];
  for (var j = 0; j < len; j++) {
    var _s = String(_filterArr[j]);
    if (_s.indexOf("active") === 0 || _s.indexOf("on hold") === 0) activeIndices.push(j);
  }`;
    } else {
      const condition = keepWhen === 'false' ? `!_filterArr[j]` : `_filterArr[j]`;
      activeFilter = `
  // Filter to active items only
  var _filterArr = items.${bulkProperty}();
  var len = _filterArr.length;
  var activeIndices = [];
  for (var j = 0; j < len; j++) {
    if (${condition}) activeIndices.push(j);
  }`;
    }
  }

  const useFilter = activeFilter !== '';
  const indexVar = useFilter ? 'activeIndices[i]' : 'i';
  const loopLen = useFilter ? 'activeIndices.length' : `${allArrayNames[0] || 'idKeys'}.length`;

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

  var items = ${sourceExpr};

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
${activeFilter}

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
function generateScopeWhose(scopeExpr: LoweredExpr): string | null {
  // The scope is the sub-expression from inside container("project", <here>)
  // Common patterns: {contains: [{var:"name"}, "text"]}, {eq: [{var:"name"}, "text"]}
  if (typeof scopeExpr !== 'object' || scopeExpr === null || Array.isArray(scopeExpr)) {
    return null;
  }

  const node = scopeExpr as { op: string; args: LoweredExpr[] };
  if (!('op' in node)) return null;

  // {eq: [{var: "name"}, "literal"]}
  if (node.op === 'eq' && isVarNode(node.args[0], 'name') && typeof node.args[1] === 'string') {
    return `{name: "${escapeJxaString(node.args[1])}"}`;
  }

  // {contains: [{var: "name"}, "literal"]} → use _contains
  if (node.op === 'contains' && isVarNode(node.args[0], 'name') && typeof node.args[1] === 'string') {
    return `{name: {_contains: "${escapeJxaString(node.args[1])}"}}`;
  }

  // Can't express this as a .whose() — return null to signal extraction failure
  return null;
}

/**
 * Compile WhoseFilter predicates into a JXA .whose() object literal.
 * Multiple filters are combined into a single object (AND semantics).
 */
function compileWhoseFilters(filters: WhoseFilter[]): string {
  const parts: string[] = [];
  for (const f of filters) {
    const propName = escapeJxaString(f.property);
    if (f.type === 'eq') {
      if (typeof f.value === 'string') {
        parts.push(`${propName}: "${escapeJxaString(f.value)}"`);
      } else if (typeof f.value === 'boolean') {
        parts.push(`${propName}: ${f.value}`);
      } else {
        parts.push(`${propName}: ${f.value}`);
      }
    } else if (f.type === 'contains') {
      parts.push(`${propName}: {_contains: "${escapeJxaString(f.value)}"}`);
    }
  }
  return `{${parts.join(', ')}}`;
}

function isVarNode(node: LoweredExpr, expectedName?: string): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  if (!('var' in node)) return false;
  if (expectedName) return (node as { var: string }).var === expectedName;
  return true;
}

/**
 * Generate a JXA accessor expression for a per-item read.
 * Uses entity-specific overrides, falling back to generic accessor based on VarDef.
 */
function generatePerItemAccessor(name: string, def: VarDef, entity: EntityType = 'tasks'): string {
  // Check entity-specific overrides first
  const overrides = perItemOverrides[entity];
  if (overrides[name]) return overrides[name];

  // Generic fallback based on VarDef
  if (def.type === 'date') {
    return `(function() { var v = item.${def.bulk || name}(); return v ? v.toISOString() : null; })()`;
  }
  return `item.${def.bulk || name}()`;
}
