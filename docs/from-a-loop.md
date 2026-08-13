---
title: Migrating from a hand-rolled loop
description: Convert a while-loop tool-calling agent into an agent machine one step at a time.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page refactors a working `while`-loop agent into an agent machine without rewriting your model calls. Your SDK calls, tools, and retry logic become the [executors](hosts.md). The machine replaces only the control flow.

The call site stays one line. Where you had this:

```ts no-check
const result = await generateText({ model, prompt, tools });
```

you end with this:

```ts
const result = await generateResult(machine, { input, executors });
```

The `generateText` call still exists. It moves into the executors, and the loop you wrote around it becomes the machine. Like `generateText`, the result carries metadata alongside the value: `result.output`, `result.snapshot`, the replayable `result.events`, and the aggregated `result.usage`. `generateResult` throws `AgentIdleError` when the run settles idle instead of done, so use `runAgent` when a pause is an expected outcome.

For the design work behind this refactor, read [Thinking in state machines](thinking-in-state-machines.md). It covers how to find the states in a loop before you write any of them down.

## Starting point: a hand-rolled loop

The starting point is a refund agent written as a `while` loop against an SDK. The model calls tools until it stops, a $100 limit is enforced inline, and a larger refund pauses for a human.

```ts
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

async function runRefundAgent(request: string) {
  const messages: any[] = [{ role: "user", content: request }];
  let refunded = false;

  while (true) {
    const { toolCalls } = await generateText({
      // Model IDs here are illustrative; substitute your provider's current models.
      model: openai("gpt-5.4-mini"),
      messages,
      tools: {
        lookupOrder: tool({ inputSchema: z.object({ id: z.string() }) }),
        issueRefund: tool({ inputSchema: z.object({ amount: z.number() }) }),
        escalate: tool({ inputSchema: z.object({ reason: z.string() }) }),
      },
    });
    if (!toolCalls?.length) return { refunded };

    for (const call of toolCalls) {
      if (call.toolName === "issueRefund") {
        if ((call.input as { amount: number }).amount > 100) return { pending: true }; // loop state is lost here
        refunded = true;
      }
      // push tool result onto messages, continue the loop
    }
  }
}
```

This loop has three problems:

- The $100 rule is an `if` statement that the model can be prompted around.
- Nothing stops `issueRefund` from running before `lookupOrder`.
- The human pause returns `{ pending: true }` and discards the loop's state, so the run cannot resume.

## Step 1: implicit phases as explicit states

The loop has phases: deciding, doing, then finishing or waiting on a human. Name each phase as a state. Declare the schemas and the setup with `setupAgent`.

```ts
import { z } from "zod";
import { setupAgent, runAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

const models = defineModels({ quick: openai("gpt-5.4-mini") });

// The loop's lookupOrder tool becomes an actor the machine invokes.
const lookupOrder = fromPromise(async ({ input }: { input: { orderId: string } }) => {
  return { total: 5000 };
});

const agentSetup = setupAgent({
  models,
  actors: { lookupOrder },
  context: z.object({
    request: z.string(),
    orderId: z.string(),
    order: z.object({ total: z.number() }).nullable(),
    refunded: z.boolean(),
  }),
  input: z.object({ request: z.string(), orderId: z.string() }),
  output: z.object({ refunded: z.boolean() }),
  events: {
    REFUND: z.object({ amount: z.number() }),
    ESCALATE: z.object({ reason: z.string() }),
    APPROVE: {}, // {} is shorthand for a payload-less event
    DENY: {},
  },
});
```

The phases become the states `lookingUp`, `deciding`, `awaitingHuman`, `refunded`, and `denied`.

<!-- viz: refund machine: lookingUp (invokes lookupOrder) -> deciding -> refunded (REFUND, guarded by amount <= 100) / awaitingHuman (ESCALATE) -> refunded (APPROVE) or denied (DENY) -->

## Step 2: tool choice as a guarded decision

In the loop, the tool choice was a model output you validated afterward. Make it a **decision** instead. The model chooses exactly one event that is legal in the current state, and it chooses the refund amount as the event's payload. A guard holds the $100 limit, so a prompt cannot bypass it.

The order lookup is a separate state that runs first. The model cannot reach the decision before the lookup finishes, because `deciding` is only entered from the lookup's `onDone`.

