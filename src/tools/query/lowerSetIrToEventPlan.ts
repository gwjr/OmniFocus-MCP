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
 *   Restriction(src,fk,lookup)  → SemiJoin(src, ColumnValues(lookup,'id'), field:fk)
 *   Count(src)                  → RowCount(src)
 *   Sort(src, by, dir)          → Sort
 *   Limit(src, n)               → Limit
 */

import type { EventNode, EventPlan, Ref } from './eventPlan.js';
import type { SetIrNode, RestrictionNode, TagNameTaskIdsNode, SimilarItemsNode } from './setIr.js';
import type { EntityType } from './variables.js';
import {
  classCode,
  propSpec,
  getJoinSpec,
  type PropSpec,
} from './aeProps.js';
import { OFClass, OFElement, OFTagProp, OFTaskProp } from '../../generated/omnifocus-sdef.js';

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
 * Enrich a column that requires a join rather than a direct chain read.
 *
 * Join specs are declared on ChainProp entries in aeProps.ts (joinSpec field).
 * This applies to variables where the chain-relation property may point to
 * different AE object types (e.g. project.container can be a Folder or the
 * Document), causing chain reads to return missing values.
 *
 * Pattern:
 *   1. lowerScan(entity, [idPropName])  — bulk chain read for relation ID
 *   2. SemiJoin to source IDs           — filter to rows we actually need
 *   3. lowerScan(joinEntity, [joinField]) — scan join entity for {id, joinField}
 *   4. HashJoin step-2 + step-3 on idPropName = joinEntity.id
 *      → null for rows whose idPropName has no match (e.g. top-level projects)
 *   5. HashJoin source + step-4 on id = id → merges col back onto source rows
 */
