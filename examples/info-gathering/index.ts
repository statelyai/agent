/**
 * Information gathering — LangGraph's "prompt generation from user
 * requirements" chatbot as a machine that asks until four typed slots are
 * filled, then writes the prompt.
 *
 * The idea: a user wants a prompt template but rarely says everything up
 * front. The bot asks for the prompt's objective, the variables the template
 * takes, the constraints on its output, and the requirements it must meet,
 * one question at a time. Once all four are known, a second model call turns
 * them into the final prompt.
 *
 * LangGraph shape (tutorials/chatbots/information-gather-prompting) — two
 * model nodes and a conditional edge on "did the model call the tool?":
 *
 *   START → info ─┬─ (tool call) → add_tool_message → prompt → END
 *                 └─ (no tool call) → END   (wait for the next user message)
 *
 * Here the "is everything known?" test is not the model deciding to call a
 * `PromptInstructions` tool. The model only EXTRACTS what it heard (four
 * nullable fields) and phrases the next question; the machine merges the
 * extractions into context and a choice state checks the four slots itself:
 *
 *   gathering → checking ─┬─ generatingPrompt → done
 *        ▲                ├─ awaitingAnswer ──ANSWER──┘ (back to gathering)
 *        │                └─ failed   (MAX_TURNS answers, still incomplete)
 *        └──────────────── ANSWER
 *
 * What maps to what:
 *   - info node                → `gathering` (request `gatherRequirements`:
 *                                structured extraction + the next question)
 *   - PromptInstructions tool  → the four nullable context slots; "the tool was
 *                                called" becomes "all four slots are non-null"
 *   - conditional edge         → `checking` (a `choice` state with guards)
 *   - END (wait for the user)  → `awaitingAnswer`, a resting state with
 *                                `meta.interaction` and `textEvent: "ANSWER"`
 *   - add_tool_message         → nothing: there is no tool-call message to
 *                                balance, the extracted fields are just context
 *   - prompt node              → `generatingPrompt` (request `writePrompt`)
 *   - checkpointer + thread_id → `result.persist()` between `runAgent` calls
 *
 * Differences from LangGraph worth calling out:
 *   - Completeness is checked by the machine, not claimed by the model. In
 *     LangGraph the model decides when it has "enough" by calling the tool; a
 *     model that calls it early ships a prompt with a hole in it. Here a slot
 *     the model never filled keeps the run in the question loop.
 *   - One confirmation turn minimum. Even when the opening message fills all
 *     four slots, the first pass routes to `awaitingAnswer` (guard:
 *     `turns === 0`) so the human confirms what was extracted before a prompt
 *     is written. LangGraph can go straight to the prompt node on turn one.
 *   - The loop is bounded. LangGraph's chat loop is open-ended; here
 *     `MAX_TURNS` human answers are allowed, and a run that still has an empty
 *     slot after that lands in `failed` with the partial requirements listed,
 *     not in `done` with a half-specified prompt.
 *   - Extractions merge, they never erase: a later turn that returns `null`
 *     for a slot keeps the earlier value.
 *
 * Stand-ins: none. Both nodes are model calls; there is no retrieval or tool.
 *
 * Dual-mode: `runInfoGatheringExample(options?)` takes an injectable
 * `generateText` and scripted human events (tests pass both, so CI needs no
 * API key); the direct run uses real models and stdin.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/info-gathering/index.ts
 */
import { z } from "zod";
import type { SnapshotFrom } from "xstate";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getInteraction,
  getStatePath,
  interactionMetaSchema,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  gatherer: openai("gpt-5.4-mini"),
};

/** Human answers allowed before an incomplete run ends in `failed`. */
export const MAX_TURNS = 6;

/** The four slots the prompt needs, in the order the bot asks for them. */
export const REQUIREMENT_FIELDS = [
  "objective",
  "variables",
  "constraints",
  "requirements",
] as const;

type RequirementField = (typeof REQUIREMENT_FIELDS)[number];

const infoGatheringContextSchema = z.object({
  objective: z.string().nullable(),
  variables: z.string().nullable(),
  constraints: z.string().nullable(),
  requirements: z.string().nullable(),
  /** "User: …" / "Assistant: …" lines, oldest first. */
  transcript: z.array(z.string()),
  /** Human answers received so far; bounds the question loop. */
  turns: z.number(),
  /** The question the idle state shows (the one human-readable progress string). */
  question: z.string(),
  finalPrompt: z.string().nullable(),
  failure: z.string().nullable(),
});

type InfoGatheringContext = z.infer<typeof infoGatheringContextSchema>;

/** The slots still empty, in asking order. */
function missingFields(context: InfoGatheringContext): RequirementField[] {
  return REQUIREMENT_FIELDS.filter((field) => context[field] === null);
}

