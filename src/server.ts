#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import tool definitions
import * as queryTool from './tools/definitions/queryOmnifocus.js';
import * as viewTool from './tools/definitions/view.js';
import * as listProjectsTool from './tools/definitions/listProjects.js';
import * as listTagsTool from './tools/definitions/listTags.js';
import * as listPerspectivesTool from './tools/definitions/listPerspectives.js';
import * as showForecastTool from './tools/definitions/showForecast.js';
import * as addTaskTool from './tools/definitions/addTask.js';
import * as addProjectTool from './tools/definitions/addProject.js';
import * as editTool from './tools/definitions/edit.js';
import * as moveTool from './tools/definitions/move.js';
import * as removeTool from './tools/definitions/removeItem.js';
import * as semanticSearchTool from './tools/definitions/semanticSearch.js';

// Create an MCP server
const server = new McpServer({
  name: "OmniFocus MCP",
  version: "1.0.0"
});

// Helper to register tools with annotations, avoiding TS2589 deep type instantiation
// from the SDK's complex Zod v3/v4 compatibility generics.
function register(name: string, description: string, schema: any, annotations: any, handler: any) {
  server.registerTool(name, { description, inputSchema: schema.shape, annotations }, handler);
}

// Read-only tools
register("query",
  "Query OmniFocus, filtering tasks, projects, or folders with an expression tree.",
  queryTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  queryTool.handler);

register("view",
  "View tasks in a project, folder, tag, or perspective. Syntactic sugar over the query tool. Use project/folder/tag for container views, perspective for saved views (Flagged, Inbox), or inbox: true.",
  viewTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  viewTool.handler);

register("list_projects",
  "List all projects grouped by folder. Returns a folder→project tree with status, flags, due dates, and task counts.",
  listProjectsTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  listProjectsTool.handler);

register("list_tags",
  "List all tags in OmniFocus with task counts. Returns tag names, hierarchy (parent/child), status, and number of active tasks per tag. Use this to discover available tags before filtering by them in the query tool.",
  listTagsTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  listTagsTool.handler);

register("list_perspectives",
  "List all available perspectives in OmniFocus, including built-in perspectives (Inbox, Projects, Tags, etc.) and custom perspectives (Pro feature)",
  listPerspectivesTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  listPerspectivesTool.handler);

register("show_forecast",
  "Show OmniFocus Forecast view: task counts per day by due, planned, and deferred date across a date range, with today's flagged and tagged counts.",
  showForecastTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  showForecastTool.handler);

register("semantic_search",
  "Search OmniFocus tasks and projects by meaning using natural language. Uses a pre-built semantic index (run the indexer first). Best for fuzzy/conceptual searches where exact keyword matching would miss relevant items.",
  semanticSearchTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  semanticSearchTool.handler);

// Additive tools (not destructive, not idempotent)
register("add_task",
  "Add one or more tasks to OmniFocus",
  addTaskTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  addTaskTool.handler);

register("add_project",
  "Add one or more projects to OmniFocus",
  addProjectTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  addProjectTool.handler);

// Mutative tools (not destructive, idempotent)
register("edit",
  "Edit tasks or projects in OmniFocus. Target by id, ids, or query expression. Supports set (properties), addTags, removeTags, mark (status), and offset (shift dates). Query targeting defaults to dryRun: true.",
  editTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  editTool.handler);

register("move",
  "Move tasks to a project/inbox, or projects to a folder. Target by id, ids, or query expression. Name-based destinations error on ambiguity. Query targeting defaults to dryRun: true.",
  moveTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  moveTool.handler);

// Destructive tools (idempotent — removing an already-removed item is a no-op)
register("remove",
  "Remove a task or project from OmniFocus",
  removeTool.schema,
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  removeTool.handler);

// Start the MCP server
const transport = new StdioServerTransport();

// Use await with server.connect to ensure proper connection
(async function() {
  try {
    console.error("Starting MCP server...");
    await server.connect(transport);
    console.error("MCP Server connected and ready to accept commands from Claude");
  } catch (err) {
    console.error(`Failed to start MCP server: ${err}`);
  }
})();

// For a cleaner shutdown if the process is terminated
