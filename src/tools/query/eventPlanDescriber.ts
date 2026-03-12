/**
 * EventPlan & TargetedEventPlan debug pretty-printers.
 *
 * Produces SSA-style text representations for debugging and logging.
 * Not used in production execution paths.
 */

import type { EventPlan, EventNode, Specifier, Ref } from './eventPlan.js';
import type { ExecutionUnit, TargetedEventPlan } from './targetedEventPlan.js';
import type { Kind } from './eventNodeRegistry.js';
import { dispatchByKind4 } from './eventNodeRegistry.js';

// ── Public API ──────────────────────────────────────────────────────────

export function describeEventPlan(plan: EventPlan): string {
  const lines: string[] = [];
  for (let i = 0; i < plan.nodes.length; i++) {
    lines.push(...describeNode(plan.nodes[i], String(i), ''));
  }
  lines.push(`result: %${plan.result}`);
  return lines.join('\n');
}

export function describeTargetedEventPlan(plan: TargetedEventPlan, units?: ExecutionUnit[]): string {
  const lines: string[] = [];

  if (units) {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      lines.push(`${'─'.repeat(2)} unit ${i} [${unit.runtime}] ${'─'.repeat(40)}`);
      for (const ref of unit.nodes) {
        const node = plan.nodes[ref];
        const alloc = node.runtimeAllocation;
        const suffix = `[${alloc.runtime} ${alloc.kind}]`;
        const nodeLines = describeNode(node, String(ref), '');
        for (let j = 0; j < nodeLines.length; j++) {
          if (j === 0) {
            const pad = Math.max(1, 45 - nodeLines[j].length);
            lines.push(`${nodeLines[j]}${' '.repeat(pad)}${suffix}`);
          } else {
            lines.push(nodeLines[j]);
          }
        }
      }
    }
  } else {
    for (let i = 0; i < plan.nodes.length; i++) {
      const node = plan.nodes[i];
      const alloc = node.runtimeAllocation;
      const suffix = `[${alloc.runtime} ${alloc.kind}]`;
      const nodeLines = describeNode(node, String(i), '');
      for (let j = 0; j < nodeLines.length; j++) {
        if (j === 0) {
          const pad = Math.max(1, 45 - nodeLines[j].length);
          lines.push(`${nodeLines[j]}${' '.repeat(pad)}${suffix}`);
        } else {
          lines.push(nodeLines[j]);
        }
      }
    }
  }

  lines.push(`result: %${plan.result}`);
  return lines.join('\n');
}

export function describeSpecifier(spec: Specifier): string {
  switch (spec.kind) {
    case 'Document':
      return 'Document';
    case 'Elements':
      return `Elements(${fmtParent(spec.parent)}, '${spec.classCode}')`;
    case 'Property':
      return `Property(${fmtParent(spec.parent)}, '${spec.propCode}')`;
    case 'ByID': {
      const idStr = typeof spec.id === 'number' ? `%${spec.id}` : `'${spec.id}'`;
      return `ByID(${fmtParent(spec.parent)}, ${idStr})`;
    }
    case 'ByName': {
      const nameStr = typeof spec.name === 'number' ? `%${spec.name}` : `'${spec.name}'`;
      return `ByName(${fmtParent(spec.parent)}, ${nameStr})`;
    }
    case 'ByIndex':
      return `ByIndex(${fmtParent(spec.parent)}, ${spec.index})`;
    case 'Whose':
      return `Whose(${fmtParent(spec.parent)}, '${spec.prop}', ${spec.match}, '${spec.value}')`;
  }
}

export function describeExecutionUnit(unit: ExecutionUnit, plan: TargetedEventPlan, unitIndex?: number): string {
  const lines: string[] = [];
  const label = unitIndex != null ? `unit ${unitIndex}` : 'unit';
  lines.push(`${label} [${unit.runtime}]`);
  lines.push(`  nodes: [${unit.nodes.map(r => `%${r}`).join(', ')}]`);
  if (unit.inputs.length > 0) {
    lines.push(`  inputs: [${unit.inputs.map(i => `%${i.ref}${i.kind === 'specifier' ? '(spec)' : ''}`).join(', ')}]`);
  }
  lines.push(`  result: %${unit.result}`);
  if (unit.dependsOn.length > 0) {
    lines.push(`  dependsOn: ${unit.dependsOn.length} unit(s)`);
  }
  for (const ref of unit.nodes) {
    const node = plan.nodes[ref];
    const alloc = node.runtimeAllocation;
    const suffix = `[${alloc.runtime} ${alloc.kind}]`;
    const nodeLines = describeNode(node, String(ref), '  ');
    for (let j = 0; j < nodeLines.length; j++) {
      if (j === 0) {
        const pad = Math.max(1, 45 - nodeLines[j].length);
        lines.push(`${nodeLines[j]}${' '.repeat(pad)}${suffix}`);
      } else {
        lines.push(nodeLines[j]);
      }
    }
  }
  return lines.join('\n');
}

// ── Internals ───────────────────────────────────────────────────────────

