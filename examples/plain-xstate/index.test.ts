import { describe, expect, test } from "vitest";
import { createAgentRuntime, getStatePath, runToQuiescence } from "@statelyai/agent";
import { createMockModelExecutors } from "../mock-model.js";
import { plainWriterAgentMachine, plainWriterMachine, runPlainXstateExample } from "./index.js";

describe("plain-xstate", () => {
  test("drives the plain machine to completion when the model approves", async () => {
    const result = await runPlainXstateExample({
      generateText: async () => ({ result: "A crisp, concrete launch blurb." }),
      decide: async () => ({ event: { type: "APPROVE" } }),
    });

    expect(result.decisions).toEqual(["APPROVE"]);
    expect(result.drafts).toBe(1);
    expect(result.revisions).toBe(0);
    expect(result.retries).toBe(0);
    expect(result.draft).toBe("A crisp, concrete launch blurb.");
    expect(result.progress).toBe(
      "Draft 1 ready: 0 of 2 revisions used, 0 retries after a failed attempt.",
    );
  });

  test("a rejected draft actor is re-invoked, and the run continues", async () => {
    let calls = 0;
    const result = await runPlainXstateExample({
      generateText: async () => {
        calls += 1;
        if (calls === 1) throw new Error("model unavailable");
        return { result: "A crisp, concrete launch blurb." };
      },
      decide: async () => ({ event: { type: "APPROVE" } }),
    });

    // One failure, one retry, then the normal draft → judge → approve path.
    expect(calls).toBe(2);
    expect(result.retries).toBe(1);
    expect(result.drafts).toBe(1);
    expect(result.decisions).toEqual(["APPROVE"]);
    expect(result.progress).toContain("1 retry after a failed attempt");
  });

  test("retries are bounded by the machine, not by the driving loop", async () => {
    let calls = 0;
    const result = await runPlainXstateExample({
      generateText: async () => {
        calls += 1;
        throw new Error("model unavailable");
      },
      decide: async () => ({ event: { type: "APPROVE" } }),
    });

    // First attempt plus two retries, then `failed` — no judging round happens.
    expect(calls).toBe(3);
    expect(result.retries).toBe(2);
    expect(result.drafts).toBe(0);
    expect(result.decisions).toEqual([]);
    expect(result.progress).toBe("Draft failed after 2 retries.");
  });

  test("loops through REVISE and re-drafts, then approves", async () => {
    let judged = 0;
    const result = await runPlainXstateExample({
      generateText: async () => ({ result: "draft" }),
      // REVISE the first two rounds, then APPROVE.
      decide: async () => {
        judged += 1;
        return { event: { type: judged <= 2 ? "REVISE" : "APPROVE" } };
      },
    });

    // draft → judge(REVISE) → draft → judge(REVISE) → draft → judge(APPROVE)
    expect(result.decisions).toEqual(["REVISE", "REVISE", "APPROVE"]);
    expect(result.drafts).toBe(3);
    // Exactly `maxRevisions` REVISEs were accepted — no off-by-one third one.
    expect(result.revisions).toBe(2);
  });

  test("the guard — not the model — bounds the revision loop", () => {
    // At the budget, REVISE is not takeable; only APPROVE remains legal.
    const spent = plainWriterMachine.resolveState({
      value: "judging",
      context: {
        topic: "x",
        maxRevisions: 2,
        drafts: 3,
        revisions: 2,
        retries: 0,
        maxRetries: 2,
        draft: "d",
        failure: null,
      },
    });
    expect(spent.can({ type: "REVISE" })).toBe(false);
    expect(spent.can({ type: "APPROVE" })).toBe(true);

    // Within the budget, both are legal.
    const withinBudget = plainWriterMachine.resolveState({
      value: "judging",
      context: {
        topic: "x",
        maxRevisions: 2,
        drafts: 2,
        revisions: 1,
        retries: 0,
        maxRetries: 2,
        draft: "d",
        failure: null,
      },
    });
    expect(withinBudget.can({ type: "REVISE" })).toBe(true);
    expect(withinBudget.can({ type: "APPROVE" })).toBe(true);
  });

  test("under the agent runtime, the model writes every draft (no canned placeholder)", async () => {
    const drafts = ["Model draft one.", "Model draft two."];
    const executors = createMockModelExecutors({ text: { writeDraft: drafts } });

    const first = await runToQuiescence(
      createAgentRuntime(plainWriterAgentMachine, { executors }),
      {
        input: { topic: "a solar weather station" },
      },
    );
    expect(first.status).toBe("idle");
    if (first.status !== "idle") throw new Error("expected idle");
    // Settles on the plain machine's own decision point, holding the model's text.
    expect(getStatePath(first.snapshot)).toBe("judging");
    expect(first.snapshot.context.draft).toBe("Model draft one.");

    const second = await runToQuiescence(
      createAgentRuntime(plainWriterAgentMachine, { executors }),
      {
        snapshot: first.persist(),
        event: { type: "REVISE" },
      },
    );
    if (second.status !== "idle") throw new Error("expected idle");
    expect(second.snapshot.context.draft).toBe("Model draft two.");

    const done = await runToQuiescence(createAgentRuntime(plainWriterAgentMachine, { executors }), {
      snapshot: second.persist(),
      event: { type: "APPROVE" },
    });
    if (done.status !== "done") throw new Error("expected done");
    expect(done.output.draft).toBe("Model draft two.");
    expect(done.output.revisions).toBe(1);
    // The revision prompt reached the model on the second draft.
    expect(executors.calls.map((call) => call.name)).toEqual(["writeDraft", "writeDraft"]);
    expect(String(executors.calls[1]?.request.prompt)).toContain("revision #1");
  });

  test("under the agent runtime, a failed model call still takes the plain retry loop", async () => {
    let calls = 0;
    const executors = createMockModelExecutors({
      text: {
        writeDraft: () => {
          calls += 1;
          if (calls === 1) throw new Error("model unavailable");
          return "Recovered draft.";
        },
      },
    });
    const result = await runToQuiescence(
      createAgentRuntime(plainWriterAgentMachine, { executors }),
      {
        input: { topic: "x" },
      },
    );
    if (result.status !== "idle") throw new Error(`expected idle, got ${result.status}`);
    expect(result.snapshot.context.retries).toBe(1);
    expect(result.snapshot.context.draft).toBe("Recovered draft.");
  });
});
