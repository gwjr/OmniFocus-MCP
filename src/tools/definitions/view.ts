import { z } from 'zod';
import { queryOmnifocus, type QueryOmnifocusParams } from '../primitives/queryOmnifocus.js';
import { resolvePerspectiveQuery } from '../primitives/perspectiveQuery.js';
import { resolveViewUrl } from '../primitives/viewUrl.js';
import { buildForest, renderForest, type TreeNode } from '../formatters/tree.js';
import { statusBadge, flagIndicator, dueAnnotation } from '../formatters/common.js';
import { listTags } from '../primitives/listTags.js';
import { showForecast, type ForecastResult } from '../primitives/showForecast.js';
import { coerceJson, appendCoercionWarnings } from '../utils/coercion.js';
import { formatItems } from '../formatters/queryResults.js';

export const schema = z.object({
  project: z.string().optional().describe(
    "View tasks in a project. Value is the project name (exact or partial match). Example: 'Litigation'"
  ),
  folder: z.string().optional().describe(
    "View projects in a folder. Value is the folder name. Example: 'Work'"
  ),
  tag: z.string().optional().describe(
    "View tasks with a tag. Value is the tag name. Example: 'Urgent'"
  ),
  url: z.string().optional().describe(
    "View an OmniFocus item by URL. Supports task URLs and project URLs."
  ),
  perspective: z.string().optional().describe(
    "View a built-in or custom perspective. Built-ins like 'Flagged' and 'Inbox' use fixed predicates; custom perspectives are translated from Omni Automation filter archives."
  ),
  inbox: z.boolean().optional().describe(
    "View inbox tasks. Shorthand for perspective: 'Inbox'."
  ),
  select: coerceJson('select', z.array(z.string()).optional().describe(
    "Fields to return. Same as query tool's select parameter."
  )),
  includeCompleted: z.boolean().optional().describe(
    "Include completed and dropped items. Default: false"
  ),
  limit: z.number().optional().describe(
    "Maximum items to return. Default: no limit"
  ),
  sort: coerceJson('sort', z.object({
    by: z.string(),
    direction: z.enum(['asc', 'desc']).optional()
  }).optional().describe(
    "Sort results. Example: {by: 'dueDate', direction: 'asc'}"
  ))
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    // Validate: exactly one view target
    const targets = [args.project, args.folder, args.tag, args.url, args.perspective, args.inbox].filter(v => v != null);
    if (targets.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: appendCoercionWarnings("Specify one of: project, folder, tag, url, perspective, or inbox.")
        }],
        isError: true
      };
    }
    if (targets.length > 1) {
      return {
        content: [{
          type: "text" as const,
          text: appendCoercionWarnings("Specify only one view target (project, folder, tag, url, perspective, or inbox).")
        }],
        isError: true
      };
    }

    let queryParams: QueryOmnifocusParams;
    let labelOverride: string | null = null;

    if (args.project) {
      queryParams = {
        entity: 'tasks',
        where: { container: ['project', { contains: [{ var: 'name' }, args.project] }] },
      };
    } else if (args.folder) {
      queryParams = {
        entity: 'projects',
        where: { contains: [{ var: 'folderName' }, args.folder] },
      };
    } else if (args.tag) {
      queryParams = {
        entity: 'tasks',
        where: { contains: [{ var: 'tags' }, args.tag] },
      };
    } else if (args.url) {
      const resolved = await resolveViewUrl(args.url);
      queryParams = resolved.queryParams;
      labelOverride = resolved.label;
    } else if (args.inbox) {
      queryParams = {
        entity: 'tasks',
        where: { eq: [{ var: 'inInbox' }, true] },
      };
    } else if (args.perspective) {
      const delegated = await handleReservedPerspective(args, extra);
      if (delegated) return delegated;
      queryParams = await resolvePerspectiveQuery(args.perspective);
    } else {
      return {
        content: [{
          type: "text" as const,
          text: appendCoercionWarnings("No view target specified.")
        }],
        isError: true
      };
    }

    // Apply common params
    if (args.select) queryParams.select = args.select;
    if (args.includeCompleted != null) queryParams.includeCompleted = args.includeCompleted;
    if (args.limit != null) queryParams.limit = args.limit;
    if (args.sort) queryParams.sort = args.sort;

    const result = await queryOmnifocus(queryParams);

    if (result.success) {
      const items = result.items || [];
      const label = labelOverride ?? getViewLabel(args);

      if (items.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: appendCoercionWarnings(`No items found in ${label}.`)
          }]
        };
      }

      let output = `## ${label} (${items.length} items)\n\n`;
      output += formatItems(items, queryParams.entity);

      return {
        content: [{
          type: "text" as const,
          text: appendCoercionWarnings(output)
        }]
      };
    } else {
      return {
        content: [{
          type: "text" as const,
          text: appendCoercionWarnings(`View failed: ${result.error}`)
        }],
        isError: true
      };
    }
  } catch (err: unknown) {
    const error = err as Error;
    return {
      content: [{
        type: "text" as const,
        text: appendCoercionWarnings(`Error: ${error.message}`)
      }],
      isError: true
    };
  }
}

async function handleReservedPerspective(args: z.infer<typeof schema>, extra: any) {
  if (!args.perspective) return null;

  switch (args.perspective.toLowerCase()) {
    case 'perspectives':
      return handlePerspectivesView();
    case 'projects':
      return handleProjectsView(args.includeCompleted ?? false);
    case 'tags':
      return handleTagsView();
    case 'forecast':
      return handleForecastView();
    default:
      return null;
  }
}

function getViewLabel(args: z.infer<typeof schema>): string {
  if (args.project) return `project "${args.project}"`;
  if (args.folder) return `folder "${args.folder}"`;
  if (args.tag) return `tag "${args.tag}"`;
  if (args.url) return `url "${args.url}"`;
  if (args.perspective) return `${args.perspective} perspective`;
  if (args.inbox) return 'Inbox';
  return 'view';
}

