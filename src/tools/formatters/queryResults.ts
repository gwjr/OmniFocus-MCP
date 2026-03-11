/**
 * Entity formatting for query/view result output.
 *
 * Shared between the query tool handler and the view tool handler
 * so both produce consistent markdown-style output.
 */

// ── Date helper ──────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Strip trailing note lines that duplicate link text.
 * Links are appended as paragraphs at the end of the note, so when both
 * `note` and `links` are displayed we'd show the same text twice.
 */
function stripLinkLines(note: string, links: Array<{ text: string }>): string {
  const lines = note.split('\n');
  const remaining = new Map<string, number>();
  for (const l of links) {
    const key = l.text.trim();
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  // Remove from the end while lines match link texts
  while (lines.length > 0) {
    const key = lines[lines.length - 1].trim();
    const count = remaining.get(key);
    if (count && count > 0) {
      remaining.set(key, count - 1);
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join('\n').trimEnd();
}

// ── Per-entity formatters ────────────────────────────────────────────────

export function formatTasks(tasks: any[]): string {
  return tasks.map(task => {
    const parts = [];

    const flag = task.flagged ? ' 🚩' : '';
    parts.push(`☐ ${task.name || 'Unnamed'}${flag}`);

    if (task.id) {
      parts.push(`[${task.id}]`);
    }

    if (task.projectName) {
      parts.push(`(${task.projectName})`);
    }

    if (task.dueDate) {
      parts.push(`[due: ${formatDate(task.dueDate)}]`);
    }
    if (task.deferDate) {
      parts.push(`[defer: ${formatDate(task.deferDate)}]`);
    }
    if (task.plannedDate) {
      parts.push(`[planned: ${formatDate(task.plannedDate)}]`);
    }

    if (task.estimatedMinutes) {
      const hours = task.estimatedMinutes >= 60
        ? `${Math.floor(task.estimatedMinutes / 60)}h`
        : `${task.estimatedMinutes}m`;
      parts.push(`(${hours})`);
    }

    if (task.tagNames?.length > 0) {
      parts.push(`<${task.tagNames.join(',')}>`);
    }

    if (task.taskStatus) {
      parts.push(`#${task.taskStatus.toLowerCase()}`);
    }

    if (task.creationDate) {
      parts.push(`[created: ${formatDate(task.creationDate)}]`);
    }
    if (task.modificationDate) {
      parts.push(`[modified: ${formatDate(task.modificationDate)}]`);
    }
    if (task.completionDate) {
      parts.push(`[completed: ${formatDate(task.completionDate)}]`);
    }

    let result = parts.join(' ');

    if (task.note) {
      const noteText = task.links?.length > 0 ? stripLinkLines(task.note, task.links) : task.note;
      if (noteText) result += `\n  Note: ${noteText}`;
    }

    if (task.links?.length > 0) {
      result += '\n  Links:';
      for (const link of task.links) {
        result += `\n    - [${link.text}](${link.url})`;
      }
    }

    return result;
  }).join('\n');
}

export function formatProjects(projects: any[]): string {
  return projects.map(project => {
    const status = project.status !== 'Active' ? ` [${project.status}]` : '';
    const folder = project.folderName ? ` 📁 ${project.folderName}` : '';
    let taskCountStr = '';
    if (project.activeTaskCount !== undefined && project.taskCount !== undefined) {
      taskCountStr = ` (${project.activeTaskCount}/${project.taskCount} tasks)`;
    } else if (project.taskCount !== undefined && project.taskCount !== null) {
      taskCountStr = ` (${project.taskCount} tasks)`;
    }
    const flagged = project.flagged ? '🚩 ' : '';
    const due = project.dueDate ? ` [due: ${formatDate(project.dueDate)}]` : '';

    let result = `P: ${flagged}${project.name}${status}${due}${folder}${taskCountStr}`;

    if (project.creationDate) {
      result += ` [created: ${formatDate(project.creationDate)}]`;
    }
    if (project.modificationDate) {
      result += ` [modified: ${formatDate(project.modificationDate)}]`;
    }

    if (project.note) {
      const noteText = project.links?.length > 0 ? stripLinkLines(project.note, project.links) : project.note;
      if (noteText) result += `\n  Note: ${noteText}`;
    }

    if (project.links?.length > 0) {
      result += '\n  Links:';
      for (const link of project.links) {
        result += `\n    - [${link.text}](${link.url})`;
      }
    }

    return result;
  }).join('\n');
}

export function formatFolders(folders: any[]): string {
  return folders.map(folder => {
    const projectCount = folder.projectCount !== undefined ? ` (${folder.projectCount} projects)` : '';
    const path = folder.path ? ` 📍 ${folder.path}` : '';

    return `F: ${folder.name}${projectCount}${path}`;
  }).join('\n');
}

export function formatTags(tags: any[]): string {
  return tags.map(tag => {
    const parts = [];

    const parent = tag.parentName ? `${tag.parentName} > ` : '';
    parts.push(`T: ${parent}${tag.name || 'Unnamed'}`);

    if (tag.availableTaskCount !== undefined) {
      parts.push(`(${tag.availableTaskCount} tasks)`);
    }

    if (tag.hidden) {
      parts.push('[On Hold]');
    }

    if (tag.allowsNextAction === false) {
      parts.push('[no next action]');
    }

    if (tag.note) {
      return parts.join(' ') + `\n  Note: ${tag.note}`;
    }

    return parts.join(' ');
  }).join('\n');
}

export function formatPerspectives(perspectives: any[]): string {
  const builtIn = perspectives.filter(p => p.type === 'builtin');
  const custom = perspectives.filter(p => p.type === 'custom');
  let output = '';

  if (builtIn.length > 0) {
    output += '### Built-in\n';
    output += builtIn.map(p => `  ${p.name}`).join('\n');
  }

  if (custom.length > 0) {
    if (builtIn.length > 0) output += '\n\n';
    output += '### Custom\n';
    output += custom.map(p => `  ${p.name}`).join('\n');
  }

  return output;
}

// ── Dispatcher ───────────────────────────────────────────────────────────

/**
 * Format an array of result items for a given entity type.
 * Returns a markdown-style string suitable for tool output.
 */
export function formatItems(items: any[], entity: string): string {
  switch (entity) {
    case 'tasks':        return formatTasks(items);
    case 'projects':     return formatProjects(items);
    case 'folders':      return formatFolders(items);
    case 'tags':         return formatTags(items);
    case 'perspectives': return formatPerspectives(items);
    default:             return '';
  }
}
