import type {
  AnyActorRef,
  EventObject,
  MachineContext,
  MetaObject,
  StateMachine,
  StateSchema,
  StateValue,
} from "xstate";
import type { StandardSchemaV1 } from "../types.js";

/**
 * The machine type a preset factory returns: its context, event union, input
 * and output are all concrete, so callers get typed run input and
 * output instead of `AnyStateMachine`. The remaining slots (children, state
 * value/tags/config, source maps) are left permissive — a preset builds its
 * states dynamically, so there is no literal state schema to infer.
 *
 * @internal
 */
export type PresetMachine<
  TContext extends MachineContext,
  TInput,
  TOutput,
  TEvent extends EventObject = EventObject,
> = StateMachine<
  TContext,
  TEvent,
  Record<string, AnyActorRef | undefined>,
  StateValue,
  string,
  TInput,
  TOutput,
  EventObject,
  MetaObject,
  StateSchema,
  any,
  any,
  any,
  any
>;

/**
 * A permissive Standard Schema that carries a JSON Schema. Presets build their
 * own context/input/output schemas this way so the module stays dependency-free
 * (no Zod in `src/`) while `lintAgentMachine` and JSON tooling still see a
 * serializable shape.
 *
 * @internal
 */
export function objectSchema<T>(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): StandardSchemaV1<T> {
  const json = { type: "object", properties, required: [...required] };
  return {
    "~standard": {
      version: 1,
      vendor: "statelyai-agent-machines",
      validate: (value: unknown) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "Expected an object" }] };
        }
        const record = value as Record<string, unknown>;
        const issues: Array<{ message: string; path?: PropertyKey[] }> = [];
        for (const key of required) {
          if (!(key in record) || record[key] === undefined) {
            issues.push({ message: `Required property '${key}' is missing`, path: [key] });
          }
        }
        for (const [key, schema] of Object.entries(properties)) {
          const item = record[key];
          if (item === undefined) continue;
          const type = (schema as { type?: string | string[] } | undefined)?.type;
          const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
          const valid =
            types.length === 0 ||
            types.some((candidate) => {
              switch (candidate) {
                case "array":
                  return Array.isArray(item);
                case "object":
                  return item !== null && typeof item === "object" && !Array.isArray(item);
                case "null":
                  return item === null;
                case "integer":
                  return typeof item === "number" && Number.isInteger(item);
                case "number":
                  return typeof item === "number" && Number.isFinite(item);
                default:
                  return typeof item === candidate;
              }
            });
          if (!valid) {
            issues.push({ message: `Expected '${key}' to be ${String(type)}`, path: [key] });
          }
        }
        return issues.length > 0 ? { issues } : { value: value as T };
      },
      jsonSchema: { input: () => json },
    },
  } as StandardSchemaV1<T>;
}

/** A payload-less event schema (`{}` shorthand equivalent) with a JSON Schema. @internal */
export const emptyPayload = objectSchema<Record<string, never>>({});

/** JSON Schema fragments reused across preset context schemas. @internal */
export const jsonString = { type: "string" };
/** @internal */
export const jsonRecord = { type: "object", additionalProperties: true };
/** @internal */
export const jsonArray = { type: "array" };
/** @internal */
export const jsonAny = {};
