---
title: Migrating from a hand-rolled loop
description: Convert a realistic while-loop tool-calling agent into an agent machine one step at a time, and see what you get for free.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

You have an agent that works, but its control flow is a `while` loop with `if`s, tool dispatch, and retry code tangled together. This page refactors that loop into an agent machine **without rewriting your model calls**. Your existing SDK calls, tools, and retry logic become the [executors](hosts.md); the machine replaces only the control flow. It drops into your existing server unchanged, and you can prove the refactor preserved behavior before shipping it.

If you already have a state machine and just want to bind LLM work to it, start from [You already have an agent workflow](xstate-as-agent-workflow.md) instead. This page is for a loop.

## Start: a hand-rolled loop

A realistic refund agent as a `while` loop with any SDK. It works: the model calls tools until it stops, a `$100` limit is enforced inline, and anything bigger pauses for a human.

```ts
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

async function runRefundAgent(request: string) {
  const messages: any[] = [{ role: 'user', content: request }];
  let refunded = false;

  while (true) {
    const { toolCalls } = await generateText({
      model: openai('gpt-5.4-mini'),
      messages,
      tools: {
        lookupOrder: tool({ inputSchema: z.object({ id: z.string() }) }),
        issueRefund: tool({ inputSchema: z.object({ amount: z.number() }) }),
        escalate: tool({ inputSchema: z.object({ reason: z.string() }) }),
      },
    });
    if (!toolCalls?.length) return { refunded };

    for (const call of toolCalls) {
      if (call.toolName === 'issueRefund') {
        if (call.input.amount > 100) return { pending: true }; // ...now what?
        refunded = true;
      }
      // push tool result onto messages, continue the loop
    }
  }
}
```

Three things are quietly wrong: the `$100` rule is an `if` the model could be prompted around, nothing stops `issueRefund` before `lookupOrder`, and the human pause returns `{ pending: true }`, **throwing away all the loop's state** with no way to resume.

## Step 1: make the implicit phases explicit states

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

## Step 2: the tool-choice becomes a decision with `allowedEvents` + guards

"Which tool" was a model output you validated after the fact. Make it a **decision**: the model chooses exactly one currently-legal event, and a **guard** owns the `$100` limit so no prompt can talk past it.

```ts
const machine = agentSetup.createMachine({
  context: ({ input }) => ({ ...input, refunded: false }),
  initial: 'deciding',
  states: {
    deciding: {
      invoke: {
        src: 'agent.decide',
        input: ({ context }) => ({
          model: 'quick',
          system: 'Decide whether this refund can be issued directly.',
          prompt: `${context.request} (amount: $${context.amount})`,
          allowedEvents: ['REFUND', 'ESCALATE'], // typo = compile error
        }),
      },
      on: {
        // Guard owns the limit: REFUND above $100 returns undefined, so the
        // model is rejected and re-asked with typed feedback.
        REFUND: ({ context }) =>
          context.amount <= 100 ? { target: 'refunded', context: { refunded: true } } : undefined,
        ESCALATE: { target: 'awaitingHuman' },
      },
    },
    // ...
  },
});
```

A chosen `REFUND` for `$5000` can no longer slip through: the guard returns `undefined` and the decision retries. The `system` and `prompt` are yours; how the model is coerced into picking one event is the host executor's job and swappable (see [Decisions](decisions.md) and [Coercion](decisions.md#coercion)).

## Step 3: the pause becomes an idle state with snapshot persistence

The loop's `return { pending: true }` becomes a real waiting **state** with no invoke. `runAgent` settles `idle` there instead of losing everything; the snapshot is plain JSON you persist anywhere.

```ts
    awaitingHuman: {
      // No invoke: runAgent settles { status: 'idle', snapshot } here.
      on: {
        APPROVE: { target: 'refunded', context: { refunded: true } },
        DENY: { target: 'denied' },
      },
    },
    refunded: { type: 'final', output: () => ({ refunded: true }) },
    denied: { type: 'final', output: () => ({ refunded: false }) },
```

## Step 4: run it with `runAgent`

The `while (true)` is gone. `runAgent` owns the loop; you supply executors built from the same `models` map.

```ts
const executors = createAiSdkExecutors({ models });

const result = await runAgent(machine, {
  input: { request: 'Refund my duplicate charge', amount: 5000 },
  executors,
});

if (result.status === 'idle') {
  // Persist result.snapshot anywhere (plain JSON), then resume in any process:
  const resumed = await runAgent(machine, {
    snapshot: result.snapshot,
    event: { type: 'APPROVE' },
    executors,
  });
  if (resumed.status === 'done') console.log(resumed.output); // { refunded: true }
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

Those executors are your existing model code. `createAiSdkExecutors` wraps the AI SDK, but the `generateText`/`streamText` slots accept the raw AI SDK functions directly, and any other SDK or a raw `fetch` backs them just as well. The tools, retry logic, and provider calls you already wrote move into the executors unchanged; only the `while` loop is gone. See [Hosts](hosts.md).

## Drop it into your existing server

The machine is host-agnostic, so it runs wherever your loop ran. For a straight-through request handler that owns its own actor, bind executors with `provideExecutors` and run a plain XState actor, no `runAgent`:

```ts
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

For the idle human pause (the `$100` escalation above) over HTTP, persist the snapshot with `runAgent` and resume on a later request. [Eject to your stack](eject.md) walks one machine from local to Express to Cloudflare with zero machine changes.

## Prove the refactor preserved behavior

Before shipping, pin the new machine's behavior with a deterministic, model-free playthrough. `simulateAgent` scripts the decisions and runs the same step path `runAgent` uses, no API key, no network:

```ts
import { simulateAgent } from "@statelyai/agent";

// A $5000 refund must escalate, not auto-refund.
const result = await simulateAgent(machine, {
  input: { request: "Refund my duplicate charge", amount: 5000 },
  script: { decisions: { "agent.decide": [{ type: "REFUND" }] } },
});
// The REFUND guard rejects amount > 100, so the run settles idle at awaitingHuman,
// not refunded: the old loop's `if` is now enforced by construction.
expect(result.status).toBe("idle");
```

`canReach` and `explorePaths` go further: enumerate every branch and prove which outcomes are reachable. See [Testing and verification](verify.md).

## Other starting points

A worked end-to-end version of this page's conversion — a genuinely tangled loop, refactored one shippable step at a time with the behavior pinned by tests — lives in [retrofit](../examples/retrofit/index.ts) (`before.ts` → `step1/2/3.ts` → `index.ts`).

The same conversion works from shapes other than a `while` loop:

- [plain-xstate](../examples/plain-xstate/index.ts): a bog-standard XState machine driven with no agent-specific setup.
- [described-workflow](../examples/described-workflow/index.ts): prompts written as state `description`s, run via `runAgent`'s `getRequests` option.
- [todo-nl](../examples/todo-nl/index.ts): natural-language commands mapped onto machine events.

## What you got for free

Same behavior as the loop, plus legality by construction, snapshot resume, step-path [checkpointing](steps.md), and [visualization](machines-as-data.md), none of which the loop gives you without hand-built machinery. The transcript and log bookkeeping you hand-maintained in the loop becomes the ordered [`onTrace`](observability.md) stream: one run/request/chunk/transition ledger for evals, JSONL, and telemetry. [Compared to LangGraph and hand-rolling](comparison.md) breaks each down against the alternatives.

If you never need them, the loop was fine. When you do, the machine gives you each one for free.
