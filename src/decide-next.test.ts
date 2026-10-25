import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, createMachine } from "xstate";
import { decideNext } from "./decide-next.js";
import {
  AgentDecisionExhaustedError,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  resolveDecision,
} from "./decision.js";
import { runAgent } from "./run-agent.js";
import { createAgentSchemas, setupAgent } from "./setup-agent.js";

// A plain XState machine: no setupAgent, no agent.* anywhere.
const desk = createMachine({
  id: "desk",
  schemas: {
    context: z.object({ limit: z.number(), refunded: z.number() }),
    events: {
      "desk.refund": z.object({ amount: z.number() }),
      "desk.escalate": z.object({}).describe("Hand the case to a person"),
      reset: z.object({}),
    },
  },
  context: { limit: 50, refunded: 0 },
  initial: "reviewing",
  states: {
    reviewing: {
      on: {
        "desk.refund": {
          description: "Refund the customer",
          to: ({ context, event }) =>
            event.amount <= context.limit
              ? { target: "refunded", context: { ...context, refunded: event.amount } }
              : undefined,
        },
        "desk.escalate": { target: "escalated" },
        reset: { target: "reviewing" },
      },
    },
    refunded: { type: "final" },
    escalated: { type: "final" },
  },
});

const payloads = () => ({ "desk.refund": [{ amount: 20 }, { amount: 80 }] });

function scripted(
  choices: Array<(request: AgentDecisionRequest) => { type: string; [key: string]: unknown }>,
) {
  const requests: AgentDecisionRequest[] = [];
  const decide: AgentDecisionExecutor = async (request) => {
    requests.push(request);
    return { event: choices[Math.min(requests.length - 1, choices.length - 1)]!(request) };
  };
  return { decide, requests };
}

