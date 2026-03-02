/**
 * JXA Emitter — generates JXA script fragments from plan nodes.
 *
 * Implements the Emitter interface by extracting script body generation
 * from jxaBulkRead.ts. Each method produces a ScriptFragment (bare body
 * with `return` but no IIFE/JSON.stringify wrapper). The wrap methods
 * handle standalone and composite script assembly.
 */

import type { Emitter, ScriptFragment } from '../emitter.js';
import type { BulkScan, MembershipScan } from '../strategy.js';
import type { EntityType, VarDef } from '../variables.js';
import { getVarRegistry } from '../variables.js';
import { escapeJxaString } from '../backends/jxaCompiler.js';
import type { LoweredExpr } from '../fold.js';

// ── Entity Configuration (shared with jxaBulkRead) ──────────────────────

interface ActiveFilterRule {
  bulkProperty: string;
  keepWhen: 'false' | 'true' | 'active';
}

interface EntityJxaConfig {
  collection: string;
  activeFilters: ActiveFilterRule[] | null;
}

const entityConfigs: Record<EntityType, EntityJxaConfig> = {
  tasks: {
    collection: 'doc.flattenedTasks',
    activeFilters: [
      { bulkProperty: 'completed', keepWhen: 'false' },
      { bulkProperty: 'dropped', keepWhen: 'false' },
    ],
  },
  tags: {
    collection: 'doc.flattenedTags',
    activeFilters: [{ bulkProperty: 'effectivelyHidden', keepWhen: 'false' }],
  },
  projects: {
    collection: 'doc.flattenedProjects',
    activeFilters: [{ bulkProperty: 'status', keepWhen: 'active' }],
  },
  folders: {
    collection: 'doc.flattenedFolders',
    activeFilters: null,
  },
  perspectives: {
    collection: '',
    activeFilters: null,
  },
};

