import { executeOmniFocusScript } from '../../utils/scriptExecution.js';

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
    const result = await executeOmniFocusScript('@listTags.js');

    if (result.error) {
      return {
        success: false,
        error: result.error
      };
    }

    let tags: TagInfo[] = result.tags || [];

    // Filter by status
    tags = tags.filter(t => {
      if (t.status === 'Active' && includeActive) return true;
      if (t.status === 'OnHold' && includeOnHold) return true;
      if (t.status === 'Dropped' && includeDropped) return true;
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
