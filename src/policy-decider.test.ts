import { describe, expect, test } from "vitest";
import { createMachine } from "xstate";
import { z } from "zod";
import type { AgentDecisionExecutor, AgentExecutorDecisionRequest } from "./decision.js";
import { createInMemoryEventLogStore } from "./event-log-store.js";
import { createPolicyDecider } from "./policy-decider.js";
import { runAgent } from "./run-agent.js";
import { setupAgent } from "./setup-agent.js";

const proposal = z.discriminatedUnion("type", [
  z.object({ type: z.literal("REFUND"), amount: z.number() }),
  z.object({ type: z.literal("ESCALATE") }),
]);
// `coupon` is optional: a present key holding undefined survives the schema.
const facts = z.object({ requested: z.number(), coupon: z.string().optional() });

// The environment: one closed-choice decision, facts passed as metadata.
const desk = setupAgent({
  context: z.object({ requested: z.number() }),
  input: z.object({ requested: z.number() }),
  events: { REFUND: z.object({ amount: z.number() }), ESCALATE: z.object({}) },
}).createMachine({
  context: ({ input }) => input,
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "decider",
          name: "chooseResolution",
          system: "Desk rules.",
          prompt: `Asked: ${context.requested}`,
          allowedEvents: ["REFUND", "ESCALATE"],
          payloads: { REFUND: [{ amount: context.requested }] },
          metadata: { facts: { requested: context.requested } },
        }),
      },
      on: {
        REFUND: ({ event }) => (event.amount <= 500 ? { target: "refunded" } : undefined),
        ESCALATE: { target: "escalated" },
      },
    },
    refunded: { type: "final" },
    escalated: { type: "final" },
  },
});

// The policy: refund small amounts with no model call; otherwise ask the model.
const policy = setupAgent({
  input: z.object({
    facts,
    options: z.array(proposal),
    system: z.string().optional(),
    prompt: z.string().optional(),
  }),
  context: z.object({
    facts,
    options: z.array(proposal),
    system: z.string().optional(),
    prompt: z.string().optional(),
    chosen: proposal.nullable(),
  }),
  output: proposal,
  events: { REFUND: z.object({ amount: z.number() }), ESCALATE: z.object({}) },
}).createMachine({
  version: "1",
  context: ({ input }) => ({ ...input, chosen: null }),
  initial: "checking",
  states: {
    checking: {
      type: "choice",
      choice: ({ context }) => {
        const refund = context.options.find((o) => o.type === "REFUND");
        return refund && context.facts.requested <= 100
          ? { target: "chosen", context: { chosen: refund } }
          : { target: "asking" };
      },
    },
    asking: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "decider",
          name: "pickResolution",
          system: context.system,
          prompt: context.prompt ?? "",
          allowedEvents: ["REFUND", "ESCALATE"],
          payloads: {
            REFUND: context.options.flatMap((o) =>
              o.type === "REFUND" ? [{ amount: o.amount }] : [],
            ),
          },
          metadata: { facts: context.facts },
        }),
        onError: { target: "gaveUp" },
      },
      on: {
        REFUND: ({ event }) => ({
          target: "chosen",
          context: { chosen: { type: "REFUND" as const, amount: event.amount } },
        }),
        ESCALATE: { target: "chosen", context: { chosen: { type: "ESCALATE" as const } } },
      },
    },
    chosen: { type: "final", output: ({ context }) => context.chosen! },
    gaveUp: { type: "final", output: { type: "ESCALATE" as const } },
  },
});

/** A model decider that records what it was asked and answers `answer`. */
function model(answer: "first" | "ESCALATE", usage = { totalTokens: 7 }) {
  const seen: AgentExecutorDecisionRequest[] = [];
  const decide: AgentDecisionExecutor = async (request) => {
    seen.push(request);
    const event = answer === "first" ? request.options![0]!.event : { type: "ESCALATE" };
    return { event, usage };
  };
  return { decide, seen };
}

