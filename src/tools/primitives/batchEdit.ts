/**
 * Batch Edit — AppleScript generation + execution for editing tasks/projects.
 *
 * Uses direct ID references (`a reference to flattened task id anId of default document`)
 * for clean, efficient item access. Dates pre-constructed outside tell blocks to avoid
 * Foundation/current-date conflicts.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateDateAssignmentV2 } from '../../utils/dateFormatting.js';
import { escapeForAppleScript } from '../../utils/applescriptEscaping.js';

const execAsync = promisify(exec);

// ── Types ────────────────────────────────────────────────────────────────

export type MarkValue = 'completed' | 'dropped' | 'active' | 'onHold' | 'flagged' | 'unflagged';

export interface BatchEditParams {
  ids: string[];
  entity: 'tasks' | 'projects';

  set?: {
    name?: string;
    note?: string;
    dueDate?: string | null;
    deferDate?: string | null;
    plannedDate?: string | null;
    flagged?: boolean;
    estimatedMinutes?: number | null;
    sequential?: boolean;
  };
  addTags?: string[];
  removeTags?: string[];
  mark?: MarkValue;
  offset?: {
    dueDate?: { days: number };
    deferDate?: { days: number };
    plannedDate?: { days: number };
  };
}

export interface BatchEditResult {
  success: boolean;
  results?: Array<{ id: string; name: string; success: boolean; error?: string }>;
  error?: string;
}

// ── AppleScript Generation ───────────────────────────────────────────────

export function generateEditScript(params: BatchEditParams): string {
  const { ids, entity, set: setProps, addTags, removeTags, mark, offset } = params;
  const entityClass = entity === 'tasks' ? 'flattened task' : 'flattened project';

  // ── Date pre-construction (before Foundation) ──────────────────────
  const datePreScripts: string[] = [];
  const dateVarNames: Record<string, string> = {};

  if (setProps) {
    for (const [prop, asProp] of [
      ['dueDate', 'due date'],
      ['deferDate', 'defer date'],
      ['plannedDate', 'planned date'],
    ] as const) {
      const val = setProps[prop];
      if (val === undefined) continue;
      if (val === null) {
        // null → clear; handled inline as `missing value`
        dateVarNames[asProp] = 'missing value';
      } else {
        const parts = generateDateAssignmentV2('workItem', asProp, val);
        if (parts) {
          if (parts.preScript) datePreScripts.push(parts.preScript);
          // Extract the var name from the assignment (e.g. "set due date of workItem to dateVarXYZ")
          const m = parts.assignmentScript.match(/to (\S+)$/);
          dateVarNames[asProp] = m ? m[1] : 'missing value';
        }
      }
    }
  }

  // ── Build script ───────────────────────────────────────────────────
  let s = 'use scripting additions\n\n';

  if (datePreScripts.length > 0) {
    s += datePreScripts.join('\n') + '\n\n';
  }

  s += `use framework "Foundation"

property NSString : a reference to current application's NSString
property NSJSONSerialization : a reference to current application's NSJSONSerialization

on escapeForJSON(theText)
  set nsStr to NSString's stringWithString:theText
  set jsonData to NSJSONSerialization's dataWithJSONObject:{nsStr} options:0 |error|:(missing value)
  set jsonArrayString to (NSString's alloc()'s initWithData:jsonData encoding:4) as text
  return text 3 thru -3 of jsonArrayString
end escapeForJSON

try
  tell application "OmniFocus"
    tell default document
`;

  // ── Tag pre-resolution (fail fast) ─────────────────────────────────
  if (addTags && addTags.length > 0) {
    for (let i = 0; i < addTags.length; i++) {
      const escaped = escapeForAppleScript(addTags[i]);
      s += `
      set addTag${i} to missing value
      try
        set addTag${i} to first flattened tag whose name = "${escaped}"
      end try
      if addTag${i} is missing value then
        return "[{\\"success\\":false,\\"error\\":\\"Tag not found: ${escaped}\\"}]"
      end if
`;
    }
  }

  if (removeTags && removeTags.length > 0) {
    for (let i = 0; i < removeTags.length; i++) {
      const escaped = escapeForAppleScript(removeTags[i]);
      s += `
      set removeTag${i} to missing value
      try
        set removeTag${i} to first flattened tag whose name = "${escaped}"
      end try
`;
    }
  }

  // ── IDs list ───────────────────────────────────────────────────────
  const idList = ids.map(id => `"${escapeForAppleScript(id)}"`).join(', ');
  s += `
      set theIds to {${idList}}
      set resultItems to {}
`;

  // ── Per-item loop ──────────────────────────────────────────────────
  s += `
      repeat with anId in theIds
        try
          set workItem to a reference to ${entityClass} id anId
          set itemName to name of workItem
          tell workItem
`;

  // set properties
  if (setProps) {
    if (setProps.name !== undefined) {
      s += `            set name to "${escapeForAppleScript(setProps.name)}"\n`;
    }
    if (setProps.note !== undefined) {
      s += `            set note to "${escapeForAppleScript(setProps.note)}"\n`;
    }
    if (setProps.flagged !== undefined) {
      s += `            set flagged to ${setProps.flagged}\n`;
    }
    if (setProps.estimatedMinutes !== undefined) {
      s += setProps.estimatedMinutes === null
        ? `            set estimated minutes to missing value\n`
        : `            set estimated minutes to ${setProps.estimatedMinutes}\n`;
    }
    if (setProps.sequential !== undefined && entity === 'projects') {
      s += `            set sequential to ${setProps.sequential}\n`;
    }

    // Date assignments
    for (const asProp of ['due date', 'defer date', 'planned date'] as const) {
      if (dateVarNames[asProp] !== undefined) {
        s += `            set ${asProp} to ${dateVarNames[asProp]}\n`;
      }
    }
  }

  // mark
  if (mark) {
    s += generateMarkScript(mark, entity);
  }

  // offset
  if (offset) {
    for (const [prop, asProp] of [
      ['dueDate', 'due date'],
      ['deferDate', 'defer date'],
      ['plannedDate', 'planned date'],
    ] as const) {
      const spec = offset[prop];
      if (spec) {
        s += `            set curVal to ${asProp}\n`;
        s += `            if curVal is not missing value then\n`;
        s += `              set ${asProp} to curVal + (${spec.days} * days)\n`;
        s += `            end if\n`;
      }
    }
  }

  s += `          end tell\n`;

  // tags (outside tell workItem — add/remove need the item reference)
  if (addTags && addTags.length > 0) {
    for (let i = 0; i < addTags.length; i++) {
      s += `          add addTag${i} to tags of workItem\n`;
    }
  }
  if (removeTags && removeTags.length > 0) {
    for (let i = 0; i < removeTags.length; i++) {
      s += `          if removeTag${i} is not missing value then\n`;
      s += `            remove removeTag${i} from tags of workItem\n`;
      s += `          end if\n`;
    }
  }

  // result assembly
  s += `
          set end of resultItems to "{\\"id\\":\\"" & anId & "\\",\\"name\\":\\"" & my escapeForJSON(itemName) & "\\",\\"success\\":true}"
        on error errMsg
          set end of resultItems to "{\\"id\\":\\"" & anId & "\\",\\"success\\":false,\\"error\\":\\"" & my escapeForJSON(errMsg) & "\\"}"
        end try
      end repeat
`;

  // ── Assemble JSON array ────────────────────────────────────────────
  s += `
      set jsonResult to "["
      repeat with i from 1 to count of resultItems
        set jsonResult to jsonResult & item i of resultItems
        if i < count of resultItems then
          set jsonResult to jsonResult & ","
        end if
      end repeat
      set jsonResult to jsonResult & "]"
      return jsonResult
    end tell
  end tell
on error errorMessage
  return "[{\\"success\\":false,\\"error\\":\\"" & my escapeForJSON(errorMessage) & "\\"}]"
end try
`;

  return s;
}

function generateMarkScript(mark: MarkValue, entity: 'tasks' | 'projects'): string {
  switch (mark) {
    case 'completed':
      return '            mark complete\n';
    case 'dropped':
      return '            mark dropped\n';
    case 'active':
      if (entity === 'tasks') {
        return '            mark incomplete\n';
      }
      return '            set status to active status\n';
    case 'onHold':
      if (entity === 'tasks') {
        // will be caught at validation layer, but defensive here
        return '            -- onHold not supported for tasks\n';
      }
      return '            set status to on hold status\n';
    case 'flagged':
      return '            set flagged to true\n';
    case 'unflagged':
      return '            set flagged to false\n';
  }
}

// ── Execution ────────────────────────────────────────────────────────────

export async function executeBatchEdit(params: BatchEditParams): Promise<BatchEditResult> {
  let tempFile: string | undefined;

  try {
    const script = generateEditScript(params);

    console.error(`[batchEdit] Executing for ${params.ids.length} ${params.entity}...`);

    tempFile = join(tmpdir(), `batch_edit_${Date.now()}.applescript`);
    writeFileSync(tempFile, script);

    const { stdout, stderr } = await execAsync(`osascript "${tempFile}"`);

    try { unlinkSync(tempFile); } catch { /* ignore */ }

    if (stderr) console.error('[batchEdit] stderr:', stderr);

    try {
      const results = JSON.parse(stdout);
      const allOk = Array.isArray(results) && results.every((r: any) => r.success);
      return { success: allOk, results };
    } catch {
      return { success: false, error: `Failed to parse result: ${stdout}` };
    }
  } catch (error: any) {
    if (tempFile) { try { unlinkSync(tempFile); } catch { /* ignore */ } }
    return { success: false, error: error?.message || 'Unknown error in batchEdit' };
  }
}
