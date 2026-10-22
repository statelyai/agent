import { isRecord } from "./is-record.js";

/** The `value` of a trace event's `from` or `snapshot`. @internal */
export function valueOf(holder: unknown): unknown {
  return isRecord(holder) ? holder.value : undefined;
}

/** A decision request on its first attempt (no failed attempts yet). @internal */
export function isFirstDecision(request: unknown): request is Record<string, unknown> {
  return (
    isRecord(request) &&
    request.kind === "decision" &&
    (!Array.isArray(request.attempts) || request.attempts.length === 0)
  );
}

/**
 * Every active leaf of a state value as a dot path:
 * `'a'` → `['a']`; `{ a: 'b' }` → `['a.b']`; `{ p: { x: 'one', y: {} } }` → `['p.x.one', 'p.y']`.
 * @internal
 */
export function statePaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix + value];
  if (!isRecord(value)) return [];
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [prefix.slice(0, -1)] : [];
  return entries.flatMap(([key, child]) => statePaths(child, `${prefix}${key}.`));
}
