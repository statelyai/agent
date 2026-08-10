import { test } from "vitest";
import assert from "node:assert/strict";
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { runAgent } from "@statelyai/agent";
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
    actors: {
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
    executors: {
      generateText: async () => ({
        output: {
          files: [
            { purpose: "Add UI", filePath: "app/page.tsx", changeType: "modify" },
            { purpose: "Add test", filePath: "app/page.test.tsx", changeType: "create" },
          ],
          estimatedComplexity: "medium",
        },
      }),
    },
  });

  assert.equal(result.status, "done");
  const output = result.status === "done" ? result.output : undefined;
  assert.deepEqual(output?.detail.changes.map((change: FileChange) => change.filePath) ?? [], [
    "app/page.tsx",
    "app/page.test.tsx",
  ]);
  assert.equal(output?.detail.changes[0]?.explanation, "Implement Add UI for Add settings page");
  // The summary leads with the plan and one line per file; code stays nested.
  assert.equal(output?.filesChanged, 2);
  assert.equal(output?.complexity, "medium");
  assert.equal(
    output?.summary,
    [
      "Plan: 2 files, medium complexity",
      "",
      "- app/page.tsx (modify) — Implement Add UI for Add settings page",
      "- app/page.test.tsx (create) — Implement Add test for Add settings page",
    ].join("\n"),
  );
  assert.ok(!output?.summary.includes("// modify"));
});
