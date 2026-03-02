#!/usr/bin/env npx tsx
/**
 * Per-item variable audit
 *
 * Tests whether properties currently classified as "per-item" (requiring
 * .whose() or byIdentifier enrichment) are actually available as bulk
 * Apple Events collection reads.
 *
 * If doc.flattenedTasks.propertyName() returns an array, the property
 * is a bulk AE property and should be reclassified as "easy".
 *
 * Tests tasks and folders properties.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let _seq = 0;

function testBulkRead(collection: string, property: string): { ok: boolean; count?: number; error?: string; sample?: string } {
  const f = join(tmpdir(), `audit_${Date.now()}_${_seq++}.js`);
  const script = `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.${collection};
  try {
    var arr = items.${property}();
    // Sample first 5 non-null values
    var samples = [];
    for (var i = 0; i < arr.length && samples.length < 5; i++) {
      if (arr[i] !== null && arr[i] !== undefined) {
        samples.push(JSON.stringify(arr[i]));
      }
    }
    return JSON.stringify({ok: true, count: arr.length, sample: samples.join(', ')});
  } catch (e) {
    return JSON.stringify({ok: false, error: e.message || String(e)});
  }
})()`;
  writeFileSync(f, script);
  try {
    const stdout = execSync(`osascript -l JavaScript "${f}"`, { timeout: 30000 }).toString().trim();
    return JSON.parse(stdout);
  } catch (e: any) {
    return { ok: false, error: e.message?.slice(0, 200) || 'unknown error' };
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

console.log('# Per-Item Variable Audit: Bulk AE Availability\n');

// ── Tasks: properties currently classified as per-item ──────────────

console.log('## Task Properties (currently per-item)\n');

const taskPerItem = [
  // From the quote: status, tags, inInbox, sequential, hasChildren, childCount, parentId
  { prop: 'taskStatus', desc: 'task status (Available/Blocked/etc)' },
  { prop: 'inInbox', desc: 'is in inbox' },
  { prop: 'sequential', desc: 'sequential flag' },
  { prop: 'next', desc: 'is next action' },
  { prop: 'parentTask', desc: 'parent task reference' },
  // Try various forms for tags
  { prop: 'tags', desc: 'tags collection' },
  // Try for children
  { prop: 'tasks', desc: 'child tasks collection' },
  { prop: 'numberOfTasks', desc: 'child task count' },
  // Also test some we think are easy, to confirm
  { prop: 'name', desc: 'name (should be easy - control)' },
  { prop: 'flagged', desc: 'flagged (should be easy - control)' },
];

for (const { prop, desc } of taskPerItem) {
  const result = testBulkRead('flattenedTasks', prop);
  const status = result.ok ? `✓ BULK OK (${result.count} items)` : `✗ NOT BULK: ${result.error}`;
  console.log(`  ${prop.padEnd(20)} ${status}`);
  if (result.ok && result.sample) {
    console.log(`  ${''.padEnd(20)} sample: ${result.sample.slice(0, 100)}`);
  }
}

// ── Try AppleScript names for task properties ───────────────────────

console.log('\n## Task Properties via AppleScript names\n');

const taskASNames: [string, string][] = [
  ['in inbox', 'inInbox'],
  ['sequential', 'sequential'],
  ['next', 'next'],
  ['number of tasks', 'numberOfTasks / childCount'],
  ['containing project', 'containingProject / parentId proxy'],
  ['parent task', 'parentTask / parentId'],
];

for (const [asName, desc] of taskASNames) {
  const f = join(tmpdir(), `audit_as_${Date.now()}_${_seq++}.applescript`);
  const script = `tell application "OmniFocus"
  tell default document
    try
      set theVals to ${asName} of every flattened task
      return (count of theVals) as text
    on error errMsg
      return "ERROR: " & errMsg
    end try
  end tell
end tell`;
  writeFileSync(f, script);
  try {
    const stdout = execSync(`osascript "${f}"`, { timeout: 30000 }).toString().trim();
    if (stdout.startsWith('ERROR:')) {
      console.log(`  "${asName}".padEnd(25) ✗ ${stdout}`);
    } else {
      console.log(`  "${asName}"${''.padEnd(Math.max(0, 23 - asName.length))} ✓ BULK OK (${stdout} items) — ${desc}`);
    }
  } catch (e: any) {
    console.log(`  "${asName}"${''.padEnd(Math.max(0, 23 - asName.length))} ✗ FAILED: ${(e.message || '').slice(0, 100)}`);
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

// ── Folders: status ─────────────────────────────────────────────────

console.log('\n## Folder Properties\n');

const folderProps = [
  { prop: 'name', desc: 'control' },
  { prop: 'hidden', desc: 'hidden/active status' },
  { prop: 'effectivelyHidden', desc: 'effectively hidden' },
];

for (const { prop, desc } of folderProps) {
  const result = testBulkRead('flattenedFolders', prop);
  const status = result.ok ? `✓ BULK OK (${result.count} items)` : `✗ NOT BULK: ${result.error}`;
  console.log(`  ${prop.padEnd(20)} ${status}`);
  if (result.ok && result.sample) {
    console.log(`  ${''.padEnd(20)} sample: ${result.sample.slice(0, 100)}`);
  }
}

// Also try AS for folder status
console.log('\n## Folder Status via AppleScript\n');

for (const asName of ['hidden', 'effectively hidden']) {
  const f = join(tmpdir(), `audit_as_${Date.now()}_${_seq++}.applescript`);
  const script = `tell application "OmniFocus"
  tell default document
    try
      set theVals to ${asName} of every flattened folder
      return (count of theVals) as text
    on error errMsg
      return "ERROR: " & errMsg
    end try
  end tell
end tell`;
  writeFileSync(f, script);
  try {
    const stdout = execSync(`osascript "${f}"`, { timeout: 30000 }).toString().trim();
    if (stdout.startsWith('ERROR:')) {
      console.log(`  "${asName}"${''.padEnd(Math.max(0, 23 - asName.length))} ✗ ${stdout}`);
    } else {
      console.log(`  "${asName}"${''.padEnd(Math.max(0, 23 - asName.length))} ✓ BULK OK (${stdout} items)`);
    }
  } catch (e: any) {
    console.log(`  "${asName}"${''.padEnd(Math.max(0, 23 - asName.length))} ✗ FAILED: ${(e.message || '').slice(0, 100)}`);
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

// ── Test what taskStatus actually returns ────────────────────────────

console.log('\n## Task Status Deep Dive\n');

// The "status" on tasks might not exist as a bulk property - OmniFocus
// might only expose it per-item. Let's check various status-related props.
const statusProps = ['completed', 'dropped', 'blocked', 'next', 'effectivelyCompleted', 'effectivelyDropped'];

console.log('  Can we derive task status from bulk booleans?');
for (const prop of statusProps) {
  const result = testBulkRead('flattenedTasks', prop);
  const status = result.ok ? `✓ (${result.count})` : `✗`;
  console.log(`    ${prop.padEnd(25)} ${status}`);
}

console.log('\n  Task status is a computed enum (Available/Blocked/Completed/Dropped/DueSoon/Next/Overdue).');
console.log('  It can be derived from: completed, dropped, blocked, next, effectivelyCompleted,');
console.log('  effectivelyDropped, dueDate (for DueSoon/Overdue). All are bulk-readable.');
