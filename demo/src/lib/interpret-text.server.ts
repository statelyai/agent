/**
 * Free chat text → one of the events an idle machine offers, whenever more
 * than one reading is on offer (see `textRouting`). "bank", "Cleo", "Looks
 * good, book it" are clear enough to a person; reading them as a typed event
 * is a Jev `choice` over the offered events (see `textCandidates`), the same
 * way the approval scenario reads a review (`createInterpretReview` in
 * `agent-runner.ts`). A state's text event, declared or inferred, is one of
 * the readings — the catch-all for a reply that is a message in its own right
 * — so "approve it" is not sent as rejection feedback.
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

/** Case, spacing and trailing punctuation don't change which name a reply is. */
function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
}

/** The label Jev picks when the text asks for none of the offered events. */
const UNCLEAR = "unclear";

const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/**
 * What Jev is told. The app's prompt is background, not the question: after a
 * round of rock-paper-scissors it reads "you threw scissors, the agent threw
 * paper", and a judge that weighs those words against the reply grows unsure
 * of a bare "rock". Saying so, and that a bare name chooses, is what keeps
 * one-word replies confident. The prompt also says what values stand for
 * ("2=Cleo"), so a name can choose a number.
 */
const INSTRUCTIONS =
  "A person typed `reply` into an app that is waiting for them to choose one of `actions`." +
  " `appSaid`, when present, is what the app last showed them: background only. It may" +
  " describe earlier turns, and an action it mentions is not chosen unless the reply chooses" +
  " it; it may also say what values stand for (which number is which name)." +
  " A reply that names an action or a value, alone or in a sentence, chooses it; one that" +
  ' agrees ("looks good", "yes", "go ahead") chooses the action that accepts or' +
  " proceeds." +
  " Which option does `reply` choose?";

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
      /** The offered actions' button labels, for the judge's context. */
      actions: string[];
      criteria: Record<string, string>;
      /** The run's request signal: a Cancel stops the judgment too. */
      requestSignal?: AbortSignal;
    }
  >({
    run: async ({ input, signal }) => {
      const { answers, providerMetadata } = await evaluate({
        model,
        state: {
          reply: input.message,
          actions: input.actions,
          ...(input.prompt ? { appSaid: input.prompt } : {}),
        },
        questions: {
          action: {
            type: "choice" as const,
            instructions: INSTRUCTIONS,
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
 * nothing. The state's text event, when there is one, is the catch-all
 * reading: chosen, it carries the whole text at any confidence (it is what
 * the state asks free text to be), and it replaces "unclear". Any other
 * reading must clear `TEXT_EVENT_CONFIDENCE`, so an unsure "approve" is asked
 * about, never sent as something else. `judge` is injected by tests;
 * omitted, Jev reads the key.
 */
export async function interpretIdleText(
  text: string,
  idle: ChatIdle,
  options: { signal?: AbortSignal; judge?: Experimental_EvaluationModel } = {},
): Promise<({ type: string } & JsonObject) | null> {
  const candidates = textCandidates(idle.events);
  if (!candidates.length) return null;
  // A reply that is exactly one choice's name needs no judgment.
  const named = candidates.filter((candidate) =>
    candidate.names.some((name) => normalizeName(name) === normalizeName(text)),
  );
  if (named.length === 1) return named[0]!.event;
  const textEvent = idle.textEvent;
  const catchAll = textEvent
    ? candidates.findIndex(
        (candidate) =>
          candidate.fill === textEvent.field && candidate.event.type === textEvent.type,
      )
    : -1;
  const labels = candidates.map((_, index) => `option_${index + 1}`);
  const criteria: Record<string, string> = Object.fromEntries(
    candidates.map((candidate, index) => {
      if (index !== catchAll) return [labels[index], candidate.description];
      const label = idle.events.find((event) => event.type === candidate.event.type)?.label;
      return [
        labels[index],
        `Not a choice of another option but a message of its own (an answer, a question,` +
          ` changes to make, a reason), sent with "${label ?? candidate.event.type}".`,
      ];
    }),
  );
  if (catchAll === -1) {
    criteria[UNCLEAR] = "Chooses none of the other options, or could mean more than one of them.";
  }
  try {
    const actor = createActor(createInterpretText(options.judge), {
      input: {
        message: text,
        prompt: idle.prompt,
        actions: [...new Set(idle.events.map((event) => event.label))],
        criteria,
        requestSignal: options.signal,
      },
    });
    actor.start();
    const { choice, confidence } = await toPromise(actor);
    const index = labels.indexOf(choice);
    const candidate = candidates[index];
    if (!candidate) return null;
    if (index !== catchAll && confidence < TEXT_EVENT_CONFIDENCE) return null;
    return candidate.fill ? { ...candidate.event, [candidate.fill]: text } : candidate.event;
  } catch (error) {
    // Reads as "unclear" to the person, but a failed judgment (a bad key, an
    // outage) is not the same thing as an unclear reply: say so in the log.
    if (!options.signal?.aborted) console.warn("[interpret-text] Jev judgment failed:", error);
    return null;
  }
}

/** The reply when typed text maps to no event: what the person can do instead. */
export function unclearTextReply(idle: ChatIdle): string {
  const labels = [...new Set(idle.events.map((event) => `“${event.label}”`))];
  return `I couldn’t tell which action that means. Available here: ${labels.join(", ")}.`;
}
