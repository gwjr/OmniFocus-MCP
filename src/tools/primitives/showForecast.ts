/**
 * Show Forecast — Replicates OmniFocus Forecast view stats.
 *
 * Three query calls run in parallel:
 *   1. Broad bulk-read of all incomplete tasks (effective dates, flagged, blocked, projectId)
 *   2. Broad bulk-read of all projects (id, status) — to exclude on-hold/dropped
 *   3. Tags entity query for "today" tag's availableTaskCount
 *
 * Node-side filtering excludes blocked tasks and tasks in on-hold/dropped projects,
 * then single-pass bucketing groups remaining tasks into:
 *   Past | Today | day-by-day | Future
 */

import { queryOmnifocus } from './queryOmnifocus.js';
import { toLocalDateKey, formatDayLabel, todayKey, addDays } from '../../utils/dateHelpers.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface ForecastParams {
  days?: number;
}

export interface DayBucket {
  /** 'past', 'future', or YYYY-MM-DD */
  date: string;
  /** Display label: "Past", "Today (Sun 1 Mar)", "Mon 2 Mar", "Future" */
  label: string;
  due: number;
  planned: number;
  deferred: number;
  taskIds: Set<string>;
}

export interface BucketResult {
  buckets: DayBucket[];
  flaggedCount: number;
  totalUniqueTasks: number;
}

export interface ForecastResult {
  success: boolean;
  asOf: string;
  buckets: DayBucket[];
  flaggedCount: number;
  todayTagCount: number | null;
  totalUniqueTasks: number;
  error?: string;
}

// ── Bucketing (pure, exported for testing) ──────────────────────────────

interface TaskRow {
  id: string;
  dueDate: string | null;
  deferDate: string | null;
  plannedDate: string | null;
  flagged: boolean;
}

export function bucketTasks(tasks: TaskRow[], today: string, days: number): BucketResult {
  // Build date range: [today, today+1, ..., today+days-1]
  const dateKeys: string[] = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(addDays(today, i));
  }
  const lastDate = dateKeys[dateKeys.length - 1];

  // Initialise buckets
  const pastBucket: DayBucket = { date: 'past', label: 'Past', due: 0, planned: 0, deferred: 0, taskIds: new Set() };
  const todayBucket: DayBucket = { date: today, label: `Today (${formatDayLabel(today)})`, due: 0, planned: 0, deferred: 0, taskIds: new Set() };
  const dayBuckets: DayBucket[] = dateKeys.slice(1).map(dk => ({
    date: dk, label: formatDayLabel(dk), due: 0, planned: 0, deferred: 0, taskIds: new Set()
  }));
  const futureBucket: DayBucket = { date: 'future', label: 'Future', due: 0, planned: 0, deferred: 0, taskIds: new Set() };

  // O(1) lookup
  const bucketMap = new Map<string, DayBucket>();
  bucketMap.set(today, todayBucket);
  for (const db of dayBuckets) bucketMap.set(db.date, db);

  let flaggedCount = 0;
  const allTaskIds = new Set<string>();

  for (const task of tasks) {
    if (task.flagged) flaggedCount++;
    placeDateInBucket(task.dueDate, 'due', task.id, today, lastDate, pastBucket, futureBucket, bucketMap, allTaskIds);
    placeDateInBucket(task.plannedDate, 'planned', task.id, today, lastDate, pastBucket, futureBucket, bucketMap, allTaskIds);
    placeDateInBucket(task.deferDate, 'deferred', task.id, today, lastDate, pastBucket, futureBucket, bucketMap, allTaskIds);
  }

  return {
    buckets: [pastBucket, todayBucket, ...dayBuckets, futureBucket],
    flaggedCount,
    totalUniqueTasks: allTaskIds.size,
  };
}

function placeDateInBucket(
  dateVal: string | null,
  source: 'due' | 'planned' | 'deferred',
  taskId: string,
  today: string,
  lastDate: string,
  pastBucket: DayBucket,
  futureBucket: DayBucket,
  bucketMap: Map<string, DayBucket>,
  allTaskIds: Set<string>,
): void {
  if (!dateVal) return;
  const dk = toLocalDateKey(dateVal);
  allTaskIds.add(taskId);

  if (dk < today) {
    // Past defer dates just mean "available now" — not overdue
    if (source === 'deferred') return;
    pastBucket[source]++;
    pastBucket.taskIds.add(taskId);
  } else if (dk > lastDate) {
    futureBucket[source]++;
    futureBucket.taskIds.add(taskId);
  } else {
    const bucket = bucketMap.get(dk);
    if (bucket) {
      bucket[source]++;
      bucket.taskIds.add(taskId);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────

export async function showForecast(params: ForecastParams = {}): Promise<ForecastResult> {
  const days = params.days ?? 14;
  const today = todayKey();

  // Three queries in parallel — all on the broad (fast) path
  const [taskResult, projectResult, tagResult] = await Promise.all([
    queryOmnifocus({
      entity: 'tasks',
      select: ['effectiveDueDate', 'effectiveDeferDate', 'effectivePlannedDate', 'flagged', 'effectivelyCompleted', 'effectivelyDropped', 'projectId'],
    }),
    queryOmnifocus({
      entity: 'projects',
      select: ['id', 'status'],
    }),
    queryOmnifocus({
      entity: 'tags',
      where: { eq: [{ var: 'name' }, 'today'] },
      select: ['availableTaskCount'],
    }),
  ]);

  if (!taskResult.success) {
    return { success: false, asOf: today, buckets: [], flaggedCount: 0, todayTagCount: null, totalUniqueTasks: 0, error: taskResult.error };
  }

  // Build set of excluded project IDs (on-hold or dropped)
  const excludedProjectIds = new Set<string>();
  if (projectResult.success && projectResult.items) {
    for (const p of projectResult.items) {
      if (p.status !== 'Active') {
        excludedProjectIds.add(p.id);
      }
    }
  }

  // Filter: exclude effectively completed/dropped and tasks in on-hold projects.
  // Note: blocked tasks are NOT excluded — they still appear in Forecast
  // (a blocked task can be overdue or have a date on a given day).
  const tasks: TaskRow[] = [];
  let idx = 0;
  for (const item of (taskResult.items || [])) {
    if (item.effectivelyCompleted) continue;
    if (item.effectivelyDropped) continue;
    if (item.projectId && excludedProjectIds.has(item.projectId)) continue;
    tasks.push({
      id: String(idx++),
      dueDate: item.effectiveDueDate,
      deferDate: item.effectiveDeferDate,
      plannedDate: item.effectivePlannedDate,
      flagged: item.flagged,
    });
  }

  const { buckets, flaggedCount, totalUniqueTasks } = bucketTasks(tasks, today, days);

  const todayTagCount = tagResult.success && tagResult.items?.length
    ? (tagResult.items[0].availableTaskCount as number ?? null)
    : null;

  return { success: true, asOf: today, buckets, flaggedCount, todayTagCount, totalUniqueTasks };
}
