import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { runAgent } from "../../src/index.js";
import { aiSdkOrchestratorWorkerMachine } from "./index.js";

const fileChangeSchema = z.object({
  filePath: z.string(),
  changeType: z.enum(["create", "modify", "delete"]),
  explanation: z.string(),
  code: z.string(),
});
type FileChange = z.infer<typeof fileChangeSchema>;

test("AI SDK orchestrator-worker plans then fans out a worker call per file", async () => {
  // Deterministic worker: stands in for the real per-file model calls.
  const machine = aiSdkOrchestratorWorkerMachine.provide({
    actorSources: {
      implementChanges: createAsyncLogic<
        FileChange[],
        {
          featureRequest: string;
          plan: {
            files: Array<{
              purpose: string;
              filePath: string;
              changeType: FileChange["changeType"];
            }>;
          };
        }
      >({
        run: async ({ input }) =>
          input.plan.files.map((file) => ({
            filePath: file.filePath,
            changeType: file.changeType,
            explanation: `Implement ${file.purpose} for ${input.featureRequest}`,
            code: `// ${file.changeType} ${file.filePath}`,
          })),
      }),
    },
  });

  const result = await runAgent(machine, {
    input: { featureRequest: "Add settings page" },
    generateText: async () => ({
      output: {
        files: [
          { purpose: "Add UI", filePath: "app/page.tsx", changeType: "modify" },
          { purpose: "Add test", filePath: "app/page.test.tsx", changeType: "create" },
        ],
        estimatedComplexity: "medium",
      },
    }),
  });

  assert.equal(result.status, "done");
  assert.deepEqual(
    result.status === "done"
      ? result.output.changes.map((change: FileChange) => change.filePath)
      : [],
    ["app/page.tsx", "app/page.test.tsx"],
  );
  assert.equal(
    result.status === "done" ? result.output.changes[0]?.explanation : undefined,
    "Implement Add UI for Add settings page",
  );
});