describe("createPolicyDecider", () => {
  test("answers with a rule and no model call when the policy can decide alone", async () => {
    const inner = model("ESCALATE");
    const result = await runAgent(desk, {
      input: { requested: 40 },
      executors: { decide: createPolicyDecider(policy, { executors: { decide: inner.decide } }) },
    });

    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("refunded");
    expect(inner.seen).toEqual([]);
  });

  test("passes the request's facts, options, system, and prompt to the policy, and on to the model", async () => {
    const inner = model("first");
    const result = await runAgent(desk, {
      input: { requested: 240 },
      executors: { decide: createPolicyDecider(policy, { executors: { decide: inner.decide } }) },
    });

    expect(result.snapshot.value).toBe("refunded");
    expect(inner.seen).toHaveLength(1);
    expect(inner.seen[0]).toMatchObject({
      name: "pickResolution",
      system: "Desk rules.",
      prompt: "Asked: 240",
      metadata: { facts: { requested: 240 } },
      options: [{ event: { type: "REFUND", amount: 240 } }, { event: { type: "ESCALATE" } }],
    });
  });

  test("reports the policy's token usage, and none when it made no model call", async () => {
    const decide = createPolicyDecider(policy, {
      executors: { decide: model("first", { totalTokens: 12 }).decide },
    });
    const request = (requested: number) =>
      ({
        kind: "decision",
        id: "d",
        name: "chooseResolution",
        model: "decider",
        events: [{ type: "REFUND" }, { type: "ESCALATE" }],
        options: [
          { event: { type: "REFUND", amount: requested } },
          { event: { type: "ESCALATE" } },
        ],
        attempts: [],
        metadata: { facts: { requested } },
      }) as unknown as AgentExecutorDecisionRequest;

    expect(await decide(request(240))).toEqual({
      event: { type: "REFUND", amount: 240 },
      usage: { totalTokens: 12 },
    });
    expect(await decide(request(40))).toEqual({ event: { type: "REFUND", amount: 40 } });
  });

  test("builds the policy's input with `input` when the default shape does not fit", async () => {
    const seenInput: unknown[] = [];
    const decide = createPolicyDecider(policy, {
      executors: { decide: model("first").decide },
      input: (request) => {
        const input = {
          facts: { requested: Number((request.metadata as { amount: number }).amount) },
          options: (request.options ?? []).map((o) => proposal.parse(o.event)),
        };
        seenInput.push(input);
        return input;
      },
    });

    const result = await decide({
      kind: "decision",
      id: "d",
      name: "x",
      model: "decider",
      events: [{ type: "REFUND" }],
      options: [{ event: { type: "REFUND", amount: 30 } }],
      attempts: [],
      metadata: { amount: 30 },
    } as unknown as AgentExecutorDecisionRequest);

    expect(result.event).toEqual({ type: "REFUND", amount: 30 });
    expect(seenInput).toEqual([
      { facts: { requested: 30 }, options: [{ type: "REFUND", amount: 30 }] },
    ]);
  });

  const decisionRequest = (facts: Record<string, unknown>, requested = facts.requested as number) =>
    ({
      kind: "decision",
      id: "d",
      name: "chooseResolution",
      model: "decider",
      events: [{ type: "REFUND" }, { type: "ESCALATE" }],
      options: [{ event: { type: "REFUND", amount: requested } }, { event: { type: "ESCALATE" } }],
      attempts: [],
      metadata: { facts },
    }) as unknown as AgentExecutorDecisionRequest;

  test("gives every decision its own policy thread, so a store never replays an earlier choice", async () => {
    const store = createInMemoryEventLogStore();
    const decide = createPolicyDecider(policy, {
      executors: { decide: model("ESCALATE").decide },
      store,
    });

    const first = await decide(decisionRequest({ requested: 240 }), { callKey: "exec:site#0" });
    const second = await decide(decisionRequest({ requested: 40 }), { callKey: "exec:site#1" });

    expect(first.event).toEqual({ type: "ESCALATE" });
    expect(second.event).toEqual({ type: "REFUND", amount: 40 });
    const { threadIds } = await store.listThreads!({ prefix: "policy:" });
    expect(threadIds.map((thread) => thread.replace(/:[^:]+$/, "")).sort()).toEqual([
      "policy:exec:site#0",
      "policy:exec:site#1",
    ]);
  });

  test("a different request at the same call key gets its own thread; the same one resumes", async () => {
    const store = createInMemoryEventLogStore();
    const decide = createPolicyDecider(policy, {
      executors: { decide: model("ESCALATE").decide },
      store,
    });

    // A fork inherits the parent's call key but asks with other facts.
    const parent = await decide(decisionRequest({ requested: 240 }), { callKey: "exec:site#0" });
    const fork = await decide(decisionRequest({ requested: 40 }), { callKey: "exec:site#0" });
    const reissued = await decide(decisionRequest({ requested: 40 }), { callKey: "exec:site#0" });

    expect(parent.event).toEqual({ type: "ESCALATE" });
    expect(fork.event).toEqual({ type: "REFUND", amount: 40 });
    expect(reissued.event).toEqual({ type: "REFUND", amount: 40 });
    const { threadIds } = await store.listThreads!({ prefix: "policy:" });
    expect(threadIds).toHaveLength(2);
    expect(threadIds[0]).toMatch(/^policy:exec:site#0:[0-9a-f]{64}$/);
  });

  test("takes the policy thread from `threadId`, and needs one when a store has no call key to go on", async () => {
    const store = createInMemoryEventLogStore();
    const decide = createPolicyDecider(policy, {
      executors: { decide: model("ESCALATE").decide },
      store,
      threadId: (request) =>
        `policy:${String((request.metadata as { facts: { requested: number } }).facts.requested)}`,
    });
    await decide(decisionRequest({ requested: 240 }));
    expect((await store.listThreads!({ prefix: "policy:" })).threadIds).toEqual(["policy:240"]);

    const without = createPolicyDecider(policy, {
      executors: { decide: model("ESCALATE").decide },
      store,
    });
    await expect(without(decisionRequest({ requested: 240 }))).rejects.toThrow(/threadId/);
  });

  test("drops undefined keys nested in the default input, so the policy's log and usage survive", async () => {
    const decide = createPolicyDecider(policy, {
      executors: { decide: model("first", { totalTokens: 12 }).decide },
    });

    const result = await decide(decisionRequest({ requested: 240, coupon: undefined }));

    expect(result).toEqual({ event: { type: "REFUND", amount: 240 }, usage: { totalTokens: 12 } });
  });

  test("rejects a policy input that is not JSON before the policy runs", async () => {
    const inner = model("first");
    const decide = createPolicyDecider(policy, {
      executors: { decide: inner.decide },
      input: () => ({ facts: { requested: 240, at: new Date() }, options: [] }) as never,
    });

    await expect(decide(decisionRequest({ requested: 240 }))).rejects.toThrow(/at/);
    expect(inner.seen).toEqual([]);
  });

  test("throws when the policy does not finish with an event", async () => {
    // A policy that waits for a person never settles 'done', so it has no event to return.
    const stuck = createMachine({ initial: "waiting", states: { waiting: {} } });
    const decide = createPolicyDecider(stuck, { executors: {} });
    await expect(
      decide({
        kind: "decision",
        id: "d",
        name: "x",
        model: "m",
        events: [],
        attempts: [],
      } as unknown as AgentExecutorDecisionRequest),
    ).rejects.toThrow(/policy .* settled 'idle'/);
  });
});
