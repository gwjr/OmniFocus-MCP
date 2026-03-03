# Swift Port Hazard Report

Analysis of TypeScript/JXA patterns in the OmniFocus MCP query engine that would be problematic, non-trivial, or subtly dangerous to replicate in a Swift port.

## 1. ExprBackend\<T\> Generic Dispatch

**Current pattern** (`fold.ts`):

`ExprBackend<T>` is a protocol (interface) with 19 methods, each returning a generic `T`. Four backend implementations exist:
- `NodeEvalBackend` → `T = (Row) => unknown` (closures)
- `JxaCompiler` → `T = string` (code fragments)
- `Describer` → `T = string` (English)
- `VarCollector` → `T = Set<string>`

`foldExpr<T>` is a single recursive function that dispatches structurally on the AST (typeof checks, `'op' in obj`, Array.isArray, etc.) and calls the appropriate backend method.

**Swift mapping**:

A Swift protocol with an associated type works cleanly:

```swift
protocol ExprBackend {
    associatedtype Value
    func literal(_ value: LiteralValue) -> Value
    func variable(_ name: String, entity: EntityType) -> Value
    // ...
}
func foldExpr<B: ExprBackend>(_ node: LoweredExpr, backend: B, entity: EntityType) -> B.Value
```

**Hazards**:
- The `container()` and `containing()` backend methods accept a `fold` callback: `(node: LoweredExpr, entity: EntityType) => T`. In Swift, this closure captures the generic backend, which is fine, but the callback's type must use the associated type (`B.Value`), preventing it from being stored in a non-generic collection. This rules out certain dynamic-dispatch patterns; the fold must stay monomorphised.
- The `LoweredExpr` union type (string | number | boolean | null | object | array) requires a proper Swift enum. TypeScript dispatches on it via `typeof` and `Array.isArray` checks at runtime; Swift would use pattern matching on an enum, which is strictly better (exhaustive) but requires defining the enum and migrating all construction sites.
- `matches()` passes the raw regex pattern string rather than a folded `T` — this asymmetry (one arg is `T`, the other is `string`) is fine in both languages but worth noting during porting.

**Severity**: Low. This pattern maps well to Swift.

## 2. Implicit JS Coercions in NodeEval

**Current pattern** (`backends/nodeEval.ts`):

This is the highest-hazard area. The Node-side evaluator relies heavily on JavaScript's implicit type coercion:

### 2a. Truthiness / Falsiness

```typescript
and(args: RowFn[]): RowFn {
    return (row) => args.every(fn => !!fn(row));
}
```

The double-bang `!!` coerces `unknown` to boolean. JS falsy values: `null`, `undefined`, `0`, `""`, `false`, `NaN`. In OmniFocus data, boolean properties (flagged, completed, blocked) are actual booleans, but `!!` is also used to coerce filter results where `null` means "no match". A Swift port must decide: do `0` and `""` evaluate as falsy, or only `nil` and `false`? The answer depends on whether any query predicates rely on the JS-specific falsy set.

**Specific risk**: The `contains()`/`startsWith()`/`endsWith()` methods check `if (s === true) return true; // stub -> permissive`. This tests for the literal boolean `true` (not truthiness), which arises from `stubVars` returning `true` for two-phase filtering. Swift `Optional` won't conflate `true` with "has a value".

### 2b. Loose Equality (`==`)

```typescript
isNull(arg: RowFn): RowFn {
    return (row) => arg(row) == null;
}
```

JS `== null` matches both `null` and `undefined`. Swift has no `undefined`, so `nil` covers both. But if any value can be a JS `undefined` that was serialised or inherited from the JXA bridge, it would silently disappear in Swift.

### 2c. Normalisation for Comparisons

```typescript
function normalize(v: unknown): unknown {
    if (typeof v === 'string') {
        if (ISO_DATE_RE.test(v)) { ... parse as timestamp }
        return v.toLowerCase();
    }
    if (v instanceof Date) return v.getTime();
    ...
}
```

