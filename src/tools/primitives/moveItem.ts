import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { escapeForAppleScript } from '../../utils/applescriptEscaping.js';
const execAsync = promisify(exec);

export interface MoveItemParams {
  id?: string;
  name?: string;
  itemType: 'task' | 'project';

  // Task destinations (provide one)
  toProjectName?: string;
  toProjectId?: string;
  toInbox?: boolean;

  // Project destinations
  toFolderName?: string;
}

function generateAppleScript(params: MoveItemParams): string {
  const id = escapeForAppleScript(params.id);
  const name = escapeForAppleScript(params.name);
  const itemType = params.itemType;

  if (!id && !name) {
    return `return "{\\\"success\\\":false,\\\"error\\\":\\\"Either id or name must be provided\\\"}"`;
  }

  let script = `use scripting additions

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
    tell front document
      -- Find the item to move
      set foundItem to missing value
`;

  // Find item by ID (then fallback to name)
  if (itemType === 'task') {
    if (id) {
      script += `
      -- Try to find task by ID
      repeat with aTask in (flattened tasks)
        if (id of aTask as string) = "${id}" then
          set foundItem to contents of aTask
          exit repeat
        end if
      end repeat

      -- If not found in projects, search in inbox
      if foundItem is missing value then
        repeat with aTask in (inbox tasks)
          if (id of aTask as string) = "${id}" then
            set foundItem to contents of aTask
            exit repeat
          end if
        end repeat
      end if
`;
    }
    if (name && !id) {
      script += `
      -- Find task by name
      repeat with aTask in (flattened tasks)
        if (name of aTask) = "${name}" then
          set foundItem to contents of aTask
          exit repeat
        end if
      end repeat

      if foundItem is missing value then
        repeat with aTask in (inbox tasks)
          if (name of aTask) = "${name}" then
            set foundItem to contents of aTask
            exit repeat
          end if
        end repeat
      end if
`;
    } else if (name && id) {
      script += `
      -- Fallback to name if ID search failed
      if foundItem is missing value then
        repeat with aTask in (flattened tasks)
          if (name of aTask) = "${name}" then
            set foundItem to contents of aTask
            exit repeat
          end if
        end repeat

        if foundItem is missing value then
          repeat with aTask in (inbox tasks)
            if (name of aTask) = "${name}" then
              set foundItem to contents of aTask
              exit repeat
            end if
          end repeat
        end if
      end if
`;
    }
  } else {
    // project
    if (id) {
      script += `
      -- Try to find project by ID
      repeat with aProject in (flattened projects)
        if (id of aProject as string) = "${id}" then
          set foundItem to contents of aProject
          exit repeat
        end if
      end repeat
`;
    }
    if (name && !id) {
      script += `
      -- Find project by name
      repeat with aProject in (flattened projects)
        if (name of aProject) = "${name}" then
          set foundItem to contents of aProject
          exit repeat
        end if
      end repeat
`;
    } else if (name && id) {
      script += `
      -- Fallback to name if ID search failed
      if foundItem is missing value then
        repeat with aProject in (flattened projects)
          if (name of aProject) = "${name}" then
            set foundItem to contents of aProject
            exit repeat
          end if
        end repeat
      end if
`;
    }
  }

  // Check that item was found
  script += `
      if foundItem is missing value then
        return "{\\\"success\\\":false,\\\"error\\\":\\\"Item not found\\\"}"
      end if

      set itemName to name of foundItem
      set itemId to id of foundItem as string
`;

  // Perform the move based on item type and destination
  if (itemType === 'task') {
    if (params.toInbox) {
      script += `
      -- Move task to inbox
      move {foundItem} to beginning of inbox tasks
      set destDesc to "inbox"
`;
    } else if (params.toProjectId) {
      const destId = escapeForAppleScript(params.toProjectId);
      script += `
      -- Find destination project by ID
      set destProject to missing value
      repeat with aProject in (flattened projects)
        if (id of aProject as string) = "${destId}" then
          set destProject to contents of aProject
          exit repeat
        end if
      end repeat

      if destProject is missing value then
        return "{\\\"success\\\":false,\\\"error\\\":\\\"Destination project not found with ID: ${destId}\\\"}"
      end if

      move {foundItem} to end of tasks of destProject
      set destDesc to name of destProject
`;
    } else if (params.toProjectName) {
      const destName = escapeForAppleScript(params.toProjectName);
      script += `
      -- Find destination project by name
      set destProject to missing value
      repeat with aProject in (flattened projects)
        if (name of aProject) = "${destName}" then
          set destProject to contents of aProject
          exit repeat
        end if
      end repeat

      if destProject is missing value then
        return "{\\\"success\\\":false,\\\"error\\\":\\\"Destination project not found: ${destName}\\\"}"
      end if

      move {foundItem} to end of tasks of destProject
      set destDesc to name of destProject
`;
    } else {
      script += `
      return "{\\\"success\\\":false,\\\"error\\\":\\\"No destination specified. Provide toProjectName, toProjectId, or toInbox for tasks.\\\"}"
`;
    }
  } else {
    // project -> folder
    if (params.toFolderName) {
      const folderName = escapeForAppleScript(params.toFolderName);
      script += `
      -- Find destination folder by name
      set destFolder to missing value
      try
        set destFolder to first flattened folder where name = "${folderName}"
      end try

      if destFolder is missing value then
        return "{\\\"success\\\":false,\\\"error\\\":\\\"Destination folder not found: ${folderName}\\\"}"
      end if

      move {foundItem} to end of projects of destFolder
      set destDesc to name of destFolder
`;
    } else {
      script += `
      return "{\\\"success\\\":false,\\\"error\\\":\\\"No destination specified. Provide toFolderName for projects.\\\"}"
`;
    }
  }

  // Return success
  script += `
      return "{\\\"success\\\":true,\\\"id\\\":\\"" & itemId & "\\",\\\"name\\\":\\"" & my escapeForJSON(itemName) & "\\",\\\"destination\\\":\\"" & my escapeForJSON(destDesc) & "\\"}"
    end tell
  end tell
on error errorMessage
  return "{\\\"success\\\":false,\\\"error\\\":\\"" & my escapeForJSON(errorMessage) & "\\"}"
end try
`;

  return script;
}

