import { z } from 'zod';
import { moveItem, MoveItemParams } from '../primitives/moveItem.js';

export const schema = z.object({
  id: z.string().optional().describe("The ID of the task or project to move (preferred)"),
  name: z.string().optional().describe("The name of the task or project to move (fallback if ID not provided)"),
  itemType: z.enum(['task', 'project']).describe("Type of item to move ('task' or 'project')"),

  // Task destinations
  toProjectName: z.string().optional().describe("Move task to this project (by name)"),
  toProjectId: z.string().optional().describe("Move task to this project (by ID, preferred over name)"),
  toInbox: z.boolean().optional().describe("Move task to the inbox (set to true)"),

  // Project destinations
  toFolderName: z.string().optional().describe("Move project to this folder (by name)"),
});

export async function handler(args: z.infer<typeof schema>, _extra: any) {
  try {
    if (!args.id && !args.name) {
      return {
        content: [{
          type: "text" as const,
          text: "Either id or name must be provided to identify the item to move."
        }],
        isError: true,
      };
    }

    // Validate destination is provided
    if (args.itemType === 'task' && !args.toProjectName && !args.toProjectId && !args.toInbox) {
      return {
        content: [{
          type: "text" as const,
          text: "For tasks, provide a destination: toProjectName, toProjectId, or toInbox."
        }],
        isError: true,
      };
    }

    if (args.itemType === 'project' && !args.toFolderName) {
      return {
        content: [{
          type: "text" as const,
          text: "For projects, provide a destination: toFolderName."
        }],
        isError: true,
      };
    }

    const result = await moveItem(args as MoveItemParams);

    if (result.success) {
      const label = args.itemType === 'task' ? 'Task' : 'Project';
      const destLabel = args.itemType === 'task'
        ? (args.toInbox ? 'inbox' : `project "${result.destination}"`)
        : `folder "${result.destination}"`;
      return {
        content: [{
          type: "text" as const,
          text: `${label} "${result.name}" moved to ${destLabel}.`
        }],
      };
    } else {
      let errorMsg = `Failed to move ${args.itemType}`;
      if (result.error) {
        if (result.error.includes("Item not found")) {
          errorMsg = `${args.itemType.charAt(0).toUpperCase() + args.itemType.slice(1)} not found`;
          if (args.id) errorMsg += ` with ID "${args.id}"`;
          if (args.name) errorMsg += `${args.id ? ' or' : ' with'} name "${args.name}"`;
          errorMsg += '.';
        } else {
          errorMsg += `: ${result.error}`;
        }
      }
      return {
        content: [{ type: "text" as const, text: errorMsg }],
        isError: true,
      };
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Tool execution error: ${error.message}`);
    return {
      content: [{
        type: "text" as const,
        text: `Error moving ${args.itemType}: ${error.message}`
      }],
      isError: true,
    };
  }
}
