import {
  experimental_decide,
  InvalidResponseDataError,
  type Experimental_DecisionModel,
  type JSONValue,
} from "ai";

type JSONObject = { [key: string]: JSONValue };
import {
  decisionOptionIds,
  type AgentDecisionExecutor,
  type AgentExecutorDecisionRequest,
} from "../decision.js";
import { isRecord } from "../internal/is-record.js";
import { unofferedOption } from "./mappers.js";

/** Options for {@link createDecisionModelDecide}. */
export interface DecisionModelDecideOptions {
  /** The question's instructions. Defaults to the request's `system` and `prompt`. */
  instructions?: string;
  /** The state the model judges. Defaults to `request.input`. */
  state?: (request: AgentExecutorDecisionRequest) => unknown;
  /**
   * Below this confidence in the chosen option, the executor throws instead of
   * answering: the throw is the escalation signal, not a retry. Route it
   * through the invoke's `onError`, or catch it at the boundary. Read from
   * the TypeSafe provider metadata when present, else the choice's top
   * probability. A model reporting neither counts as 0.
   */
  minConfidence?: number;
}

/** The question id the closed choice is asked under. */
const QUESTION_ID = "next";

/**
 * A `decide` executor backed by an AI SDK decision model (`experimental_decide`),
 * such as TypeSafe's Jev. It asks ONE `choice` question over the request's
 * `options`: each option id is a label, its description the criterion (the
 * event as JSON when it has none). The answer maps back to `option.event`.
 *
 * A label that is not an option is retried like any failed choice. It needs a
 * closed choice: a request without `options` throws. Pass
 * `payloads` on `agent.decide`, or use `decideNext`, to build one.
 *
 * @example
 * ```ts no-check
 * const decide = createDecisionModelDecide(typeSafeAi.decisionModel('jev-latest'), {
 *   minConfidence: 0.6,
 * });
 * ```
 */
export function createDecisionModelDecide(
  model: Experimental_DecisionModel,
  options: DecisionModelDecideOptions = {},
): AgentDecisionExecutor {
  return async (request, info) => {
    const offered = request.options;
    if (!offered || offered.length === 0) {
      throw new Error(
        `createDecisionModelDecide: decision '${request.name}' has no options. A decision ` +
          "model answers a closed choice: pass `payloads` on agent.decide, or use decideNext.",
      );
    }
    const ids = decisionOptionIds(offered);
    const criteria = Object.fromEntries(
      offered.map((option, index) => [
        ids[index]!,
        option.description ?? JSON.stringify(option.event),
      ]),
    );
    const instructions =
      options.instructions ??
      ([request.system, request.prompt].filter(Boolean).join("\n\n") ||
        "Which option should happen next?");

    const ask = () =>
      experimental_decide({
        model,
        state: toDecisionState(options.state ? options.state(request) : request.input),
        questions: { [QUESTION_ID]: { type: "choice" as const, instructions, criteria } },
        ...(info?.signal ? { abortSignal: info.signal } : {}),
      });
    let result: Awaited<ReturnType<typeof ask>>;
    try {
      result = await ask();
    } catch (error) {
      // The SDK throws on a label that is not an option; answer with an event
      // no candidate has instead, so the choice is retried.
      const chosen = unofferedChoice(error, ids);
      if (chosen === undefined) throw error;
      return { event: unofferedOption(`option ${JSON.stringify(chosen)}`, ids) };
    }

    const answer = result.answers[QUESTION_ID]!;
    const option = offered[ids.indexOf(answer.choice)];
    if (!option) {
      return { event: unofferedOption(`option ${JSON.stringify(answer.choice)}`, ids) };
    }
    const reported = (
      result.providerMetadata?.typesafe?.confidence as Record<string, unknown> | undefined
    )?.[QUESTION_ID];
    const confidence =
      typeof reported === "number" ? reported : (answer.probabilities?.[answer.choice] ?? 0);
    if (options.minConfidence !== undefined && confidence < options.minConfidence) {
      throw new Error(
        `createDecisionModelDecide: low confidence (${confidence.toFixed(2)} < ` +
          `${options.minConfidence}) choosing '${answer.choice}' for decision '${request.name}'.`,
      );
    }

    return {
      event: option.event,
      confidence,
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      },
    };
  };
}

// The label of an `InvalidResponseDataError` whose choice is not an offered id.
function unofferedChoice(error: unknown, ids: readonly string[]): string | undefined {
  if (!InvalidResponseDataError.isInstance(error) || !isRecord(error.data)) return undefined;
  const answer = error.data[QUESTION_ID];
  const choice = isRecord(answer) ? answer.choice : undefined;
  return typeof choice === "string" && !ids.includes(choice) ? choice : undefined;
}

// A decision model takes a string or a JSON object as its state.
function toDecisionState(value: unknown): string | JSONObject {
  if (typeof value === "string") return value;
  try {
    const json: unknown = JSON.parse(JSON.stringify(value ?? {}));
    return isRecord(json) ? (json as JSONObject) : { value: json as JSONValue };
  } catch {
    return String(value);
  }
}
