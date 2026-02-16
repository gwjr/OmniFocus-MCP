# Issue: `parentTempId` vs `projectName` confusion in `batch_add_items`

**Source:** UX test D2 (Matter Onboarding) — untutored Haiku agent, 2026-02-11

## The Problem

When asked to create a sequential project with 8 tasks, an untutored Haiku agent produced this `batch_add_items` call:

```json
{
  "items": [
    {
      "type": "project",
      "name": "Williams v. Acme Corp",
      "folderName": "Litigation",
      "dueDate": "2026-07-14",
      "sequential": true,
      "tags": ["Williams v Acme"],
      "tempId": "project1"
    },
    {
      "type": "task",
      "name": "Conflict check",
      "projectName": "Williams v. Acme Corp",
      "dueDate": "2026-02-14",
      "tags": ["Williams v Acme", "Urgent"],
      "parentTempId": "project1"          // <-- HERE
    },
    ...
  ]
}
```

The agent set **both** `projectName` and `parentTempId` on every task, with `parentTempId` pointing at the project's `tempId`. This is a category error:

- `parentTempId` is for linking a task to a **parent task** (i.e. creating an action group / nested task hierarchy)
- `projectName` is for placing a task into a **project**
- A project is not a task — `parentTempId` referencing a project `tempId` is semantically wrong

## Why This Happened

The schema doesn't make the distinction between projects and tasks clear enough in the context of `tempId`/`parentTempId`. The field descriptions say:

- `tempId`: "Temporary ID for within-batch references"
- `parentTempId`: "Reference to parent's tempId within the batch"

Neither description says "parent **task's** tempId" — so the agent reasonably assumed it could reference any item in the batch, including the project.

## What Actually Happens

Untested, but likely one of:
1. The server ignores `parentTempId` when it points to a project (tasks land in the project via `projectName` anyway)
2. The server errors because it tries to find a task with that tempId
3. The server creates the tasks as children of... something unexpected

## Suggested Fix

**Option A — Documentation fix:** Update `parentTempId` description to: "Reference to a parent **task's** tempId within the batch. Use `projectName` to assign tasks to a project; use `parentTempId` only to nest tasks under other tasks (action groups)."

**Option B — Make it work:** Allow `parentTempId` to reference a project's `tempId`, treating it as equivalent to `projectName`. This matches the agent's mental model and would "just work."

**Option C — Schema guardrail:** Only allow `tempId` on items with `"type": "task"`, not on projects. This prevents the confusion at the source — if the project can't have a `tempId`, agents won't try to reference it.

## Other Positives from This Test

Despite the confusion, the agent:
- Correctly chose `batch_add_items` over individual `add_omnifocus_task` calls
- Calculated reasonable staggered due dates from a prose description
- Applied mixed tags correctly (global tag on all items, "Urgent" only on conflict check)
- Set `createSequentially: true` to ensure correct ordering
- Used `sequential: true` on the project
- Completed in 0 tool calls / 9 seconds (pure reasoning, no MCP queries needed)
