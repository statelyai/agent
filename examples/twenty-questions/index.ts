/**
 * Twenty Questions — decision loop + guard-enforced legality + human turns as
 * gated machine events.
 *
 * The agent asks yes/no questions to narrow down a secret, then guesses.
 * Showcases:
 *   - Inline `agent.decide` invoke (chosen event auto-delivered): the model picks
 *     exactly one currently-legal event (ASK or GUESS) each turn. The
 *     decision is authored state-local — it lives in the `deciding` state
 *     that invokes it, typed against the machine's own event schemas.
 *   - Guard-enforced legality: the final turn must be GUESS, so ASK is
 *     only legal while `questionsRemaining > 1` (a v6 function-transition
 *     returning `undefined` when illegal). If the model chooses ASK on the
 *     final turn, `resolveDecision`'s mode-3 `canTake` check rejects it
 *     (`failure: 'rejected-by-guard'`) and retries.
 *   - Human turns as idle states with `meta.interaction` hints. States waiting
 *     on the player have no invoke, so the run settles `idle`; the hints tell a
 *     host which buttons to render (`ANSWER_YES` / `ANSWER_NO`, …) and which
 *     event free chat text becomes (`textEvent`). Labels interpolate
 *     `{question}` against the snapshot context, so the button row is captioned
 *     with whatever the agent just asked. Resume with
 *     `runAgent(machine, { snapshot: result.persist(), event })`.
 *   - Two paths into the same state: button events are deterministic (no model
 *     call), free text goes through a Jev judgment instead.
 *   - Reading the player's free text is a JUDGMENT, not a generation. Each of
 *     the three classifying states calls the AI SDK's `experimental_evaluate`
 *     with Jev (`@ai-sdk/typesafe-ai`) as the evaluation model, with the
 *     pending prompt and the raw reply as state: a `choice` among
 *     yes / no / sideQuestion for an answer, and a boolean question each for "does the
 *     player say the guess was right?" and "does the player want another
 *     round?", compared with `GUESS_CORRECT_THRESHOLD` and
 *     `PLAY_AGAIN_THRESHOLD`. The asker stays an `agent.decide` (it chooses
 *     the machine's next event), and the side answer stays a text request.
 *   - Side-question detour: the player's free-text reply to a yes/no question
 *     may itself be a question ("is a lizard considered domestic?"). When Jev
 *     picks `sideQuestion`, the reply itself is the side question: the branch
 *     answers it (without revealing the secret), emits the answer
 *     (`SIDE_ANSWER`), and re-asks the SAME pending question. No turn is
 *     consumed and the transcript entry is untouched.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/twenty-questions/index.ts
 */
import { z } from "zod";
import { createAsyncLogic, type SnapshotFrom } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  type AgentMessage,
  assistantMessage,
  createAgentSchemas,
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  messagesSchema,
  runAgent,
  setupAgent,
  userMessage,
  type EventOf,
} from "@statelyai/agent";

/**
 * The library's `messagesSchema` really validates roles, parts and media
 * payloads. It is a Standard Schema rather than a zod one, so `z.object`
 * cannot take it as a field directly; this adapter delegates to it.
 */
const messagesField = z.custom<AgentMessage[]>(
  (value) => !("issues" in messagesSchema["~standard"].validate(value)),
  { message: "Expected an array of agent messages" },
);

const transcriptTurnSchema = z.object({
  question: z.string(),
  answer: z.enum(["yes", "no"]),
  rawAnswer: z.string(),
});

const PLAY_AGAIN_PROMPT = "Do you want to play another round?";

/** Free-text guess feedback counts as "right" when Jev's probability clears this. */
export const GUESS_CORRECT_THRESHOLD = 0.5;
/** A free-text reply starts another round when Jev's probability clears this. */
export const PLAY_AGAIN_THRESHOLD = 0.5;

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/**
 * The player's reply to a yes/no question, as a `choice` judgment: yes, no,
 * or a side question asked back. The judge model is injected by tests and
 * hosts; the default is Jev.
 */
