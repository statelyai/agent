/** True for a plain object-like value (arrays excluded). @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for an object whose prototype is `null` or some realm's
 * `Object.prototype`. Comparing against this realm's `Object.prototype` alone
 * rejects plain objects built in another realm: a jest test file's vm
 * context, or `structuredClone`'s output inside one. @internal
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/** True for an `Error` from any realm, where `instanceof Error` sees only this one. @internal */
export function isError(value: unknown): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

/** JSON text with object keys sorted and `undefined` fields dropped, for comparing JSON-like values. @internal */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      isPlainObject(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    ) ?? "undefined"
  );
}
