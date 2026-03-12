import { z } from 'zod';
import { queryOmnifocus, QueryOmnifocusParams } from '../primitives/queryOmnifocus.js';
import { coerceJson, appendCoercionWarnings } from '../utils/coercion.js';
import { describeExpr, describeSort } from '../query/backends/describer.js';
import { formatItems } from '../formatters/queryResults.js';
import { ALL_OPS } from '../query/operations.js';

export const schema = z.object({
  entity: z.enum(['tasks', 'projects', 'folders', 'tags', 'perspectives']).describe(
    "Type of entity to query. Choose 'tasks' for individual tasks, 'projects' for projects, 'folders' for folder organization, or 'tags' for tag hierarchy"
  ),

  where: coerceJson('where', z.any().optional().describe(
    `Expression tree for filtering using compact syntax. ${ALL_OPS.length} operations: ${ALL_OPS.join(', ')}. Use {opName: [args]} syntax (e.g. {contains: [{var: "name"}, "review"]}). Dates: {date: "YYYY-MM-DD"}, {offset: {date: "now", days: -3}}, {var: "now"}. Date ranges: {between: [{var: "dueDate"}, {var: "now"}, {offset: {date: "now", days: 7}}]}. Tags: {contains: [{var: "tags"}, "tagName"]}. Container scoping: {container: ["project"|"folder"|"tag", expr]} — "project" for tasks, "folder" for tasks/projects/folders, "tag" for tags (ancestor walk). Project name: {contains: [{var: "projectName"}, "text"]}. Semantic search: {similar: ["query"]} or {similar: ["query", 60]} with optional 0-100 threshold. Similar queries default to limit 20 and auto-inject a similarity field.`
  )),

  select: coerceJson('select', z.array(z.string()).optional().describe(
    "Specific fields to return (reduces response size). COMMON (all entities): id, name. SHARED: note (tasks/projects/tags), dueDate/deferDate/effectiveDueDate/effectiveDeferDate/modificationDate/creationDate/sequential/completedByChildren (tasks/projects), status (projects/folders). TASK-ONLY: flagged, taskStatus, plannedDate, effectivePlannedDate, completionDate, estimatedMinutes, tagNames, tags, projectName, projectId, parentId, childIds, hasChildren, inInbox. PROJECT-ONLY: folderName, folderID, containsSingletonActions, taskCount, activeTaskCount, tasks. FOLDER-ONLY: path, parentFolderID, projectCount, projects, subfolders. TAG-ONLY: allowsNextAction, hidden, effectivelyHidden, availableTaskCount, remainingTaskCount, parentName"
  )),

  limit: z.number().optional().describe(
    "Maximum number of items to return. Useful for large result sets. Default: no limit"
  ),

  sort: coerceJson('sort', z.object({
    by: z.string().describe(
      "Field to sort by. OPTIONS: name, dueDate, deferDate, modificationDate, creationDate, estimatedMinutes, taskStatus, similarity (for similar queries)"
    ),
    direction: z.enum(['asc', 'desc']).optional().describe(
      "Sort order. 'asc' = ascending (A-Z, old-new), 'desc' = descending (Z-A, new-old). Default: 'asc'"
    )
  }).optional().describe(
    "Sort results. Example: {by: \"dueDate\", direction: \"asc\"}"
  )),

  includeCompleted: z.boolean().optional().describe(
    "Include completed and dropped items. Default: false (active items only)"
  ),

  op: z.enum(['get', 'count', 'exists']).optional().describe(
    "Query operation. 'get' (default) returns matching items. 'count' returns the number of matches — avoids reading output-only columns, so faster when note/expensive fields are in select. 'exists' returns true/false and stops after the first match (fastest for presence checks)."
  ),

  summary: z.boolean().optional().describe(
    "Deprecated — use op:'count' instead. Returns only the count of matches."
  )
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    // Build query description for result output
    const queryDesc = buildQueryDescription(args);

    const result = await queryOmnifocus(args as QueryOmnifocusParams);

    if (result.success) {
      // Resolve effective op (mirrors the primitive's logic)
      const effectiveOp = args.op ?? (args.summary ? 'count' : 'get');

      if (effectiveOp === 'count') {
        const count = result.count ?? 0;
        const noun = count === 1 ? singularEntity(args.entity) : args.entity;
        return {
          content: [{
            type: "text" as const,
            text: appendCoercionWarnings(
              count === 0
                ? `No ${args.entity} found${queryDesc}`
                : `Found ${count} ${noun}${queryDesc}`
            )
          }]
        };
      }

      if (effectiveOp === 'exists') {
        return {
          content: [{
            type: "text" as const,
            text: appendCoercionWarnings(
              result.exists
                ? `Yes — at least one ${singularEntity(args.entity)} found${queryDesc}`
                : `No ${args.entity} found${queryDesc}`
            )
          }]
        };
      }

      // 'get': return items
      const items = result.items || [];
      let output: string;

      if (items.length === 0) {
        output = `No ${args.entity} found${queryDesc}`;
      } else {
        const noun = items.length === 1 ? singularEntity(args.entity) : args.entity;
        output = `## Query Results: ${items.length} ${noun}${queryDesc}\n\n`;
        output += formatItems(items, args.entity);
      }

      if (items.length > 0 && items.length === args.limit) {
        output += `\n\n--- Results limited to ${args.limit} items. More may be available.`;
      }

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
          text: appendCoercionWarnings(`Query failed: ${result.error}`)
        }],
        isError: true
      };
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Query execution error: ${error.message}`);
    return {
      content: [{
        type: "text" as const,
        text: appendCoercionWarnings(`Error executing query: ${error.message}`)
      }],
      isError: true
    };
  }
}

function singularEntity(entity: string): string {
  if (entity === 'tasks') return 'task';
  if (entity === 'projects') return 'project';
  if (entity === 'folders') return 'folder';
  if (entity === 'tags') return 'tag';
  if (entity === 'perspectives') return 'perspective';
  return entity;
}

function buildQueryDescription(args: z.infer<typeof schema>): string {
  const parts: string[] = [];

  if (args.where != null) {
    parts.push(` where: ${describeExpr(args.where)}`);
  }

  if (args.sort) {
    parts.push(`, ${describeSort(args.sort)}`);
  }

  return parts.join('');
}

