#!/usr/bin/env npx tsx
/**
 * Verify specific per-item property claims
 *
 * Targeted checks for:
 * 1. tasks.hasChildren / childCount — does numberOfTasks work on tasks? Are there any parent tasks?
 * 2. tasks.parentId — does parentTask.id() chain work?
 * 3. tasks.tags — confirmed bulk, but verify structure
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let _seq = 0;

function runJXA(script: string): { ms: number; stdout: string } {
  const f = join(tmpdir(), `verify_${Date.now()}_${_seq++}.js`);
  writeFileSync(f, script);
  const t0 = performance.now();
  let stdout: string;
  try {
    stdout = execSync(`osascript -l JavaScript "${f}"`, { timeout: 60000 }).toString();
  } finally {
    try { unlinkSync(f); } catch {}
  }
  return { ms: performance.now() - t0, stdout };
}

function runAS(script: string): { ms: number; stdout: string } {
  const f = join(tmpdir(), `verify_as_${Date.now()}_${_seq++}.applescript`);
  writeFileSync(f, script);
  const t0 = performance.now();
  let stdout: string;
  try {
    stdout = execSync(`osascript "${f}"`, { timeout: 60000 }).toString();
  } finally {
    try { unlinkSync(f); } catch {}
  }
  return { ms: performance.now() - t0, stdout };
}

console.log('# Per-Item Property Verification\n');

// ═════════════════════════════════════════════════════════════════════
// 1. hasChildren / childCount — does numberOfTasks work on tasks?
// ═════════════════════════════════════════════════════════════════════

console.log('## 1. hasChildren / childCount\n');

// First: how many tasks actually have children?
const childCheck = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
  var numTasks = items.numberOfTasks();
  var nonZero = 0;
  var examples = [];
  var names = items.name();
  var ids = items.id();
  for (var i = 0; i < numTasks.length; i++) {
    if (numTasks[i] > 0) {
      nonZero++;
      if (examples.length < 5) {
        examples.push({name: names[i], id: ids[i], children: numTasks[i]});
      }
    }
  }
  return JSON.stringify({total: numTasks.length, withChildren: nonZero, examples: examples});
})()`);
console.log(`  JXA: flattenedTasks.numberOfTasks()  ${Math.round(childCheck.ms)}ms`);
const cd = JSON.parse(childCheck.stdout.trim());
console.log(`    ${cd.total} tasks, ${cd.withChildren} have children`);
for (const ex of cd.examples) {
  console.log(`    - "${ex.name}" (${ex.id}): ${ex.children} children`);
}

// Verify via AS
const asChildCheck = runAS(`tell application "OmniFocus"
  tell default document
    set counts to number of tasks of every flattened task
    set nonZero to 0
    repeat with c in counts
      if c > 0 then set nonZero to nonZero + 1
    end repeat
    return (nonZero as text) & " of " & ((count of counts) as text)
  end tell
end tell`);
console.log(`\n  AS: number of tasks of every flattened task  ${Math.round(asChildCheck.ms)}ms`);
console.log(`    result: ${asChildCheck.stdout.trim()} have children`);

// Cross-check: does the .tasks collection give us the right thing?
const tasksCheck = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = doc.flattenedTasks;
  var taskColls = items.tasks();
  var nonEmpty = 0;
  for (var i = 0; i < taskColls.length; i++) {
    if (taskColls[i] && taskColls[i].length > 0) nonEmpty++;
  }
  return JSON.stringify({total: taskColls.length, withChildren: nonEmpty});
})()`);
console.log(`\n  JXA: flattenedTasks.tasks() (child collections)  ${Math.round(tasksCheck.ms)}ms`);
console.log(`    result: ${tasksCheck.stdout.trim()}`);

// ═════════════════════════════════════════════════════════════════════
// 2. parentId — does parentTask.id() chain work?
// ═════════════════════════════════════════════════════════════════════

console.log('\n## 2. parentId (parentTask chain)\n');

// Try parentTask.id() as chain
const parentChain = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  try {
    var parentIds = doc.flattenedTasks.parentTask.id();
    var nonNull = 0;
    var examples = [];
    var names = doc.flattenedTasks.name();
    for (var i = 0; i < parentIds.length; i++) {
      if (parentIds[i] !== null && parentIds[i] !== undefined) {
        nonNull++;
        if (examples.length < 5) {
          examples.push({task: names[i], parentId: parentIds[i]});
        }
      }
    }
    return JSON.stringify({count: parentIds.length, withParent: nonNull, examples: examples});
  } catch(e) {
    return JSON.stringify({error: e.message || String(e)});
  }
})()`);
console.log(`  JXA: flattenedTasks.parentTask.id() (chain)  ${Math.round(parentChain.ms)}ms`);
console.log(`    result: ${parentChain.stdout.trim().slice(0, 300)}`);

// Also try parentTask.name() chain
const parentNameChain = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  try {
    var parentNames = doc.flattenedTasks.parentTask.name();
    var nonNull = 0;
    for (var i = 0; i < parentNames.length; i++) {
      if (parentNames[i] !== null && parentNames[i] !== undefined && parentNames[i] !== '') nonNull++;
    }
    return JSON.stringify({count: parentNames.length, withParent: nonNull});
  } catch(e) {
    return JSON.stringify({error: e.message || String(e)});
  }
})()`);
console.log(`  JXA: flattenedTasks.parentTask.name() (chain)  ${Math.round(parentNameChain.ms)}ms`);
console.log(`    result: ${parentNameChain.stdout.trim()}`);

// AS equivalent
const asParent = runAS(`tell application "OmniFocus"
  tell default document
    try
      set parentIds to id of parent task of every flattened task
      set nonNull to 0
      repeat with p in parentIds
        if p is not missing value then set nonNull to nonNull + 1
      end repeat
      return (nonNull as text) & " of " & ((count of parentIds) as text) & " have a parent task"
    on error errMsg
      return "ERROR: " & errMsg
    end try
  end tell
end tell`);
console.log(`\n  AS: id of parent task of every flattened task  ${Math.round(asParent.ms)}ms`);
console.log(`    result: ${asParent.stdout.trim()}`);

// ═════════════════════════════════════════════════════════════════════
// 3. tags — verify bulk structure
// ═════════════════════════════════════════════════════════════════════

console.log('\n## 3. tags (bulk structure verification)\n');

// JXA chain: tags.name()
const tagNames = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var tagNameArrays = doc.flattenedTasks.tags.name();
  var withTags = 0;
  var examples = [];
  var taskNames = doc.flattenedTasks.name();
  for (var i = 0; i < tagNameArrays.length; i++) {
    if (tagNameArrays[i] && tagNameArrays[i].length > 0) {
      withTags++;
      if (examples.length < 5) {
        examples.push({task: taskNames[i], tags: tagNameArrays[i]});
      }
    }
  }
  return JSON.stringify({total: tagNameArrays.length, withTags: withTags, examples: examples});
})()`);
console.log(`  JXA: flattenedTasks.tags.name() (chain)  ${Math.round(tagNames.ms)}ms`);
const tn = JSON.parse(tagNames.stdout.trim());
console.log(`    ${tn.total} tasks, ${tn.withTags} have tags`);
for (const ex of tn.examples) {
  console.log(`    - "${ex.task.slice(0, 40)}": [${ex.tags.join(', ')}]`);
}

// JXA chain: tags.id()
const tagIds = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  try {
    var tagIdArrays = doc.flattenedTasks.tags.id();
    var withTags = 0;
    for (var i = 0; i < tagIdArrays.length; i++) {
      if (tagIdArrays[i] && tagIdArrays[i].length > 0) withTags++;
    }
    return JSON.stringify({total: tagIdArrays.length, withTags: withTags});
  } catch(e) {
    return JSON.stringify({error: e.message || String(e)});
  }
})()`);
console.log(`\n  JXA: flattenedTasks.tags.id() (chain)  ${Math.round(tagIds.ms)}ms`);
console.log(`    result: ${tagIds.stdout.trim()}`);

// AS: {id, name} of tags of every flattened task
const asTags = runAS(`tell application "OmniFocus"
  tell default document
    set tagData to name of tags of every flattened task
    set withTags to 0
    repeat with t in tagData
      if (count of t) > 0 then set withTags to withTags + 1
    end repeat
    return (withTags as text) & " of " & ((count of tagData) as text) & " have tags"
  end tell
end tell`);
console.log(`\n  AS: name of tags of every flattened task  ${Math.round(asTags.ms)}ms`);
console.log(`    result: ${asTags.stdout.trim()}`);

// ═════════════════════════════════════════════════════════════════════
// 4. Folder status
// ═════════════════════════════════════════════════════════════════════

console.log('\n## 4. Folder status\n');

const folderStatus = runJXA(`(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var names = doc.flattenedFolders.name();
  var hidden = doc.flattenedFolders.hidden();
  var effHidden = doc.flattenedFolders.effectivelyHidden();
  var results = [];
  for (var i = 0; i < names.length; i++) {
    var status = hidden[i] ? 'Dropped' : 'Active';
    results.push({name: names[i], hidden: hidden[i], effHidden: effHidden[i], status: status});
  }
  return JSON.stringify({count: results.length, examples: results.slice(0, 5)});
})()`);
console.log(`  JXA: hidden + effectivelyHidden of flattenedFolders  ${Math.round(folderStatus.ms)}ms`);
const fs = JSON.parse(folderStatus.stdout.trim());
console.log(`    ${fs.count} folders`);
for (const ex of fs.examples) {
  console.log(`    - "${ex.name}": hidden=${ex.hidden}, effHidden=${ex.effHidden} → ${ex.status}`);
}

console.log('\nDone.');