/** "objective: …" lines for whatever is known so far. */
function renderKnown(context: InfoGatheringContext): string {
  const known = REQUIREMENT_FIELDS.filter((field) => context[field] !== null);
  return known.length === 0
    ? "(nothing yet)"
    : known.map((field) => `- ${field}: ${context[field]}`).join("\n");
}

/** The `failed` notice: why it stopped, what was gathered, what is missing. */
function renderPartialNotice(context: InfoGatheringContext): string {
  const missing = missingFields(context);
  return [
    context.failure ??
      `Stopped after ${context.turns} answer(s) (MAX_TURNS=${MAX_TURNS}) without all four requirements.`,
    "",
    "Gathered so far:",
    renderKnown(context),
    "",
    `Still missing: ${missing.length ? missing.join(", ") : "(none)"}`,
  ].join("\n");
}

const extractionSchema = z.object({
  objective: z.string().nullable(),
  variables: z.string().nullable(),
  constraints: z.string().nullable(),
  requirements: z.string().nullable(),
  nextQuestion: z.string(),
});

const agentSetup = setupAgent({
  models,
  meta: interactionMetaSchema,
  context: infoGatheringContextSchema,
  // A single string field, so a demo chat message (or a starter chip) seeds the
  // user's first message. Empty means "start by asking".
  input: z.object({ opener: z.string().default("") }),
  output: z.object({
    prompt: z.string(),
    objective: z.string().nullable(),
    variables: z.string().nullable(),
    constraints: z.string().nullable(),
    requirements: z.string().nullable(),
    turns: z.number(),
  }),
  events: {
    ANSWER: z.object({ text: z.string() }),
  },
  // `generatingPrompt` always sets `finalPrompt` before `done` reads it.
  states: {
    done: {
      schemas: { context: infoGatheringContextSchema.extend({ finalPrompt: z.string() }) },
    },
  },
  requests: {
    // info node: extract what the user has said so far, and ask the next thing.
    gatherRequirements: {
      schemas: {
        input: z.object({
          transcript: z.array(z.string()),
          known: z.string(),
          missing: z.array(z.string()),
        }),
        output: extractionSchema,
      },
      model: "gatherer",
      system:
        "You help a user specify a prompt template. You need four things: the " +
        "OBJECTIVE of the prompt, the VARIABLES passed into the template, any " +
        "CONSTRAINTS on what the output must NOT do, and any REQUIREMENTS the output " +
        "MUST satisfy. From the conversation, extract each one you can (a short " +
        "phrase), or null if the user has not said it. Do not guess. Then write " +
        "nextQuestion: one short question asking for the first missing item, or, if " +
        "nothing is missing, a question asking the user to confirm the summary.",
      prompt: ({ input }) =>
        [
          "Conversation so far:",
          input.transcript.length ? input.transcript.join("\n") : "(the user has not spoken yet)",
          "",
          "Already known:",
          input.known,
          "",
          `Still missing: ${input.missing.length ? input.missing.join(", ") : "(none)"}`,
        ].join("\n"),
    },
    // prompt node: turn the four slots into the final prompt template.
    writePrompt: {
      schemas: {
        input: z.object({
          objective: z.string(),
          variables: z.string(),
          constraints: z.string(),
          requirements: z.string(),
        }),
        output: z.object({ prompt: z.string() }),
      },
      model: "gatherer",
      system:
        "Write a clear, reusable prompt template from the user's requirements. Refer " +
        "to each variable as {variable_name}. Return only the template.",
      prompt: ({ input }) =>
        [
          `Objective: ${input.objective}`,
          `Variables: ${input.variables}`,
          `Constraints: ${input.constraints}`,
          `Requirements: ${input.requirements}`,
        ].join("\n"),
    },
  },
});

export const infoGatheringSchemas = agentSetup.schemas;

