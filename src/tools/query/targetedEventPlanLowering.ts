/**
 * targetedEventPlanLowering.ts
 *
 * Assigns a RuntimeAllocation to every node in an EventPlan, producing a
 * TargetedEventPlan. Then splits into ExecutionUnits.
 *
 * Pass 1 — assignRuntimes:
 *   • Nodes with a hint field → fixed(hint.runtime)
 *   • All other nodes        → proposed(defaultRuntime(node))
 *
 * Pass 2 — splitExecutionUnits:
 *   • Partition nodes by effective runtime into contiguous ExecutionUnits
 *   • Compute cross-unit input/output refs and dependsOn links
 */

import type { EventNode, EventPlan, Hinted, Ref, Runtime, RuntimeAllocation, Specifier } from './eventPlan.js';
import type { ExecutionUnit, Input, TargetedEventPlan, TargetedNode } from './targetedEventPlan.js';
import { defaultRuntime, collectRefs } from './eventPlanUtils.js';

// ── Pass 1: assign runtimes ───────────────────────────────────────────────────

export function assignRuntimes(plan: EventPlan): TargetedEventPlan {
  const outNodes: TargetedNode[] = [];

  for (const node of plan.nodes) {
    const isHinted = 'hint' in node;
    const runtimeAllocation: RuntimeAllocation = isHinted
      ? { kind: 'fixed',    runtime: (node as Hinted<EventNode>).hint }
      : { kind: 'proposed', runtime: defaultRuntime(node) };

    // Strip the hint field from the output node — it's been consumed
    const { hint: _hint, ...baseNode } = node as Hinted<EventNode>;
    void _hint;
    outNodes.push({ ...baseNode, runtimeAllocation } as TargetedNode);
  }

  return { nodes: outNodes, result: plan.result };
}

// ── Pass 2: split into ExecutionUnits ────────────────────────────────────────

export function splitExecutionUnits(targeted: TargetedEventPlan): ExecutionUnit[] {
  const { nodes } = targeted;
  if (nodes.length === 0) return [];

  // Walk nodes in SSA order; start a new unit on every runtime boundary.
  // Consecutive nodes with the same runtime merge into one unit.
  const units: ExecutionUnit[] = [];
  const refToUnit = new Map<Ref, ExecutionUnit>();

  let currentRuntime: Runtime = nodes[0].runtimeAllocation.runtime;
  let currentRefs: Ref[] = [0];

  for (let i = 1; i < nodes.length; i++) {
    const rt = nodes[i].runtimeAllocation.runtime;
    if (rt !== currentRuntime) {
      // Flush the current run as a unit
      units.push(buildUnit(currentRuntime, currentRefs, nodes, refToUnit));
      currentRuntime = rt;
      currentRefs = [];
    }
    currentRefs.push(i);
  }
  // Flush the final run
  units.push(buildUnit(currentRuntime, currentRefs, nodes, refToUnit));

  // Compute dependsOn
  for (const unit of units) {
    const deps = new Set<ExecutionUnit>();
    for (const input of unit.inputs) {
      const dep = refToUnit.get(input.ref);
      if (dep && dep !== unit) deps.add(dep);
    }
    unit.dependsOn = [...deps];
  }

  return units;
}

function buildUnit(
  runtime: Runtime,
  nodeRefs: Ref[],
  nodes: TargetedNode[],
  refToUnit: Map<Ref, ExecutionUnit>,
): ExecutionUnit {
  const nodeSet = new Set(nodeRefs);
  const inputSet = new Set<Ref>();
  for (const ref of nodeRefs) {
    for (const inputRef of collectRefs(nodes[ref])) {
      if (!nodeSet.has(inputRef)) {
        inputSet.add(inputRef);
      }
    }
  }

  const sortedInputs = [...inputSet].sort((a, b) => a - b);
  const unit: ExecutionUnit = {
    runtime,
    nodes: nodeRefs,
    inputs: sortedInputs.map(ref => ({ ref, kind: 'value' as const })),
    outputs: [],  // computed by computeBindings after all units are built
    result: nodeRefs[nodeRefs.length - 1],
    dependsOn: [], // filled by caller
  };
  for (const ref of nodeRefs) refToUnit.set(ref, unit);
  return unit;
}

// ── Pass 3: compute cross-unit bindings ──────────────────────────────────────

/**
 * Returns true if a node produces an AE specifier reference rather than
 * a JSON-serializable value. Only Get(Property(...)) materializes — it
 * calls .propCode() and returns actual data. All other Get specifier
 * kinds (Elements, ByID, ByName, ByIndex, Whose, Document) produce AE
 * object specifier references that are NOT JSON-serializable.
 */
function isNonMaterializing(node: EventNode): boolean {
  return node.kind === 'Get' && node.specifier.kind !== 'Property';
}

/**
 * Post-pass after splitExecutionUnits: refine Input/Output bindings.
 *
 * For each cross-unit input ref:
 *   - If the producing node is a non-materializing Get:
 *     • Consuming unit is 'node' → compile error (can't deserialize AE specifiers)
 *     • Consuming unit is 'jxa' → set kind='specifier' with the
 *       specifier from the producing Get, so the emitter can reconstruct it.
 *   - Otherwise: keep kind='value' (JSON-serializable).
 *
 * Also computes output bindings for each unit.
 */
export function computeBindings(
  units: ExecutionUnit[],
  plan: TargetedEventPlan,
): void {
  // Pass 1: refine inputs
  for (const unit of units) {
    const refinedInputs: Input[] = [];
    for (const input of unit.inputs) {
      const producingNode = plan.nodes[input.ref];
      if (producingNode.kind === 'Get' && producingNode.specifier.kind !== 'Property') {
        if (unit.runtime === 'node') {
          throw new Error(
            `compile error: non-serializable AE specifier ref %${input.ref} ` +
            `(Get(${producingNode.specifier.kind})) ` +
            `cannot cross to node execution unit`,
          );
        }
        // JXA: reconstruct specifier in-place
        refinedInputs.push({
          ref: input.ref,
          kind: 'specifier',
          spec: producingNode.specifier,
        });
      } else {
        refinedInputs.push(input);
      }
    }
    unit.inputs = refinedInputs;
  }

  // Pass 2: compute outputs — which refs are consumed by other units?
  for (const unit of units) {
    const nodeSet = new Set(unit.nodes);
    const outputMap = new Map<Ref, 'value' | 'specifier'>();

    for (const other of units) {
      if (other === unit) continue;
      for (const inp of other.inputs) {
        if (nodeSet.has(inp.ref) && !outputMap.has(inp.ref)) {
          outputMap.set(inp.ref, inp.kind === 'specifier' ? 'specifier' : 'value');
        }
      }
    }

    // Always include result — downstream orchestrator reads it
    if (!outputMap.has(unit.result)) {
      const resultNode = plan.nodes[unit.result];
      outputMap.set(
        unit.result,
        isNonMaterializing(resultNode) ? 'specifier' : 'value',
      );
    }

    unit.outputs = [...outputMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ref, kind]) => ({ ref, kind }));
  }
}

// ── Convenience: assign + split + bind in one step ───────────────────────────

export function targetEventPlan(plan: EventPlan): {
  targeted: TargetedEventPlan;
  units: ExecutionUnit[];
} {
  const targeted = assignRuntimes(plan);
  const units = splitExecutionUnits(targeted);
  computeBindings(units, targeted);
  return { targeted, units };
}
