/**
 * Write hyperlinks to OmniFocus task/project notes via JXA.
 *
 * Appends linked paragraphs to the end of the note. Each link becomes a
 * new paragraph with the link text, and the "link" style attribute set
 * to the URL.
 *
 * Preserves existing links: reads current links before writing, then
 * rewrites all (existing + new) after the plain-text note set.
 */

import { executeJXA } from './scriptExecution.js';

export interface LinkToAdd {
  text: string;
  url: string;
}

/**
 * Append hyperlinks to the notes of the given items.
 *
 * Each link becomes a new paragraph at the end of the note. If the note
 * is empty, the first link's text becomes the note content.
 *
 * Existing links in the note are preserved: the script reads them first,
 * then reconstructs all links (old + new) after setting the note text.
 *
 * @param items  - Array of { id, links } to write
 * @param entity - 'task' or 'project' (singular)
 */
export async function writeLinks(
  items: Array<{ id: string; links: LinkToAdd[] }>,
  entity: 'task' | 'project',
): Promise<void> {
  if (items.length === 0) return;
  // Filter out items with no links to add
  const filtered = items.filter(item => item.links.length > 0);
  if (filtered.length === 0) return;

  const script = buildWriteLinksScript(filtered, entity);
  await executeJXA(script);
}

/**
 * Build the JXA script that appends linked paragraphs.
 * Exported for unit testing.
 */
export function buildWriteLinksScript(
  items: Array<{ id: string; links: LinkToAdd[] }>,
  entity: 'task' | 'project',
): string {
  const collection = entity === 'task' ? 'flattenedTasks' : 'flattenedProjects';
  const itemsJson = JSON.stringify(items);

  // Strategy:
  //   1. Read existing links (paragraph index → url) before any modification
  //   2. Build full text: existing note + new link paragraphs
  //   3. Set note text once (destroys all rich text attributes)
  //   4. Re-apply existing link attributes on their original paragraphs
  //   5. Apply new link attributes on the appended paragraphs
  return `(function() {
  var app = Application('OmniFocus');
  var doc = app.defaultDocument;
  var items = ${itemsJson};
  for (var i = 0; i < items.length; i++) {
    var id = items[i].id;
    var newLinks = items[i].links;
    if (newLinks.length === 0) continue;
    try {
      var item = doc.${collection}.byId(id);
      var currentNote = item.note() || '';
      var baseParagraphs = 0;
      // Step 1: read existing links (paragraph index → url)
      var existingLinks = [];
      if (currentNote.length > 0) {
        var note = item.note;
        baseParagraphs = note.paragraphs.length;
        for (var p = 0; p < baseParagraphs; p++) {
          try {
            var val = note.paragraphs[p].style.attributes.byName('link').value();
            if (val && String(val) !== 'null') {
              existingLinks.push({ idx: p, url: String(val) });
            }
          } catch(e) {}
        }
      }
      // Step 2: build full text with new link paragraphs appended
      var suffix = '';
      for (var j = 0; j < newLinks.length; j++) {
        suffix += (currentNote.length === 0 && j === 0 ? '' : '\\n') + newLinks[j].text;
      }
      // Step 3: set note text once (plain text — destroys all attributes)
      item.note = currentNote + suffix;
      // Step 4: re-apply existing link attributes
      var note = item.note;
      for (var k = 0; k < existingLinks.length; k++) {
        try {
          note.paragraphs[existingLinks[k].idx].style.attributes.byName('link').value = existingLinks[k].url;
        } catch(e) {}
      }
      // Step 5: apply new link attributes on appended paragraphs
      for (var j = 0; j < newLinks.length; j++) {
        var paraIdx = baseParagraphs + j;
        note.paragraphs[paraIdx].style.attributes.byName('link').value = newLinks[j].url;
      }
    } catch(e) {}
  }
  return JSON.stringify(true);
})()`;
}