export function createClassifyAnswer(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { reply: { choice: "yes" | "no" | "sideQuestion" } } },
    { question: string; rawAnswer: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { question: input.question, reply: input.rawAnswer },
        questions: {
          reply: {
            type: "choice" as const,
            instructions: "How does `reply` respond to the yes/no `question`?",
            criteria: {
              yes: 'An affirmation: "mhm", "for sure", "correct", or an indirect confirmation.',
              no: "A denial, a correction, or a contradiction.",
              sideQuestion:
                'A question asked back instead of an answer, e.g. "is a lizard considered domestic?".',
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** Free-text guess feedback as a boolean question. */
export function createClassifyGuessFeedback(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { guessCorrect: { probability: number } } },
    { guess: string; rawAnswer: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { guess: input.guess, reply: input.rawAnswer },
        questions: {
          guessCorrect: {
            type: "boolean" as const,
            instructions: "Does `reply` say that `guess` was correct?",
            criteria: {
              true: "Yes, correct, right, got it.",
              false: "No, wrong, incorrect, or a different answer.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** Free-text reply to the play-again prompt as a boolean question. */
export function createClassifyPlayAgain(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { playAgain: { probability: number } } },
    { rawAnswer: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { question: PLAY_AGAIN_PROMPT, reply: input.rawAnswer },
        questions: {
          playAgain: {
            type: "boolean" as const,
            instructions: "Does `reply` say the player wants another round?",
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

const models = {
  quick: openai("gpt-5.4-mini"),
};

export const twentyQuestionsSchemas = createAgentSchemas({
  meta: interactionMetaSchema,
  context: z.object({
    /** What the agent is currently waiting on; `{question}` in idle labels. */
    question: z.string(),
    maxQuestions: z.number(),
    questionsRemaining: z.number(),
    transcript: z.array(transcriptTurnSchema),
    messages: messagesField,
    pendingRawAnswer: z.string().nullable(),
    pendingSideQuestion: z.string().nullable(),
    guess: z.string().nullable(),
    userScore: z.number(),
    agentScore: z.number(),
    round: z.number(),
  }),
  input: z.object({
    questionsRemaining: z.number().default(20),
  }),
  output: z.object({
    guess: z.string(),
    questionsUsed: z.number(),
    userScore: z.number(),
    agentScore: z.number(),
    roundsPlayed: z.number(),
  }),
  events: {
    ASK: z.object({ question: z.string() }),
    GUESS: z.object({ guess: z.string() }),
    /** Free-text player replies (the `textEvent` of each idle state). */
    ANSWER: z.object({ rawAnswer: z.string() }),
    GUESS_FEEDBACK: z.object({ rawAnswer: z.string() }),
    PLAY_AGAIN: z.object({ rawAnswer: z.string() }),
    /** Button replies: deterministic, no classifier call. */
    ANSWER_YES: z.object({}),
    ANSWER_NO: z.object({}),
    GUESS_RIGHT: z.object({}),
    GUESS_WRONG: z.object({}),
    PLAY_AGAIN_YES: z.object({}),
    PLAY_AGAIN_NO: z.object({}),
  },
  emitted: {
    // The agent's brief answer to a player's side question, surfaced so the
    // host can print it before the pending question is re-asked.
    SIDE_ANSWER: z.object({ question: z.string(), answer: z.string() }),
  },
});

const agentSetup = setupAgent({
  schemas: twentyQuestionsSchemas,
  models,
  actors: {
    // Reading free-text replies: Jev judgments (see createClassify* above).
    classifyAnswer: createClassifyAnswer(),
    classifyGuessFeedback: createClassifyGuessFeedback(),
    classifyPlayAgain: createClassifyPlayAgain(),
  },
  requests: {
    answerSideQuestion: {
      schemas: {
        input: z.object({
          question: z.string(),
          transcript: z.array(transcriptTurnSchema),
        }),
        output: z.string(),
      },
      model: "quick",
      system:
        "The Twenty Questions player asked you a side question instead of answering yes/no. " +
        "Answer it briefly and factually in one sentence, using the transcript for context. " +
        "Do NOT reveal, speculate about, or hint at what the secret might be — the game " +
        "continues after your answer.",
      prompt: ({ input }) =>
        [
          "Transcript so far:",
          input.transcript.length === 0
            ? "(none yet)"
            : input.transcript.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n"),
          `Side question: ${input.question}`,
        ].join("\n"),
    },
  },
  // Only `gameOver` is narrowed. The only transition into it is
  // classifyingPlayAgain's onDone (playAgain below threshold), reached only after a GUESS
  // event already set `guess` — guaranteed non-null there. Every other state is
  // left at the base context: partial `states` means unlisted states keep it,
  // and states whose reset transitions write `guess`/`pendingSideQuestion` back
  // to null cannot be narrowed (a narrowed source can't widen a field).
  states: {
    gameOver: {
      schemas: { context: twentyQuestionsSchemas.context.extend({ guess: z.string() }) },
    },
  },
});

function renderTranscriptPrompt(context: {
  questionsRemaining: number;
  transcript: { question: string; answer: "yes" | "no"; rawAnswer: string }[];
  messages: AgentMessage[];
}): string {
  return [
    `Questions remaining: ${context.questionsRemaining}`,
    `Messages so far: ${JSON.stringify(context.messages)}`,
    "Transcript so far:",
    context.transcript.length === 0
      ? "(none yet)"
      : context.transcript
          .map(
            (turn) =>
              `Q: ${turn.question}\nA: ${turn.answer}` +
              (turn.rawAnswer ? ` (raw: ${turn.rawAnswer})` : ""),
          )
          .join("\n"),
    "If the player reveals the secret or gives extra information in a raw answer, use it and guess immediately.",
    "Avoid repeating categories already answered. If something is an animal, do not ask if it is a plant, fungus, or microorganism.",
    context.questionsRemaining > 1
      ? "Ask a yes/no question (ASK) or make your guess (GUESS)."
      : "This is the final turn. You must make your guess now (GUESS).",
  ].join("\n");
}

/**
 * Append the pending question to the transcript, now that it has an answer.
 * The pending question lives in `context.question` until then, so an unanswered
 * question never shows up as history.
 */
function withAnswer(
  context: {
    question: string;
    transcript: { question: string; answer: "yes" | "no"; rawAnswer: string }[];
    messages: AgentMessage[];
  },
  answer: "yes" | "no",
  rawAnswer: string,
) {
  return {
    transcript: [...context.transcript, { question: context.question, answer, rawAnswer }],
    messages: [...context.messages, userMessage(rawAnswer)],
    pendingRawAnswer: null,
  };
}

/** Apply guess feedback to the score and queue the play-again prompt. */
function withGuessFeedback(
  context: { agentScore: number; userScore: number; messages: AgentMessage[] },
  correct: boolean,
  rawAnswer: string,
) {
  return {
    agentScore: context.agentScore + (correct ? 1 : 0),
    userScore: context.userScore + (correct ? 0 : 1),
    messages: [...context.messages, userMessage(rawAnswer), assistantMessage(PLAY_AGAIN_PROMPT)],
    pendingRawAnswer: null,
    question: PLAY_AGAIN_PROMPT,
  };
}

/** Reset for another round; scores and round count carry over. */
function freshRound(context: { maxQuestions: number; round: number }) {
  return {
    questionsRemaining: context.maxQuestions,
    transcript: [],
    messages: [],
    pendingRawAnswer: null,
    pendingSideQuestion: null,
    guess: null,
    question: "",
    round: context.round + 1,
  };
}

export const twentyQuestionsMachine = agentSetup.createMachine({
  id: "twenty-questions",
  context: ({ input }) => ({
    question: "",
    maxQuestions: input.questionsRemaining,
    questionsRemaining: input.questionsRemaining,
    transcript: [],
    messages: [],
    pendingRawAnswer: null,
    pendingSideQuestion: null,
    guess: null,
    userScore: 0,
    agentScore: 0,
    round: 1,
  }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          system:
            "You are playing twenty questions. Ask one yes/no question at a time to " +
            "narrow down the secret, or guess once you are confident. You have a " +
            "limited number of questions remaining.",
          prompt: renderTranscriptPrompt(context),
          maxRetries: 2,
        }),
        onError: { target: "stumped" },
      },
      on: {
        // Guard: ASK is only legal before the final turn. Returning
        // `undefined` makes the transition illegal — `snapshot.can(event)`
        // (resolveDecision's mode-3 check) will reject an ASK chosen with
        // one turn remaining, recording `failure: 'rejected-by-guard'` and
        // retrying. The model must GUESS on the final turn.
        ASK: ({ context, event }) =>
          context.questionsRemaining > 1
            ? {
                target: "awaitingAnswer",
                context: {
                  // The pending question stays out of `transcript` until the
                  // player actually answers it.
                  question: event.question,
                  messages: [...context.messages, assistantMessage(event.question)],
                  questionsRemaining: context.questionsRemaining - 1,
                },
              }
            : undefined,
        GUESS: ({ context, event }) => ({
          target: "awaitingGuessFeedback",
          context: {
            guess: event.guess,
            question: `My guess is ${event.guess}. Was I right?`,
            messages: [
              ...context.messages,
              assistantMessage(`My guess is ${event.guess}. Was I right?`),
            ],
          },
        }),
      },
    },

    // No invoke: the run settles idle here and a host resumes with one of the
    // accepted events. Buttons answer directly; free text goes to ANSWER and
    // gets classified (which is also how side questions are detected).
    awaitingAnswer: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{question}",
          events: {
            ANSWER_YES: { label: "Yes", style: "primary" },
            ANSWER_NO: { label: "No" },
            ANSWER: { label: "Reply" },
          },
          textEvent: "ANSWER",
        },
      },
      on: {
        ANSWER_YES: ({ context }) => ({
          target: "deciding",
          context: withAnswer(context, "yes", "yes"),
        }),
        ANSWER_NO: ({ context }) => ({
          target: "deciding",
          context: withAnswer(context, "no", "no"),
        }),
        ANSWER: ({ event }) => ({
          target: "classifyingAnswer",
          context: { pendingRawAnswer: event.rawAnswer },
        }),
      },
    },

    classifyingAnswer: {
      invoke: {
        src: "classifyAnswer",
        input: ({ context }) => ({
          question: context.question,
          rawAnswer: context.pendingRawAnswer ?? "",
        }),
        onDone: ({ context, output }) => {
          const reply = output.answers.reply.choice;
          return reply === "sideQuestion"
            ? {
                // Detour: answer the player's side question (the reply
                // itself), then re-ask the SAME pending question. The
                // transcript entry and turn count are untouched.
                target: "answeringSideQuestion",
                context: {
                  pendingSideQuestion: context.pendingRawAnswer ?? "",
                  pendingRawAnswer: null,
                },
              }
            : {
                target: "deciding",
                context: withAnswer(context, reply, context.pendingRawAnswer ?? ""),
              };
        },
        onError: { target: "stumped" },
      },
    },

    answeringSideQuestion: {
      invoke: {
        src: "answerSideQuestion",
        input: ({ context }) => ({
          question: context.pendingSideQuestion ?? "",
          transcript: context.transcript,
        }),
        onDone: ({ context, output }, enq) => {
          // Surface the answer to the host, then return to the pending
          // question — awaitingAnswer re-prompts with the same transcript
          // entry, so no turn is consumed.
          enq.emit({
            type: "SIDE_ANSWER",
            question: context.pendingSideQuestion ?? "",
            answer: output.result,
          });
          return {
            target: "awaitingAnswer",
            context: {
              pendingSideQuestion: null,
              messages: [
                ...context.messages,
                userMessage(context.pendingSideQuestion ?? ""),
                assistantMessage(output.result),
              ],
            },
          };
        },
        // If the side answer fails, just re-ask the pending question.
        onError: {
          target: "awaitingAnswer",
          context: { pendingSideQuestion: null },
        },
      },
    },

    awaitingGuessFeedback: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{question}",
          events: {
            GUESS_RIGHT: { label: "Got it", style: "primary" },
            GUESS_WRONG: { label: "Nope", style: "danger" },
            GUESS_FEEDBACK: { label: "Reply" },
          },
          textEvent: "GUESS_FEEDBACK",
        },
      },
      on: {
        GUESS_RIGHT: ({ context }) => ({
          target: "awaitingPlayAgain",
          context: withGuessFeedback(context, true, "correct"),
        }),
        GUESS_WRONG: ({ context }) => ({
          target: "awaitingPlayAgain",
          context: withGuessFeedback(context, false, "wrong"),
        }),
        GUESS_FEEDBACK: ({ event }) => ({
          target: "classifyingGuessFeedback",
          context: { pendingRawAnswer: event.rawAnswer },
        }),
      },
    },

    classifyingGuessFeedback: {
      invoke: {
        src: "classifyGuessFeedback",
        input: ({ context }) => ({
          guess: context.guess ?? "",
          rawAnswer: context.pendingRawAnswer ?? "",
        }),
        onDone: ({ context, output }) => ({
          target: "awaitingPlayAgain",
          context: withGuessFeedback(
            context,
            output.answers.guessCorrect.probability >= GUESS_CORRECT_THRESHOLD,
            context.pendingRawAnswer ?? "",
          ),
        }),
        onError: {
          target: "awaitingPlayAgain",
          context: { question: PLAY_AGAIN_PROMPT },
        },
      },
    },

    awaitingPlayAgain: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{question}",
          events: {
            PLAY_AGAIN_YES: { label: "Play again", style: "primary" },
            PLAY_AGAIN_NO: { label: "Stop here" },
            PLAY_AGAIN: { label: "Reply" },
          },
          textEvent: "PLAY_AGAIN",
        },
      },
      on: {
        PLAY_AGAIN_YES: ({ context }) => ({
          target: "deciding",
          context: freshRound(context),
        }),
        PLAY_AGAIN_NO: ({ context }) => ({
          target: "gameOver",
          context: {
            messages: [...context.messages, userMessage("no")],
            pendingRawAnswer: null,
            guess: context.guess ?? "",
          },
        }),
        PLAY_AGAIN: ({ event }) => ({
          target: "classifyingPlayAgain",
          context: { pendingRawAnswer: event.rawAnswer },
        }),
      },
    },

    classifyingPlayAgain: {
      invoke: {
        src: "classifyPlayAgain",
        input: ({ context }) => ({
          rawAnswer: context.pendingRawAnswer ?? "",
        }),
        onDone: ({ context, output }) =>
          output.answers.playAgain.probability >= PLAY_AGAIN_THRESHOLD
            ? { target: "deciding", context: freshRound(context) }
            : {
                target: "gameOver",
                context: {
                  messages: [...context.messages, userMessage(context.pendingRawAnswer ?? "")],
                  pendingRawAnswer: null,
                  // Prove gameOver's narrowing: a GUESS always preceded this state.
                  guess: context.guess ?? "",
                },
              },
        onError: ({ context }) => ({
          target: "gameOver",
          context: { guess: context.guess ?? "" },
        }),
      },
    },

    gameOver: {
      type: "final",
      output: ({ context }) => ({
        guess: context.guess,
        questionsUsed: context.transcript.length,
        userScore: context.userScore,
        agentScore: context.agentScore,
        roundsPlayed: context.round,
      }),
    },

    // Reached when chooseAction exhausts its retries (AgentDecisionExhaustedError).
    stumped: {
      type: "final",
      output: ({ context }) => ({
        guess: "",
        questionsUsed: context.transcript.length,
        userScore: context.userScore,
        agentScore: context.agentScore,
        roundsPlayed: context.round,
      }),
    },
  },
});

