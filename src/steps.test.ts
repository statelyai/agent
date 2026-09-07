import { describe, expect, test } from "vitest";
import { createActor } from "xstate";
import { z } from "zod";
import { setupAgent } from "./index.js";
import { getPendingInvokes, initialAgentStep } from "./steps.js";

function createJokeMachine() {
  const agent = setupAgent({
    context: z.object({ topic: z.string() }),
    input: z.object({ topic: z.string() }),
    requests: {
      joke: {
        schemas: { input: z.object({ topic: z.string() }), output: z.string() },
        model: "quick",
        prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
      },
    },
  });
  return agent.createMachine({
    context: ({ input }) => input,
    initial: "telling",
    states: {
      telling: {
        invoke: {
          id: "joke",
          src: "joke",
          input: ({ context }) => ({ topic: context.topic }),
          onDone: { target: "told" },
        },
      },
      told: { type: "final" },
    },
  });
}

/**
 * `getPendingInvokes` re-derives a pending request from the snapshot's live
 * children rather than the last transition's actions, so it reads three things
 * off the child actor: `src`, `logic`, and — for the invoke input the request
 * builder needs — `getSnapshot().input`, the typed `input` field of XState's
 * `AsyncSnapshot`.
 *
 * If an XState bump breaks THIS suite, that is the contract that moved: the
 * fields below are the ones `getPendingInvokes` depends on, and a lost `input`
 * silently re-derives requests with `undefined` input (schema validation fails,
 * or worse, a prompt renders "undefined"). Fix `getPendingInvokes` before
 * relaxing these assertions.
 */
describe("getPendingInvokes — xstate child-actor compatibility", () => {
  test("reads src, logic, and the resolved input off a pending child", () => {
    const step = initialAgentStep(createJokeMachine(), { topic: "cats" });

    expect(getPendingInvokes(step.snapshot)).toEqual([
      expect.objectContaining({
        type: "@xstate.spawn",
        id: "joke",
        src: "joke",
        input: { topic: "cats" },
        logic: expect.objectContaining({ kind: "statelyai.textLogic" }),
      }),
    ]);
  });

  test("the re-derived request carries the resolved input, not undefined", () => {
    const step = initialAgentStep(createJokeMachine(), { topic: "cats" });

    expect(step.requests).toEqual([
      expect.objectContaining({
        kind: "text",
        id: "joke",
        src: "joke",
        input: expect.objectContaining({
          name: "joke",
          input: { topic: "cats" },
          prompt: "Tell a joke about cats.",
        }),
      }),
    ]);
  });

  test("the resolved input survives a persist/restore round trip", () => {
    const machine = createJokeMachine();
    const actor = createActor(machine, { input: { topic: "cats" } }).start();
    const persisted = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
    actor.stop();

    const restored = createActor(machine, { snapshot: persisted }).start();
    const pending = getPendingInvokes(restored.getSnapshot());
    restored.stop();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.input).toEqual({ topic: "cats" });
  });
});