function fmtParent(parent: Specifier | Ref): string {
  return typeof parent === 'number' ? `%${parent}` : describeSpecifier(parent);
}

function fmtRef(r: Ref): string {
  return `%${r}`;
}

// ── Describer registry ───────────────────────────────────────────────────

/**
 * Per-kind narrowed describer registry. Each entry receives its specific
 * EventNode variant — no local casts needed. Adding a new kind without
 * an entry is a compile error.
 */
type DescriberRegistry = {
  [K in Kind]: (node: Extract<EventNode, { kind: K }>, lhs: string, idx: string, prefix: string) => string[];
};

const DESCRIBE_NODE: DescriberRegistry = {

  Get: (node, lhs) =>
    [`${lhs} = Get(${describeSpecifier(node.specifier)})`],

  Count: (node, lhs) =>
    [`${lhs} = Count(${describeSpecifier(node.specifier)})`],

  Set: (node, lhs) =>
    [`${lhs} = Set(${describeSpecifier(node.specifier)}, ${fmtRef(node.value)})`],

  Command: (node, lhs) => {
    const args = Object.entries(node.args)
      .map(([k, v]) => {
        const vs = typeof v === 'number' ? fmtRef(v) : typeof v === 'string' ? `'${v}'` : String(v);
        return `${k}:${vs}`;
      })
      .join(', ');
    return [`${lhs} = Command('${node.fourCC}', ${describeSpecifier(node.target)}, {${args}})`];
  },

  Zip: (node, lhs) => {
    const cols = node.columns.map(c => `${c.name}:${fmtRef(c.ref)}`).join(', ');
    return [`${lhs} = Zip([${cols}])`];
  },

  ColumnValues: (node, lhs) =>
    [`${lhs} = ColumnValues(${fmtRef(node.source)}, '${node.field}')`],

  Flatten: (node, lhs) =>
    [`${lhs} = Flatten(${fmtRef(node.source)})`],

  Filter: (node, lhs) =>
    [`${lhs} = Filter(${fmtRef(node.source)}, ${JSON.stringify(node.predicate)})`],

  SemiJoin: (node, lhs) => {
    const fieldPart = node.field && node.field !== 'id' ? `, field:'${node.field}'` : '';
    const arrayPart = node.arrayField ? ', arrayField' : '';
    const excludePart = node.exclude ? ', exclude' : '';
    return [`${lhs} = SemiJoin(${fmtRef(node.source)}, ids:${fmtRef(node.ids)}${fieldPart}${arrayPart}${excludePart})`];
  },

  HashJoin: (node, lhs) => {
    const fm = Object.entries(node.fieldMap).map(([k, v]) => `${k}:${v}`).join(', ');
    return [`${lhs} = HashJoin(${fmtRef(node.source)}, ${fmtRef(node.lookup)}, sourceKey:'${node.sourceKey}', lookupKey:'${node.lookupKey}', {${fm}})`];
  },

  Sort: (node, lhs) =>
    [`${lhs} = Sort(${fmtRef(node.source)}, by:'${node.by}', dir:${node.dir})`],

  Limit: (node, lhs) =>
    [`${lhs} = Limit(${fmtRef(node.source)}, n:${node.n})`],

  Pick: (node, lhs) =>
    [`${lhs} = Pick(${fmtRef(node.source)}, [${node.fields.join(',')}])`],

  Derive: (node, lhs) => {
    const specs = node.derivations.map(d => `${d.var}@${d.entity}`).join(', ');
    return [`${lhs} = Derive(${fmtRef(node.source)}, [${specs}])`];
  },

  Union: (node, lhs) =>
    [`${lhs} = Union(${fmtRef(node.left)}, ${fmtRef(node.right)})`],

  SetOp: (node, lhs) =>
    [`${lhs} = SetOp(${fmtRef(node.left)}, ${fmtRef(node.right)}, op:'${node.op}')`],

  RowCount: (node, lhs) =>
    [`${lhs} = RowCount(${fmtRef(node.source)})`],

  AddSwitch: (node, lhs) => {
    const defStr = node.default === 'error' ? 'Error' : JSON.stringify(node.default);
    return [`${lhs} = AddSwitch(${fmtRef(node.source)}, '${node.column}', ${node.cases.length} cases, default:${defStr})`];
  },

  ForEach: (node, lhs, idx, prefix) => {
    const lines: string[] = [];
    lines.push(`${lhs} = ForEach(${fmtRef(node.source)}) {`);
    for (let j = 0; j < node.body.length; j++) {
      lines.push(...describeNode(node.body[j], `${idx}.${j}`, `${prefix}  `));
    }
    lines.push(`${prefix}  collect: %${idx}.${node.collect}`);
    lines.push(`${prefix}}`);
    return lines;
  },
};

/**
 * Describe a single EventNode. `idx` is the display label — either a
 * plain number string ("3") for top-level nodes, or a scoped string
 * ("5.0") for ForEach body nodes.
 */
function describeNode(node: EventNode, idx: string, prefix: string): string[] {
  const lhs = `${prefix}%${idx}`;
  return dispatchByKind4(DESCRIBE_NODE, node, lhs, idx, prefix);
}
