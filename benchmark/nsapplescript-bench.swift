// NSAppleScript Benchmark for OmniFocus
//
// Tests whether NSAppleScript with compile-once / execute-many gives better
// performance than osascript, and whether the in-process Apple Events connection
// stays warm across repeated executions (à la Script Debugger).
//
// Compile:  swiftc -O benchmark/nsapplescript-bench.swift -o benchmark/nsapplescript-bench
// Run:      ./benchmark/nsapplescript-bench
//
// On first run, macOS will prompt for permission to control OmniFocus — approve it.
// OmniFocus must be running.

import Foundation

// ── AppleScript sources ───────────────────────────────────────────────────────

// 1 property: baseline
let script1prop = """
tell application "OmniFocus"
  tell default document
    set v0 to name of every flattened task
    return (count of v0) as text
  end tell
end tell
"""

// 5 properties: moderate load
let script5props = """
tell application "OmniFocus"
  tell default document
    set v0 to name of every flattened task
    set v1 to id of every flattened task
    set v2 to flagged of every flattened task
    set v3 to completed of every flattened task
    set v4 to due date of every flattened task
    return (count of v0) as text
  end tell
end tell
"""

// 18 properties: the heavy case where pre-compiled .scpt was 4.1× faster than JXA
let script18props = """
tell application "OmniFocus"
  tell default document
    set v0 to name of every flattened task
    set v1 to id of every flattened task
    set v2 to flagged of every flattened task
    set v3 to completed of every flattened task
    set v4 to dropped of every flattened task
    set v5 to due date of every flattened task
    set v6 to defer date of every flattened task
    set v7 to completion date of every flattened task
    set v8 to modification date of every flattened task
    set v9 to creation date of every flattened task
    set v10 to estimated minutes of every flattened task
    set v11 to blocked of every flattened task
    set v12 to effectively completed of every flattened task
    set v13 to effectively dropped of every flattened task
    set v14 to sequential of every flattened task
    set v15 to in inbox of every flattened task
    set v16 to next of every flattened task
    set v17 to repetition rule of every flattened task
    return (count of v0) as text
  end tell
end tell
"""

// Chain property: containingProject.name — the case with high variance in osascript
let scriptChain = """
tell application "OmniFocus"
  tell default document
    set v0 to name of containing project of every flattened task
    return (count of v0) as text
  end tell
end tell
"""

// ── Timing ───────────────────────────────────────────────────────────────────

func nowMs() -> Double {
    return ProcessInfo.processInfo.systemUptime * 1000.0
}

func median(_ arr: [Double]) -> Double {
    let s = arr.sorted()
    return s[s.count / 2]
}

func fmt(_ ms: Double) -> String {
    return String(format: "%.0fms", ms)
}

func fmtArr(_ arr: [Double]) -> String {
    return "[" + arr.map { fmt($0) }.joined(separator: ", ") + "]"
}

// ── NSAppleScript execution modes ─────────────────────────────────────────────

struct FreshResult {
    let compileMs: Double
    let execMs: Double
    let error: String?
}

/// Compile and execute from scratch on every call.
func runFresh(source: String) -> FreshResult {
    guard let script = NSAppleScript(source: source) else {
        return FreshResult(compileMs: 0, execMs: 0, error: "NSAppleScript(source:) returned nil")
    }
    var err: NSDictionary?
    let t0 = nowMs()
    let ok = script.compileAndReturnError(&err)
    let compileMs = nowMs() - t0
    guard ok else {
        return FreshResult(compileMs: compileMs, execMs: 0, error: err?.description)
    }
    var err2: NSDictionary?
    let t1 = nowMs()
    script.executeAndReturnError(&err2)
    let execMs = nowMs() - t1
    return FreshResult(compileMs: compileMs, execMs: execMs, error: err2?.description)
}

/// A compiled NSAppleScript held in memory — the cached path.
class CachedScript {
    let source: String
    let compileMs: Double
    private let script: NSAppleScript

