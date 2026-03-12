/**
 * Core sync logic for the OmniFocus semantic index.
 *
 * Reads task/project data from OmniFocus, diffs against the stored index,
 * embeds changed content via embeddingd, and updates the SQLite database.
 */

import { executeJXA } from '../utils/scriptExecution.js';
import { enrichByIdentifier } from '../utils/omniJsEnrich.js';
import { embedBatch, embeddingToHex } from './embeddingClient.js';
import {
  ensureDb, getStoredItems, upsertItems, deleteItems,
  getEmbeddedContents, upsertEmbeddings, pruneOrphanEmbeddings,
  rebuildVecTable, type ItemData,
} from './db.js';

export interface SyncStats {
  total: number;
  added: number;
  updated: number;
  deleted: number;
  embedded: number;
  skippedEmbeddings: number;
}

// ── Content text ─────────────────────────────────────────────────────────

const MAX_NOTE_LEN = 500;

function buildContent(item: Omit<ItemData, 'content'>): string {
  let content = item.name;
  if (item.tags) content += `\nTags: ${item.tags}`;
  if (item.projectName) content += `\nProject: ${item.projectName}`;
  if (item.note) {
    const truncated = item.note.length > MAX_NOTE_LEN
      ? item.note.slice(0, MAX_NOTE_LEN) + '…'
      : item.note;
    content += `\n${truncated}`;
  }
  return content;
}

// ── OmniFocus data reads ─────────────────────────────────────────────────

interface LiveMeta {
  id: string;
  entity: 'task' | 'project';
  modificationDate: string | null;
}

/** Fast bulk read: ids + modificationDates only (~300ms). */
async function readLiveMetadata(): Promise<LiveMeta[]> {
  const script = `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var tIds = doc.flattenedTasks.id();
  var tMods = doc.flattenedTasks.modificationDate();
  var pIds = doc.flattenedProjects.id();
  var pMods = doc.flattenedProjects.modificationDate();
  var pSet = {};
  for (var i = 0; i < pIds.length; i++) pSet[pIds[i]] = true;
  var iso = function(d) { return d ? d.toISOString() : null; };
  var out = [];
  for (var i = 0; i < tIds.length; i++) {
    if (pSet[tIds[i]]) continue;
    out.push({ id: tIds[i], entity: 'task', modificationDate: iso(tMods[i]) });
  }
  for (var i = 0; i < pIds.length; i++) {
    out.push({ id: pIds[i], entity: 'project', modificationDate: iso(pMods[i]) });
  }
  return JSON.stringify(out);
})()`;
  return await executeJXA(script);
}

interface RawFullData {
  tasks: Array<Omit<ItemData, 'content'>>;
  projects: Array<Omit<ItemData, 'content'>>;
}

/** Expensive bulk read: all properties including notes (~5-20s). */
async function readFullData(): Promise<RawFullData> {
  const script = `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var tIds = doc.flattenedTasks.id();
  var tNames = doc.flattenedTasks.name();
  var tNotes = doc.flattenedTasks.note();
  var tMods = doc.flattenedTasks.modificationDate();
  var tTags = doc.flattenedTasks.tags.name();
  var tProjs = doc.flattenedTasks.containingProject.name();
  var tFlagged = doc.flattenedTasks.flagged();
  var tDue = doc.flattenedTasks.dueDate();
  var tDefer = doc.flattenedTasks.deferDate();
  var pIds = doc.flattenedProjects.id();
  var pIdSet = {};
  for (var i = 0; i < pIds.length; i++) pIdSet[pIds[i]] = true;
  var pNames = doc.flattenedProjects.name();
  var pNotes = doc.flattenedProjects.note();
  var pMods = doc.flattenedProjects.modificationDate();
  var pFlagged = doc.flattenedProjects.flagged();
  var pDue = doc.flattenedProjects.dueDate();
  var pDefer = doc.flattenedProjects.deferDate();
  var iso = function(d) { return d ? d.toISOString() : null; };
  var tasks = [];
  for (var i = 0; i < tIds.length; i++) {
    if (pIdSet[tIds[i]]) continue;
    tasks.push({
      id: tIds[i], entity: 'task',
      name: tNames[i] || '', note: tNotes[i] || '',
      modificationDate: iso(tMods[i]) || '',
      tags: tTags[i] ? tTags[i].join(', ') : '',
      projectName: tProjs[i] || '',
      flagged: tFlagged[i] ? 1 : 0,
      dueDate: iso(tDue[i]), deferDate: iso(tDefer[i]),
    });
  }
  var projects = [];
  for (var i = 0; i < pIds.length; i++) {
    projects.push({
      id: pIds[i], entity: 'project',
      name: pNames[i] || '', note: pNotes[i] || '',
      modificationDate: iso(pMods[i]) || '',
      tags: '', projectName: '',
      flagged: pFlagged[i] ? 1 : 0,
      dueDate: iso(pDue[i]), deferDate: iso(pDefer[i]),
    });
  }
  return JSON.stringify({ tasks: tasks, projects: projects });
})()`;
  return await executeJXA(script) as unknown as RawFullData;
}

