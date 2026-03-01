import { queryOmnifocus } from './queryOmnifocus.js';

export interface ListTagsParams {
  includeActive?: boolean;
  includeOnHold?: boolean;
  includeDropped?: boolean;
}

interface TagInfo {
  id: string;
  name: string;
  status: string;
  parent: string | null;
  taskCount: number;
  active: boolean;
}

interface ListTagsResult {
  success: boolean;
  tags?: TagInfo[];
  count?: number;
  error?: string;
}

export async function listTags(params: ListTagsParams = {}): Promise<ListTagsResult> {
  const { includeActive = true, includeOnHold = false, includeDropped = false } = params;

  try {
    // Include hidden tags if we need on-hold or dropped
    const includeCompleted = includeOnHold || includeDropped;

    const result = await queryOmnifocus({
      entity: 'tags',
      select: ['id', 'name', 'hidden', 'availableTaskCount', 'parentName'],
      includeCompleted,
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Map query results to TagInfo format
    let tags: TagInfo[] = (result.items || []).map(item => {
      // Derive status from hidden property
      // Apple Events doesn't expose Tag.Status directly; hidden maps to OnHold
      const status = item.hidden ? 'OnHold' : 'Active';
      return {
        id: item.id,
        name: item.name,
        status,
        parent: item.parentName || null,
        taskCount: item.availableTaskCount ?? 0,
        active: !item.hidden,
      };
    });

    // Filter by status
    tags = tags.filter(t => {
      if (t.status === 'Active' && includeActive) return true;
      if (t.status === 'OnHold' && includeOnHold) return true;
      // Note: Dropped tags cannot be distinguished from OnHold via Apple Events
      // (both have hidden=true). Dropped filtering requires OmniJS.
      return false;
    });

    return {
      success: true,
      tags,
      count: tags.length
    };

  } catch (error) {
    console.error('Error listing tags:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}
