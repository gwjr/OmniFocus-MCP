/**
 * SQLite operations for the semantic index.
 *
 * All access goes through the Homebrew sqlite3 CLI so we can load the
 * sqlite-vec extension (vec0.dylib). No npm sqlite dependency needed.
 */

import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';

const SQLITE3 = '/opt/homebrew/opt/sqlite/bin/sqlite3';
const VEC0_PATH = join(homedir(), '.mail-index', 'vec0.dylib');
const DB_DIR = join(homedir(), '.omnifocus-mcp');
export const DB_PATH = join(DB_DIR, 'semantic.db');

// ── Helpers ──────────────────────────────────────────────────────────────

/** Escape a string for use in an SQL single-quoted literal. */
function sqlStr(val: string | null | undefined): string {
  if (val === null || val === undefined) return 'NULL';
  return `'${val.replace(/'/g, "''")}'`;
}

/** Run raw SQL against the DB. Optionally loads vec0 extension. */
function runSql(sql: string, opts: { vec?: boolean } = {}): string {
  const prefix = opts.vec ? `.load ${VEC0_PATH}\n` : '';
  return execSync(`${SQLITE3} "${DB_PATH}"`, {
    input: prefix + sql,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

/** Run SQL and parse JSON output (.mode json). */
function runSqlJson(sql: string, opts: { vec?: boolean } = {}): any[] {
  const prefix = opts.vec ? `.load ${VEC0_PATH}\n` : '';
  const raw = execSync(`${SQLITE3} "${DB_PATH}"`, {
    input: prefix + `.mode json\n${sql}`,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return raw.trim() ? JSON.parse(raw) : [];
}

// ── Schema ───────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    dimensions INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS current_model (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model_id INTEGER NOT NULL REFERENCES models(id)
);

INSERT OR IGNORE INTO models(id, name, dimensions) VALUES (1, 'all-MiniLM-L6-v2', 384);
INSERT OR IGNORE INTO current_model(id, model_id) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    entity TEXT NOT NULL,
    name TEXT NOT NULL,
    note TEXT,
    tags TEXT,
    projectName TEXT,
    content TEXT NOT NULL,
    modificationDate TEXT NOT NULL,
    flagged INTEGER DEFAULT 0,
    dueDate TEXT,
    deferDate TEXT
);

CREATE TABLE IF NOT EXISTS text_embeddings (
    content TEXT NOT NULL,
    model_id INTEGER NOT NULL REFERENCES models(id),
    embedding BLOB NOT NULL,
    PRIMARY KEY (content, model_id)
);
`;

export function ensureDb(): void {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }
  runSql(SCHEMA);
}

// ── Item operations ──────────────────────────────────────────────────────

export interface StoredItem {
  id: string;
  entity: string;
  modificationDate: string;
  content: string;
}

/** Get all stored items (id, entity, modificationDate, content) for diffing. */
export function getStoredItems(): StoredItem[] {
  return runSqlJson('SELECT id, entity, modificationDate, content FROM items;');
}

export interface ItemData {
  id: string;
  entity: 'task' | 'project';
  name: string;
  note: string;
  tags: string;
  projectName: string;
  content: string;
  modificationDate: string;
  flagged: number;
  dueDate: string | null;
  deferDate: string | null;
}

/** Upsert items into the items table. Batched into transactions of 500. */
export function upsertItems(items: ItemData[]): void {
  if (items.length === 0) return;
  const BATCH = 500;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const stmts = batch.map(it =>
      `INSERT OR REPLACE INTO items(id,entity,name,note,tags,projectName,content,modificationDate,flagged,dueDate,deferDate) VALUES(${sqlStr(it.id)},${sqlStr(it.entity)},${sqlStr(it.name)},${sqlStr(it.note)},${sqlStr(it.tags)},${sqlStr(it.projectName)},${sqlStr(it.content)},${sqlStr(it.modificationDate)},${it.flagged},${sqlStr(it.dueDate)},${sqlStr(it.deferDate)});`
    );
    runSql('BEGIN;\n' + stmts.join('\n') + '\nCOMMIT;');
  }
}

/** Delete items by ID. */
export function deleteItems(ids: string[]): void {
  if (ids.length === 0) return;
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const inList = batch.map(id => sqlStr(id)).join(',');
    runSql(`DELETE FROM items WHERE id IN (${inList});`);
  }
}

// ── Embedding operations ─────────────────────────────────────────────────

/** Get content strings that already have embeddings (avoids re-embedding). */
export function getEmbeddedContents(): Set<string> {
  const rows = runSqlJson(
    'SELECT content FROM text_embeddings WHERE model_id = (SELECT model_id FROM current_model WHERE id = 1);'
  );
  return new Set(rows.map((r: any) => r.content));
}

/**
 * Upsert embedding entries. contentHexPairs: [contentText, embeddingHex].
 * Uses INSERT OR IGNORE since content+model_id is the PK (content-addressed).
 */
export function upsertEmbeddings(pairs: Array<{ content: string; embeddingHex: string }>): void {
  if (pairs.length === 0) return;
  const BATCH = 200;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const stmts = batch.map(p =>
      `INSERT OR IGNORE INTO text_embeddings(content, model_id, embedding) VALUES(${sqlStr(p.content)}, (SELECT model_id FROM current_model WHERE id = 1), X'${p.embeddingHex}');`
    );
    runSql('BEGIN;\n' + stmts.join('\n') + '\nCOMMIT;');
  }
}

/** Prune orphaned embeddings (content not referenced by any item). */
export function pruneOrphanEmbeddings(): void {
  runSql('DELETE FROM text_embeddings WHERE content NOT IN (SELECT content FROM items);');
}

// ── Vec table ────────────────────────────────────────────────────────────

/** Rebuild the vec0 virtual table from items + text_embeddings. */
export function rebuildVecTable(): void {
  runSql(`
DROP TABLE IF EXISTS vec_items;
CREATE VIRTUAL TABLE vec_items USING vec0(
    item_rowid INTEGER PRIMARY KEY,
    embedding float[384]
);
INSERT INTO vec_items(item_rowid, embedding)
SELECT i.rowid, te.embedding
FROM items i
JOIN text_embeddings te ON te.content = i.content
  AND te.model_id = (SELECT model_id FROM current_model WHERE id = 1);
`, { vec: true });
}

// ── KNN search ───────────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  entity: string;
  name: string;
  note: string | null;
  tags: string | null;
  projectName: string | null;
  flagged: number;
  dueDate: string | null;
  deferDate: string | null;
  distance: number;
}

/**
 * KNN search: find the closest items to a query embedding.
 * Returns up to `overFetch` vec results, filtered by entity, limited to `limit`.
 */
export function knnSearch(
  queryHex: string,
  limit: number,
  entity?: 'tasks' | 'projects' | 'all',
): SearchResult[] {
  const overFetch = Math.max(limit * 3, 50);
  const entityFilter = entity && entity !== 'all'
    ? `AND i.entity = ${sqlStr(entity === 'tasks' ? 'task' : 'project')}`
    : '';

  return runSqlJson(`
SELECT i.id, i.entity, i.name, i.note, i.tags, i.projectName,
       i.flagged, i.dueDate, i.deferDate, v.distance
FROM (
  SELECT item_rowid, distance
  FROM vec_items
  WHERE embedding MATCH X'${queryHex}'
  ORDER BY distance
  LIMIT ${overFetch}
) v
JOIN items i ON i.rowid = v.item_rowid
${entityFilter}
ORDER BY v.distance
LIMIT ${limit};
`, { vec: true });
}

/** Check whether the DB and vec_items table exist and are populated. */
export function isIndexReady(): boolean {
  if (!existsSync(DB_PATH)) return false;
  try {
    const rows = runSqlJson('SELECT count(*) as n FROM items;');
    return rows.length > 0 && rows[0].n > 0;
  } catch {
    return false;
  }
}
