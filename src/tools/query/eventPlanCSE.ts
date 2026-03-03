/**
 * Common Subexpression Elimination for EventPlan IR.
 *
 * Unifies Get nodes whose specifiers are structurally identical,
 * then compacts the node array removing dead slots.
 */

import type { EventPlan, EventNode, Specifier, Ref } from './eventPlan.js';

// ── Specifier keying ────────────────────────────────────────────────────────

function specKey(spec: Specifier, canonical: (r: Ref) => Ref): string {
  switch (spec.kind) {
    case 'Document': return 'D';
    case 'Elements': return `E(${parentKey(spec.parent, canonical)},${spec.classCode})`;
    case 'Property': return `P(${parentKey(spec.parent, canonical)},${spec.propCode})`;
    case 'ByID':     return `I(${parentKey(spec.parent, canonical)},${idKey(spec.id, canonical)})`;
    case 'ByName':   return `N(${parentKey(spec.parent, canonical)},${nameKey(spec.name, canonical)})`;
    case 'ByIndex':  return `X(${parentKey(spec.parent, canonical)},${spec.index})`;
    case 'Whose':    return `W(${parentKey(spec.parent, canonical)},${spec.prop},${spec.match},${JSON.stringify(spec.value)})`;
  }
}

function parentKey(p: Specifier | Ref, canonical: (r: Ref) => Ref): string {
  return typeof p === 'number' ? `@${canonical(p)}` : specKey(p, canonical);
}

function idKey(id: string | Ref, canonical: (r: Ref) => Ref): string {
  return typeof id === 'number' ? `@${canonical(id)}` : JSON.stringify(id);
}

function nameKey(name: string | Ref, canonical: (r: Ref) => Ref): string {
  return typeof name === 'number' ? `@${canonical(name)}` : JSON.stringify(name);
}

// ── Ref rewriting ───────────────────────────────────────────────────────────

function rewriteSpec(spec: Specifier, remap: (r: Ref) => Ref): Specifier {
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

function rewriteNode(node: EventNode, remap: (r: Ref) => Ref): EventNode {
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

// ── CSE pass ────────────────────────────────────────────────────────────────

export function cseEventPlan(plan: EventPlan): EventPlan {
  const n = plan.nodes.length;

  // Pass 1: build canonical map (rename[i] = canonical ref for node i)
  const rename = new Array<Ref>(n);
  const seen = new Map<string, Ref>();

  function canonical(r: Ref): Ref {
    // Follow rename chain (rename is filled left-to-right, so no cycles)
    while (rename[r] !== undefined && rename[r] !== r) {
      r = rename[r];
    }
    return r;
  }

  for (let i = 0; i < n; i++) {
    const node = plan.nodes[i];
    if (node.kind === 'Get') {
      const key = specKey(node.specifier, canonical);
      const existing = seen.get(key);
      if (existing !== undefined) {
        rename[i] = existing;
      } else {
        rename[i] = i;
        seen.set(key, i);
      }
    } else {
      rename[i] = i;
    }
  }

  // Pass 2: rewrite all Refs using canonical mapping
  const rewritten = plan.nodes.map(node => rewriteNode(node, canonical));
  const newResult = canonical(plan.result);

  // Pass 3: compact — remove eliminated nodes
  const survivors: number[] = [];
  for (let i = 0; i < n; i++) {
    if (rename[i] === i) {
      survivors.push(i);
    }
  }

  // If nothing was eliminated, return rewritten plan directly
  if (survivors.length === n) {
    return { nodes: rewritten, result: newResult };
  }

  // Build compaction map: old index → new index
  const compact = new Map<Ref, Ref>();
  for (let newIdx = 0; newIdx < survivors.length; newIdx++) {
    compact.set(survivors[newIdx], newIdx);
  }

  function compactRef(r: Ref): Ref {
    const mapped = compact.get(r);
    if (mapped === undefined) {
      // This ref was eliminated — it should have been canonicalized already
      // by pass 2, so look up its canonical form
      const c = canonical(r);
      const m = compact.get(c);
      if (m === undefined) {
        throw new Error(`CSE compact: dangling ref ${r} (canonical ${c})`);
      }
      return m;
    }
    return mapped;
  }

  const compactedNodes = survivors.map(oldIdx =>
    rewriteNode(rewritten[oldIdx], compactRef)
  );

  return {
    nodes: compactedNodes,
    result: compactRef(newResult),
  };
}