async function handlePerspectivesView() {
  const result = await queryOmnifocus({ entity: 'perspectives' });

  if (!result.success) {
    return {
      content: [{ type: "text" as const, text: `Failed to list perspectives: ${result.error}` }],
      isError: true
    };
  }

  const perspectives = result.items || [];
  if (perspectives.length === 0) {
    return { content: [{ type: "text" as const, text: "No perspectives found." }] };
  }

  let output = `## Available Perspectives (${perspectives.length})\n\n`;
  const builtIn = perspectives.filter((p: any) => p.type === 'builtin');
  const custom = perspectives.filter((p: any) => p.type === 'custom');

  if (builtIn.length > 0) {
    output += `### Built-in Perspectives\n`;
    builtIn.forEach((p: any) => { output += `• ${p.name}\n`; });
  }
  if (custom.length > 0) {
    if (builtIn.length > 0) output += '\n';
    output += `### Custom Perspectives\n`;
    custom.forEach((p: any) => { output += `• ${p.name}\n`; });
  }

  return { content: [{ type: "text" as const, text: output }] };
}

async function handleProjectsView(includeCompleted: boolean) {
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
  const folderIdSet = new Set(folders.map((f: any) => f.id));

  const folderNodes: TreeNode[] = folders.map((f: any) => ({
    id: f.id,
    name: f.name,
    kind: 'folder',
    parentId: folderIdSet.has(f.parentFolderId) ? f.parentFolderId : null,
    children: [],
    props: {},
  }));
  const projectNodes: TreeNode[] = projects.map((p: any) => ({
    id: p.id,
    name: p.name,
    kind: 'project',
    parentId: folderIdSet.has(p.folderId) ? p.folderId : null,
    children: [],
    props: {
      status: p.status,
      flagged: p.flagged,
      dueDate: p.dueDate,
      activeTaskCount: p.activeTaskCount,
    },
  }));

  const roots = buildForest([...folderNodes, ...projectNodes]);
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

  return {
    content: [{ type: "text" as const, text: `## Projects (${projects.length} projects, ${folders.length} folders)\n\n${tree}` }]
  };
}

async function handleTagsView() {
  const result = await listTags({
    includeActive: true,
    includeOnHold: false,
    includeDropped: false,
  });

  if (!result.success) {
    return {
      content: [{ type: "text" as const, text: `Failed to list tags: ${result.error}` }],
      isError: true
    };
  }

  const tags = result.tags || [];
  if (tags.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No tags found matching the specified criteria." }]
    };
  }

  const topLevel = tags.filter(t => !t.parent);
  const nested = tags.filter(t => t.parent);
  let output = `## Tags (${tags.length})\n\n`;

  for (const tag of topLevel) {
    const count = tag.taskCount > 0 ? ` (${tag.taskCount} tasks)` : '';
    const status = tag.status !== 'Active' ? ` [${tag.status}]` : '';
    output += `• ${tag.name}${count}${status}\n`;

    const children = nested.filter(t => t.parent === tag.name);
    for (const child of children) {
      const cCount = child.taskCount > 0 ? ` (${child.taskCount} tasks)` : '';
      const cStatus = child.status !== 'Active' ? ` [${child.status}]` : '';
      output += `  • ${child.name}${cCount}${cStatus}\n`;
    }
  }

  const shownParents = new Set(topLevel.map(t => t.name));
  const orphanedNested = nested.filter(t => t.parent && !shownParents.has(t.parent));
  if (orphanedNested.length > 0) {
    output += `\n### Nested (parent not shown)\n`;
    for (const tag of orphanedNested) {
      const count = tag.taskCount > 0 ? ` (${tag.taskCount} tasks)` : '';
      output += `  • ${tag.parent} > ${tag.name}${count}\n`;
    }
  }

  return { content: [{ type: "text" as const, text: output }] };
}

async function handleForecastView() {
  const result = await showForecast({});

  if (!result.success) {
    return {
      content: [{ type: "text" as const, text: `Forecast failed: ${result.error}` }],
      isError: true
    };
  }

  return { content: [{ type: "text" as const, text: formatForecast(result) }] };
}

function formatForecast(result: ForecastResult): string {
  const { buckets, flaggedCount, todayTagCount } = result;
  const todayBucket = buckets.find(b => b.label.startsWith('Today'));
  const dateLabel = todayBucket ? todayBucket.label.replace('Today (', '').replace(')', '') : '';
  let out = `OmniFocus Forecast — ${dateLabel}\n\n`;
  const labelW = Math.max(20, ...buckets.map(b => b.label.length + 2));
  const numW = 6;

  out += pad('', labelW) + pad('Due', numW) + pad('Plan', numW) + pad('Defer', numW) + 'Tasks\n';
  out += '─'.repeat(labelW + numW * 3 + 6) + '\n';

  for (const b of buckets) {
    const tasks = b.taskIds.size;
    let row = pad(b.label, labelW);
    row += pad(fmt(b.due), numW);
    row += pad(fmt(b.planned), numW);
    row += pad(fmt(b.deferred), numW);
    row += fmt(tasks);

    if (b.label.startsWith('Today')) {
      const extras: string[] = [];
      if (flaggedCount > 0) extras.push(`${flaggedCount} flagged`);
      if (todayTagCount != null && todayTagCount > 0) extras.push(`${todayTagCount} tagged "today"`);
      if (extras.length > 0) row += `  (+ ${extras.join(', ')})`;
    }

    out += row + '\n';
  }

  return out;
}

function fmt(n: number): string {
  return n > 0 ? String(n) : '-';
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}
