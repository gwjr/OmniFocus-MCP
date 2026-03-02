# OmniFocus AppleScript Dictionary Reference

Extracted from `OmniFocus.app` (v4). The raw `.sdef` is at `docs/omnifocus-applescript-dictionary.sdef`.

> **How to browse interactively**: Use the `browse_sdef` MCP tool with paths like
> `OmniFocus/documents/flattened tasks` — see the tool's help for path syntax.

---

## Object Model Overview

```
application
  └─ document (default document)
       ├─ inbox tasks       → inbox task (inherits task)
       ├─ tasks             → task (top-level project root tasks)
       ├─ flattened tasks   → flattened task (ALL tasks: inbox, project roots, sub-tasks)
       ├─ projects          → project (top-level)
       ├─ flattened projects → flattened project (ALL projects)
       ├─ folders           → folder (top-level)
       ├─ flattened folders → flattened folder (ALL folders)
       ├─ tags              → tag (top-level)
       ├─ flattened tags    → flattened tag (ALL tags)
       ├─ sections          → section (projects + folders, top-level)
       └─ perspectives      → perspective
```

**Important**: `flattened tasks` includes project root tasks — every project has a corresponding
task in `flattenedTasks`. To get only non-project tasks, subtract `flattenedProjects.id()`.

---

## Bulk Property Access Pattern

AppleScript and JXA support reading a property from an entire collection in one Apple Event:

```applescript
-- AppleScript
set allNames to name of every flattened task of default document

-- JXA equivalent
app.defaultDocument.flattenedTasks.name()
```

This returns an aligned array — element `i` of each property array corresponds to element `i`
of the collection. This is the fastest access pattern (~140-170ms for ~2000 tasks).

**Chain properties** also work in bulk:

```applescript
set projectNames to name of containing project of every flattened task of default document
```

JXA: `app.defaultDocument.flattenedTasks.containingProject.name()`

These return `null`/`missing value` for items where the chain breaks (e.g., inbox tasks have
no containing project).

---

## Document

| Property | Type | R/O | Notes |
|----------|------|-----|-------|
| `id` | text | ro | |
| `name` | text | ro | |
| `can redo` | boolean | ro | |
| `can undo` | boolean | ro | |
| `last sync date` | date | ro | |
| `perspective names` | text[] | ro | |

**Elements**: `flattened tasks`, `flattened projects`, `flattened folders`, `flattened tags`,
`inbox tasks`, `tasks`, `projects`, `folders`, `tags`, `sections`, `perspectives`, `settings`

---

## Task (flattened task, inbox task, available task, remaining task)

All inherit from `task`. `flattened task` is the main collection used for queries.

### Properties

| Property | Type | R/O | Bulk? | Notes |
|----------|------|-----|-------|-------|
| `id` | text | ro | yes | Unique identifier |
| `name` | text | | yes | |
| `note` | rich text | | yes* | Expensive — large text payloads |
| `flagged` | boolean | | yes | |
| `completed` | boolean | ro | yes | Use `mark complete`/`mark incomplete` |
| `dropped` | boolean | ro | yes | Use `mark dropped`/`mark incomplete` |
| `blocked` | boolean | ro | yes | True if prior sequential sibling incomplete |
| `next` | boolean | ro | yes | True if next action of its project |
| `in inbox` | boolean | ro | yes | True if task is inbox item |
| `sequential` | boolean | | yes | Children are sequentially dependent |
| `completed by children` | boolean | | yes | |
| `due date` | date | | yes | |
| `defer date` | date | | yes | |
| `planned date` | date | | yes | v4+ |
| `effective due date` | date | ro | yes | Including inherited |
| `effective defer date` | date | ro | yes | Including inherited |
| `effective planned date` | date | ro | yes | Including inherited |
| `completion date` | date | | yes | Only modifiable on completed tasks |
| `dropped date` | date | | yes | Only modifiable on dropped tasks |
| `creation date` | date | | yes | Only settable at creation time |
| `modification date` | date | ro | yes | |
| `estimated minutes` | integer | | yes | |
| `should use floating time zone` | boolean | | yes | |
| `effectively completed` | boolean | ro | yes | Including parent/project status |
| `effectively dropped` | boolean | ro | yes | Including parent/project status |
| `number of tasks` | integer | ro | yes | Direct child count |
| `number of available tasks` | integer | ro | yes | |
| `number of completed tasks` | integer | ro | yes | |
| `containing project` | project | ro | chain | `.containingProject.name()` etc |
| `parent task` | task | ro | chain | `.parentTask.id()` etc |
| `primary tag` | tag | | chain | `.primaryTag.name()` etc |
| `container` | document\|project\|task | ro | chain | |
| `repetition rule` | repetition rule | | no | Complex type |
| `next due date` | date | ro | yes | Next repeat due date |
| `next defer date` | date | ro | yes | Next repeat defer date |
| `next planned date` | date | ro | yes | Next repeat planned date |

### Elements

| Element | Type | Notes |
|---------|------|-------|
| `tasks` | task | Direct children only |
| `flattened tasks` | flattened task | All descendants |
| `tags` | tag | Tags assigned to this task; bulk-readable via chain: `.tags.name()`, `.tags.id()` |

### Tag Access

Tags are a **nested collection** — each task has zero or more tags. Bulk-readable:

```applescript
-- Returns list of lists: {{tag1, tag2}, {}, {tag3}, ...}
set tagNames to name of tags of every flattened task of default document
```

JXA: `app.defaultDocument.flattenedTasks.tags.name()` — returns `[["tag1","tag2"], [], ["tag3"], ...]`

---

