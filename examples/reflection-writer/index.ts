/**
 * Reflection (essay writer) — LangGraph's canonical Reflection tutorial as an
 * EXPLICIT machine: a generator drafts an essay, a critique persona grades it,
 * and the feedback loops back into a revision. drafting → critiquing →
 * (revise loop back to drafting) → done.
 *
 * LangGraph: two nodes (`generate` ↔ `reflect`) cycle, and a `should_continue`
 * conditional edge ends the run when `len(state["messages"]) > 6` — i.e. after
 * ~3 round trips, counted by message-array length. Here the loop bound is a
 * TYPED guard on an explicit `checking` choice state (`rewrites >=
 * maxRewrites`), not an implicit count of an accumulating list. Same shape,
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
 * over the tutorial's fixed message-count loop, while `maxRewrites` stays the
 * hard upper bound. The critic grades against a strict five-item rubric, so a
 * live run reliably takes at least one revision round instead of signing off
 * on the first draft and hiding the loop. Every model invoke has an `onError`
 * routing to a distinct `failed` final state, so a run that could not finish is
 * never mistaken for one that simply had nothing more to say.
 *
 * Readable output: the run presents the ORIGINAL draft and the FINAL draft side
 * by side, plus a one-line-per-critique log RENDERED from the critiques the
 * machine recorded — not accumulated as a string in context. The intermediate
 * drafts and the full critique prose stay out of the leading string fields, so
 * the result reads as a comparison rather than a wall of essay text.
 *
 * Dual-mode: `runReflectionWriterExample(options?)` takes an injectable
 * `generateText` (the test passes mocks — CI with no API key); the direct run below
 * uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/reflection-writer/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  type AgentMessage,
  assistantMessage,
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  userMessage,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  // One generator model, re-invoked each round over the growing transcript —
  // the tutorial's single `generate` node.
  writer: openai("gpt-5.4-mini"),
  // The `reflect` node: a teacher persona grading the latest draft.
  critic: openai("gpt-5.4-mini"),
};

// The critic returns PROSE feedback plus a boolean verdict. The prose is what
// gets fed back to the writer (the tutorial's role-flipped reflection message);
// `satisfied` is the early-exit signal the fixed-count tutorial lacks.
const critiqueSchema = z.object({
  critique: z.string(),
  satisfied: z.boolean(),
});

/** Hard upper bound on rewrites after the first draft (the tutorial's loop bound). */
const MAX_REWRITES = 2;

/** Collapses critique prose to a single short line for the critique log. */
function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const reflectionContextSchema = z.object({
  topic: z.string(),
  // The latest draft. Also the best-effort output if a model call fails.
  essay: z.string(),
  // The very first draft, kept so the result can show original vs. final.
  firstDraft: z.string(),
  // Accumulating transcript: task + every draft (assistant) + every critique
  // (role-flipped to user, as the tutorial does so the writer treats the
  // reflection as feedback to act on). `messagesSchema` is the shipped
  // validator, but nesting it in a zod object erases the element type, so the
  // context schema keeps a typed `z.custom`.
  messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
  // Every completed critique, in order. The latest one drives the early-exit
  // guard; the critique log is RENDERED from this list in `output`, so there
  // is no second copy of it to keep in sync.
  critiques: z.array(critiqueSchema),
  // Why the run stopped early, when it did. `null` on the happy path.
  failure: z.string().nullable(),
  maxRewrites: z.number(),
});

type ReflectionContext = z.infer<typeof reflectionContextSchema>;

/** Rewrites so far: every draft after the first. Derived from the transcript. */
function rewriteCount(context: ReflectionContext): number {
  const drafts = context.messages.filter((message) => message.role === "assistant").length;
  return Math.max(0, drafts - 1);
}

/** Names the draft a critique graded: the original, or rewrite N. */
function draftLabel(rewrite: number): string {
  return rewrite === 0 ? "Original" : `Rewrite ${rewrite}`;
}

/**
 * One line per critique, labeled with the draft it graded — derived from the
 * recorded critiques. Critique N grades rewrite N-1, so a run that spends its
 * whole budget has one more critique than rewrites (the last grades the final).
 */