    init?(source: String) {
        guard let s = NSAppleScript(source: source) else { return nil }
        var err: NSDictionary?
        let t0 = nowMs()
        guard s.compileAndReturnError(&err) else {
            print("  Compile error: \(err?.description ?? "unknown")")
            return nil
        }
        self.compileMs = nowMs() - t0
        self.source = source
        self.script = s
    }

    func execute() -> (ms: Double, error: String?) {
        var err: NSDictionary?
        let t0 = nowMs()
        script.executeAndReturnError(&err)
        return (nowMs() - t0, err?.description)
    }
}

/// Baseline: spawn osascript process from a temp file (same as existing TypeScript benchmarks).
func runOsascript(source: String) -> Double {
    let path = (NSTemporaryDirectory() as NSString).appendingPathComponent(
        "bench_\(Int(Date().timeIntervalSince1970 * 1000)).applescript"
    )
    do {
        try source.write(toFile: path, atomically: true, encoding: .utf8)
    } catch {
        print("  Error writing temp file: \(error)")
        return -1
    }
    defer { try? FileManager.default.removeItem(atPath: path) }

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    proc.arguments = [path]
    proc.standardOutput = Pipe()
    proc.standardError = Pipe()

    let t0 = nowMs()
    do {
        try proc.run()
    } catch {
        print("  Error launching osascript: \(error)")
        return -1
    }
    proc.waitUntilExit()
    return nowMs() - t0
}

// ── Benchmark runner ──────────────────────────────────────────────────────────

struct BenchResult {
    let label: String
    let propCount: Int
    let freshCompile: [Double]
    let freshExec: [Double]
    let cachedExec: [Double]
    let cachedCompileMs: Double  // one-time cost
    let osascript: [Double]
}

func runBench(label: String, propCount: Int, source: String, n: Int, warmup: Int) -> BenchResult {
    print("── \(label) (\(propCount) prop\(propCount == 1 ? "" : "s")) ──")

    // Warmup using osascript (wakes OmniFocus, primes IPC)
    print("  Warmup (\(warmup) osascript runs)...", terminator: "")
    fflush(stdout)
    for _ in 0..<warmup {
        _ = runOsascript(source: source)
        print(".", terminator: "")
        fflush(stdout)
    }
    print()

    // Build the cached script
    print("  Compiling cached NSAppleScript...", terminator: "")
    fflush(stdout)
    guard let cached = CachedScript(source: source) else {
        fatalError("Failed to compile CachedScript for \(label)")
    }
    print(" \(fmt(cached.compileMs))")

    // Warmup the cached script path (first execute is often slower)
    print("  Warmup cached execute...", terminator: "")
    fflush(stdout)
    for _ in 0..<warmup {
        let (_, e) = cached.execute()
        if let e = e { print("\n  Cached warmup error: \(e)") }
        print(".", terminator: "")
        fflush(stdout)
    }
    print()

    var freshCompile: [Double] = []
    var freshExec: [Double] = []
    var cachedExec: [Double] = []
    var osascriptMs: [Double] = []

    print("  Timing \(n) runs (fresh / cached / osascript)...", terminator: "")
    fflush(stdout)

    for _ in 0..<n {
        // Fresh NSAppleScript
        let fr = runFresh(source: source)
        if let e = fr.error { print("\n  Fresh error: \(e)") }
        freshCompile.append(fr.compileMs)
        freshExec.append(fr.execMs)

        // Cached NSAppleScript
        let (cms, ce) = cached.execute()
        if let ce = ce { print("\n  Cached error: \(ce)") }
        cachedExec.append(cms)

        // osascript baseline
        osascriptMs.append(runOsascript(source: source))

        print(".", terminator: "")
        fflush(stdout)
    }
    print()

    return BenchResult(
        label: label,
        propCount: propCount,
        freshCompile: freshCompile,
        freshExec: freshExec,
        cachedExec: cachedExec,
        cachedCompileMs: cached.compileMs,
        osascript: osascriptMs
    )
}

