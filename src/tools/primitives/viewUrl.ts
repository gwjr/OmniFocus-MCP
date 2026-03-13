import type { QueryOmnifocusParams } from './queryOmnifocus.js';
import { queryOmnifocus } from './queryOmnifocus.js';
import { resolvePerspectiveQuery } from './perspectiveQuery.js';

export interface ResolvedViewUrl {
  label: string;
  queryParams: QueryOmnifocusParams;
}

interface ParsedOmniFocusUrl {
  kind: string;
  id: string;
}

function parseOmniFocusUrl(url: string): ParsedOmniFocusUrl {
  const match = url.match(/^omnifocus:\/\/\/([^/?#]+)\/([^/?#]+)/i);
  if (!match) {
    throw new Error(`Unsupported OmniFocus URL: ${url}`);
  }

  return {
    kind: decodeURIComponent(match[1]).toLowerCase(),
    id: decodeURIComponent(match[2]),
  };
}

async function isProjectId(id: string): Promise<boolean> {
  const result = await queryOmnifocus({
    entity: 'projects',
    where: { eq: [{ var: 'id' }, id] },
    select: ['id'],
    includeCompleted: true,
    limit: 1,
  });

  if (!result.success) {
    throw new Error(`Project URL probe failed: ${result.error}`);
  }

  return (result.items?.length ?? 0) > 0;
}

export async function resolveViewUrl(url: string): Promise<ResolvedViewUrl> {
  const parsed = parseOmniFocusUrl(url);

  switch (parsed.kind) {
    case 'task':
    case 'project':
      if (await isProjectId(parsed.id)) {
        return {
          label: `project "${parsed.id}"`,
          queryParams: {
            entity: 'tasks',
            where: { container: ['project', { eq: [{ var: 'id' }, parsed.id] }] },
          },
        };
      }
      return {
        label: `task "${parsed.id}"`,
        queryParams: {
          entity: 'tasks',
          where: { eq: [{ var: 'id' }, parsed.id] },
        },
      };
    case 'tag':
      return {
        label: `tag "${parsed.id}"`,
        queryParams: {
          entity: 'tasks',
          where: { container: ['tag', { eq: [{ var: 'id' }, parsed.id] }] },
        },
      };
    case 'folder':
      return {
        label: `folder "${parsed.id}"`,
        queryParams: {
          entity: 'projects',
          where: { container: ['folder', { eq: [{ var: 'id' }, parsed.id] }] },
        },
      };
    case 'perspective':
      return {
        label: `perspective "${parsed.id}"`,
        queryParams: await resolvePerspectiveQuery(parsed.id),
      };
    default:
      throw new Error(`Unsupported OmniFocus URL target type: ${parsed.kind}`);
  }
}
