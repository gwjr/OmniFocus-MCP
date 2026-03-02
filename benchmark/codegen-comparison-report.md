# Codegen Comparison: Legacy vs EventPlan

Static analysis of emitted JXA scripts for 8 benchmark queries.
No execution against OmniFocus — purely structural comparison.

## Summary

| Query | Entity | Legacy RT | EP RT | Legacy bytes | EP bytes | Delta | Legacy AE | EP AE |
|-------|--------|-----------|-------|-------------|----------|-------|-----------|-------|
| all tasks by name | tasks | 1 | 1 | 1252 | 427 | -66% | 6 | 6 |
| flagged tasks | tasks | 1 | 1 | 1255 | 427 | -66% | 6 | 6 |
| tasks with tag Work | tasks | 1 | 1 | 1094 | 336 | -69% | 5 | 4 |
| tasks due soon | tasks | 1 | 1 | 1145 | 390 | -66% | 5 | 5 |
| active projects | projects | 1 | 1 | 1330 | 425 | -68% | 3 | 2 |
| projects with folderName | projects | 1 | 1 | 2068 | 914 | -56% | 9 | 9 |
| all tags | tags | 1 | 1 | 910 | 267 | -71% | 2 | 2 |
| all folders | folders | 1 | 1 | 689 | 216 | -69% | 1 | 1 |
| **Total** | | **8** | **8** | **9743** | **3402** | **-65%** | | |

## Per-Query Detail

### all tasks by name [tasks]

**Legacy:**
- Scripts: 1, Round-trips: 1
- Size: 1252 bytes, 42 lines
- AE calls: bulk reads 6, .whose() 0, .byId() 0

**EventPlan:**
- JXA scripts: 1, Node units: 1, Round-trips: 1
- JXA size: 427 bytes, 12 lines
- AE calls: bulk reads 6, .whose() 0, .byId() 0
- Units: JXA unit: refs [0,1,2,3,4,5], exports [1,2,3,4,5]; Node unit: refs [6,7,8], ops: [Zip,Filter,Sort]

### flagged tasks [tasks]

**Legacy:**
- Scripts: 1, Round-trips: 1
- Size: 1255 bytes, 42 lines
- AE calls: bulk reads 6, .whose() 0, .byId() 0

**EventPlan:**
- JXA scripts: 1, Node units: 1, Round-trips: 1
- JXA size: 427 bytes, 12 lines
- AE calls: bulk reads 6, .whose() 0, .byId() 0
- Units: JXA unit: refs [0,1,2,3,4,5], exports [1,2,3,4,5]; Node unit: refs [6,7,8,9], ops: [Zip,Filter,Filter,Sort]

### tasks with tag Work [tasks]

**Legacy:**
- Scripts: 1, Round-trips: 1
- Size: 1094 bytes, 39 lines
- AE calls: bulk reads 5, .whose() 0, .byId() 0

**EventPlan:**
- JXA scripts: 1, Node units: 1, Round-trips: 1
- JXA size: 336 bytes, 11 lines
- AE calls: bulk reads 4, .whose() 0, .byId() 0
- Units: JXA unit: refs [0,1,2,3,4], exports [1,2,3,4]; Node unit: refs [5,6,7,8], ops: [Zip,Filter,Filter,Sort]

### tasks due soon [tasks]

**Legacy:**
- Scripts: 1, Round-trips: 1
- Size: 1145 bytes, 41 lines
- AE calls: bulk reads 5, .whose() 0, .byId() 0

**EventPlan:**
- JXA scripts: 1, Node units: 1, Round-trips: 1
- JXA size: 390 bytes, 11 lines
- AE calls: bulk reads 5, .whose() 0, .byId() 0
- Units: JXA unit: refs [0,1,2,3,4], exports [1,2,3,4]; Node unit: refs [5,6,7,8], ops: [Zip,Filter,Filter,Sort]

### active projects [projects]

**Legacy:**
- Scripts: 1, Round-trips: 1
- Size: 1330 bytes, 41 lines
- AE calls: bulk reads 3, .whose() 0, .byId() 0

**EventPlan:**
- JXA scripts: 1, Node units: 1, Round-trips: 1
- JXA size: 425 bytes, 9 lines
- AE calls: bulk reads 2, .whose() 0, .byId() 0
- Units: JXA unit: refs [0,1,2], exports [1,2]; Node unit: refs [3,4,5,6], ops: [Zip,Filter,Filter,Sort]

### projects with folderName [projects]

**Legacy:**
- Scripts: 1, Round-trips: 1
- Size: 2068 bytes, 69 lines
- AE calls: bulk reads 9, .whose() 0, .byId() 0

**EventPlan:**
- JXA scripts: 2, Node units: 2, Round-trips: 1
- JXA size: 914 bytes, 20 lines
- AE calls: bulk reads 9, .whose() 0, .byId() 0
- Units: JXA unit: refs [0,1,2,3,4], exports [1,2,3,4]; JXA unit: refs [7,8,9], exports [8,9]; Node unit: refs [5,6], ops: [Zip,Filter]; Node unit: refs [10,11,12], ops: [Zip,HashJoin,Sort]

### all tags [tags]

**Legacy:**
- Scripts: 1, Round-trips: 1
- Size: 910 bytes, 38 lines
- AE calls: bulk reads 2, .whose() 0, .byId() 0

**EventPlan:**
- JXA scripts: 1, Node units: 1, Round-trips: 1
- JXA size: 267 bytes, 9 lines
- AE calls: bulk reads 2, .whose() 0, .byId() 0
- Units: JXA unit: refs [0,1,2], exports [1,2]; Node unit: refs [3,4,5], ops: [Zip,Filter,Sort]

### all folders [folders]

**Legacy:**
- Scripts: 1, Round-trips: 1
- Size: 689 bytes, 31 lines
- AE calls: bulk reads 1, .whose() 0, .byId() 0

**EventPlan:**
- JXA scripts: 1, Node units: 1, Round-trips: 1
- JXA size: 216 bytes, 8 lines
- AE calls: bulk reads 1, .whose() 0, .byId() 0
- Units: JXA unit: refs [0,1], exports [1]; Node unit: refs [2,3], ops: [Zip,Sort]

## Regression Analysis

No regressions detected.

_Generated 2026-03-02T22:41:28.023Z_
