# A policy machine

A policy answers one decision of the environment. It is a `setupAgent` machine, so `describeMachine`, traces, and evals work on it, and `improve-machine` can change it one diff at a time.

- **Input:** the facts it reads and the options the environment offered. **Output:** one event, from a final state.
- **It proposes; the environment disposes.** The environment's guards still judge whatever the policy returns, so the policy needs no copy of the rules to be safe. It may read the exported guard functions to decide well.
- **Declare `version`** and bump it on every change.

## What the environment exports

The event schemas and the facts schema, so the policy reuses them instead of redeclaring them. The `agent.decide` input passes the facts as `metadata: { facts }`.

```ts
// In the environment file (exported there):
export const factsSchema = z.object({
  order: z.object({ orderId: z.string(), amount: z.number(), refunded: z.boolean() }).nullable(),
  requestedAmount: z.number().nullable(),
});
export const deskEvents = {
  REFUND: z.object({ amount: z.number() }),
  ESCALATE: z.object({}),
  CLOSE: z.object({}),
};
```

## The policy

```ts
import { z } from "zod";
import { runAgent, setupAgent, type AgentDecisionExecutor, type AgentRequestExecutors } from "@statelyai/agent";
import { deskEvents, factsSchema } from "./desk.js";

/** One proposal: an environment event with its `type`. */
const proposalSchema = z.discriminatedUnion("type", [
  deskEvents.REFUND.extend({ type: z.literal("REFUND") }),
  deskEvents.ESCALATE.extend({ type: z.literal("ESCALATE") }),
  deskEvents.CLOSE.extend({ type: z.literal("CLOSE") }),
]);
type Proposal = z.infer<typeof proposalSchema>;

const policySetup = setupAgent({
  input: z.object({ facts: factsSchema, options: z.array(proposalSchema) }),
  context: z.object({
    facts: factsSchema,
    options: z.array(proposalSchema),
    chosen: proposalSchema.nullable(),
  }),
  output: proposalSchema,
  events: deskEvents,
});

/** The offered options of one type, as `payloads` entries (`type` removed). */
const payloadsOf = (options: readonly Proposal[], type: Proposal["type"]) =>
  options.filter((option) => option.type === type).map(({ type: _type, ...payload }) => payload);

const offers = (options: readonly Proposal[], type: Proposal["type"]) =>
  options.some((option) => option.type === type);

export const policyMachine = policySetup.createMachine({
  id: "resolution-policy",
  version: "1",
  description: "Pick one offered resolution per ticket. Success: the desk's outcome matches the expected outcome.",
  context: ({ input }) => ({ ...input, chosen: null }),
  initial: "checking",
  states: {
    // A rule ported from the old code: an already-refunded order closes, no model call.
    checking: {
      type: "choice",
      choice: ({ context }) =>
        context.facts.order?.refunded && offers(context.options, "CLOSE")
          ? { target: "chosen", context: { chosen: { type: "CLOSE" as const } } }
          : { target: "asking" },
    },
    asking: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "decider",
          name: "pickResolution",
          prompt: `Facts: ${JSON.stringify(context.facts)}`,
          allowedEvents: ["REFUND", "ESCALATE", "CLOSE"],
          // Only what the environment offered; `[]` withholds a type.
          payloads: {
            REFUND: payloadsOf(context.options, "REFUND"),
            ESCALATE: payloadsOf(context.options, "ESCALATE"),
            CLOSE: payloadsOf(context.options, "CLOSE"),
          },
        }),
        onError: { target: "gaveUp" },
      },
      on: {
        REFUND: ({ event }) => ({
          target: "chosen",
          context: { chosen: { type: "REFUND" as const, amount: event.amount } },
        }),
        ESCALATE: { target: "chosen", context: { chosen: { type: "ESCALATE" as const } } },
        CLOSE: { target: "chosen", context: { chosen: { type: "CLOSE" as const } } },
      },
    },
    chosen: { type: "final", output: ({ context }) => context.chosen! },
    gaveUp: { type: "final", output: { type: "ESCALATE" as const } },
  },
});

/** Runs the policy as the environment's decider. */
export function policyDecider(executors: AgentRequestExecutors): AgentDecisionExecutor {
  return async (request, info) => {
    const result = await runAgent(policyMachine, {
      input: {
        facts: factsSchema.parse(request.metadata?.facts),
        options: (request.options ?? []).map((option) => proposalSchema.parse(option.event)),
      },
      executors,
      signal: info?.signal,
    });
    if (result.status !== "done") throw new Error(`policy settled '${result.status}'`);
    return { event: result.output };
  };
}
```

- Every state that invokes `agent.decide` needs an `onError`, or `lintAgentMachine` warns. A policy that cannot choose falls back to the safest event the environment always accepts (here `ESCALATE`).
- A rule the policy applies without a model is a `choice` state over the facts, checked against what was offered (`offers`), since the environment may have withheld it.

## Running it as the environment's decider

```ts
/** The model's executors, with the policy answering the environment's `chooseResolution`. */
export function withPolicy(modelExecutors: AgentRequestExecutors): AgentRequestExecutors {
  const decideWithPolicy = policyDecider(modelExecutors);
  return {
    ...modelExecutors,
    decide: (request, info) => {
      if (request.name === "chooseResolution") return decideWithPolicy(request, info);
      if (!modelExecutors.decide) throw new Error("no decide executor");
      return modelExecutors.decide(request, info);
    },
  };
}
```

Pass `withPolicy(modelExecutors)` as the environment's `executors`. Decisions with any other name still reach the model.
