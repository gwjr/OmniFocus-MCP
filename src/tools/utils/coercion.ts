import { z } from 'zod';

/**
 * Module-scoped warnings buffer. Safe because stdio transport is single-threaded.
 */
const warnings: string[] = [];

/**
 * Wraps a Zod schema to accept JSON-encoded strings and coerce them to the
 * expected type. When coercion happens, a warning is recorded so the handler
 * can include it in the response.
 *
 * Handles three cases for string inputs:
 * 1. Valid JSON string → parse + mild warning
 * 2. JS object literal (unquoted keys, single quotes, trailing commas) → fix + stronger warning
 * 3. Neither → warning + pass-through (Zod or compiler will error)
 */
export function coerceJson<T extends z.ZodTypeAny>(fieldName: string, schema: T) {
  return z.preprocess((val) => {
    if (typeof val === 'string') {
      // Try standard JSON parse
      try {
        const parsed = JSON.parse(val);
        warnings.push(
          `"${fieldName}" was passed as a JSON-encoded string instead of a JSON object/array. ` +
          `It worked this time, but pass it as structured data directly next time.`
        );
        return parsed;
      } catch {
        // JSON.parse failed — try JS object literal fixup
      }

      // Try fixing common JS-to-JSON differences
      const fixed = tryFixJsLiteral(val);
      if (fixed !== null) {
        warnings.push(
          `"${fieldName}" was passed as a JavaScript object literal string, not valid JSON. ` +
          `It was auto-corrected this time, but pass it as structured JSON data directly.`
        );
        return fixed;
      }

      // Neither worked — warn and pass through (Zod or compiler will error)
      warnings.push(
        `"${fieldName}" was passed as a string that isn't valid JSON. ` +
        `Pass it as structured JSON data directly.`
      );
      return val;
    }
    return val;
  }, schema);
}

/**
 * Attempt to fix common JS object literal differences from JSON:
 * - Unquoted keys: {and: [...]} → {"and": [...]}
 * - Single-quoted strings: {'and': [...]} → {"and": [...]}
 * - Trailing commas: [1, 2,] → [1, 2]
 *
 * Returns the parsed value on success, or null if it still can't be parsed.
 */
export function tryFixJsLiteral(val: string): unknown | null {
  let fixed = val;

  // Replace single-quoted strings with double-quoted
  // Match 'text' but not inside double quotes — simple approach: replace all
  fixed = fixed.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');

  // Quote unquoted keys: {and: or ,and: → {"and":
  // Anchors on { or , preceding the key (word chars before colon)
  fixed = fixed.replace(/([\{,]\s*)(\w+)\s*:/g, '$1"$2":');

  // Strip trailing commas before ] and }
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

/**
 * Returns any coercion warnings accumulated since the last call, then clears
 * the buffer.
 */
export function getCoercionWarnings(): string[] {
  const result = [...warnings];
  warnings.length = 0;
  return result;
}

/**
 * If there are coercion warnings, appends them to a response text string.
 */
export function appendCoercionWarnings(text: string): string {
  const w = getCoercionWarnings();
  if (w.length === 0) return text;
  return text + '\n\n' + w.map(msg => `⚠️ ${msg}`).join('\n');
}
