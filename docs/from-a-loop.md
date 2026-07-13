---
title: Migrating from a hand-rolled loop
description: Convert a realistic while-loop tool-calling agent into an agent machine one step at a time, and see what you get for free.
---

## Start: a hand-rolled loop

Here is a realistic refund agent as a `while` loop with any SDK. It works. The model calls tools until it stops, a `$100` limit is enforced inline, and anything bigger has to pause for a human.

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

Three things are quietly wrong: the `$100` rule is an `if` the model could be prompted around, nothing stops `issueRefund` before `lookupOrder`, and the human pause returns `{ pending: true }` and **throws away all the loop's state**. There is no way to resume.

## Step 1: make the implicit phases explicit states

The loop has phases even though nothing names them: it is deciding what to do, then doing it, then either finishing or waiting on a human. Name them as states. Declare schemas and the setup with the flat `setupAgent` form.

```ts
import { z } from 'zod';
import { setupAgent, runAgent } from '@statelyai/agent';
import { createAiSdkExecutors, defineModels } from '@statelyai/agent/ai-sdk';
import { openai } from '@ai-sdk/openai';

const models = defineModels({ quick: openai('gpt-5.4-mini') });

const agentSetup = setupAgent({
  models,
  context: z.object({ request: z.string(), amount: z.number(), refunded: z.boolean() }),
  input: z.object({ request: z.string(), amount: z.number() }),
  output: z.object({ refunded: z.boolean() }),
  events: {
    REFUND: z.object({}),
    ESCALATE: z.object({ reason: z.string() }),
    APPROVE: z.object({}),
    DENY: z.object({}),
  },
});
```

The phases become `deciding`, `awaitingHuman`, `refunded`, `denied`.

## Step 2: the tool-choice becomes a decision with `allowedEvents` + guards

In the loop, "which tool" was a model output you validated after the fact. Make it a **decision**: the model chooses exactly one currently-legal event, and a **guard** owns the `$100` limit so no prompt can talk past it.

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
        // The guard owns the limit, not the prompt: REFUND above $100 returns
        // undefined, so the model is rejected and re-asked with typed feedback.
        REFUND: ({ context }) =>
          context.amount <= 100 ? { target: 'refunded', context: { refunded: true } } : undefined,
        ESCALATE: { target: 'awaitingHuman' },
      },
    },
    // ...
  },
});
```

A chosen `REFUND` for `$5000` can no longer slip through — the guard returns `undefined` and the decision retries. See [Decisions](decisions.md).

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

The loop and its `while (true)` are gone. `runAgent` owns the loop; you supply executors built from the same `models` map.

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

## What you got for free

The same behavior as the loop, plus four things the loop could not give you without hand-built machinery:

- **Legality.** The model can only choose a currently-legal event, and the `$100` rule is a guard, not a promptable `if`. Illegal actions are impossible, not caught late.
- **Resume.** The human pause is a JSON snapshot you persist and resume in another process, days later, with pre-pause work guaranteed to run exactly once. See [Human in the loop](human-in-the-loop.md).
- **Inspection.** Drive the same machine one model call at a time on the [step path](steps.md) for a durable host that checkpoints after every call and replays deterministically.
- **Visualization.** The machine is a graph: open it in Stately to see and review the flow, or store it as [data](machines-as-data.md) for an agent to generate or edit.

If you never need those four, the loop was fine. When you do, the machine gives you each one without hand-built machinery. See [Compared to LangGraph and hand-rolling](comparison.md).
