import { describe, expect, test } from "vitest";
import { createActor, createMachine } from "xstate";
import { runStateRequestPass, type StateRequestPassDeps } from "./internal/state-request-pass.js";
import type { AgentMessage, ChosenEvent } from "./types.js";

// ─── Unit tests for the getRequests execution core ───
//
// The pass runs against a BARE actor here: no runAgent, no idle detection,
// no settle machinery. This is the seam that makes ordering, isolation, and
// advancement independently testable.

function createHarness(machine: Parameters<typeof createActor>[0]) {
  const actor = createActor(machine).start();
  const messages: AgentMessage[] = [];
  const sentEvents: ChosenEvent[] = [];
  let requestSeq = 0;
  let settled = false;

  const deps: StateRequestPassDeps = {
    getSnapshot: () => actor.getSnapshot(),
    send: (event) => {
      sentEvents.push(event);
      actor.send(event as never);
    },
    isSettled: () => settled,
    messages,
    appendToLog: (...items) => messages.push(...items),
    consumeModelCall: () => {},
    nextRequestId: () => `req_${++requestSeq}`,
  };

  return {
    actor,
    messages,
    sentEvents,
    deps,
    settle: () => {
      settled = true;
    },
  };
}

const stepMachine = createMachine({
  id: "steps",
  initial: "a",
  states: {
    a: { on: { A_DONE: { target: "b" } } },
    b: { on: { B_DONE: { target: "complete" } } },
    complete: { type: "final" },
  },
});

describe("runStateRequestPass", () => {
  test("text phase is concurrent and isolated; advance phase follows request order", async () => {
    const parallelMachine = createMachine({
      id: "par",
      type: "parallel",
      states: {
        style: {
          initial: "checking",
          states: {
            checking: { on: { STYLE_DONE: { target: "done" } } },
            done: { type: "final" },
          },
        },
        facts: {
          initial: "checking",
          states: {
            checking: { on: { FACTS_DONE: { target: "done" } } },
            done: { type: "final" },
          },
        },
      },
    });

    const harness = createHarness(parallelMachine);
    const seen: Array<{ prompt: string; historyLength: number }> = [];

    const { sentAny } = await runStateRequestPass(
      [
        { model: "m", prompt: "style?", onDone: { type: "STYLE_DONE" } },
        { model: "m", prompt: "facts?", onDone: { type: "FACTS_DONE" } },
      ],
      {
        ...harness.deps,
        generateText: async (request) => {
          const prompt = String(request.messages?.at(-1)?.content);
          seen.push({ prompt, historyLength: request.messages?.length ?? 0 });
          // First request resolves LAST — order must not depend on latency.
          await new Promise((resolve) => setTimeout(resolve, prompt === "style?" ? 20 : 1));
          return { output: `${prompt} ok` };
        },
      },
    );

    expect(sentAny).toBe(true);
    // Isolation: each text call saw only pass-start history + its own prompt.
    expect(seen.map((call) => call.historyLength)).toEqual([1, 1]);
    // Log and sends follow request order, not completion order.
    expect(harness.messages.map((message) => message.content)).toEqual([
      "style?",
      "style? ok",
      "facts?",
      "facts? ok",
    ]);
    expect(harness.sentEvents.map((event) => event.type)).toEqual(["STYLE_DONE", "FACTS_DONE"]);
  });

  test("onDone function computes the event (payload included) from the output", async () => {
    const harness = createHarness(stepMachine);

    const { sentAny } = await runStateRequestPass(
      [
        {
          model: "m",
          prompt: "do a",
          onDone: ({ output }) => ({ type: "A_DONE", result: output }),
        },
      ],
      { ...harness.deps, generateText: async () => ({ output: "made a thing" }) },
    );

    expect(sentAny).toBe(true);
    expect(harness.sentEvents).toEqual([{ type: "A_DONE", result: "made a thing" }]);
    expect(harness.actor.getSnapshot().value).toBe("b");
  });

  test("decide fallback sees earlier blocks and appends the chosen-event marker", async () => {
    const harness = createHarness(stepMachine);
    const decideHistories: string[][] = [];

    const { sentAny } = await runStateRequestPass(
      [{ model: "m", prompt: "which way?", kind: "decision" }],
      {
        ...harness.deps,
        decide: async (request) => {
          decideHistories.push((request.messages ?? []).map((message) => String(message.content)));
          expect(request.events.map((descriptor) => descriptor.type)).toEqual(["A_DONE"]);
          return { event: { type: "A_DONE" } };
        },
      },
    );

    expect(sentAny).toBe(true);
    expect(decideHistories).toEqual([["which way?"]]);
    expect(harness.messages.map((message) => message.content)).toEqual([
      "which way?",
      "[chose: A_DONE]",
    ]);
  });

  test("a pass that sends nothing reports sentAny: false", async () => {
    const harness = createHarness(stepMachine);

    const { sentAny } = await runStateRequestPass(
      [{ model: "m", prompt: "do a", onDone: () => undefined }],
      { ...harness.deps, generateText: async () => ({ output: "ok" }) },
    );

    expect(sentAny).toBe(false);
    expect(harness.sentEvents).toEqual([]);
    // The work is still preserved in the log.
    expect(harness.messages.map((message) => message.content)).toEqual(["do a", "ok"]);
  });

  test("settling mid-pass stops remaining appends and sends", async () => {
    const harness = createHarness(stepMachine);

    const { sentAny } = await runStateRequestPass(
      [
        { model: "m", prompt: "first", onDone: { type: "A_DONE" } },
        { model: "m", prompt: "second", onDone: { type: "B_DONE" } },
      ],
      {
        ...harness.deps,
        send: (event) => {
          harness.deps.send(event);
          harness.settle(); // the first send ends the run
        },
        generateText: async () => ({ output: "ok" }),
      },
    );

    expect(sentAny).toBe(true);
    expect(harness.sentEvents.map((event) => event.type)).toEqual(["A_DONE"]);
    // The second request's block was never appended.
    expect(harness.messages.map((message) => message.content)).toEqual(["first", "ok"]);
  });

  test("executor errors reject the pass (the host maps them to its error settle)", async () => {
    const harness = createHarness(stepMachine);

    await expect(
      runStateRequestPass([{ model: "m", prompt: "boom" }], {
        ...harness.deps,
        generateText: async () => {
          throw new Error("provider down");
        },
      }),
    ).rejects.toThrow("provider down");
  });
});
