# OmniFocus OmniJS (Omni Automation) API Reference

OmniJS is the JavaScript automation API that runs **inside** OmniFocus. It is invoked from
AppleScript/JXA via the `evaluate javascript` command.

> **Official docs**: https://omni-automation.com/omnifocus/index.html
> **Full API reference**: https://www.omni-automation.com/omnifocus/OF-API.html

---

## Invocation

```applescript
-- AppleScript
tell application "OmniFocus"
  evaluate javascript "Task.byIdentifier('abc123').name"
end tell
```

```javascript
// JXA
const app = Application('OmniFocus');
app.includeStandardAdditions = true;
const result = app.evaluateJavascript(`
  (function() {
    const t = Task.byIdentifier('abc123');
    return t ? t.name : null;
  })()
`);
```

**Return value behaviour**: `evaluateJavascript()` preserves JavaScript types across the bridge:
- Strings, numbers, booleans, null → pass through as-is
- Arrays → real JXA arrays (including nested arrays)
- Objects → JXA objects (but key order may vary)
- No need to `JSON.stringify()` inside OmniJS — the bridge handles it

---

## Class Hierarchy

```
DatabaseObject
  id: ObjectIdentifier { objectClass: String, primaryKey: String }
  url: URL | null (v4.5+, r/o)

  DatedObject < DatabaseObject
    added: Date | null (r/o)
    modified: Date | null (r/o)

    ActiveObject < DatedObject
      active: Boolean (r/o)
      effectiveActive: Boolean (r/o)

      Task < ActiveObject
      Project < ActiveObject
      Tag < ActiveObject
      Folder < ActiveObject
```

---

## Database

Accessed as the implicit global in OmniJS scripts (no variable needed for most operations),
or via `document` in some contexts.

### Flattened Collections (all tasks/projects/folders/tags in the database)

| Property | Type | Notes |
|----------|------|-------|
| `flattenedTasks` | TaskArray | **Includes project root tasks** — every project has a task |
| `flattenedProjects` | ProjectArray | All projects, regardless of folder nesting |
| `flattenedFolders` | FolderArray | All folders |
| `flattenedTags` | TagArray | All tags |
| `flattenedSections` | SectionArray | All projects + folders |

### Top-Level Collections

| Property | Type | Notes |
|----------|------|-------|
| `inbox` | Inbox (extends TaskArray) | Inbox tasks only |
| `library` | Library (extends SectionArray) | Top-level projects + folders |
| `projects` | ProjectArray | Top-level projects only |
| `folders` | FolderArray | Top-level folders only |
| `tags` | Tags (extends TagArray) | Top-level tags only |

### Methods

| Method | Returns | Notes |
|--------|---------|-------|
| `taskNamed(name)` | Task \| null | |
| `projectNamed(name)` | Project \| null | |
| `folderNamed(name)` | Folder \| null | |
| `tagNamed(name)` | Tag \| null | |
| `projectsMatching(search)` | ProjectArray | Search by name |
| `foldersMatching(search)` | FolderArray | |
| `tagsMatching(search)` | TagArray | |
| `objectForURL(url)` | DatabaseObject \| null | Resolve `omnifocus:///` URL |
| `moveTasks(tasks, position)` | | |
| `duplicateTasks(tasks, position)` | | |
| `moveSections(sections, position)` | | |
| `moveTags(tags, position)` | | |
| `convertTasksToProjects(tasks, position)` | | |
| `deleteObject(object)` | | |
| `save()`, `undo()`, `redo()`, `cleanUp()` | | |

### Collection Array Methods

All collection types (TaskArray, ProjectArray, etc.) extend Array and add:
- `byName(name: String)` → first match or null

Hierarchical collections (Inbox, Library, Tags) additionally have:
- `apply(function)` → walk hierarchy with `ApplyResult.Stop`, `.SkipChildren`, `.SkipPeers`
- `beginning`, `ending` → insertion location references

---

## Task

### Lookup

| Method | Notes |
|--------|-------|
| `Task.byIdentifier(id)` | Lookup by primaryKey string. ~7ms per call. |
| `new Task(name, position?)` | Create a new task |
| `Task.byParsingTransportText(text, singleTask?)` | Parse TaskPaper format |

### Properties

