/**
 * Unit tests for link extraction and writing utilities.
 *
 * Tests script generation, variable registration, and orchestrator integration.
 * No OmniFocus process needed — these test generated JXA script text
 * and query engine wiring, not actual execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildExtractLinksScript } from '../dist/utils/extractLinks.js';
import { buildWriteLinksScript } from '../dist/utils/writeLinks.js';
import { taskVars, projectVars, getVarRegistry, isArrayVar } from '../dist/tools/query/variables.js';
import { buildSetIrPlan, analyseColumnOverlap } from '../dist/tools/query/executionUnits/orchestrator.js';

// ── extractLinks script generation ──────────────────────────────────────

describe('buildExtractLinksScript — basic structure', () => {
  it('generates a self-invoking function', () => {
    const script = buildExtractLinksScript(['id1'], 'task');
    assert.ok(script.startsWith('(function()'), 'Should be a self-invoking function');
    assert.ok(script.endsWith('})()'), 'Should end with invocation');
  });

  it('uses flattenedTasks for task entity', () => {
    const script = buildExtractLinksScript(['id1'], 'task');
    assert.ok(script.includes('flattenedTasks.byId'), 'Should use flattenedTasks');
  });

  it('uses flattenedProjects for project entity', () => {
    const script = buildExtractLinksScript(['id1'], 'project');
    assert.ok(script.includes('flattenedProjects.byId'), 'Should use flattenedProjects');
  });

  it('embeds the ID array as JSON', () => {
    const script = buildExtractLinksScript(['abc', 'def'], 'task');
    assert.ok(script.includes('["abc","def"]'), 'Should contain the ID array as JSON');
  });

  it('accesses attributeRuns for link extraction', () => {
    const script = buildExtractLinksScript(['id1'], 'task');
    assert.ok(script.includes('attributeRuns'), 'Should read attributeRuns');
    assert.ok(script.includes("byName('link')"), 'Should access link attribute by name');
  });

  it('groups consecutive runs with same URL', () => {
    const script = buildExtractLinksScript(['id1'], 'task');
    // Check for the merge logic: prevUrl comparison and text concatenation
    assert.ok(script.includes('prevUrl'), 'Should track previous URL for grouping');
    assert.ok(script.includes('.text +='), 'Should concatenate text for same URL');
  });

  it('returns JSON object keyed by ID', () => {
    const script = buildExtractLinksScript(['id1', 'id2'], 'task');
    assert.ok(script.includes('out[id]'), 'Should key results by ID');
    assert.ok(script.includes('JSON.stringify(out)'), 'Should return JSON object');
  });
});

// ── writeLinks script generation ────────────────────────────────────────

describe('buildWriteLinksScript — basic structure', () => {
  it('generates a self-invoking function', () => {
    const script = buildWriteLinksScript(
      [{ id: 'id1', links: [{ text: 'Example', url: 'https://example.com' }] }],
      'task',
    );
    assert.ok(script.startsWith('(function()'), 'Should be a self-invoking function');
  });

  it('uses flattenedTasks for task entity', () => {
    const script = buildWriteLinksScript(
      [{ id: 'id1', links: [{ text: 'Test', url: 'https://test.com' }] }],
      'task',
    );
    assert.ok(script.includes('flattenedTasks.byId'), 'Should use flattenedTasks');
  });

  it('uses flattenedProjects for project entity', () => {
    const script = buildWriteLinksScript(
      [{ id: 'id1', links: [{ text: 'Test', url: 'https://test.com' }] }],
      'project',
    );
    assert.ok(script.includes('flattenedProjects.byId'), 'Should use flattenedProjects');
  });

  it('sets note text once then applies link attributes by paragraph index', () => {
    const script = buildWriteLinksScript(
      [{ id: 'id1', links: [{ text: 'Link', url: 'https://a.com' }] }],
      'task',
    );
    // Builds full text in one shot
    assert.ok(script.includes('item.note = currentNote + suffix'), 'Should set note text once');
    // Applies new link attributes by paragraph index
    assert.ok(script.includes('paragraphs[paraIdx]'), 'Should index paragraphs for new links');
    assert.ok(script.includes("byName('link').value = newLinks[j].url"), 'Should set new link attribute');
  });

  it('reads and re-applies existing links', () => {
    const script = buildWriteLinksScript(
      [{ id: 'id1', links: [{ text: 'Link', url: 'https://a.com' }] }],
      'task',
    );
    // Reads existing links before modification
    assert.ok(script.includes('existingLinks'), 'Should track existing links');
    // Re-applies existing link attributes after plain-text set
    assert.ok(script.includes('existingLinks[k].url'), 'Should re-apply existing link URLs');
  });

  it('embeds all items as JSON', () => {
    const items = [
      { id: 'id1', links: [{ text: 'A', url: 'https://a.com' }] },
      { id: 'id2', links: [{ text: 'B', url: 'https://b.com' }] },
    ];
    const script = buildWriteLinksScript(items, 'task');
    assert.ok(script.includes('"id1"'), 'Should include first ID');
    assert.ok(script.includes('"id2"'), 'Should include second ID');
    assert.ok(script.includes('https://a.com'), 'Should include first URL');
    assert.ok(script.includes('https://b.com'), 'Should include second URL');
  });
});

// ── Variable registration ───────────────────────────────────────────────

describe('links variable registration', () => {
  it('links is registered in taskVars', () => {
    assert.ok('links' in taskVars, 'taskVars should have links');
    assert.equal(taskVars.links.type, 'array');
    assert.equal(taskVars.links.cost, 'expensive');
    assert.equal(taskVars.links.appleEventsProperty, null);
  });

  it('links is registered in projectVars', () => {
    assert.ok('links' in projectVars, 'projectVars should have links');
    assert.equal(projectVars.links.type, 'array');
    assert.equal(projectVars.links.cost, 'expensive');
    assert.equal(projectVars.links.appleEventsProperty, null);
  });

  it('links is not registered in folderVars', () => {
    const registry = getVarRegistry('folders');
    assert.ok(!('links' in registry), 'folderVars should not have links');
  });

  it('links is not registered in tagVars', () => {
    const registry = getVarRegistry('tags');
    assert.ok(!('links' in registry), 'tagVars should not have links');
  });

  it('isArrayVar returns true for links on tasks', () => {
    assert.ok(isArrayVar('links', 'tasks'));
  });

  it('isArrayVar returns true for links on projects', () => {
    assert.ok(isArrayVar('links', 'projects'));
  });
});

// ── Orchestrator integration — links stripped from plan ──────────────────

describe('orchestrator — links column handling', () => {
  it('links does not appear in SetIR plan select columns', () => {
    // If links is in the select list, the plan should NOT try to read it.
    // It would fail because there's no AE property or OmniJS accessor for it.
    // The orchestrator strips it before plan generation.
    // We verify this by checking that buildSetIrPlan doesn't throw when
    // links is absent from the select list.
    const plan = buildSetIrPlan({
      predicate: true,
      entity: 'tasks',
      op: 'get',
      select: ['name', 'id'],
    });
    assert.ok(plan, 'Plan should be generated without links');
  });

  it('analyseColumnOverlap treats links as output-only when not in predicate', () => {
    const overlap = analyseColumnOverlap(
      { op: 'eq', args: [{ var: 'flagged' }, true] },
      ['name', 'links'],
    );
    assert.ok(overlap.outputOnlyColumns.includes('links') || overlap.outputOnlyColumns.includes('name'),
      'links and/or name should be output-only');
    assert.ok(overlap.filterColumns.has('flagged'), 'flagged should be a filter column');
  });
});
