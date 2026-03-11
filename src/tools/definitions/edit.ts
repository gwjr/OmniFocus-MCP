import { z } from 'zod';
import { resolveTargets, TargetingError, type MutationEntity } from '../targeting.js';
import { executeBatchEdit, type BatchEditParams, type MarkValue } from '../primitives/batchEdit.js';
import { writeLinks, type LinkToAdd } from '../../utils/writeLinks.js';
import { extractLinks } from '../../utils/extractLinks.js';
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

  addLinks: z.array(z.object({
    text: z.string().describe("Display text for the link"),
    url: z.string().describe("URL target for the hyperlink"),
  })).optional().describe("Hyperlinks to append to the note (clickable in OmniFocus)"),

  offset: z.object({
    dueDate: offsetDaysSchema.optional(),
    deferDate: offsetDaysSchema.optional(),
    plannedDate: offsetDaysSchema.optional(),
  }).optional().describe("Shift dates relative to current value"),

  dryRun: z.boolean().optional()
    .describe("Preview without mutating. Default: true for query targeting, false for id/ids"),
});

function summariseEdits(args: z.infer<typeof schema>): string {
  const parts: string[] = [];
  if (args.set) {
    for (const [k, v] of Object.entries(args.set)) {
      if (v === undefined) continue;
      if (v === null) { parts.push(`cleared ${k}`); continue; }
      if (typeof v === 'boolean') { parts.push(v ? `set ${k}` : `unset ${k}`); continue; }
      parts.push(`${k}: ${v}`);
    }
  }
  if (args.mark) parts.push(`marked ${args.mark}`);
  if (args.addTags?.length) parts.push(`+tags: ${args.addTags.join(', ')}`);
  if (args.removeTags?.length) parts.push(`-tags: ${args.removeTags.join(', ')}`);
  if (args.addLinks?.length) {
    parts.push(...args.addLinks.map(l => `+link: "${l.text}" → ${l.url}`));
  }
  if (args.offset) {
    for (const [k, v] of Object.entries(args.offset)) {
      if (v) parts.push(`${k} ${v.days > 0 ? '+' : ''}${v.days}d`);
    }
  }
  return parts.length > 0 ? `Changes: ${parts.join(', ')}` : '';
}

export async function handler(args: z.infer<typeof schema>, _extra: any) {
  try {
    // ── Validate at least one operation ────────────────────────────────
    if (!args.set && !args.addTags && !args.removeTags && !args.mark && !args.offset && !args.addLinks) {
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          "At least one operation (set, addTags, removeTags, mark, offset, addLinks) is required."
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

    // Execute the standard batch edit (properties, tags, marks, offsets).
    // If addLinks is the ONLY operation, skip the AppleScript edit entirely.
    const hasStandardOps = !!(args.set || args.addTags || args.removeTags || args.mark || args.offset);
    const entitySingular = resolved.entity === 'tasks' ? 'task' as const : 'project' as const;

    // ── Preserve existing links when note is being overwritten ──────
    // Setting note via AppleScript replaces rich text with plain text,
    // destroying link attributes. Read existing links before the edit
    // so we can re-apply them afterwards.
    let preservedLinks: Map<string, Array<{ text: string; url: string }>> | null = null;
    if (args.set?.note !== undefined && hasStandardOps) {
      preservedLinks = await extractLinks(resolved.ids, entitySingular);
    }

    let result: Awaited<ReturnType<typeof executeBatchEdit>>;
    if (hasStandardOps) {
      result = await executeBatchEdit(editParams);
    } else {
      // Links-only edit: synthesise a success result with item names
      result = {
        success: true,
        results: resolved.ids.map(id => {
          const preview = resolved.previews?.find(p => p.id === id);
          return { id, name: preview?.name ?? id, success: true };
        }),
      };
    }

    // ── Write links (preserved + new) ───────────────────────────────
    // Combine preserved links with any new addLinks. writeLinks handles
    // the read-then-rewrite internally for its own appended text, but
    // when set.note replaced the entire note, the preserved links need
    // to be explicitly re-applied.
    if (result.success) {
      const newLinks = args.addLinks ?? [];
      const linkItems: Array<{ id: string; links: LinkToAdd[] }> = [];

      for (const id of resolved.ids) {
        const preserved = preservedLinks?.get(id) ?? [];
        const combined = [...preserved, ...newLinks];
        if (combined.length > 0) {
          linkItems.push({ id, links: combined });
        }
      }

      if (linkItems.length > 0) {
        await writeLinks(linkItems, entitySingular);
      }
    }

    if (result.success) {
      const names = result.results?.map(r => `"${r.name}"`).join(', ') ?? '';
      const changes = summariseEdits(args);
      return {
        content: [{ type: "text" as const, text: appendCoercionWarnings(
          `Edited ${result.results?.length ?? 0} ${resolved.entity}: ${names}\n${changes}`
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