This normalises all strings to lowercase and date-like strings to timestamps. The heuristic — "if it matches `/^\d{4}-\d{2}-\d{2}/`, treat it as a date" — is fragile. Swift's `Date` is not a special snowflake; it's a `TimeInterval` wrapper. But the ad-hoc sniffing must be replicated exactly, or comparisons will silently change behaviour. **User: no, we won't be doing backwards compat with the Swift port**

### 2d. Mixed-Type Comparison

```typescript
function safeCompare(a: unknown, b: unknown): number | null {
    if (typeof na === 'number' && typeof nb === 'number') return na - nb;
    if (typeof na === 'string' && typeof nb === 'string') return na < nb ? -1 : ...;
    return null;
}
```

Comparing a `number` to a `string` returns `null` (no ordering). In Swift, `Any` comparisons require explicit type checking. The risk is that JS silently coerces in ways not captured by `safeCompare`, and the Swift port might inadvertently allow or disallow comparisons that the TS version handles differently.

### 2e. `tryStaticArray` — Probing Closures

```typescript
function tryStaticArray(fn: RowFn): unknown[] | null {
    try {
        const val = fn({});
        return Array.isArray(val) ? val : null;
    } catch { return null; }
}
```

This calls a closure with an empty row to detect whether it's a constant function, using exception handling as control flow. Swift closures are not introspectable in this way; you'd need to either:
- Tag constant expressions at compile time (e.g., a wrapper enum `RowExpr.constant([...])` vs `.dynamic((Row) -> Any)`)
- Accept the overhead of not pre-normalising static arrays

**Severity**: High. This is the most bug-prone area to port. Every coercion path needs explicit tests and a clear decision about intended semantics.

## 3. Use of `any` and Structural Duck-Typing

### 3a. Row = Record\<string, unknown\>

The entire row model is `Record<string, unknown>`. Values are accessed by string key and cast at the use site:

```typescript
const due = new Date(row.dueDate as string).getTime();
const fk = row[field] as string;
```

In Swift, this maps to `[String: Any]`. Every field access requires a cast (`as? String`, `as? Int`, etc.), which is verbose but explicit. The alternative — a strongly-typed Row struct — would be a significant redesign (each entity has different columns).

**Hazard**: The TS code freely mixes types within rows. A row can contain `string`, `number`, `boolean`, `null`, `string[]` (for tags), and `Date` (although dates are usually serialised to ISO strings by the JXA bridge). Swift's `Any` doesn't participate in `Equatable` or `Comparable` without casting, so every comparison site needs explicit type-dispatch.

### 3b. LoweredExpr Union Type

```typescript
export type LoweredExpr =
  | string | number | boolean | null
  | { var: string }
  | { type: 'date'; value: string }
  | { op: string; args: LoweredExpr[] }
  | LoweredExpr[];
```

This is a discriminated union dispatched by runtime type checks (`typeof`, `Array.isArray`, `'op' in obj`). Swift's natural translation is an enum:

```swift
indirect enum LoweredExpr {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case variable(String)
    case dateLiteral(String)
    case operation(String, [LoweredExpr])
    case array([LoweredExpr])
}
```

This is actually cleaner than the TS version. **No hazard** — the Swift version would be an improvement.

### 3c. Specifier Union Type

```typescript
export type Specifier =
  | { kind: 'Document' }
  | { kind: 'Elements'; parent: Specifier | Ref; classCode: FourCC }
  | { kind: 'Property'; parent: Specifier | Ref; propCode: FourCC }
  | ...
```

The `parent: Specifier | Ref` field is a union of a recursive enum case and a plain integer. In Swift:

```swift
indirect enum Specifier {
    case document
    case elements(parent: SpecifierOrRef, classCode: FourCC)
    // ...
}
enum SpecifierOrRef {
    case specifier(Specifier)
    case ref(Int)
}
```

Slightly more verbose but fully type-safe. **Low hazard.**

## 4. Date Handling

**Current pattern**:

