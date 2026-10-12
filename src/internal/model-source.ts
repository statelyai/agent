import { isRecord } from "./is-record.js";
import { getAgentExecutionOptions } from "./registry.js";

function hasEntries(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function isMachineLike(value: object): boolean {
  return "config" in value && typeof (value as { transition?: unknown }).transition === "function";
}

/** Short description of a value for construction-time error messages. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value !== "object") return typeof value;
  if (isMachineLike(value)) {
    return getAgentExecutionOptions(value)
      ? "a machine whose setupAgent(...) declared no models"
      : "a machine not built by setupAgent(...).createMachine";
  }
  if (typeof (value as { createMachine?: unknown }).createMachine === "function") {
    return "a setupAgent(...) result that declared no models";
  }
  const keys = Object.keys(value);
  return keys.length ? `an object with keys ${keys.join(", ")}` : "an empty object";
}

/**
 * Normalizes an adapter's first argument to its options object. Accepts the
 * options object itself (`{ models }`, `{ resolveModel }`), a `setupAgent(...)`
 * result (its `models`), or a machine built by `setupAgent(...).createMachine`
 * (the `models` registered for it). Provider-free: the adapter decides what the
 * model values are. Throws, naming what it got, for anything else. @internal
 */
export function resolveModelSource<TOptions>(adapter: string, source: unknown): TOptions {
  if (isRecord(source)) {
    if (typeof source.createMachine === "function") {
      // A setupAgent(...) result.
      if (hasEntries(source.models)) return { models: source.models } as TOptions;
    } else if (isMachineLike(source)) {
      const models = getAgentExecutionOptions(source)?.models;
      if (hasEntries(models)) return { models } as TOptions;
    } else if (isRecord(source.models) || typeof source.resolveModel === "function") {
      return source as TOptions;
    }
  }
  throw new TypeError(
    `${adapter}: expected { models }, { resolveModel }, a setupAgent(...) result with models, ` +
      `or a machine from its createMachine; got ${describeValue(source)}.`,
  );
}
