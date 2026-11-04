/** An async effect a wrapped workflow calls. */
export type AnyEffect = (...args: unknown[]) => PromiseLike<unknown>;

/**
 * A plain copy of an effects object with every callable effect passed
 * through `wrap`: own and inherited methods alike (a class instance's
 * prototype methods), each bound to the original object so `this` still
 * works. Other own properties are copied as they are.
 */
export function mapEffects<T>(effects: T, wrap: (name: string, effect: AnyEffect) => unknown): T {
  const source = effects as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (
    let level: object | null = effects as object;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name === "constructor" || name in out) continue;
      const value = source[name];
      out[name] =
        typeof value === "function" ? wrap(name, (value as AnyEffect).bind(effects)) : value;
    }
  }
  return out as T;
}

/** A stream, as recorders and wrapped effects see one: anything `for await` reads. */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function"
  );
}