Three distinct date representations coexist:
1. JXA bridge returns JS `Date` objects from Apple Events
2. `jxaUnit.ts` transforms to ISO strings: `.map(function(v) { return v ? v.toISOString() : null; })`
3. `nodeEval.ts` normalises to epoch-millisecond timestamps for comparison

Swift has `Date` (epoch-seconds `TimeInterval`), and Apple Events return `NSDate`. The serialisation boundary (JXA → JSON → Node) currently uses ISO 8601 strings as the interchange format.

**Hazards**:
- **Epoch units**: JS uses milliseconds, Swift uses seconds. Every arithmetic site (`days * 86400000` in `offset()`) would use the wrong constant if copied literally.
- **ISO 8601 sniffing**: The regex `/^\d{4}-\d{2}-\d{2}/` in `normalize()` decides whether a string should be treated as a date. A Swift port needs the same heuristic or the comparison semantics change. Swift's `ISO8601DateFormatter` is more strict than `Date.parse()`.
- **Timezone sensitivity**: `Date.parse("2026-03-03")` in JS returns UTC midnight; in Swift, `ISO8601DateFormatter` with default options would also return UTC. But `DateFormatter` with `"yyyy-MM-dd"` uses the local timezone. This is a classic source of off-by-one-day bugs.
- **null dates**: OmniFocus returns null/missing for optional dates (no due date). In JS, `null` flows through cleanly. In Swift, `Optional<Date>` requires explicit unwrapping at every site.

**Severity**: Medium. Mostly mechanical but with subtle calendar/timezone traps.

## 5. The JXA Bridge — What Replaces It in Swift?

**Current pattern** (`jxaUnit.ts`, `orchestrator.ts`):

The query engine generates JXA source code as a string, executes it via `osascript` (IPC), and parses the JSON result. The JXA code uses the JavaScript-for-Automation bridge to send Apple Events.

The orchestrator splits the EventPlan into ExecutionUnits by runtime (jxa/node/omniJS), topologically sorts them, fuses consecutive JXA units into composite `osascript` calls, and threads results between units via JSON serialisation.

**Swift alternatives**:

**User: my plan is to use NSAppleScript but to call handlers with hand-built AE Descriptors so we get the right types.**

1. **NSAppleScript / OSAScript** — Runs AppleScript (or JXA) in-process. Still uses Apple Events under the hood. Eliminates the osascript IPC tax (~50ms per call) but keeps the scripting bridge overhead.

2. **NSAppleEventDescriptor directly** — Build and send raw Apple Events using `NSAppleEventDescriptor`. This is what the JXA bridge does internally. Benefits: eliminates JXA bridge tax (2-4x at 8+ properties), precise control over specifiers, no string-template code generation. Costs: extremely verbose API, manual descriptor construction, error handling via `OSStatus`. **User: not easy to send arbitrary apple events without dropping to C APIs.**

3. **ScriptingBridge.framework** — Generates Objective-C headers from the sdef, providing typed method calls. Deprecated in spirit (no new development), but functional. Cannot do bulk reads in the same way as JXA `.property()` array calls.

4. **`AEDescriptor` (Swift 5.9+ / macOS 14+)** — Improved Swift overlay for Apple Events. Still relatively low-level.

5. **OmniJS `evaluateJavascript()`** — Already used as a fallback for complex queries. Could become the primary execution path, running OmniJS scripts via the Omni Automation API. Works from Swift via Apple Events or URL schemes.

**Hazards**:

- **Bulk reads**: The current engine's performance depends on JXA bulk property reads (`doc.flattenedTasks.name()` returns an aligned array in ~140ms). NSAppleEventDescriptor can replicate this by sending a `Get` event with an `Elements` specifier and a `Property` specifier, but constructing the equivalent descriptor tree is non-trivial. ScriptingBridge does not support bulk reads in the same form.

- **Code generation elimination**: The current architecture generates JXA source code at runtime. A Swift port would either: (a) build `NSAppleEventDescriptor` trees programmatically, which eliminates code generation entirely but requires rewriting the entire emitter, or (b) continue generating JXA/AppleScript strings and executing them via NSAppleScript, preserving the architecture but keeping the overhead.

