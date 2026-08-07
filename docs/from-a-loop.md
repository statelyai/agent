---
title: Migrating from a hand-rolled loop
description: Convert a realistic while-loop tool-calling agent into an agent machine one step at a time, and see what you get for free.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).
> This page refactors a working `while`-loop agent into an agent machine **without rewriting your model calls**: your SDK calls, tools, and retry logic become the [executors](hosts.md); the machine replaces only the control flow.

The call site stays one line. Where you had:

```ts no-check
const result = await generateText({ model, prompt, tools });
```

you end with:

```ts
const result = await generateResult(machine, { input, executors });
```

Your `generateText` call did not go away; it moved into the executors. The loop you wrote around it became the machine. And like `generateText`, the result carries metadata alongside the value: `result.output`, plus `result.snapshot`, the replayable `result.events`, and the aggregated `result.usage`.

For the design move underneath this refactor (how to spot the states hiding in a loop before you write any of them down), read [Thinking in state machines](thinking-in-state-machines.md).

## Start: a hand-rolled loop

A realistic refund agent as a `while` loop with any SDK. It works: the model calls tools until it stops, a `$100` limit is enforced inline, and anything bigger pauses for a human.

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
        if ((call.input as { amount: number }).amount > 100) return { pending: true }; // ...now what?
        refunded = true;
      }
      // push tool result onto messages, continue the loop
    }
  }
}
```

Three things are quietly wrong: the `$100` rule is an `if` the model could be prompted around, nothing stops `issueRefund` before `lookupOrder`, and the human pause returns `{ pending: true }`, **throwing away all the loop's state** with no way to resume.

## Step 1: implicit phases as explicit states

The loop already has phases: deciding, doing, then finishing or waiting on a human. Name them as states. Declare schemas and setup with the flat `setupAgent` form.

```ts
import { z } from "zod";
import { setupAgent, runAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

const models = defineModels({ quick: openai("gpt-5.4-mini") });

const agentSetup = setupAgent({
  models,
  context: z.object({ request: z.string(), amount: z.number(), refunded: z.boolean() }),
  input: z.object({ request: z.string(), amount: z.number() }),
  output: z.object({ refunded: z.boolean() }),
  events: {
    REFUND: {}, // {} is shorthand for a payload-less event
    ESCALATE: z.object({ reason: z.string() }),
    APPROVE: {},
    DENY: {},
  },
});
```

The phases become `deciding`, `awaitingHuman`, `refunded`, `denied`.

## Step 2: tool choice as a guarded decision

"Which tool" was a model output you validated after the fact. Make it a **decision**: the model chooses exactly one currently-legal event, and a **guard** owns the `$100` limit so no prompt can talk past it.

```ts no-check
const machine = agentSetup.createMachine({
  context: ({ input }) => ({ ...input, refunded: false }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          system: "Decide whether this refund can be issued directly.",
          prompt: `${context.request} (amount: $${context.amount})`,
          allowedEvents: ["REFUND", "ESCALATE"], // typo = compile error
        }),
      },
      on: {
        // The $100 rule, as a guard.
        REFUND: ({ context }) =>
          context.amount <= 100 ? { target: "refunded", context: { refunded: true } } : undefined,
        ESCALATE: { target: "awaitingHuman" },
      },
    },
    // ...
  },
});
```

A chosen `REFUND` for `$5000` can no longer slip through: the transition returns `undefined`, so the choice is rejected and the decision retries with typed feedback (see [transitions](machines.md#transitions)). The `system` and `prompt` are yours; how the model is coerced into picking one event is the host executor's job and swappable (see [Decisions](decisions.md) and [Coercion](decisions.md#coercion)).

## Step 3: the pause as an idle state

The loop's `return { pending: true }` becomes a real waiting **state** with no invoke. `runAgent` settles `idle` there instead of losing everything; the snapshot is plain JSON you persist anywhere.

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

With `runAgent` owning the loop, the `while (true)` is gone; you supply executors built from the same `models` map.

```ts
const executors = createAiSdkExecutors({ models });

const result = await runAgent(machine, {
  input: { request: "Refund my duplicate charge", amount: 5000 },
  executors,
});

if (result.status === "idle") {
  // Persist result.snapshot anywhere (plain JSON), then resume in any process:
  const resumed = await runAgent(machine, {
    snapshot: result.snapshot,
    event: { type: "APPROVE" },
    executors,
  });
  if (resumed.status === "done") console.log(resumed.output); // { refunded: true }
}
```

The idle snapshot is genuinely plain JSON, so a real `stringify` → store → `parse` round-trip resumes identically:

```ts
import { persistSnapshot } from "@statelyai/agent";

// persistSnapshot deep-clones via JSON.stringify/parse; do it by hand to prove it:
const wire = JSON.stringify(persistSnapshot(result.snapshot)); // what your DB/queue stores
const restored = JSON.parse(wire); // a fresh process, no live objects

