/**
 * MINIMAL LOCAL SHIM for TanStack Start's `createServerFn`. This repo does not
 * depend on `@tanstack/react-start`, so this keeps the example typechecking
 * standalone while mirroring the real chained builder:
 *
 *   createServerFn({ method: 'POST' }).validator(fn).handler(fn)
 *
 * In a real TanStack Start app you DELETE this file and
 * `import { createServerFn } from '@tanstack/react-start'`. The call shape and
 * the handler body are identical.
 */

interface ServerFnBuilder<TInput> {
  /** Narrows/validates the raw input; return value becomes `ctx.data`. */
  validator<T>(fn: (input: unknown) => T): ServerFnBuilder<T>;
  /** Registers the server handler; returns the callable server function. */
  handler<TOutput>(
    fn: (ctx: { data: TInput }) => TOutput | Promise<TOutput>,
  ): (opts: { data: TInput }) => Promise<TOutput>;
}

export function createServerFn(
  _options: { method?: "GET" | "POST" } = {},
): ServerFnBuilder<unknown> {
  let validate: (input: unknown) => unknown = (input) => input;
  const builder: ServerFnBuilder<unknown> = {
    validator(fn) {
      validate = fn as (input: unknown) => unknown;
      return builder as never;
    },
    handler(fn) {
      return async (opts) => (await fn({ data: validate(opts.data) })) as never;
    },
  };
  return builder;
}