- **App Sandbox**: If the Swift port targets a sandboxed app, Apple Events access requires entitlements and user consent. The current server runs as a Node.js process which inherits the terminal's accessibility permissions. A sandboxed Swift app would need `com.apple.security.automation.apple-events` and a target app entitlement.

- **Specifier reconstruction**: The `jxaUnit.ts` emitter reconstructs AE object specifiers as JXA expressions (e.g., `doc.flattenedTasks.byId(x)`). In Swift with raw Apple Events, this becomes building `NSAppleEventDescriptor` hierarchies: `formUniqueID`, `typeObjectSpecifier`, etc. Every specifier shape (`Elements`, `Property`, `ByID`, `ByName`, `Whose`) needs a descriptor builder.

- **JSON serialisation boundary**: Currently, JXA serialises results to JSON, and Node parses them. A Swift port using in-process Apple Events receives `NSAppleEventDescriptor` reply descriptors, which must be unpacked to Swift types. This is more efficient (no JSON round-trip) but the unpacking code is verbose and type-specific.

**Severity**: High. The JXA bridge is the largest architectural boundary. Choosing the right replacement framework determines the effort for the entire port.

## 6. Dynamic Node Dispatch (`switch` on `node.kind`)

**Current pattern** (throughout):

The codebase uses discriminated unions extensively:
- `EventNode.kind`: 19 variants (Get, Count, Set, Command, ForEach, Zip, Filter, SemiJoin, ...)
- `SetIrNode.kind`: 11 variants (Scan, Filter, Intersect, Union, ...)
- `Specifier.kind`: 7 variants

Each is dispatched via `switch (node.kind)` in multiple places (lowering, emission, execution, walking, optimisation).

**Swift mapping**: Swift enums with associated values and `switch` with exhaustive checking. This is actually better than TS — TypeScript's exhaustive checking via `never` is opt-in and easy to miss, while Swift enforces it by default.

**Hazard**: The SSA index scheme (`Ref = number`, array index into `nodes[]`) maps to `Int` in Swift. The multiple `as Ref` casts in the TS code hint at type confusion that Swift's type system could eliminate by making `Ref` a `struct` with restricted operations.

**Severity**: Low. This is a clean port target.

## 7. Array Alignment Assumptions (Positional AE Bulk Reads)

**Current pattern** (`nodeUnit.ts:execZip`, `jxaUnit.ts:lowerScan`):

The engine's core data model relies on positional alignment of bulk Apple Events reads:

```
flattenedTasks.id()   → ["id1", "id2", "id3", ...]
flattenedTasks.name() → ["Task A", "Task B", "Task C", ...]
flattenedTasks.flagged() → [false, true, false, ...]
```

These parallel arrays are zipped into row objects by position. `Zip` enforces length equality:

```typescript
if (col.values.length !== len) {
    throw new Error(`column '${col.name}' has length ${col.values.length}, expected ${len}`);
}
```

**Hazards**:

- **Atomicity**: The bulk reads are separate Apple Events. If OmniFocus modifies data between reads (e.g., a sync completes), the arrays may become misaligned: task N's name might correspond to task N+1's id if a task was inserted or deleted between reads. The current engine ignores this race condition. A Swift port should consider whether to add any mitigation (e.g., reading all properties in a single Apple Events transaction, if OmniFocus supports it, or validating alignment post-read).

- **Chain property alignment**: `doc.flattenedTasks.containingProject.name()` returns an array aligned with `flattenedTasks`, where each element is the project name (or `null`/missing value for inbox tasks). If the chain property returns missing values for some elements, the alignment is preserved by Apple Events inserting `null`/`missing value` placeholders. This behaviour is AE-runtime-specific and must be verified under the Swift Apple Events API.

- **Nested arrays**: `doc.flattenedTasks.tags.name()` returns `[["tag1"], [], ["tag2","tag3"], ...]` — a nested array aligned with tasks. This works in JXA because the AE runtime returns a list-of-lists. With `NSAppleEventDescriptor`, the reply descriptor's structure may differ and require careful unpacking.

