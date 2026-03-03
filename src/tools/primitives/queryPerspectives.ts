/**
 * Perspectives query handler.
 *
 * Perspectives have no Apple Events class code and cannot be queried via
 * the SetIR / EventPlan pipeline. This module handles them via OmniJS
 * (evaluateJavascript) with optional Node-side predicate filtering.
 */

import { executeOmniFocusScript } from '../../utils/scriptExecution.js';
import { compileNodePredicate } from '../query/backends/nodeEval.js';
import type { LoweredExpr } from '../query/fold.js';
import type { Row } from '../query/backends/nodeEval.js';

const PERSPECTIVES_SCRIPT = `(() => {
  try {
    var items = [];

    var builtIns = [
      { obj: Perspective.BuiltIn.Inbox, name: "Inbox" },
      { obj: Perspective.BuiltIn.Projects, name: "Projects" },
      { obj: Perspective.BuiltIn.Tags, name: "Tags" },
      { obj: Perspective.BuiltIn.Forecast, name: "Forecast" },
      { obj: Perspective.BuiltIn.Flagged, name: "Flagged" },
      { obj: Perspective.BuiltIn.Review, name: "Review" }
    ];
    builtIns.forEach(function(p) {
      items.push({
        id: "builtin_" + p.name.toLowerCase(),
        name: p.name,
        type: "builtin"
      });
    });

    try {
      var customs = Perspective.Custom.all;
      if (customs && customs.length > 0) {
        customs.forEach(function(p) {
          items.push({
            id: p.identifier || ("custom_" + p.name.toLowerCase().replace(/\\s+/g, "_")),
            name: p.name,
            type: "custom"
          });
        });
      }
    } catch (e) {
      // Custom perspectives not available (Standard edition)
    }

    return JSON.stringify({ items: items, count: items.length, error: null });
  } catch (error) {
    return JSON.stringify({ error: error.toString(), items: [], count: 0 });
  }
})()`;

/**
 * Query perspectives via OmniJS, with optional Node-side predicate filtering.
 *
 * @param filterAst  Lowered predicate AST (or `true` for no filter)
 * @param op         'get' | 'count' | 'exists'
 */
export async function queryPerspectives(
  filterAst: LoweredExpr | true,
): Promise<Row[]> {
  const tempFile = `/tmp/omnifocus_perspectives_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.js`;
  const fs = await import('fs');
  fs.writeFileSync(tempFile, PERSPECTIVES_SCRIPT);

  const result = await executeOmniFocusScript(tempFile);
  fs.unlinkSync(tempFile);

  if (result.error) {
    throw new Error(`Perspectives error: ${result.error}`);
  }

  let items: Row[] = result.items || [];

  // Node-side filtering by predicate if present.
  // On filter compile error, return unfiltered results rather than failing
  // the query — perspective rows have a minimal schema (id, name, type) so
  // most predicates won't apply, but we don't want to crash on unsupported ops.
  if (filterAst !== true) {
    try {
      const predicate = compileNodePredicate(filterAst, 'perspectives' as any);
      items = items.filter(row => !!predicate(row));
    } catch (e) {
      console.error('Perspectives filter failed:', e);
    }
  }

  // For exists: we only need to know if there's at least one match (caller handles this)
  // For count: caller reads items.length
  // For get: return all items
  return items;
}
