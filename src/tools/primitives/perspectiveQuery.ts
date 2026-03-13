import type { QueryOmnifocusParams } from './queryOmnifocus.js';
import { customPerspectiveToQuery } from './customPerspectiveQuery.js';
import { fetchCustomPerspectiveArchives, fetchTagNamesWithStatus } from './queryPerspectives.js';

const BUILTIN_PERSPECTIVE_QUERIES: Record<string, QueryOmnifocusParams> = {
  flagged: {
    entity: 'tasks',
    where: { eq: [{ var: 'flagged' }, true] },
  },
  inbox: {
    entity: 'tasks',
    where: { eq: [{ var: 'inInbox' }, true] },
  },
};

export function resolveBuiltinPerspectiveQuery(nameOrId: string): QueryOmnifocusParams | null {
  const key = nameOrId.toLowerCase();
  const builtIn = BUILTIN_PERSPECTIVE_QUERIES[key];
  return builtIn ? { ...builtIn } : null;
}

async function resolveCustomPerspectiveQuery(nameOrId: string): Promise<QueryOmnifocusParams> {
  const matches = await fetchCustomPerspectiveArchives(nameOrId);
  if (matches.length === 0) {
    throw new Error(`Custom perspective not found: ${nameOrId}`);
  }
  if (matches.length > 1) {
    throw new Error(`Custom perspective "${nameOrId}" is ambiguous`);
  }

  const onHoldTagNames = await fetchTagNamesWithStatus('OnHold');
  return customPerspectiveToQuery(matches[0], { onHoldTagNames });
}

export async function resolvePerspectiveQuery(nameOrId: string): Promise<QueryOmnifocusParams> {
  return resolveBuiltinPerspectiveQuery(nameOrId) ?? resolveCustomPerspectiveQuery(nameOrId);
}