| Property | Type | R/O | Notes |
|----------|------|-----|-------|
| `name` | String | | |
| `note` | String | | Plain text (not rich text like AS) |
| `id` | ObjectIdentifier | ro | Use `.id.primaryKey` for the string ID |
| `flagged` | Boolean | | |
| `effectiveFlagged` | Boolean | ro | Inherited from parent |
| `completed` | Boolean | ro | Use markComplete()/markIncomplete() |
| `completionDate` | Date \| null | ro | |
| `deferDate` | Date \| null | | |
| `dueDate` | Date \| null | | |
| `effectiveDeferDate` | Date \| null | ro | |
| `effectiveDueDate` | Date \| null | ro | |
| `plannedDate` | Date \| null | | v4.5+ |
| `effectivePlannedDate` | Date \| null | ro | |
| `estimatedMinutes` | Number \| null | | |
| `sequential` | Boolean | | |
| `inInbox` | Boolean | ro | |
| `taskStatus` | Task.Status | ro | Enum — see below |
| `tags` | TagArray | ro | |
| `parent` | Task \| null | ro | Parent task (sub-tasks) |
| `project` | Project \| null | ro | Direct project if root task |
| `containingProject` | Project \| null | ro | Root project up the tree |
| `assignedContainer` | Project\|Task\|Inbox \| null | | Inbox task assignment |
| `children` / `tasks` | TaskArray | ro | Direct children |
| `flattenedChildren` / `flattenedTasks` | TaskArray | ro | All descendants |
| `hasChildren` | Boolean | ro | |
| `completedByChildren` | Boolean | | |
| `repetitionRule` | Task.RepetitionRule \| null | | |
| `notifications` | Array\<Task.Notification\> | ro | |
| `attachments` | Array\<FileWrapper\> | | |
| `linkedFileURLs` | Array\<URL\> | ro | |
| `shouldUseFloatingTimeZone` | Boolean | | |
| `added` | Date \| null | ro | Creation date |
| `modified` | Date \| null | ro | |
| `dropDate` | Date \| null | ro | |
| `effectiveDropDate` | Date \| null | ro | |
| `effectiveCompletedDate` | Date \| null | ro | |

### Methods

| Method | Notes |
|--------|-------|
| `markComplete(date?)` | |
| `markIncomplete()` | Reopens completed or dropped |
| `drop(allOccurrences)` | Mark dropped |
| `addTag(tag)` / `addTags(tags)` | |
| `removeTag(tag)` / `removeTags(tags)` | |
| `clearTags()` | |
| `appendStringToNote(text)` | |
| `apply(function)` | Hierarchical iteration |
| `taskNamed(name)` / `childNamed(name)` | |

### Task.Status Enum

| Value | Meaning |
|-------|---------|
| `Task.Status.Available` | Can be worked on now |
| `Task.Status.Blocked` | Sequential project, prior task incomplete |
| `Task.Status.Completed` | |
| `Task.Status.Dropped` | |
| `Task.Status.DueSoon` | Due within the "due soon" interval |
| `Task.Status.Next` | Next action in sequential project |
| `Task.Status.Overdue` | Past due date |

---

## Project

### Lookup

| Method | Notes |
|--------|-------|
| `Project.byIdentifier(id)` | |
| `new Project(name, position?)` | |

### Properties (beyond inherited)

| Property | Type | R/O | Notes |
|----------|------|-----|-------|
| `name` | String | | |
| `status` | Project.Status | | |
| `containsSingletonActions` | Boolean | | "Single Actions" list |
| `defaultSingletonActionHolder` | Boolean | | Default inbox target |
| `tasks` / `children` | TaskArray | ro | Direct children |
| `flattenedChildren` / `flattenedTasks` | TaskArray | ro | All tasks within |
| `hasChildren` | Boolean | ro | |
| `nextTask` | Task \| null | ro | |
| `tags` | TagArray | ro | |
| `parentFolder` | Folder \| null | ro | (AS: `folder`) |
| `task` | Task | ro | The project's root task object |
| `lastReviewDate` | Date \| null | | |
| `nextReviewDate` | Date \| null | | |
| `reviewInterval` | Project.ReviewInterval \| null | | |
| `flagged` | Boolean | | |
| `sequential` | Boolean | | |
| `dueDate` / `deferDate` | Date \| null | | |
| `estimatedMinutes` | Number \| null | | |

### Project.Status Enum

| Value | AS equivalent |
|-------|--------------|
| `Project.Status.Active` | `active status` |
| `Project.Status.OnHold` | `on hold status` |
| `Project.Status.Done` | `done status` |
| `Project.Status.Dropped` | `dropped status` |

