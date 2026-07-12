/**
 * Twenty Questions — decision loop + guard-enforced legality + machine-owned
 * human input.
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
 *   - Machine-owned input prompts: states that need the user invoke
 *     `agent.userInput` with prompt data derived from context, so the host can
 *     just insert the machine and press play.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/twenty-questions/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import { promptLine } from "../helpers/cli.js";
import {
  type AgentMessage,
  assistantMessage,
  createAgentSchemas,
  runAgent,
  setupAgent,
  userMessage,
} from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

const transcriptTurnSchema = z.object({
  question: z.string(),
  answer: z.enum(["yes", "no"]),
  rawAnswer: z.string(),
});

const answerClassificationSchema = z.object({
  answer: z.enum(["yes", "no"]),
  reasoning: z.string(),
});

const guessFeedbackClassificationSchema = z.object({
  correct: z.boolean(),
  reasoning: z.string(),
});

const playAgainClassificationSchema = z.object({
  playAgain: z.boolean(),
  reasoning: z.string(),
});

const models = {
  quick: openai("gpt-5.4-mini"),
} as const;

export const twentyQuestionsSchemas = createAgentSchemas({
  context: z.object({
    maxQuestions: z.number(),
    questionsRemaining: z.number(),
    transcript: z.array(transcriptTurnSchema),
    messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
    pendingRawAnswer: z.string().nullable(),
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
    ANSWER: z.object({ rawAnswer: z.string() }),
    GUESS_FEEDBACK: z.object({ rawAnswer: z.string() }),
    PLAY_AGAIN: z.object({ rawAnswer: z.string() }),
  },
});

const agentSetup = setupAgent({
  schemas: twentyQuestionsSchemas,
  models,
  requests: {
    classifyAnswer: {
      schemas: {
        input: z.object({
          question: z.string(),
          rawAnswer: z.string(),
          messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
          transcript: z.array(transcriptTurnSchema),
        }),
        output: answerClassificationSchema,
      },
      model: "quick",
      system:
        "Classify a natural-language answer to a Twenty Questions yes/no question. " +
        'Return answer=yes for affirmations like "mhm", "for sure", "correct", or indirect confirmations. ' +
        "Return answer=no for denials, corrections, or contradictions. Keep reasoning short.",
      messages: ({ input }) => [
        ...input.messages,
        userMessage(
          [
            `Question: ${input.question}`,
            `Raw answer: ${input.rawAnswer}`,
            "Classify the raw answer as yes or no.",
          ].join("\n"),
        ),
      ],
    },
    classifyGuessFeedback: {
      schemas: {
        input: z.object({
          guess: z.string(),
          rawAnswer: z.string(),
          messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
        }),
        output: guessFeedbackClassificationSchema,
      },
      model: "quick",
      system:
        "Classify whether the user says the Twenty Questions guess was correct. " +
        "Return correct=true for yes/correct/right. Return correct=false for no/wrong/incorrect.",
      messages: ({ input }) => [
        ...input.messages,
        userMessage(
          [
            `Guess: ${input.guess}`,
            `Raw answer: ${input.rawAnswer}`,
            "Classify whether the guess was correct.",
          ].join("\n"),
        ),
      ],
    },
    classifyPlayAgain: {
      schemas: {
        input: z.object({
          rawAnswer: z.string(),
          messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
        }),
        output: playAgainClassificationSchema,
      },
      model: "quick",
      system:
        "Classify whether the user wants to play another round. Return playAgain=true for yes; false for no.",
      messages: ({ input }) => [
        ...input.messages,
        userMessage(
          [
            "Question: Do you want to play another round?",
            `Raw answer: ${input.rawAnswer}`,
            "Classify whether the user wants another round.",
          ].join("\n"),
        ),
      ],
    },
  },
  // The only transition into `gameOver` is classifyingPlayAgain's onDone
  // (playAgain=false), reached only after a GUESS event already set `guess` —
  // guaranteed non-null there. `stumped` (reached on decide/classify errors,
  // possibly before any GUESS) is deliberately left unnarrowed.
  states: {
    deciding: {},
    awaitingAnswer: {},
    classifyingAnswer: {},
    // The play-again states are NOT narrowed even though `guess` is set by
    // then: their reset transition back to `deciding` writes `guess: null`,
    // and context updates typecheck against the SOURCE state's narrowed
    // context, so a narrowed source can never widen a field back to null.
    // Transitions into `gameOver` prove `guess` explicitly instead.
    awaitingGuessFeedback: {},
    classifyingGuessFeedback: {},
    awaitingPlayAgain: {},
    classifyingPlayAgain: {},
    gameOver: { schemas: { context: twentyQuestionsSchemas.context.extend({ guess: z.string() }) } },
    stumped: {},
  },
});

const DECIDE_SYSTEM_PROMPT =
  "You are playing twenty questions. Ask one yes/no question at a time to " +
  "narrow down the secret, or guess once you are confident. You have a " +
  "limited number of questions remaining.";

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

export const twentyQuestionsMachine = agentSetup.createMachine({
  id: "twenty-questions",
  context: ({ input }) => ({
    maxQuestions: input.questionsRemaining,
    questionsRemaining: input.questionsRemaining,
    transcript: [],
    messages: [],
    pendingRawAnswer: null,
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
          system: DECIDE_SYSTEM_PROMPT,
          prompt: renderTranscriptPrompt(context),
          // allowedEvents is an optional narrowing: listing events buys
          // compile-time typo safety (typed against the machine's event-schema
          // keys, ASK | GUESS | ANSWER). Omit it and all currently-legal
          // events are allowed.
          allowedEvents: ["ASK", "GUESS"] as const,
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
                  transcript: [
                    ...context.transcript,
                    {
                      question: event.question,
                      answer: "yes" as const,
                      rawAnswer: "",
                    },
                  ],
                  messages: [...context.messages, assistantMessage(event.question)],
                  questionsRemaining: context.questionsRemaining - 1,
                },
              }
            : undefined,
        GUESS: ({ context, event }) => ({
          target: "awaitingGuessFeedback",
          context: {
            guess: event.guess,
            messages: [
              ...context.messages,
              assistantMessage(`My guess is ${event.guess}. Was I right?`),
            ],
          },
        }),
      },
    },

    awaitingAnswer: {
      tags: ["awaiting-user"],
      invoke: {
        src: "agent.userInput",
        input: ({ context }) => ({
          prompt: context.transcript.at(-1)?.question ?? "Answer yes or no.",
        }),
        onDone: ({ event }) => ({
          target: "classifyingAnswer",
          context: {
            pendingRawAnswer: String(event.output ?? ""),
          },
        }),
      },
    },

    classifyingAnswer: {
      invoke: {
        src: "classifyAnswer",
        input: ({ context }) => ({
          question: context.transcript.at(-1)?.question ?? "",
          rawAnswer: context.pendingRawAnswer ?? "",
          messages: context.messages,
          transcript: context.transcript,
        }),
        onDone: ({ context, output }) => ({
          target: "deciding",
          context: {
            transcript: [
              ...context.transcript.slice(0, -1),
              {
                ...context.transcript.at(-1)!,
                answer: output.answer,
                rawAnswer: context.pendingRawAnswer ?? "",
              },
            ],
            messages: [...context.messages, userMessage(context.pendingRawAnswer ?? "")],
            pendingRawAnswer: null,
          },
        }),
        onError: { target: "stumped" },
      },
    },

    awaitingGuessFeedback: {
      tags: ["awaiting-user"],
      invoke: {
        src: "agent.userInput",
        input: ({ context }) => ({
          prompt: `My guess is ${context.guess}. Was I right?`,
        }),
        onDone: ({ event }) => ({
          target: "classifyingGuessFeedback",
          context: { pendingRawAnswer: String(event.output ?? "") },
        }),
      },
    },

    classifyingGuessFeedback: {
      invoke: {
        src: "classifyGuessFeedback",
        input: ({ context }) => ({
          guess: context.guess ?? "",
          rawAnswer: context.pendingRawAnswer ?? "",
          messages: context.messages,
        }),
        onDone: ({ context, output }) => ({
          target: "awaitingPlayAgain",
          context: {
            agentScore: context.agentScore + (output.correct ? 1 : 0),
            userScore: context.userScore + (output.correct ? 0 : 1),
            messages: [
              ...context.messages,
              userMessage(context.pendingRawAnswer ?? ""),
              assistantMessage("Do you want to play another round?"),
            ],
            pendingRawAnswer: null,
          },
        }),
        onError: { target: "awaitingPlayAgain" },
      },
    },

    awaitingPlayAgain: {
      tags: ["awaiting-user"],
      invoke: {
        src: "agent.userInput",
        input: {
          prompt: "Do you want to play another round?",
        },
        onDone: ({ event }) => ({
          target: "classifyingPlayAgain",
          context: { pendingRawAnswer: String(event.output ?? "") },
        }),
      },
    },

    classifyingPlayAgain: {
      invoke: {
        src: "classifyPlayAgain",
        input: ({ context }) => ({
          rawAnswer: context.pendingRawAnswer ?? "",
          messages: context.messages,
        }),
        onDone: ({ context, output }) =>
          output.playAgain
            ? {
                target: "deciding",
                context: {
                  questionsRemaining: context.maxQuestions,
                  transcript: [],
                  messages: [],
                  pendingRawAnswer: null,
                  guess: null,
                  round: context.round + 1,
                },
              }
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

    // Reached when chooseAction exhausts its retries (DecisionExhaustedError).
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

export async function main() {
  const result = await runAgent(twentyQuestionsMachine, {
    input: { questionsRemaining: 20 },
    ...executors,
    userInput: async ({ prompt }) => promptLine(`${prompt ?? ">"} `),
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Twenty questions did not complete: ${result.status}`);
  }

  console.log(`Final score — user: ${result.output.userScore}, agent: ${result.output.agentScore}`);
}

runExampleMain(import.meta.url, main);
