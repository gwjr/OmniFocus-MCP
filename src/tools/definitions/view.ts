import { z } from 'zod';
import { queryOmnifocus, type QueryOmnifocusParams } from '../primitives/queryOmnifocus.js';
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
  perspective: z.string().optional().describe(
    "View a built-in perspective. Supported: 'Flagged', 'Inbox'. Custom perspectives run an opaque OmniJS query."
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

// Built-in perspectives we can translate to predicates
const PERSPECTIVE_PREDICATES: Record<string, { entity: string; where: unknown }> = {
  flagged: {
    entity: 'tasks',
    where: { eq: [{ var: 'flagged' }, true] }
  },
  inbox: {
    entity: 'tasks',
    where: { eq: [{ var: 'inInbox' }, true] }
  },
};

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    // Validate: exactly one view target
    const targets = [args.project, args.folder, args.tag, args.perspective, args.inbox].filter(v => v != null);
    if (targets.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: appendCoercionWarnings("Specify one of: project, folder, tag, perspective, or inbox.")
        }],
        isError: true
      };
    }
    if (targets.length > 1) {
      return {
        content: [{
          type: "text" as const,
          text: appendCoercionWarnings("Specify only one view target (project, folder, tag, perspective, or inbox).")
        }],
        isError: true
      };
    }

    let queryParams: QueryOmnifocusParams;

    if (args.project) {
      queryParams = {
        entity: 'tasks',
        where: { container: ['project', { contains: [{ var: 'name' }, args.project] }] },
      };
    } else if (args.folder) {
      queryParams = {
        entity: 'projects',
        where: { container: ['folder', { contains: [{ var: 'name' }, args.folder] }] },
      };
    } else if (args.tag) {
      queryParams = {
        entity: 'tasks',
        where: { container: ['tag', { contains: [{ var: 'name' }, args.tag] }] },
      };
    } else if (args.inbox) {
      queryParams = {
        entity: 'tasks',
        where: { eq: [{ var: 'inInbox' }, true] },
      };
    } else if (args.perspective) {
      const key = args.perspective.toLowerCase();
      const known = PERSPECTIVE_PREDICATES[key];
      if (known) {
        queryParams = {
          entity: known.entity as any,
          where: known.where,
        };
      } else {
        // Unknown/custom perspective — use OmniJS getPerspectiveView fallback
        return executeCustomPerspective(args);
      }
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
      const label = getViewLabel(args);

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

function getViewLabel(args: z.infer<typeof schema>): string {
  if (args.project) return `project "${args.project}"`;
  if (args.folder) return `folder "${args.folder}"`;
  if (args.tag) return `tag "${args.tag}"`;
  if (args.perspective) return `${args.perspective} perspective`;
  if (args.inbox) return 'Inbox';
  return 'view';
}

async function executeCustomPerspective(args: z.infer<typeof schema>) {
  // For custom/unknown perspectives, delegate to the existing OmniJS script
  const { executeOmniFocusScript } = await import('../../utils/scriptExecution.js');
  const result = await executeOmniFocusScript('@getPerspectiveView.js');

  if (result.error) {
    return {
      content: [{
        type: "text" as const,
        text: appendCoercionWarnings(`Failed to get perspective: ${result.error}`)
      }],
      isError: true
    };
  }

  let items = result.items || [];

  if (args.limit) {
    items = items.slice(0, args.limit);
  }

  const label = `${args.perspective} perspective`;
  if (items.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: appendCoercionWarnings(`No items found in ${label}.`)
      }]
    };
  }

  let output = `## ${label} (${items.length} items)\n\n`;
  output += formatItems(items, 'tasks');

  return {
    content: [{
      type: "text" as const,
      text: appendCoercionWarnings(output)
    }]
  };
}
