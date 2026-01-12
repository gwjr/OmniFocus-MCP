/**
 * Utility functions for escaping strings for use in AppleScript
 */

/**
 * Escape a string for safe use in AppleScript double-quoted strings.
 *
 * AppleScript string literals use double quotes, and within them:
 * - \" escapes a double quote
 * - \\ escapes a backslash
 * - \n, \r, \t are interpreted as control characters
 *
 * This function ensures all special characters are properly escaped.
 *
 * @param str - The string to escape (can be null/undefined)
 * @returns The escaped string, or empty string if input was null/undefined
 */
export function escapeForAppleScript(str: string | null | undefined): string {
  if (!str) return '';

  return str
    // Escape backslashes first (must be before other escapes that use backslash)
    .replace(/\\/g, '\\\\')
    // Escape double quotes
    .replace(/"/g, '\\"')
    // Escape newlines
    .replace(/\n/g, '\\n')
    // Escape carriage returns
    .replace(/\r/g, '\\r')
    // Escape tabs
    .replace(/\t/g, '\\t');
}

/**
 * Legacy escaping function for backwards compatibility.
 * Matches the original escaping pattern used in the codebase.
 *
 * @deprecated Use escapeForAppleScript instead for more complete escaping
 */
export function legacyEscape(str: string | null | undefined): string {
  if (!str) return '';
  return str.replace(/['"\\]/g, '\\$&');
}