describe("decideNext on a plain machine", () => {
  test("offers only the options the snapshot accepts, matching the event patterns", async () => {
    const snapshot = createActor(desk).start().getSnapshot();
    const { decide, requests } = scripted([(request) => request.options![0]!.event]);

    const result = await decideNext(snapshot, {
      decide,
      model: "quick",
      allowedEvents: "desk.*",
      payloads,
    });

    expect(requests[0]!.options!.map((option) => option.event)).toEqual([
      { amount: 20, type: "desk.refund" },
      { type: "desk.escalate" },
    ]);
    expect(requests[0]!.options!.map((option) => option.description)).toEqual([
      "Refund the customer (amount: 20)",
      "Hand the case to a person",
    ]);
    expect(result.event).toEqual({ amount: 20, type: "desk.refund" });
    expect(result.attempts).toEqual([]);
  });

  test("lookahead describes the target state and the changed context key", async () => {
    const snapshot = createActor(desk).start().getSnapshot();
    const { decide, requests } = scripted([(request) => request.options![0]!.event]);

    await decideNext(snapshot, {
      decide,
      model: "quick",
      allowedEvents: "desk.*",
      payloads,
      lookahead: true,
    });

    const refund = requests[0]!.options![0]!.description!;
    expect(refund).toContain('state: "reviewing" → "refunded"');
    expect(refund).toContain("refunded: 0 → 20");
    expect(requests[0]!.options![1]!.description).toContain('state: "reviewing" → "escalated"');
  });

  test("a lookahead array limits the reported context keys; each value is cut", async () => {
    const machine = createMachine({
      context: { note: "", turn: 0 },
      initial: "idle",
      states: {
        idle: {
          on: {
            GO: ({ context }) => ({
              target: "done",
              context: { note: "x".repeat(200), turn: context.turn + 1 },
            }),
          },
        },
        done: {},
      },
    });
    const snapshot = createActor(machine).start().getSnapshot();
    const effectOf = async (
      lookahead: NonNullable<Parameters<typeof decideNext>[1]["lookahead"]>,
    ) => {
      const { decide, requests } = scripted([(request) => request.options![0]!.event]);
      await decideNext(snapshot, { decide, model: "quick", allowedEvents: "GO", lookahead });
      return requests[0]!.options![0]!.description!;
    };

    const all = await effectOf(true);
    expect(all).toContain("turn: 0 → 1");
    expect(all).toContain(`→ "${"x".repeat(118)}…`);

    const limited = await effectOf(["note"]);
    expect(limited).toBe(`GO. Then: state: "idle" → "done"; note: "" → "${"x".repeat(118)}…`);
  });

  test("withheld lists the candidates the guards blocked", async () => {
    const snapshot = createActor(desk).start().getSnapshot();
    const { decide, requests } = scripted([(request) => request.options![0]!.event]);

    const result = await decideNext(snapshot, {
      decide,
      model: "quick",
      allowedEvents: "desk.*",
      payloads,
    });

    expect(result.withheld).toEqual([{ amount: 80, type: "desk.refund" }]);
    expect(result.request.withheld).toEqual(result.withheld);
    expect(requests[0]!.options!.map((option) => option.event)).not.toContainEqual({
      amount: 80,
      type: "desk.refund",
    });
  });

  test("a type with no payloads key is offered bare; an empty list withholds it", async () => {
    const snapshot = createActor(desk).start().getSnapshot();
    const { decide, requests } = scripted([(request) => request.options![0]!.event]);

    await decideNext(snapshot, {
      decide,
      model: "quick",
      allowedEvents: "desk.*",
      payloads: () => ({ "desk.refund": [] }),
    });

    expect(requests[0]!.options!.map((option) => option.event)).toEqual([
      { type: "desk.escalate" },
    ]);
  });

  test("a choice matching no offered option is retried, then exhausts", async () => {
    const snapshot = createActor(desk).start().getSnapshot();
    const { decide, requests } = scripted([() => ({ type: "desk.refund", amount: 80 })]);

    const error = await decideNext(snapshot, {
      decide,
      model: "quick",
      allowedEvents: "desk.*",
      payloads,
      maxRetries: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentDecisionExhaustedError);
    const attempts = (error as AgentDecisionExhaustedError).attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.failure).toBe("rejected-by-guard");
    expect(attempts[0]!.reason).toContain("matched no offered option");
    expect(requests[1]!.attempts).toHaveLength(1);
  });

  test("reports the failed attempts before a choice lands", async () => {
    const snapshot = createActor(desk).start().getSnapshot();
    const { decide } = scripted([
      () => ({ type: "desk.refund", amount: 80 }),
      () => ({ type: "desk.escalate" }),
    ]);

    const result = await decideNext(snapshot, {
      decide,
      model: "quick",
      allowedEvents: "desk.*",
      payloads,
    });

    expect(result.event).toEqual({ type: "desk.escalate" });
    expect(result.attempts.map((attempt) => attempt.failure)).toEqual(["rejected-by-guard"]);
  });

  test("no options: returns null without calling the executor", async () => {
    const snapshot = createActor(desk).start().getSnapshot();
    const { decide, requests } = scripted([() => ({ type: "desk.escalate" })]);

    const result = await decideNext(snapshot, {
      decide,
      model: "quick",
      allowedEvents: "desk.refund",
      payloads: () => ({ "desk.refund": [{ amount: 80 }] }),
    });

    expect(result.event).toBeNull();
    expect(result.request.options).toEqual([]);
    expect(result.withheld).toEqual([{ amount: 80, type: "desk.refund" }]);
    expect(requests).toHaveLength(0);
  });
});