/** Read a small set of changed items via OmniJS byIdentifier. */
async function readChangedItems(
  taskIds: string[],
  projectIds: string[],
): Promise<Array<Omit<ItemData, 'content'>>> {
  const items: Array<Omit<ItemData, 'content'>> = [];
  const cols = ['name', 'note', 'tags', 'projectName', 'flagged', 'dueDate', 'deferDate', 'modificationDate'];

  if (taskIds.length > 0) {
    const rows = await enrichByIdentifier('tasks', taskIds, cols);
    for (const row of rows) {
      if (!row) continue;
      items.push({
        id: row.id as string,
        entity: 'task',
        name: (row.name as string) || '',
        note: (row.note as string) || '',
        modificationDate: (row.modificationDate as string) || '',
        tags: Array.isArray(row.tags) ? (row.tags as string[]).join(', ') : '',
        projectName: (row.projectName as string) || '',
        flagged: row.flagged ? 1 : 0,
        dueDate: (row.dueDate as string) || null,
        deferDate: (row.deferDate as string) || null,
      });
    }
  }

  if (projectIds.length > 0) {
    const rows = await enrichByIdentifier('projects', projectIds, cols.filter(c => c !== 'tags' && c !== 'projectName'));
    for (const row of rows) {
      if (!row) continue;
      items.push({
        id: row.id as string,
        entity: 'project',
        name: (row.name as string) || '',
        note: (row.note as string) || '',
        modificationDate: (row.modificationDate as string) || '',
        tags: '',
        projectName: '',
        flagged: row.flagged ? 1 : 0,
        dueDate: (row.dueDate as string) || null,
        deferDate: (row.deferDate as string) || null,
      });
    }
  }

  return items;
}

// ── Sync ─────────────────────────────────────────────────────────────────

export async function syncIndex(): Promise<SyncStats> {
  ensureDb();

  // 1. Fast metadata read from OmniFocus
  const liveMeta = await readLiveMetadata();
  const liveById = new Map(liveMeta.map(m => [m.id, m]));

  // 2. Stored state
  const stored = getStoredItems();
  const storedById = new Map(stored.map(s => [s.id, s]));

  // 3. Diff
  const newIds: LiveMeta[] = [];
  const changedIds: LiveMeta[] = [];
  for (const live of liveMeta) {
    const prev = storedById.get(live.id);
    if (!prev) {
      newIds.push(live);
    } else if (prev.modificationDate !== live.modificationDate) {
      changedIds.push(live);
    }
  }
  const deletedIds = stored.filter(s => !liveById.has(s.id)).map(s => s.id);

  const needsUpdate = newIds.length + changedIds.length;

  // 4. Early exit if nothing changed
  if (needsUpdate === 0 && deletedIds.length === 0) {
    return { total: liveMeta.length, added: 0, updated: 0, deleted: 0, embedded: 0, skippedEmbeddings: 0 };
  }

  // 5. Read full data for changed items
  let itemsToUpsert: ItemData[];
  const allChanged = [...newIds, ...changedIds];

  if (needsUpdate > 50) {
    // Full bulk read — amortises the note-read cost across all items
    console.error(`  Reading all items (bulk read for ${needsUpdate} changes)...`);
    const full = await readFullData();
    const allRaw = [...full.tasks, ...full.projects];
    itemsToUpsert = allRaw.map(raw => ({ ...raw, content: buildContent(raw) }));
  } else {
    // Small batch via OmniJS byIdentifier
    const taskIds = allChanged.filter(m => m.entity === 'task').map(m => m.id);
    const projIds = allChanged.filter(m => m.entity === 'project').map(m => m.id);
    console.error(`  Reading ${needsUpdate} changed items via OmniJS...`);
    const changedRaw = await readChangedItems(taskIds, projIds);
    itemsToUpsert = changedRaw.map(raw => ({ ...raw, content: buildContent(raw) }));
  }

  // 6. Determine which content strings need embedding
  const existingEmbeddings = getEmbeddedContents();
  const contentToEmbed: string[] = [];
  for (const item of itemsToUpsert) {
    if (!existingEmbeddings.has(item.content)) {
      contentToEmbed.push(item.content);
    }
  }
  // Deduplicate (identical content across items shares one embedding)
  const uniqueContent = [...new Set(contentToEmbed)];

  // 7. Embed new content
  let embeddedCount = 0;
  if (uniqueContent.length > 0) {
    console.error(`  Embedding ${uniqueContent.length} texts...`);
    const vectors = await embedBatch(uniqueContent);
    const pairs = uniqueContent.map((text, i) => ({
      content: text,
      embeddingHex: embeddingToHex(vectors[i]),
    }));
    upsertEmbeddings(pairs);
    embeddedCount = uniqueContent.length;
  }

  // 8. Upsert items
  if (itemsToUpsert.length > 0) {
    console.error(`  Upserting ${itemsToUpsert.length} items...`);
    upsertItems(itemsToUpsert);
  }

  // 9. Delete removed items
  if (deletedIds.length > 0) {
    console.error(`  Deleting ${deletedIds.length} removed items...`);
    deleteItems(deletedIds);
  }

  // 10. Prune orphaned embeddings and rebuild vec table
  pruneOrphanEmbeddings();
  console.error('  Rebuilding vec table...');
  rebuildVecTable();

  return {
    total: liveMeta.length,
    added: newIds.length,
    updated: changedIds.length,
    deleted: deletedIds.length,
    embedded: embeddedCount,
    skippedEmbeddings: contentToEmbed.length - embeddedCount,
  };
}
