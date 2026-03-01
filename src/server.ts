#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import tool definitions
import * as dumpDatabaseTool from './tools/definitions/dumpDatabase.js';
import * as addOmniFocusTaskTool from './tools/definitions/addOmniFocusTask.js';
import * as addProjectTool from './tools/definitions/addProject.js';
import * as removeItemTool from './tools/definitions/removeItem.js';
import * as editItemTool from './tools/definitions/editItem.js';
import * as batchAddItemsTool from './tools/definitions/batchAddItems.js';
import * as batchRemoveItemsTool from './tools/definitions/batchRemoveItems.js';
import * as queryOmniFocusTool from './tools/definitions/queryOmnifocus.js';
import * as listPerspectivesTool from './tools/definitions/listPerspectives.js';
import * as getPerspectiveViewTool from './tools/definitions/getPerspectiveView.js';
import * as moveItemTool from './tools/definitions/moveItem.js';
import * as listTagsTool from './tools/definitions/listTags.js';
import * as showForecastTool from './tools/definitions/showForecast.js';

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
register("dump_database",
  "Gets the current state of your OmniFocus database",
  dumpDatabaseTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  dumpDatabaseTool.handler);

register("query_omnifocus",
  "Query OmniFocus, filtering tasks, projects, or folders with an expression tree.",
  queryOmniFocusTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  queryOmniFocusTool.handler);

register("list_perspectives",
  "List all available perspectives in OmniFocus, including built-in perspectives (Inbox, Projects, Tags, etc.) and custom perspectives (Pro feature)",
  listPerspectivesTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  listPerspectivesTool.handler);

register("get_perspective_view",
  "Get the items visible in a specific OmniFocus perspective. Shows what tasks and projects are displayed when viewing that perspective",
  getPerspectiveViewTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  getPerspectiveViewTool.handler);

register("list_tags",
  "List all tags in OmniFocus with task counts. Returns tag names, hierarchy (parent/child), status, and number of active tasks per tag. Use this to discover available tags before filtering by them in query_omnifocus.",
  listTagsTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  listTagsTool.handler);

register("show_forecast",
  "Show OmniFocus Forecast view: task counts per day by due, planned, and deferred date across a date range, with today's flagged and tagged counts.",
  showForecastTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  showForecastTool.handler);

// Additive tools (not destructive, not idempotent)
register("add_omnifocus_task",
  "Add a new task to OmniFocus",
  addOmniFocusTaskTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  addOmniFocusTaskTool.handler);

register("add_project",
  "Add a new project to OmniFocus",
  addProjectTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  addProjectTool.handler);

register("batch_add_items",
  "Add multiple tasks or projects to OmniFocus in a single operation",
  batchAddItemsTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  batchAddItemsTool.handler);

// Mutative tools (not destructive, idempotent)
register("edit_item",
  "Edit a task or project in OmniFocus",
  editItemTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  editItemTool.handler);

register("move_item",
  "Move a task to a different project (or inbox), or a project to a different folder",
  moveItemTool.schema,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  moveItemTool.handler);

// Destructive tools (idempotent — removing an already-removed item is a no-op)
register("remove_item",
  "Remove a task or project from OmniFocus",
  removeItemTool.schema,
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  removeItemTool.handler);

register("batch_remove_items",
  "Remove multiple tasks or projects from OmniFocus in a single operation",
  batchRemoveItemsTool.schema,
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  batchRemoveItemsTool.handler);

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
