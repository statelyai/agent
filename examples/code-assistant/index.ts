/**
 * Self-correcting code assistant — LangGraph's code-assistant tutorial as an
 * EXPLICIT machine: generate code → execute/check → on failure reflect on the
 * error and regenerate, bounded by a retry budget.
 *
 * LangGraph shape (docs/tutorials/code_assistant) — nodes + a conditional edge:
 *
 *   START → generate → check_code ─┬─ (checks pass)        → END
 *                                  └─ (checks fail) reflect → generate → …
 *
 * The tutorial parses a structured `{ prefix, imports, code }` solution, runs
 * the import block and the code block, and on any error feeds the traceback
 * back into the next generation, looping until the checks pass or an iteration
 * budget is spent. Here every node is a state and the "did the checks pass?"
 * branch is a real `choice` transition you can point at, not control flow
 * hidden inside a node's return value:
 *
 *   generating → executing → checking ─┬─ done      (checks passed)
 *                                      ├─ failed    (budget spent)
 *                                      └─ reflecting → generating → …
 *
 * What maps to what:
 *   - generate    → `generating`  (ONE structured-output request: the model
 *                    returns `{ code, explanation }`; the code must define a
 *                    single named function with NO imports)
 *   - check_code  → `executing`   (a typed PLAIN actor — host-owned, NOT a model
 *                    call: run the code in `node:vm` against an empty sandbox
 *                    with a timeout, then apply the unit checks)
 *   - decide      → `checking`    (a `choice` state; the conditional edge)
 *   - reflect     → `reflecting`  (a transient state: the exact failures are
 *                    already in context, so it just loops back to `generating`,
 *                    whose prompt feeds them into the next attempt)
 *
 * Differences from LangGraph worth calling out:
 *   - Sandboxed execution: LangGraph `exec`s the solution in-process. Here the
 *     code runs via `vm.runInNewContext` against an EMPTY sandbox with a short
 *     timeout — never `eval`, never the host globals. (The timeout covers load;
 *     an infinite loop inside the function itself is out of scope for a demo.)
 *   - The loop is bounded by a typed `maxAttempts` guard on the `checking`
 *     choice state (LangGraph counts iterations against a `max_iterations`
 *     flag). Exhaustion ends in a `failed` OUTCOME carrying the last failures —
 *     not a thrown error.
 *   - A generation failure DEGRADES to `failed` with a best-effort message; no
 *     unhandled model error aborts the run.
 *
 * Dual-mode: `runCodeAssistantExample(options?)` takes an injectable
 * `generateText` (tests pass a scripted mock — keyless CI); the direct run uses
 * real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/code-assistant/index.ts
 */
import vm from "node:vm";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

export const models = defineModels({
  coder: openai("gpt-5.4-mini"),
});

/** One unit check: call the generated function with `args`, expect `expected`. */
export interface CodeCheck {
  args: unknown[];
  expected: unknown;
}

/** Result of running the generated code against the checks. */
export interface ExecutionResult {
  passed: boolean;
  failures: string[];
}