```ts no-check
const machine = agentSetup.createMachine({
  context: ({ input }) => ({ ...input, order: null, refunded: false }),
  initial: "lookingUp",
  states: {
    lookingUp: {
      invoke: {
        src: "lookupOrder",
        input: ({ context }) => ({ orderId: context.orderId }),
        onDone: ({ output }) => ({ target: "deciding", context: { order: output } }),
      },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          system: "Decide whether this refund can be issued directly.",
          prompt: `${context.request} (order total: $${context.order?.total})`,
          allowedEvents: ["REFUND", "ESCALATE"], // an unknown name is a compile error
        }),
      },
      on: {
        // The $100 rule as a guard.
        REFUND: ({ event }) =>
          event.amount <= 100 ? { target: "refunded", context: { refunded: true } } : undefined,
        ESCALATE: { target: "awaitingHuman" },
      },
    },
    // ...
  },
});
```

The model picks the amount, and the guard checks it. A `REFUND` chosen for $5000 no longer takes effect. The transition returns `undefined`, the choice is rejected, and the decision retries with typed feedback. See [transitions](machines.md#transitions).

You write the `system` and `prompt` values. The host executor decides how the model is coerced into picking one event, and you can replace that executor. See [Decisions](decisions.md) and [Coercion](decisions.md#coercion).

## Step 3: the pause as an idle state

The loop's `return { pending: true }` becomes a waiting state with no invoke. `runAgent` settles as `idle` in that state instead of discarding the run. The snapshot is plain JSON, so you can persist it anywhere.

```ts no-check
    // ...
    awaitingHuman: {
      // No invoke: runAgent settles { status: 'idle', snapshot } here.
      on: {
        APPROVE: { target: 'refunded', context: { refunded: true } },
        DENY: { target: 'denied' },
      },
    },
    refunded: { type: 'final', output: () => ({ refunded: true }) },
    denied: { type: 'final', output: () => ({ refunded: false }) },
    // ...
```

## Step 4: the run with `runAgent`

`runAgent` owns the loop, so the `while (true)` is gone. You supply executors built from the same `models` map.

```ts
const executors = createAiSdkExecutors({ models });

const result = await runAgent(machine, {
  input: { request: "Refund my duplicate charge", orderId: "A-42" },
  executors,
});

if (result.status === "idle") {
  // result.snapshot is plain JSON. Persist it, then resume in any process.
  const resumed = await runAgent(machine, {
    snapshot: result.snapshot,
    event: { type: "APPROVE" },
    executors,
  });
  if (resumed.status === "done") console.log(resumed.output); // { refunded: true }
}
```

The idle snapshot is plain JSON, so a `stringify`, store, and `parse` round-trip resumes the same run.

<!-- viz: resume flow: runAgent settles idle -> persisted snapshot -> JSON in a store -> new process parses -> runAgent(snapshot, event) -> done -->

```ts
const wire = JSON.stringify(result.persistedSnapshot ?? result.snapshot); // stored by your DB or queue
const restored = JSON.parse(wire); // read in a fresh process, with no live objects

const resumed = await runAgent(machine, {
  snapshot: restored,
  event: { type: "APPROVE" },
  executors,
});
// resumed.status === 'done', resumed.output === { refunded: true }
```

The executors hold your existing model code:

- The `createAiSdkExecutors` adapter wraps the AI SDK.
- The `generateText` and `streamText` slots also accept the raw AI SDK functions. Another SDK or a raw `fetch` works the same way.
- The tools, retry logic, and provider calls you already wrote move across unchanged.

Only the `while` loop is removed. See [Hosts](hosts.md).

## Existing server integration

The machine is host-agnostic, so it runs wherever your loop ran. For a request handler that runs straight through and owns its own actor, bind the executors with `provideExecutors` and run a plain XState actor instead of `runAgent`.

```ts no-check
import { createActor } from "xstate";
import { provideExecutors } from "@statelyai/agent";

app.post("/refund", async (req, res) => {
  const actor = createActor(provideExecutors(machine, executors), {
    input: { request: req.body.request, amount: req.body.amount },
  });
  actor.subscribe((s) => {
    if (s.status === "done") res.json(s.output);
  });
  actor.start();
});
```

To handle the human pause over HTTP, persist the snapshot with `runAgent` and resume it on a later request. [Use in any stack](any-stack.md) runs one machine in local, Express, and Cloudflare hosts without machine changes.

## Behavior preservation

Before you ship, pin the new machine's behavior with a deterministic playthrough that uses no model. `simulateAgent` scripts the decisions and runs the same step path that `runAgent` uses, with no API key and no network access.

```ts
import { simulateAgent } from "@statelyai/agent";

// A $5000 refund must escalate, not auto-refund.
const result = await simulateAgent(machine, {
  input: { request: "Refund my duplicate charge", orderId: "A-42" },
  script: {
    invokes: { lookupOrder: [{ total: 5000 }] },
    decisions: {
      "agent.decide": [
        { type: "REFUND", amount: 5000 },
        { type: "ESCALATE", reason: "Above the automatic refund limit." },
      ],
    },
  },
});
// The guard rejects the $5000 REFUND, which consumes its script entry. The
// decision is requested again and consumes the next entry, so the run reaches
// awaitingHuman and settles idle there.
expect(result.status).toBe("idle");
```

Script one entry per decision attempt, including attempts a guard rejects. A rejected decision consumes its entry, and the retry consumes the next one. If a queue runs dry while a request is pending, `simulateAgent` throws an error naming the request's kind, src, and id. The `invokes` channel cans the output of any non-model actor, which is how `lookupOrder` returns a total without calling your order service.

`explorePaths` enumerates every branch, and `canReach` returns `{ reachable, witness }` for one target state. See [Testing and verification](verify.md).

## Retrofit with `getRequests`

The steps above assume you write the model calls into the machine as invokes. If you already have a plain XState machine, use `getRequests` instead. It is a `RunAgentOptions` hook. Whenever the machine would settle idle, `getRequests` reads the snapshot and returns the model requests to run. If it returns nothing, the run settles idle, which is how human-wait states stay human-wait states.

The machine does not change. You choose where the prompts live: state `description` fields, `meta`, tags, or a lookup table keyed by state value. The library does not require any of these.

The following example reads prompts from state descriptions.

```ts no-check
import { getSnapshotRequests, runAgent } from "@statelyai/agent";

const result = await runAgent(existingMachine, {
  executors,
  getRequests: (snapshot) => getSnapshotRequests(snapshot, { model: "writer" }),
});
```

`getSnapshotRequests(snapshot, { model, filter?, map? })` is the prompts-in-descriptions recipe as a function. By default every active node with a `description` that is not tagged `waiting` produces one request. The request's `prompt` is the node's `description`, its `kind` is `decision` when the node is tagged `decision`, its `system` comes from `meta.role`, and its `allowedEvents` are the node's own events. A node with exactly one own event gets an explicit `onDone`, so a single-outcome state advances without a model decision. Pass `filter` to choose which nodes produce requests, and `map` to reshape or drop each request.

To build requests some other way, read the active state nodes with `getSnapshotNodes(snapshot)`. It returns `{ id, key, description?, tags, meta?, ownEvents, leaf }` per node.

```ts no-check
import { getSnapshotNodes } from "@statelyai/agent";

getRequests: (snapshot) =>
  getSnapshotNodes(snapshot)
    .filter((node) => node.leaf && node.meta)
    .map((node) => buildRequest(node));
```

This hook behaves as follows:

- Each request runs according to its `kind` and appends to the run's message log. The log is `RunAgentOptions.messages`, and you read it back with `getAgentMessages(snapshot)`.
- Each request advances the machine according to `onDone`. `onDone` is either an explicit event, or a `decide` call when you omit it. Both are gated by `snapshot.can`.
- Multiple returned requests run concurrently. For parallel regions, scope each request with `allowedEvents`. The node's `ownEvents` is a reasonable default.
- A pass that sends no event settles idle.
- Every model call counts against `maxModelCalls`.

For a runnable version, see [described-workflow](../examples/described-workflow/index.ts). It is a plain `createMachine` with no invokes and no `setupAgent`, driven by `getRequests`.

## Related

For what the machine gives you over the loop, see the [overview](index.md).

For a worked version of this conversion, see [retrofit](../examples/retrofit/index.ts). It refactors a tangled loop one step at a time with the behavior pinned by tests, in the order `before.ts`, `step1.ts`, `step2.ts`, `step3.ts`, and `index.ts`.

The same conversion works from shapes other than a `while` loop:

- [plain-xstate](../examples/plain-xstate/index.ts): a standard XState machine driven with no agent-specific setup.
- [described-workflow](../examples/described-workflow/index.ts): prompts written as state `description` fields and run through the `getRequests` option of `runAgent`.
- [todo-nl](../examples/todo-nl/index.ts): natural-language commands mapped onto machine events.
- [Thinking in state machines](thinking-in-state-machines.md): the design tutorial behind this refactor, worked through on one triage agent.
