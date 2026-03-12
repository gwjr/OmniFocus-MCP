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
  includeCompleted?: boolean;
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
 *   < 0.4 = very relevant, 0.4-0.7 = relevant, 0.7-0.9 = marginal, > 0.9 = noise
 *
 * Uses a steeper exponential decay so that the 60-80% range better
 * separates signal from noise (the old 1/(1+d²) curve was too flat).
 */
function distanceToConfidence(distance: number): number {
  // Exponential decay: d=0 → 100%, d=0.5 → 78%, d=0.7 → 61%, d=0.9 → 44%, d=1.2 → 24%
  const conf = 100 * Math.exp(-distance * distance);
  return Math.round(conf * 10) / 10;
}

/** Minimum confidence below which results are noise. */
const MIN_CONFIDENCE = 45;

export async function semanticSearch(params: SemanticSearchParams): Promise<SemanticSearchResult> {
  const { query, limit = 5, entity = 'all', includeCompleted = false } = params;

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

    // 2. KNN search — over-fetch to allow post-filtering
    const raw = knnSearch(queryHex, limit * 3, entity, includeCompleted);

    // 3. Format results, filtering out empty names and low-confidence noise
    const results: FormattedResult[] = [];
    for (const r of raw) {
      if (!r.name || !r.name.trim()) continue; // skip empty-name items
      const confidence = distanceToConfidence(r.distance);
      if (confidence < MIN_CONFIDENCE) continue; // below noise floor
      results.push({
        id: r.id,
        entity: r.entity,
        name: r.name,
        projectName: r.projectName || null,
        tags: r.tags || null,
        note: r.note ? (r.note.length > 200 ? r.note.slice(0, 200) + '…' : r.note) : null,
        flagged: r.flagged === 1,
        dueDate: r.dueDate || null,
        deferDate: r.deferDate || null,
        confidence,
        distance: Math.round(r.distance * 1000) / 1000,
      });
      if (results.length >= limit) break;
    }

    return { success: true, results, count: results.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('embeddingd') || msg.includes('com.gwjrmwd.embeddingd')) {
      return { success: false, error: 'embeddingd is not running. Launch it first.' };
    }
    return { success: false, error: msg };
  }
}
