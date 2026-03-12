import { z } from 'zod';
import { semanticSearch } from '../primitives/semanticSearch.js';

export const schema = z.object({
  query: z.string().describe('Concrete search terms — use specific nouns/verbs like "draft legal brief" not abstract concepts like "things to do". More specific = better results.'),
  limit: z.number().optional().describe('Max results (default: 5)'),
  entity: z.enum(['tasks', 'projects', 'all']).optional()
    .describe('Filter by entity type. Use "tasks" for actionable items, "projects" for containers. Default: all.'),
  includeCompleted: z.boolean().optional()
    .describe('Include completed/dropped items (default: false)'),
});

export async function handler(args: z.infer<typeof schema>, _extra: any) {
  try {
    const result = await semanticSearch({
      query: args.query,
      limit: args.limit,
      entity: args.entity,
      includeCompleted: args.includeCompleted,
    });

    if (!result.success) {
      return {
        content: [{
          type: "text" as const,
          text: `Semantic search failed: ${result.error}`,
        }],
        isError: true,
      };
    }

    const results = result.results || [];

    if (results.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `No results found for: "${args.query}"`,
        }],
      };
    }

    let output = `## Semantic Search: "${args.query}"\n\n`;
    output += `Found ${results.length} result${results.length !== 1 ? 's' : ''}:\n\n`;

    for (const r of results) {
      const icon = r.entity === 'project' ? '📁' : r.flagged ? '🚩' : '•';
      const conf = `${r.confidence}%`;
      output += `${icon} **${r.name}** (${conf})\n`;

      const meta: string[] = [];
      if (r.projectName) meta.push(`Project: ${r.projectName}`);
      if (r.tags) meta.push(`Tags: ${r.tags}`);
      if (r.dueDate) meta.push(`Due: ${r.dueDate.split('T')[0]}`);
      if (r.deferDate) meta.push(`Defer: ${r.deferDate.split('T')[0]}`);
      if (meta.length > 0) output += `  ${meta.join(' · ')}\n`;

      if (r.note) output += `  _${r.note.replace(/\n/g, ' ')}_\n`;

      output += `  ID: ${r.id}\n\n`;
    }

    return {
      content: [{
        type: "text" as const,
        text: output,
      }],
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      content: [{
        type: "text" as const,
        text: `Error in semantic search: ${error.message}`,
      }],
      isError: true,
    };
  }
}
