import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runFileSnapshotStoreExample } from "./index.js";

test("persists and resumes a native XState snapshot through application storage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-snapshot-test-"));
  const output = await runFileSnapshotStoreExample(directory, {
    generateText: async () => ({ output: "Framework-owned persistence." }),
  });

  const stored = JSON.parse(readFileSync(join(directory, "release-42.json"), "utf8"));
  expect(stored.value).toBe("reviewing");
  expect(output).toEqual({ draft: "Framework-owned persistence." });
});
