import { describe, expect, test } from "vitest";
import { z } from "zod";
import { getDecisionRequests } from "./decision-requests.js";
import type { AgentDecisionExecutor } from "./decision.js";
import { runAgent, serializeTraceEvent, type AgentTraceEvent } from "./run-agent.js";
import { setupAgent } from "./setup-agent.js";

const desk = setupAgent({
  context: z.object({ requested: z.number() }),
  input: z.object({ requested: z.number() }),
  events: { REFUND: z.object({ amount: z.number() }), ESCALATE: z.object({}), NOTE: z.object({}) },
}).createMachine({
  context: ({ input }) => input,
  initial: "triaging",
  states: {
    triaging: {
      invoke: {
        src: "agent.decide",
        input: { model: "m", name: "triage", allowedEvents: ["NOTE"] },
      },
      on: { NOTE: { target: "deciding" } },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "m",
          name: "chooseResolution",
          allowedEvents: ["REFUND", "ESCALATE"],
          payloads: { REFUND: [{ amount: context.requested }, { amount: 1000 }] },
          metadata: { facts: { requested: context.requested } },
        }),
      },
      on: {
        REFUND: ({ context, event }) =>
          event.amount <= context.requested ? { target: "refunded" } : undefined,
        ESCALATE: { target: "escalated" },
      },
    },
    refunded: { type: "final" },
    escalated: { type: "final" },
  },
});

/** Notes, then proposes an illegal refund once before the legal one, so the decision is retried. */
const decide: AgentDecisionExecutor = async (request) => {
  if (request.name === "triage") return { event: { type: "NOTE" } };
  return {
    event:
      request.attempts.length === 0 ? { type: "REFUND", amount: 999 } : request.options![0]!.event,
  };
};

async function traceOf() {
  const trace: AgentTraceEvent[] = [];
  const result = await runAgent(desk, {
    input: { requested: 40 },
    executors: { decide },
    onTrace: (event) => trace.push(event),
  });
  expect(result.snapshot.value).toBe("refunded");
  return trace;
}

describe("getDecisionRequests", () => {
  test("lists each decision once, on its first attempt, with the state it was asked in", async () => {
    const requests = getDecisionRequests(await traceOf());

    expect(requests.map((r) => [r.states, r.request.name, r.request.attempts.length])).toEqual([
      [["triaging"], "triage", 0],
      [["deciding"], "chooseResolution", 0],
    ]);
  });

  test("reads a serialized trace, keeping the offered options and the facts", async () => {
    const serialized = JSON.parse(
      JSON.stringify((await traceOf()).map((e) => serializeTraceEvent(e))),
    );
    const [row] = getDecisionRequests(serialized, { name: "chooseResolution" });

    expect(row?.states).toEqual(["deciding"]);
    expect(row?.request).toMatchObject({
      name: "chooseResolution",
      metadata: { facts: { requested: 40 } },
      options: [{ event: { type: "REFUND", amount: 40 } }, { event: { type: "ESCALATE" } }],
    });
    // The guard-refused option is on the request as `withheld`, not `options`.
    expect(row?.request.withheld).toEqual([{ type: "REFUND", amount: 1000 }]);
  });
});