- **Value transforms**: `jxaUnit.ts` applies `.map()` transforms to bulk-read arrays (e.g., `.map(function(v) { return v ? v.toISOString() : null; })` for dates, status enum mapping). These must be applied to the raw descriptor array in the same order. If the descriptor contains `missingValue` descriptors instead of `null`, the transform logic must handle them.

**Severity**: Medium. The pattern itself is simple but the implicit contract with Apple Events alignment is delicate and hard to test without the actual runtime. **User: agreed but it seems to work.**

## 8. Additional Hazards

### 8a. Computed Variable Derivation Duplication

Computed variable logic (e.g., `deriveTaskStatus`) is defined in two places:
- `lowerToSetIr.ts`: as `SwitchCase` predicates (declarative)
- `nodeUnit.ts`: as imperative `deriveTaskStatus()` functions

A Swift port should unify these, but the current duplication means both must be ported and kept in sync until unified.

### 8b. FourCC String Typing

`FourCC` is defined as `type FourCC = string`. The generated `omnifocus-sdef.ts` provides constants (`OFTaskProp.name = 'pnam'`). In Swift, FourCC codes are traditionally `OSType` (UInt32). The mapping from 4-character strings to `OSType` values is well-defined but requires a helper. Using `OSType` would provide better type safety than raw strings. **User: agreed but we might have a custom type that is a bit more readable**

### 8c. Error Handling via Exceptions

The TS code uses `throw new Error(...)` for both programming errors (unknown op, unresolved ref) and runtime errors (misaligned arrays, missing properties). Swift would use a mix of `fatalError()` for programming errors and `throws`/`Result` for recoverable errors. The distinction matters for the orchestrator, which currently catches JXA execution errors and surfaces them.

### 8d. Regex in `matches()` Operator

`new RegExp(pattern, 'i')` creates a case-insensitive regex at compile time. Swift's `NSRegularExpression` has different regex syntax from JS (`\d` works in both, but lookahead/lookbehind, Unicode properties, and named groups differ). User-supplied patterns might break.

### 8e. JSON Serialisation Boundary

The orchestrator serialises cross-unit data as JSON (`JSON.stringify` in JXA → `JSON.parse` in Node). In a pure-Swift port using in-process Apple Events, this boundary may disappear — data stays as Swift types throughout. But if any execution path still involves OmniJS (via `evaluateJavascript()`), JSON remains the interchange format, and the port needs to handle the serialisation/deserialisation for that path.

### 8f. String Interning and Comparison

The TS code relies on JS string interning for efficient equality checks in `Set.has()` and `Map.get()` (used extensively in SemiJoin, HashJoin, Union dedup). Swift `String` comparison is O(n) by default, and `Set<String>` / `Dictionary<String, ...>` use hashing. Performance should be comparable, but if the port uses `NSAppleEventDescriptor` string values without converting to Swift `String`, the hash/equality behaviour may differ.

## Summary Table

| Area | Severity | Effort | Notes |
|---|---|---|---|
| ExprBackend\<T\> protocol | Low | Low | Maps cleanly to associated-type protocol |
| JS coercions in NodeEval | **High** | **High** | Every truthiness/nullability/normalisation path needs explicit handling |
| `any` / duck-typing (Row, LoweredExpr) | Medium | Medium | Enum for AST; `[String: Any]` for rows with cast boilerplate |
| Date handling | Medium | Medium | Epoch units, timezone, ISO sniffing |
| JXA bridge replacement | **High** | **High** | Architectural decision; determines overall port shape |
| Dynamic dispatch on node.kind | Low | Low | Swift enums are better than TS discriminated unions |
| Array alignment | Medium | Low | Implicit AE contract; needs integration testing |
| Computed var duplication | Low | Medium | Opportunity to unify during port |
| FourCC typing | Low | Low | Use `OSType` |
| Regex syntax differences | Low | Low | Document and test |
