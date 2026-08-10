/**
 * Vercel AI SDK orchestrator-worker — ported to `setupAgent`. An orchestrator
 * request plans the file-level work, then a worker fans out one model call per
 * planned file to produce the actual `{ explanation, code }` — matching the
 * source example, where the implementation step maps over the planned files
 * and calls `generateText`/`Output.object` per file under `Promise.all`.
 *
 * The per-file fan-out is dynamic (N unknown at build time), so it lives in a
 * host-owned `implementChanges` actor (the same shape as the map-reduce "map"
 * step) rather than static parallel regions. Tests inject a deterministic
 * `implementChanges` via `.provide`; the direct run wires the real AI SDK.
 *
 * The final output leads with the plan and one line per changed file; the raw
 * code sits under `detail`, so it never becomes the headline.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#orchestrator-worker
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-orchestrator-worker/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import { createAsyncLogic } from "xstate";
import { setupAgent, runAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const implementationPlanSchema = z.object({
  files: z.array(
    z.object({
      purpose: z.string(),
      filePath: z.string(),
      changeType: z.enum(["create", "modify", "delete"]),
    }),
  ),
  estimatedComplexity: z.enum(["low", "medium", "high"]),
});
type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

const fileChangeSchema = z.object({
  filePath: z.string(),
  changeType: z.enum(["create", "modify", "delete"]),
  explanation: z.string(),
  code: z.string(),
});
type FileChange = z.infer<typeof fileChangeSchema>;

// The worker's per-file model output (path + changeType are already known from
// the plan; the model supplies the explanation and code).
const workerOutputSchema = z.object({
  explanation: z.string(),
  code: z.string(),
});

// Each worker returns a one-phrase `explanation` (the line the demo shows) and
// short `code` (kept out of the leading summary).
const workerSystemPrompts: Record<ImplementationPlan["files"][number]["changeType"], string> = {
  create:
    "You implement a new file. Return the file contents as `code`, under 30 lines, and a one-phrase `explanation` of what it does.",
  modify:
    "You modify an existing file. Return just the changed section as `code`, under 30 lines, and a one-phrase `explanation` of the change.",
  delete:
    "You remove a file. Return an empty `code` string and a one-phrase `explanation` of why it is safe to delete.",
};

export const models = defineModels({
  orchestrator: openai("gpt-5.4-mini"),
  worker: openai("gpt-5.4-mini"),
});

/**
 * Host-owned worker fan-out: one real model call per planned file, run
 * concurrently. Swap this out via `.provide({ actors: { implementChanges } })`
 * for a deterministic version in tests.
 */
export function createImplementChangesActor(model: LanguageModel) {
  return createAsyncLogic<FileChange[], { featureRequest: string; plan: ImplementationPlan }>({
    run: async ({ input }) =>
      Promise.all(
        input.plan.files.map(async (file): Promise<FileChange> => {
          const { output } = await generateText({
            model,
            system: workerSystemPrompts[file.changeType],
            output: Output.object({ schema: workerOutputSchema }),
            prompt: [
              `Implement the changes for ${file.filePath} to support:`,
              file.purpose,
              "",
              `Overall feature context: ${input.featureRequest}`,
            ].join("\n"),
          });
          return {
            filePath: file.filePath,
            changeType: file.changeType,
            explanation: output.explanation,
            code: output.code,
          };
        }),
      ),
  });
}

const contextSchema = z.object({
  featureRequest: z.string(),
  plan: implementationPlanSchema.nullable(),
  /** One line: how many files the orchestrator planned, and how hard. */
  planSummary: z.string().nullable(),
  changes: z.array(fileChangeSchema),
});

/** "Plan: 2 files, medium complexity" */
function planLine(plan: ImplementationPlan) {
  const count = plan.files.length;
  return `Plan: ${count} file${count === 1 ? "" : "s"}, ${plan.estimatedComplexity} complexity`;
}

/**
 * The final read: the plan line, then one line per changed file. Full code stays
 * out of the leading string — it rides along nested under `detail`.
 */
function summarize(plan: ImplementationPlan | null, changes: FileChange[]) {
  const files = changes.map(
    (change) => `- ${change.filePath} (${change.changeType}) — ${change.explanation}`,
  );
  return [
    plan ? planLine(plan) : "Plan: none",
    files.length ? files.join("\n") : "No files changed.",
  ].join("\n\n");
}

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ featureRequest: z.string() }),
  // Leads with the plan and one line per changed file; the raw code stays
  // nested under `detail` so it never becomes the headline.
  output: z.object({
    summary: z.string(),
    filesChanged: z.number(),
    complexity: z.enum(["low", "medium", "high"]),
    detail: z.object({
      plan: implementationPlanSchema,
      changes: z.array(fileChangeSchema),
    }),
  }),
  actors: {
    // Bound to the real AI SDK by default; overridden in tests via `.provide`.
    implementChanges: createImplementChangesActor(models.worker),
  },
  // planning sets plan before any state that reads it — narrow it non-null there.
  states: {
    implementing: { context: { plan: implementationPlanSchema } },
    done: { context: { plan: implementationPlanSchema } },
  },
  requests: {
    planImplementation: {
      schemas: {
        input: z.object({ featureRequest: z.string() }),
        output: implementationPlanSchema,
      },
      model: "orchestrator",
      system:
        "You are an implementation orchestrator. Break a feature request into the minimal set of file-level changes (path, purpose, create/modify/delete) and rate overall complexity. Plan at most three files, and keep each purpose to one short phrase.",
      prompt: ({ input }) => input.featureRequest,
    },
  },
});

export const aiSdkOrchestratorWorkerMachine = agentSetup.createMachine({
  id: "ai-sdk-orchestrator-worker",
  context: ({ input }) => ({
    featureRequest: input.featureRequest,
    plan: null,
    planSummary: null,
    changes: [],
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        id: "planImplementation",
        src: "planImplementation",
        input: ({ context }) => ({ featureRequest: context.featureRequest }),
        onDone: ({ output }) => ({
          target: "implementing",
          context: { plan: output, planSummary: planLine(output) },
        }),
        onError: { target: "failed" },
      },
    },
    implementing: {
      invoke: {
        id: "implementChanges",
        src: "implementChanges",
        input: ({ context }) => ({
          featureRequest: context.featureRequest,
          plan: context.plan,
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { changes: output },
        }),
        onError: { target: "failed" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        summary: summarize(context.plan, context.changes),
        filesChanged: context.changes.length,
        complexity: context.plan.estimatedComplexity,
        detail: { plan: context.plan, changes: context.changes },
      }),
    },
    // Best-effort output when the planning model call fails.
    failed: {
      type: "final",
      output: ({ context }) => {
        const plan = context.plan ?? { files: [], estimatedComplexity: "low" as const };
        return {
          summary: summarize(context.plan, context.changes),
          filesChanged: context.changes.length,
          complexity: plan.estimatedComplexity,
          detail: { plan, changes: context.changes },
        };
      },
    },
  },
});

export async function runAiSdkOrchestratorWorkerExample(
  observe?: Parameters<typeof runAgent>[1]["onTransition"],
) {
  const result = await runAgent(aiSdkOrchestratorWorkerMachine, {
    input: { featureRequest: "Add settings page" },
    executors: createAiSdkExecutors({ models }),
    onTransition: observe,
  });
  if (result.status !== "done") {
    throw new Error(`Orchestrator-worker example did not complete: ${result.status}`);
  }
  return result.output;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    console.log(
      await runAiSdkOrchestratorWorkerExample((snapshot) =>
        console.log("[state]", JSON.stringify(snapshot.value)),
      ),
    );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
