/**
 * SetIR → EventPlan lowering pass.
 *
 * Purely structural: each SetIrNode kind maps to one or more EventNodes.
 * No domain knowledge — active-filter predicates and any other implicit
 * constraints are injected into the predicate tree by the caller (tool
 * function) before lowerToSetIr is called.
 *
 * Mappings:
 *   Scan(entity, cols)          → Get(Elements) + Get(Property)×n + Zip
 *   Filter(src, pred, entity)   → Filter
 *   Intersect(L, R)             → SemiJoin(L, ColumnValues(R, 'id'))
 *   Union(L, R)                 → Union(L, R)
 *   Enrich(src, entity, cols)   → ColumnValues(id) + ForEach(ByID+props) + HashJoin
 *   ContainerMembers(...)       → Whose + ForEach(elements+id) + Flatten + Zip({id})
 *   Count(src)                  → RowCount(src)
 *   Sort(src, by, dir)          → Sort
 *   Limit(src, n)               → Limit
 */

import type { EventNode, EventPlan, Ref } from './eventPlan.js';
import type { SetIrNode, ContainerMembersNode } from './setIr.js';
import type { EntityType } from './variables.js';
import {
  classCode,
  propSpec,
  type PropSpec,
} from './strategyToEventPlan.js';

// ── Builder ──────────────────────────────────────────────────────────────

function builder() {
  const nodes: EventNode[] = [];
  const push = (n: EventNode): Ref => { nodes.push(n); return nodes.length - 1; };
  return { nodes, push };
}

// ── Scan ─────────────────────────────────────────────────────────────────

function lowerScan(
  entity: EntityType,
  columns: string[],
  push: (n: EventNode) => Ref,
): Ref {
  const elemRef = push({
    kind: 'Get',
    specifier: { kind: 'Elements', parent: { kind: 'Document' }, classCode: classCode(entity) },
    effect: 'nonMutating',
  });

  // Always include 'id'; deduplicate
  const colSet = new Set(['id', ...columns]);

  const colRefs: { name: string; ref: Ref }[] = [];
  for (const col of colSet) {
    const spec = propSpec(entity, col);
    const ref = emitPropRead(spec, elemRef, push);
    colRefs.push({ name: col, ref });
  }

  return push({ kind: 'Zip', columns: colRefs });
}

/** Emit a Get for a simple or chain property specifier off a parent ref. */
function emitPropRead(spec: PropSpec, parent: Ref, push: (n: EventNode) => Ref): Ref {
  if (spec.kind === 'simple') {
    return push({
      kind: 'Get',
      specifier: { kind: 'Property', parent, propCode: spec.code },
      effect: 'nonMutating',
    });
  }
  // Chain: Property(Property(parent, relation), terminal)
  return push({
    kind: 'Get',
    specifier: {
      kind: 'Property',
      parent: { kind: 'Property', parent, propCode: spec.relation },
      propCode: spec.terminal,
    },
    effect: 'nonMutating',
  });
}

// ── Join-based Enrich ─────────────────────────────────────────────────────

/**
 * Properties that cannot be read via chain access and must instead be
 * resolved by joining against a related entity scan.
 *
 * This applies to variables where the chain-relation property may point to
 * different AE object types (e.g. project.container can be a Folder or the
 * Document).  When the relation points to the Document, chaining through it
 * to read a sub-property returns `missing value` and per-item access errors.
 * Bulk-reading the relation ID (e.g. container.id()) does work, so we read
 * that, then join against the related entity scan.
 *
 * Pattern (for each column c in this table):
 *   1. lowerScan(entity, [idPropName])  — bulk chain read for relation ID
 *   2. SemiJoin to source IDs           — filter to rows we actually need
 *   3. lowerScan(joinEntity, [c])       — scan join entity for {id, joinField}
 *   4. HashJoin step-2 + step-3 on idPropName = joinEntity.id
 *      → null for rows whose idPropName has no match (e.g. top-level projects)
 *   5. HashJoin source + step-4 on id = id → merges c back onto source rows
 *
 * TODO: once the legacy pipeline is removed, declare these specs at the
 * PropSpec level in strategyToEventPlan.ts and replace this table with a
 * proper CrossEntityJoin SetIR node that is lowered here.
 */
interface JoinSpec {
  idPropName: string;   // variable name whose propSpec gives the relation entity ID
  joinEntity: EntityType;
  joinField:  string;   // field in joinEntity that supplies the output value
}

