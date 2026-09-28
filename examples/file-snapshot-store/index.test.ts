import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  releaseNoteMachine,
  runFileSnapshotStoreDemo,
  runFileSnapshotStoreExample,
  runLongLivedActor,
} from "./index.js";

test("writes a native XState snapshot to a JSON file and resumes the run from it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-snapshot-test-"));
  const output = await runFileSnapshotStoreExample(directory, {
    generateText: async (request) => {
      if (request.name !== "draft") throw new Error(`unexpected request: ${request.name}`);
      return { result: "Application-owned persistence." };
    },
  });

  // The real file on disk, parsed back: the run paused in `reviewing` and the
  // resumed run read that JSON, not an in-memory handle.
  const stored = JSON.parse(readFileSync(join(directory, "release-42.json"), "utf8"));
  expect(stored.value).toBe("reviewing");
  expect(stored.context.draft).toBe("Application-owned persistence.");
  expect(output).toMatchObject({ draft: "Application-owned persistence." });
});

test("one actor stays alive from the model draft through the APPROVE event to done", async () => {
  const result = await runLongLivedActor("actors", {
    generateText: async (request) => {
      if (request.name !== "draft") throw new Error(`unexpected request: ${request.name}`);
      return { result: "Keep the actor alive." };
    },
  });

  expect(result.draft).toBe("Keep the actor alive.");
  // Every snapshot the application observed on its own subscription.
  expect(result.states).toEqual(["drafting", "reviewing", "done"]);
});

test("refuses to start the long-lived actor when the run is already cancelled", async () => {
  let called = false;
  await expect(
    runLongLivedActor(
      "cancelled before it began",
      {
        generateText: async () => {
          called = true;
          return { result: "should never run" };
        },
      },
      { signal: AbortSignal.abort() },
    ),
  ).rejects.toThrow(/cancelled/);

  expect(called).toBe(false);
});

test("the demo reads as its own story: its own machine, the right topic, no host paths", async () => {
  const prompts: string[] = [];
  const transitions: string[] = [];
  const result = await runFileSnapshotStoreDemo({
    executors: {
      generateText: async (request) => {
        prompts.push(request.prompt ?? "");
        return { result: "A release note." };
      },
    },
    onTransition: (snapshot) => transitions.push(snapshot.machine.id),
  });

  // The storage half drafts about application-owned storage, not the opposite.
  expect(prompts[0]).toBe("Draft a release note about application-owned storage.");
  expect(prompts.join("\n")).not.toMatch(/framework-owned/i);
  // Transitions are this example's machine, not a borrowed one.
  expect(releaseNoteMachine.id).toBe("file-snapshot-store");
  expect(new Set(transitions)).toEqual(new Set(["file-snapshot-store"]));
  // A logical file name, never the OS temp directory.
  expect(result.snapshotFile).toBe("release-42.json (in a temp directory, removed after the run)");
  expect(JSON.stringify(result)).not.toContain(tmpdir());
});
