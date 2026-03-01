import { z } from 'zod';
import { queryOmnifocus } from '../primitives/queryOmnifocus.js';
import { buildForest, renderForest, type TreeNode } from '../formatters/tree.js';
import { statusBadge, flagIndicator, dueAnnotation } from '../formatters/common.js';

export const schema = z.object({
  includeCompleted: z.boolean().optional().describe(
    "Include completed, dropped, and on-hold projects. Default: false"
  ),
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    const includeCompleted = args.includeCompleted ?? false;

    // Two fast parallel queries via direct JXA
    const [foldersResult, projectsResult] = await Promise.all([
      queryOmnifocus({
        entity: 'folders',
        select: ['id', 'name', 'parentFolderId'],
      }),
      queryOmnifocus({
        entity: 'projects',
        select: ['id', 'name', 'status', 'flagged', 'dueDate', 'activeTaskCount', 'folderId'],
        includeCompleted,
      }),
    ]);

    if (!foldersResult.success) {
      return {
        content: [{ type: "text" as const, text: `Failed to query folders: ${foldersResult.error}` }],
        isError: true
      };
    }
    if (!projectsResult.success) {
      return {
        content: [{ type: "text" as const, text: `Failed to query projects: ${projectsResult.error}` }],
        isError: true
      };
    }

    const folders = foldersResult.items || [];
    const projects = projectsResult.items || [];

    // Build a set of known folder IDs (to distinguish folder containers from the document)
    const folderIdSet = new Set(folders.map((f: any) => f.id));

    // Convert folders to TreeNodes
    const folderNodes: TreeNode[] = folders.map((f: any) => ({
      id: f.id,
      name: f.name,
      kind: 'folder',
      parentId: folderIdSet.has(f.parentFolderId) ? f.parentFolderId : null,
      children: [],
      props: {},
    }));

    // Convert projects to TreeNodes, parented under their folder
    const projectNodes: TreeNode[] = projects.map((p: any) => ({
      id: p.id,
      name: p.name,
      kind: 'project',
      // Only treat folderId as a parent if it's actually a folder (not the document)
      parentId: folderIdSet.has(p.folderId) ? p.folderId : null,
      children: [],
      props: {
        status: p.status,
        flagged: p.flagged,
        dueDate: p.dueDate,
        activeTaskCount: p.activeTaskCount,
      },
    }));

    // Build forest from all nodes combined
    const allNodes = [...folderNodes, ...projectNodes];
    const roots = buildForest(allNodes);

    // Render
    const tree = renderForest(roots, {
      prefixes: { folder: 'F:', project: 'P:' },
      annotate: (node) => {
        if (node.kind !== 'project') return '';
        const parts: string[] = [];
        parts.push(flagIndicator(node.props.flagged as boolean));
        parts.push(statusBadge(node.props.status as string));
        parts.push(dueAnnotation(node.props.dueDate as string));
        const count = node.props.activeTaskCount as number;
        if (count > 0) parts.push(` (${count} tasks)`);
        return parts.join('');
      },
    });

    const header = `## Projects (${projects.length} projects, ${folders.length} folders)\n\n`;

    return {
      content: [{ type: "text" as const, text: header + tree }]
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      content: [{ type: "text" as const, text: `Error: ${error.message}` }],
      isError: true
    };
  }
}
