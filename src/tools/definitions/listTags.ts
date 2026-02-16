import { z } from 'zod';
import { listTags } from '../primitives/listTags.js';

export const schema = z.object({
  includeActive: z.boolean().optional().describe("Include active tags (default: true)"),
  includeOnHold: z.boolean().optional().describe("Include on-hold tags (default: false)"),
  includeDropped: z.boolean().optional().describe("Include dropped tags (default: false)")
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    const result = await listTags({
      includeActive: args.includeActive ?? true,
      includeOnHold: args.includeOnHold ?? false,
      includeDropped: args.includeDropped ?? false
    });

    if (result.success) {
      const tags = result.tags || [];

      if (tags.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No tags found matching the specified criteria."
          }]
        };
      }

      // Group tags: top-level vs nested
      const topLevel = tags.filter(t => !t.parent);
      const nested = tags.filter(t => t.parent);

      let output = `## Tags (${tags.length})\n\n`;

      // Show top-level tags
      for (const tag of topLevel) {
        const count = tag.taskCount > 0 ? ` (${tag.taskCount} tasks)` : '';
        const status = tag.status !== 'Active' ? ` [${tag.status}]` : '';
        output += `• ${tag.name}${count}${status}\n`;

        // Show children of this tag
        const children = nested.filter(t => t.parent === tag.name);
        for (const child of children) {
          const cCount = child.taskCount > 0 ? ` (${child.taskCount} tasks)` : '';
          const cStatus = child.status !== 'Active' ? ` [${child.status}]` : '';
          output += `  • ${child.name}${cCount}${cStatus}\n`;
        }
      }

      // Show any nested tags whose parents weren't in the top-level list
      // (e.g., parent is on-hold but child is active)
      const shownParents = new Set(topLevel.map(t => t.name));
      const orphanedNested = nested.filter(t => t.parent && !shownParents.has(t.parent));
      if (orphanedNested.length > 0) {
        output += `\n### Nested (parent not shown)\n`;
        for (const tag of orphanedNested) {
          const count = tag.taskCount > 0 ? ` (${tag.taskCount} tasks)` : '';
          output += `  • ${tag.parent} > ${tag.name}${count}\n`;
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: output
        }]
      };
    } else {
      return {
        content: [{
          type: "text" as const,
          text: `Failed to list tags: ${result.error}`
        }],
        isError: true
      };
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Error listing tags: ${error.message}`);
    return {
      content: [{
        type: "text" as const,
        text: `Error listing tags: ${error.message}`
      }],
      isError: true
    };
  }
}
