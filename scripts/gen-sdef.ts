#!/usr/bin/env npx tsx
/**
 * gen-sdef.ts — Generate OmniFocus FourCC constants from the sdef XML.
 *
 * Reads: docs/omnifocus-applescript-dictionary.sdef
 * Writes: src/generated/omnifocus-sdef.ts
 *
 * Usage:
 *   npx tsx scripts/gen-sdef.ts
 *
 * The sdef (scripting definition) file is the canonical source of Apple Events
 * codes for OmniFocus. This generator extracts class, property, and element
 * codes and writes typed TypeScript const maps that the rest of the codebase
 * can import.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SDEF_PATH = resolve(ROOT, 'docs/omnifocus-applescript-dictionary.sdef');
const OUT_PATH = resolve(ROOT, 'src/generated/omnifocus-sdef.ts');

// ── XML parsing (minimal, regex-based) ─────────────────────────────────────

interface SdefProperty {
  name: string;       // AS name, e.g. "due date"
  code: string;       // FourCC, e.g. "FCDd"
  type?: string;      // e.g. "text", "boolean", "date"
  access?: string;    // "r" if read-only, undefined if read-write
  description?: string;
}

interface SdefElement {
  type: string;       // AS type name, e.g. "flattened task"
  code?: string;      // Resolved class code
}

interface SdefClass {
  name: string;       // AS name, e.g. "task"
  code: string;       // FourCC, e.g. "FCac"
  inherits?: string;  // parent class name
  description?: string;
  properties: SdefProperty[];
  elements: SdefElement[];
}

/**
 * Parse a single <property .../> or <property ...>...</property> tag.
 */
function parseProperty(tag: string): SdefProperty | null {
  const code = attr(tag, 'code');
  const name = attr(tag, 'name');
  if (!code || !name) return null;
  return {
    name,
    code,
    type: attr(tag, 'type') ?? undefined,
    access: attr(tag, 'access') ?? undefined,
    description: attr(tag, 'description') ?? undefined,
  };
}

/**
 * Parse a single <element .../> or <element ...>...</element> tag.
 */
function parseElement(tag: string): SdefElement | null {
  const type = attr(tag, 'type');
  if (!type) return null;
  // Skip hidden/deprecated elements
  if (/hidden="yes"/.test(tag)) return null;
  return { type };
}

/**
 * Extract an XML attribute value from a tag string.
 */
function attr(tag: string, name: string): string | null {
  // Match name="value" or name='value'
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? m[1] : null;
}

/**
 * Parse all <class> and <class-extension> blocks from the sdef XML.
 */