const resumed = await runAgent(machine, {
  snapshot: restored,
  event: { type: "APPROVE" },
  executors,
});
// resumed.status === 'done', resumed.output === { refunded: true }
```

Those executors are your existing model code:

- The `createAiSdkExecutors` adapter wraps the AI SDK.
- The `generateText`/`streamText` slots also accept the raw AI SDK functions directly, and any other SDK or a raw `fetch` backs them just as well.
- The tools, retry logic, and provider calls you already wrote move in unchanged.

Only the `while` loop is gone. See [Hosts](hosts.md).

## Existing server integration

The machine is host-agnostic, so it runs wherever your loop ran. For a straight-through request handler that owns its own actor, bind executors with `provideExecutors` and run a plain XState actor, no `runAgent`:

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

For the idle human pause (the `$100` escalation above) over HTTP, persist the snapshot with `runAgent` and resume on a later request. [Use in any stack](any-stack.md) drops one machine into local, Express, and Cloudflare hosts with zero machine changes.

## Behavior-preservation proof

Before shipping, pin the new machine's behavior with a deterministic, model-free playthrough. `simulateAgent` scripts the decisions and runs the same step path `runAgent` uses, no API key, no network:

```ts
import { simulateAgent } from "@statelyai/agent";

// A $5000 refund must escalate, not auto-refund.
const result = await simulateAgent(machine, {
  input: { request: "Refund my duplicate charge", amount: 5000 },
  script: { decisions: { "agent.decide": [{ type: "REFUND" }] } },
});
// The REFUND guard rejects amount > 100, so the run never reaches refunded: it
// settles idle at deciding. The old loop's `if` is now enforced by construction.
expect(result.status).toBe("idle");
```

`canReach` and `explorePaths` go further: enumerate every branch and prove which outcomes are reachable. See [Testing and verification](verify.md).

## Retrofit with `getRequests`

Everything above assumes you write the model calls into the machine as invokes. If you already have a plain XState machine, `getRequests` is the seam that skips that rewrite: it is a `RunAgentOptions` hook, and whenever the machine would otherwise settle idle, it reads the snapshot and returns the model request(s) to run instead. Return nothing and the run settles idle, which is how human-wait states stay human-wait states.

The machine does not change at all. Where the prompts live is your call: state `description`s, `meta`, tags, or a lookup table keyed by state value. Nothing is blessed by the library.

The prompts-in-descriptions recipe, copy-paste and adapt:

```ts no-check
const result = await runAgent(existingMachine, {
  executors,
  getRequests: (snapshot) =>
    snapshot._nodes
      .filter((node) => node.description && !node.tags.includes("waiting"))
      .map((node) => ({
        model: "writer",
        prompt: node.description!,
        kind: node.tags.includes("decision") ? "decision" : "text",
        // single-outcome states advance deterministically; else `decide`
        onDone: node.ownEvents.length === 1 ? { type: node.ownEvents[0] } : undefined,
        allowedEvents: node.ownEvents,
      })),
});
```

Semantics:

- Each request runs per its `kind`, appends to the run's message log (`RunAgentOptions.messages`, read back with `getAgentMessages(snapshot)`), and advances the machine per `onDone`: an explicit event, or a `decide` call when omitted. Always gated by `snapshot.can`.
- Multiple returned requests run concurrently. For parallel regions, scope each one with `allowedEvents` (the node's `ownEvents` is a good default).
- A pass that sends no event settles idle.
- Every model call counts against `maxModelCalls`.

Runnable version: [described-workflow](../examples/described-workflow/index.ts), a plain `createMachine` with no invokes and no `setupAgent`, driven end to end by `getRequests`.

## What the machine adds

Same behavior as the loop, plus three things the loop only gets with hand-built machinery:

- **Legality by construction**, and snapshot resume at every idle state.
- **Durability**: the [step path](steps.md) and the [event log](event-log.md).
- **One ordered ledger**: the transcript bookkeeping you hand-maintained becomes [`onTrace`](observability.md), for evals, JSONL, and telemetry.

## Related

A worked end-to-end version of this page's conversion (a genuinely tangled loop, refactored one shippable step at a time with the behavior pinned by tests) lives in [retrofit](../examples/retrofit/index.ts): `before.ts`, then `step1/2/3.ts`, then `index.ts`.

The same conversion works from shapes other than a `while` loop:

- [plain-xstate](../examples/plain-xstate/index.ts): a bog-standard XState machine driven with no agent-specific setup.
- [described-workflow](../examples/described-workflow/index.ts): prompts written as state `description`s, run via `runAgent`'s `getRequests` option.
- [todo-nl](../examples/todo-nl/index.ts): natural-language commands mapped onto machine events.
- [Thinking in state machines](thinking-in-state-machines.md): the design tutorial behind this refactor, worked end to end on one triage agent.