## Project (flattened project)

Inherits from `section`. Projects have most task properties plus review/status properties.

### Properties (beyond task properties)

| Property | Type | R/O | Bulk? | Notes |
|----------|------|-----|-------|-------|
| `id` | text | ro | yes | |
| `name` | text | | yes | |
| `status` | project status | | yes | `active status`/`on hold status`/`done status`/`dropped status` |
| `effective status` | project status | ro | yes | Including folder status |
| `folder` | folder | ro | chain | `.folder.name()` etc |
| `singleton action holder` | boolean | | yes | "Single Actions" list |
| `default singleton action holder` | boolean | | yes | Default inbox target |
| `next task` | task | ro | chain | Next available action |
| `last review date` | date | | yes | |
| `next review date` | date | | yes | |
| `review interval` | repetition interval | | no | |
| `flagged` | boolean | | yes | |
| `sequential` | boolean | | yes | |
| `due date` | date | | yes | |
| `defer date` | date | | yes | |
| `estimated minutes` | integer | | yes | |
| `note` | rich text | | yes* | |
| `completed` | boolean | ro | yes | |
| `dropped` | boolean | ro | yes | |
| `effectively completed` | boolean | ro | yes | |
| `effectively dropped` | boolean | ro | yes | |
| `number of tasks` | integer | ro | yes | |
| `number of available tasks` | integer | ro | yes | |
| `number of completed tasks` | integer | ro | yes | |

**Note**: Project IDs and task IDs are **different** — a project's root task has a different ID
from the project itself. `containing project` of a project's root task points to the project.

---

## Folder (flattened folder)

### Properties

| Property | Type | R/O | Bulk? | Notes |
|----------|------|-----|-------|-------|
| `id` | text | ro | yes | |
| `name` | text | | yes | |
| `hidden` | boolean | | yes | True = Dropped |
| `effectively hidden` | boolean | ro | yes | Including parent folder status |
| `creation date` | date | ro | yes | |
| `modification date` | date | ro | yes | |
| `note` | rich text | | yes* | |
| `container` | document\|folder | ro | chain | |

### Elements

| Element | Type |
|---------|------|
| `folders` | folder |
| `flattened folders` | flattened folder |
| `projects` | project |
| `flattened projects` | flattened project |
| `sections` | section |

---

## Tag (flattened tag)

### Properties

| Property | Type | R/O | Bulk? | Notes |
|----------|------|-----|-------|-------|
| `id` | text | | yes | |
| `name` | text | | yes | |
| `hidden` | boolean | | yes | Active vs dropped |
| `effectively hidden` | boolean | ro | yes | Including parent tag |
| `allows next action` | boolean | | yes | False = tasks can't be "next" |
| `available task count` | integer | ro | yes | |
| `remaining task count` | integer | ro | yes | |
| `container` | tag | ro | chain | Parent tag |
| `location` | location information | | no | For Nearby perspective |
| `note` | rich text | | yes* | |

### Elements

| Element | Type |
|---------|------|
| `tags` | tag | Direct children |
| `flattened tags` | flattened tag | All descendants |
| `tasks` | task | **ro** — tasks with this tag |
| `available tasks` | available task | |
| `remaining tasks` | remaining task | |

---

## Commands

### Status Commands

| Command | Applies to | Notes |
|---------|-----------|-------|
| `mark complete` | task, project | Optional `completion date` param |
| `mark incomplete` | task, project | Reopens completed OR dropped items |
| `mark dropped` | task, project | Optional `dropped date` param |

### CRUD Commands

| Command | Signature | Notes |
|---------|-----------|-------|
| `make` | `make new task with properties {name:"...", ...}` | Create objects |
| `delete` | `delete theTask` | |
| `duplicate` | `duplicate theTask to end of project "X"` | |
| `move` | `move theTask to end of project "X"` | |
| `add` | `add theTag to tags of theTask` | Add tag to task |
| `remove` | `remove theTag from tags of theTask` | Remove tag from task |

### Other

| Command | Notes |
|---------|-------|
| `evaluate javascript` | Bridge to OmniJS — `evaluate javascript "code"` |
| `parse tasks into` | Import TaskPaper-format text |
| `compact` | Process inbox items, hide completed |
| `synchronize` | Trigger sync |

---

## Enumerations

| Enum | Values |
|------|--------|
| `project status` | `active status`, `on hold status`, `done status`, `dropped status` |
| `repetition method` | `fixed repetition`, `start after completion`, `due after completion` |
| `repetition based on` | `based on due`, `based on planned`, `based on defer` |
| `interval unit` | `minute`, `hour`, `day`, `week`, `month`, `year` |
| `sidebar tab` | `inbox tab`, `projects tab`, `tags tab`, `forecast tab`, `flagged tab`, `review tab` |

---

## Addressing Patterns

```applescript
-- By ID (fastest for single-item access)
a reference to flattened task id "abc123" of default document

-- By name (first match)
first flattened task of default document whose name is "Buy milk"

-- .whose() — SLOW on large collections (~31s for 751 tasks)
-- Only use for small targeted lookups (tag by name, project scope)
every flattened task of default document whose flagged is true

-- Bulk read (fastest for collection-wide reads)
name of every flattened task of default document
```

**Performance notes** (from benchmark/REPORT.md):
- IPC floor: ~100ms per Apple Event round-trip
- Bulk read of one property: ~140-170ms for ~2000 tasks
- Chain property: ~200-400ms (variable)
- `.whose()` on large collections: avoid — use bulk read + Node filter instead
- At 8+ properties: AppleScript is 2-4x faster than JXA (bridge tax)
