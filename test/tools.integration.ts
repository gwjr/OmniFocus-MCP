/**
 * Tool handler integration tests.
 *
 * Exercises every non-mutating tool handler against a live OmniFocus
 * instance with realistic arguments. Asserts:
 *   - No crashes (handler returns without throwing)
 *   - Success responses (isError is not set)
 *   - Non-empty results where expected
 *   - Correct response shape and content
 *   - Human-readable output (no raw JSON)
 *
 * Requires OmniFocus running. Run with:
 *   node --test --test-timeout=60000 test/tools.integration.ts
 *
 * NOT included in the default `node --test test/*.test.ts` glob.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Import tool handlers ─────────────────────────────────────────────────
import * as queryTool from '../dist/tools/definitions/queryOmnifocus.js';
import * as viewTool from '../dist/tools/definitions/view.js';
import * as listProjectsTool from '../dist/tools/definitions/listProjects.js';
import * as listTagsTool from '../dist/tools/definitions/listTags.js';
import * as listPerspectivesTool from '../dist/tools/definitions/listPerspectives.js';
import * as showForecastTool from '../dist/tools/definitions/showForecast.js';
import { queryOmnifocus } from '../dist/tools/primitives/queryOmnifocus.js';

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

function assertNotRawJson(text: string, label: string): void {
  const trimmed = text.trimStart();
  assert.ok(
    !trimmed.startsWith('{') && !trimmed.startsWith('['),
    `${label}: response starts with raw JSON — expected human-readable text.\nFirst 200 chars: ${trimmed.slice(0, 200)}`
  );
}

async function getSampleViewUrls(): Promise<{ taskUrl: string; projectUrl: string }> {
  const [taskResult, projectResult] = await Promise.all([
    queryOmnifocus({
      entity: 'tasks',
      where: {
        and: [
          { eq: [{ var: 'hasChildren' }, false] },
          { isNotNull: [{ var: 'projectId' }] },
        ],
      },
      select: ['id'],
      limit: 1,
    }),
    queryOmnifocus({
      entity: 'projects',
      select: ['id'],
      includeCompleted: true,
      limit: 1,
    }),
  ]);

  assert.ok(taskResult.success, `sample task ID query failed: ${taskResult.error}`);
  assert.ok(projectResult.success, `sample project ID query failed: ${projectResult.error}`);

  const taskId = taskResult.items?.[0]?.id;
  const projectId = projectResult.items?.[0]?.id;
  assert.equal(typeof taskId, 'string', 'sample task ID is missing');
  assert.equal(typeof projectId, 'string', 'sample project ID is missing');

  return {
    taskUrl: `omnifocus:///task/${taskId}`,
    projectUrl: `omnifocus:///task/${projectId}`,
  };
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
    const r = assertMcpResponse(result, 'due filter');
    assertSuccess(r, 'due filter');
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
    const r = assertMcpResponse(result, 'folders');
    assertSuccess(r, 'folders');
  });
});

// ── view tool ────────────────────────────────────────────────────────────

describe('integration: view tool', () => {
  it('project view — returns tasks or empty message', async () => {
    const result = await viewTool.handler({ project: 'a' } as any, {});
    const r = assertMcpResponse(result, 'project view');
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

  it('Perspectives pseudo-perspective — lists perspectives', async () => {
    const result = await viewTool.handler({ perspective: 'Perspectives' } as any, {});
    const r = assertMcpResponse(result, 'perspectives view');
    const text = assertSuccess(r, 'perspectives view');
    assert.match(text, /Perspectives/, 'mentions Perspectives');
  });

  it('Projects built-in perspective — delegates to projects view', async () => {
    const result = await viewTool.handler({ perspective: 'Projects' } as any, {});
    const r = assertMcpResponse(result, 'projects perspective');
    const text = assertSuccess(r, 'projects perspective');
    assert.match(text, /Projects/, 'mentions Projects');
  });

  it('Tags built-in perspective — delegates to tags view', async () => {
    const result = await viewTool.handler({ perspective: 'Tags' } as any, {});
    const r = assertMcpResponse(result, 'tags perspective');
    const text = assertSuccess(r, 'tags perspective');
    assert.match(text, /Tags \(\d+\)/, 'has tag count header');
  });

  it('Forecast built-in perspective — delegates to forecast view', async () => {
    const result = await viewTool.handler({ perspective: 'Forecast' } as any, {});
    const r = assertMcpResponse(result, 'forecast perspective');
    const text = assertSuccess(r, 'forecast perspective');
    assert.match(text, /Forecast/, 'mentions Forecast');
  });

  it('task URL — returns the matching task', async () => {
    const { taskUrl } = await getSampleViewUrls();
    const result = await viewTool.handler({ url: taskUrl } as any, {});
    const r = assertMcpResponse(result, 'task url');
    const text = assertSuccess(r, 'task url');
    assert.match(text, /task "/i, 'mentions task label');
  });

  it('project URL — returns tasks in the matching project', async () => {
    const { projectUrl } = await getSampleViewUrls();
    const result = await viewTool.handler({ url: projectUrl } as any, {});
    const r = assertMcpResponse(result, 'project url');
    const text = assertSuccess(r, 'project url');
    assert.match(text, /project "/i, 'mentions project label');
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
  it('returns perspectives without crashing', async () => {
    const result = await listPerspectivesTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_perspectives');
    assertSuccess(r, 'list_perspectives');
    assert.match(r.content[0].text, /Perspectives/, 'output mentions Perspectives');
  });

  it('custom-only filter', async () => {
    const result = await listPerspectivesTool.handler({
      includeBuiltIn: false, includeCustom: true,
    } as any, {});
    const r = assertMcpResponse(result, 'custom only');
    assertSuccess(r, 'custom only');
  });

  it('built-in-only filter', async () => {
    const result = await listPerspectivesTool.handler({
      includeBuiltIn: true, includeCustom: false,
    } as any, {});
    const r = assertMcpResponse(result, 'builtin only');
    assertSuccess(r, 'builtin only');
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

// ── query tool — similar predicate ────────────────────────────────────────

describe('integration: query similar predicate', () => {
  it('tasks — similar returns results without crashing', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { similar: ['kitchen'] },
    } as any, {});
    const r = assertMcpResponse(result, 'similar tasks');
    assertSuccess(r, 'similar tasks');
  });

  it('projects — similar returns results without crashing', async () => {
    const result = await queryTool.handler({
      entity: 'projects',
      where: { similar: ['planning'] },
    } as any, {});
    const r = assertMcpResponse(result, 'similar projects');
    assertSuccess(r, 'similar projects');
  });

  it('tasks — similar composed with flagged filter', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { and: [{ similar: ['legal'] }, { eq: [{ var: 'flagged' }, true] }] },
    } as any, {});
    const r = assertMcpResponse(result, 'similar+flagged');
    assertSuccess(r, 'similar+flagged');
  });

  it('tasks — similar with limit', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { similar: ['email'] },
      limit: 3,
    } as any, {});
    const r = assertMcpResponse(result, 'similar+limit');
    assertSuccess(r, 'similar+limit');
  });

  it('tasks — similar with select', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { similar: ['shopping'] },
      select: ['id', 'name'],
      limit: 5,
    } as any, {});
    const r = assertMcpResponse(result, 'similar+select');
    assertSuccess(r, 'similar+select');
  });

  it('tasks — similar with op:count', async () => {
    const result = await queryTool.handler({
      entity: 'tasks',
      where: { similar: ['meeting'] },
      op: 'count',
    } as any, {});
    const r = assertMcpResponse(result, 'similar+count');
    assertSuccess(r, 'similar+count');
  });

  it('folders — similar returns error (no semantic index)', async () => {
    const result = await queryTool.handler({
      entity: 'folders',
      where: { similar: ['test'] },
    } as any, {});
    const r = assertMcpResponse(result, 'similar folders');
    // similar on unsupported entities is not extracted by the optimizer;
    // NodeEval throws its safety message when it encounters the unextracted op.
    assert.ok(r.isError || r.content[0].text.includes('planner'), 'folders should fail with planner error');
  });

  it('tags — similar returns error (no semantic index)', async () => {
    const result = await queryTool.handler({
      entity: 'tags',
      where: { similar: ['test'] },
    } as any, {});
    const r = assertMcpResponse(result, 'similar tags');
    assert.ok(r.isError || r.content[0].text.includes('planner'), 'tags should fail with planner error');
  });
});

// ── edit with query targeting (calls OmniFocus for dry run) ──────────────

describe('integration: edit dry run', () => {
  it('query targeting defaults to dry run — returns preview', async () => {
    const { handler } = await import('../dist/tools/definitions/edit.js');
    const result = await handler({
      query: { entity: 'tasks', where: { eq: [{ var: 'flagged' }, true] } },
      mark: 'completed',
    } as any, {});
    const r = assertMcpResponse(result, 'edit query dryRun');
    assert.ok(!r.isError || r.content[0].text.includes('No items'), 'dry run returns preview or empty');
  });
});

// ── No-JSON-output regression tests ──────────────────────────────────────
//
// Every non-mutating tool should return human-readable text, not raw JSON.

describe('integration: no raw JSON output', () => {
  it('query tasks — human-readable, not JSON', async () => {
    const result = await queryTool.handler({ entity: 'tasks', limit: 3 } as any, {});
    const r = assertMcpResponse(result, 'query noJSON');
    assertSuccess(r, 'query noJSON');
    assertNotRawJson(r.content[0].text, 'query tasks');
  });

  it('query projects — human-readable, not JSON', async () => {
    const result = await queryTool.handler({ entity: 'projects', limit: 3 } as any, {});
    const r = assertMcpResponse(result, 'query projects noJSON');
    assertSuccess(r, 'query projects noJSON');
    assertNotRawJson(r.content[0].text, 'query projects');
  });

  it('query tags — human-readable, not JSON', async () => {
    const result = await queryTool.handler({ entity: 'tags', limit: 3 } as any, {});
    const r = assertMcpResponse(result, 'query tags noJSON');
    assertSuccess(r, 'query tags noJSON');
    assertNotRawJson(r.content[0].text, 'query tags');
  });

  it('query folders — human-readable, not JSON', async () => {
    const result = await queryTool.handler({ entity: 'folders' } as any, {});
    const r = assertMcpResponse(result, 'query folders noJSON');
    assertSuccess(r, 'query folders noJSON');
    assertNotRawJson(r.content[0].text, 'query folders');
  });

  it('view inbox — human-readable, not JSON', async () => {
    const result = await viewTool.handler({ inbox: true } as any, {});
    const r = assertMcpResponse(result, 'view inbox noJSON');
    assertSuccess(r, 'view inbox noJSON');
    assertNotRawJson(r.content[0].text, 'view inbox');
  });

  it('view flagged — human-readable, not JSON', async () => {
    const result = await viewTool.handler({ perspective: 'Flagged' } as any, {});
    const r = assertMcpResponse(result, 'view flagged noJSON');
    assertSuccess(r, 'view flagged noJSON');
    assertNotRawJson(r.content[0].text, 'view flagged');
  });

  it('view project — human-readable, not JSON', async () => {
    const result = await viewTool.handler({ project: 'a' } as any, {});
    const r = assertMcpResponse(result, 'view project noJSON');
    assertSuccess(r, 'view project noJSON');
    assertNotRawJson(r.content[0].text, 'view project');
  });

  it('list_projects — human-readable, not JSON', async () => {
    const result = await listProjectsTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_projects noJSON');
    assertSuccess(r, 'list_projects noJSON');
    assertNotRawJson(r.content[0].text, 'list_projects');
  });

  it('list_tags — human-readable, not JSON', async () => {
    const result = await listTagsTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_tags noJSON');
    assertSuccess(r, 'list_tags noJSON');
    assertNotRawJson(r.content[0].text, 'list_tags');
  });

  it('list_perspectives — human-readable, not JSON', async () => {
    const result = await listPerspectivesTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'list_perspectives noJSON');
    assertSuccess(r, 'list_perspectives noJSON');
    assertNotRawJson(r.content[0].text, 'list_perspectives');
  });

  it('show_forecast — human-readable, not JSON', async () => {
    const result = await showForecastTool.handler({} as any, {});
    const r = assertMcpResponse(result, 'show_forecast noJSON');
    assertSuccess(r, 'show_forecast noJSON');
    assertNotRawJson(r.content[0].text, 'show_forecast');
  });
});
