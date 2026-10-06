/**
 * Self-Discover — the model composes its own reasoning structure for a task,
 * then follows it. Four stages in a fixed order, plus one bound the LangGraph
 * version leaves to trust.
 *
 * The idea (Zhou et al. 2024, "Self-Discover: Large Language Models
 * Self-Compose Reasoning Structures"): instead of one fixed prompting style
 * (chain of thought, step by step), the model first SELECTS the generic
 * reasoning modules that suit the task, ADAPTS them to the task's specifics,
 * turns them into a step-by-step reasoning STRUCTURE (a plan with blanks),
 * and finally REASONS by filling that plan in to reach an answer.
 *
 * LangGraph shape (tutorials/self-discover/self-discover) — a straight line:
 *
 *   START → select → adapt → structure → reason → END
 *
 * Machine shape:
 *
 *   selecting → selectionValid? ─┬─ adapting → structuring → reasoning → done
 *                                └─ failed (no module clears MODULE_THRESHOLD)
 *
 * What maps to what:
 *   - select    → `selecting` (ONE Jev call, one boolean question per module in the
 *                 exported `REASONING_MODULES` — see note), then
 *                 `selectionValid` (a choice state: top-k above the threshold,
 *                 or `failed`)
 *   - adapt     → `adapting`
 *   - structure → `structuring`
 *   - reason    → `reasoning` (returns the worked reasoning, THEN the answer)
 *
 * Differences from LangGraph worth calling out:
 *   - Selection is a JUDGMENT, not a generation. The tutorial asks a chat
 *     model to copy the chosen modules' text back. Here `selecting` asks the
 *     AI SDK's `experimental_evaluate` with Jev (`@ai-sdk/typesafe-ai`) as the
 *     evaluation model, with the task and every module as state and one
 *     boolean question per module that quotes it ("would the reasoning module
 *     '<module>' help solve `task`?"). The machine keeps the modules whose
 *     probability clears `MODULE_THRESHOLD`, most probable first, capped at
 *     `MAX_SELECTED_MODULES`. No module text
 *     is retyped, so a selection can only name modules that exist. The text
 *     model is reserved for adapt, structure, and reason.
 *   - The selection is checked. The tutorial trusts the select step and passes
 *     whatever it returns straight to adapt, so an empty selection flows
 *     through unnoticed. Here the requirement is stated: the `selectionValid`
 *     choice state needs between 1 and `MAX_SELECTED_MODULES` modules, and
 *     when no module clears `MODULE_THRESHOLD` the run lands in `failed` with
 *     a notice naming the threshold. There is no retry: asking Jev the same
 *     question over the same state would return the same answer.
 *   - Reasoning comes before the answer. The reason step's structured output
 *     lists `reasoning` first and `answer` second, and the model fills fields
 *     in order, so the answer is written after (and from) the worked steps
 *     rather than guessed first and justified after. The reasoning is prose,
 *     one line per plan step, so the result reads as an explanation.
 *   - The plan is a list of steps, not a JSON object. The paper's structure
 *     is JSON with empty values; here the model returns one string per step
 *     and the machine numbers them, so the plan reads as text wherever it is
 *     shown. The worked reasoning is a list too, one entry per step, and every
 *     entry is flattened to one plain line (`plainStep`) so no step can turn
 *     into a markdown heading, quote, or rule when rendered.
 *   - Every invoke has an `onError` that lands in `failed` with whatever stages
 *     completed.
 *   - `REASONING_MODULES` is 16 of the paper's 39 modules, shortened, to keep
 *     prompts small. Add the rest and the machine is unchanged.
 *
 * Dual-mode: `runSelfDiscoverExample(options?)` takes an injectable
 * `generateText` and `judge` (tests pass scripted mocks, so CI needs no
 * API key); the direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/self-discover/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  reasoner: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** The most modules a selection may contain. */
export const MAX_SELECTED_MODULES = 5;
/** A module is selected when Jev's probability that it helps clears this. */
export const MODULE_THRESHOLD = 0.5;