---

## Tag

### Lookup

| Method | Notes |
|--------|-------|
| `Tag.byIdentifier(id)` | |
| `new Tag(name, position?)` | |
| `Tag.forecastTag` | The forecast tag (class property) |

### Properties

| Property | Type | R/O | Notes |
|----------|------|-----|-------|
| `name` | String | | |
| `status` | Tag.Status | | Active, OnHold, Dropped |
| `allowsNextAction` | Boolean | | |
| `parent` | Tag \| null | ro | Parent in hierarchy |
| `children` / `tags` | TagArray | ro | |
| `flattenedChildren` / `flattenedTags` | TagArray | ro | |
| `tasks` | TaskArray | ro | All tasks with this tag |
| `availableTasks` | TaskArray | ro | |
| `remainingTasks` | TaskArray | ro | |
| `projects` | ProjectArray | ro | |
| `childrenAreMutuallyExclusive` | Boolean | ro | v4.7+ |

### Tag.Status Enum

| Value | AS equivalent |
|-------|--------------|
| `Tag.Status.Active` | `hidden = false` |
| `Tag.Status.OnHold` | `hidden = true` |
| `Tag.Status.Dropped` | `hidden = true` |

---

## Folder

### Lookup

| Method | Notes |
|--------|-------|
| `Folder.byIdentifier(id)` | |
| `new Folder(name, position?)` | |

### Properties

| Property | Type | R/O | Notes |
|----------|------|-----|-------|
| `name` | String | | |
| `status` | Folder.Status | | Active or Dropped |
| `parent` | Folder \| null | ro | |
| `children` / `sections` | Array\<Project\|Folder\> | ro | |
| `folders` | FolderArray | ro | |
| `projects` | ProjectArray | ro | |
| `flattenedChildren` / `flattenedSections` | SectionArray | ro | |
| `flattenedFolders` | FolderArray | ro | |
| `flattenedProjects` | ProjectArray | ro | |

---

## Perspective

### Built-in Perspectives

Class properties on `Perspective.BuiltIn`:
`.Flagged`, `.Forecast`, `.Inbox`, `.Nearby`, `.Projects`, `.Review`, `.Search`, `.Tags`

### Custom Perspectives

| Property | Type | R/O |
|----------|------|-----|
| `name` | String | ro |
| `identifier` | String | ro |

Lookup: `Perspective.Custom.byName(name)`, `Perspective.Custom.byIdentifier(uuid)`

---

## Key Differences: AppleScript Dictionary vs OmniJS

| Concept | AppleScript (sdef) | OmniJS |
|---------|-------------------|--------|
| Task status | Booleans: `completed`, `dropped`, `blocked`, `next` | Enum: `task.taskStatus` → `Task.Status.Available` etc |
| Project status | Enum: `active status` etc | Enum: `Project.Status.Active` etc |
| Tag active/dropped | `hidden` boolean | `Tag.Status` enum |
| Folder active/dropped | `hidden` boolean | `Folder.Status` enum |
| ID access | `id of task` → string | `task.id.primaryKey` → string |
| Tag operations | `add theTag to tags of theTask` | `task.addTag(tag)` |
| Mark complete | `mark complete theTask` | `task.markComplete()` |
| Reopen | `mark incomplete` | `task.markIncomplete()` |
| Note | Rich text object | Plain string |
| Create | `make new task with properties {...}` | `new Task(name, position)` |
| Bulk read | `name of every flattened task` → array | Not available — iterate or use AS/JXA |
| Lookup by ID | `flattened task id "abc"` | `Task.byIdentifier("abc")` (~7ms) |

---

## Performance Guidance

| Pattern | Speed | When to use |
|---------|-------|-------------|
| AS/JXA bulk property read | ~140ms/prop | Collection-wide queries |
| AS/JXA chain property | ~200-400ms | Relationship traversal (project name, parent ID) |
| OmniJS `byIdentifier()` | ~7ms/item | Small targeted lookups (<50 items) |
| OmniJS full scan | Very slow | Avoid — use bulk read + filter instead |
| AS pre-compiled (.scpt) | Saves ~1.7s | Hot paths with many properties |
| JXA at 8+ properties | 2-4x slower than AS | Consider switching to AS for hot paths |

See `benchmark/REPORT.md` for detailed empirical data.
