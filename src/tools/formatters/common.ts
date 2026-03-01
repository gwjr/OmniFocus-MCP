/**
 * Common formatting utilities shared across tool output formatters.
 */

/** Compact date: M/D (no year, no time). Null-safe. */
export function compactDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Format estimated minutes as compact duration: 30m, 2h, 1h30m. */
export function compactDuration(minutes: number | null | undefined): string {
  if (!minutes) return '';
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${minutes}m`;
}

/** Project status badge — only shown for non-Active statuses. */
export function statusBadge(status: string | null | undefined): string {
  if (!status || status === 'Active') return '';
  return ` [${status}]`;
}

/** Flag indicator. */
export function flagIndicator(flagged: boolean | undefined): string {
  return flagged ? ' 🚩' : '';
}

/** Due date annotation. */
export function dueAnnotation(dueDate: string | null | undefined): string {
  if (!dueDate) return '';
  return ` [due:${compactDate(dueDate)}]`;
}

/** Build an indented line. */
export function indentLine(depth: number, prefix: string, text: string, indent = '   '): string {
  return `${indent.repeat(depth)}${prefix}${text}\n`;
}