const JOIN_PROPS: Readonly<Record<string, Readonly<Record<string, JoinSpec>>>> = {
  projects: {
    // container.name() fails when container is the Document (top-level projects).
    // container.id() works in bulk; join that against folders.{id,name}.
    folderName: { idPropName: 'folderId', joinEntity: 'folders', joinField: 'name' },
  },
  tags: {
    // container.name() fails when container is the tag-root (Document).
    // container.id() works in bulk; self-join against tags.{id,name}.
    parentName: { idPropName: 'parentId', joinEntity: 'tags', joinField: 'name' },
  },
};

function lowerJoinEnrich(
  sourceRef: Ref,
  entity: EntityType,
  col: string,
  spec: JoinSpec,
  push: (n: EventNode) => Ref,
): Ref {
  // 1. Bulk-scan entity for {id, idPropName} — chain bulk read works here
  const entityScanRef = lowerScan(entity, [spec.idPropName], push);

  // 2. SemiJoin: keep only the entity rows whose id is in source
  const sourceIdsRef = push({ kind: 'ColumnValues', source: sourceRef, field: 'id' });
  const filteredRef  = push({ kind: 'SemiJoin', source: entityScanRef, ids: sourceIdsRef });

  // 3. Scan join entity for {id, joinField}
  const joinScanRef = lowerScan(spec.joinEntity, [spec.joinField], push);

  // 4. HashJoin: filteredRef.idPropName = joinScan.id → adds col.
  //    Rows with no matching join-entity entry get col = null
  //    (e.g. top-level projects not in any folder).
  const enrichedRef = push({
    kind:      'HashJoin',
    source:    filteredRef,
    lookup:    joinScanRef,
    sourceKey: spec.idPropName,
    lookupKey: 'id',
    fieldMap:  { [spec.joinField]: col },
  });

  // 5. HashJoin: merge col back onto the original source rows
  return push({
    kind:      'HashJoin',
    source:    sourceRef,
    lookup:    enrichedRef,
    sourceKey: 'id',
    lookupKey: 'id',
    fieldMap:  { [col]: col },
  });
}

// ── Enrich ───────────────────────────────────────────────────────────────

function lowerEnrich(
  sourceRef: Ref,
  entity: EntityType,
  columns: string[],
  push: (n: EventNode) => Ref,
  nodes: EventNode[],
): Ref {
  // Extract IDs from source rows
  const cvRef = push({ kind: 'ColumnValues', source: sourceRef, field: 'id' });

  // Build ForEach body
  const forEachIdx = nodes.length;
  const bodyNodes: EventNode[] = [];

  // body[0] = Get(ByID(Elements(Document, classCode), forEachIdx))
  bodyNodes.push({
    kind: 'Get',
    specifier: {
      kind: 'ByID',
      parent: { kind: 'Elements', parent: { kind: 'Document' }, classCode: classCode(entity) },
      id: forEachIdx as Ref,
    },
    effect: 'nonMutating',
  });

  const byIdRef = 0 as Ref; // body-local index

  // body[1..n] = Get(Property(byIdRef, propCode)) for each column
  const varBodyRefs: { name: string; ref: Ref }[] = [];
  for (const col of columns) {
    const bodyIdx = bodyNodes.length;
    const spec = propSpec(entity, col);
    if (spec.kind === 'simple') {
      bodyNodes.push({
        kind: 'Get',
        specifier: { kind: 'Property', parent: byIdRef, propCode: spec.code },
        effect: 'nonMutating',
      });
    } else {
      bodyNodes.push({
        kind: 'Get',
        specifier: {
          kind: 'Property',
          parent: { kind: 'Property', parent: byIdRef, propCode: spec.relation },
          propCode: spec.terminal,
        },
        effect: 'nonMutating',
      });
    }
    varBodyRefs.push({ name: col, ref: bodyIdx as Ref });
  }

  // body[n+1] = Zip([{name:'id', ref:forEachIdx}, ...cols])
  const zipBodyIdx = bodyNodes.length;
  bodyNodes.push({
    kind: 'Zip',
    columns: [{ name: 'id', ref: forEachIdx as Ref }, ...varBodyRefs],
  });

  const feRef = push({
    kind: 'ForEach',
    source: cvRef,
    body: bodyNodes,
    collect: zipBodyIdx,
    effect: 'nonMutating',
  });

  // HashJoin: merge per-item enriched rows back onto source rows
  const fieldMap: Record<string, string> = {};
  for (const col of columns) fieldMap[col] = col;

  return push({
    kind: 'HashJoin',
    source: sourceRef,
    lookup: feRef,
    sourceKey: 'id',
    lookupKey: 'id',
    fieldMap,
  });
}

