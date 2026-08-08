/**
 * Reflection (essay writer) — LangGraph's canonical Reflection tutorial as an
 * EXPLICIT machine: a generator drafts an essay, a critique persona grades it,
 * and the feedback loops back into a revision. drafting → critiquing →
 * (revise loop back to drafting) → done.
 *
 * LangGraph: two nodes (`generate` ↔ `reflect`) cycle, and a `should_continue`
 * conditional edge ends the run when `len(state["messages"]) > 6` — i.e. after
 * ~3 round trips, counted by message-array length. Here the loop bound is a
 * TYPED guard on an explicit `checking` choice state (`revisions >=
 * maxRevisions`), not an implicit count of an accumulating list. Same shape,
 * but the stop condition is a named number you can point at, and the transcript
 * length is a consequence rather than the control signal.
 *   source: https://langchain-ai.github.io/langgraph/tutorials/reflection/reflection/
 *
 * Contrast with the sibling `ai-sdk-evaluator-optimizer` example: that loop is
 * SCORE-threshold-driven (a numeric qualityScore ≥ 8 gate). This one mirrors
 * the reflection tutorial instead — a critique persona produces PROSE feedback
 * that is fed back into the next draft as role-flipped user messages, and the
 * generator sees the whole accumulating transcript (task + every draft + every
 * critique), exactly like the tutorial re-invokes its single generate node over
 * the growing message list.
 *
 * The critique request returns structured `{ critique, satisfied }`, so the
 * loop can ALSO exit early the moment the critic is satisfied — an improvement
 * over the tutorial's fixed message-count loop, while `maxRevisions` stays the
 * hard upper bound. The critic grades against a strict five-item rubric, so a
 * live run reliably takes at least one revision round instead of signing off
 * on the first draft and hiding the loop. Every model invoke has an `onError`
 * that degrades to the best-effort current draft rather than erroring the run.
 *
 * Dual-mode: `runReflectionWriterExample(options?)` takes an injectable
 * `generateText` (the test passes mocks — keyless CI); the direct run below
 * uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/reflection-writer/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  type AgentMessage,
  assistantMessage,
  runAgent,
  setupAgent,
  userMessage,
  type AgentRequestExecutors,
} from "@statelyai/agent";

export const models = defineModels({
  // One generator model, re-invoked each round over the growing transcript —
  // the tutorial's single `generate` node.
  writer: openai("gpt-5.4-mini"),
  // The `reflect` node: a teacher persona grading the latest draft.
  critic: openai("gpt-5.4-mini"),
});

// The critic returns PROSE feedback plus a boolean verdict. The prose is what
// gets fed back to the writer (the tutorial's role-flipped reflection message);
// `satisfied` is the early-exit signal the fixed-count tutorial lacks.
const critiqueSchema = z.object({
  critique: z.string(),
  satisfied: z.boolean(),
});

/** Hard upper bound on revision rounds (the tutorial's loop bound). */
const MAX_REVISIONS = 3;

const agentSetup = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    // The latest draft. Also the best-effort output if a model call fails.
    essay: z.string(),
    // Accumulating transcript: task + every draft (assistant) + every critique
    // (role-flipped to user, as the tutorial does so the writer treats the
    // reflection as feedback to act on).
    messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
    // The critic's latest structured verdict (drives the early-exit guard).
    critique: critiqueSchema.nullable(),
    // Completed revision rounds — the typed loop bound, replacing LangGraph's
    // `len(messages) > 6` check.
    revisions: z.number(),
    maxRevisions: z.number(),
  }),
  input: z.object({
    topic: z.string(),
  }),
  output: z.object({
    essay: z.string(),
    revisions: z.number(),
    // Whether the critic signed off (vs. stopped at the revision bound).
    satisfied: z.boolean(),
    // Transcript length — a consequence here, the control signal in LangGraph.
    messageCount: z.number(),
  }),
  emitted: {
    DRAFTED: z.object({ revision: z.number(), length: z.number() }),
    CRITIQUED: z.object({ revision: z.number(), satisfied: z.boolean() }),
  },
  // `critiquing` runs only once a draft exists; `done` always carries an essay.
  states: {
    critiquing: { context: { essay: z.string() } },
    done: { context: { essay: z.string() } },
  },
  requests: {
    // The `generate` node: write (or revise) the essay from the whole
    // transcript. On a revision the transcript already holds the prior draft
    // and the critic's feedback, so this single request covers both the first
    // draft and every rewrite — exactly one generate node, re-invoked.
    writeEssay: {
      schemas: {
        input: z.object({ messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)) }),
        output: z.string(),
      },
      model: "writer",
      system:
        "You are an essay-writing assistant. Write the best essay you can for " +
        "the user's request. If the transcript contains a critique of a prior " +
        "draft, produce a revised essay that addresses every point while " +
        "keeping what already works. Return only the essay prose.",
      messages: ({ input }) => input.messages,
    },
    // The `reflect` node: a teacher grades the latest draft and returns prose
    // recommendations plus a satisfied verdict.
    critiqueEssay: {
      schemas: {
        input: z.object({ topic: z.string(), essay: z.string() }),
        output: critiqueSchema,
      },
      model: "critic",
      // The rubric is deliberately strict: with a lenient critic a live first
      // draft often scores well enough to skip the loop entirely, so the
      // generate <-> reflect cycle the example exists to show never runs.
      // Every rubric item must hold before `satisfied` is true, and a first
      // draft essentially never clears all five.
      system:
        "You are a demanding writing teacher grading an essay against a strict " +
        "rubric: (1) a specific, arguable thesis, (2) concrete evidence or " +
        "examples for every claim, (3) a fairly stated counterargument that is " +
        "answered, (4) tight structure with no filler, (5) prose free of " +
        "cliché and vague abstraction. Give detailed, specific recommendations " +
        "for each rubric item that falls short. Set `satisfied` to true ONLY " +
        "when every rubric item is fully met and no substantive revision is " +
        "left; a first draft almost never clears this bar, so expect to return " +
        "false with actionable critique at least once.",
      prompt: ({ input }) => `Essay topic: ${input.topic}\n\nEssay:\n${input.essay}`,
    },
  },
});