function lowerJoinEnrich(
  sourceRef: Ref,
  entity: EntityType,
  col: string,
  spec: NonNullable<import('./aeProps.js').ChainProp['joinSpec']>,
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

// ── Restriction ───────────────────────────────────────────────────────────

/**
 * Lower a Restriction node (FK-based semi-join).
 *
 * Strategy:
 *   1. Lower source → rows with {id, fkColumn}
 *   2. Lower lookup → rows of the container entity satisfying its predicate
 *   3. Extract container IDs: ColumnValues(lookup, 'id') → string[]
 *   4. SemiJoin(source, ids, field: fkColumn [, arrayField: true for tag arrays])
 *      → rows from source where source[fkColumn] ∈ ids
 *
 * All operations are bulk AE reads + node-side filtering — no per-item round-trips.
 */
function lowerRestriction(
  node: RestrictionNode,
  lower: (n: SetIrNode) => Ref,
  push: (n: EventNode) => Ref,
): Ref {
  const sourceRef    = lower(node.source);
  const lookupRef    = lower(node.lookup);
  const lookupCol    = node.lookupColumn ?? 'id';
  let lookupIdsRef   = push({ kind: 'ColumnValues', source: lookupRef, field: lookupCol });
  if (node.flattenLookup) {
    lookupIdsRef = push({ kind: 'Flatten', source: lookupIdsRef });
  }
  return push({
    kind:       'SemiJoin',
    source:     sourceRef,
    ids:        lookupIdsRef,
    field:      node.fkColumn,
    arrayField: node.arrayFk,
  });
}

// ── TagNameTaskIds ────────────────────────────────────────────────────────

/**
 * Lower a TagNameTaskIds node to EventPlan.
 *
 * Emits:
 *   ref0: Get(Whose(Elements(Document, flattenedTag), name, match, value))
 *   ref1: Get(Elements(ref0, flattenedTask))
 *   ref2: Get(Property(ref1, id))
 *   ref3: Zip([{name:'id', ref:ref2}])
 *
 * This is the "tag name shortcut": instead of scanning all tags + all task
 * tagIds arrays, look up the tag by name with .whose() (fast for targeted
 * lookups) and traverse its tasks.id() relationship.
 */
function lowerTagNameTaskIds(
  node: TagNameTaskIdsNode,
  push: (n: EventNode) => Ref,
): Ref {
  // Step 1: Get the tag(s) matching the name via .whose()
  const tagRef = push({
    kind: 'Get',
    specifier: {
      kind: 'Whose',
      parent: { kind: 'Elements', parent: { kind: 'Document' }, classCode: OFClass.flattenedTag },
      prop: OFTagProp.name,
      match: node.match,
      value: node.tagName,
    },
    effect: 'nonMutating',
  });

  // Step 2: Get the tasks belonging to those tags
  const tasksRef = push({
    kind: 'Get',
    specifier: { kind: 'Elements', parent: tagRef, classCode: OFElement.flattenedTask },
    effect: 'nonMutating',
  });

  // Step 3: Get the IDs of those tasks
  const idsRef = push({
    kind: 'Get',
    specifier: { kind: 'Property', parent: tasksRef, propCode: OFTaskProp.id },
    effect: 'nonMutating',
  });

  // Step 4: Zip into rows with {id}
  return push({ kind: 'Zip', columns: [{ name: 'id', ref: idsRef }] });
}

// ── SimilarItems ──────────────────────────────────────────────────────────

/**
 * Lower a SimilarItems node to EventPlan.
 *
 * Emits a two-node chain:
 *   ref0: Embed(query)            — JXA, calls embeddingd → number[384]
 *   ref1: SemanticSearch(entity, ref0) — Node, KNN against sqlite-vec → {id, distance}[]
 */
function lowerSimilarItems(
  node: SimilarItemsNode,
  push: (n: EventNode) => Ref,
): Ref {
  // Step 1: Embed the query string (JXA — calls embeddingd via Apple Events)
  const embedRef = push({
    kind: 'Embed',
    query: node.query,
  } as EventNode);

  // Step 2: KNN search against the semantic index (Node-side)
  const searchRef = push({
    kind: 'SemanticSearch',
    entity: node.entity,
    embeddingRef: embedRef,
  } as EventNode);

  return searchRef;
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
        const filteredRef = push({ kind: 'SemiJoin', source: leftRef, ids: idsRef });

        // When mergeColumns is set, enrich the filtered rows with columns
        // from the right side via HashJoin (e.g. similarity from SimilarItems).
        if (node.mergeColumns && node.mergeColumns.length > 0) {
          const fieldMap: Record<string, string> = {};
          for (const col of node.mergeColumns) fieldMap[col] = col;
          return push({
            kind: 'HashJoin',
            source: filteredRef,
            lookup: rightRef,
            sourceKey: 'id',
            lookupKey: 'id',
            fieldMap,
          });
        }

        return filteredRef;
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
        const directCols: string[] = [];
        const joinCols: { col: string; spec: NonNullable<import('./aeProps.js').ChainProp['joinSpec']> }[] = [];
        for (const c of node.columns) {
          const js = getJoinSpec(node.entity, c);
          if (js) joinCols.push({ col: c, spec: js });
          else    directCols.push(c);
        }

        let enrichRef = srcRef;
        if (directCols.length > 0) {
          enrichRef = lowerEnrich(enrichRef, node.entity, directCols, push, nodes);
        }
        for (const { col, spec } of joinCols) {
          enrichRef = lowerJoinEnrich(enrichRef, node.entity, col, spec, push);
        }
        return enrichRef;
      }

      case 'Restriction':
        return lowerRestriction(node, lower, push);

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

      case 'TagNameTaskIds':
        return lowerTagNameTaskIds(node, push);

      case 'SimilarItems':
        return lowerSimilarItems(node, push);

      case 'Error':
        throw new Error(
          `lowerSetIrToEventPlan: Error node survived into lowering (this is a planner/optimizer bug — ` +
          `optimizeSetIr should simplify Error nodes via algebraic identities: ` +
          `Union(Error,R)→R, Intersect(Error,R)→Error, etc.)` +
          (node.message ? `. Original error: ${node.message}` : '')
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