export async function moveItem(params: MoveItemParams): Promise<{
  success: boolean;
  id?: string;
  name?: string;
  destination?: string;
  error?: string;
}> {
  let tempFile: string | undefined;

  try {
    const script = generateAppleScript(params);

    console.error("Executing AppleScript for move_item...");
    console.error(`Item type: ${params.itemType}, ID: ${params.id || 'not provided'}, Name: ${params.name || 'not provided'}`);

    tempFile = join(tmpdir(), `move_omnifocus_${Date.now()}.applescript`);
    writeFileSync(tempFile, script);

    const { stdout, stderr } = await execAsync(`osascript "${tempFile}"`);

    try { unlinkSync(tempFile); } catch { /* ignore */ }

    if (stderr) {
      console.error("AppleScript stderr:", stderr);
    }

    console.error("AppleScript stdout:", stdout);

    try {
      const result = JSON.parse(stdout);
      return {
        success: result.success,
        id: result.id,
        name: result.name,
        destination: result.destination,
        error: result.error,
      };
    } catch (parseError) {
      console.error("Error parsing AppleScript result:", parseError);
      return { success: false, error: `Failed to parse result: ${stdout}` };
    }
  } catch (error: any) {
    if (tempFile) {
      try { unlinkSync(tempFile); } catch { /* ignore */ }
    }
    console.error("Error in moveItem execution:", error);
    return { success: false, error: error?.message || "Unknown error in moveItem" };
  }
}