describe("agent.decide with payloads under the runtime", () => {
  const schemas = createAgentSchemas({
    context: z.object({ limit: z.number(), refunded: z.number() }),
    input: z.object({}),
    events: {
      refund: z.object({ amount: z.number() }),
      escalate: z.object({}),
    },
  });

  const machine = setupAgent({ schemas }).createMachine({
    context: { limit: 50, refunded: 0 },
    initial: "deciding",
    states: {
      deciding: {
        invoke: {
          src: "agent.decide",
          input: {
            model: "quick",
            allowedEvents: ["refund", "escalate"],
            payloads: { refund: [{ amount: 20 }, { amount: 80 }] },
            maxRetries: 1,
          },
          onError: { target: "failed" },
        },
        on: {
          refund: ({ context, event }) =>
            event.amount <= context.limit
              ? { target: "refunded", context: { ...context, refunded: event.amount } }
              : undefined,
          escalate: { target: "escalated" },
        },
      },
      refunded: { type: "final" },
      escalated: { type: "final" },
      failed: { type: "final" },
    },
  });

  test("delivers only accepted options and takes one of them", async () => {
    const { decide, requests } = scripted([(request) => request.options![0]!.event]);
    const result = await runAgent(machine, {
      executors: { generateText: async () => ({ result: {} }), decide },
      input: {},
    });

    expect(requests[0]!.options!.map((option) => option.event)).toEqual([
      { amount: 20, type: "refund" },
      { type: "escalate" },
    ]);
    expect(result.snapshot.value).toBe("refunded");
    expect(result.snapshot.context.refunded).toBe(20);
  });

  test("the request.start trace carries the withheld options", async () => {
    const { decide } = scripted([(request) => request.options![0]!.event]);
    const starts: AgentDecisionRequest[] = [];
    await runAgent(machine, {
      executors: { generateText: async () => ({ result: {} }), decide },
      onTrace: (event) => {
        if (event.type === "request.start" && event.request.kind === "decision") {
          starts.push(event.request);
        }
      },
      input: {},
    });

    expect(starts.map((request) => request.withheld)).toEqual([[{ amount: 80, type: "refund" }]]);
  });

  test("fails to onError without a model call when no offered option is accepted", async () => {
    const noOptions = setupAgent({ schemas }).createMachine({
      context: { limit: 50, refunded: 0 },
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: {
              model: "quick",
              allowedEvents: ["refund", "escalate"],
              // The only refund is over the limit; escalate is withheld.
              payloads: { refund: [{ amount: 80 }], escalate: [] },
            },
            onError: {
              target: "failed",
              context: ({ context, event }) => ({
                ...context,
                error: (event.error as Error).message,
                code: (event.error as { code?: string }).code,
              }),
            },
          },
          on: {
            refund: ({ context, event }) =>
              event.amount <= context.limit ? { target: "refunded" } : undefined,
            escalate: { target: "escalated" },
          },
        },
        refunded: { type: "final" },
        escalated: { type: "final" },
        failed: { type: "final" },
      },
    });
    const { decide, requests } = scripted([(request) => request.options![0]!.event]);
    const traced: string[] = [];
    const starts: AgentDecisionRequest[] = [];
    const result = await runAgent(noOptions, {
      executors: { generateText: async () => ({ result: {} }), decide },
      onTrace: (event) => {
        if (event.type === "request.start" || event.type === "request.error") {
          if (event.request.kind !== "decision") return;
          traced.push(event.type);
          if (event.type === "request.start") starts.push(event.request);
        }
      },
      input: {},
    });

    expect(requests).toHaveLength(0);
    // The blocked options still reach the trace, so foldTraces counts them.
    expect(traced).toEqual(["request.start", "request.error"]);
    expect(starts.map((request) => request.withheld)).toEqual([[{ amount: 80, type: "refund" }]]);
    expect(result.snapshot.value).toBe("failed");
    const context = result.snapshot.context as { code?: string; error?: string };
    expect(context.code).toBe("decision-exhausted");
    expect(context.error).toContain("no offered option");
  });

  test("rejects a choice that matches no offered option", async () => {
    const { decide, requests } = scripted([() => ({ type: "refund", amount: 30 })]);
    const result = await runAgent(machine, {
      executors: { generateText: async () => ({ result: {} }), decide },
      input: {},
    });

    expect(result.snapshot.value).toBe("failed");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.attempts[0]!.reason).toContain("matched no offered option");
  });
});

describe("resolveDecision with an empty closed choice", () => {
  test("fails without calling the executor", async () => {
    let calls = 0;
    const decide: AgentDecisionExecutor = async () => {
      calls += 1;
      return { event: { type: "X" } };
    };
    await expect(
      resolveDecision(
        {
          kind: "decision",
          id: "d",
          model: "m",
          events: [{ type: "X", toolName: "send_event_X" }],
          options: [],
          attempts: [],
        },
        { decide },
      ),
    ).rejects.toBeInstanceOf(AgentDecisionExhaustedError);
    expect(calls).toBe(0);
  });
});
