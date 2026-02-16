# Issue: No `sequential` support on action groups (parent tasks)

**Source:** UX test B2 (Nested Project Build) — untutored Haiku agent, 2026-02-11

## The Problem

When asked to create a project with three sequential action groups, each containing sequential subtasks, the agent correctly identified that OmniFocus action groups are implemented as parent tasks (not nested projects). It then tried to set `sequential: true` on each parent task:

```json
{
  "type": "task",
  "name": "Gather Documents",
  "projectName": "Annual Compliance Filing",
  "sequential": true,              // <-- Does this work?
  "estimatedMinutes": 30,
  "tags": ["Compliance"],
  "tempId": "gather_parent",
  "hierarchyLevel": 1
}
```

In OmniFocus, action groups have their own sequential/parallel setting independent of the containing project. A common pattern is:

```
Project (sequential)           — phases happen in order
├─ Phase 1 (parallel)          — tasks within phase can be done in any order
│  ├─ Task A
│  └─ Task B
├─ Phase 2 (sequential)        — tasks must be done in order
│  ├─ Task C
│  └─ Task D
```

## Current State

The `batch_add_items` and `add_omnifocus_task` schemas include `sequential` as a field, but it is only documented on the `add_project` tool. It's unclear whether:

1. The server accepts `sequential` on task items and passes it through to OmniFocus
2. The server silently ignores it on tasks
3. The server errors

The `edit_item` tool has `newSequential` but its description says "Whether the project should be sequential" — implying it's project-only.

## Why This Matters

This is a fundamental OmniFocus feature. Any non-trivial project template involves action groups with mixed sequential/parallel settings. Without this capability:

- A sequential project with parallel action groups can't be created (all tasks would be forced sequential by the project setting)
- The common "phases are sequential, tasks within each phase are parallel" pattern is impossible
- Users must manually adjust action group settings in the OmniFocus UI after creation, defeating the purpose of AI-assisted project setup

## The Agent's Workaround

The B2 agent explicitly noted the limitation:

> "OmniFocus doesn't support nested projects (projects within projects). The tool schemas show that tasks can have parent tasks, but projects cannot have parent projects. The action groups you've described would need to be implemented as **parent tasks** (not projects) within the main project."

It then set `sequential: true` on the parent tasks hoping it would work, while acknowledging uncertainty.

## Suggested Fix

1. **Confirm and document** whether `sequential` works on tasks in `batch_add_items` and `add_omnifocus_task`
2. If it doesn't work, **add support** — in the AppleScript, after creating a parent task, set its `sequential` property
3. Ensure `edit_item` with `newSequential` also works on tasks (action groups), not just projects
4. Update the tool descriptions to explicitly mention action group support

## Other Positives from This Test

Despite the gap, the agent:
- Correctly chose `batch_add_items` with a single call for all 13 items (1 project + 3 parents + 9 subtasks)
- Used `tempId`/`parentTaskName` correctly for the two-level hierarchy
- Applied dates only where specified (project defer, last subtask due) — didn't naively spread dates
- Applied uniform tags and per-group estimated minutes correctly
- Noted the due date should only go on the *final* subtask of the *last* group, not on every group's last subtask (though the user's request was ambiguous here)
- Completed in 0 tool calls / 58 seconds (pure reasoning)
