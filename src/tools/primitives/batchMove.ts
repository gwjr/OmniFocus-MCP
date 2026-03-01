/**
 * Batch Move — AppleScript generation + execution for moving tasks/projects.
 *
 * Tasks can move to a project (by ID or name) or to the inbox.
 * Projects can move to a folder (by ID or name).
 * Name-based destinations error on ambiguity (multiple items with same name).
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { escapeForAppleScript } from '../../utils/applescriptEscaping.js';

const execAsync = promisify(exec);

// ── Types ────────────────────────────────────────────────────────────────

export interface BatchMoveParams {
  ids: string[];
  entity: 'tasks' | 'projects';

  toProjectId?: string;
  toProjectName?: string;
  toFolderId?: string;
  toFolderName?: string;
  toInbox?: boolean;
}

export interface BatchMoveResult {
  success: boolean;
  results?: Array<{ id: string; name: string; success: boolean; destination?: string; error?: string }>;
  error?: string;
}

// ── Validation ───────────────────────────────────────────────────────────

export class MoveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveValidationError';
  }
}

export function validateMoveParams(params: BatchMoveParams): void {
  const { entity, toProjectId, toProjectName, toFolderId, toFolderName, toInbox } = params;
  const dests = [toProjectId, toProjectName, toFolderId, toFolderName, toInbox].filter(v => v != null);

  if (dests.length === 0) {
    throw new MoveValidationError('Exactly one destination (toProjectId, toProjectName, toFolderId, toFolderName, toInbox) is required.');
  }
  if (dests.length > 1) {
    throw new MoveValidationError('Exactly one destination must be provided — got multiple.');
  }

  // Entity/destination compatibility
  if (entity === 'tasks') {
    if (toFolderId || toFolderName) {
      throw new MoveValidationError('Tasks cannot be moved to folders. Use toProjectId, toProjectName, or toInbox.');
    }
  }
  if (entity === 'projects') {
    if (toProjectId || toProjectName || toInbox) {
      throw new MoveValidationError('Projects cannot be moved to projects or inbox. Use toFolderId or toFolderName.');
    }
  }
}

// ── AppleScript Generation ───────────────────────────────────────────────

export function generateMoveScript(params: BatchMoveParams): string {
  const { ids, entity, toProjectId, toProjectName, toFolderId, toFolderName, toInbox } = params;
  const entityClass = entity === 'tasks' ? 'flattened task' : 'flattened project';

  let s = `use scripting additions

use framework "Foundation"

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

  // ── Destination resolution ─────────────────────────────────────────
  if (toProjectId) {
    const escaped = escapeForAppleScript(toProjectId);
    s += `
      set destItem to a reference to flattened project id "${escaped}"
      set destName to name of destItem
`;
  } else if (toProjectName) {
    const escaped = escapeForAppleScript(toProjectName);
    s += `
      set destProjects to (every flattened project whose name = "${escaped}")
      if (count of destProjects) = 0 then
        return "[{\\"success\\":false,\\"error\\":\\"Project not found: ${escaped}\\"}]"
      end if
      if (count of destProjects) > 1 then
        return "[{\\"success\\":false,\\"error\\":\\"Ambiguous: " & (count of destProjects) & " projects named '${escaped}'\\"}]"
      end if
      set destItem to item 1 of destProjects
      set destName to name of destItem
`;
  } else if (toFolderId) {
    const escaped = escapeForAppleScript(toFolderId);
    s += `
      set destItem to a reference to flattened folder id "${escaped}"
      set destName to name of destItem
`;
  } else if (toFolderName) {
    const escaped = escapeForAppleScript(toFolderName);
    s += `
      set destFolders to (every flattened folder whose name = "${escaped}")
      if (count of destFolders) = 0 then
        return "[{\\"success\\":false,\\"error\\":\\"Folder not found: ${escaped}\\"}]"
      end if
      if (count of destFolders) > 1 then
        return "[{\\"success\\":false,\\"error\\":\\"Ambiguous: " & (count of destFolders) & " folders named '${escaped}'\\"}]"
      end if
      set destItem to item 1 of destFolders
      set destName to name of destItem
`;
  } else if (toInbox) {
    s += `
      set destName to "Inbox"
`;
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
`;

  if (toProjectId || toProjectName) {
    s += `          move {workItem} to end of tasks of destItem\n`;
  } else if (toFolderId || toFolderName) {
    s += `          move {workItem} to end of projects of destItem\n`;
  } else if (toInbox) {
    s += `          move {workItem} to beginning of inbox tasks\n`;
  }

  s += `
          set end of resultItems to "{\\"id\\":\\"" & anId & "\\",\\"name\\":\\"" & my escapeForJSON(itemName) & "\\",\\"success\\":true,\\"destination\\":\\"" & my escapeForJSON(destName) & "\\"}"
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

// ── Execution ────────────────────────────────────────────────────────────

export async function executeBatchMove(params: BatchMoveParams): Promise<BatchMoveResult> {
  let tempFile: string | undefined;

  try {
    validateMoveParams(params);
    const script = generateMoveScript(params);

    console.error(`[batchMove] Executing for ${params.ids.length} ${params.entity}...`);

    tempFile = join(tmpdir(), `batch_move_${Date.now()}.applescript`);
    writeFileSync(tempFile, script);

    const { stdout, stderr } = await execAsync(`osascript "${tempFile}"`);

    try { unlinkSync(tempFile); } catch { /* ignore */ }

    if (stderr) console.error('[batchMove] stderr:', stderr);

    try {
      const results = JSON.parse(stdout);
      const allOk = Array.isArray(results) && results.every((r: any) => r.success);
      return { success: allOk, results };
    } catch {
      return { success: false, error: `Failed to parse result: ${stdout}` };
    }
  } catch (error: any) {
    if (tempFile) { try { unlinkSync(tempFile); } catch { /* ignore */ } }
    if (error instanceof MoveValidationError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: error?.message || 'Unknown error in batchMove' };
  }
}
