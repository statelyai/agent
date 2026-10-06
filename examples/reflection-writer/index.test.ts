import { expect, test } from "vitest";
import { createAgentRuntime, runToQuiescence } from "@statelyai/agent";
import { createMockModelExecutors } from "../mock-model.js";
import { reflectionWriterMachine, runReflectionWriterExample } from "./index.js";

// Mock the two model calls by routing on `request.name` (the key each request
// was declared under). `writeEssay` returns a bare essay string; `critiqueEssay`
// returns the structured `{ critique, satisfied }` verdict. Each side is scripted in order,
// one entry per invocation. Only the model calls are mocked — the machine's
// loop, guards, and transcript accumulation run for real.
function scriptedGenerateText(scripts: {
  writer: string[];
  critic: Array<{ critique: string; satisfied: boolean }>;
}) {
  const cursors = { writer: 0, critic: 0 };
  return async (request: { name?: string }) => {
    if (request.name === "writeEssay") {
      const essay = scripts.writer[cursors.writer] ?? scripts.writer[scripts.writer.length - 1];
      cursors.writer++;
      return { result: essay };
    }
    const critique = scripts.critic[cursors.critic] ?? scripts.critic[scripts.critic.length - 1];
    cursors.critic++;
    return { result: critique };
  };
}

test("reflection loop runs to the revision bound then stops (LangGraph should_continue analogue)", async () => {
  // Critic never satisfied → the typed `rewrites >= maxRevisions` guard is the
  // only thing that stops the loop, exactly like LangGraph's message-count edge.
  const result = await runReflectionWriterExample({
    topic: "The little prince",
    generateText: scriptedGenerateText({
      writer: ["draft 1", "draft 2", "draft 3"],
      critic: [
        { critique: "Too short.", satisfied: false },
        { critique: "Needs depth.", satisfied: false },
        { critique: "Still vague.", satisfied: false },
      ],
    }),
  });

  // First draft + 2 rewrites: drafting entered 3 times, each draft critiqued.
  expect(result.progress.filter((s) => s === "drafting")).toHaveLength(3);
  expect(result.progress.filter((s) => s === "critiquing")).toHaveLength(3);
  expect(result.rewrites).toBe(2);
  expect(result.satisfied).toBe(false);
  expect(result.comparison).toMatch(/Final draft \(rewrite 2\)\ndraft 3/);
  expect(result.progress.at(-1)).toBe("done");
  // The stop reason counts the rewrites that actually happened.
  expect(result.comparison).toMatch(/not satisfied after 2 rewrites/);
  // 3 critiques for 2 rewrites: each is labeled with the draft it graded, so
  // no counter claims a third revision.
  expect(result.comparison).toMatch(
    /Critiques \(3\)\nOriginal: revise\. Too short\.\nRewrite 1: revise\. Needs depth\.\nRewrite 2: revise\. Still vague\.$/,
  );
  expect(result.comparison).not.toMatch(/revision/i);
});

test("the revision count is the number of rewrites, not critique rounds", async () => {
  // Draft → critique → ONE rewrite → critique → signed off: 1 revision.
  const result = await runReflectionWriterExample({
    topic: "The little prince",
    generateText: scriptedGenerateText({
      writer: ["draft 1", "draft 2"],
      critic: [
        { critique: "Too short.", satisfied: false },
        { critique: "Good.", satisfied: true },
      ],
    }),
  });

  expect(result.progress.filter((s) => s === "drafting")).toHaveLength(2);
  expect(result.rewrites).toBe(1);
  expect(result.comparison).toMatch(/^The critic signed off on rewrite 1\./);
});

test("the result shows the original next to the final draft, with a one-line revision log", async () => {
  const result = await runReflectionWriterExample({
    topic: "The little prince",
    generateText: scriptedGenerateText({
      writer: ["the original draft", "the final draft"],
      critic: [
        { critique: "Too short.", satisfied: false },
        { critique: "Good enough now.", satisfied: true },
      ],
    }),
  });

  // Both drafts are kept, and the comparison leads with them side by side.
  expect(result.comparison).toMatch(/Original draft\nthe original draft/);
  expect(result.comparison).toMatch(/Final draft \(rewrite 1\)\nthe final draft/);

  // One collapsed line per critique, labeled with the draft it graded.
  const logLines = result.comparison
    .split("\n")
    .filter((line) => /^(Original|Rewrite \d+): (revise|satisfied)\./.test(line));
  expect(logLines).toEqual([
    "Original: revise. Too short.",
    "Rewrite 1: satisfied. Good enough now.",
  ]);

  // The drafts live only inside the comparison: no field repeats them, and no
  // transcript bookkeeping is part of the result.
  expect(Object.keys(result).sort()).toEqual(
    ["comparison", "failure", "progress", "rewrites", "satisfied"].sort(),
  );
});

