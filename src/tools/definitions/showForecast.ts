import { z } from 'zod';
import { showForecast, type ForecastResult } from '../primitives/showForecast.js';

export const schema = z.object({
  days: z.number().int().min(1).max(90).optional().describe(
    "Number of days ahead to show (default: 14, max: 90)"
  ),
});

export async function handler(args: z.infer<typeof schema>, extra: any) {
  try {
    const result = await showForecast({ days: args.days });

    if (!result.success) {
      return {
        content: [{
          type: "text" as const,
          text: `Forecast failed: ${result.error}`
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: formatForecast(result),
      }],
    };
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Error generating forecast: ${error.message}`);
    return {
      content: [{
        type: "text" as const,
        text: `Error generating forecast: ${error.message}`
      }],
      isError: true,
    };
  }
}

// ── Formatting ──────────────────────────────────────────────────────────

function formatForecast(result: ForecastResult): string {
  const { buckets, flaggedCount, todayTagCount } = result;

  // Header
  const todayBucket = buckets.find(b => b.label.startsWith('Today'));
  const dateLabel = todayBucket ? todayBucket.label.replace('Today (', '').replace(')', '') : '';
  let out = `OmniFocus Forecast — ${dateLabel}\n\n`;

  // Column widths
  const labelW = Math.max(20, ...buckets.map(b => b.label.length + 2));
  const numW = 6;

  out += pad('', labelW) + pad('Due', numW) + pad('Plan', numW) + pad('Defer', numW) + 'Tasks\n';
  out += '─'.repeat(labelW + numW * 3 + 6) + '\n';

  for (const b of buckets) {
    const tasks = b.taskIds.size;
    let row = pad(b.label, labelW);
    row += pad(fmt(b.due), numW);
    row += pad(fmt(b.planned), numW);
    row += pad(fmt(b.deferred), numW);
    row += fmt(tasks);

    // Today extras
    if (b.label.startsWith('Today')) {
      const extras: string[] = [];
      if (flaggedCount > 0) extras.push(`${flaggedCount} flagged`);
      if (todayTagCount != null && todayTagCount > 0) extras.push(`${todayTagCount} tagged "today"`);
      if (extras.length > 0) row += `  (+ ${extras.join(', ')})`;
    }

    out += row + '\n';
  }

  return out;
}

function fmt(n: number): string {
  return n > 0 ? String(n) : '-';
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}
