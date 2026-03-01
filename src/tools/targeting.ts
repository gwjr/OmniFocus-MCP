/**
 * Shared targeting resolution for edit and move tools.
 *
 * Three modes:
 *   1. id + entity  → { ids: [id], entity }
 *   2. ids + entity → { ids, entity }
 *   3. query: { entity, where } → run queryOmnifocus → { ids, entity, previews }
 */

import { queryOmnifocus } from './primitives/queryOmnifocus.js';

export type MutationEntity = 'tasks' | 'projects';

export interface TargetingInput {
  id?: string;
  ids?: string[];
  query?: { entity: MutationEntity; where: unknown };
  entity?: MutationEntity;
}

export interface ResolvedTargets {
  ids: string[];
  entity: MutationEntity;
  /** Present only for query targeting — name previews for dry-run display. */
  previews?: Array<{ id: string; name: string }>;
}

export class TargetingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetingError';
  }
}

const VALID_ENTITIES: ReadonlySet<string> = new Set(['tasks', 'projects']);

/**
 * Resolve targeting input to a list of IDs + entity.
 * Throws TargetingError on validation failures.
 */
export async function resolveTargets(input: TargetingInput): Promise<ResolvedTargets> {
  const modes = [input.id, input.ids, input.query].filter(v => v != null);

  if (modes.length === 0) {
    throw new TargetingError('Exactly one of id, ids, or query must be provided.');
  }
  if (modes.length > 1) {
    throw new TargetingError('Exactly one of id, ids, or query must be provided — got multiple.');
  }

  // ── Query mode ──────────────────────────────────────────────────────
  if (input.query != null) {
    const { entity, where } = input.query;
    if (!VALID_ENTITIES.has(entity)) {
      throw new TargetingError(`Entity must be "tasks" or "projects", got "${entity}".`);
    }
    const result = await queryOmnifocus({ entity, where, select: ['id', 'name'] });
    if (!result.success) {
      throw new TargetingError(`Query failed: ${result.error}`);
    }
    const items = result.items ?? [];
    const ids = items.map((it: any) => it.id as string).filter(Boolean);
    const previews = items.map((it: any) => ({ id: it.id as string, name: it.name as string }));
    return { ids, entity, previews };
  }

  // ── id / ids mode — entity is required ──────────────────────────────
  const entity = input.entity;
  if (!entity) {
    throw new TargetingError('Entity is required when using id or ids targeting.');
  }
  if (!VALID_ENTITIES.has(entity)) {
    throw new TargetingError(`Entity must be "tasks" or "projects", got "${entity}".`);
  }

  if (input.id != null) {
    return { ids: [input.id], entity };
  }

  // ids mode
  const ids = input.ids!;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new TargetingError('ids must be a non-empty array of strings.');
  }
  return { ids, entity };
}
