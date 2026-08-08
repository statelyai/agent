import { expect, test } from "vitest";
import { reflectionWriterMachine, runReflectionWriterExample } from "./index.js";

// Mock the two model calls by routing on `request.model` (the alias set in
// `defineModels`). `writer` returns a bare essay string; `critic` returns the
// structured `{ critique, satisfied }` verdict. Each side is scripted in order,
// one entry per invocation. Only the model calls are mocked — the machine's
// loop, guards, and transcript accumulation run for real.
function scriptedGenerateText(scripts: {
  writer: string[];
  critic: Array<{ critique: string; satisfied: boolean }>;
}) {
  const cursors = { writer: 0, critic: 0 };
  return async (request: { model: string }) => {
    if (request.model === "writer") {
      const essay = scripts.writer[cursors.writer] ?? scripts.writer[scripts.writer.length - 1];
      cursors.writer++;
      return { output: essay };
    }
    const critique = scripts.critic[cursors.critic] ?? scripts.critic[scripts.critic.length - 1];
    cursors.critic++;
    return { output: critique };
  };
}

test("reflection loop runs to the revision bound then stops (LangGraph should_continue analogue)", async () => {
  // Critic never satisfied → the typed `revisions >= maxRevisions` guard is the
  // only thing that stops the loop, exactly like LangGraph's message-count edge.
  const result = await runReflectionWriterExample({
    topic: "The little prince",
    generateText: scriptedGenerateText({
      writer: ["draft 1", "draft 2", "draft 3", "draft 4"],
      critic: [
        { critique: "Too short.", satisfied: false },
        { critique: "Needs depth.", satisfied: false },
        { critique: "Still thin.", satisfied: false },
      ],
    }),
  });

  // 3 revision rounds: drafting entered 3 times, critiquing 3 times.
  expect(result.progress.filter((s) => s === "drafting")).toHaveLength(3);
  expect(result.progress.filter((s) => s === "critiquing")).toHaveLength(3);
  expect(result.revisions).toBe(3);
  expect(result.satisfied).toBe(false);
  // Final draft is the 3rd (the 4th is never requested — bound hit first).
  expect(result.essay).toBe("draft 3");
  expect(result.progress.at(-1)).toBe("done");
  // Transcript: 1 task + 3 drafts + 3 critiques = 7 messages.
  expect(result.messageCount).toBe(7);
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
    generateText: async (request: { model: string; system?: string }) => {
      if (request.model === "writer") return { output: drafts[cursors.writer++] };
      critiqueSystems.push(request.system ?? "");
      return { output: verdicts[cursors.critic++] };
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
  expect(result.revisions).toBe(2);
  expect(result.satisfied).toBe(true);
  expect(result.essay).toBe("revised draft with evidence");
});

test("early exit when the critic is satisfied (improves on the fixed-count tutorial)", async () => {
  // Critic signs off after the 2nd draft, under the revision bound — the
  // `satisfied` branch of the checking guard ends the loop early.
  const result = await runReflectionWriterExample({
    topic: "The little prince",
    generateText: scriptedGenerateText({
      writer: ["draft 1", "draft 2", "draft 3"],
      critic: [
        { critique: "Expand the ending.", satisfied: false },
        { critique: "Excellent — ship it.", satisfied: true },
      ],
    }),
  });

  expect(result.satisfied).toBe(true);
  expect(result.revisions).toBe(2);
  expect(result.progress.filter((s) => s === "drafting")).toHaveLength(2);
  expect(result.essay).toBe("draft 2");
  expect(result.progress.at(-1)).toBe("done");
});

test("model failure degrades to the best-effort current draft (onError, no throw)", async () => {
  // First draft succeeds, then the critique call throws. onError routes to done
  // carrying the draft we already have rather than erroring the run.
  const generateText = async (request: { model: string }) => {
    if (request.model === "writer") return { output: "the only draft" };
    throw new Error("critic model unavailable");
  };

  const result = await runReflectionWriterExample({
    topic: "The little prince",
    generateText,
  });

  expect(result.essay).toBe("the only draft");
  // Never reached a completed critique, so no revision counted and not satisfied.
  expect(result.revisions).toBe(0);
  expect(result.satisfied).toBe(false);
  expect(result.progress.at(-1)).toBe("done");
});

test("machine exports a runnable definition", () => {
  expect(reflectionWriterMachine.id).toBe("reflection-writer");
});
