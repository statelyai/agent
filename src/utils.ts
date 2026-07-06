import type { AnyMachineSnapshot } from "xstate";
import type {
  AssistantMessage,
  FilePart,
  ImagePart,
  StandardSchemaV1,
  SystemMessage,
  TextPart,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  UserMessage,
} from "./types.js";

/** Builds a {@link UserMessage} from a string or multimodal content parts. */
export function userMessage(content: string | Array<TextPart | ImagePart | FilePart>): UserMessage {
  return { role: "user", content };
}

/** Builds an {@link AssistantMessage} from a string or content parts (text, files, tool calls/results). */
export function assistantMessage(
  content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>,
): AssistantMessage {
  return { role: "assistant", content };
}

/** Builds a {@link SystemMessage}. */
export function systemMessage(content: string): SystemMessage {
  return { role: "system", content };
}

/** Builds a {@link ToolMessage} from one or more tool-result parts. */
export function toolMessage(content: Array<ToolResultPart>): ToolMessage {
  return { role: "tool", content };
}

// A snapshot's meta value type, recovered from its `getMeta()` return type
// (`Record<StateId, TMeta | undefined>`). For a schema-typed machine (e.g.
// `setupAgent({ meta })`), this resolves to the meta schema's output type; for
// an untyped snapshot it falls back to `MetaObject`.
type MetaOfSnapshot<TSnapshot extends { getMeta(): Record<string, unknown> }> = NonNullable<
  ReturnType<TSnapshot["getMeta"]>[keyof ReturnType<TSnapshot["getMeta"]>]
>;

/**
 * Returns the merged `meta` of a snapshot's active state(s) — the typed
 * replacement for the `Object.values(snapshot.getMeta())[0]` dance.
 *
 * `snapshot.getMeta()` is keyed by state id; a leaf machine has one active
 * state, but parallel/nested machines can have several. This shallow-merges
 * every active state's meta into one object (later/deeper entries win) and
 * returns `{}` when no active state declares meta.
 *
 * The return type is recovered from the snapshot's own `getMeta()` type, so a
 * schema-typed machine (`setupAgent({ meta })`) yields the meta schema's
 * output type. Pass an explicit `TMeta` to override when the snapshot is
 * untyped (e.g. `AnyMachineSnapshot`).
 *
 * @example HITL: read the current state's interaction protocol off an idle
 * snapshot to render for a human.
 * ```ts
 * const { interaction } = getStateMeta(result.snapshot);
 * ```
 */
export function getStateMeta<
  TSnapshot extends { getMeta(): Record<string, unknown> } = AnyMachineSnapshot,
  TMeta = MetaOfSnapshot<TSnapshot>,
>(snapshot: TSnapshot): Partial<TMeta> {
  return Object.assign(
    {},
    ...Object.values(snapshot.getMeta()).filter(
      (meta): meta is Record<string, unknown> => meta != null,
    ),
  );
}

/**
 * Validates `value` against a {@link StandardSchemaV1}, synchronously.
 * Throws if the schema's `validate` returns a `Promise` (async validation is
 * not supported anywhere in this library) or if validation reports issues —
 * in which case the thrown `Error.message` joins every issue message with
 * `', '`.
 */
export function validateSchemaSync<T>(schema: StandardSchemaV1<T>, value: unknown): T {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new Error("Async schema validation is not supported.");
  }

  if (result.issues) {
    throw new Error(result.issues.map((issue: { message: string }) => issue.message).join(", "));
  }

  return result.value as T;
}
