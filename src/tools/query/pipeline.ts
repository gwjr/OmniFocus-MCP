/**
 * Minimal typed pass composition helpers for the query pipeline.
 *
 * A lowering pass changes representation (A -> B), an optimization pass
 * preserves it (A -> A), and an execution pass terminates in a result.
 * Pipelines are plain function composition; no runtime object state.
 */

export type LowerPass<A, B> = (input: A) => B;
export type OptimizePass<A> = (input: A) => A;
export type ExecutePass<A, R> = (input: A) => R;
export type AsyncPass<A, B> = (input: A) => B | Promise<B>;

export function composePasses<A, B>(
  ab: LowerPass<A, B>,
): LowerPass<A, B>;
export function composePasses<A, B, C>(
  ab: LowerPass<A, B>,
  bc: LowerPass<B, C>,
): LowerPass<A, C>;
export function composePasses<A, B, C, D>(
  ab: LowerPass<A, B>,
  bc: LowerPass<B, C>,
  cd: LowerPass<C, D>,
): LowerPass<A, D>;
export function composePasses<A, B, C, D, E>(
  ab: LowerPass<A, B>,
  bc: LowerPass<B, C>,
  cd: LowerPass<C, D>,
  de: LowerPass<D, E>,
): LowerPass<A, E>;
export function composePasses(...passes: Array<(input: unknown) => unknown>) {
  return (input: unknown) => passes.reduce((value, pass) => pass(value), input);
}

export function composeAsyncPasses<A, B>(
  ab: AsyncPass<A, B>,
): AsyncPass<A, Awaited<B>>;
export function composeAsyncPasses<A, B, C>(
  ab: AsyncPass<A, B>,
  bc: AsyncPass<B, C>,
): AsyncPass<A, Awaited<C>>;
export function composeAsyncPasses<A, B, C, D>(
  ab: AsyncPass<A, B>,
  bc: AsyncPass<B, C>,
  cd: AsyncPass<C, D>,
): AsyncPass<A, Awaited<D>>;
export function composeAsyncPasses<A, B, C, D, E>(
  ab: AsyncPass<A, B>,
  bc: AsyncPass<B, C>,
  cd: AsyncPass<C, D>,
  de: AsyncPass<D, E>,
): AsyncPass<A, Awaited<E>>;
export function composeAsyncPasses(...passes: Array<(input: unknown) => unknown>) {
  return async (input: unknown) => {
    let value = input;
    for (const pass of passes) {
      value = await pass(value);
    }
    return value;
  };
}