func printResult(_ r: BenchResult) {
    let freshTotal = zip(r.freshCompile, r.freshExec).map { $0 + $1 }
    let fm_freshCompile = median(r.freshCompile)
    let fm_freshExec = median(r.freshExec)
    let fm_freshTotal = median(freshTotal)
    let fm_cached = median(r.cachedExec)
    let fm_osa = median(r.osascript)

    print()
    print("### \(r.label) (\(r.propCount) prop\(r.propCount == 1 ? "" : "s"))")
    print()
    print("  Fresh NSAppleScript (compile+exec each time):")
    print("    compile:  \(fmtArr(r.freshCompile))  median=\(fmt(fm_freshCompile))")
    print("    exec:     \(fmtArr(r.freshExec))  median=\(fmt(fm_freshExec))")
    print("    total:    \(fmtArr(freshTotal))  median=\(fmt(fm_freshTotal))")
    print()
    print("  Cached NSAppleScript (compile once, exec only):")
    print("    compile:  \(fmt(r.cachedCompileMs)) (one-time)")
    print("    exec:     \(fmtArr(r.cachedExec))  median=\(fmt(fm_cached))")
    print()
    print("  osascript baseline:")
    print("    total:    \(fmtArr(r.osascript))  median=\(fmt(fm_osa))")
    print()

    let cachedVsOsa = fm_osa / fm_cached
    let freshVsOsa  = fm_osa / fm_freshTotal

    print("  ┌─────────────────────────────────────────────────────┐")
    print("  │ osascript median:       \(fmt(fm_osa).padding(toLength: 8, withPad: " ", startingAt: 0)) (baseline)              │")
    print("  │ Fresh NSAppleScript:    \(fmt(fm_freshTotal).padding(toLength: 8, withPad: " ", startingAt: 0)) (\(String(format: "%.2f", freshVsOsa))× vs osascript)   │")
    print("  │ Cached NSAppleScript:   \(fmt(fm_cached).padding(toLength: 8, withPad: " ", startingAt: 0)) (\(String(format: "%.2f", cachedVsOsa))× vs osascript)   │")
    print("  │ One-time compile cost:  \(fmt(r.cachedCompileMs).padding(toLength: 8, withPad: " ", startingAt: 0))                          │")
    print("  └─────────────────────────────────────────────────────┘")

    // Break-even: how many queries to amortise the compile cost?
    let savedPerQuery = fm_osa - fm_cached
    if savedPerQuery > 0 {
        let breakEven = Int(ceil(r.cachedCompileMs / savedPerQuery))
        print("  Break-even (compile amortised at \(fmt(savedPerQuery))/query saved): \(breakEven) queries")
    } else {
        print("  Note: cached is not faster than osascript (no amortisation advantage)")
    }
}

// ── IPC floor measurement ─────────────────────────────────────────────────────
//
// Isolates the Swift-side IPC cost from the rest of the pipeline.
// The existing benchmark measured ~100ms floor via osascript (including ~26ms
// process spawn). We want to know the floor *from Swift* with NSAppleScript.

// Trivial script: just count tasks (one round-trip, minimal data)
let scriptIPCFloor = """
tell application "OmniFocus"
  tell default document
    return (count of flattened tasks) as text
  end tell
end tell
"""

// Even more trivial: no collection, just version string — pure handshake cost
let scriptHandshake = """
tell application "OmniFocus"
  return version
end tell
"""

