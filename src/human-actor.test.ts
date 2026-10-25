import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, createMachine } from "xstate";
import { decideNext } from "./decide-next.js";
import type { AgentDecisionExecutor, AgentDecisionRequest } from "./decision.js";
import { describeMachine } from "./describe-machine.js";
import { getAcceptedEvents } from "./events.js";
import { interactionMetaSchema } from "./interaction.js";
import { runAgent } from "./run-agent.js";
import { createAgentSchemas, setupAgent } from "./setup-agent.js";
import { explorePaths, lintAgentMachine } from "./verify.js";

const schemas = createAgentSchemas({
  context: z.object({}),
  input: z.object({}),
  events: { approve: z.object({}), revise: z.object({}), cancel: z.object({}) },
});

// A person approves; the model may only ask for a revision.
const review = setupAgent({ schemas }).createMachine({
  context: {},
  initial: "reviewing",
  on: { cancel: { target: ".cancelled", meta: { actor: "human" } } },
  states: {
    reviewing: {
      invoke: {
        src: "agent.decide",
        input: { model: "quick", allowedEvents: ["revise", "approve"], maxRetries: 1 },
        onError: { target: "failed" },
      },
      on: {
        approve: { target: "approved", meta: { actor: "human" } },
        revise: { target: "revised" },
      },
    },
    approved: { type: "final" },
    revised: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});

function recording(choose: (request: AgentDecisionRequest) => { type: string }) {
  const requests: AgentDecisionRequest[] = [];
  const decide: AgentDecisionExecutor = async (request) => {
    requests.push(request);
    return { event: choose(request) };
  };
  return { decide, requests };
}

describe('transition meta `actor: "human"`', () => {
  test("getAcceptedEvents with `actor: 'agent'` drops human-tagged events", () => {
    const snapshot = createActor(review, { input: {} }).getSnapshot();
    const types = (actor?: "agent") =>
      getAcceptedEvents(snapshot, actor ? { actor } : {}).map((event) => event.type);

    expect(types().sort()).toEqual(["approve", "cancel", "revise"]);
    expect(types("agent")).toEqual(["revise"]);
  });

  test("agent.decide never offers a human-tagged event", async () => {
    const { decide, requests } = recording(() => ({ type: "approve" }));
    const result = await runAgent(review, { executors: { decide }, input: {} });

    expect(requests[0]!.events.map((event) => event.type)).toEqual(["revise"]);
    // Choosing it anyway is retried, then the decision fails to onError.
    expect(requests).toHaveLength(2);
    expect(result.snapshot.value).toBe("failed");
  });

  test("a closed choice withholds the human-tagged options", async () => {
    const closed = setupAgent({ schemas }).createMachine({
      context: {},
      initial: "reviewing",
      states: {
        reviewing: {
          invoke: {
            src: "agent.decide",
            input: {
              model: "quick",
              allowedEvents: ["revise", "approve"],
              payloads: { revise: [{}], approve: [{}] },
            },
          },
          on: {
            approve: { target: "approved", meta: { actor: "human" } },
            revise: { target: "revised" },
          },
        },
        approved: { type: "final" },
        revised: { type: "final" },
      },
    });
    const { decide, requests } = recording((request) => request.options![0]!.event);
    const result = await runAgent(closed, { executors: { decide }, input: {} });

    expect(requests[0]!.options!.map((option) => option.event)).toEqual([{ type: "revise" }]);
    expect(requests[0]!.withheld).toEqual([{ type: "approve" }]);
    expect(result.snapshot.value).toBe("revised");
  });

  test("decideNext withholds a human-tagged event on a plain machine", async () => {
    const plain = createMachine({
      schemas: { meta: interactionMetaSchema },
      context: {},
      initial: "reviewing",
      states: {
        reviewing: {
          on: {
            approve: { target: "approved", meta: { actor: "human" } },
            revise: { target: "revised" },
          },
        },
        approved: {},
        revised: {},
      },
    });
    const { decide, requests } = recording((request) => request.options![0]!.event);

    const result = await decideNext(createActor(plain).getSnapshot(), {
      decide,
      model: "quick",
      allowedEvents: "*",
    });

    expect(requests[0]!.options!.map((option) => option.event)).toEqual([{ type: "revise" }]);
    expect(result.withheld).toEqual([{ type: "approve" }]);
    expect(result.event).toEqual({ type: "revise" });
  });

  test("describeMachine marks human-tagged transitions", () => {
    const text = describeMachine(review);
    expect(text).toContain("on cancel (human) → cancelled");
    expect(text).toContain("on approve (human) → approved");
    expect(text).toContain("on revise → revised");
  });

  test("lint: a decision that lists a human-tagged event is an error", () => {
    expect(lintAgentMachine(review)).toContainEqual(
      expect.objectContaining({
        code: "decide-allows-human-event",
        severity: "error",
        path: "reviewing",
      }),
    );
    expect(
      lintAgentMachine(review).filter((d) => d.code === "decide-allows-human-event"),
    ).toHaveLength(1);
  });

  test("lint reads a single-string `allowedEvents` too", () => {
    const single = setupAgent({ schemas }).createMachine({
      context: {},
      initial: "reviewing",
      states: {
        reviewing: {
          invoke: { src: "agent.decide", input: { model: "quick", allowedEvents: "approve" } },
          on: { approve: { target: "approved", meta: { actor: "human" } } },
        },
        approved: { type: "final" },
      },
    });
    expect(lintAgentMachine(single).map((d) => d.code)).toContain("decide-allows-human-event");
  });

  test("explorePaths branches a decision only on events a model may choose", async () => {
    const report = await explorePaths(review, { input: {} });
    expect(report.terminals.map((terminal) => terminal.state)).toEqual(["revised"]);
  });

  test("the meta schema accepts only `actor: 'human'`", () => {
    const validate = (value: unknown) => interactionMetaSchema["~standard"].validate(value);
    expect(validate({ actor: "human" })).toEqual({ value: { actor: "human" } });
    expect(validate({ actor: "model" })).toHaveProperty("issues");
  });
});
