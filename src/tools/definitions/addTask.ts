import { z } from 'zod';
import { addOmniFocusTask, AddOmniFocusTaskParams } from '../primitives/addOmniFocusTask.js';
import { batchAddItems, BatchAddItemsParams } from '../primitives/batchAddItems.js';
import { coerceJson, appendCoercionWarnings } from '../utils/coercion.js';

const taskSchema = z.object({
  name: z.string().describe("The name of the task"),
  note: z.string().optional().describe("Additional notes for the task"),
  dueDate: z.string().optional().describe("Due date in ISO format (YYYY-MM-DD or full ISO date)"),
  deferDate: z.string().optional().describe("Defer date in ISO format (YYYY-MM-DD or full ISO date)"),
  plannedDate: z.string().optional().describe("Planned date in ISO format — indicates intention to work on this date"),
  flagged: z.boolean().optional().describe("Whether the task is flagged"),
  estimatedMinutes: z.number().optional().describe("Estimated time to complete, in minutes"),
  tags: z.array(z.string()).optional().describe("Tags to assign to the task"),
  projectName: z.string().optional().describe("Project to add the task to (inbox if not specified)"),
  parentTaskId: z.string().optional().describe("ID of the parent task (preferred for accuracy)"),
  parentTaskName: z.string().optional().describe("Name of the parent task (matched within project or globally)"),
});

export const schema = z.object({
  tasks: coerceJson('tasks', z.array(taskSchema).describe(
    "Array of tasks to add. For a single task, pass an array with one element."
  )),
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    const tasks = args.tasks;

    if (!tasks || tasks.length === 0) {
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings("No tasks provided.") }],
        isError: true
      };
    }

    // Single task: use direct add for simplicity
    if (tasks.length === 1) {
      const task = tasks[0];
      const result = await addOmniFocusTask(task as AddOmniFocusTaskParams);

      if (result.success) {
        const placement = (result as any).placement as string | undefined;
        const location = placement === 'parent' ? 'under the parent task'
          : task.projectName ? `in project "${task.projectName}"`
          : 'in your inbox';
        return {
          content: [{ type: "text" as const, text: appendCoercionWarnings(`Task "${task.name}" created ${location}.`) }]
        };
      }
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(`Failed to create task: ${result.error}`) }],
        isError: true
      };
    }

    // Multiple tasks: batch add
    const batchItems = tasks.map(t => ({ ...t, type: 'task' as const }));
    const result = await batchAddItems(batchItems as BatchAddItemsParams[]);

    const successes = result.results.filter(r => r.success).length;
    const failures = result.results.filter(r => !r.success).length;

    let message = `Created ${successes} of ${tasks.length} tasks.`;
    if (failures > 0) {
      const failDetails = result.results
        .map((r, i) => r.success ? null : `- "${tasks[i].name}": ${r.error}`)
        .filter(Boolean)
        .join('\n');
      message += `\n\nFailed:\n${failDetails}`;
    }

    return {
      content: [{ type: "text" as const, text: appendCoercionWarnings(message) }],
      isError: failures === tasks.length
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      content: [{ type: "text" as const, text: appendCoercionWarnings(`Error: ${error.message}`) }],
      isError: true
    };
  }
}
