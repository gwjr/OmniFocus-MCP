/**
 * EventPlan IR
 *
 * Intermediate representation between StrategyNode and emitted code
 * (JXA / AppleScript / OmniJS / Node).
 *
 * Runtime-agnostic: no JXA, AppleScript, or OmniJS syntax embedded.
 * Runtime annotations are added by the TargetedEventPlan pass.
 *
 * SSA form: each node occupies a slot in the plan array; its slot index
 * is its Ref. Values are immutable references. Data flow is explicit.
 */

import type { LoweredExpr } from './fold.js';
import type { EntityType } from './variables.js';

// ── Primitive types ──────────────────────────────────────────────────────────

/** 4-character Apple Events code, e.g. 'pnam', 'FCft' */
export type FourCC = string;

/** Scoped resource identifier, e.g. 'of:tasks', 'dt:records' */
export type Resource = string;

/** Index into the EventPlan node array (SSA binding) */
export type Ref = number;

// ── Runtime ──────────────────────────────────────────────────────────────────

export type Runtime = 'jxa' | 'omniJS' | 'node';

// ── Side effects ─────────────────────────────────────────────────────────────

export type SideEffect =
  | 'nonMutating'
  | { kind: 'sideEffectiveFor'; resources: Resource[] }
  | 'sideEffective';

// ── Specifiers ───────────────────────────────────────────────────────────────

/**
 * Specifiers describe AE object addresses. They are structural (not SSA
 * values) — no value is produced until a specifier is wrapped in Get or Count.
 * parent may be a nested specifier or a Ref (used inside ForEach bodies where
 * the loop variable is an AE object reference).
 */
export type Specifier =
  | { kind: 'Document' }
  | { kind: 'Elements';  parent: Specifier | Ref; classCode: FourCC }
  | { kind: 'Property';  parent: Specifier | Ref; propCode:  FourCC }
  | { kind: 'ByID';      parent: Specifier | Ref; id:   string | Ref }
  | { kind: 'ByName';    parent: Specifier | Ref; name: string | Ref }
  | { kind: 'ByIndex';   parent: Specifier | Ref; index: number };

// ── DeriveSpec ───────────────────────────────────────────────────────────────

/**
 * References a computed-var derivation rule by name and entity.
 * The emitter resolves var+entity to the actual derivation function at
 * emission time, using the same rules the current executor uses.
 */
export interface DeriveSpec {
  var:    string;
  entity: EntityType;
}

// ── EventNode ─────────────────────────────────────────────────────────────────

export type EventNode =

  // ── AE reads ────────────────────────────────────────────────────────────

  | { kind: 'Get';
      specifier: Specifier;
      effect: SideEffect;           // almost always 'nonMutating'
    }

  | { kind: 'Count';
      specifier: Specifier;
      effect: SideEffect;
    }

  // ── AE writes / commands ────────────────────────────────────────────────

  | { kind: 'Set';
      specifier: Specifier;
      value: Ref;
      effect: SideEffect;           // typically sideEffectiveFor the affected entity
    }

  | { kind: 'Command';
      fourCC:  FourCC;
      target:  Specifier;
      args:    Record<string, Ref | string | number>;
      effect:  SideEffect;
    }

  // ── Iteration ───────────────────────────────────────────────────────────
  //
  // Iterates over source — a collection of any kind (AE element set, flat
  // value array from ColumnValues, etc.). The set of valid collection types
  // is open.
  //
  // The ForEach node occupies index N in the plan.
  // Ref N is SCOPED — its meaning depends on where it appears:
  //   • Inside body:   Ref N resolves to the current iteration item.
  //   • Outside body:  Ref N resolves to the accumulated result — the flat
  //                    collection of collect values across all iterations.
  //
  // Using Ref N (as "current item") in a node outside this ForEach's body
  // is a compile error. The emitter tracks a ForEach stack to resolve this.

  | { kind: 'ForEach';
      source:  Ref;
      body:    EventNode[];
      collect: Ref;
      effect:  SideEffect;
    }

  // ── Node-side operations (no AE involvement) ────────────────────────────

  | { kind: 'Zip';
      columns: { name: string; ref: Ref }[];
    }

  // Extract a single named field from each row in a row array, producing a
  // flat value array. Primary use: preparing a column for ForEach or
  // Get(ByID, Ref). Inverse of Zip for a single column.
  | { kind: 'ColumnValues';
      source: Ref;
      field:  string;
    }

  // Flatten one level of nesting from an array of arrays.
  // e.g. [['a','b'], [], ['c']] → ['a', 'b', 'c']
  | { kind: 'Flatten';
      source: Ref;
    }

  | { kind: 'Filter';
      source:    Ref;
      predicate: LoweredExpr;   // compiled at emission time to runtime predicate
    }

  | { kind: 'SemiJoin';
      source: Ref;
      ids:    Ref;              // Ref to a string[] / Set<string>
    }

  | { kind: 'HashJoin';
      source:    Ref;
      lookup:    Ref;
      sourceKey: string;
      lookupKey: string;
      fieldMap:  Record<string, string>;
    }

  | { kind: 'Sort';
      source: Ref;
      by:     string;
      dir:    'asc' | 'desc';
    }

  | { kind: 'Limit';
      source: Ref;
      n:      number;
    }

  // Narrow a row array to a subset of fields. Named Pick to avoid collision
  // with the OmniFocus domain concept of a "project".
  | { kind: 'Pick';
      source: Ref;
      fields: string[];
    }

  | { kind: 'Derive';
      source:      Ref;
      derivations: DeriveSpec[];
    }

  // ── Targeting hint ──────────────────────────────────────────────────────
  //
  // Transparent to data flow: value equals source's value.
  // Carries a runtime preference that the targeting pass treats as
  // authoritative, overriding its default heuristics for the sourced node.
  //
  // Emitted by the Strategy→EventPlan lowering, which has app-specific
  // knowledge the generic targeting pass does not.
  // Consumed and stripped by the targeting pass (Pass 1).

  | { kind: 'Hint';
      source:  Ref;
      runtime: Runtime;
    };

// ── EventPlan ────────────────────────────────────────────────────────────────

export interface EventPlan {
  nodes:  EventNode[];   // index = Ref
  result: Ref;           // which node's value is the query output
}