/** 16 of the paper's 39 generic reasoning modules, shortened. */
export const REASONING_MODULES: readonly string[] = [
  "How could I devise an experiment to help solve the problem?",
  "Make a list of ideas for solving the problem, and apply them one by one to see if any makes progress.",
  "How can I simplify the problem so that it is easier to solve?",
  "What are the key assumptions underlying the problem?",
  "How can I break the problem down into smaller, more manageable parts?",
  "Critical thinking: analyze the problem from different perspectives, question assumptions, and weigh the evidence.",
  "Creative thinking: generate unconventional ideas for solving the problem.",
  "Systems thinking: treat the problem as part of a larger system of interconnected elements.",
  "Reflective thinking: step back, examine biases and assumptions, and learn from past experience.",
  "What is the core issue that needs to be addressed?",
  "What are the underlying causes or factors contributing to the problem?",
  "What kinds of solution are typically produced for this kind of problem?",
  "Is this an analytical problem that needs data analysis, modeling, or optimization?",
  "Is this a design challenge that needs a creative solution?",
  "Let's think step by step.",
  "Let's make a step-by-step plan and carry it out with clear notation and explanation.",
];

/**
 * select as a judgment: the task and every reasoning module are the state, and
 * each module gets its own boolean question. One call, one probability per
 * module, no prose. The judge model is injected by tests and hosts; the
 * default is Jev.
 */
