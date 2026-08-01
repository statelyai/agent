/**
 * `useLiveExecutors()` swaps the module-level `toolRunOptions` binding. The
 * bridge functions must therefore *default* to that binding, not to the frozen
 * `mockRunOptions` constant — otherwise calling `useLiveExecutors()` is a no-op
 * for every caller that doesn't pass `runOptions` explicitly.
 *
 * Lives in its own file because the swap is module state: a separate test file
 * gets a fresh module registry, so the other specs still see the mock.
 */
import { describe, expect, test, vi } from "vitest";

/** Stand in for the real ai-sdk executors with a marker generation. */
vi.mock("@statelyai/agent/ai-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@statelyai/agent/ai-sdk")>();
  const createAiSdkExecutors = () => ({
    generateText: async (request: { model: string }) =>
      request.model === "promptEvaluator"
        ? { output: { satisfied: true, missing: [], questions: [] } }
        : {
            output: {
              to: "marker@example.com",
              subject: "MARKER SUBJECT",
              body: "Written by the marker executor.",
            },
          },
  });
  return { ...actual, createAiSdkExecutors };
});

const { startDraft, startWorkflow, unwrapToolResult, useLiveExecutors } =
  await import("./index.js");

describe("mastra-host useLiveExecutors", () => {
  test("takes effect for bridge callers that pass no runOptions", async () => {
    const before = await startDraft("Announce the faster deploys.");
    expect(before.status).toBe("pending");
    if (before.status !== "pending") return;
    // The keyless default is still in force.
    expect(before.draft?.subject).toBe("Deploy pipeline is faster");

    useLiveExecutors();

    const after = await startDraft("Announce the faster deploys.");
    expect(after.status).toBe("pending");
    if (after.status !== "pending") return;
    expect(after.draft?.subject).toBe("MARKER SUBJECT");
    expect(after.draft?.to).toBe("marker@example.com");
  });

  test("also takes effect through the Mastra tool wrapper", async () => {
    const result = unwrapToolResult(
      await startWorkflow.execute!(
        { prompt: "Announce the faster deploys." },
        { observe: (await import("@mastra/core/tools")).noopObserve },
      ),
    );
    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.draft?.subject).toBe("MARKER SUBJECT");
  });
});
