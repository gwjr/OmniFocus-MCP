/**
 * Tool handler smoke tests.
 *
 * Two categories:
 *
 * 1. **Read-only tools** (query, view, list_projects, list_tags,
 *    list_perspectives, show_forecast): call with real arguments against
 *    the running EventPlan pipeline. Asserts every handler returns a
 *    well-formed MCP response and does not throw. Catches missing property
 *    specs (tags.hidden, effectivePlannedDate) and broken codegen.
 *
 * 2. **Mutation tools** (add_task, add_project, edit, move, remove):
 *    test ONLY validation paths that return before hitting any primitive.
 *    Never calls OmniFocus — safe to run in any environment.
 *
 * All tests assert the MCP response shape: { content: [{ type: "text", text }] }.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Import all tool handlers and schemas ─────────────────────────────────
import * as queryTool from '../dist/tools/definitions/queryOmnifocus.js';
import * as viewTool from '../dist/tools/definitions/view.js';
import * as listProjectsTool from '../dist/tools/definitions/listProjects.js';
import * as listTagsTool from '../dist/tools/definitions/listTags.js';
import * as listPerspectivesTool from '../dist/tools/definitions/listPerspectives.js';
import * as showForecastTool from '../dist/tools/definitions/showForecast.js';
import * as addTaskTool from '../dist/tools/definitions/addTask.js';
import * as addProjectTool from '../dist/tools/definitions/addProject.js';
import * as editTool from '../dist/tools/definitions/edit.js';
import * as moveTool from '../dist/tools/definitions/move.js';
import * as removeTool from '../dist/tools/definitions/removeItem.js';

// ── Response shape assertion ─────────────────────────────────────────────

interface McpResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function assertMcpResponse(result: unknown, label: string): McpResponse {
  assert.ok(result != null, `${label}: result is null`);
  const r = result as any;
  assert.ok(Array.isArray(r.content), `${label}: content is not an array`);
  assert.ok(r.content.length > 0, `${label}: content is empty`);
  for (const item of r.content) {
    assert.equal(item.type, 'text', `${label}: content item type is not 'text'`);
    assert.equal(typeof item.text, 'string', `${label}: content item text is not a string`);
    assert.ok(item.text.length > 0, `${label}: content item text is empty`);
  }
  return r;
}

function assertSuccess(result: McpResponse, label: string): void {
  assert.ok(!result.isError, `${label}: unexpected error — ${result.content[0]?.text}`);
}

function assertError(result: McpResponse, label: string, pattern?: RegExp): void {
  assert.ok(result.isError, `${label}: expected isError=true`);
  if (pattern) {
    assert.match(result.content[0].text, pattern, `${label}: error text mismatch`);
  }
}

// ── Read-only tool smoke tests (hit EventPlan pipeline, read OmniFocus) ──

describe('tool handler smoke: query', () => {
  it('schema exports', () => {
    assert.ok(queryTool.schema, 'schema exists');
    assert.ok(typeof queryTool.handler === 'function', 'handler is a function');
  });

  it('minimal tasks query — returns results', async () => {
    const result = await queryTool.handler({ entity: 'tasks' } as any, {});
    const r = assertMcpResponse(result, 'query tasks');
    assertSuccess(r, 'query tasks');
  });

  it('tasks with where clause — returns results', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { eq: [{ var: 'flagged' }, true] },
    } as any, {});
    const r = assertMcpResponse(result, 'query flagged');
    assertSuccess(r, 'query flagged');
  });

  it('projects query — returns results', async () => {
    const result = await queryTool.handler({ entity: 'projects' } as any, {});
    const r = assertMcpResponse(result, 'query projects');
    assertSuccess(r, 'query projects');
  });

  it('tags query — returns results', async () => {
    const result = await queryTool.handler({ entity: 'tags' } as any, {});
    const r = assertMcpResponse(result, 'query tags');
    assertSuccess(r, 'query tags');
  });

  it('folders query — returns results', async () => {
    const result = await queryTool.handler({ entity: 'folders' } as any, {});
    assertMcpResponse(result, 'query folders');
    // folders may return 0 results in some environments, so don't assert success
  });

  it('summary mode — returns count', async () => {
    const result = await queryTool.handler({
      entity: 'tasks', summary: true,
    } as any, {});
    const r = assertMcpResponse(result, 'query summary');
    assertSuccess(r, 'query summary');
    assert.match(r.content[0].text, /Found \d+|No tasks found/, 'summary has count');
  });

  it('select + sort + limit — returns results', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      select: ['id', 'name'],
      sort: { by: 'name', direction: 'asc' },
      limit: 5,
    } as any, {});
    const r = assertMcpResponse(result, 'query select+sort+limit');
    assertSuccess(r, 'query select+sort+limit');
  });

  it('includeCompleted — returns results', async () => {
    const result = await queryTool.handler({
      entity: 'tasks', includeCompleted: true,
    } as any, {});
    const r = assertMcpResponse(result, 'query includeCompleted');
    assertSuccess(r, 'query includeCompleted');
  });

  it('tasks with tag filter — returns results', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { contains: [{ var: 'tags' }, 'Work'] },
    } as any, {});
    assertMcpResponse(result, 'query tag filter');
  });

  it('tasks select tags field — returns results', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      select: ['name', 'tags'],
      limit: 3,
    } as any, {});
    const r = assertMcpResponse(result, 'query select tags');
    assertSuccess(r, 'query select tags');
  });

  it('projects with folderName — returns results', async () => {
    const result = await queryTool.handler({
      entity: 'projects',
      select: ['name', 'folderName'],
    } as any, {});
    const r = assertMcpResponse(result, 'query projects+folderName');
    assertSuccess(r, 'query projects+folderName');
  });

  it('tags with parentName — returns results', async () => {
    const result = await queryTool.handler({
      entity: 'tags',
      select: ['name', 'parentName'],
    } as any, {});
    const r = assertMcpResponse(result, 'query tags+parentName');
    assertSuccess(r, 'query tags+parentName');
  });
});

describe('tool handler smoke: view', () => {
  it('schema exports', () => {
    assert.ok(viewTool.schema, 'schema exists');
    assert.ok(typeof viewTool.handler === 'function', 'handler is a function');
  });

  it('no target — returns validation error', async () => {
    const result = await viewTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'view empty');
    assertError(r, 'view empty', /Specify one of/);
  });

  it('multiple targets — returns validation error', async () => {
    const result = await viewTool.handler({ project: 'X', tag: 'Y' } as any, {});
    const r = assertMcpResponse(result, 'view multi');
    assertError(r, 'view multi', /only one/);
  });

  it('project view — does not throw', async () => {
    const result = await viewTool.handler({ project: 'Test' } as any, {});
    assertMcpResponse(result, 'view project');
  });

  it('inbox view — returns results', async () => {
    const result = await viewTool.handler({ inbox: true } as any, {});
    assertMcpResponse(result, 'view inbox');
  });

  it('flagged perspective — returns results', async () => {
    const result = await viewTool.handler({ perspective: 'Flagged' } as any, {});
    assertMcpResponse(result, 'view flagged');
  });
});

describe('tool handler smoke: list_projects', () => {
  it('schema exports', () => {
    assert.ok(listProjectsTool.schema, 'schema exists');
    assert.ok(typeof listProjectsTool.handler === 'function', 'handler is a function');
  });

  it('default args — returns project tree', async () => {
    const result = await listProjectsTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_projects');
    assertSuccess(r, 'list_projects');
    assert.match(r.content[0].text, /Projects/, 'output mentions Projects');
  });
});

describe('tool handler smoke: list_tags', () => {
  it('schema exports', () => {
    assert.ok(listTagsTool.schema, 'schema exists');
    assert.ok(typeof listTagsTool.handler === 'function', 'handler is a function');
  });

  it('default args — returns tag list', async () => {
    const result = await listTagsTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_tags');
    assertSuccess(r, 'list_tags');
    assert.match(r.content[0].text, /Tags/, 'output mentions Tags');
  });
});

describe('tool handler smoke: list_perspectives', () => {
  it('schema exports', () => {
    assert.ok(listPerspectivesTool.schema, 'schema exists');
    assert.ok(typeof listPerspectivesTool.handler === 'function', 'handler is a function');
  });

  it('default args — returns perspectives', async () => {
    const result = await listPerspectivesTool.handler({} as any, {});
    assertMcpResponse(result, 'list_perspectives');
  });
});

describe('tool handler smoke: show_forecast', () => {
  it('schema exports', () => {
    assert.ok(showForecastTool.schema, 'schema exists');
    assert.ok(typeof showForecastTool.handler === 'function', 'handler is a function');
  });

  it('default args — returns forecast', async () => {
    const result = await showForecastTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'show_forecast');
    assertSuccess(r, 'show_forecast');
    assert.match(r.content[0].text, /Forecast/, 'output mentions Forecast');
  });

  it('custom days — returns forecast', async () => {
    const result = await showForecastTool.handler({ days: 7 } as any, {});
    const r = assertMcpResponse(result, 'show_forecast 7d');
    assertSuccess(r, 'show_forecast 7d');
  });
});

// ── Mutation tool smoke tests ────────────────────────────────────────────
//
// VALIDATION ONLY — never calls a primitive that touches OmniFocus.
// Tests only exercise code paths that return before any osascript call.

describe('tool handler smoke: add_task (validation)', () => {
  it('schema exports', () => {
    assert.ok(addTaskTool.schema, 'schema exists');
    assert.ok(typeof addTaskTool.handler === 'function', 'handler is a function');
  });

  it('empty tasks array — returns error', async () => {
    const result = await addTaskTool.handler({ tasks: [] } as any, {});
    const r = assertMcpResponse(result, 'add_task empty');
    assertError(r, 'add_task empty', /No tasks provided/);
  });
});

describe('tool handler smoke: add_project (validation)', () => {
  it('schema exports', () => {
    assert.ok(addProjectTool.schema, 'schema exists');
    assert.ok(typeof addProjectTool.handler === 'function', 'handler is a function');
  });

  it('empty projects array — returns error', async () => {
    const result = await addProjectTool.handler({ projects: [] } as any, {});
    const r = assertMcpResponse(result, 'add_project empty');
    assertError(r, 'add_project empty', /No projects provided/);
  });
});

describe('tool handler smoke: edit (validation)', () => {
  it('schema exports', () => {
    assert.ok(editTool.schema, 'schema exists');
    assert.ok(typeof editTool.handler === 'function', 'handler is a function');
  });

  it('no operation — returns validation error', async () => {
    const result = await editTool.handler({
      id: 'abc', entity: 'tasks',
    } as any, {});
    const r = assertMcpResponse(result, 'edit no-op');
    assertError(r, 'edit no-op', /At least one operation/);
  });

  it('onHold for tasks — returns validation error', async () => {
    const result = await editTool.handler({
      id: 'abc', entity: 'tasks', mark: 'onHold',
    } as any, {});
    const r = assertMcpResponse(result, 'edit onHold');
    assertError(r, 'edit onHold', /cannot be put on hold/);
  });

  it('no targeting — returns error', async () => {
    const result = await editTool.handler({
      set: { name: 'New name' },
    } as any, {});
    const r = assertMcpResponse(result, 'edit no target');
    assertError(r, 'edit no target');
  });

  it('query targeting defaults to dry run — returns preview', async () => {
    const result = await editTool.handler({
      query: { entity: 'tasks', where: { eq: [{ var: 'flagged' }, true] } },
      mark: 'completed',
    } as any, {});
    const r = assertMcpResponse(result, 'edit query dryRun');
    // dryRun=true by default for query targeting, so this should return
    // either "Would edit" preview or "No items matched" — both are success
    assert.ok(!r.isError || r.content[0].text.includes('No items'), 'dry run returns preview or empty');
  });
});

describe('tool handler smoke: move (validation)', () => {
  it('schema exports', () => {
    assert.ok(moveTool.schema, 'schema exists');
    assert.ok(typeof moveTool.handler === 'function', 'handler is a function');
  });

  it('no targeting — returns error', async () => {
    const result = await moveTool.handler({
      toInbox: true,
    } as any, {});
    const r = assertMcpResponse(result, 'move no target');
    assertError(r, 'move no target');
  });

  it('tasks to folder — returns entity mismatch error', async () => {
    const result = await moveTool.handler({
      id: 'abc', entity: 'tasks', toFolderName: 'Work',
      dryRun: false,
    } as any, {});
    const r = assertMcpResponse(result, 'move tasks→folder');
    assertError(r, 'move tasks→folder');
  });

  it('no destination — returns error', async () => {
    const result = await moveTool.handler({
      id: 'abc', entity: 'tasks',
      dryRun: false,
    } as any, {});
    const r = assertMcpResponse(result, 'move no dest');
    assertError(r, 'move no dest');
  });
});

describe('tool handler smoke: remove (validation)', () => {
  it('schema exports', () => {
    assert.ok(removeTool.schema, 'schema exists');
    assert.ok(typeof removeTool.handler === 'function', 'handler is a function');
  });

  it('no id or name — returns error', async () => {
    const result = await removeTool.handler({
      itemType: 'task',
    } as any, {});
    const r = assertMcpResponse(result, 'remove no id');
    assertError(r, 'remove no id', /id or name/i);
  });
});
