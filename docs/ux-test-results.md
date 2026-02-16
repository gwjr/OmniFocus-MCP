# OmniFocus MCP Server — UX Test Results

**Date:** 2026-02-11
**Model:** Claude Haiku 4.5 (untutored — no context about the MCP server)
**Method:** Each agent received only the user's natural-language request and the constraint "read-only, don't read source code"

---

## Scorecard

| Test | Status | Calls | Time | Summary |
|---|---|---|---|---|
| **A1** Stuck project audit | SUCCESS | 3 | 171s | Found 22 stuck projects. Couldn't get modification dates. |
| **A2** Horizons of focus | SUCCESS | 2 | 19s | Found 10 orphaned projects. Correctly flagged folder-name mismatch. |
| **A3** Context time blocking | SUCCESS (empty) | 6 | 140s | No tasks match tags 'Office'/'Computer'. Explored alternatives. |
| **A4** Deferred item runway | SUCCESS | 1 | 20s | Found deferred items, grouped by day. Only showed ~17 of "361". |
| **A5** Inbox processing | PARTIAL | 5 | 82s | Got projects + tags. `projectName: "inbox"` returned nothing. |
| **B1** Daily availability | FAILED (perms) | 1 | 6s | Permission denied on perspectives. Didn't fall back to queries. |
| **B2** Nested project build | PLAN ONLY | 0 | 58s | Correct `batch_add_items`. Spotted sequential-on-action-groups gap. |
| **B3** Stale project audit | SUCCESS | 14 | 184s | Best result. Found 18 empty projects, 9 urgent due dates, PHS pattern. |
| **B4** Workload rebalancing | SUCCESS (empty) | 9 | 113s | Tags don't exist. Found 25 planned tasks, 18 stacked on Monday. |
| **B5** Perspective discrepancy | FAILED (perms) | 3 | 10s | Permission denied. No fallback attempted. |
| **C1** Barrister triage | SUCCESS | 3 | 15s | Clean 3-query triage. Identified 3 projects to flag. Best efficiency. |
| **C2** Deadline cascade | PENDING | — | — | Still running at end of session. |
| **C3** Waiting-on audit | FAILED (perms) | 3 | 8s | Permission denied on MCP tools. |
| **C4** CPD compliance | FAILED (perms) | 4 | 11s | Permission denied. Correct reasoning about what it *would* do. |
| **C5** Case template build | PLAN ONLY | 0 | 22s | Correct dates, good `batch_add_items` with 22 items. |
| **D1** Morning briefing | FAILED (session) | 10 | 20s | Round 1 only — MCP server died under concurrency. |
| **D2** Matter onboarding | PLAN ONLY | 0 | 9s | Correct `batch_add_items`. `parentTempId`/`projectName` confusion. |
| **D3** Delegation audit | FAILED (perms) | 2 | 15s | Permission denied. |
| **D4** Overcommitment detect | FAILED (session) | 3 | 16s | Round 1 only — MCP server died under concurrency. |
| **D5** Partners meeting | FAILED (session) | 4 | 15s | Round 1 only — MCP server died under concurrency. |

**Summary:** 8 successful query runs, 3 successful write plans, 2 correct-but-empty, 7 permission/infra failures.

---

## Confirmed Findings

### Infrastructure

1. **MCP server can't handle concurrent sessions.** 20 simultaneous agents killed it instantly. Even 3-4 concurrent agents caused "Session not found" errors. Single agents work fine.

2. **Claude Code permission model doesn't suit agent fleets.** Each subagent needs individual tool permission approval. Multiple agents create a barrage of prompts that are easy to miss/deny, causing false "permission denied" failures.

3. **Parallel tool calls within a single agent can fail catastrophically.** If one MCP call in a parallel batch fails, all siblings are killed ("Sibling tool call errored"). Agents should be nudged toward sequential queries when server reliability is uncertain.

### API Design — Positive

4. **`batch_add_items` schema is self-documenting.** Three untutored haiku agents (B2, C5, D2) all independently discovered it, used `tempId`/`parentTempId` correctly, and produced valid batch structures. This is well-designed.

5. **`query_omnifocus` is the natural first choice.** Every query-scenario agent reached for it over `dump_database`. The filter/fields/sort schema is intuitive.

6. **The triage pattern (overdue + dueWithin + flagged) works efficiently.** C1 achieved a complete triage in 3 calls / 15 seconds. This is the MCP server at its best.

### API Design — Gaps to Fix

7. **No `list_tags` tool.** Confirmed by A3, A5, B4 — every agent that needed tag vocabulary burned multiple calls discovering it from task data. This is the most frequently hit gap.

8. **`parentTempId` vs `projectName` confusion in `batch_add_items`.** D2 used `parentTempId` to point at a project's `tempId`, which is a category error. The schema doesn't distinguish these clearly. See `docs/issue-parentTempId-projectName-confusion.md`.

