import { z } from 'zod';
import { resolveTargets, TargetingError, type MutationEntity } from '../targeting.js';
import { executeBatchMove, validateMoveParams, MoveValidationError, type BatchMoveParams } from '../primitives/batchMove.js';
import { appendCoercionWarnings } from '../utils/coercion.js';

export const schema = z.object({
  // Targeting (exactly one of id/ids/query)
  id: z.string().optional().describe("ID of the task or project to move"),
  ids: z.array(z.string()).optional().describe("Array of IDs to move"),
  query: z.object({
    entity: z.enum(['tasks', 'projects']),
    where: z.unknown(),
  }).optional().describe("Query expression to select targets — { entity, where }"),
  entity: z.enum(['tasks', 'projects']).optional()
    .describe("Entity type — required for id/ids targeting, inferred from query"),

  // Destination (exactly one)
  toProjectId: z.string().optional().describe("Move tasks to this project (by ID)"),
  toProjectName: z.string().optional().describe("Move tasks to this project (by name — hard error if ambiguous)"),
  toFolderId: z.string().optional().describe("Move projects to this folder (by ID)"),
  toFolderName: z.string().optional().describe("Move projects to this folder (by name — hard error if ambiguous)"),
  toInbox: z.boolean().optional().describe("Move tasks to the inbox"),

  dryRun: z.boolean().optional()
    .describe("Preview without mutating. Default: true for query targeting, false for id/ids"),
});

export async function handler(args: z.infer<typeof schema>, _extra: any) {
  try {
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

    // ── Validate destination ──────────────────────────────────────────
    try {
      validateMoveParams({
        ids: resolved.ids,
        entity: resolved.entity,
        toProjectId: args.toProjectId,
        toProjectName: args.toProjectName,
        toFolderId: args.toFolderId,
        toFolderName: args.toFolderName,
        toInbox: args.toInbox,
      });
    } catch (e) {
      if (e instanceof MoveValidationError) {
        return {
          content: [{ type: "text" as const, text: appendCoercionWarnings(e.message) }],
          isError: true,
        };
      }
      throw e;
    }

    // ── Dry run ───────────────────────────────────────────────────────
    const isDryRun = args.dryRun ?? (args.query != null);
    if (isDryRun) {
      const dest = args.toProjectId ?? args.toProjectName ?? args.toFolderId ?? args.toFolderName ?? 'Inbox';
      const previews = resolved.previews ?? resolved.ids.map(id => ({ id, name: '(unknown)' }));
      const lines = previews.map(p => `- "${p.name}" (${p.id})`).join('\n');
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          `Would move ${resolved.ids.length} ${resolved.entity} to "${dest}":\n${lines}`
        ) }],
      };
    }

    // ── Execute ───────────────────────────────────────────────────────
    const moveParams: BatchMoveParams = {
      ids: resolved.ids,
      entity: resolved.entity,
      toProjectId: args.toProjectId,
      toProjectName: args.toProjectName,
      toFolderId: args.toFolderId,
      toFolderName: args.toFolderName,
      toInbox: args.toInbox,
    };

    const result = await executeBatchMove(moveParams);

    if (result.success) {
      const dest = result.results?.[0]?.destination ?? '(unknown)';
      const names = result.results?.map(r => `"${r.name}"`).join(', ') ?? '';
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          `Moved ${result.results?.length ?? 0} ${resolved.entity} to "${dest}": ${names}`
        ) }],
      };
    }

    // Partial failure
    if (result.results) {
      const ok = result.results.filter(r => r.success);
      const fail = result.results.filter(r => !r.success);
      let msg = '';
      if (ok.length > 0) {
        msg += `Moved ${ok.length}: ${ok.map(r => `"${r.name}"`).join(', ')}.\n`;
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
        `Move failed: ${result.error}`
      ) }],
      isError: true,
    };

  } catch (err: unknown) {
    const error = err as Error;
    console.error(`[move] Tool execution error: ${error.message}`);
    return {
      content: [{ type: "text" as const, text: appendCoercionWarnings(
        `Error: ${error.message}`
      ) }],
      isError: true,
    };
  }
}