const perItemOverrides: Record<EntityType, Record<string, string>> = {
  tasks: {
    id:         'item.id().toString()',
    note:       '(item.note() || "")',
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

const chainAccessors: Record<EntityType, Record<string, string>> = {
  tasks: {
    projectName: '  var projectNameArr = items.containingProject.name();',
    projectId:   `  var _projIds = items.containingProject.id();
  var projectIdArr = _projIds.map(function(v) { return v ? v.toString() : null; });`,
    parentId:    `  var _parentIds = items.parentTask.id();
  var parentIdArr = _parentIds.map(function(v) { return v ? v.toString() : null; });`,
    tags:        '  var tagsArr = items.tags.name();',
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

interface RelationshipConfig {
  accessor: string;
  activeFilters: ActiveFilterRule[] | null;
}

const relationships: Record<string, Record<string, RelationshipConfig>> = {
  tags: {
    tasks: { accessor: 'tasks', activeFilters: [
      { bulkProperty: 'completed', keepWhen: 'false' },
      { bulkProperty: 'dropped', keepWhen: 'false' },
    ] },
  },
  projects: {
    tasks: { accessor: 'flattenedTasks', activeFilters: [
      { bulkProperty: 'completed', keepWhen: 'false' },
      { bulkProperty: 'dropped', keepWhen: 'false' },
    ] },
  },
  folders: {
    projects: { accessor: 'flattenedProjects', activeFilters: [{ bulkProperty: 'status', keepWhen: 'active' }] },
  },
};

function generateScopeWhose(scopeExpr: LoweredExpr): string | null {
  if (typeof scopeExpr !== 'object' || scopeExpr === null || Array.isArray(scopeExpr)) {
    return null;
  }
  const node = scopeExpr as { op: string; args: LoweredExpr[] };
  if (!('op' in node)) return null;

  if (node.op === 'eq' && isVarNode(node.args[0], 'name') && typeof node.args[1] === 'string') {
    return `{name: "${escapeJxaString(node.args[1])}"}`;
  }
  if (node.op === 'contains' && isVarNode(node.args[0], 'name') && typeof node.args[1] === 'string') {
    return `{name: {_contains: "${escapeJxaString(node.args[1])}"}}`;
  }
  return null;
}

function isVarNode(node: LoweredExpr, expectedName?: string): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  if (!('var' in node)) return false;
  if (expectedName) return (node as { var: string }).var === expectedName;
  return true;
}

function generatePerItemAccessor(name: string, def: VarDef, entity: EntityType): string {
  const overrides = perItemOverrides[entity];
  if (overrides[name]) return overrides[name];
  const prop = def.appleEventsProperty || name;
  if (def.type === 'date') {
    return `(function() { var v = item.${prop}(); return v ? v.toISOString() : null; })()`;
  }
  return `item.${prop}()`;
}

// ── JxaEmitter ───────────────────────────────────────────────────────────

export class JxaEmitter implements Emitter {

  propertyScan(node: BulkScan): ScriptFragment {
    return { body: this.generateBulkBody(node), resultType: 'rows' };
  }

  membershipLookup(node: MembershipScan): ScriptFragment {
    return { body: this.generateMembershipBody(node), resultType: 'idSet' };
  }

  perItemRead(ids: string[], perItemVars: Set<string>, entity: EntityType): ScriptFragment {
    return { body: this.generatePerItemBody(ids, perItemVars, entity), resultType: 'rows' };
  }

  wrapStandalone(fragment: ScriptFragment): string {
    return `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;

  return JSON.stringify((function() {
${fragment.body}
  })());
})()`;
  }

  wrapComposite(fragments: ScriptFragment[]): string {
    const slotIIFEs = fragments.map((f, i) =>
      `  _r[${i}] = (function() {\n${f.body}\n  })();`
    ).join('\n');

    return `(function() {
  var app = Application('OmniFocus');
  app.includeStandardAdditions = true;
  var doc = app.defaultDocument;
  var _r = [];
${slotIIFEs}
  return JSON.stringify(_r);
})()`;
  }

  // ── Body Generators ──────────────────────────────────────────────────

  private generateBulkBody(node: BulkScan): string {
    const registry = getVarRegistry(node.entity);
    const entityConfig = entityConfigs[node.entity];
    const entityChains = chainAccessors[node.entity];

    // Group vars by their bulk-read method
    const directProps: { name: string; appleEventsProperty: string; def: VarDef }[] = [];
    const chainProps: { name: string; def: VarDef }[] = [];

    // Map column names (nodeKeys) to var names
    const vars = new Set<string>();
    let needsId = false;
    for (const col of node.columns) {
      const varName = Object.keys(registry).find(k => registry[k].nodeKey === col);
      if (varName) {
        vars.add(varName);
        if (col === 'id') needsId = true;
      }
    }

    for (const varName of vars) {
      if (varName === 'now') continue;
      const def = registry[varName];
      if (!def) continue;
      if (def.appleEventsProperty && def.cost === 'easy') {
        directProps.push({ name: varName, appleEventsProperty: def.appleEventsProperty, def });
      } else if (def.cost === 'chain') {
        chainProps.push({ name: varName, def });
      }
    }

    // id is always bulk-readable
    if (needsId && !directProps.some(p => p.name === 'id')) {
      const idDef = registry['id'];
      if (idDef) directProps.push({ name: 'id', appleEventsProperty: idDef.appleEventsProperty || 'id', def: idDef });
    }

    // Source collection expression
    let sourceExpr: string;
    if (node.projectScope) {
      const scopeJxa = generateScopeWhose(node.projectScope);
      if (scopeJxa) {
        sourceExpr = `doc.flattenedProjects.whose(${scopeJxa})[0].flattenedTasks`;
      } else {
        sourceExpr = entityConfig.collection;
      }
    } else {
      sourceExpr = entityConfig.collection;
    }

    const PROJECT_STATUS_MAP = '{"active status":"Active","done status":"Done","on hold status":"OnHold","dropped status":"Dropped"}';

    // Generate bulk read lines for direct properties
    const readLines = directProps.map(({ name, appleEventsProperty, def }) => {
      const isDate = def.type === 'date';
      if (isDate) {
        return `  var ${name}Arr = items.${appleEventsProperty}();
  var ${name}Iso = ${name}Arr.map(function(v) { return v ? v.toISOString() : null; });`;
      }
      if (name === 'id') {
        return `  var idArr = items.id();
  var idKeys = idArr.map(function(v) { return v ? v.toString() : null; });`;
      }
      if (name === 'status' && node.entity === 'projects') {
        return `  var _rawStatusArr = items.${appleEventsProperty}();
  var _statusMap = ${PROJECT_STATUS_MAP};
  var statusArr = _rawStatusArr.map(function(v) { return _statusMap[String(v)] || String(v); });`;
      }
      return `  var ${name}Arr = items.${appleEventsProperty}();`;
    });

    // Chain properties
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
    if (node.includeCompleted || !entityConfig.activeFilters) {
      activeFilter = '';
    } else {
      const rules = entityConfig.activeFilters;
      const filterReadLines = rules.map((r, i) =>
        `  var _fa${i} = items.${r.bulkProperty}();`
      ).join('\n');

      const conditions = rules.map((r, i) => {
        if (r.keepWhen === 'active') {
          return `(function(){var _s=String(_fa${i}[j]);return _s.indexOf("active")===0||_s.indexOf("on hold")===0;})()`;
        }
        return r.keepWhen === 'false' ? `!_fa${i}[j]` : `_fa${i}[j]`;
      }).join(' && ');

      activeFilter = `
  // Filter to active items only
${filterReadLines}
  var len = _fa0.length;
  var activeIndices = [];
  for (var j = 0; j < len; j++) {
    if (${conditions}) activeIndices.push(j);
  }`;
    }

    const useFilter = activeFilter !== '';
    const indexVar = useFilter ? 'activeIndices[i]' : 'i';
    const loopLen = useFilter ? 'activeIndices.length' : `${allArrayNames[0] || 'idKeys'}.length`;

    // Build row construction
    const rowPropsIndexed = [
      ...directProps.map(({ name, def }) => {
        if (def.type === 'date') return `"${name}": ${name}Iso[${indexVar}]`;
        if (name === 'id') return `"id": idKeys[${indexVar}]`;
        return `"${name}": ${name}Arr[${indexVar}]`;
      }),
      ...chainProps.map(({ name }) => {
        // tags chain returns nested arrays — lowercase each tag name
        if (name === 'tags') {
          return `"tags": (tagsArr[${indexVar}] || []).map(function(t) { return t.toLowerCase(); })`;
        }
        return `"${name}": ${name}Arr[${indexVar}]`;
      })
    ];

    return `  var items = ${sourceExpr};

  // Bulk-read properties via Apple Events
${readLines.join('\n')}
${chainLines.join('\n')}

  // Alignment check
  var _lens = {${allArrayNames.map(a => `"${a}": ${a}.length`).join(', ')}};
  var _first = _lens["${allArrayNames[0]}"];
  for (var _k in _lens) {
    if (_lens[_k] !== _first) {
      return {error: "alignment mismatch", properties: Object.keys(_lens), lengths: _lens};
    }
  }
${activeFilter}

  // Build row objects
  var rows = [];
  for (var i = 0; i < ${loopLen}; i++) {
    rows.push({${rowPropsIndexed.join(', ')}});
  }

  return rows;`;
  }

  private generateMembershipBody(node: MembershipScan): string {
    const rel = relationships[node.sourceEntity]?.[node.targetEntity];
    if (!rel) {
      throw new Error(
        `No relationship defined: ${node.sourceEntity} → ${node.targetEntity}`
      );
    }

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
    if (!node.includeCompleted && rel.activeFilters) {
      const rules = rel.activeFilters;
      const filterReadLines = rules.map((r, i) =>
        `    var _mfa${i} = items.${r.bulkProperty}();`
      ).join('\n');
      const conditions = rules.map((r, i) => {
        if (r.keepWhen === 'active') {
          return `(function(){var _s=String(_mfa${i}[j]);return _s.indexOf("active")===0||_s.indexOf("on hold")===0;})()`;
        }
        return r.keepWhen === 'false' ? `!_mfa${i}[j]` : `_mfa${i}[j]`;
      }).join(' && ');
      activeFilterCode = `
${filterReadLines}
    var filtered = [];
    for (var j = 0; j < itemIds.length; j++) {
      if (${conditions}) filtered.push(itemIds[j]);
    }
    itemIds = filtered;`;
    }

    return `  var matches = ${sourceConfig.collection}.whose({name: "${escaped}"});
  var ids = [];
  for (var i = 0; i < matches.length; i++) {
    var items = matches[i].${rel.accessor};
    var itemIds = items.id();
    ${activeFilterCode}
    for (var j = 0; j < itemIds.length; j++) {
      ids.push(itemIds[j].toString());
    }
  }

  return ids;`;
  }

  private generatePerItemBody(ids: string[], perItemVars: Set<string>, entity: EntityType): string {
    const registry = getVarRegistry(entity);
    const config = entityConfigs[entity];
    const varEntries = [...perItemVars].map(name => {
      const def = registry[name];
      if (!def) throw new Error(`Unknown variable "${name}" for per-item read (entity: ${entity})`);
      return { name, def };
    });

    const accessors = varEntries.map(({ name, def }) => {
      return `        "${name}": ${generatePerItemAccessor(name, def, entity)}`;
    });

    const idsJson = JSON.stringify(ids);

    return `  var ids = ${idsJson};
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

  return results;`;
  }
}
