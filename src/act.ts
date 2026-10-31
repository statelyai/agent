import { createAsyncLogic, type AsyncActorLogic } from "xstate";
import type { AgentTools, AllowedEvents } from "./types.js";
import { ACT_ACTOR } from "./text-logic.js";

/**
 * Inline input for the `agent.act` builtin actor: one model call whose tools
 * are the invoking state's accepted events (plus any plain `tools`). The model
 * calls them in any order across up to `maxSteps` steps of the host's tool
 * loop; each event call is delivered to the machine and answered with what it
 * did (`{ state?, changed? }`). Typed against the machine's own event schemas.
 */
export interface AgentActInput<
  TEvent extends string = string,
  TMetadata = Record<string, unknown>,
  TModel extends string = string,
> {
  /** Semantic request identity. Defaults to the invoke occurrence id. */
  name?: string;
  model: TModel;
  system?: string;
  prompt?: string;
  /** Framework-native messages, passed through without conversion. */
  messages?: any[];
  /** Event types offered as tools, intersected with what the state accepts. Omitted means all of them. */
  allowedEvents?: AllowedEvents<TEvent>;
  /** Plain tools offered beside the event tools. */
  tools?: AgentTools;
  /** Bounds the host's tool loop. Default {@link DEFAULT_ACT_MAX_STEPS}. */
  maxSteps?: number;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  metadata?: TMetadata;
}

/** The `agent.act` builtin's tool-loop bound when its input sets no `maxSteps`. */
export const DEFAULT_ACT_MAX_STEPS = 20;

/** What an event tool answers once the invoking state has exited. */
export const ACT_STATE_EXITED = "state exited; stopped";

/** The `agent.act` builtin's logic: runnable only once a host binds it. @internal */
export type ActLogic = AsyncActorLogic<unknown, AgentActInput> & {
  readonly kind: "statelyai.actLogic";
};

/** Whether `logic` is the (unbound) `agent.act` builtin. @internal */
export function isActLogic(logic: unknown): logic is ActLogic {
  return (
    !!logic &&
    typeof logic === "object" &&
    (logic as { kind?: unknown }).kind === "statelyai.actLogic"
  );
}

// Builds the unbound `agent.act` builtin actor logic registered by setupAgent.
// It needs the invoking actor's live snapshot, so only `createAgentRuntime`
// and `provideExecutors` can run it.
export function createActActor(): ActLogic {
  const logic = createAsyncLogic<unknown, AgentActInput>({
    run: async () => {
      throw new Error(
        `'${ACT_ACTOR}' has no host execution. Run the machine with createAgentRuntime(...) ` +
          "or provideExecutors(...) and a 'generateText' executor.",
      );
    },
  });
  return Object.assign(logic, { kind: "statelyai.actLogic" as const });
}