// ── ContainerMembers ─────────────────────────────────────────────────────

/**
 * Lower a ContainerMembers node.
 *
 * Mirrors the forward-direction MembershipScan lowering in strategyToEventPlan:
 *   1. Whose(Elements(Document, containerClass), name, eq|contains, value)
 *      → matching container AE objects
 *   2. ForEach: for each container, Get(Elements(container, targetClass))
 *              then Get(Property(elements, 'ID  '))
 *   3. Flatten nested ID arrays → flat string[]
 *   4. Zip into {id: string}[] rows so Intersect can use ColumnValues(R, 'id')
 *
 * Complex containerPredicates (not simple eq/contains on name) are not yet
 * supported and will throw. The fallback is to execute the container query
 * as a separate sub-plan — a future extension.
 */
function lowerContainerMembers(
  node: ContainerMembersNode,
  push: (n: EventNode) => Ref,
  nodes: EventNode[],
): Ref {
  const { targetEntity, containerType, containerPredicate } = node;

  const containerEntity: EntityType =
    containerType === 'tag'     ? 'tags'     :
    containerType === 'folder'  ? 'folders'  : 'projects';

  // Parse simple name-equality predicate (the common case)
  const parsed = parseNamePred(containerPredicate);
  if (!parsed) {
    throw new Error(
      `lowerSetIrToEventPlan: ContainerMembers only supports simple eq/contains on ` +
      `name. Got: ${JSON.stringify(containerPredicate)}`
    );
  }

  const nameSpec = propSpec(containerEntity, 'name');
  if (nameSpec.kind !== 'simple') throw new Error('name is always a simple property');

  // %filtered = Get(Whose(Elements(Document, containerClass), nameCode, match, value))
  const filteredRef = push({
    kind: 'Get',
    specifier: {
      kind: 'Whose',
      parent: {
        kind: 'Elements',
        parent: { kind: 'Document' },
        classCode: classCode(containerEntity),
      },
      prop: nameSpec.code,
      match: parsed.match,
      value: parsed.value,
    },
    effect: 'nonMutating',
  });

  // ForEach: for each matching container, collect target-entity IDs
  const forEachIdx = nodes.length;
  const bodyNodes: EventNode[] = [];

  // body[0] = Get(Elements(forEachIdx, classCode(targetEntity)))
  bodyNodes.push({
    kind: 'Get',
    specifier: {
      kind: 'Elements',
      parent: forEachIdx as Ref,
      classCode: classCode(targetEntity),
    },
    effect: 'nonMutating',
  });

  // body[1] = Get(Property(body[0], 'ID  '))
  bodyNodes.push({
    kind: 'Get',
    specifier: { kind: 'Property', parent: 0 as Ref, propCode: 'ID  ' },
    effect: 'nonMutating',
  });

  const forEachRef = push({
    kind: 'ForEach',
    source: filteredRef,
    body: bodyNodes,
    collect: 1, // collect body[1]: the ID arrays
    effect: 'nonMutating',
  });

  // Flatten [[id1,id2],[id3]] → [id1,id2,id3]
  const flatRef = push({ kind: 'Flatten', source: forEachRef });

  // Zip into {id: ...} rows so Intersect can extract via ColumnValues(R, 'id')
  return push({ kind: 'Zip', columns: [{ name: 'id', ref: flatRef }] });
}

/**
 * Parse a simple name predicate: eq(name, 'value') or contains(name, 'value').
 * Returns null for anything else.
 */
function parseNamePred(
  pred: import('./fold.js').LoweredExpr,
): { match: 'eq' | 'contains'; value: string } | null {
  if (typeof pred !== 'object' || pred === null || Array.isArray(pred)) return null;
  const node = pred as { op?: string; args?: unknown[] };
  if ((node.op !== 'eq' && node.op !== 'contains') || !Array.isArray(node.args)) return null;
  const [lhs, rhs] = node.args as [unknown, unknown];
  // Accept either (var:name, literal) or (literal, var:name)
  const isNameVar = (x: unknown) =>
    typeof x === 'object' && x !== null && 'var' in (x as object) && (x as { var: string }).var === 'name';
  if (isNameVar(lhs) && typeof rhs === 'string') return { match: node.op, value: rhs };
  if (isNameVar(rhs) && typeof lhs === 'string') return { match: node.op, value: lhs };
  return null;
}

