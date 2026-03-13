/**
 * Generic tree builder and renderer.
 *
 * Takes flat arrays of items with id/parentId relationships and renders
 * an indented tree. Used by the unified view tool for folder→project and
 * tag hierarchy rendering.
 */

import { indentLine, statusBadge, flagIndicator, dueAnnotation } from './common.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface TreeNode {
  id: string;
  name: string;
  /** Type tag for rendering (e.g. 'folder', 'project') */
  kind: string;
  /** Parent node ID, or null for root */
  parentId: string | null;
  /** Children populated during tree construction */
  children: TreeNode[];
  /** Arbitrary properties for rendering */
  props: Record<string, unknown>;
}

export interface TreeRenderConfig {
  /** Prefix per kind, e.g. { folder: 'F:', project: 'P:' } */
  prefixes: Record<string, string>;
  /** Annotations to render per kind */
  annotate?: (node: TreeNode) => string;
  /** Indent string per level */
  indent?: string;
}

// ── Tree Construction ───────────────────────────────────────────────────

/**
 * Build a forest (array of root TreeNodes) from flat items.
 * Items not matching any parent are placed at root level.
 */
export function buildForest(items: TreeNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const item of items) {
    byId.set(item.id, item);
  }

  const roots: TreeNode[] = [];

  for (const item of items) {
    if (item.parentId && byId.has(item.parentId)) {
      byId.get(item.parentId)!.children.push(item);
    } else {
      roots.push(item);
    }
  }

  return roots;
}

/**
 * Render a forest to a compact indented string.
 */
export function renderForest(roots: TreeNode[], config: TreeRenderConfig): string {
  const indent = config.indent ?? '   ';
  let output = '';

  function renderNode(node: TreeNode, depth: number): void {
    const prefix = config.prefixes[node.kind] ?? '';
    const annotation = config.annotate ? config.annotate(node) : '';
    output += indentLine(depth, prefix ? `${prefix} ` : '', `${node.name}${annotation}`, indent);

    for (const child of node.children) {
      renderNode(child, depth + 1);
    }
  }

  for (const root of roots) {
    renderNode(root, 0);
  }

  return output;
}
