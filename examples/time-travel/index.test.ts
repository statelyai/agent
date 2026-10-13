import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { getInteraction } from "@statelyai/agent";
import { replay } from "@statelyai/agent/log";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import { runTimeTravelExample, timeTravelMachine } from "./index.js";

/** Only the model is mocked, keyed by request name; the draft echoes its tone. */
function scripted() {
  const executors = createMockModelExecutors({
    text: {
      outline: "- what a state is\n- what an event is\n- why transitions are pure",
      draft: (request) => `A ${(request.input as { tone: string }).tone} draft.`,
    },
  });
  return { generateText: executors.generateText, calls: executors.calls };
}

test("the branch replays A's prefix, edits the tone, and diverges as a new lineage", async () => {
  const executors = scripted();
  const { branchIndex, a, b, logAAfterBranch } = await runTimeTravelExample({
    tone: "formal",
    branchTone: "playful",
    generateText: executors.generateText,
  });

  // B's init entry carries the edited snapshot rather than machine input.
  const initB = b.log[0]!.event as { type: string; snapshot?: { context?: { tone?: string } } };
  expect(initB.type).toBe("@agent.init");
  expect((initB.snapshot as { value?: unknown }).value).toBe("outlined");
  expect(initB.snapshot?.context?.tone).toBe("playful");

  // A snapshot-only resume mints a new execution id: B is its own lineage.
  expect(a.executionId).toBeDefined();
  expect(b.executionId).toBeDefined();
  expect(b.executionId).not.toBe(a.executionId);

  // B keeps A's outline (replayed, not re-requested) and redrafts it.
  expect(b.output.outline).toBe(a.output.outline);
  expect(a.output.draft).toBe("A formal draft.");
  expect(b.output.draft).toBe("A playful draft.");
  expect(executors.calls.map((call) => call.name)).toEqual(["outline", "draft", "draft"]);

  // A's log is unchanged by the branch.
  expect(logAAfterBranch).toEqual(a.log);
  expect(branchIndex).toBeLessThan(a.log.length);
});

test("the branch point is a labelled human wait", async () => {
  const { branchIndex, a } = await runTimeTravelExample({ generateText: scripted().generateText });
  const { snapshot } = replay(timeTravelMachine, a.log.slice(0, branchIndex));
  expect(getInteraction(snapshot)?.label).toBe(
    "Outline ready for 'state machines'. Draft it in a formal tone?",
  );
});

test("starters run to done", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ input: { topic: string; tone: string } }>;
  expect(starters).toHaveLength(2);

  for (const { input } of starters) {
    const result = await runTimeTravelExample({ ...input, generateText: scripted().generateText });
    expect(result.a.output.tone).toBe(input.tone);
    expect(result.b.output.tone).toBe("playful");
  }
});

test("lint is clean", () => {
  expect(() => lintAgentMachine(timeTravelMachine, { throw: true })).not.toThrow();
});
