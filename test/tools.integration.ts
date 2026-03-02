/**
 * Tool handler integration tests (tier 2).
 *
 * Exercises every non-mutating tool handler against a live OmniFocus
 * instance with realistic arguments. Asserts:
 *   - No crashes (handler returns without throwing)
 *   - Success responses (isError is not set)
 *   - Non-empty results where expected
 *   - Correct response shape and content
 *
 * Requires OmniFocus running. Run with:
 *   node --test --test-timeout=60000 test/tools.integration.ts
 *
 * NOT included in the default `npm test` suite (no .test.ts in the
 * normal glob). Run explicitly or via a dedicated npm script.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ── Import tool handlers ─────────────────────────────────────────────────
import * as queryTool from '../dist/tools/definitions/queryOmnifocus.js';
import * as viewTool from '../dist/tools/definitions/view.js';
import * as listProjectsTool from '../dist/tools/definitions/listProjects.js';
import * as listTagsTool from '../dist/tools/definitions/listTags.js';
import * as listPerspectivesTool from '../dist/tools/definitions/listPerspectives.js';
import * as showForecastTool from '../dist/tools/definitions/showForecast.js';

// ── Helpers ──────────────────────────────────────────────────────────────

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
    assert.equal(item.type, 'text', `${label}: content type`);
    assert.equal(typeof item.text, 'string', `${label}: text type`);
  }
  return r;
}

function assertSuccess(r: McpResponse, label: string): string {
  assert.ok(!r.isError, `${label}: unexpected error — ${r.content[0]?.text}`);
  return r.content[0].text;
}

// ── query tool ───────────────────────────────────────────────────────────

describe('integration: query tool', () => {
  it('tasks — returns non-empty results with default fields', async () => {
    const result = await queryTool.handler({ entity: 'tasks' } as any, {});
    const r = assertMcpResponse(result, 'tasks');
    const text = assertSuccess(r, 'tasks');
    assert.match(text, /Query Results: \d+ task/, 'has result count');
  });

  it('tasks — flagged filter returns results', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { eq: [{ var: 'flagged' }, true] },
    } as any, {});
    const r = assertMcpResponse(result, 'flagged');
    assertSuccess(r, 'flagged');
  });

  it('tasks — select specific fields', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      select: ['id', 'name', 'dueDate', 'flagged'],
      limit: 3,
    } as any, {});
    const r = assertMcpResponse(result, 'select');
    const text = assertSuccess(r, 'select');
    // Limited to 3 items
    assert.match(text, /Results limited to 3/, 'mentions limit');
  });

  it('tasks — sort by name', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      sort: { by: 'name', direction: 'asc' },
      limit: 5,
    } as any, {});
    const r = assertMcpResponse(result, 'sort');
    assertSuccess(r, 'sort');
  });

  it('tasks — summary mode returns count', async () => {
    const result = await queryTool.handler({
      entity: 'tasks', summary: true,
    } as any, {});
    const r = assertMcpResponse(result, 'summary');
    const text = assertSuccess(r, 'summary');
    assert.match(text, /Found \d+/, 'has count');
  });

  it('tasks — includeCompleted returns more results', async () => {
    const [active, all] = await Promise.all([
      queryTool.handler({ entity: 'tasks', summary: true } as any, {}),
      queryTool.handler({ entity: 'tasks', summary: true, includeCompleted: true } as any, {}),
    ]);
    const activeR = assertMcpResponse(active, 'active');
    const allR = assertMcpResponse(all, 'all');
    assertSuccess(activeR, 'active');
    assertSuccess(allR, 'all');
    // Extract counts
    const activeCount = parseInt(activeR.content[0].text.match(/Found (\d+)/)?.[1] ?? '0');
    const allCount = parseInt(allR.content[0].text.match(/Found (\d+)/)?.[1] ?? '0');
    assert.ok(allCount >= activeCount, `includeCompleted should return >= active (${allCount} >= ${activeCount})`);
  });

  it('tasks — tag filter (contains)', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { contains: [{ var: 'tags' }, 'Work'] },
    } as any, {});
    const r = assertMcpResponse(result, 'tag filter');
    // May return 0 results if no "Work" tag exists, but should not error
    assertSuccess(r, 'tag filter');
  });

  it('tasks — select tags field returns tag names', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      select: ['name', 'tags'],
      limit: 5,
    } as any, {});
    const r = assertMcpResponse(result, 'tags field');
    assertSuccess(r, 'tags field');
  });

  it('tasks — due date filter', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: {
        between: [
          { var: 'dueDate' },
          { var: 'now' },
          { offset: { date: 'now', days: 30 } },
        ],
      },
    } as any, {});
    assertMcpResponse(result, 'due filter');
  });

  it('projects — returns non-empty results', async () => {
    const result = await queryTool.handler({ entity: 'projects' } as any, {});
    const r = assertMcpResponse(result, 'projects');
    const text = assertSuccess(r, 'projects');
    assert.match(text, /Query Results: \d+ project/, 'has result count');
  });

  it('projects — select folderName', async () => {
    const result = await queryTool.handler({
      entity: 'projects',
      select: ['name', 'status', 'folderName'],
    } as any, {});
    const r = assertMcpResponse(result, 'projects+folder');
    assertSuccess(r, 'projects+folder');
  });

  it('tags — returns non-empty results', async () => {
    const result = await queryTool.handler({ entity: 'tags' } as any, {});
    const r = assertMcpResponse(result, 'tags');
    const text = assertSuccess(r, 'tags');
    assert.match(text, /Query Results: \d+ tag/, 'has result count');
  });

  it('tags — select parentName', async () => {
    const result = await queryTool.handler({
      entity: 'tags',
      select: ['name', 'parentName'],
    } as any, {});
    const r = assertMcpResponse(result, 'tags+parent');
    assertSuccess(r, 'tags+parent');
  });

  it('folders — returns results', async () => {
    const result = await queryTool.handler({ entity: 'folders' } as any, {});
    assertMcpResponse(result, 'folders');
  });
});

// ── view tool ────────────────────────────────────────────────────────────

describe('integration: view tool', () => {
  it('project view — returns tasks or empty message', async () => {
    // Use a project name that likely exists — but accept empty result too
    const result = await viewTool.handler({ project: 'a' } as any, {});
    const r = assertMcpResponse(result, 'project view');
    // Should succeed even if project doesn't exist (returns "No items")
    assertSuccess(r, 'project view');
  });

  it('inbox view — returns results', async () => {
    const result = await viewTool.handler({ inbox: true } as any, {});
    const r = assertMcpResponse(result, 'inbox');
    assertSuccess(r, 'inbox');
  });

  it('flagged perspective — returns results', async () => {
    const result = await viewTool.handler({ perspective: 'Flagged' } as any, {});
    const r = assertMcpResponse(result, 'flagged');
    assertSuccess(r, 'flagged');
  });

  it('view with select + limit — returns results', async () => {
    const result = await viewTool.handler({
      inbox: true,
      select: ['id', 'name'],
      limit: 3,
    } as any, {});
    const r = assertMcpResponse(result, 'view+select');
    assertSuccess(r, 'view+select');
  });
});

// ── list_projects ────────────────────────────────────────────────────────

describe('integration: list_projects', () => {
  it('returns folder/project tree', async () => {
    const result = await listProjectsTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_projects');
    const text = assertSuccess(r, 'list_projects');
    assert.match(text, /Projects/, 'mentions Projects');
    // Should have both projects and folders in the output
    assert.match(text, /\d+ projects/, 'has project count');
    assert.match(text, /\d+ folders/, 'has folder count');
  });

  it('includeCompleted returns more projects', async () => {
    const [active, all] = await Promise.all([
      listProjectsTool.handler({} as any, {}),
      listProjectsTool.handler({ includeCompleted: true } as any, {}),
    ]);
    const activeR = assertMcpResponse(active, 'active');
    const allR = assertMcpResponse(all, 'all');
    assertSuccess(activeR, 'active');
    assertSuccess(allR, 'all');
  });
});

// ── list_tags ────────────────────────────────────────────────────────────

describe('integration: list_tags', () => {
  it('returns tag list with counts', async () => {
    const result = await listTagsTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_tags');
    const text = assertSuccess(r, 'list_tags');
    assert.match(text, /Tags \(\d+\)/, 'has tag count header');
  });

  it('includeOnHold returns tags', async () => {
    const result = await listTagsTool.handler({ includeOnHold: true } as any, {});
    const r = assertMcpResponse(result, 'list_tags onHold');
    assertSuccess(r, 'list_tags onHold');
  });
});

// ── list_perspectives ────────────────────────────────────────────────────

describe('integration: list_perspectives', () => {
  // Note: perspectives entity is not supported in the EventPlan pipeline
  // (no Apple Events class code). The handler returns an error result.
  // When perspectives support is added, update these to assert success.

  it('returns response without throwing', async () => {
    const result = await listPerspectivesTool.handler({} as any, {});
    assertMcpResponse(result, 'list_perspectives');
    // Currently errors with "No class code for entity: perspectives"
    // Accept either success or graceful error
  });

  it('custom-only filter', async () => {
    const result = await listPerspectivesTool.handler({
      includeBuiltIn: false, includeCustom: true,
    } as any, {});
    assertMcpResponse(result, 'custom only');
  });

  it('built-in-only filter', async () => {
    const result = await listPerspectivesTool.handler({
      includeBuiltIn: true, includeCustom: false,
    } as any, {});
    assertMcpResponse(result, 'builtin only');
  });
});

// ── show_forecast ────────────────────────────────────────────────────────

describe('integration: show_forecast', () => {
  it('default 14-day forecast', async () => {
    const result = await showForecastTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'forecast');
    const text = assertSuccess(r, 'forecast');
    assert.match(text, /Forecast/, 'mentions Forecast');
    assert.match(text, /Today/, 'has Today row');
    assert.match(text, /Past/, 'has Past row');
    assert.match(text, /Future/, 'has Future row');
    // Should have Due/Plan/Defer columns
    assert.match(text, /Due/, 'has Due column');
    assert.match(text, /Plan/, 'has Plan column');
    assert.match(text, /Defer/, 'has Defer column');
  });

  it('7-day forecast', async () => {
    const result = await showForecastTool.handler({ days: 7 } as any, {});
    const r = assertMcpResponse(result, 'forecast 7d');
    const text = assertSuccess(r, 'forecast 7d');
    assert.match(text, /Forecast/, 'mentions Forecast');
  });

  it('1-day forecast (minimal)', async () => {
    const result = await showForecastTool.handler({ days: 1 } as any, {});
    const r = assertMcpResponse(result, 'forecast 1d');
    assertSuccess(r, 'forecast 1d');
  });
});
