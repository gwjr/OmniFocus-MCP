import type { QueryOmnifocusParams } from './queryOmnifocus.js';
import type { CustomPerspectiveArchiveRow } from './queryPerspectives.js';

type CompactExpr = unknown;

interface TranslationResult {
  where?: CompactExpr;
  includeCompleted?: boolean;
}

export interface PerspectiveTranslationContext {
  onHoldTagNames?: string[];
}

function andExpr(parts: Array<CompactExpr | null | undefined>): CompactExpr | null {
  const filtered = parts.filter(p => p != null);
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return filtered[0];
  return { and: filtered };
}

function orExpr(parts: Array<CompactExpr | null | undefined>): CompactExpr | null {
  const filtered = parts.filter(p => p != null);
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return filtered[0];
  return { or: filtered };
}

function notExpr(part: CompactExpr | null | undefined): CompactExpr | null {
  if (part == null) return null;
  return { not: [part] };
}

function durationToDays(amount: number, component: string): number {
  switch (component) {
    case 'hour': return Math.max(1, Math.ceil(amount / 24));
    case 'day': return amount;
    case 'week': return amount * 7;
    case 'month': return amount * 30;
    case 'year': return amount * 365;
    default:
      throw new Error(`Unsupported perspective relative date component "${component}"`);
  }
}

function mapDateField(field: string): string {
  switch (field) {
    case 'due': return 'dueDate';
    case 'defer': return 'deferDate';
    case 'completed': return 'completionDate';
    case 'added': return 'creationDate';
    case 'changed': return 'modificationDate';
    case 'planned': return 'plannedDate';
    default:
      throw new Error(`Unsupported perspective date field "${field}"`);
  }
}

function translateAvailability(value: string): TranslationResult {
  switch (value) {
    case 'remaining':
      return {};
    case 'available':
    case 'firstAvailable':
      return { where: { eq: [{ var: 'blocked' }, false] } };
    case 'completed':
      return { where: { eq: [{ var: 'completed' }, true] }, includeCompleted: true };
    case 'dropped':
      return { where: { eq: [{ var: 'dropped' }, true] }, includeCompleted: true };
    default:
      throw new Error(`Unsupported perspective actionAvailability "${value}"`);
  }
}

function translateActionStatus(value: string): TranslationResult {
  switch (value) {
    case 'flagged':
      return { where: { eq: [{ var: 'flagged' }, true] } };
    case 'due':
      return {
        where: {
          and: [
            { isNotNull: [{ var: 'dueDate' }] },
            { lte: [{ var: 'dueDate' }, { var: 'now' }] },
          ],
        },
      };
    default:
      throw new Error(`Unsupported perspective actionStatus "${value}"`);
  }
}

function translateTagStatus(value: string, ctx: PerspectiveTranslationContext): TranslationResult {
  switch (value) {
    case 'onHold':
      if (!ctx.onHoldTagNames || ctx.onHoldTagNames.length === 0) {
        throw new Error('Perspective translation requires on-hold tag names to translate actionHasTagWithStatus');
      }
      return {
        where: orExpr(ctx.onHoldTagNames.map(name => ({ contains: [{ var: 'tags' }, name] }))) ?? undefined,
      };
    default:
      throw new Error(`Unsupported perspective actionHasTagWithStatus "${value}"`);
  }
}

function translateWithinFocus(ids: string[]): TranslationResult {
  if (!Array.isArray(ids) || ids.length === 0) return {};
  const predicate = { in: [{ var: 'id' }, ids] };
  return {
    where: orExpr([
      { container: ['project', predicate] },
      { container: ['folder', predicate] },
    ]) ?? undefined,
  };
}

function translateDateRule(rule: Record<string, unknown>): TranslationResult {
  const field = mapDateField(String(rule.actionDateField));
  const target = { var: field };

  if (rule.actionDateIsInTheNext && typeof rule.actionDateIsInTheNext === 'object') {
    const spec = rule.actionDateIsInTheNext as Record<string, unknown>;
    const days = durationToDays(
      Number(spec.relativeAfterAmount ?? 0),
      String(spec.relativeComponent ?? 'day'),
    );
    return {
      where: {
        and: [
          { isNotNull: [target] },
          { gte: [target, { var: 'now' }] },
          { lte: [target, { offset: { date: 'now', days } }] },
        ],
      },
    };
  }

  if (rule.actionDateIsToday === true) {
    return {
      where: {
        and: [
          { isNotNull: [target] },
          { gte: [target, { var: 'now' }] },
          { lte: [target, { offset: { date: 'now', days: 1 } }] },
        ],
      },
    };
  }

  throw new Error(`Unsupported perspective date rule for field "${String(rule.actionDateField)}"`);
}

