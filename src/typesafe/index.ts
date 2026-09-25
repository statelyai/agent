/**
 * `@statelyai/agent/typesafe` — TypeSafe System One judgments (Jev) as
 * machine actors.
 *
 * A System One model answers narrow, typed questions over explicit state:
 * a `choice` among labels, a `noul` (probability that a condition holds), or
 * a `score` on described levels. It returns probabilities, not prose, so its
 * answers are what a guard or a `choice` state consumes directly. Where a
 * machine needs classification, grading, relevance, or a yes/no check, a
 * judgment is the right shape; a text request stays for anything generative.
 *
 * `createSystemOneLogic` wraps one `client.systemOne` call as XState async
 * actor logic. Register it under `setupAgent({ actors })` and invoke it like
 * any other actor: `state` and `questions` are functions of the invoke input,
 * and the actor's output is the typed `answers` map plus the call's usage.
 *
 * The SDK client reads `TYPESAFE_API_KEY` from the environment when none is
 * passed. Tests pass a client built over a fake `fetch`, so the real SDK
 * request and parse path runs against scripted answers.
 * @module
 */
import { createAsyncLogic } from "xstate";
import {
  TypeSafeClient,
  type EntryType,
  type Questions,
  type SystemOneResult,
  type Usage,
} from "@typesafe-ai/sdk";

export type { ChoiceResponse, NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";

/** What a System One actor resolves with: the typed answers and the call's usage. */
export type SystemOneOutput<Q extends Questions> = {
  answers: SystemOneResult<Q>["answers"];
  model: string;
  usage: Usage;
};

export type SystemOneLogicOptions<TInput, Q extends Questions> = {
  /**
   * The state the questions are asked over, from the invoke input. Prefer an
   * object with named fields when the context has several parts.
   */
  state: (input: TInput) => EntryType;
  /**
   * The questions, keyed by the name code reads the answer back under. Build
   * them with the SDK's `choice`, `noul`, and `score` helpers.
   */
  questions: (input: TInput) => Q;
  /** Model name; defaults to the client's default (`jev-latest`). */
  model?: string;
  /**
   * The SDK client. Omit to construct one lazily from the environment
   * (`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`).
   */
  client?: TypeSafeClient;
};

/**
 * Async actor logic that asks one batch of System One questions per invoke.
 * Independent questions over the same state belong in one call: they run in
 * parallel and cannot see one another's answers.
 */
export function createSystemOneLogic<TInput, const Q extends Questions>(
  options: SystemOneLogicOptions<TInput, Q>,
) {
  let client = options.client;
  return createAsyncLogic<SystemOneOutput<Q>, TInput>({
    run: async ({ input, signal }) => {
      const questions = options.questions(input);
      // Nothing to judge (an empty candidate list, say) is an ordinary outcome,
      // not a request: resolve with no answers and no call.
      if (Object.keys(questions).length === 0) {
        return {
          answers: {} as SystemOneResult<Q>["answers"],
          model: options.model ?? client?.defaultModel ?? "",
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      }
      client ??= new TypeSafeClient();
      const result = await client.systemOne(
        {
          state: options.state(input),
          questions,
          ...(options.model ? { model: options.model } : {}),
        },
        { signal },
      );
      return { answers: result.answers, model: result.model, usage: result.usage };
    },
  });
}