const executors = createAiSdkExecutors({ models });

type TwentyQuestionsSnapshot = SnapshotFrom<typeof twentyQuestionsMachine>;

/**
 * What a host (or the test) sends to unblock an idle machine: the player-facing
 * slice of the machine's own event union, so payloads are never restated here.
 */
export type PlayerEvent = Extract<
  EventOf<typeof twentyQuestionsMachine>,
  {
    type:
      | "ANSWER"
      | "ANSWER_NO"
      | "ANSWER_YES"
      | "GUESS_FEEDBACK"
      | "GUESS_RIGHT"
      | "GUESS_WRONG"
      | "PLAY_AGAIN"
      | "PLAY_AGAIN_NO"
      | "PLAY_AGAIN_YES";
  }
>;

/** Prompt for whatever the idle state is waiting on, from its meta hint. */
export function idlePrompt(snapshot: TwentyQuestionsSnapshot): string {
  return getInteraction(snapshot)?.label || "?";
}

/**
 * Route free text to the idle state's `textEvent`. `eventFromInteraction` is
 * not usable here: it always names the free-text field `text`, and these
 * events carry it as `rawAnswer`.
 */
export function toPlayerEvent(snapshot: TwentyQuestionsSnapshot, text: string): PlayerEvent {
  const textEvent = getInteraction(snapshot)?.textEvent ?? "ANSWER";
  return { type: textEvent, rawAnswer: text } as PlayerEvent;
}

export async function main() {
  const shared = {
    executors,
    on: {
      SIDE_ANSWER: ({ answer }: { answer: string }) => console.log(`[side answer] ${answer}`),
    },
    onTransition: (snapshot: TwentyQuestionsSnapshot) =>
      console.log("[state]", getStatePath(snapshot)),
  };

  let result = await runAgent(twentyQuestionsMachine, {
    input: { questionsRemaining: 20 },
    ...shared,
  });

  // Every player turn settles the run idle. Resume from `result.persist()`.
  while (result.status === "idle") {
    const text = await promptLine(`${idlePrompt(result.snapshot)}\n> `);
    result = await runAgent(twentyQuestionsMachine, {
      snapshot: result.persist(),
      event: toPlayerEvent(result.snapshot, text),
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Twenty questions did not complete: ${result.status}`);
  }

  console.log(`Final score — user: ${result.output.userScore}, agent: ${result.output.agentScore}`);
}

/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
