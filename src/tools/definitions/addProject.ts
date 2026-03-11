import { z } from 'zod';
import { addProject as addProjectPrimitive, AddProjectParams } from '../primitives/addProject.js';
import { writeLinks } from '../../utils/writeLinks.js';
import { coerceJson, coerceArray, appendCoercionWarnings } from '../utils/coercion.js';

const projectSchema = z.object({
  name: z.string().describe("The name of the project"),
  note: z.string().optional().describe("Additional notes for the project"),
  dueDate: z.string().optional().describe("Due date in ISO format (YYYY-MM-DD or full ISO date)"),
  deferDate: z.string().optional().describe("Defer date in ISO format (YYYY-MM-DD or full ISO date)"),
  flagged: z.boolean().optional().describe("Whether the project is flagged"),
  estimatedMinutes: z.number().optional().describe("Estimated time to complete, in minutes"),
  tags: z.array(z.string()).optional().describe("Tags to assign to the project"),
  links: coerceJson('links', z.array(z.object({
    text: z.string().describe("Display text for the link"),
    url: z.string().describe("URL target for the hyperlink"),
  })).optional().describe("Hyperlinks to add to the note (clickable in OmniFocus)")),
  folderName: z.string().optional().describe("Folder to add the project to (root if not specified)"),
  sequential: z.boolean().optional().describe("Whether tasks should be sequential (default: false)"),
});

export const schema = z.object({
  projects: coerceJson('projects', coerceArray(z.array(projectSchema).describe(
    "Array of projects to add. A single project object is also accepted."
  ))),
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    const projects = args.projects;

    if (!projects || projects.length === 0) {
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings("No projects provided.") }],
        isError: true
      };
    }

    // Add projects sequentially (order may matter for folder creation)
    const results: { name: string; success: boolean; error?: string }[] = [];

    for (const project of projects) {
      const result = await addProjectPrimitive(project as AddProjectParams);
      // Append hyperlinks if project was created successfully
      if (result.success && result.projectId && project.links?.length) {
        await writeLinks([{ id: result.projectId, links: project.links }], 'project');
      }
      results.push({
        name: project.name,
        success: result.success,
        error: result.success ? undefined : result.error,
      });
    }

    const successes = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success).length;

    if (projects.length === 1) {
      const r = results[0];
      if (r.success) {
        const location = projects[0].folderName
          ? `in folder "${projects[0].folderName}"`
          : 'at the root level';
        return {
          content: [{ type: "text" as const, text: appendCoercionWarnings(`Project "${r.name}" created ${location}.`) }]
        };
      }
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(`Failed to create project: ${r.error}`) }],
        isError: true
      };
    }

    let message = `Created ${successes} of ${projects.length} projects.`;
    if (failures > 0) {
      const failDetails = results
        .filter(r => !r.success)
        .map(r => `- "${r.name}": ${r.error}`)
        .join('\n');
      message += `\n\nFailed:\n${failDetails}`;
    }

    return {
      content: [{ type: "text" as const, text: appendCoercionWarnings(message) }],
      isError: failures === projects.length
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      content: [{ type: "text" as const, text: appendCoercionWarnings(`Error: ${error.message}`) }],
      isError: true
    };
  }
}