test("the critic grades against the strict rubric, so one draft is never enough", async () => {
  // The rubric text is what keeps a live run from signing off on the first
  // draft and hiding the loop. Capture the critique request to assert the
  // rubric reaches the model, and script a critic that behaves as instructed:
  // false on the first draft, satisfied on the revision.
  const critiqueSystems: string[] = [];
  const drafts = ["thin first draft", "revised draft with evidence"];
  const verdicts = [
    { critique: "No counterargument, and claims lack evidence.", satisfied: false },
    { critique: "Every rubric item met.", satisfied: true },
  ];
  const cursors = { writer: 0, critic: 0 };

  const result = await runReflectionWriterExample({
    topic: "Carbon tax versus cap-and-trade",
    generateText: async (request: { name?: string; system?: string }) => {
      if (request.name === "writeEssay") return { result: drafts[cursors.writer++] };
      critiqueSystems.push(request.system ?? "");
      return { result: verdicts[cursors.critic++] };
    },
  });

  // The rubric is in the critic's system prompt on every critique.
  expect(critiqueSystems).toHaveLength(2);
  for (const system of critiqueSystems) {
    expect(system).toMatch(/strict rubric/i);
    expect(system).toMatch(/counterargument/i);
    expect(system).toMatch(/first draft almost never clears this bar/i);
  }

  // The loop actually ran: draft → critique → revise → critique.
  expect(result.progress.filter((s) => s === "drafting")).toHaveLength(2);
  expect(result.rewrites).toBe(1);
  expect(result.satisfied).toBe(true);
  expect(result.comparison).toContain("revised draft with evidence");
});

test("early exit when the critic is satisfied (improves on the fixed-count tutorial)", async () => {
  // Critic signs off after the 1st draft, under the revision bound — the
  // `satisfied` branch of the checking guard ends the loop early.
  const result = await runReflectionWriterExample({
    topic: "The little prince",
    generateText: scriptedGenerateText({
      writer: ["draft 1", "draft 2"],
      critic: [{ critique: "Excellent, ship it.", satisfied: true }],
    }),
  });

  expect(result.satisfied).toBe(true);
  // Stopped after the first draft: no rewrite needed.
  expect(result.rewrites).toBe(0);
  expect(result.progress.filter((s) => s === "drafting")).toHaveLength(1);
  // No rewrite: the original is shown once, not repeated as a "final draft".
  expect(result.comparison).toMatch(/^The critic signed off on the original draft\./);
  expect(result.comparison.match(/draft 1/g)).toHaveLength(1);
  expect(result.comparison).not.toContain("Final draft");
  expect(result.progress.at(-1)).toBe("done");
  expect(result.failure).toBeNull();
});

test("model failure ends in `failed`, still reporting the draft it had", async () => {
  // First draft succeeds, then the critique call throws. onError routes to
  // `failed`, which reports the draft in hand AND why the run stopped — a
  // caller can tell this apart from a run that finished normally.
  const generateText = async (request: { name?: string }) => {
    if (request.name === "writeEssay") return { result: "the only draft" };
    throw new Error("critic model unavailable");
  };

  const result = await runReflectionWriterExample({
    topic: "The little prince",
    generateText,
  });

  expect(result.comparison).toContain("the only draft");
  // Only the first draft exists, so no rewrite counted and not satisfied.
  expect(result.rewrites).toBe(0);
  expect(result.satisfied).toBe(false);
  expect(result.failure).toMatch(/^critiqueEssay failed: /);
  expect(result.comparison).toContain("Stopped early");
  expect(result.progress.at(-1)).toBe("failed");
});

test("every rewrite sees its previous draft and the latest critique; counters agree", async () => {
  // Real AI SDK adapter over a mock model: the writer echoes which draft it is
  // on, the critic never signs off, so the run spends its full rewrite budget.
  const executors = createMockModelExecutors({
    text: {
      writeEssay: ["draft 0", "draft 1", "draft 2"],
      critiqueEssay: [
        { critique: "critique of draft 0", satisfied: false },
        { critique: "critique of draft 1", satisfied: false },
        { critique: "critique of draft 2", satisfied: false },
      ],
    },
  });
  const emitted: Array<{ type: string; rewrite: number }> = [];
  const result = await runToQuiescence(
    createAgentRuntime(reflectionWriterMachine, {
      executors,
      on: { "*": (event) => emitted.push({ type: event.type, rewrite: event.rewrite }) },
    }),
    { input: { topic: "Car-free downtowns" } },
  );
  expect(result.status).toBe("done");

  // Each rewrite's transcript ends with the draft it rewrites and the critique
  // of exactly that draft.
  const writes = executors.calls.filter((call) => call.name === "writeEssay");
  expect(writes).toHaveLength(3);
  for (const [index, call] of writes.slice(1).entries()) {
    const messages = (call.input as { messages: Array<{ role: string; content: unknown }> })
      .messages;
    expect(messages.at(-2)).toMatchObject({ role: "assistant", content: `draft ${index}` });
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: `Critique:\ncritique of draft ${index}`,
    });
  }

  // DRAFTED and CRITIQUED name the same draft numbers the output counts:
  // the last event is the critique of rewrite 2, and the result says 2.
  expect(emitted).toEqual([
    { type: "DRAFTED", rewrite: 0 },
    { type: "CRITIQUED", rewrite: 0 },
    { type: "DRAFTED", rewrite: 1 },
    { type: "CRITIQUED", rewrite: 1 },
    { type: "DRAFTED", rewrite: 2 },
    { type: "CRITIQUED", rewrite: 2 },
  ]);
  if (result.status !== "done") return;
  expect(result.output.rewrites).toBe(2);
  expect(result.output.comparison).toMatch(/Final draft \(rewrite 2\)\ndraft 2/);
});

test("machine exports a runnable definition", () => {
  expect(reflectionWriterMachine.id).toBe("reflection-writer");
});