function translateRule(rule: Record<string, unknown>, ctx: PerspectiveTranslationContext): TranslationResult {
  if ('disabledRule' in rule) {
    return {};
  }

  if ('aggregateRules' in rule) {
    const aggregateRules = Array.isArray(rule.aggregateRules) ? rule.aggregateRules as Array<Record<string, unknown>> : [];
    return translateArchiveRules(aggregateRules, typeof rule.aggregateType === 'string' ? rule.aggregateType : 'all', ctx);
  }

  const parts: TranslationResult[] = [];

  if ('actionAvailability' in rule) {
    parts.push(translateAvailability(String(rule.actionAvailability)));
  }
  if ('actionStatus' in rule) {
    parts.push(translateActionStatus(String(rule.actionStatus)));
  }
  if (rule.actionHasDueDate === true) {
    parts.push({ where: { isNotNull: [{ var: 'dueDate' }] } });
  }
  if (rule.actionHasDeferDate === true) {
    parts.push({ where: { isNotNull: [{ var: 'deferDate' }] } });
  }
  if (rule.actionHasPlannedDate === true) {
    parts.push({ where: { isNotNull: [{ var: 'plannedDate' }] } });
  }
  if (rule.actionHasDuration === true) {
    parts.push({ where: { isNotNull: [{ var: 'estimatedMinutes' }] } });
  }
  if (rule.actionIsLeaf === true) {
    parts.push({ where: { eq: [{ var: 'hasChildren' }, false] } });
  }
  if ('actionHasAnyOfTags' in rule) {
    const ids = Array.isArray(rule.actionHasAnyOfTags) ? rule.actionHasAnyOfTags : [];
    parts.push({
      where: {
        container: ['tag', { in: [{ var: 'id' }, ids] }],
      },
    });
  }
  if ('actionWithinFocus' in rule) {
    parts.push(translateWithinFocus(Array.isArray(rule.actionWithinFocus) ? rule.actionWithinFocus as string[] : []));
  }
  if ('actionHasTagWithStatus' in rule) {
    parts.push(translateTagStatus(String(rule.actionHasTagWithStatus), ctx));
  }
  if ('actionDateField' in rule) {
    parts.push(translateDateRule(rule));
  }

  if (parts.length === 0) {
    throw new Error(`Unsupported perspective rule ${JSON.stringify(rule)}`);
  }

  return {
    where: andExpr(parts.map(p => p.where)) ?? undefined,
    includeCompleted: parts.some(p => p.includeCompleted === true) || undefined,
  };
}

export function translateArchiveRules(
  rules: Array<Record<string, unknown>>,
  aggregation: string | null | undefined,
  ctx: PerspectiveTranslationContext = {},
): TranslationResult {
  const translated = rules.map(rule => translateRule(rule, ctx));
  const effectiveAggregation = aggregation ?? 'all';
  const whereParts = translated.map(t => t.where);

  let where: CompactExpr | null;
  switch (effectiveAggregation) {
    case 'all':
      where = andExpr(whereParts);
      break;
    case 'any':
      where = orExpr(whereParts);
      break;
    case 'none':
      where = notExpr(orExpr(whereParts));
      break;
    default:
      throw new Error(`Unsupported perspective aggregation "${effectiveAggregation}"`);
  }

  return {
    where: where ?? undefined,
    includeCompleted: translated.some(t => t.includeCompleted === true) || undefined,
  };
}

export function customPerspectiveToQuery(
  perspective: CustomPerspectiveArchiveRow,
  ctx: PerspectiveTranslationContext = {},
): QueryOmnifocusParams {
  const translated = translateArchiveRules(
    (perspective.archivedFilterRules ?? []) as Array<Record<string, unknown>>,
    perspective.archivedTopLevelFilterAggregation,
    ctx,
  );

  return {
    entity: 'tasks',
    ...(translated.where !== undefined ? { where: translated.where } : {}),
    ...(translated.includeCompleted ? { includeCompleted: true } : {}),
  };
}