func runIPCFloor(n: Int, warmup: Int) {
    print("── IPC Floor from Swift ──")
    print("  Measures the minimum Apple Events round-trip cost when calling")
    print("  OmniFocus from within a native Swift process (no osascript spawn).")
    print()

    // Compile both scripts once
    guard let handshakeScript = CachedScript(source: scriptHandshake),
          let floorScript = CachedScript(source: scriptIPCFloor) else {
        print("  ERROR: Could not compile IPC floor scripts")
        return
    }

    print("  Warmup (\(warmup) runs)...", terminator: "")
    fflush(stdout)
    for _ in 0..<warmup {
        _ = handshakeScript.execute()
        _ = floorScript.execute()
        print(".", terminator: "")
        fflush(stdout)
    }
    print()

    var handshakeMs: [Double] = []
    var countMs: [Double] = []
    var osaHandshakeMs: [Double] = []
    var osaCountMs: [Double] = []

    print("  Timing \(n) runs...", terminator: "")
    fflush(stdout)
    for _ in 0..<n {
        let (h, _) = handshakeScript.execute()
        handshakeMs.append(h)

        let (c, _) = floorScript.execute()
        countMs.append(c)

        // osascript equivalents for comparison
        osaHandshakeMs.append(runOsascript(source: scriptHandshake))
        osaCountMs.append(runOsascript(source: scriptIPCFloor))

        print(".", terminator: "")
        fflush(stdout)
    }
    print()

    let hMed  = median(handshakeMs)
    let cMed  = median(countMs)
    let ohMed = median(osaHandshakeMs)
    let ocMed = median(osaCountMs)

    print()
    print("  ┌────────────────────────────────────────────────────────────────┐")
    print("  │ Operation              NSAppleScript   osascript   Δ (saved)   │")
    print("  │ ─────────────────────────────────────────────────────────────  │")
    print("  │ Handshake (version)    \(fmt(hMed).padding(toLength: 14, withPad: " ", startingAt: 0))  \(fmt(ohMed).padding(toLength: 10, withPad: " ", startingAt: 0))  \(fmt(ohMed - hMed).padding(toLength: 10, withPad: " ", startingAt: 0))│")
    print("  │ Count tasks            \(fmt(cMed).padding(toLength: 14, withPad: " ", startingAt: 0))  \(fmt(ocMed).padding(toLength: 10, withPad: " ", startingAt: 0))  \(fmt(ocMed - cMed).padding(toLength: 10, withPad: " ", startingAt: 0))│")
    print("  └────────────────────────────────────────────────────────────────┘")
    print()
    print("  Raw NSAppleScript handshake: \(fmtArr(handshakeMs))  median=\(fmt(hMed))")
    print("  Raw NSAppleScript count:     \(fmtArr(countMs))  median=\(fmt(cMed))")
    print("  Raw osascript handshake:     \(fmtArr(osaHandshakeMs))  median=\(fmt(ohMed))")
    print("  Raw osascript count:         \(fmtArr(osaCountMs))  median=\(fmt(ocMed))")
    print()
    print("  Reference (REPORT.md §1): bare osascript process startup = ~26ms")
    print("  Reference (REPORT.md §2): IPC floor via osascript = ~100-120ms")
    print("  Expected: NSAppleScript ≈ IPC floor minus ~26ms process spawn savings")
    print("  If NSAppleScript handshake < 10ms → connection is persistent/cached")
    print()
}

// ── Main ──────────────────────────────────────────────────────────────────────

let N = 10
let WARMUP = 3

print("# NSAppleScript vs osascript — OmniFocus Bulk Read Benchmark")
print("# \(N) timed runs per path, \(WARMUP) warmup runs, OmniFocus must be running")
print("# Compile: swiftc -O benchmark/nsapplescript-bench.swift -o benchmark/nsapplescript-bench")
print()

// IPC floor first
runIPCFloor(n: N, warmup: WARMUP)
print()

let benches: [(label: String, props: Int, source: String)] = [
    ("name only",       1,  script1prop),
    ("5 properties",    5,  script5props),
    ("18 properties",   18, script18props),
    ("chain: containingProject.name", 1, scriptChain),
]

var results: [BenchResult] = []

for (label, props, src) in benches {
    let r = runBench(label: label, propCount: props, source: src, n: N, warmup: WARMUP)
    results.append(r)
    print()
}

// ── Summary table ─────────────────────────────────────────────────────────────

print("\n" + String(repeating: "═", count: 70))
print("## RESULTS")
print(String(repeating: "═", count: 70))

for r in results {
    printResult(r)
    print()
}

// Reference from existing benchmarks (§4.2 and §9 of REPORT.md)
print(String(repeating: "─", count: 70))
print("## Reference (from existing osascript benchmarks in REPORT.md)")
print("  JXA 18 props median:          13,982ms")
print("  AS source 18 props median:     5,158ms")
print("  AS pre-compiled (.scpt) 18p:   3,443ms")
print("  Script Debugger (persistent):  35–89ms  ← target to beat")
print()
print("Done.")
