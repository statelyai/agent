/**
 * Self-Discover — the model composes its own reasoning structure for a task,
 * then follows it. Four model stages in a fixed order, plus one bound the
 * LangGraph version leaves to trust.
 *
 * The idea (Zhou et al. 2024, "Self-Discover: Large Language Models
 * Self-Compose Reasoning Structures"): instead of one fixed prompting style
 * (chain of thought, step by step), the model first SELECTS the generic
 * reasoning modules that suit the task, ADAPTS them to the task's specifics,
 * turns them into a step-by-step reasoning STRUCTURE (a JSON plan with blanks),
 * and finally REASONS by filling that plan in to reach an answer.
 *
 * LangGraph shape (tutorials/self-discover/self-discover) — a straight line:
 *
 *   START → select → adapt → structure → reason → END
 *
 * Machine shape:
 *
 *   selecting → selectionValid? ─┬─ adapting → structuring → reasoning → done
 *       ▲                        └─ selectionRejected? ─┬─ selecting (retry once)
 *       └───────────────────────────────────────────────┘└─ failed
 *
 * What maps to what:
 *   - select    → `selecting` (structured request: `{ modules: string[] }`,
 *                 chosen from the exported `REASONING_MODULES`)
 *   - adapt     → `adapting`
 *   - structure → `structuring`
 *   - reason    → `reasoning` (returns the answer and the filled-in trace)
 *
 * Differences from LangGraph worth calling out:
 *   - The selection is checked. The tutorial passes whatever the select step
 *     returns straight to adapt, so an empty selection, or all thirty-nine
 *     modules, flows through unnoticed. Here the `selectionValid` choice state
 *     requires between 1 and `MAX_SELECTED_MODULES` modules. A selection
 *     outside that range goes to `selectionRejected`, which retries `selecting`
 *     with the problem stated in the prompt, at most `MAX_SELECTION_RETRIES`
 *     time(s), and then lands in `failed`.
 *   - The range is checked by the machine, not by the output schema. A zod
 *     `.min(1).max(5)` would turn a bad selection into a request error; the
 *     choice state turns it into a retry with feedback, visible as a state.
 *   - Every invoke has an `onError` that lands in `failed` with whatever stages
 *     completed.
 *   - `REASONING_MODULES` is 16 of the paper's 39 modules, shortened, to keep
 *     prompts small. Add the rest and the machine is unchanged.
 *
 * Dual-mode: `runSelfDiscoverExample(options?)` takes an injectable
 * `generateText` (tests pass a scripted mock, so CI needs no API key); the
 * direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/self-discover/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = {
  reasoner: openai("gpt-5.4-mini"),
};

/** The most modules a selection may contain. */
export const MAX_SELECTED_MODULES = 5;
/** Times `selecting` may be retried after an out-of-range selection. */
export const MAX_SELECTION_RETRIES = 1;

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

const selfDiscoverContextSchema = z.object({
  task: z.string(),
  // The latest selection, valid or not: the rejection prompt reads its size.
  selectedModules: z.array(z.string()),
  selectionRetries: z.number(),
  adaptedModules: z.string().nullable(),
  reasoningStructure: z.string().nullable(),
  answer: z.string().nullable(),
  reasoningTrace: z.string().nullable(),
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
          reasoningTrace: z.string(),
        }),
      },
    },
  },
  requests: {
    // select: pick the modules that suit this task.
    selectModules: {
      schemas: {
        input: z.object({
          task: z.string(),
          rejectedCount: z.number().nullable(),
        }),
        output: z.object({ modules: z.array(z.string()) }),
      },
      model: "reasoner",
      system:
        "Select the reasoning modules that are crucial for solving the task. Copy each " +
        `selected module's text exactly. Select at least 1 and at most ${MAX_SELECTED_MODULES}.`,
      prompt: ({ input }) =>
        [
          `Task: ${input.task}`,
          "",
          "Reasoning modules:",
          ...REASONING_MODULES.map((module, i) => `${i + 1}. ${module}`),
          input.rejectedCount === null
            ? ""
            : `\nYour previous selection had ${input.rejectedCount} module(s), which is outside ` +
              `the allowed range. Select between 1 and ${MAX_SELECTED_MODULES}.`,
        ].join("\n"),
    },
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
    // structure: turn the adapted modules into a fill-in reasoning plan.
    structurePlan: {
      schemas: {
        input: z.object({ task: z.string(), adapted: z.string() }),
        output: z.object({ structure: z.string() }),
      },
      model: "reasoner",
      system:
        "Operationalize the adapted reasoning modules into a step-by-step reasoning plan " +
        "in JSON: keys describe each step, values are left empty to be filled in later. " +
        "Do not solve the task.",
      prompt: ({ input }) =>
        [`Task: ${input.task}`, "", "Adapted modules:", input.adapted].join("\n"),
    },
    // reason: follow the plan, filling in each value, and answer.
    solveTask: {
      schemas: {
        input: z.object({ task: z.string(), structure: z.string() }),
        output: z.object({ answer: z.string(), reasoningTrace: z.string() }),
      },
      model: "reasoner",
      system:
        "Follow the reasoning structure step by step, filling in each value, to solve " +
        "the task. Return the filled-in structure as reasoningTrace and the final answer.",
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
    selectionRetries: 0,
    adaptedModules: null,
    reasoningStructure: null,
    answer: null,
    reasoningTrace: null,
    failure: null,
  }),
  initial: "selecting",
  states: {
    selecting: {
      invoke: {
        src: "selectModules",
        input: ({ context }) => ({
          task: context.task,
          // On a retry, tell the model how far off the last selection was.
          rejectedCount: context.selectionRetries > 0 ? context.selectedModules.length : null,
        }),
        onDone: ({ output }) => ({
          target: "selectionValid",
          context: { selectedModules: output.result.modules },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `selectModules failed: ${String(event.error)}` },
        }),
      },
    },
    // The bound the tutorial lacks: 1..MAX_SELECTED_MODULES modules.
    selectionValid: {
      type: "choice",
      choice: ({ context }) =>
        context.selectedModules.length >= 1 &&
        context.selectedModules.length <= MAX_SELECTED_MODULES
          ? { target: "adapting" }
          : { target: "selectionRejected" },
    },
    selectionRejected: {
      type: "choice",
      choice: ({ context }) =>
        context.selectionRetries >= MAX_SELECTION_RETRIES
          ? {
              target: "failed",
              context: {
                failure:
                  `selection still had ${context.selectedModules.length} module(s) after ` +
                  `${MAX_SELECTION_RETRIES} retry (allowed: 1 to ${MAX_SELECTED_MODULES})`,
              },
            }
          : { target: "selecting", context: { selectionRetries: context.selectionRetries + 1 } },
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
          context: { reasoningStructure: output.result.structure },
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
                  reasoningTrace: output.result.reasoningTrace,
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
        // The answer leads; the filled-in plan follows so the reader sees how
        // the model got there.
        answer: `${context.answer}\n\nReasoning (the filled-in structure):\n${context.reasoningTrace}`,
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
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export interface SelfDiscoverResult {
  answer: string;
  reasoningStructure: string;
  selectedModules: string[];
  adaptedModules: string;
  /** `done`, or `failed` when the selection stayed out of range or a call failed. */
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
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runAgent(selfDiscoverMachine, {
    input: { task },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Self-Discover example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
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
