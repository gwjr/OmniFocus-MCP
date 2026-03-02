/**
 * StrategyNode debug pretty-printer.
 *
 * Produces an indented tree representation for debugging and logging.
 * Not used in production execution paths.
 */

import type { StrategyNode } from './strategy.js';

// ── Public API ──────────────────────────────────────────────────────────

export function describeStrategyNode(node: StrategyNode, indent: number = 0): string {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];

  switch (node.kind) {
    case 'BulkScan': {
      let line = `${pad}BulkScan ${node.entity} [${node.columns.join(', ')}]`;
      if (!node.includeCompleted) line += ' (includeCompleted:false)';
      if (node.projectScope) line += ` scope:${JSON.stringify(node.projectScope)}`;
      lines.push(line);
      break;
    }

    case 'FallbackScan':
      lines.push(`${pad}FallbackScan ${node.entity} ${JSON.stringify(node.filterAst)}`);
      break;

    case 'MembershipScan':
      lines.push(`${pad}MembershipScan ${node.sourceEntity}\u2192${node.targetEntity} ${JSON.stringify(node.predicate)}`);
      break;

    case 'Filter':
      lines.push(`${pad}Filter ${JSON.stringify(node.predicate)}`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      break;

    case 'PreFilter': {
      const assumeTrue = [...node.assumeTrue].join(', ');
      lines.push(`${pad}PreFilter ${JSON.stringify(node.predicate)} (assumeTrue:[${assumeTrue}])`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      break;
    }

    case 'PerItemEnrich': {
      const vars = [...node.perItemVars].join(', ');
      lines.push(`${pad}PerItemEnrich [${vars}] ${node.entity}`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      lines.push(describeStrategyNode(node.fallback, indent + 2));
      break;
    }

    case 'Sort':
      lines.push(`${pad}Sort by:${node.by} ${node.direction}`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      break;

    case 'Limit':
      lines.push(`${pad}Limit ${node.count}`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      break;

    case 'Project':
      lines.push(`${pad}Project [${node.fields.join(', ')}]`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      break;

    case 'SemiJoin':
      lines.push(`${pad}SemiJoin`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      lines.push(describeStrategyNode(node.lookup, indent + 2));
      break;

    case 'CrossEntityJoin':
      lines.push(`${pad}CrossEntityJoin sourceKey:${node.sourceKey} lookupKey:${node.lookupKey}`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      lines.push(describeStrategyNode(node.lookup, indent + 2));
      break;

    case 'SelfJoinEnrich':
      lines.push(`${pad}SelfJoinEnrich`);
      lines.push(describeStrategyNode(node.source, indent + 2));
      break;
  }

  return lines.join('\n');
}
