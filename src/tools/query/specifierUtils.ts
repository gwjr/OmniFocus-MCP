/**
 * Specifier traversal utilities.
 *
 * Extracted from eventPlanUtils.ts to avoid import cycles between
 * eventPlanUtils.ts and eventNodeRegistry.ts.
 */

import type { Ref, Specifier } from './eventPlan.js';

/**
 * Collect all Ref values reachable from a Specifier tree.
 * Both parent refs and ByID/ByName id/name refs are included.
 */
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

/**
 * Rewrite all Ref values in a Specifier tree using the given remapping function.
 */
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

export function rewriteParent(p: Specifier | Ref, remap: (r: Ref) => Ref): Specifier | Ref {
  return typeof p === 'number' ? remap(p) : rewriteSpec(p, remap);
}