function formatValue(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

/** Structural equality good enough for pure-function return values. */
function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Run generated code in a sandboxed VM, then apply the unit checks. NEVER
 * `eval`: the code runs via `runInNewContext` against an EMPTY sandbox with a
 * short timeout. Code that throws at load (e.g. a syntax error) is reported as a
 * NORMAL failure — the promise never rejects.
 */
export function executeCode(
  code: string,
  functionName: string,
  checks: CodeCheck[],
  timeoutMs = 1000,
): ExecutionResult {
  const sandbox: Record<string, unknown> = {};
  try {
    vm.runInNewContext(code, sandbox, { timeout: timeoutMs });
  } catch (error) {
    return { passed: false, failures: [`Code failed to load: ${(error as Error).message}`] };
  }

  const fn = sandbox[functionName];
  if (typeof fn !== "function") {
    return {
      passed: false,
      failures: [`Expected a function named \`${functionName}\` to be defined.`],
    };
  }

  const failures: string[] = [];
  for (const check of checks) {
    const call = `${functionName}(${check.args.map(formatValue).join(", ")})`;
    try {
      const actual = (fn as (...args: unknown[]) => unknown)(...check.args);
      if (!deepEqual(actual, check.expected)) {
        failures.push(
          `${call} returned ${formatValue(actual)}, expected ${formatValue(check.expected)}`,
        );
      }
    } catch (error) {
      failures.push(`${call} threw: ${(error as Error).message}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

const codeCheckSchema = z.object({
  args: z.array(z.unknown()),
  expected: z.unknown(),
});

// Structured generation output: the code plus a short explanation. The code
// must define a single named function with no imports (enforced by the prompt).
const solutionSchema = z.object({
  code: z.string(),
  explanation: z.string(),
});

const agentSetup = setupAgent({
  models,
  context: z.object({
    // The task: a natural-language spec plus the function name and unit checks.
    spec: z.string(),
    functionName: z.string(),
    checks: z.array(codeCheckSchema),
    // The latest generated code and its explanation ("" until first generation).
    code: z.string(),
    explanation: z.string(),
    // Failures from the latest execution — fed back into the next generation.
    failures: z.array(z.string()),
    // Completed generate→execute attempts; the typed loop bound.
    attempts: z.number(),
    maxAttempts: z.number(),
    passed: z.boolean(),
  }),
  input: z.object({
    spec: z.string(),
    functionName: z.string(),
    checks: z.array(codeCheckSchema),
    maxAttempts: z.number().default(3),
  }),
  output: z.object({
    code: z.string(),
    attempts: z.number(),
    passed: z.boolean(),
    failures: z.array(z.string()),
  }),
  actorSources: {
    // check_code: the host-owned sandboxed executor. NOT a model call.
    runChecks: createAsyncLogic<
      ExecutionResult,
      { code: string; functionName: string; checks: CodeCheck[] }
    >({
      run: async ({ input }) => executeCode(input.code, input.functionName, input.checks),
    }),
  },
  requests: {
    // generate: one structured-output request returning `{ code, explanation }`.
    // On a retry, the prior code and its failures are in the prompt so the model
    // can correct them (the tutorial's reflect-then-regenerate).
    generateCode: {
      schemas: {
        input: z.object({
          spec: z.string(),
          functionName: z.string(),
          checks: z.array(codeCheckSchema),
          previousCode: z.string().nullable(),
          failures: z.array(z.string()),
        }),
        output: solutionSchema,
      },
      model: "coder",
      system:
        "You are a coding assistant. Write plain JavaScript that defines EXACTLY " +
        "ONE named function solving the task. No imports, no `require`, no " +
        "external dependencies — self-contained code only. Return the code and a " +
        "one-sentence explanation.",
      prompt: ({ input }) =>
        [
          input.spec,
          `Define a function named \`${input.functionName}\`.`,
          [
            "It must satisfy these checks (input -> expected output):",
            ...input.checks.map(
              (check) =>
                `  ${input.functionName}(${check.args.map(formatValue).join(", ")}) === ${formatValue(check.expected)}`,
            ),
          ].join("\n"),
          input.previousCode ? `Your previous attempt:\n${input.previousCode}` : "",
          input.failures.length
            ? `It failed these checks:\n${input.failures.map((failure) => `- ${failure}`).join("\n")}\nFix them.`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
    },
  },
});

export const codeAssistantSchemas = agentSetup.schemas;

export const codeAssistantMachine = agentSetup.createMachine({
  id: "code-assistant",
  context: ({ input }) => ({
    spec: input.spec,
    functionName: input.functionName,
    checks: input.checks,
    code: "",
    explanation: "",
    failures: [],
    attempts: 0,
    maxAttempts: input.maxAttempts,
    passed: false,
  }),
  initial: "generating",
  states: {
    // generate: produce (or correct) the code. A generation failure degrades to
    // `failed` with a best-effort message rather than aborting the run.
    generating: {
      invoke: {
        src: "generateCode",
        input: ({ context }) => ({
          spec: context.spec,
          functionName: context.functionName,
          checks: context.checks,
          previousCode: context.code || null,
          failures: context.failures,
        }),
        onDone: ({ output }) => ({
          target: "executing",
          context: { code: output.code, explanation: output.explanation },
        }),
        onError: {
          target: "failed",
          context: { failures: ["Code generation failed."] },
        },
      },
    },
    // check_code: run the code in the sandbox and apply the checks. Each pass
    // counts as one attempt (the typed loop bound).
    executing: {
      invoke: {
        src: "runChecks",
        input: ({ context }) => ({
          code: context.code,
          functionName: context.functionName,
          checks: context.checks,
        }),
        onDone: ({ context, output }) => ({
          target: "checking",
          context: {
            passed: output.passed,
            failures: output.failures,
            attempts: context.attempts + 1,
          },
        }),
      },
    },
    // decide: the conditional edge as a visible choice state. Passed → done.
    // Budget spent → failed. Otherwise reflect and retry.
    checking: {
      type: "choice",
      choice: ({ context }) =>
        context.passed
          ? { target: "done" }
          : context.attempts >= context.maxAttempts
            ? { target: "failed" }
            : { target: "reflecting" },
    },
    // reflect: the failures are already in context; loop back to generate, whose
    // prompt feeds them into the next attempt. A visible marker, not a model call.
    reflecting: {
      always: { target: "generating" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        code: context.code,
        attempts: context.attempts,
        passed: true,
        failures: [],
      }),
    },
    // Best-effort terminal: checks never passed within the budget (or generation
    // failed). Carries the last failures rather than throwing.
    failed: {
      type: "final",
      output: ({ context }) => ({
        code: context.code,
        attempts: context.attempts,
        passed: false,
        failures: context.failures,
      }),
    },
  },
});

export interface RunCodeAssistantOptions {
  spec?: string;
  functionName?: string;
  checks?: CodeCheck[];
  maxAttempts?: number;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition (the visible generate→check→reflect loop). */
  onProgress?: (state: string) => void;
}

export interface CodeAssistantResult {
  code: string;
  attempts: number;
  passed: boolean;
  failures: string[];
  progress: string[];
}

const DEFAULT_TASK = {
  spec: "Write a function that returns the sum of an array of numbers.",
  functionName: "sumArray",
  checks: [
    { args: [[1, 2, 3]], expected: 6 },
    { args: [[]], expected: 0 },
    { args: [[-5, 5, 10]], expected: 10 },
  ] satisfies CodeCheck[],
};

/** Runs the code-assistant loop; records state progress so the loop is observable. */
export async function runCodeAssistantExample(
  options: RunCodeAssistantOptions = {},
): Promise<CodeAssistantResult> {
  const {
    spec = DEFAULT_TASK.spec,
    functionName = DEFAULT_TASK.functionName,
    checks = DEFAULT_TASK.checks,
    maxAttempts = 3,
    generateText,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runAgent(codeAssistantMachine, {
    input: { spec, functionName, checks, maxAttempts },
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
    throw new Error(`Code-assistant example did not complete: ${result.status}`);
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

    const result = await runCodeAssistantExample({
      generateText,
      onProgress: (state) => console.log(`  → ${state}`),
    });

    console.log("\nTask:", DEFAULT_TASK.spec);
    console.log("Attempts:", result.attempts);
    console.log("Passed:", result.passed);
    if (result.failures.length) console.log("Failures:", result.failures);
    console.log("\nCode:\n", result.code);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
