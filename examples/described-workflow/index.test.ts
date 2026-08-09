import { describe, expect, test } from "vitest";
import { runAgent, type AgentTextRequest } from "@statelyai/agent";
import { describedWorkflowMachine, runDescribedWorkflowExample } from "./index.js";

/** Scripted writer: outline or blurb, chosen off the prompt. */
const generateText = async (request: AgentTextRequest) => ({
  output: request.prompt?.startsWith("List the three")
    ? "1. Visual. 2. Executable. 3. Verifiable."
    : "Statechart Studio turns your logic into diagrams you can run.",
});

describe("described-workflow", () => {
  test("interprets the plain machine's descriptions into a full run", async () => {
    let judged = 0;
    const result = await runDescribedWorkflowExample({
      generateText,
      decide: async () => {
        judged += 1;
        return { event: { type: judged === 1 ? "REVISE" : "APPROVE" } };
      },
    });

    // outline → draft → judge(REVISE) → draft → judge(APPROVE).
    expect(judged).toBe(2);
    expect(result.outline).toContain("Visual");
    expect(result.draft).toBe("Statechart Studio turns your logic into diagrams you can run.");
    expect(result.messages.at(-1)?.content).toBe("[chose: APPROVE]");
  });

  test("reaches the judging gate with a real draft for a host with no getRequests", async () => {
    // A host that only runs the machine (the demo) still gets the artifacts:
    // each writing state produces its own text before the gate is reached.
    const idle = await runAgent(describedWorkflowMachine, { executors: { generateText } });

    expect(idle.status).toBe("idle");
    if (idle.status !== "idle") return;
    expect(idle.snapshot.value).toBe("judging");
    expect(idle.snapshot.context.outline).toBeTruthy();
    expect(idle.snapshot.context.draft).toBe(
      "Statechart Studio turns your logic into diagrams you can run.",
    );

    // Approving the visible draft finishes the run.
    const done = await runAgent(describedWorkflowMachine, {
      snapshot: idle.persistedSnapshot,
      event: { type: "APPROVE" },
      executors: { generateText },
    });
    expect(done.status).toBe("done");
    if (done.status !== "done") return;
    expect((done.output as { draft: string }).draft).toContain("Statechart Studio");
  });
});
