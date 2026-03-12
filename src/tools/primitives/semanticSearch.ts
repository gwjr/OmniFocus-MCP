/**
 * Semantic search primitive — queries the pre-built semantic index.
 *
 * Read-only: embeds the query via embeddingd, runs KNN via sqlite-vec,
 * and formats results from the items table. No OmniFocus calls.
 */

import { embedText, embeddingToHex } from '../../indexer/embeddingClient.js';
import { isIndexReady, knnSearch, type SearchResult } from '../../indexer/db.js';

export interface SemanticSearchParams {
  query: string;
  limit?: number;
  entity?: 'tasks' | 'projects' | 'all';
}

export interface SemanticSearchResult {
  success: boolean;
  results?: FormattedResult[];
  count?: number;
  error?: string;
}

interface FormattedResult {
  id: string;
  entity: string;
  name: string;
  projectName: string | null;
  tags: string | null;
  note: string | null;
  flagged: boolean;
  dueDate: string | null;
  deferDate: string | null;
  confidence: number;
  distance: number;
}

/**
 * Convert L2 distance to a 0-100 confidence percentage.
 * Lower distance = higher confidence. Empirically, MiniLM L2 distances:
 *   < 0.5 = very relevant, 0.5-1.0 = relevant, 1.0-1.5 = marginal, > 1.5 = poor
 */
function distanceToConfidence(distance: number): number {
  // Sigmoid-like mapping: d=0 → 100%, d=1.0 → ~50%, d=2.0 → ~12%
  const conf = 100 / (1 + distance * distance);
  return Math.round(conf * 10) / 10;
}

export async function semanticSearch(params: SemanticSearchParams): Promise<SemanticSearchResult> {
  const { query, limit = 10, entity = 'all' } = params;

  // Check index exists
  if (!isIndexReady()) {
    return {
      success: false,
      error: 'Semantic index not built yet. Run the indexer first: npm run index',
    };
  }

  try {
    // 1. Embed query
    const queryVec = await embedText(query);
    const queryHex = embeddingToHex(queryVec);

    // 2. KNN search
    const raw = knnSearch(queryHex, limit, entity);

    // 3. Format results
    const results: FormattedResult[] = raw.map((r: SearchResult) => ({
      id: r.id,
      entity: r.entity,
      name: r.name,
      projectName: r.projectName || null,
      tags: r.tags || null,
      note: r.note ? (r.note.length > 200 ? r.note.slice(0, 200) + '…' : r.note) : null,
      flagged: r.flagged === 1,
      dueDate: r.dueDate || null,
      deferDate: r.deferDate || null,
      confidence: distanceToConfidence(r.distance),
      distance: Math.round(r.distance * 1000) / 1000,
    }));

    return { success: true, results, count: results.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('embeddingd') || msg.includes('com.gwjrmwd.embeddingd')) {
      return { success: false, error: 'embeddingd is not running. Launch it first.' };
    }
    return { success: false, error: msg };
  }
}
