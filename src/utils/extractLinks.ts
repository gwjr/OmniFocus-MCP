/**
 * Extract hyperlinks from OmniFocus task/project notes via JXA.
 *
 * Links are stored as `attribute "link"` on rich-text attribute runs.
 * This utility reads them in a single osascript call for the whole batch,
 * grouping consecutive runs with the same URL into one logical link.
 */

import { executeJXA } from './scriptExecution.js';

export interface NoteLink {
  text: string;
  url: string;
}

/**
 * Extract hyperlinks from notes of the given item IDs.
 *
 * Returns a Map from item ID → array of NoteLink (empty array if no links).
 * Items with empty notes or no links are included with [].
 *
 * @param ids    - Array of OmniFocus item IDs
 * @param entity - 'task' or 'project' (singular — maps to flattenedTasks/flattenedProjects)
 */
export async function extractLinks(
  ids: string[],
  entity: 'task' | 'project',
): Promise<Map<string, NoteLink[]>> {
  if (ids.length === 0) return new Map();

  const script = buildExtractLinksScript(ids, entity);
  const raw = await executeJXA(script);

  const result = new Map<string, NoteLink[]>();
  if (!raw || typeof raw !== 'object') return result;

  // raw is { id: [{text, url}, ...], ... }
  const obj = raw as unknown as Record<string, Array<{ text: string; url: string }>>;
  for (const id of ids) {
    result.set(id, obj[id] ?? []);
  }

  return result;
}

/**
 * Build the JXA script for batch link extraction.
 * Exported for unit testing.
 */
export function buildExtractLinksScript(
  ids: string[],
  entity: 'task' | 'project',
): string {
  const collection = entity === 'task' ? 'flattenedTasks' : 'flattenedProjects';
  const idsJson = JSON.stringify(ids);

  return `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var ids = ${idsJson};
  var out = {};
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var links = [];
    try {
      var item = doc.${collection}.byId(id);
      var note = item.note;
      var noteText = note();
      if (noteText && noteText.length > 0) {
        var runs = note.attributeRuns;
        var runCount = runs.length;
        var prevUrl = null;
        var prevIdx = -1;
        for (var j = 0; j < runCount; j++) {
          var url = null;
          try {
            var val = runs[j].style.attributes.byName('link').value();
            if (val && String(val) !== 'null') url = String(val);
          } catch(e) {}
          if (url) {
            if (url === prevUrl && prevIdx >= 0) {
              // Consecutive run with same URL — merge text
              links[prevIdx].text += runs[j].text();
            } else {
              prevIdx = links.length;
              prevUrl = url;
              links.push({ text: runs[j].text(), url: url });
            }
          } else {
            prevUrl = null;
            prevIdx = -1;
          }
        }
      }
      // Trim trailing whitespace from link text (paragraphs include trailing newlines)
      for (var k = 0; k < links.length; k++) {
        links[k].text = links[k].text.replace(/\\s+$/, '');
      }
    } catch(e) {}
    out[id] = links;
  }
  return JSON.stringify(out);
})()`;
}
