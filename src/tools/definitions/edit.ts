import { z } from 'zod';
import { resolveTargets, TargetingError, type MutationEntity } from '../targeting.js';
import { executeBatchEdit, type BatchEditParams, type MarkValue } from '../primitives/batchEdit.js';
import { coerceJson, appendCoercionWarnings } from '../utils/coercion.js';

const offsetDaysSchema = z.object({ days: z.number() });

export const schema = z.object({
  // Targeting (exactly one of id/ids/query)
  id: z.string().optional().describe("ID of the task or project to edit"),
  ids: coerceJson('ids', z.array(z.string()).optional().describe("Array of IDs to edit")),
  query: z.object({
    entity: z.enum(['tasks', 'projects']),
    where: z.unknown(),
  }).optional().describe("Query expression to select targets — { entity, where }"),
  entity: z.enum(['tasks', 'projects']).optional()
    .describe("Entity type — required for id/ids targeting, inferred from query"),

  // Operations
  set: z.object({
    name: z.string().optional(),
    note: z.string().optional(),
    dueDate: z.string().nullable().optional().describe("ISO date string, or null to clear"),
    deferDate: z.string().nullable().optional().describe("ISO date string, or null to clear"),
    plannedDate: z.string().nullable().optional().describe("ISO date string, or null to clear (tasks only)"),
    flagged: z.boolean().optional(),
    estimatedMinutes: z.number().nullable().optional(),
    sequential: z.boolean().optional().describe("Projects only"),
  }).optional().describe("Properties to set"),

  addTags: coerceJson('addTags', z.array(z.string()).optional()
    .describe("Tags to add — must already exist, error if not found")),
  removeTags: coerceJson('removeTags', z.array(z.string()).optional()
    .describe("Tags to remove — silently skips if not on item")),

  mark: z.enum(['completed', 'dropped', 'active', 'onHold', 'flagged', 'unflagged']).optional()
    .describe("Status transition"),

  offset: z.object({
    dueDate: offsetDaysSchema.optional(),
    deferDate: offsetDaysSchema.optional(),
    plannedDate: offsetDaysSchema.optional(),
  }).optional().describe("Shift dates relative to current value"),

  dryRun: z.boolean().optional()
    .describe("Preview without mutating. Default: true for query targeting, false for id/ids"),
});

export async function handler(args: z.infer<typeof schema>, _extra: any) {
  try {
    // ── Validate at least one operation ────────────────────────────────
    if (!args.set && !args.addTags && !args.removeTags && !args.mark && !args.offset) {
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          "At least one operation (set, addTags, removeTags, mark, offset) is required."
        ) }],
        isError: true,
      };
    }

    // ── Validate mark + entity compatibility ──────────────────────────
    const effectiveEntity = args.query?.entity ?? args.entity;
    if (args.mark === 'onHold' && effectiveEntity === 'tasks') {
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          "Tasks cannot be put on hold. Use mark: 'dropped' or 'completed' instead."
        ) }],
        isError: true,
      };
    }

    // ── Resolve targets ───────────────────────────────────────────────
    let resolved;
    try {
      resolved = await resolveTargets({
        id: args.id,
        ids: args.ids,
        query: args.query as any,
        entity: args.entity as MutationEntity | undefined,
      });
    } catch (e) {
      if (e instanceof TargetingError) {
        return {
          content: [{ type: "text" as const, text: appendCoercionWarnings(e.message) }],
          isError: true,
        };
      }
      throw e;
    }

    if (resolved.ids.length === 0) {
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          "No items matched the targeting criteria."
        ) }],
      };
    }

    // ── Dry run ───────────────────────────────────────────────────────
    const isDryRun = args.dryRun ?? (args.query != null);
    if (isDryRun) {
      const previews = resolved.previews ?? resolved.ids.map(id => ({ id, name: '(unknown)' }));
      const lines = previews.map(p => `- "${p.name}" (${p.id})`).join('\n');
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          `Would edit ${resolved.ids.length} ${resolved.entity}:\n${lines}`
        ) }],
      };
    }

    // ── Execute ───────────────────────────────────────────────────────
    const editParams: BatchEditParams = {
      ids: resolved.ids,
      entity: resolved.entity,
      set: args.set as BatchEditParams['set'],
      addTags: args.addTags,
      removeTags: args.removeTags,
      mark: args.mark as MarkValue | undefined,
      offset: args.offset,
    };

    const result = await executeBatchEdit(editParams);

    if (result.success) {
      const names = result.results?.map(r => `"${r.name}"`).join(', ') ?? '';
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          `Edited ${result.results?.length ?? 0} ${resolved.entity}: ${names}`
        ) }],
      };
    }

    // Partial failure — some items succeeded, some failed
    if (result.results) {
      const ok = result.results.filter(r => r.success);
      const fail = result.results.filter(r => !r.success);
      let msg = '';
      if (ok.length > 0) {
        msg += `Edited ${ok.length}: ${ok.map(r => `"${r.name}"`).join(', ')}.\n`;
      }
      if (fail.length > 0) {
        msg += `Failed ${fail.length}: ${fail.map(r => `${r.id}: ${r.error}`).join('; ')}`;
      }
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(msg) }],
        isError: fail.length > 0,
      };
    }

    return {
      content: [{ type: "text" as const, text: appendCoercionWarnings(
        `Edit failed: ${result.error}`
      ) }],
      isError: true,
    };

  } catch (err: unknown) {
    const error = err as Error;
    console.error(`[edit] Tool execution error: ${error.message}`);
    return {
      content: [{ type: "text" as const, text: appendCoercionWarnings(
        `Error: ${error.message}`
      ) }],
      isError: true,
    };
  }
}