function parseSdef(xml: string): { classes: SdefClass[] } {
  const classes: SdefClass[] = [];

  // Match <class ...>...</class> blocks (including multi-line)
  const classRe = /<class\s+([^>]*)>([\s\S]*?)<\/class>/g;
  let m: RegExpExecArray | null;

  while ((m = classRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const code = attr(`<class ${attrs}>`, 'code');
    const name = attr(`<class ${attrs}>`, 'name');
    if (!code || !name) continue;

    const cls: SdefClass = {
      name,
      code,
      inherits: attr(`<class ${attrs}>`, 'inherits') ?? undefined,
      description: attr(`<class ${attrs}>`, 'description') ?? undefined,
      properties: [],
      elements: [],
    };

    // Extract properties from the class body
    // Match both self-closing and open/close property tags
    const propRe = /<property\s+[^>]*?(?:\/>|>[\s\S]*?<\/property>)/g;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(body)) !== null) {
      const prop = parseProperty(pm[0]);
      if (prop) cls.properties.push(prop);
    }

    // Extract elements
    const elemRe = /<element\s+[^>]*?(?:\/>|>[\s\S]*?<\/element>)/g;
    let em: RegExpExecArray | null;
    while ((em = elemRe.exec(body)) !== null) {
      const elem = parseElement(em[0]);
      if (elem) cls.elements.push(elem);
    }

    // Also check for <contents> tag (used by project for root task)
    const contentsRe = /<contents\s+([^>]*)(?:\/>|>[\s\S]*?<\/contents>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = contentsRe.exec(body)) !== null) {
      const prop = parseProperty(`<property ${cm[1]}/>`);
      if (prop) cls.properties.push(prop);
    }

    classes.push(cls);
  }

  // Also parse <class-extension> blocks (e.g. document extensions)
  const extRe = /<class-extension\s+([^>]*)>([\s\S]*?)<\/class-extension>/g;
  while ((m = extRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const extends_ = attr(`<x ${attrs}>`, 'extends');
    if (!extends_) continue;

    // Find the base class we're extending
    let target = classes.find(c => c.name === extends_);
    if (!target) {
      // Create a synthetic entry for the extension
      const code = attr(`<x ${attrs}>`, 'code') ?? '????';
      target = {
        name: extends_,
        code,
        description: attr(`<x ${attrs}>`, 'description') ?? undefined,
        properties: [],
        elements: [],
      };
      classes.push(target);
    }

    // Add properties and elements from the extension
    const propRe = /<property\s+[^>]*?(?:\/>|>[\s\S]*?<\/property>)/g;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(body)) !== null) {
      const prop = parseProperty(pm[0]);
      if (prop) target.properties.push(prop);
    }

    const elemRe = /<element\s+[^>]*?(?:\/>|>[\s\S]*?<\/element>)/g;
    let em: RegExpExecArray | null;
    while ((em = elemRe.exec(body)) !== null) {
      const elem = parseElement(em[0]);
      if (elem) target.elements.push(elem);
    }
  }

  return { classes };
}

// ── Name normalization ──────────────────────────────────────────────────────

/**
 * Convert an AppleScript name to a camelCase identifier.
 * "due date" → "dueDate", "effectively completed" → "effectivelyCompleted"
 */
