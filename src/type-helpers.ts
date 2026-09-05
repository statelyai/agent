import type {
  AnyStateMachine,
  ContextFrom,
  EventFromLogic,
  InputFrom,
  OutputFrom,
  SnapshotFrom,
  StateValueFrom,
} from "xstate";
import type { EventUnion, InferInput, InferOutput, StandardSchemaV1 } from "./types.js";

type SchemaAt<T, TKey extends PropertyKey> = T extends {
  schemas: Record<TKey, infer TSchema extends StandardSchemaV1>;
}
  ? TSchema
  : never;

/** Machine context, or a setup's context-schema output. */
export type ContextOf<T> = T extends AnyStateMachine
  ? ContextFrom<T>
  : InferOutput<SchemaAt<T, "context">>;

/** Machine input, or a setup's context-schema input. */
export type InputOf<T> = T extends AnyStateMachine
  ? InputFrom<T>
  : InferInput<SchemaAt<T, "input">>;

/** Machine output, or a setup's output-schema output. */
export type OutputOf<T> = T extends AnyStateMachine
  ? OutputFrom<T>
  : InferOutput<SchemaAt<T, "output">>;

/** Machine event union, or the event union declared by a setup. */
export type EventOf<T> = T extends AnyStateMachine
  ? EventFromLogic<T>
  : T extends { schemas: { events: infer TEvents extends Record<string, StandardSchemaV1> } }
    ? EventUnion<TEvents>
    : never;

/** Typed live XState snapshot for a machine. */
export type SnapshotOf<TMachine extends AnyStateMachine> = SnapshotFrom<TMachine>;

/** Literal state-value union accepted by a machine snapshot's `matches`. */
export type StateValueOf<TMachine extends AnyStateMachine> = StateValueFrom<TMachine>;

/** State/transition metadata declared by a setup or carried by a machine snapshot. */
export type MetaOf<T> = T extends { schemas: { meta: infer TSchema extends StandardSchemaV1 } }
  ? InferOutput<TSchema>
  : T extends AnyStateMachine
    ? ReturnType<SnapshotFrom<T>["getMeta"]> extends Record<string, infer TMeta>
      ? TMeta
      : never
    : never;

/** Semantic request names registered on a `setupAgent(...)` result. */
export type RequestNamesOf<T> = T extends { requests: infer TRequests }
  ? keyof TRequests & string
  : never;