export const reflectionWriterSchemas = agentSetup.schemas;

export const reflectionWriterMachine = agentSetup.createMachine({
  id: "reflection-writer",
  context: ({ input }) => ({
    topic: input.topic,
    essay: "",
    messages: [userMessage(`Write an essay on the following topic:\n${input.topic}`)],
    critique: null,
    revisions: 0,
    maxRevisions: MAX_REVISIONS,
  }),
  initial: "drafting",
  states: {
    // generate node: draft or revise from the accumulating transcript.
    drafting: {
      invoke: {
        id: "writeEssay",
        src: "writeEssay",
        input: ({ context }) => ({ messages: context.messages }),
        onDone: ({ context, output }, enq) => {
          enq.emit({ type: "DRAFTED", revision: context.revisions, length: output.length });
          return {
            target: "critiquing",
            context: {
              essay: output,
              // Record the draft in the transcript (assistant turn).
              messages: [...context.messages, assistantMessage(output)],
            },
          };
        },
        // A failed draft degrades to done with whatever draft we have (empty on
        // the first round) — best-effort, no throw.
        onError: { target: "done" },
      },
    },
    // reflect node: grade the current draft.
    critiquing: {
      invoke: {
        id: "critiqueEssay",
        src: "critiqueEssay",
        input: ({ context }) => ({ topic: context.topic, essay: context.essay }),
        onDone: ({ context, output }, enq) => {
          enq.emit({
            type: "CRITIQUED",
            revision: context.revisions + 1,
            satisfied: output.satisfied,
          });
          return {
            target: "checking",
            context: {
              critique: output,
              revisions: context.revisions + 1,
              // Feed the critique back as a role-flipped USER message, as the
              // tutorial does, so the next draft treats it as feedback to act on.
              messages: [...context.messages, userMessage(`Critique:\n${output.critique}`)],
            },
          };
        },
        // Can't critique → stop with the current draft (best-effort output).
        onError: { target: "done" },
      },
    },
    // The typed loop bound. LangGraph's `should_continue` counts messages
    // (`len > 6`); here the same decision is a named guard: stop when the critic
    // is satisfied OR the revision budget is spent, else loop back to drafting.
    checking: {
      type: "choice",
      choice: ({ context }) =>
        context.critique?.satisfied || context.revisions >= context.maxRevisions
          ? { target: "done" }
          : { target: "drafting" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        essay: context.essay,
        revisions: context.revisions,
        satisfied: context.critique?.satisfied ?? false,
        messageCount: context.messages.length,
      }),
    },
  },
});

export interface RunReflectionWriterOptions {
  topic?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition (the visible reflect loop). */
  onProgress?: (state: string) => void;
}

export interface ReflectionWriterResult {
  essay: string;
  revisions: number;
  satisfied: boolean;
  messageCount: number;
  progress: string[];
}

/** Runs the reflection loop; records state progress so the loop is observable. */
export async function runReflectionWriterExample(
  options: RunReflectionWriterOptions = {},
): Promise<ReflectionWriterResult> {
  const {
    topic = "Why the little prince is relevant to modern childhood",
    generateText,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runAgent(reflectionWriterMachine, {
    input: { topic },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    onTransition: (snapshot) => {
      const state = String(snapshot.value);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Reflection-writer example did not complete: ${result.status}`);
  }
  return { ...result.output, progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { generateText } = createAiSdkExecutors({ models });

    const topic = "Why the little prince is relevant to modern childhood";
    const result = await runReflectionWriterExample({
      topic,
      generateText,
      onProgress: (state) => console.log(`  → ${state}`),
    });

    console.log("Topic:", topic);
    console.log("Revisions:", result.revisions);
    console.log("Satisfied:", result.satisfied);
    console.log("Essay:\n", result.essay);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
