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
 * Compare: https://ai-sdk.dev/docs/agents/workflows#orchestrator-worker
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-orchestrator-worker/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import { createAsyncLogic } from "xstate";
import { setupAgent, runAgent } from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

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

const workerSystemPrompts: Record<ImplementationPlan["files"][number]["changeType"], string> = {
  create:
    "You implement a new file. Return the full file contents as `code` and a one-line `explanation` of what it does.",
  modify:
    "You modify an existing file. Return the changed file contents as `code` and a one-line `explanation` of the change.",
  delete:
    "You remove a file. Return an empty `code` string and a one-line `explanation` of why it is safe to delete.",
};

export const models = defineModels({
  orchestrator: openai("gpt-5.4-mini"),
  worker: openai("gpt-5.4-mini"),
});

/**
 * Host-owned worker fan-out: one real model call per planned file, run
 * concurrently. Swap this out via `.provide({ actorSources: { implementChanges } })`
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
  changes: z.array(fileChangeSchema),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ featureRequest: z.string() }),
  output: z.object({
    plan: implementationPlanSchema,
    changes: z.array(fileChangeSchema),
  }),
  actorSources: {
    // Bound to the real AI SDK by default; overridden in tests via `.provide`.
    implementChanges: createImplementChangesActor(models.worker),
  },
  // planning sets plan before any state that reads it — narrow it non-null there.
  states: {
    planning: {},
    implementing: {
      schemas: { context: contextSchema.extend({ plan: implementationPlanSchema }) },
    },
    done: {
      schemas: { context: contextSchema.extend({ plan: implementationPlanSchema }) },
    },
  },
  requests: {
    planImplementation: {
      schemas: {
        input: z.object({ featureRequest: z.string() }),
        output: implementationPlanSchema,
      },
      model: "orchestrator",
      system:
        "You are an implementation orchestrator. Break a feature request into the minimal set of file-level changes (path, purpose, create/modify/delete) and rate overall complexity.",
      prompt: ({ input }) => input.featureRequest,
    },
  },
});

export const aiSdkOrchestratorWorkerMachine = agentSetup.createMachine({
  id: "ai-sdk-orchestrator-worker",
  context: ({ input }) => ({
    featureRequest: input.featureRequest,
    plan: null,
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
          context: { plan: output },
        }),
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
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        plan: context.plan,
        changes: context.changes,
      }),
    },
  },
});

export async function runAiSdkOrchestratorWorkerExample(
  observe?: Parameters<typeof runAgent>[1]["onTransition"],
) {
  const result = await runAgent(aiSdkOrchestratorWorkerMachine, {
    input: { featureRequest: "Add settings page" },
    ...createAiSdkExecutors({ models }),
    onTransition: observe,
  });
  if (result.status !== "done") {
    throw new Error(`Orchestrator-worker example did not complete: ${result.status}`);
  }
  return result.output;
}

runExampleMain(import.meta.url, async () => {
  console.log(
    await runAiSdkOrchestratorWorkerExample((snapshot) =>
      console.log("[state]", JSON.stringify(snapshot.value)),
    ),
  );
});
