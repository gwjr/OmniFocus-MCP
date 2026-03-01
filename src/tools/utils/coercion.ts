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
 * If the string isn't valid JSON, it passes through untouched and Zod's
 * normal validation produces the type error.
 */
export function coerceJson<T extends z.ZodTypeAny>(fieldName: string, schema: T) {
  return z.preprocess((val) => {
    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        warnings.push(
          `"${fieldName}" was passed as a JSON-encoded string instead of a JSON object/array. ` +
          `It worked this time, but pass it as structured data directly next time.`
        );
        return parsed;
      } catch {
        return val;
      }
    }
    return val;
  }, schema);
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
