import { z } from 'zod';
import { queryOmnifocus, type QueryOmnifocusParams } from '../primitives/queryOmnifocus.js';
import { resolvePerspectiveQuery } from '../primitives/perspectiveQuery.js';
import { resolveViewUrl } from '../primitives/viewUrl.js';
import { handler as listPerspectivesHandler } from './listPerspectives.js';
import { handler as listProjectsHandler } from './listProjects.js';
import { handler as listTagsHandler } from './listTags.js';
import { handler as showForecastHandler } from './showForecast.js';
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
      return listPerspectivesHandler({}, extra);
    case 'projects':
      return listProjectsHandler(
        { ...(args.includeCompleted != null ? { includeCompleted: args.includeCompleted } : {}) } as any,
        extra,
      );
    case 'tags':
      return listTagsHandler({} as any, extra);
    case 'forecast':
      return showForecastHandler({} as any, extra);
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
