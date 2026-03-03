/**
 * Shared EventPlan utilities.
 *
 * Extracted from eventPlanCSE.ts, eventPlanColumnPrune.ts, and
 * targetedEventPlanLowering.ts to eliminate duplication.
 *
 * Provides:
 *   - defaultRuntime:      node kind → default Runtime
 *   - collectRefs:         extract all Ref inputs for a node
 *   - rewriteNode/Spec:    apply a Ref remapping to a node/specifier
 */

import type { EventNode, Ref, Runtime, Specifier } from './eventPlan.js';

// ── Default runtime per node kind ────────────────────────────────────────────

export function defaultRuntime(node: EventNode): Runtime {
  switch (node.kind) {
    case 'Get':
    case 'Count':
    case 'Set':
    case 'Command':
    case 'ForEach':
      return 'jxa';
    case 'Zip':
    case 'Filter':
    case 'SemiJoin':
    case 'HashJoin':
    case 'Sort':
    case 'Limit':
    case 'Pick':
    case 'Derive':
    case 'ColumnValues':
    case 'Flatten':
    case 'Union':
    case 'RowCount':
    case 'AddSwitch':
      return 'node';
  }
}

// ── Collect all Ref inputs for a node ────────────────────────────────────────

export function collectRefs(node: EventNode): Ref[] {
  const refs: Ref[] = [];

  switch (node.kind) {
    case 'Get':
    case 'Count':
      collectSpecifierRefs(node.specifier, refs);
      break;
    case 'Set':
      collectSpecifierRefs(node.specifier, refs);
      refs.push(node.value);
      break;
    case 'Command':
      collectSpecifierRefs(node.target, refs);
      for (const v of Object.values(node.args)) {
        if (typeof v === 'number') refs.push(v);
      }
      break;
    case 'ForEach':
      refs.push(node.source);
      break;
    case 'Zip':
      for (const col of node.columns) refs.push(col.ref);
      break;
    case 'Filter':
      refs.push(node.source);
      break;
    case 'SemiJoin':
      refs.push(node.source, node.ids);
      break;
    case 'HashJoin':
      refs.push(node.source, node.lookup);
      break;
    case 'Sort':
    case 'Limit':
    case 'Pick':
    case 'Derive':
    case 'ColumnValues':
    case 'Flatten':
    case 'RowCount':
    case 'AddSwitch':
      refs.push(node.source);
      break;
    case 'Union':
      refs.push(node.left, node.right);
      break;
  }

  return refs;
}

export function collectSpecifierRefs(spec: Specifier, refs: Ref[]): void {
  if (spec.kind === 'Document') return;

  if (typeof spec.parent === 'number') {
    refs.push(spec.parent);
  } else {
    collectSpecifierRefs(spec.parent, refs);
  }

  if (spec.kind === 'ByID' && typeof spec.id === 'number') {
    refs.push(spec.id);
  }
  if (spec.kind === 'ByName' && typeof spec.name === 'number') {
    refs.push(spec.name);
  }
}

// ── Ref rewriting ────────────────────────────────────────────────────────────

export function rewriteSpec(spec: Specifier, remap: (r: Ref) => Ref): Specifier {
  switch (spec.kind) {
    case 'Document': return spec;
    case 'Elements': return { ...spec, parent: rewriteParent(spec.parent, remap) };
    case 'Property': return { ...spec, parent: rewriteParent(spec.parent, remap) };
    case 'ByID':     return {
      ...spec,
      parent: rewriteParent(spec.parent, remap),
      id: typeof spec.id === 'number' ? remap(spec.id) : spec.id,
    };
    case 'ByName':   return {
      ...spec,
      parent: rewriteParent(spec.parent, remap),
      name: typeof spec.name === 'number' ? remap(spec.name) : spec.name,
    };
    case 'ByIndex':  return { ...spec, parent: rewriteParent(spec.parent, remap) };
    case 'Whose':    return { ...spec, parent: rewriteParent(spec.parent, remap) };
  }
}

function rewriteParent(p: Specifier | Ref, remap: (r: Ref) => Ref): Specifier | Ref {
  return typeof p === 'number' ? remap(p) : rewriteSpec(p, remap);
}

export function rewriteNode(node: EventNode, remap: (r: Ref) => Ref): EventNode {
  switch (node.kind) {
    case 'Get':
      return { ...node, specifier: rewriteSpec(node.specifier, remap) };
    case 'Count':
      return { ...node, specifier: rewriteSpec(node.specifier, remap) };
    case 'Set':
      return { ...node, specifier: rewriteSpec(node.specifier, remap), value: remap(node.value) };
    case 'Command':
      return {
        ...node,
        target: rewriteSpec(node.target, remap),
        args: Object.fromEntries(
          Object.entries(node.args).map(([k, v]) =>
            [k, typeof v === 'number' ? remap(v) : v]
          )
        ),
      };
    case 'ForEach':
      return {
        ...node,
        source: remap(node.source),
        body: node.body.map(n => rewriteNode(n, remap)),
        collect: remap(node.collect),
      };
    case 'Zip':
      return {
        ...node,
        columns: node.columns.map(c => ({ ...c, ref: remap(c.ref) })),
      };
    case 'ColumnValues':
      return { ...node, source: remap(node.source) };
    case 'Flatten':
      return { ...node, source: remap(node.source) };
    case 'Filter':
      return { ...node, source: remap(node.source) };
    case 'SemiJoin':
      return { ...node, source: remap(node.source), ids: remap(node.ids) };
    case 'HashJoin':
      return { ...node, source: remap(node.source), lookup: remap(node.lookup) };
    case 'Sort':
      return { ...node, source: remap(node.source) };
    case 'Limit':
      return { ...node, source: remap(node.source) };
    case 'Pick':
      return { ...node, source: remap(node.source) };
    case 'Derive':
      return { ...node, source: remap(node.source) };
    case 'Union':
      return { ...node, left: remap(node.left), right: remap(node.right) };
    case 'RowCount':
      return { ...node, source: remap(node.source) };
    case 'AddSwitch':
      return { ...node, source: remap(node.source) };
  }
}
