/**
 * Free chat text → one of the events an idle machine offers, for a state that
 * declares no `textEvent`. "bank", "Bruno", "Looks good, book it" are clear
 * enough to a person; reading them as a typed event is a Jev `choice` over
 * the offered events (see `textCandidates`), the same way the approval
 * scenario reads a review (`createInterpretReview` in `agent-runner.ts`).
 *
 * The judge is Jev through the AI SDK's `experimental_evaluate`, which reads
 * `TYPESAFE_AI_API_KEY`; tests mock `@ai-sdk/typesafe-ai`.
 */
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { createActor, createAsyncLogic, toPromise } from "xstate";
import { textCandidates, type ChatIdle, type JsonObject } from "./machine-ui";

/** Below this confidence, typed text reads as unclear and nothing is delivered. */
export const TEXT_EVENT_CONFIDENCE = 0.6;

/** The label Jev picks when the text asks for none of the offered events. */
const UNCLEAR = "unclear";

const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/**
 * One Jev `choice` over labeled readings of `message`. Confidence comes from
 * the result's TypeSafe provider metadata; a judge that reports none counts
 * as unsure (0).
 */
export function createInterpretText(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { choice: string; confidence: number },
    {
      message: string;
      prompt: string | null;
      criteria: Record<string, string>;
      /** The run's request signal: a Cancel stops the judgment too. */
      requestSignal?: AbortSignal;
    }
  >({
    run: async ({ input, signal }) => {
      const { answers, providerMetadata } = await evaluate({
        model,
        state: input.prompt
          ? { message: input.message, waitingFor: input.prompt }
          : { message: input.message },
        questions: {
          action: {
            type: "choice" as const,
            instructions:
              "`message` is what a person typed to an app that is waiting for them to act" +
              " (`waitingFor`, when present, is what it asked). Which action does it ask for?",
            criteria: input.criteria,
          },
        },
        abortSignal: input.requestSignal ? AbortSignal.any([signal, input.requestSignal]) : signal,
      });
      const reported = (
        providerMetadata?.typesafe?.confidence as Record<string, unknown> | undefined
      )?.action;
      return {
        choice: String((answers.action as { choice: unknown }).choice),
        confidence: typeof reported === "number" ? reported : 0,
      };
    },
  });
}

/**
 * The offered event `text` asks for, with its payload filled, or null when
 * Jev is unsure, picks "unclear", or fails — the caller then delivers
 * nothing. `judge` is injected by tests; omitted, Jev reads the key.
 */
export async function interpretIdleText(
  text: string,
  idle: ChatIdle,
  options: { signal?: AbortSignal; judge?: Experimental_EvaluationModel } = {},
): Promise<({ type: string } & JsonObject) | null> {
  const candidates = textCandidates(idle.events);
  if (!candidates.length) return null;
  const labels = candidates.map((_, index) => `option_${index + 1}`);
  const criteria: Record<string, string> = Object.fromEntries(
    candidates.map((candidate, index) => [labels[index], candidate.description]),
  );
  criteria[UNCLEAR] = "Asks for none of the other options, or it is not clear which one.";
  try {
    const actor = createActor(createInterpretText(options.judge), {
      input: { message: text, prompt: idle.prompt, criteria, requestSignal: options.signal },
    });
    actor.start();
    const { choice, confidence } = await toPromise(actor);
    if (confidence < TEXT_EVENT_CONFIDENCE) return null;
    const candidate = candidates[labels.indexOf(choice)];
    if (!candidate) return null;
    return candidate.fill ? { ...candidate.event, [candidate.fill]: text } : candidate.event;
  } catch {
    return null;
  }
}

/** The reply when typed text maps to no event: what the person can do instead. */
export function unclearTextReply(idle: ChatIdle): string {
  const labels = [...new Set(idle.events.map((event) => `“${event.label}”`))];
  return `I couldn’t tell which action that means. Available here: ${labels.join(", ")}.`;
}
