import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runFileSnapshotStoreExample, runLongLivedActor } from "./index.js";

test("writes a native XState snapshot to a JSON file and resumes the run from it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-snapshot-test-"));
  const output = await runFileSnapshotStoreExample(directory, {
    generateText: async (request) => {
      if (request.name !== "draft") throw new Error(`unexpected request: ${request.name}`);
      return { output: "Framework-owned persistence." };
    },
  });

  // The real file on disk, parsed back: the run paused in `reviewing` and the
  // resumed run read that JSON, not an in-memory handle.
  const stored = JSON.parse(readFileSync(join(directory, "release-42.json"), "utf8"));
  expect(stored.value).toBe("reviewing");
  expect(stored.context.draft).toBe("Framework-owned persistence.");
  // `toMatchObject`, so the shared portable-loop machine can add output fields
  // (a `failure` reason, say) without breaking the persistence claim under test.
  expect(output).toMatchObject({ draft: "Framework-owned persistence." });
});

test("one actor stays alive from the model draft through the APPROVE event to done", async () => {
  const result = await runLongLivedActor("actors", {
    generateText: async (request) => {
      if (request.name !== "draft") throw new Error(`unexpected request: ${request.name}`);
      return { output: "Keep the actor alive." };
    },
  });

  expect(result.draft).toBe("Keep the actor alive.");
  // Every snapshot the application observed on its own subscription.
  expect(result.states).toEqual(["drafting", "reviewing", "done"]);
});
