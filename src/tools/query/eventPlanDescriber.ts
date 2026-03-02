/**
 * EventPlan & TargetedEventPlan debug pretty-printers.
 *
 * Produces SSA-style text representations for debugging and logging.
 * Not used in production execution paths.
 */

import type { EventPlan, EventNode, Specifier, Ref } from './eventPlan.js';
import type { ExecutionUnit, TargetedEventPlan } from './targetedEventPlan.js';

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
  }
}

export function describeExecutionUnit(unit: ExecutionUnit, plan: TargetedEventPlan, unitIndex?: number): string {
  const lines: string[] = [];
  const label = unitIndex != null ? `unit ${unitIndex}` : 'unit';
  lines.push(`${label} [${unit.runtime}]`);
  lines.push(`  nodes: [${unit.nodes.map(r => `%${r}`).join(', ')}]`);
  if (unit.inputs.length > 0) {
    lines.push(`  inputs: [${unit.inputs.map(r => `%${r}`).join(', ')}]`);
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

/**
 * Describe a single EventNode. `idx` is the display label — either a
 * plain number string ("3") for top-level nodes, or a scoped string
 * ("5.0") for ForEach body nodes.
 */
function describeNode(node: EventNode, idx: string, prefix: string): string[] {
  const lhs = `${prefix}%${idx}`;

  switch (node.kind) {
    case 'Get':
      return [`${lhs} = Get(${describeSpecifier(node.specifier)})`];

    case 'Count':
      return [`${lhs} = Count(${describeSpecifier(node.specifier)})`];

    case 'Set':
      return [`${lhs} = Set(${describeSpecifier(node.specifier)}, ${fmtRef(node.value)})`];

    case 'Command': {
      const args = Object.entries(node.args)
        .map(([k, v]) => {
          const vs = typeof v === 'number' ? fmtRef(v) : typeof v === 'string' ? `'${v}'` : String(v);
          return `${k}:${vs}`;
        })
        .join(', ');
      return [`${lhs} = Command('${node.fourCC}', ${describeSpecifier(node.target)}, {${args}})`];
    }

    case 'Zip': {
      const cols = node.columns.map(c => `${c.name}:${fmtRef(c.ref)}`).join(', ');
      return [`${lhs} = Zip([${cols}])`];
    }

    case 'ColumnValues':
      return [`${lhs} = ColumnValues(${fmtRef(node.source)}, '${node.field}')`];

    case 'Flatten':
      return [`${lhs} = Flatten(${fmtRef(node.source)})`];

    case 'Filter':
      return [`${lhs} = Filter(${fmtRef(node.source)}, ${JSON.stringify(node.predicate)})`];

    case 'SemiJoin':
      return [`${lhs} = SemiJoin(${fmtRef(node.source)}, ids:${fmtRef(node.ids)})`];

    case 'HashJoin': {
      const fm = Object.entries(node.fieldMap).map(([k, v]) => `${k}:${v}`).join(', ');
      return [`${lhs} = HashJoin(${fmtRef(node.source)}, ${fmtRef(node.lookup)}, sourceKey:'${node.sourceKey}', lookupKey:'${node.lookupKey}', {${fm}})`];
    }

    case 'Sort':
      return [`${lhs} = Sort(${fmtRef(node.source)}, by:'${node.by}', dir:${node.dir})`];

    case 'Limit':
      return [`${lhs} = Limit(${fmtRef(node.source)}, n:${node.n})`];

    case 'Pick':
      return [`${lhs} = Pick(${fmtRef(node.source)}, [${node.fields.join(',')}])`];

    case 'Derive': {
      const specs = node.derivations.map(d => `${d.var}@${d.entity}`).join(', ');
      return [`${lhs} = Derive(${fmtRef(node.source)}, [${specs}])`];
    }

    case 'ForEach': {
      const lines: string[] = [];
      lines.push(`${lhs} = ForEach(${fmtRef(node.source)}) {`);
      for (let j = 0; j < node.body.length; j++) {
        lines.push(...describeNode(node.body[j], `${idx}.${j}`, `${prefix}  `));
      }
      lines.push(`${prefix}  collect: %${idx}.${node.collect}`);
      lines.push(`${prefix}}`);
      return lines;
    }
  }
}
