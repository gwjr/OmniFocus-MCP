#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import tool definitions
import * as queryTool from './tools/definitions/queryOmnifocus.js';
import * as viewTool from './tools/definitions/view.js';
import * as addTaskTool from './tools/definitions/addTask.js';
import * as addProjectTool from './tools/definitions/addProject.js';
import * as editTool from './tools/definitions/edit.js';
import * as moveTool from './tools/definitions/move.js';
import * as removeTool from './tools/definitions/removeItem.js';

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
  "Unified read/navigation tool for OmniFocus. View containers, perspectives, perspective discovery, or OmniFocus URLs for tasks, projects, folders, tags, and perspectives.",
  viewTool.schema,
  { readOnlyHint: true, openWorldHint: false },
  viewTool.handler);

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