function toCamelCase(name: string): string {
  return name
    .split(/\s+/)
    .map((word, i) =>
      i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join('');
}

// ── Code generation ─────────────────────────────────────────────────────────

/** The entity types we care about for the generated output. */
const ENTITY_MAP: Record<string, { constName: string; propConstName: string; description: string }> = {
  'task':              { constName: 'task',             propConstName: 'OFTaskProp',       description: 'task / flattened task' },
  'project':           { constName: 'project',          propConstName: 'OFProjectProp',    description: 'project / flattened project' },
  'folder':            { constName: 'folder',           propConstName: 'OFFolderProp',     description: 'folder / flattened folder' },
  'tag':               { constName: 'tag',              propConstName: 'OFTagProp',        description: 'tag / flattened tag' },
};

const CLASS_ENTRIES: Record<string, { key: string; description: string }> = {
  'document':          { key: 'document',         description: 'Application/document root' },
  'task':              { key: 'task',              description: 'task (individual task object, non-flattened)' },
  'flattened task':    { key: 'flattenedTask',     description: 'flattened task (appears in doc.flattenedTasks)' },
  'project':           { key: 'project',           description: 'project (wrapper around a root task)' },
  'flattened project': { key: 'flattenedProject',  description: 'flattened project (appears in doc.flattenedProjects)' },
  'folder':            { key: 'folder',            description: 'folder' },
  'flattened folder':  { key: 'flattenedFolder',   description: 'flattened folder (appears in doc.flattenedFolders)' },
  'tag':               { key: 'tag',               description: 'tag' },
  'flattened tag':     { key: 'flattenedTag',      description: 'flattened tag (appears in doc.flattenedTags)' },
  'section':           { key: 'section',           description: 'section (folder or project)' },
  'inbox task':        { key: 'inboxTask',         description: 'inbox task (task in document inbox)' },
  'available task':    { key: 'availableTask',     description: 'available task (unblocked and incomplete)' },
  'remaining task':    { key: 'remainingTask',     description: 'remaining task (incomplete but possibly blocked)' },
};

const ELEMENT_ENTRIES: Record<string, { key: string; description: string }> = {
  'flattened task':    { key: 'flattenedTask',     description: 'flattenedTask -- elements of tag, project, folder' },
  'flattened project': { key: 'flattenedProject',  description: 'flattenedProject -- elements of folder' },
  'flattened folder':  { key: 'flattenedFolder',   description: 'flattenedFolder -- elements of folder' },
  'flattened tag':     { key: 'flattenedTag',      description: 'flattenedTag -- elements of tag (child tags)' },
  'tag':               { key: 'tag',               description: 'tag -- elements of task or project' },
  'task':              { key: 'task',               description: 'task -- elements of tag, project, task' },
  'project':           { key: 'project',           description: 'project -- elements of folder, document' },
  'folder':            { key: 'folder',            description: 'folder -- elements of folder, document' },
  'inbox task':        { key: 'inboxTask',         description: 'inboxTask -- elements of document' },
  'available task':    { key: 'availableTask',     description: 'availableTask -- elements of tag, project, task' },
  'remaining task':    { key: 'remainingTask',     description: 'remainingTask -- elements of tag, project, task' },
  'section':           { key: 'section',           description: 'section -- elements of folder, document' },
};

/**
 * Domain-specific aliases.
 *
 * These are properties that the codebase references but which don't map 1:1
 * to sdef property names. They arise because:
 * - Some sdef "elements" (like tags) are used as pseudo-properties in bulk reads
 * - Some sdef properties have generic names (container) but the codebase uses
 *   entity-specific aliases (parentTag, containingFolderId)
 */
const DOMAIN_ALIASES: Record<string, Array<{ key: string; code: string; comment: string }>> = {
  'task': [
    { key: 'tags',  code: 'FCtg', comment: 'tags (element, not property -- returns collection via .tags.name()/.tags.id())' },
  ],
  'project': [
    { key: 'containingFolderId', code: 'FCAr', comment: 'containing folder (alias for folder property -- used for folder relationship traversal)' },
    { key: 'tags',               code: 'FCtg', comment: 'tags (element, not property -- returns collection)' },
  ],
  'tag': [
    { key: 'parentTag', code: 'FCtg', comment: 'parent tag (alias for container property -- tag-specific name for the parent relationship)' },
  ],
};

function generate(classes: SdefClass[]): string {
  // Build class-name→code lookup
  const classCodeMap = new Map<string, string>();
  for (const cls of classes) {
    classCodeMap.set(cls.name, cls.code);
  }

  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * OmniFocus Apple Events FourCC constants.`);
  lines.push(` *`);
  lines.push(` * AUTO-GENERATED from OmniFocus.app sdef via scripts/gen-sdef.ts.`);
  lines.push(` * DO NOT EDIT MANUALLY -- run the generator to update.`);
  lines.push(` *`);
  lines.push(` * Source: docs/omnifocus-applescript-dictionary.sdef`);
  lines.push(` */`);
  lines.push(``);

  // ── OFClass ──────────────────────────────────────────────────────────────

  lines.push(`// -- Class codes ------------------------------------------------------------------`);
  lines.push(``);
  lines.push(`/** Apple Events class codes for OmniFocus entity types. */`);
  lines.push(`export const OFClass = {`);

  for (const [className, entry] of Object.entries(CLASS_ENTRIES)) {
    const code = classCodeMap.get(className);
    if (!code) {
      console.warn(`WARNING: class "${className}" not found in sdef`);
      continue;
    }
    lines.push(`  /** ${entry.description} */`);
    lines.push(`  ${entry.key}: ${quoteFourCC(code)},`);
    lines.push(``);
  }

  lines.push(`} as const satisfies Record<string, string>;`);
  lines.push(``);
  lines.push(`export type OFClassName = keyof typeof OFClass;`);
  lines.push(``);

  // ── OFProp (shared) ──────────────────────────────────────────────────────

  lines.push(`// -- Property codes -- shared -----------------------------------------------------`);
  lines.push(``);
  lines.push(`/** Property codes that appear on multiple entity types. */`);
  lines.push(`export const OFProp = {`);

  // Find properties common to all 4 entity types
  const entityClasses = Object.keys(ENTITY_MAP).map(n => classes.find(c => c.name === n)!).filter(Boolean);
  const sharedProps = findSharedProperties(entityClasses);
  for (const prop of sharedProps) {
    const desc = prop.description ? ` -- ${prop.description}` : '';
    lines.push(`  /** ${toCamelCase(prop.name)}${desc} */`);
    lines.push(`  ${toCamelCase(prop.name)}: ${quoteFourCC(prop.code)},`);
  }

  lines.push(`} as const satisfies Record<string, string>;`);
  lines.push(``);

  // ── Per-entity property maps ──────────────────────────────────────────────

  for (const [className, meta] of Object.entries(ENTITY_MAP)) {
    const cls = classes.find(c => c.name === className);
    if (!cls) {
      console.warn(`WARNING: entity class "${className}" not found in sdef`);
      continue;
    }

    lines.push(`// -- Property codes -- ${meta.description} ${'-'.repeat(Math.max(0, 55 - meta.description.length))}`);
    lines.push(``);
    lines.push(`/** Property codes specific to ${meta.description}. */`);
    lines.push(`export const ${meta.propConstName} = {`);

    // Deduplicate properties by name (sdef can have duplicates from inheritance)
    const seen = new Set<string>();
    for (const prop of cls.properties) {
      const camel = toCamelCase(prop.name);
      if (seen.has(camel)) continue;
      seen.add(camel);
      lines.push(`  /** ${prop.name} */`);
      lines.push(`  ${camel}: ${quoteFourCC(prop.code)},`);
    }

    // Add domain-specific aliases
    const aliases = DOMAIN_ALIASES[className] ?? [];
    for (const alias of aliases) {
      if (seen.has(alias.key)) continue;
      seen.add(alias.key);
      lines.push(`  /** ${alias.comment} */`);
      lines.push(`  ${alias.key}: ${quoteFourCC(alias.code)},`);
    }

    lines.push(`} as const satisfies Record<string, string>;`);
    lines.push(``);
  }

  // ── OFElement ─────────────────────────────────────────────────────────────

  lines.push(`// -- Element class codes -- relationships ------------------------------------------`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * Element class codes used in membership/traversal relationships.`);
  lines.push(` * e.g. Elements(tagRef, OFElement.flattenedTask) -> tasks belonging to that tag.`);
  lines.push(` */`);
  lines.push(`export const OFElement = {`);

  for (const [elemName, entry] of Object.entries(ELEMENT_ENTRIES)) {
    const code = classCodeMap.get(elemName);
    if (!code) {
      console.warn(`WARNING: element class "${elemName}" not found in sdef`);
      continue;
    }
    lines.push(`  /** ${entry.description} */`);
    lines.push(`  ${entry.key}: ${quoteFourCC(code)},`);
    lines.push(``);
  }

  lines.push(`} as const satisfies Record<string, string>;`);
  lines.push(``);

  return lines.join('\n');
}

/**
 * Find properties that appear (by name+code) in all given classes.
 */
function findSharedProperties(classes: SdefClass[]): SdefProperty[] {
  if (classes.length === 0) return [];
  const first = classes[0];
  return first.properties.filter(p =>
    classes.every(c => c.properties.some(cp => cp.name === p.name && cp.code === p.code))
  );
}

/**
 * Quote a FourCC code as a string literal.
 * Preserves trailing spaces (common in Apple Events codes like 'ID  ').
 */
function quoteFourCC(code: string): string {
  return `'${code}'`;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log(`Reading sdef from ${SDEF_PATH}`);
  const xml = readFileSync(SDEF_PATH, 'utf-8');

  const { classes } = parseSdef(xml);
  console.log(`Parsed ${classes.length} classes`);

  // Log entity classes found
  for (const name of Object.keys(ENTITY_MAP)) {
    const cls = classes.find(c => c.name === name);
    if (cls) {
      console.log(`  ${name}: ${cls.code} (${cls.properties.length} properties, ${cls.elements.length} elements)`);
    } else {
      console.log(`  ${name}: NOT FOUND`);
    }
  }

  const output = generate(classes);
  writeFileSync(OUT_PATH, output, 'utf-8');
  console.log(`Wrote ${OUT_PATH}`);
}

main();
