/**
 * EventPlan & TargetedEventPlan debug pretty-printers.
 *
 * Produces SSA-style text representations for debugging and logging.
 * Not used in production execution paths.
 */

import type { EventPlan, EventNode, Specifier, Ref } from './eventPlan.js';
import type { ExecutionUnit, TargetedEventPlan } from './targetedEventPlan.js';
import type { Kind } from './eventNodeRegistry.js';

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

type DescribeEntry = (node: EventNode, lhs: string, idx: string, prefix: string) => string[];

/**
 * Typed registry defining how each EventNode kind is pretty-printed.
 * Adding a new kind without an entry is a compile error.
 */
const DESCRIBE_NODE: { [K in Kind]: DescribeEntry } = {

  Get(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Get' }>;
    return [`${lhs} = Get(${describeSpecifier(n.specifier)})`];
  },

  Count(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Count' }>;
    return [`${lhs} = Count(${describeSpecifier(n.specifier)})`];
  },

  Set(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Set' }>;
    return [`${lhs} = Set(${describeSpecifier(n.specifier)}, ${fmtRef(n.value)})`];
  },

  Command(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Command' }>;
    const args = Object.entries(n.args)
      .map(([k, v]) => {
        const vs = typeof v === 'number' ? fmtRef(v) : typeof v === 'string' ? `'${v}'` : String(v);
        return `${k}:${vs}`;
      })
      .join(', ');
    return [`${lhs} = Command('${n.fourCC}', ${describeSpecifier(n.target)}, {${args}})`];
  },

  Zip(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Zip' }>;
    const cols = n.columns.map(c => `${c.name}:${fmtRef(c.ref)}`).join(', ');
    return [`${lhs} = Zip([${cols}])`];
  },

  ColumnValues(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'ColumnValues' }>;
    return [`${lhs} = ColumnValues(${fmtRef(n.source)}, '${n.field}')`];
  },

  Flatten(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Flatten' }>;
    return [`${lhs} = Flatten(${fmtRef(n.source)})`];
  },

  Filter(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Filter' }>;
    return [`${lhs} = Filter(${fmtRef(n.source)}, ${JSON.stringify(n.predicate)})`];
  },

  SemiJoin(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'SemiJoin' }>;
    const fieldPart = n.field && n.field !== 'id' ? `, field:'${n.field}'` : '';
    const arrayPart = n.arrayField ? ', arrayField' : '';
    const excludePart = n.exclude ? ', exclude' : '';
    return [`${lhs} = SemiJoin(${fmtRef(n.source)}, ids:${fmtRef(n.ids)}${fieldPart}${arrayPart}${excludePart})`];
  },

  HashJoin(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'HashJoin' }>;
    const fm = Object.entries(n.fieldMap).map(([k, v]) => `${k}:${v}`).join(', ');
    return [`${lhs} = HashJoin(${fmtRef(n.source)}, ${fmtRef(n.lookup)}, sourceKey:'${n.sourceKey}', lookupKey:'${n.lookupKey}', {${fm}})`];
  },

  Sort(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Sort' }>;
    return [`${lhs} = Sort(${fmtRef(n.source)}, by:'${n.by}', dir:${n.dir})`];
  },

  Limit(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Limit' }>;
    return [`${lhs} = Limit(${fmtRef(n.source)}, n:${n.n})`];
  },

  Pick(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Pick' }>;
    return [`${lhs} = Pick(${fmtRef(n.source)}, [${n.fields.join(',')}])`];
  },

  Derive(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Derive' }>;
    const specs = n.derivations.map(d => `${d.var}@${d.entity}`).join(', ');
    return [`${lhs} = Derive(${fmtRef(n.source)}, [${specs}])`];
  },

  Union(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'Union' }>;
    return [`${lhs} = Union(${fmtRef(n.left)}, ${fmtRef(n.right)})`];
  },

  SetOp(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'SetOp' }>;
    return [`${lhs} = SetOp(${fmtRef(n.left)}, ${fmtRef(n.right)}, op:'${n.op}')`];
  },

  RowCount(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'RowCount' }>;
    return [`${lhs} = RowCount(${fmtRef(n.source)})`];
  },

  AddSwitch(node, lhs) {
    const n = node as Extract<EventNode, { kind: 'AddSwitch' }>;
    const defStr = n.default === 'error' ? 'Error' : JSON.stringify(n.default);
    return [`${lhs} = AddSwitch(${fmtRef(n.source)}, '${n.column}', ${n.cases.length} cases, default:${defStr})`];
  },

  ForEach(node, lhs, idx, prefix) {
    const n = node as Extract<EventNode, { kind: 'ForEach' }>;
    const lines: string[] = [];
    lines.push(`${lhs} = ForEach(${fmtRef(n.source)}) {`);
    for (let j = 0; j < n.body.length; j++) {
      lines.push(...describeNode(n.body[j], `${idx}.${j}`, `${prefix}  `));
    }
    lines.push(`${prefix}  collect: %${idx}.${n.collect}`);
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
  return DESCRIBE_NODE[node.kind](node, lhs, idx, prefix);
}
