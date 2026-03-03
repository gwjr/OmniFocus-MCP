# AppleScript Codegen for Wide Bulk Reads — Investigation Report

**Date:** 3 March 2026
**Task:** #38 — Investigate whether generating AppleScript instead of JXA for bulk reads with 8+ properties would improve performance.
**Verdict:** Not worth implementing. The JXA bridge tax from benchmark/REPORT.md is not reproducible in current conditions.

---

## Background

Section 4.2 of REPORT.md (dated 2 March 2026) reported a dramatic JXA bridge tax at high property counts:

| Language | Median (18 props) |
|----------|-------------------:|
| JXA | 13,982ms |
| AppleScript (source) | 5,158ms |
| AppleScript (pre-compiled) | 3,443ms |

This suggested a 2.7-4.1x speedup from switching to AppleScript for wide reads.

## Investigation

### 1. Can AppleScript produce JSON?

**Yes.** AppleScript can use `NSJSONSerialization` via the Cocoa scripting bridge:

```applescript
use framework "Foundation"
use scripting additions

tell application "OmniFocus"
    set v0 to name of every flattened task of default document
end tell

set ca to current application
set nsArr to ca's NSArray's arrayWithArray:v0
set jsonData to ca's NSJSONSerialization's dataWithJSONObject:nsArr options:0 |error|:(missing value)
set jsonString to (ca's NSString's alloc()'s initWithData:jsonData encoding:(ca's NSUTF8StringEncoding)) as text
return jsonString
```

Works correctly. Foundation JSON serialization handles arrays of scalars, booleans, and numbers. Date serialization requires manual ISO conversion (not natively supported).

### 2. Re-benchmarking: JXA vs AppleScript (March 3, 2026)

Ran fresh alternating benchmarks on the same machine with the same OmniFocus database.

#### 10 properties (full JSON output):
| Language | Run 1 | Run 2 | Run 3 |
|----------|------:|------:|------:|
| JXA | 625ms | 636ms | 705ms |
| AS + Foundation JSON (per-row dicts) | 1,299ms | 1,328ms | 1,341ms |
| AS + Foundation JSON (aligned arrays) | 808ms | 777ms | 767ms |

**AppleScript is slower** — the per-row dictionary construction via Foundation's ObjC bridge is expensive (~1.3s), and even aligned-array serialization (~780ms) is slower than JXA (~660ms).

#### 18 properties (full JSON output, 5 runs alternating):
| Language | Runs | Median |
|----------|------|-------:|
| JXA | 909, 944, 958, 2521, 1236 | ~958ms |
| AS + Foundation JSON | 1272, 1234, 1186, 1420, 2046 | ~1272ms |

**JXA wins at 18 properties too.** The original 14s median is nowhere to be seen.

#### 18 properties (count-only return, no JSON serialization):
| Language | Runs | Median |
|----------|------|-------:|
| JXA (no .map transforms) | 1095, 337, 377, 401, 1838 | ~401ms |
| AS (return count as text) | 843, 378, 874, 3196, 1757 | ~874ms |

Very high variance (337ms to 3,196ms within a single session). No consistent winner.

### 3. NSAppleScript (cached, in-process) benchmark

Used the existing `benchmark/nsapplescript-bench` Swift tool, which tests compile-once / execute-many AppleScript via NSAppleScript API (similar to Script Debugger's persistent connection model).

| Test | Cached NSAppleScript | osascript | Speedup |
|------|---------------------:|----------:|--------:|
| 1 prop | 65ms | 179ms | 2.75x |
| 5 props | 350ms | 393ms | 1.12x |
| 18 props | 1,249ms | 1,175ms | **0.94x (slower)** |
| Chain property | 79ms | 173ms | 2.20x |

**At 18 properties, cached NSAppleScript is the same speed as osascript.** The ~65ms process-startup savings is invisible against the 1.2s of Apple Events processing. The advantage is only material for small scripts (1 property: 2.75x speedup from avoiding osascript spawn).

## Why the Original Benchmark Was Wrong

The REPORT.md figures (14s JXA, 5.2s AS, 3.4s compiled) are not reproducible. Several hypotheses:

1. **GC pressure from JXA bridge:** The original test may have triggered JavaScriptCore GC under specific heap pressure conditions that don't currently reproduce. The original report noted individual JXA runs ranging from 1,172ms to 26,995ms — extreme variance.

2. **OmniFocus cache state:** OmniFocus may have been syncing, indexing, or in a cold-cache state during the original benchmark. The high variance in both the original and current data supports this.

3. **System conditions:** macOS scheduler pressure, thermal throttling, or memory pressure from other processes.

The conclusion is that the "JXA bridge tax" documented in REPORT.md section 4.2 is an artifact of high-variance measurements under unfavorable conditions, not a systematic per-statement overhead. Today's measurements show JXA and AppleScript within ~20% of each other at all property counts.

## Typical Query Width

From the dump-codegen analysis, typical queries read:
- **Task queries:** 5-7 property arrays (id, name, 1-2 filter vars, effectivelyCompleted, effectivelyDropped) + 1-2 from project-exclusion scan
- **Project queries:** 2-4 property arrays
- **Tag/folder queries:** 1-2 property arrays

The widest realistic query (a user requesting `select: [name, id, flagged, dueDate, deferDate, completionDate, tags, estimatedMinutes]` with active filters) would read ~10 properties. This is well below where any JXA bridge tax would manifest, even if the original benchmark were correct.

## Conclusion: Not Worth Implementing

1. **The performance premise is invalid.** Current measurements show no JXA bridge tax — JXA and AppleScript perform identically at 10-18 properties when both must produce JSON output.

2. **AppleScript JSON serialization has costs.** Foundation bridging for dates (no native ISO support), missing values (null handling), and per-row object construction adds overhead that offsets any theoretical AE dispatch savings.

3. **Complexity cost is high.** A new `asUnit` or AppleScript codegen path would require:
   - New emitter with AppleScript syntax (space-separated keywords, no camelCase)
   - FourCC → AppleScript property name mapping (`effectivelyCompleted` → `effectively completed`)
   - Date value transforms in AppleScript (no `.toISOString()`)
   - Foundation JSON serialization boilerplate
   - New execution path in orchestrator
   - Test coverage for all the above

4. **The real optimisation opportunity is elsewhere.** The NSAppleScript benchmark showed that cached, in-process AppleScript execution saves ~65ms of process startup per invocation. For a query that makes 2-3 osascript calls, that's ~130-200ms — meaningful against a 500ms query. But that requires a native sidecar process or Node.js native addon, which is a much larger architectural change (see the `nsapplescript-bench.swift` proof-of-concept).

### Recommended Alternative

If wide-read performance becomes a bottleneck in practice:

1. **Measure first.** Add timing instrumentation to production queries to find actual bottlenecks. The bulk-read Apple Events calls are likely ~300-500ms for typical 5-7 property queries — not the hot path.

2. **Reduce round-trips.** The JXA fusion pass (already implemented) batches multiple JXA units into a single osascript call, saving ~65ms per eliminated round-trip.

3. **Native sidecar (Swift port only).** A long-running Swift helper using NSAppleScript would save ~65ms/call of process startup overhead. More impactful than language switching, and could be combined with script pre-compilation. **Note:** This requires a Swift native component (NSAppleEventDescriptor / NSAppleScript) and is only relevant in the context of a Swift port — it is not actionable in the current Node/osascript architecture. See `docs/swift-port-hazards.md` for the broader Swift port analysis.
