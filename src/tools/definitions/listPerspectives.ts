import { z } from 'zod';
import { queryOmnifocus } from '../primitives/queryOmnifocus.js';

export const schema = z.object({
  includeBuiltIn: z.boolean().optional().describe("Include built-in perspectives (Inbox, Projects, Tags, etc.). Default: true"),
  includeCustom: z.boolean().optional().describe("Include custom perspectives (Pro feature). Default: true")
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    const result = await queryOmnifocus({ entity: 'perspectives' });

    if (result.success) {
      let perspectives = result.items || [];

      // Filter by type
      const includeBuiltIn = args.includeBuiltIn ?? true;
      const includeCustom = args.includeCustom ?? true;

      if (!includeBuiltIn) {
        perspectives = perspectives.filter((p: any) => p.type !== 'builtin');
      }
      if (!includeCustom) {
        perspectives = perspectives.filter((p: any) => p.type !== 'custom');
      }

      if (perspectives.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No perspectives found."
          }]
        };
      }

      let output = `## Available Perspectives (${perspectives.length})\n\n`;

      const builtIn = perspectives.filter((p: any) => p.type === 'builtin');
      const custom = perspectives.filter((p: any) => p.type === 'custom');

      if (builtIn.length > 0) {
        output += `### Built-in Perspectives\n`;
        builtIn.forEach((p: any) => {
          output += `• ${p.name}\n`;
        });
      }

      if (custom.length > 0) {
        if (builtIn.length > 0) output += '\n';
        output += `### Custom Perspectives\n`;
        custom.forEach((p: any) => {
          output += `• ${p.name}\n`;
        });
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
          text: `Failed to list perspectives: ${result.error}`
        }],
        isError: true
      };
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Error listing perspectives: ${error.message}`);
    return {
      content: [{
        type: "text" as const,
        text: `Error listing perspectives: ${error.message}`
      }],
      isError: true
    };
  }
}