export function createSelectModules(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<{ answers: Record<string, { probability: number }> }, { task: string }>({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { task: input.task, modules: [...REASONING_MODULES] },
        questions: Object.fromEntries(
          REASONING_MODULES.map((module, index) => [
            `module${index}`,
            {
              type: "boolean" as const,
              // Quote the module itself: a bare `modules[i]` index is easy to
              // misalign across sixteen rows.
              instructions: `Would the reasoning module "${module}" help solve \`task\`?`,
              criteria: {
                true: "Applying this module moves this particular task toward its answer.",
                false:
                  "The module does not fit this kind of task, or adds nothing beyond restating it.",
              },
            },
          ]),
        ),
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/**
 * The modules that clear `MODULE_THRESHOLD`, most probable first, capped at
 * `MAX_SELECTED_MODULES` — the top-k of the per-module answers.
 */
function pickModules(answers: Record<string, { probability: number } | undefined>): string[] {
  return REASONING_MODULES.map((module, index) => ({
    module,
    probability: answers[`module${index}`]?.probability ?? 0,
  }))
    .filter((scored) => scored.probability >= MODULE_THRESHOLD)
    .sort((left, right) => right.probability - left.probability)
    .slice(0, MAX_SELECTED_MODULES)
    .map((scored) => scored.module);
}

/**
 * One step as one plain line: whitespace flattened, and any leading numbering
 * or markdown block marker (`#`, `>`, bullets, `Step 6:`) dropped — the
 * machine numbers steps itself, and a stray `#` would render as a heading.
 */
export function plainStep(text: string): string {
  return (
    text
      .replace(/\s+/g, " ")
      .trim()
      // "# of vertices" means "number of", not a heading.
      .replace(/^#\s*of\b/i, "Number of")
      .replace(/^(?:(?:#+|>+|[-*+](?=\s)|\d+[.)]|step\s*\d+\s*[:.)-]?)\s*)+/i, "")
      .replace(/^[-=_*\s]+$/, "")
  );
}

/** Numbered plain lines, one per step; empty steps are dropped. */
function numberedSteps(steps: readonly string[]): string {
  return steps
    .map(plainStep)
    .filter((step) => step.length > 0)
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
}

const selfDiscoverContextSchema = z.object({
  task: z.string(),
  // The modules that cleared the threshold (empty when none did).
  selectedModules: z.array(z.string()),
  adaptedModules: z.string().nullable(),
  reasoningStructure: z.string().nullable(),
  answer: z.string().nullable(),
  // The worked steps, as prose, written before the answer.
  reasoning: z.string().nullable(),
  // Why the run stopped short; set only on the way into `failed`.
  failure: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: selfDiscoverContextSchema,
  input: z.object({
    task: z.string(),
  }),
  output: z.object({
    answer: z.string(),
    reasoningStructure: z.string(),
    selectedModules: z.array(z.string()),
    adaptedModules: z.string(),
  }),
  // `done` is only reachable through every stage in order, so each stage's
  // result is set there.
  states: {
    done: {
      schemas: {
        context: selfDiscoverContextSchema.extend({
          adaptedModules: z.string(),
          reasoningStructure: z.string(),
          answer: z.string(),
          reasoning: z.string(),
        }),
      },
    },
  },
  actors: {
    // select: a Jev judgment per reasoning module (see createSelectModules).
    selectModules: createSelectModules(),
  },
  requests: {
    // adapt: rephrase the selected modules for this task.
    adaptModules: {
      schemas: {
        input: z.object({ task: z.string(), modules: z.array(z.string()) }),
        output: z.object({ adapted: z.string() }),
      },
      model: "reasoner",
      system:
        "Rephrase and specify each selected reasoning module so it better helps solve " +
        "the task. Do not solve the task.",
      prompt: ({ input }) =>
        [
          `Task: ${input.task}`,
          "",
          "Selected modules:",
          ...input.modules.map((m) => `- ${m}`),
        ].join("\n"),
    },
    // structure: turn the adapted modules into a fill-in reasoning plan, one
    // string per step (the machine numbers them).
    structurePlan: {
      schemas: {
        input: z.object({ task: z.string(), adapted: z.string() }),
        output: z.object({
          steps: z
            .array(z.string())
            .describe("One entry per plan step: what to work out. Plain text, no numbering."),
        }),
      },
      model: "reasoner",
      system:
        "Operationalize the adapted reasoning modules into a step-by-step reasoning plan: " +
        "one short instruction per step, each naming what to work out, with the result " +
        "left to be filled in later. Plain sentences, no numbering, JSON, or markdown. " +
        "Do not solve the task.",
      prompt: ({ input }) =>
        [`Task: ${input.task}`, "", "Adapted modules:", input.adapted].join("\n"),
    },
    // reason: follow the plan step by step, THEN answer. Field order matters:
    // the model writes `reasoning` before `answer`, so the answer is the
    // conclusion of the worked steps, not a guess the steps then contradict.
    solveTask: {
      schemas: {
        input: z.object({ task: z.string(), structure: z.string() }),
        output: z.object({
          reasoning: z
            .array(z.string())
            .describe("One entry per plan step, in order: a short plain sentence. No numbering."),
          answer: z.string().describe("The conclusion the reasoning reached, stated exactly."),
        }),
      },
      model: "reasoner",
      system:
        "Follow the reasoning structure step by step to solve the task. First write " +
        "`reasoning`: work through each step of the structure in order, one short plain " +
        "sentence per step (no numbering or markdown), checking every constraint in the " +
        "task. Then write `answer`: exactly the conclusion your reasoning reached, as a " +
        "full phrase. If the task lists options, give the chosen option's letter AND " +
        "its text. Never give an answer your reasoning did not arrive at.",
      prompt: ({ input }) =>
        [`Task: ${input.task}`, "", "Reasoning structure:", input.structure].join("\n"),
    },
  },
});

export const selfDiscoverSchemas = agentSetup.schemas;

export const selfDiscoverMachine = agentSetup.createMachine({
  id: "self-discover",
  context: ({ input }) => ({
    task: input.task,
    selectedModules: [],
    adaptedModules: null,
    reasoningStructure: null,
    answer: null,
    reasoning: null,
    failure: null,
  }),
  initial: "selecting",
  states: {
    selecting: {
      invoke: {
        src: "selectModules",
        input: ({ context }) => ({ task: context.task }),
        onDone: ({ output }) => ({
          target: "selectionValid",
          context: { selectedModules: pickModules(output.answers) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `selectModules failed: ${String(event.error)}` },
        }),
      },
    },
    // The bound the tutorial lacks: 1..MAX_SELECTED_MODULES modules. The top-k
    // pick already caps the count; no module above the threshold ends the run.
    selectionValid: {
      type: "choice",
      choice: ({ context }) =>
        context.selectedModules.length >= 1 &&
        context.selectedModules.length <= MAX_SELECTED_MODULES
          ? { target: "adapting" }
          : {
              target: "failed",
              context: {
                failure:
                  `no reasoning module cleared MODULE_THRESHOLD (${MODULE_THRESHOLD}); ` +
                  `a plan needs 1 to ${MAX_SELECTED_MODULES} modules`,
              },
            },
    },
    adapting: {
      invoke: {
        src: "adaptModules",
        input: ({ context }) => ({ task: context.task, modules: context.selectedModules }),
        onDone: ({ output }) => ({
          target: "structuring",
          context: { adaptedModules: output.result.adapted },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `adaptModules failed: ${String(event.error)}` },
        }),
      },
    },
    structuring: {
      invoke: {
        src: "structurePlan",
        input: ({ context }) => ({ task: context.task, adapted: context.adaptedModules ?? "" }),
        onDone: ({ output }) => ({
          target: "reasoning",
          context: { reasoningStructure: numberedSteps(output.result.steps) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `structurePlan failed: ${String(event.error)}` },
        }),
      },
    },
    reasoning: {
      invoke: {
        src: "solveTask",
        input: ({ context }) => ({
          task: context.task,
          structure: context.reasoningStructure ?? "",
        }),
        onDone: ({ context, output }) =>
          context.adaptedModules !== null && context.reasoningStructure !== null
            ? {
                target: "done",
                context: {
                  adaptedModules: context.adaptedModules,
                  reasoningStructure: context.reasoningStructure,
                  answer: output.result.answer,
                  reasoning: numberedSteps(output.result.reasoning),
                },
              }
            : { target: "failed", context: { failure: "a stage finished without a result" } },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `solveTask failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        // The answer leads; the worked steps follow so the reader sees how the
        // model got there.
        answer: `${context.answer}\n\nReasoning:\n${context.reasoning}`,
        reasoningStructure: context.reasoningStructure,
        selectedModules: context.selectedModules,
        adaptedModules: context.adaptedModules,
      }),
    },
    // Best-effort terminal: whatever stages completed, and why the run stopped.
    failed: {
      type: "final",
      output: ({ context }) => ({
        answer: `No answer. Stopped: ${context.failure ?? "unknown failure"}.`,
        reasoningStructure: context.reasoningStructure ?? "",
        selectedModules: context.selectedModules,
        adaptedModules: context.adaptedModules ?? "",
      }),
    },
  },
});

export interface RunSelfDiscoverOptions {
  task?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export interface SelfDiscoverResult {
  answer: string;
  reasoningStructure: string;
  selectedModules: string[];
  adaptedModules: string;
  /** `done`, or `failed` when no module cleared the threshold or a call failed. */
  finalState: string;
  progress: string[];
}

/** Runs the four Self-Discover stages; records state progress. */
export async function runSelfDiscoverExample(
  options: RunSelfDiscoverOptions = {},
): Promise<SelfDiscoverResult> {
  const {
    task = "Alice, Bob, and Carol each own one pet: a cat, a dog, or a fish. Alice is allergic to fur. Bob's pet cannot live in water. Carol does not own the dog. Who owns which pet?",
    generateText,
    judge,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(selfDiscoverMachine, {
      ...(generateText
        ? { executors: { generateText } }
        : { executors: createAiSdkExecutors({ models }) }),
      ...(judge ? { actors: { selectModules: createSelectModules(judge) } } : {}),
      onTransition: (snapshot) => {
        const state = getStatePath(snapshot);
        progress.push(state);
        onProgress?.(state);
      },
    }),
    {
      input: { task },
    },
  );

  if (result.status !== "done") {
    throw new Error(`Self-Discover example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { generateText } = createAiSdkExecutors({ models });
    const result = await runSelfDiscoverExample({
      generateText,
      onProgress: (state) => console.log(`  → ${state}`),
    });

    console.log("\nSelected modules:\n-", result.selectedModules.join("\n- "));
    console.log("\nReasoning structure:\n", result.reasoningStructure);
    console.log(`\nAnswer (${result.finalState}):\n`, result.answer);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