// ── Main lowering ─────────────────────────────────────────────────────────

/**
 * Lower a SetIR tree to an EventPlan.
 *
 * @param outputColumns  When provided, a Pick node is appended to project
 *   the result to exactly these columns. This enables the column pruner to
 *   eliminate any upstream columns that are structurally required by the IR
 *   (e.g. 'id' for Intersect join keys) but not needed in the final output.
 */
export function lowerSetIrToEventPlan(root: SetIrNode, outputColumns?: string[]): EventPlan {
  const { nodes, push } = builder();

  function lower(node: SetIrNode): Ref {
    switch (node.kind) {

      case 'Scan':
        return lowerScan(node.entity, node.columns, push);

      case 'Filter': {
        const srcRef = lower(node.source);
        if (node.predicate === true || node.predicate === null) return srcRef;
        return push({ kind: 'Filter', source: srcRef, predicate: node.predicate, entity: node.entity });
      }

      case 'Intersect': {
        const leftRef  = lower(node.left);
        const rightRef = lower(node.right);
        // Extract the id column from the right side for use as the SemiJoin id set
        const idsRef = push({ kind: 'ColumnValues', source: rightRef, field: 'id' });
        return push({ kind: 'SemiJoin', source: leftRef, ids: idsRef });
      }

      case 'Union': {
        const leftRef  = lower(node.left);
        const rightRef = lower(node.right);
        return push({ kind: 'Union', left: leftRef, right: rightRef });
      }

      case 'Difference': {
        const leftRef  = lower(node.left);
        const rightRef = lower(node.right);
        const idsRef = push({ kind: 'ColumnValues', source: rightRef, field: 'id' });
        return push({ kind: 'SemiJoin', source: leftRef, ids: idsRef, exclude: true });
      }

      case 'Enrich': {
        const srcRef = lower(node.source);
        const joinTable = JOIN_PROPS[node.entity] ?? {};
        const directCols = node.columns.filter(c => !(c in joinTable));
        const joinCols   = node.columns.filter(c =>   c in joinTable);

        let enrichRef = srcRef;
        if (directCols.length > 0) {
          enrichRef = lowerEnrich(enrichRef, node.entity, directCols, push, nodes);
        }
        for (const col of joinCols) {
          enrichRef = lowerJoinEnrich(enrichRef, node.entity, col, joinTable[col], push);
        }
        return enrichRef;
      }

      case 'ContainerMembers':
        return lowerContainerMembers(node, push, nodes);

      case 'Count':
        return push({ kind: 'RowCount', source: lower(node.source) });

      case 'Sort':
        return push({ kind: 'Sort', source: lower(node.source), by: node.by, dir: node.direction });

      case 'Limit':
        return push({ kind: 'Limit', source: lower(node.source), n: node.n });

      case 'AddSwitch': {
        const srcRef = lower(node.source);
        const defaultVal: import('./fold.js').LoweredExpr | 'error' =
          typeof node.default === 'object' &&
          node.default !== null &&
          !Array.isArray(node.default) &&
          (node.default as { kind?: string }).kind === 'Error'
            ? 'error'
            : node.default as import('./fold.js').LoweredExpr;
        return push({
          kind: 'AddSwitch',
          source: srcRef,
          entity: node.entity,
          column: node.column,
          cases: node.cases,
          default: defaultVal,
        });
      }

      case 'Error':
        throw new Error(
          `lowerSetIrToEventPlan: Error node not eliminated by optimizer` +
          (node.message ? `: ${node.message}` : '')
        );

      default: {
        const _exhaustive: never = node;
        throw new Error(`lowerSetIrToEventPlan: unknown node kind '${(_exhaustive as SetIrNode).kind}'`);
      }
    }
  }

  let result = lower(root);

  // When the caller specifies output columns, append a Pick so the column
  // pruner can propagate the narrow set and eliminate dead upstream reads
  // (e.g. 'id' injected by scan() but not needed in the final output).
  if (outputColumns && outputColumns.length > 0) {
    result = push({ kind: 'Pick', source: result, fields: outputColumns });
  }

  return { nodes, result };
}