function renderCritiqueLog(critiques: ReflectionContext["critiques"]): string {
  return critiques
    .map(
      (critique, index) =>
        `${draftLabel(index)}: ${critique.satisfied ? "satisfied" : "revise"}. ${oneLine(critique.critique)}`,
    )
    .join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Why the loop ended, in the reader's words. A run that stops with
 * `satisfied: false` did not fail — it spent its rewrite budget — and saying
 * so is the difference between "the critic approved this" and "this is the
 * best it managed in two rewrites".
 */
function renderStopReason(context: ReflectionContext): string {
  if (context.failure) return `Stopped early: ${context.failure}`;
  const last = context.critiques[context.critiques.length - 1];
  const rewrites = rewriteCount(context);
  if (last?.satisfied) {
    return rewrites === 0
      ? "The critic signed off on the original draft."
      : `The critic signed off on rewrite ${rewrites}.`;
  }
  return `Best effort: the critic was still not satisfied after ${plural(rewrites, "rewrite")}, which is the budget.`;
}

/** The comparison view: original draft, final draft, and the critique log. */
function renderComparison(context: ReflectionContext): string {
  const rewrites = rewriteCount(context);
  const sections = [
    renderStopReason(context),
    "",
    "Original draft",
    context.firstDraft || "(none)",
  ];
  // With no rewrite the final draft IS the original; printing it twice is noise.
  if (rewrites > 0) {
    sections.push("", `Final draft (rewrite ${rewrites})`, context.essay);
  }
  sections.push(
    "",
    `Critiques (${context.critiques.length})`,
    renderCritiqueLog(context.critiques) || "(no critique completed)",
  );
  return sections.join("\n");
}

const agentSetup = setupAgent({
  models,
  context: reflectionContextSchema,
  input: z.object({
    topic: z.string(),
  }),
  // One string a reader needs (original next to final, with the critique
  // log); the drafts live only inside it, so nothing repeats beside it.
  output: z.object({
    comparison: z.string(),
    // Rewrites after the first draft (not critiques: the last critique grades
    // the final rewrite, so a full-budget run has one more critique).
    rewrites: z.number(),
    // Whether the critic signed off (vs. stopped at the rewrite budget).
    satisfied: z.boolean(),
    // Set only when a model call failed and the run ended in `failed`.
    failure: z.string().nullable(),
  }),
  // `rewrite` names the draft: 0 is the original, N is rewrite N — the same
  // number the output's `rewrites` counts and the critique log labels.
  emitted: {
    DRAFTED: z.object({ rewrite: z.number(), length: z.number() }),
    CRITIQUED: z.object({ rewrite: z.number(), satisfied: z.boolean() }),
  },
  // `critiquing` runs only once a draft exists; `done` always carries an essay.
  states: {
    critiquing: {
      schemas: { context: reflectionContextSchema.extend({ essay: z.string() }) },
    },
    done: { schemas: { context: reflectionContextSchema.extend({ essay: z.string() }) } },
  },
  requests: {
    // The `generate` node: write (or revise) the essay from the whole
    // transcript. On a revision the transcript already holds the prior draft
    // and the critic's feedback, so this single request covers both the first
    // draft and every rewrite — exactly one generate node, re-invoked.
    writeEssay: {
      schemas: {
        input: z.object({ messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)) }),
        output: z.string(),
      },
      model: "writer",
      system:
        "You are an essay-writing assistant. Write the best essay you can for " +
        "the user's request, in at most 150 words. If the transcript ends with a " +
        "critique, rewrite your LATEST draft so it addresses every point of that " +
        "critique while keeping what already works. Return only the essay prose.",
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
        "for each rubric item that falls short, in at most 60 words total. Set " +
        "`satisfied` to true ONLY " +
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
    firstDraft: "",
    messages: [userMessage(`Write an essay on the following topic:\n${input.topic}`)],
    critiques: [],
    failure: null,
    maxRewrites: MAX_REWRITES,
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
          enq.emit({
            type: "DRAFTED",
            rewrite: context.critiques.length,
            length: output.result.length,
          });
          return {
            target: "critiquing",
            context: {
              essay: output.result,
              // The original draft is kept once, so the result can show it next
              // to the final one.
              firstDraft: context.critiques.length === 0 ? output.result : context.firstDraft,
              // Record the draft in the transcript (assistant turn).
              messages: [...context.messages, assistantMessage(output.result)],
            },
          };
        },
        // A draft that never arrived is a failed run, not a finished one.
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `writeEssay failed: ${String(event.error)}` },
        }),
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
            // The draft just graded: one critique per draft, so the count so far.
            rewrite: context.critiques.length,
            satisfied: output.result.satisfied,
          });
          return {
            target: "checking",
            context: {
              critiques: [...context.critiques, output.result],
              // Feed the critique back as a role-flipped USER message, as the
              // tutorial does, so the next draft treats it as feedback to act on.
              messages: [...context.messages, userMessage(`Critique:\n${output.result.critique}`)],
            },
          };
        },
        // A critique that never arrived stops the loop with a draft in hand:
        // `failed` still reports that draft, and says why it stopped.
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `critiqueEssay failed: ${String(event.error)}` },
        }),
      },
    },
    // The typed loop bound. LangGraph's `should_continue` counts messages
    // (`len > 6`); here the same decision is a named guard: stop when the critic
    // is satisfied OR the rewrite budget is spent, else loop back to drafting.
    checking: {
      type: "choice",
      choice: ({ context }) =>
        context.critiques.at(-1)?.satisfied || rewriteCount(context) >= context.maxRewrites
          ? { target: "done" }
          : { target: "drafting" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        comparison: renderComparison(context),
        rewrites: rewriteCount(context),
        satisfied: context.critiques.at(-1)?.satisfied ?? false,
        failure: null,
      }),
    },
    // A separate terminal for "a model call failed": the caller can still read
    // whatever draft exists, and can tell this apart from a completed run.
    failed: {
      type: "final",
      output: ({ context }) => ({
        comparison: renderComparison(context),
        rewrites: rewriteCount(context),
        satisfied: false,
        failure: context.failure ?? "unknown failure",
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
  comparison: string;
  rewrites: number;
  satisfied: boolean;
  /** Set only when the run ended in `failed`. */
  failure: string | null;
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
  const result = await runToQuiescence(
    createAgentRuntime(reflectionWriterMachine, {
      ...(generateText
        ? { executors: { generateText } }
        : { executors: createAiSdkExecutors({ models }) }),
      onTransition: (snapshot) => {
        // `getStatePath` serializes nested and parallel state values properly;
        // `String(snapshot.value)` would print "[object Object]" for either.
        const state = getStatePath(snapshot);
        progress.push(state);
        onProgress?.(state);
      },
    }),
    {
      input: { topic },
    },
  );

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
    console.log("Satisfied:", result.satisfied);
    console.log(result.comparison);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
