/**
 * JSON Schema generator for the `where` expression tree.
 *
 * Generates a self-describing JSON Schema from the operations and variable
 * registries, so MCP clients can offer structured completion.
 */

import { operations } from './operations.js';
import { taskVars, projectVars, folderVars, tagVars, perspectiveVars, type VarRegistry } from './variables.js';

type JsonSchema = Record<string, unknown>;

/**
 * Generate a JSON Schema for the `where` expression tree.
 * The schema uses `oneOf` to describe each valid node shape.
 */
export function generateWhereSchema(): JsonSchema {
  // Collect all var names across all entities (union for the schema)
  const allVarNames = [...new Set([
    ...Object.keys(taskVars),
    ...Object.keys(projectVars),
    ...Object.keys(folderVars),
    ...Object.keys(tagVars),
    ...Object.keys(perspectiveVars),
  ])].sort();

  // The expression schema is recursive — use a $defs reference
  const exprRef = { $ref: '#/$defs/expr' };

  const exprSchema: JsonSchema = {
    oneOf: [
      // Primitives
      { type: 'string', description: 'String literal' },
      { type: 'number', description: 'Number literal' },
      { type: 'boolean', description: 'Boolean literal' },
      { type: 'null', description: 'Null literal' },

      // Array literal
      { type: 'array', items: exprRef, description: 'Array literal' },

      // Variable reference
      {
        type: 'object',
        properties: {
          var: { type: 'string', enum: allVarNames }
        },
        required: ['var'],
        additionalProperties: false,
        description: 'Variable reference — {var: "fieldName"}'
      },

      // Date literal
      {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO date string (YYYY-MM-DD)' }
        },
        required: ['date'],
        additionalProperties: false,
        description: 'Date literal — {date: "2026-03-01"}'
      },

      // Offset
      {
        type: 'object',
        properties: {
          offset: {
            type: 'object',
            properties: {
              date: {
                oneOf: [
                  { type: 'string', description: '"now" or "YYYY-MM-DD"' },
                  { type: 'object', properties: { var: { type: 'string' } }, required: ['var'] }
                ]
              },
              days: { type: 'integer', description: 'Number of days (negative = past, positive = future)' }
            },
            required: ['date', 'days'],
            additionalProperties: false
          }
        },
        required: ['offset'],
        additionalProperties: false,
        description: 'Date offset — {offset: {date: "now", days: -3}}'
      },

      // Operations
      ...generateOpSchemas(exprRef),
    ]
  };

  return {
    $defs: { expr: exprSchema },
    ...exprRef
  };
}

function generateOpSchemas(exprRef: JsonSchema): JsonSchema[] {
  return Object.entries(operations).map(([opName, meta]) => {
    const itemsConstraint: JsonSchema = { items: exprRef };

    if (meta.minArgs === meta.maxArgs && meta.maxArgs > 0) {
      // Fixed arg count
      itemsConstraint.minItems = meta.minArgs;
      itemsConstraint.maxItems = meta.maxArgs;
    } else {
      if (meta.minArgs > 0) itemsConstraint.minItems = meta.minArgs;
      if (meta.maxArgs > 0) itemsConstraint.maxItems = meta.maxArgs;
    }

    return {
      type: 'object',
      properties: {
        [opName]: {
          type: 'array',
          ...itemsConstraint,
          description: meta.description
        }
      },
      required: [opName],
      additionalProperties: false,
      description: `${opName} — ${meta.description}`
    };
  });
}

/**
 * Generate the full input schema for query_omnifocus, embedding the
 * generated where schema.
 */