9. **No `sequential` support on action groups.** B2 identified that action groups (parent tasks) can't be made sequential via the API. See `docs/issue-sequential-on-action-groups.md`.

10. **`projectName: "inbox"` may not work.** A5 got zero results. Either the filter is broken or the user's inbox was genuinely empty — needs investigation.

11. **`modificationDate` retrieval issues.** A1 and B3 both failed to sort by modification date despite requesting the field. The field may not be returned or may be formatted unexpectedly.

12. **No `batch_edit_items` tool.** C2's deadline cascade scenario would require N individual `edit_item` calls. Not tested live but the gap is clear from the scenario design.

13. **No per-project aggregate queries.** B3's stale project audit required 14 calls for 103 projects. A `hasCompletedTasksSince` filter or `lastCompletionDate` field on projects would collapse this to 1-2 calls.

### Haiku Reasoning Observations

14. **Large result sets overwhelm haiku.** A4 got 361 items and could only present ~17, hand-waving the rest. A `limit` parameter or pagination guidance would help.

15. **Error recovery is poor.** When MCP calls fail, haiku tries `dump_database` as fallback, then gives up. No agent tried retrying the same call or testing with a simpler query first.

16. **Semantic reasoning is surprisingly good.** A2 correctly noticed folder-name mismatches. B3 spotted the PHS pattern (14 projects all blocked on the same action). B4 gave practical advice about the user's actual workflow vs. the scenario's assumptions.

---

## Priority Fix List

| Priority | Item | Effort | Impact | Status |
|---|---|---|---|---|
| **P1** | Add `list_tags` tool | Small | Saves 3-5 calls per tag-dependent scenario | **DONE** |
| **P1** | Investigate `projectName: "inbox"` filter | Small | Blocks the entire inbox-processing workflow | **OK** — code is correct; A5 had empty inbox |
| **P1** | Investigate `modificationDate` field retrieval | Small | Needed for any staleness/audit scenario | **DONE** — see below |
| **P2** | Clarify `parentTempId` vs `projectName` in schema descriptions | Small | Prevents agent confusion on project scaffolding | |
| **P2** | Add `sequential` support on action groups (tasks) | Medium | Required for non-trivial project templates | |
| **P2** | Add `batch_edit_items` tool | Medium | Required for date-cascade and bulk-flag workflows | |
| **P2** | Implement `deferredUntil` filter (declared but never wired up) | Small | Needed for deferred-item runway scenarios | |
| **P3** | Add per-project aggregate fields (lastCompletionDate, etc.) | Medium | Eliminates N+1 pattern for audit scenarios | |
| **P3** | Add health-check/ping tool | Small | Helps agents detect server issues before committing to complex queries | |

### P1 Fix Details

**`list_tags` tool** (2026-02-11)
- New OmniJS script (`listTags.js`), primitive, definition, registered in server.ts
- Returns tag name, hierarchy (parent/child), status, task count
- Filters: includeActive (default true), includeOnHold, includeDropped

**`modificationDate` field retrieval** (2026-02-11)
Three bugs fixed:
1. **Sort property mapping**: `sortBy: "modificationDate"` was generating `a.modificationDate` in the JXA, but OmniJS tasks use `.modified` and projects use `.task.modified`. Added entity-aware `mapFieldToProperty()`.
2. **Project date access**: OmniJS `Project` objects don't expose `.modified`/`.added` directly — dates live on the root task (`project.task.modified`, `project.task.added`). Field mapping now uses `item.task.modified` for projects, `item.modified` for tasks.
3. **Project date display**: `formatProjects()` in the definition wasn't rendering `modificationDate` or `creationDate` even when present in the data. Added display lines.

**Bonus: SDK upgrade** (2026-02-11)
- SDK was stuck at 1.8.0 despite `package.json` requesting `^1.26.0`
- Upgraded to SDK 1.26.0 + Zod 4.3.6
- `tsc` now builds cleanly (no more hand-editing dist/)

**Bonus: `deferredUntil` filter** (discovered 2026-02-11)
- The filter is declared in the schema and TypeScript interface but never wired up in `generateFilterConditions()`. Queued as P2.

---

## Tests Still Needed

The following scenarios were not completed due to infrastructure issues and should be retried:

- **B1** Daily availability (perspectives + query cross-reference)
- **B5** Perspective vs query discrepancy
- **C2** Deadline cascade (date arithmetic + bulk edits)
- **C3** Waiting-on audit (cross-entity join)
- **C4** CPD compliance dashboard (includeCompleted + arithmetic)
- **D1** Morning briefing (multi-query synthesis)
- **D3** Delegation audit (tag query + conditional flagging)
- **D4** Overcommitment detection (time budgeting)
- **D5** Partners meeting report (N+1 + perspective cross-reference)
