import { z } from 'zod';
import { queryOmnifocus, QueryOmnifocusParams } from '../primitives/queryOmnifocus.js';
import { coerceJson, appendCoercionWarnings } from '../utils/coercion.js';
import { describeExpr, describeSort } from '../query/backends/describer.js';

export const schema = z.object({
  entity: z.enum(['tasks', 'projects', 'folders']).describe(
    "Type of entity to query. Choose 'tasks' for individual tasks, 'projects' for projects, or 'folders' for folder organization"
  ),

  where: coerceJson('where', z.any().optional().describe(
    `Expression tree for filtering using compact syntax. 17 operations: and, or, not, eq, neq, gt, gte, lt, lte, between, in, container, contains, startsWith, endsWith, matches. Use {opName: [args]} syntax (e.g. {contains: [{var: "name"}, "review"]}). Dates: {date: "YYYY-MM-DD"}, {offset: {date: "now", days: -3}}, {var: "now"}. Date ranges: {between: [{var: "dueDate"}, {var: "now"}, {offset: {date: "now", days: 7}}]}. Tags: {contains: [{var: "tags"}, "tagName"]}. Container scoping: {container: ["project", expr]}. Project name: {contains: [{var: "projectName"}, "text"]}.`
  )),

  select: coerceJson('select', z.array(z.string()).optional().describe(
    "Specific fields to return (reduces response size). TASK FIELDS: id, name, note, flagged, taskStatus, dueDate, deferDate, plannedDate, effectiveDueDate, effectiveDeferDate, effectivePlannedDate, completionDate, estimatedMinutes, tagNames, tags, projectName, projectId, parentId, childIds, hasChildren, sequential, completedByChildren, inInbox, modificationDate, creationDate. PROJECT FIELDS: id, name, status, note, folderName, folderID, sequential, dueDate, deferDate, effectiveDueDate, effectiveDeferDate, completedByChildren, containsSingletonActions, taskCount, activeTaskCount, tasks, modificationDate, creationDate. FOLDER FIELDS: id, name, path, parentFolderID, status, projectCount, projects, subfolders"
  )),

  limit: z.number().optional().describe(
    "Maximum number of items to return. Useful for large result sets. Default: no limit"
  ),

  sort: coerceJson('sort', z.object({
    by: z.string().describe(
      "Field to sort by. OPTIONS: name, dueDate, deferDate, modificationDate, creationDate, estimatedMinutes, taskStatus"
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

  summary: z.boolean().optional().describe(
    "Return only count of matches, not full details. Efficient for statistics. Default: false"
  )
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    // Build query description for result output
    const queryDesc = buildQueryDescription(args);

    const result = await queryOmnifocus(args as QueryOmnifocusParams);

    if (result.success) {
      if (args.summary) {
        const noun = result.count === 1 ? singularEntity(args.entity) : args.entity;
        return {
          content: [{
            type: "text" as const,
            text: appendCoercionWarnings(
              result.count === 0
                ? `No ${args.entity} found${queryDesc}`
                : `Found ${result.count} ${noun}${queryDesc}`
            )
          }]
        };
      } else {
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
      }
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

function formatItems(items: any[], entity: string): string {
  switch (entity) {
    case 'tasks':    return formatTasks(items);
    case 'projects': return formatProjects(items);
    case 'folders':  return formatFolders(items);
    default:         return '';
  }
}

function formatTasks(tasks: any[]): string {
  return tasks.map(task => {
    const parts = [];

    const flag = task.flagged ? '🚩 ' : '';
    parts.push(`• ${flag}${task.name || 'Unnamed'}`);

    if (task.id) {
      parts.push(`[${task.id}]`);
    }

    if (task.projectName) {
      parts.push(`(${task.projectName})`);
    }

    if (task.dueDate) {
      parts.push(`[due: ${formatDate(task.dueDate)}]`);
    }
    if (task.deferDate) {
      parts.push(`[defer: ${formatDate(task.deferDate)}]`);
    }
    if (task.plannedDate) {
      parts.push(`[planned: ${formatDate(task.plannedDate)}]`);
    }

    if (task.estimatedMinutes) {
      const hours = task.estimatedMinutes >= 60
        ? `${Math.floor(task.estimatedMinutes / 60)}h`
        : `${task.estimatedMinutes}m`;
      parts.push(`(${hours})`);
    }

    if (task.tagNames?.length > 0) {
      parts.push(`<${task.tagNames.join(',')}>`);
    }

    if (task.taskStatus) {
      parts.push(`#${task.taskStatus.toLowerCase()}`);
    }

    if (task.creationDate) {
      parts.push(`[created: ${formatDate(task.creationDate)}]`);
    }
    if (task.modificationDate) {
      parts.push(`[modified: ${formatDate(task.modificationDate)}]`);
    }
    if (task.completionDate) {
      parts.push(`[completed: ${formatDate(task.completionDate)}]`);
    }

    let result = parts.join(' ');

    if (task.note) {
      result += `\n  Note: ${task.note}`;
    }

    return result;
  }).join('\n');
}

function formatProjects(projects: any[]): string {
  return projects.map(project => {
    const status = project.status !== 'Active' ? ` [${project.status}]` : '';
    const folder = project.folderName ? ` 📁 ${project.folderName}` : '';
    let taskCountStr = '';
    if (project.activeTaskCount !== undefined && project.taskCount !== undefined) {
      taskCountStr = ` (${project.activeTaskCount}/${project.taskCount} tasks)`;
    } else if (project.taskCount !== undefined && project.taskCount !== null) {
      taskCountStr = ` (${project.taskCount} tasks)`;
    }
    const flagged = project.flagged ? '🚩 ' : '';
    const due = project.dueDate ? ` [due: ${formatDate(project.dueDate)}]` : '';

    let result = `P: ${flagged}${project.name}${status}${due}${folder}${taskCountStr}`;

    if (project.creationDate) {
      result += ` [created: ${formatDate(project.creationDate)}]`;
    }
    if (project.modificationDate) {
      result += ` [modified: ${formatDate(project.modificationDate)}]`;
    }

    if (project.note) {
      result += `\n  Note: ${project.note}`;
    }

    return result;
  }).join('\n');
}

function formatFolders(folders: any[]): string {
  return folders.map(folder => {
    const projectCount = folder.projectCount !== undefined ? ` (${folder.projectCount} projects)` : '';
    const path = folder.path ? ` 📍 ${folder.path}` : '';

    return `F: ${folder.name}${projectCount}${path}`;
  }).join('\n');
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
