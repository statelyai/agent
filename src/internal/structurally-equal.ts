import { isRecord } from "./is-record.js";

/** Deep equality over plain data, plus `Date`, `Map`, and `Set` contents. @internal */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Values whose contents are not enumerable own keys.
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof Map || b instanceof Map) {
    return a instanceof Map && b instanceof Map && structurallyEqual([...a], [...b]);
  }
  if (a instanceof Set || b instanceof Set) {
    return a instanceof Set && b instanceof Set && structurallyEqual([...a], [...b]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => structurallyEqual(item, b[index]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]))
  );
}
