/**
 * Tool handler smoke tests.
 *
 * Verifies:
 *   - Every tool exports a schema and handler function
 *   - Validation-only code paths that return before any primitive call
 *   - Basic happy-path calls return success (requires OmniFocus running)
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

function assertSuccess(r: McpResponse, label: string): string {
  assert.ok(!r.isError, `${label}: unexpected error — ${r.content[0]?.text}`);
  return r.content[0].text;
}

function assertError(result: McpResponse, label: string, pattern?: RegExp): void {
  assert.ok(result.isError, `${label}: expected isError=true`);
  if (pattern) {
    assert.match(result.content[0].text, pattern, `${label}: error text mismatch`);
  }
}

// ── Schema export tests ─────────────────────────────────────────────────

describe('tool schema exports: read-only tools', () => {
  it('query — exports schema and handler', () => {
    assert.ok(queryTool.schema, 'schema exists');
    assert.ok(typeof queryTool.handler === 'function', 'handler is a function');
  });

  it('view — exports schema and handler', () => {
    assert.ok(viewTool.schema, 'schema exists');
    assert.ok(typeof viewTool.handler === 'function', 'handler is a function');
  });

  it('list_projects — exports schema and handler', () => {
    assert.ok(listProjectsTool.schema, 'schema exists');
    assert.ok(typeof listProjectsTool.handler === 'function', 'handler is a function');
  });

  it('list_tags — exports schema and handler', () => {
    assert.ok(listTagsTool.schema, 'schema exists');
    assert.ok(typeof listTagsTool.handler === 'function', 'handler is a function');
  });

  it('list_perspectives — exports schema and handler', () => {
    assert.ok(listPerspectivesTool.schema, 'schema exists');
    assert.ok(typeof listPerspectivesTool.handler === 'function', 'handler is a function');
  });

  it('show_forecast — exports schema and handler', () => {
    assert.ok(showForecastTool.schema, 'schema exists');
    assert.ok(typeof showForecastTool.handler === 'function', 'handler is a function');
  });
});

// ── View validation tests (no OmniFocus calls) ──────────────────────────

describe('tool validation: view', () => {
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
});

// ── Mutation tool validation tests (no OmniFocus calls) ─────────────────

describe('tool validation: add_task', () => {
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

describe('tool validation: add_project', () => {
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

describe('tool validation: edit', () => {
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
});

describe('tool validation: move', () => {
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
    const r = assertMcpResponse(result, 'move tasks->folder');
    assertError(r, 'move tasks->folder');
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

describe('tool validation: remove', () => {
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

// ── Happy-path smoke tests (require OmniFocus running) ───────────────────

describe('smoke: query tool', () => {
  it('query folders', async () => {
    const result = await queryTool.handler({ entity: 'folders' } as any, {});
    const r = assertMcpResponse(result, 'query folders');
    assertSuccess(r, 'query folders');
  });

  it('tasks with tag filter', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { contains: [{ var: 'tags' }, 'Work'] },
    } as any, {});
    const r = assertMcpResponse(result, 'tasks with tag filter');
    assertSuccess(r, 'tasks with tag filter');
  });
});

describe('smoke: view tool', () => {
  it('project view — returns results', async () => {
    const result = await viewTool.handler({ project: 'a' } as any, {});
    const r = assertMcpResponse(result, 'project view');
    assertSuccess(r, 'project view');
  });

  it('inbox view — returns results', async () => {
    const result = await viewTool.handler({ inbox: true } as any, {});
    const r = assertMcpResponse(result, 'inbox view');
    assertSuccess(r, 'inbox view');
  });

  it('flagged perspective — returns results', async () => {
    const result = await viewTool.handler({ perspective: 'Flagged' } as any, {});
    const r = assertMcpResponse(result, 'flagged perspective');
    assertSuccess(r, 'flagged perspective');
  });
});

describe('smoke: list_perspectives', () => {
  it('default args — returns perspectives', async () => {
    const result = await listPerspectivesTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_perspectives');
    assertSuccess(r, 'list_perspectives');
  });
});