export const infoGatheringMachine = agentSetup.createMachine({
  id: "info-gathering",
  context: ({ input }) => ({
    objective: null,
    variables: null,
    constraints: null,
    requirements: null,
    transcript: input.opener.trim() ? [`User: ${input.opener.trim()}`] : [],
    turns: 0,
    question: "",
    finalPrompt: null,
    failure: null,
  }),
  initial: "gathering",
  states: {
    // info: one extraction + next-question call per pass. Non-null extractions
    // merge into context; null never erases an earlier answer.
    gathering: {
      invoke: {
        src: "gatherRequirements",
        input: ({ context }) => ({
          transcript: context.transcript,
          known: renderKnown(context),
          missing: missingFields(context),
        }),
        onDone: ({ context, output }) => ({
          target: "checking",
          context: {
            objective: output.result.objective ?? context.objective,
            variables: output.result.variables ?? context.variables,
            constraints: output.result.constraints ?? context.constraints,
            requirements: output.result.requirements ?? context.requirements,
            question: output.result.nextQuestion,
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `gatherRequirements failed: ${String(event.error)}` },
        }),
      },
    },
    // The conditional edge. Order matters:
    //   1. one confirmation turn minimum — the first pass always asks;
    //   2. all four slots filled → write the prompt;
    //   3. answer budget spent with a slot still empty → failed;
    //   4. otherwise ask the next question.
    checking: {
      type: "choice",
      choice: ({ context }) => {
        if (context.turns === 0) return { target: "awaitingAnswer" };
        if (missingFields(context).length === 0) return { target: "generatingPrompt" };
        if (context.turns >= MAX_TURNS) return { target: "failed" };
        return { target: "awaitingAnswer" };
      },
    },
    // Resting state: the run settles idle here and a host resumes with ANSWER.
    awaitingAnswer: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{question}",
          textEvent: "ANSWER",
          events: { ANSWER: { label: "Reply", style: "primary" } },
        },
      },
      on: {
        ANSWER: ({ context, event }) => ({
          target: "gathering",
          context: {
            transcript: [
              ...context.transcript,
              `Assistant: ${context.question}`,
              `User: ${event.text}`,
            ],
            turns: context.turns + 1,
          },
        }),
      },
    },
    // prompt: every slot is non-null here (the choice guard checked it).
    generatingPrompt: {
      invoke: {
        src: "writePrompt",
        input: ({ context }) => ({
          objective: context.objective ?? "",
          variables: context.variables ?? "",
          constraints: context.constraints ?? "",
          requirements: context.requirements ?? "",
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { finalPrompt: output.result.prompt },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `writePrompt failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        prompt: context.finalPrompt,
        objective: context.objective,
        variables: context.variables,
        constraints: context.constraints,
        requirements: context.requirements,
        turns: context.turns,
      }),
    },
    // Budget spent (or a model call failed) before all four slots were known:
    // the partial requirements are the best-effort output, not a prompt.
    failed: {
      type: "final",
      output: ({ context }) => ({
        prompt: renderPartialNotice(context),
        objective: context.objective,
        variables: context.variables,
        constraints: context.constraints,
        requirements: context.requirements,
        turns: context.turns,
      }),
    },
  },
});

type InfoGatheringSnapshot = SnapshotFrom<typeof infoGatheringMachine>;

/** What a host (or the test) sends to unblock the idle question state. */
export type InfoGatheringHumanEvent = { type: "ANSWER"; text: string };

export interface RunInfoGatheringOptions {
  /** The user's first message; empty starts with the bot asking. */
  opener?: string;
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Scripted human answers, consumed in order on each idle settle; then stdin. */
  humanEvents?: InfoGatheringHumanEvent[];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
  /** Observes each question the bot asks while idle. */
  onQuestion?: (question: string) => void;
}

export interface InfoGatheringResult {
  prompt: string;
  objective: string | null;
  variables: string | null;
  constraints: string | null;
  requirements: string | null;
  turns: number;
  /** The final state reached: `done` or `failed`. */
  outcome: string;
  progress: string[];
}

/** Runs the gather-then-prompt loop, resuming from `persist()` on every idle settle. */
export async function runInfoGatheringExample(
  options: RunInfoGatheringOptions = {},
): Promise<InfoGatheringResult> {
  const { opener = "", generateText, onProgress, onQuestion } = options;
  const queued = [...(options.humanEvents ?? [])];
  const progress: string[] = [];
  const shared = {
    executors: generateText ? { generateText } : createAiSdkExecutors({ models }),
    onTransition: (snapshot: InfoGatheringSnapshot) => {
      const state = getStatePath(snapshot);
      // A resume re-reports the restored state; record each state once per visit.
      if (progress.at(-1) === state) return;
      progress.push(state);
      onProgress?.(state);
    },
  };

  let result = await runToQuiescence(
    createAgentRuntime(infoGatheringMachine, {
      ...shared,
    }),
    {
      input: { opener },
      ...shared,
    },
  );
  while (result.status === "idle") {
    const question = getInteraction(result.snapshot)?.label ?? result.snapshot.context.question;
    onQuestion?.(question);
    const event = queued.shift() ?? {
      type: "ANSWER" as const,
      text: await promptLine(`${question}\n> `),
    };
    result = await runToQuiescence(
      createAgentRuntime(infoGatheringMachine, {
        ...shared,
      }),
      {
        snapshot: result.persist(),
        event,
        ...shared,
      },
    );
  }

  if (result.status !== "done") {
    throw new Error(`Info-gathering example did not complete: ${result.status}`);
  }
  return { ...result.output, outcome: getStatePath(result.snapshot), progress };
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
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runInfoGatheringExample({
      opener: "I need a prompt that extracts invoice fields from emails",
    });
    console.log(`\n[${result.outcome} after ${result.turns} answer(s)]\n`);
    console.log(result.prompt);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
