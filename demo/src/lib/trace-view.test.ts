import { describe, expect, it } from "vitest";
import { liveTraceStep, summarizePayload, traceSteps } from "./trace-view";

describe("transition payload summaries", () => {
  it("drops the actor plumbing the row's own label already carries", () => {
    expect(
      summarizePayload({
        type: "xstate.done.actor.0.writeEssay",
        actorId: "writeEssay",
        sessionId: "0omzt8x9",
        parentSessionId: "0omzt8x0",
      }),
    ).toBe("");
  });

  it("hoists an actor's output so the step reads as work, not a wrapper", () => {
    expect(
      summarizePayload({
        type: "xstate.done.actor.0.critiqueEssay",
        actorId: "critiqueEssay",
        output: { score: 6, verdict: "revise" },
      }),
    ).toBe("score: 6, verdict: revise");
  });

  it("previews a long text output instead of printing it into the thread", () => {
    const summary = summarizePayload({
      type: "xstate.done.actor.0.writeEssay",
      output: `A carbon tax is generally better than cap-and-trade at cutting emissions
        because it gives businesses a clear, stable price signal.`,
    });

    expect(summary).toBe("A carbon tax is generally better than cap-and-t…");
    expect(summary).not.toContain("\n");
  });

  it("keeps a model event's own fields, which are the decision itself", () => {
    expect(summarizePayload({ type: "REFUND", amount: 184, reason: "damaged" })).toBe(
      "amount: 184, reason: damaged",
    );
  });

  it("summarizes collections by size rather than listing them", () => {
    expect(summarizePayload({ type: "FOUND", sources: ["a", "b", "c"] })).toBe("sources: 3 items");
  });

  it("reports a failure's message", () => {
    expect(
      summarizePayload({ type: "xstate.error.actor.0.draft", error: new Error("rate limited") }),
    ).toBe("rate limited");
  });

  it("caps a wide event so one step cannot bury the log", () => {
    const summary = summarizePayload({ type: "WIDE", a: 1, b: 2, c: 3, d: 4, e: 5 });

    expect(summary).toBe("a: 1, b: 2, c: 3");
  });
});

describe("transition labels", () => {
  it("names the actor, without the system index an anonymous invoke carries", () => {
    const [step] = traceSteps([
      {
        event: { type: "xstate.done.actor.0.reflection.drafting", actorId: "0.reflection.drafting" },
        value: "evaluating",
        context: {},
        at: 0,
      },
    ]);

    expect(step?.label).toBe("reflection.drafting");
  });

  it("leaves a named invoke's id alone", () => {
    const [step] = traceSteps([
      {
        event: { type: "xstate.done.actor.0.writeEssay", actorId: "writeEssay" },
        value: "critiquing",
        context: {},
        at: 0,
      },
    ]);

    expect(step?.label).toBe("writeEssay");
  });
});

describe("trace steps", () => {
  it("summarizes both the server trace and the live inspection stream alike", () => {
    const event = { type: "xstate.done.actor.0.plan", actorId: "plan", output: { steps: 2 } };

    const [fromTrace] = traceSteps([{ event, value: "acting", context: {}, at: 120 }]);
    const live = liveTraceStep(event, "acting", 120);

    expect(fromTrace).toEqual({
      label: "plan",
      state: "acting",
      payload: "steps: 2",
      kind: "done",
      at: 120,
    });
    expect(live).toEqual(fromTrace);
  });
});
