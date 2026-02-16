# OmniFocus MCP Server — UX Test Cases

Generated 2026-02-11 by four simulated expert personas. All scenarios are **non-destructive** (no deleting items, no dropping projects, no completing things that shouldn't be completed). Write operations are limited to adding tasks/projects, flagging, editing dates, and setting project status to on-hold.

---

## How to Use This Document

Each test case describes a realistic request a user might type verbatim into an AI assistant connected to the OmniFocus MCP server. To evaluate ergonomics:

1. **Can the AI accomplish it at all?** Some scenarios expose missing tools or fields.
2. **How many round-trips does it take?** N+1 query patterns are a recurring concern.
3. **Does the AI reason correctly about the results?** Many scenarios require client-side deduplication, aggregation, or date arithmetic.
4. **Is the output useful?** Raw data dumps vs. synthesised briefings.
5. **Does it feel natural?** Would a user be satisfied with the interaction, or would they have been faster in the native app?

---

## A. GTD Expert Scenarios

### A1. Stuck Project Audit

> "Do a stuck-project audit for my weekly review. Find all active projects that either have no available next actions, or where every task is blocked or deferred. For each one, show me the project name, folder, when it was last modified, and how many tasks it has. Sort by oldest-modified first."

**Expected tool sequence:**

1. `query_omnifocus` — entity: projects, filters: `{ status: ["Active"] }`, fields: [id, name, folderName, modificationDate, activeTaskCount, taskCount], sortBy: modificationDate, sortOrder: asc
2. For each project: `query_omnifocus` — entity: tasks, filters: `{ projectId: "<id>", status: ["Available", "Next"] }`, summary: true
3. Report projects where step 2 returns count 0

**Ergonomic pressure points:**

- N+1 query pattern: one query per project to check for available actions. A database with 40+ active projects means 40+ follow-up calls.
- No composite filter like `hasAvailableActions` on the project entity.
- Cannot distinguish "stuck because all deferred" from "stuck because all blocked" from "stuck because empty" without pulling the full task list per project.

---

### A2. Horizons of Focus Integrity Check

> "I use top-level folders as my Areas of Responsibility: Work, Family, Health, Finances, Home, and Creative. Tell me: (1) which active projects are NOT inside any of those folders, and (2) which of those six areas has no active projects at all right now."

**Expected tool sequence:**

1. `query_omnifocus` — entity: folders, fields: [id, name, path, subfolders, parentFolderID]
2. `query_omnifocus` — entity: projects, filters: `{ status: ["Active"] }`, fields: [id, name, folderName, folderID]
3. AI builds folder ancestry tree from step 1, resolves each project's root folder, computes two set-differences

**Ergonomic pressure points:**

- `folderName` on projects returns only the immediate parent, not the root ancestor. A project in "Work > Legal > Litigation" reports folderName as "Litigation", not "Work".
- The AI must reconstruct the folder hierarchy from `parentFolderID` fields to determine root ancestry.
- No `folderPath` field on projects would collapse this to a simple string-prefix check.

---

### A3. Context-Based Time Blocking

> "I have 4 hours of free time today. Look at my tasks tagged 'Office' or 'Computer' that are available and have estimated durations. Build me a proposed action list that fits within 4 hours, prioritising anything flagged or due soon."

**Expected tool sequence:**

1. `query_omnifocus` — entity: tasks, filters: `{ tags: ["Office", "Computer"], status: ["Available", "Next", "DueSoon", "Overdue"], flagged: true }`, fields: [id, name, projectName, estimatedMinutes, dueDate, flagged, tagNames], sortBy: dueDate
2. `query_omnifocus` — same but `flagged: false`
3. AI merges results (flagged first), filters out tasks without estimatedMinutes, greedily packs into 240-minute budget

**Ergonomic pressure points:**

- Cannot combine flagged-priority sorting with due-date sorting in a single query. Requires two queries and client-side merge.
- Tasks without `estimatedMinutes` are common — the AI must decide whether to skip them, treat as zero, or warn.
- No multi-field sort or priority-score sort.

---

### A4. Deferred-Item Runway

> "Show me everything that's currently deferred but will become available in the next 7 days. Group the results by the date they become available."

**Expected tool sequence:**

1. `query_omnifocus` — entity: tasks, filters: `{ deferredUntil: 7 }`, fields: [id, name, projectName, tagNames, deferDate, effectiveDeferDate], sortBy: deferDate, sortOrder: asc
2. AI groups results by effectiveDeferDate (date-only, truncating any time component)

**Ergonomic pressure points:**

- `deferredUntil` semantics are ambiguous: does day 0 = today or tomorrow? Does it include items whose defer date is today (which may already be available)?
- Grouping is entirely client-side — no server-side GROUP BY.
- Date strings may include time components requiring truncation for day-level bucketing.

---

### A5. Inbox-Zero Processing Dry Run

> "Pull everything from my inbox, then look at my existing active projects and tag list. For each inbox item, suggest which project it belongs to, what tags apply, and whether it's a 'do now', 'schedule', 'delegate', or 'defer' action. Don't change anything — just give me the analysis."

**Expected tool sequence:**

1. `query_omnifocus` — entity: tasks, filters: `{ projectName: "inbox" }`, fields: [id, name, note]
2. `query_omnifocus` — entity: projects, filters: `{ status: ["Active"] }`, fields: [id, name, folderName]
3. No `list_tags` tool exists — must extract tags from tasks: `query_omnifocus` — entity: tasks, fields: [tagNames], then deduplicate client-side (expensive)
4. AI performs semantic matching between inbox item names and project/tag vocabulary

**Ergonomic pressure points:**

- **No `list_tags` tool.** The only way to discover existing tags is to query tasks and extract `tagNames`, potentially pulling thousands of records.
- The classification task is pure AI reasoning — tests whether the tool set provides enough reference data efficiently.
- Tests whether the AI respects read-only intent when it has write tools available.

---

## B. OmniFocus Power User Scenarios

### B1. Realistic Daily Availability Check

> "Look at my Forecast perspective and cross-reference it with my custom 'Today' perspective. Check if any tasks due today are blocked in sequential projects. For anything actually available and due today, tell me the total estimated time and whether it fits in 8 hours. If it doesn't, flag the overdue or due-soonest tasks."

**Expected tool sequence:**

1. `get_perspective_view` — perspectiveName: "Forecast"
2. `get_perspective_view` — perspectiveName: "Today"
3. `query_omnifocus` — entity: tasks, filters: `{ status: ["Blocked"], dueWithin: 1 }`, fields: [id, name, projectName, projectId, taskStatus, dueDate, estimatedMinutes]
4. `query_omnifocus` — entity: projects, filters: `{ status: ["Active"] }`, fields: [id, name, sequential]
5. `query_omnifocus` — entity: tasks, filters: `{ status: ["Available", "DueSoon", "Overdue"], dueWithin: 1 }`, fields: [id, name, estimatedMinutes, dueDate, flagged, tagNames, projectName]
6. Conditional `edit_item` calls to flag highest-priority items if total > 480 minutes

**Ergonomic pressure points:**

- Must reconcile two perspectives whose filter rules cannot be inspected via the API.
- Understanding sequential-project blocking requires joining task data against project data.
- Conditional writes require judgment, not rote execution.
- Null `estimatedMinutes` handling.

---

### B2. Hierarchical Project Scaffolding with Action Groups

> "Create a sequential project 'Annual Compliance Filing' in 'Work — Legal'. Build three sequential action groups — 'Gather Documents' (3 subtasks), 'Prepare Draft' (3 subtasks), 'Review Cycle' (3 subtasks). Defer the project to March 1st. Final subtask due April 15th. Tag everything 'Compliance'. Estimate 30/60/45 min per group respectively."

**Expected tool sequence:**

1. `add_project` — name, folder, sequential, deferDate, tags
2. `batch_add_items` — 3 parent tasks (action groups) with tempIds + 9 subtasks referencing parentTempIds, with per-task estimatedMinutes and the last subtask having dueDate

**Ergonomic pressure points:**

- Two levels of nesting (project > action group > subtask) via `tempId`/`parentTempId`.
- **No `sequential` property on tasks/action groups** — only projects have it. In OmniFocus, action groups have their own sequential/parallel setting. This is a missing capability.
- User specified dates only where needed (project defer, last subtask due) — AI must not naively apply dates to every item.
- Project name in `batch_add_items` must exactly match the name from step 1.

---

### B3. Stale Project Audit with Conditional Status Change

> "Find all active projects with no task completed in the last 30 days. For each, tell me remaining tasks, whether the next action is blocked/deferred, most recent modification date, and upcoming due dates within 2 weeks. If any project has zero remaining tasks, put it on hold."

**Expected tool sequence:**

1. `query_omnifocus` — entity: projects, filters: `{ status: ["Active"] }`, fields: [id, name, status, taskCount, activeTaskCount, modificationDate, dueDate, folderName]
2. Per project: `query_omnifocus` — entity: tasks, filters: `{ projectId: "<id>" }`, includeCompleted: true, fields: [id, name, taskStatus, completionDate, deferDate, dueDate], sortBy: modificationDate, sortOrder: desc
3. `query_omnifocus` — entity: tasks, filters: `{ dueWithin: 14 }`, fields: [id, projectName, dueDate]
4. `edit_item` calls for empty projects — newProjectStatus: "onHold"

**Ergonomic pressure points:**

- N+1 query pattern for per-project completion history.
- **`includeCompleted` defaults to false** — forgetting this silently omits all completion data, making the audit useless.
- `modificationDate` on the project is a red herring for "staleness" — need `completionDate` on child tasks.
- Edge case: `activeTaskCount == 0` could mean "all completed" (should mark complete, not on-hold) or "all dropped" — AI must reason about the distinction.

---

### B4. Weekly Workload Rebalancing by Energy Tags

> "I use tags 'Deep Work', 'Shallow Work', and 'Errand'. Show me how available unflagged tasks break down by these tags. Check my planned tasks for this week — identify any day over 4 hours total or over 3 hours of Deep Work. Redistribute Shallow Work and Errands from overloaded days to lighter ones."

**Expected tool sequence:**

1. `query_omnifocus` — entity: tasks, filters: `{ status: ["Available"], flagged: false, tags: ["Deep Work"] }`, fields: [id, name, estimatedMinutes, plannedDate, projectName, tagNames]
2. Same for "Shallow Work"
3. Same for "Errand"
4. `query_omnifocus` — entity: tasks, filters: `{ plannedWithin: 5 }`, fields: [id, name, estimatedMinutes, plannedDate, tagNames]
5. AI performs constraint-satisfaction reasoning
6. Multiple `edit_item` calls — newPlannedDate for each rebalanced task

**Ergonomic pressure points:**

- `tags` filter is OR-only — separate queries needed per tag for bucketing.
- `plannedWithin` is forward-only from today, not calendar-week-aware. If today is Wednesday, "this week" includes Monday and Tuesday which the filter can't reach.
- Constraint satisfaction with null estimates.
- **No `batch_edit_items`** — each date change is a separate `edit_item` call (potentially 10-20 calls).

---

### B5. Perspective vs. Query Discrepancy Audit

> "I have custom perspectives 'Waiting For' and 'This Week'. For each, pull the perspective view AND run the equivalent raw query. Tell me about any discrepancies. Also check my 'Review' perspective and tell me how many projects are due for review."

**Expected tool sequence:**

1. `get_perspective_view` — "Waiting For" + `query_omnifocus` with `tags: ["Waiting"]`
2. `get_perspective_view` — "This Week" + `query_omnifocus` with `dueWithin: 7` + `query_omnifocus` with `plannedWithin: 7` (union for OR semantics)
3. `get_perspective_view` — "Review"
4. Set-difference comparisons on each pair

**Ergonomic pressure points:**

- **Custom perspective rules cannot be inspected** — only their output. The AI can approximate but not replicate arbitrary filter logic.
- `dueWithin` and `plannedWithin` combine with AND in a single query, but the perspective likely uses OR. Must union two separate queries.
- **No review-cycle fields** (`nextReviewDate`, `reviewInterval`) are exposed. The Review perspective's output is visible but the underlying review metadata is opaque.

---

## C. Barrister Scenarios

### C1. Weekly Triage Briefing Across All Cases

> "Give me a triage report. Everything overdue, everything due in the next 7 days, and anything flagged. Group by case. For any case with 3 or more items due this week, flag the project itself."

**Expected tool sequence:**

1. `query_omnifocus` — filters: `{ status: ["Overdue"] }`, fields: [id, name, dueDate, projectName, projectId, tagNames, flagged]
2. `query_omnifocus` — filters: `{ dueWithin: 7 }`, fields: same
3. `query_omnifocus` — filters: `{ flagged: true }`, fields: same
4. AI deduplicates across the three overlapping result sets, groups by project, counts
5. `query_omnifocus` — entity: projects, filters: `{ status: ["Active"] }`, fields: [id, name, flagged]
6. `edit_item` calls to flag qualifying unflagged projects

**Ergonomic pressure points:**

- Deduplication across three queries with overlapping results (an overdue flagged task appears in all three).
- Project name from task results must be matched to project ID from project query — partial-name matching can cause mismatches (e.g. "R v Smith [2025]" vs "R v Smith [2025] — Murder").
- The AI should synthesise ("the Henderson matter has 4 overdue tasks — this project is in trouble") rather than dump raw data.

---

### C2. Court Deadline Cascade — Trial Date Moved

> "The Smith murder trial has been moved from 14 April to 28 April. Push back every task in 'R v Smith — Trial Prep' by 14 days — but only tasks with a due date, and don't touch completed ones. Also shift defer dates if present. Add a task 'Notify solicitors of new trial date' due tomorrow, flagged."

**Expected tool sequence:**

1. `query_omnifocus` — entity: projects, filters: `{ projectName: "R v Smith" }` — find exact project
2. `query_omnifocus` — entity: tasks, filters: `{ projectId: "<id>" }`, fields: [id, name, dueDate, deferDate, taskStatus]
3. AI filters: exclude completed/dropped, exclude tasks with no dueDate
4. Multiple `edit_item` calls — newDueDate: existing + 14 days, newDeferDate: existing + 14 days (if present)
5. `add_omnifocus_task` — "Notify solicitors of new trial date", due tomorrow, flagged

**Ergonomic pressure points:**

- **No `batch_edit_items`** — a trial prep project with 30-50 tasks means 30-50 serial `edit_item` calls. This is the single biggest ergonomic gap for this use case.
- Date arithmetic is entirely client-side. Timezone handling could shift dates by a day if the AI naively converts to UTC.
- Partial project name match may return multiple "R v Smith" projects — AI must disambiguate or ask.
- `includeCompleted` defaults to false, which is helpful here — but the AI should understand the default rather than redundantly filtering.

---

### C3. Cross-Case Waiting-On Audit

> "Show me every task tagged 'Waiting' or 'Waiting On Solicitor'. For each, tell me the project, how long it's been waiting, and whether the project has a due date within 30 days. If anything has been waiting over 21 days AND is in a project due within 30 days, create a chase task in that project due in 3 days, tagged 'Phone' and 'Urgent'."

**Expected tool sequence:**

1. `query_omnifocus` — entity: tasks, filters: `{ tags: ["Waiting", "Waiting On Solicitor"] }`, fields: [id, name, projectName, projectId, deferDate, creationDate, tagNames]
2. `query_omnifocus` — entity: projects, filters: `{ dueWithin: 30 }`, fields: [id, name, dueDate]
3. AI cross-references: match waiting tasks to projects, compute age from deferDate or creationDate
4. Multiple `add_omnifocus_task` calls for qualifying items

**Ergonomic pressure points:**

- Tags filter is OR (correct here), but exact and case-sensitive. If the actual tag is "Waiting on Solicitor" (lowercase "on"), the query silently returns nothing.
- Field name ambiguity: `creationDate` vs `added` — documentation mentions both, AI must pick the right one.
- Cross-entity join (tasks to projects by ID) must be built client-side.
- String interpolation in new task names ("Chase solicitors re: [original name]").

---

### C4. CPD Compliance Dashboard

> "Check my 'CPD 2025-26' project. How many tasks completed vs total? Sum estimated minutes for completed vs remaining to give me hours done and hours left. Any overdue CPD tasks? If I'm less than halfway through the hours with less than 4 months left (year ends 31 March), add a flagged warning task with a note explaining the shortfall."

**Expected tool sequence:**

1. `query_omnifocus` — entity: tasks, filters: `{ projectName: "CPD 2025-26" }`, **includeCompleted: true**, fields: [id, name, taskStatus, estimatedMinutes, dueDate, completionDate]
2. AI computes: total vs completed counts, sum estimatedMinutes by status, identify overdue tasks
3. AI evaluates: hours done < 50% of total AND today > 30 November?
4. Conditional `add_omnifocus_task` — flagged, with computed note

**Ergonomic pressure points:**

- **`includeCompleted: true` is critical** — without it, the AI sees only active tasks and cannot compute completion percentage or hours done. This is a silent-failure trap.
- Null `estimatedMinutes` handling — tasks without estimates make the dashboard unreliable. AI should warn.
- The conditional logic references an external fact (BSB CPD year April–March) that the AI must know or be told.
- The composed note with interpolated values tests the AI's ability to produce a useful artifact, not just check boxes.

---

### C5. New Criminal Case from Template

> "New case: R v Kapoor, conspiracy to defraud. Crown Court at Southwark. PTPH on 18 March 2026, trial 1 June 2026. Set up my standard structure in 'Criminal Cases', sequential. Four task groups: 'Initial Review' (defer today, due 1 week), 'PTPH Preparation' (defer 2 weeks before PTPH, due 2 days before), 'Defence Case Statement' (defer day after PTPH, due 28 days after), 'Trial Preparation' (defer 4 weeks before trial, due 1 week before). Each with 3-5 subtasks. Tag everything 'Crown Court' and 'Southwark'."

**Expected tool sequence:**

1. `add_project` — "R v Kapoor [2026] — Conspiracy to Defraud", folderName: "Criminal Cases", sequential: true, tags: ["Crown Court", "Southwark"], note with case details
2. `batch_add_items` — ~20 items: 4 action-group parents with tempIds + ~16 subtasks via parentTempId, with dates computed relative to PTPH (18 March) and trial (1 June)

**Ergonomic pressure points:**

- Extensive date arithmetic: "2 weeks before PTPH" = 4 March, "28 days after PTPH" = 15 April, etc. All client-side.
- Two levels of nesting via `tempId`/`parentTempId` in a single `batch_add_items` call (~20 items). Tests batch reliability.
- Sequential project + parallel action groups is an OmniFocus pattern the batch must not break.
- Project name in batch must exactly match the name from step 1 — any mismatch sends tasks to inbox.
- **No template/duplicate-project tool** — the AI is the template engine every time.

---

## D. Chief of Staff / EA Scenarios

### D1. Morning Briefing Pack

> "Prepare my morning briefing. What's overdue, what's due today or this week, what's flagged, and what deferred items become available today? Group by urgency. For anything overdue, check whether other tasks in the same project are also slipping."

**Expected tool sequence:**

1. `query_omnifocus` — filters: `{ status: ["Overdue"] }` (fires)
2. `query_omnifocus` — filters: `{ dueWithin: 1 }` (today)
3. `query_omnifocus` — filters: `{ dueWithin: 7 }` (week)
4. `query_omnifocus` — filters: `{ flagged: true }` (flagged)
5. `query_omnifocus` — filters: `{ deferredUntil: 1 }` (newly available)
6. Per overdue project: `query_omnifocus` — filters: `{ projectId: "<id>", status: ["Overdue", "DueSoon"] }` (sibling slippage)

**Ergonomic pressure points:**

- Deduplication across 5 overlapping result sets.
- N+1 for sibling slippage (should batch by unique projectId, not per task).
- `dueWithin: 1` means "today and tomorrow" — AI must understand boundary semantics.
- Output must be a synthesised briefing, not a data dump.

---

### D2. New Litigation Matter Onboarding

> "New employment case — Williams v. Acme Corp. Create a sequential project in Litigation, due 14 July for the CMC. Standard early-stage tasks: conflict check, engagement letter, document preservation, client interview, research claims, draft complaint, serve defendant, prepare for CMC. Conflict check and engagement letter due within 3 days. Document preservation within a week. Stagger the rest reasonably. Tag everything 'Williams v Acme', tag conflict check 'Urgent'."

**Expected tool sequence:**

1. `query_omnifocus` — entity: folders — verify "Litigation" exists and get exact name
2. `add_project` — name, folder, sequential, dueDate, tags
3. `batch_add_items` — ~8 tasks with staggered due dates, mixed tags

**Ergonomic pressure points:**

- AI must calculate "reasonable intervals" for a litigation timeline — it is the template engine.
- Sequential project means task ordering matters — tasks must be added in the correct sequence.
- Mixed tag handling: global tag on all tasks + additional tag on one specific task.
- Defensive folder lookup: if "Litigation" doesn't exist exactly, the project lands at root level with no warning.

---

### D3. Delegation Audit

> "Show me all tasks tagged 'Delegated' or 'Waiting For'. For each: project, last modified, due date. Sort by staleness (oldest modification first). If any are overdue, flag them. Also give me a count of delegated items per project."

**Expected tool sequence:**

1. `query_omnifocus` — entity: tasks, filters: `{ tags: ["Delegated", "Waiting For"] }`, fields: [id, name, projectName, modificationDate, dueDate, flagged, tagNames, taskStatus], sortBy: modificationDate, sortOrder: asc
2. AI identifies overdue + unflagged items
3. `edit_item` calls to flag each qualifying item
4. AI computes per-project counts from step 1 results (no second query needed)

**Ergonomic pressure points:**

- Tag matching is **case-sensitive and exact**. "Delegated" vs "delegated" vs "Waiting" vs "Waiting For" — a single character difference means silent empty results.
- Staleness sort requires `sortOrder: asc` (oldest first) — counterintuitive direction.
- No `batch_edit_items` — multiple serial `edit_item` calls for flagging.
- Smart AI avoids a redundant second query for per-project counts by deriving them from step 1.

---

### D4. Overcommitment Detection

> "Add up estimated minutes for everything due or planned in the next 5 business days. Compare to 40-hour weekly capacity. Break down by day. Flag which tasks lack estimates. If any day exceeds 10 hours, flag the lowest-priority unflagged items on that day to mark for delegation."

**Expected tool sequence:**

1. `query_omnifocus` — filters: `{ dueWithin: 7 }`, fields: [id, name, dueDate, plannedDate, estimatedMinutes, flagged, projectName, tagNames]
2. `query_omnifocus` — filters: `{ plannedWithin: 7 }`, fields: same
3. AI merges and deduplicates, bins by day, sums estimates, identifies null-estimate wildcards
4. Conditional `edit_item` calls to flag excess items on overloaded days

**Ergonomic pressure points:**

- **Business days vs calendar days**: `dueWithin`/`plannedWithin` work in calendar days only. "5 business days" from Wednesday = 7 calendar days including the weekend.
- Dual date dimensions: tasks have both `dueDate` and `plannedDate` — AI must decide which to use for day-bucketing and explain its reasoning.
- Null `estimatedMinutes` must be surfaced as wildcards, not treated as zero.
- Conditional flagging requires multi-step reasoning: filter (unflagged only), sort (latest due date first = lowest priority), flag enough to bring day under 10 hours.

---

### D5. Cross-Matter Status Report for Partners' Meeting

> "Partners' meeting tomorrow. Give me a status summary across all active projects in the Litigation and Corporate folders. Per project: name, active tasks remaining, anything overdue, next due date, flagged items. Sort most-urgent first. Also pull my 'Weekly Review' perspective and flag anything there that isn't covered by the project-level view."

**Expected tool sequence:**

1. `query_omnifocus` — entity: folders — get IDs for "Litigation" and "Corporate"
2. `query_omnifocus` — entity: projects, filters: `{ folderId: "<lit_id>", status: ["Active"] }`, fields: [id, name, dueDate, activeTaskCount]
3. Same for Corporate folder
4. Per project: `query_omnifocus` — filters: `{ projectId: "<id>", status: ["Overdue"] }`, summary: true
5. Per project: `query_omnifocus` — filters: `{ projectId: "<id>", flagged: true }`, fields: [name, dueDate]
6. Per project: `query_omnifocus` — filters: `{ projectId: "<id>" }`, sortBy: dueDate, limit: 1
7. `get_perspective_view` — "Weekly Review"
8. Cross-reference perspective results against project data for orphans

**Ergonomic pressure points:**

- **Worst-case N+1**: 12 projects across two folders = 36 follow-up queries (steps 4-6). This is the scenario most likely to feel intolerably slow.
- Alternative: `dump_database` and filter in memory — but payload size for a large database is a concern.
- `folderId` filter doesn't recurse into subfolders. If "Litigation" has subfolders, the AI misses nested projects.
- Output must be a scannable briefing table, not raw data.

---

## Appendix: Ergonomic Gaps Identified

### High Severity

| Gap | Scenarios affected |
|---|---|
| **No `batch_edit_items` tool** — editing N items requires N serial `edit_item` calls | C2, B4, C1, D3, D4 |
| **N+1 query problem** — no per-project aggregate queries (overdue count, last completion date, available-action check) | A1, B3, D1, D5 |
| **No `list_tags` tool** — discovering existing tags requires querying all tasks and extracting `tagNames` | A5 |

### Medium Severity

| Gap | Scenarios affected |
|---|---|
| No `folderPath` field on projects (only immediate parent name) | A2 |
| No `sequential` property on action groups / tasks (only projects) | B2 |
| `includeCompleted` defaults to false — silent data loss if forgotten | B3, C4 |
| Tags filter is OR-only (no AND/NOT compound logic) | B4, D3 |
| `plannedWithin` / `dueWithin` are forward-only, calendar-day-only (no business-day awareness, no past-day reach) | B4, D4 |
| Custom perspective filter rules cannot be inspected, only their output | B5 |
| No review-cycle fields (`nextReviewDate`, `reviewInterval`) exposed | B5 |
| Date arithmetic entirely client-side with timezone risks | C2, C5 |
| No folder-recursive project filtering | D5 |

### Low Severity

| Gap | Scenarios affected |
|---|---|
| `deferredUntil` boundary semantics ambiguous | A4 |
| Project name partial matching can over-match or under-match | C2, D2 |
| Field name ambiguity (`creationDate` vs `added`) | C3 |
| No template / duplicate-project tool | C5, D2 |
| No multi-field sort (e.g. flagged + dueDate) | A3 |
| No server-side grouping / aggregation | A4, D4 |