export function generateQueryInputSchema(): JsonSchema {
  const whereSchema = generateWhereSchema();

  return {
    type: 'object',
    properties: {
      entity: {
        type: 'string',
        enum: ['tasks', 'projects', 'folders', 'tags', 'perspectives'],
        description: "Type of entity to query. Choose 'tasks' for individual tasks, 'projects' for projects, 'folders' for folder organization, or 'tags' for tag hierarchy"
      },
      where: {
        ...whereSchema,
        description: `Expression tree for filtering. Uses compact syntax where the operation name is the object key.

NODE TYPES:
- Literals: strings, numbers, booleans, null
- Variable: {var: "fieldName"} — reference a field
- Date: {date: "YYYY-MM-DD"} — date literal
- Offset: {offset: {date: "now", days: -3}} — relative date
- Operation: {opName: [args...]} — apply an operation

OPERATIONS (16):
- Logical: {and: [expr, expr, ...]}, {or: [expr, expr, ...]}, {not: [expr]}
- Comparison: {eq: [a, b]}, {neq: [a, b]}, {gt: [a, b]}, {gte: [a, b]}, {lt: [a, b]}, {lte: [a, b]}
- Value-in-array: {in: [expr, [values]]} e.g. {in: [{var: "status"}, ["Available", "Next"]]}
- Container scoping: {container: ["project"|"folder"|"tag", expr]} — filter by ancestor
- String (case-insensitive): {contains: [expr, "pattern"]}, {startsWith: [expr, "pat"]}, {endsWith: [expr, "pat"]}, {matches: [expr, "regex"]}
- Tags: {contains: [{var: "tags"}, "tagName"]} — tag membership (tasks only)

TASK VARS: id, name, note, flagged, status, dueDate, deferDate, plannedDate, effectiveDueDate, effectiveDeferDate, effectivePlannedDate, completionDate, modificationDate, creationDate, estimatedMinutes, projectId, parentId, inInbox, sequential, hasChildren, childCount, tags, now
PROJECT VARS: id, name, note, status, flagged, dueDate, deferDate, effectiveDueDate, effectiveDeferDate, modificationDate, creationDate, estimatedMinutes, sequential, folderId, taskCount, activeTaskCount, now
FOLDER VARS: id, name, status, parentFolderId, projectCount, now
TAG VARS: id, name, note, allowsNextAction, hidden, effectivelyHidden, availableTaskCount, remainingTaskCount, parentName, now

Status values — Task: Available, Blocked, Completed, Dropped, DueSoon, Next, Overdue — Project: Active, Done, Dropped, OnHold — Folder: Active, Dropped

EXAMPLES:
- Tasks named "review": {contains: [{var: "name"}, "review"]}
- Flagged tasks due within 7 days: {and: [{eq: [{var: "flagged"}, true]}, {lte: [{var: "dueDate"}, {offset: {date: "now", days: 7}}]}]}
- Tasks in project "litigation": {container: ["project", {contains: [{var: "name"}, "litigation"]}]}
- Tasks with tag "work": {contains: [{var: "tags"}, "work"]}
- Overdue or due soon: {in: [{var: "status"}, ["Overdue", "DueSoon"]]}
- Tasks modified in last 3 days: {gt: [{var: "modificationDate"}, {offset: {date: "now", days: -3}}]}
- Child tags under "Work": entity: "tags", where: {container: ["tag", {contains: [{var: "name"}, "Work"]}]}`
      },
      select: {
        type: 'array',
        items: { type: 'string' },
        description: "Specific fields to return (reduces response size). COMMON (all entities): id, name. SHARED: note (tasks/projects/tags), dueDate/deferDate/effectiveDueDate/effectiveDeferDate/modificationDate/creationDate/sequential/completedByChildren (tasks/projects), status (projects/folders). TASK-ONLY: flagged, taskStatus, plannedDate, effectivePlannedDate, completionDate, estimatedMinutes, tagNames, tags, projectName, projectId, parentId, childIds, hasChildren, inInbox. PROJECT-ONLY: folderName, folderID, containsSingletonActions, taskCount, activeTaskCount, tasks. FOLDER-ONLY: path, parentFolderID, projectCount, projects, subfolders. TAG-ONLY: allowsNextAction, hidden, effectivelyHidden, availableTaskCount, remainingTaskCount, parentName"
      },
      limit: {
        type: 'number',
        description: "Maximum number of items to return. Useful for large result sets. Default: no limit"
      },
      sort: {
        type: 'object',
        properties: {
          by: {
            type: 'string',
            description: "Field to sort by. OPTIONS: name, dueDate, deferDate, modificationDate, creationDate, estimatedMinutes, taskStatus"
          },
          direction: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: "Sort order. 'asc' = ascending (A-Z, old-new), 'desc' = descending (Z-A, new-old). Default: 'asc'"
          }
        },
        required: ['by'],
        description: "Sort results by a field. Example: {sort: {by: \"dueDate\", direction: \"asc\"}}"
      },
      includeCompleted: {
        type: 'boolean',
        description: "Include completed and dropped items. Default: false (active items only)"
      },
      summary: {
        type: 'boolean',
        description: "Return only count of matches, not full details. Efficient for statistics. Default: false"
      }
    },
    required: ['entity']
  };
}
