---
title: Usage and budgets
description: Read token usage off a run, cap runaway loops with maxModelCalls, and enforce turn and token budgets as ordinary machine guards.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

Three layers, coarsest first:

- **After the run**: `result.usage`, the aggregated model-call usage for that run.
- **During the run, host side**: `onResult` and `onTrace` see each call's usage as it lands.
- **During the run, machine side**: the reserved `@agent.usage` event delivers each call's tokens to the machine, so budgets live in `context` and are enforced by ordinary guards.

The first two are observational. Only the third can change what the agent does.

## Reading `result.usage`

<!-- AgentUsage from src/text-logic.ts; aggregation in src/run-agent.ts -->

Every settled `RunAgentResult` carries `usage`, on all three variants (`done`, `idle`, `error`):

```ts
const result = await runAgent(machine, { input, executors });

result.usage.modelCalls; // number, always present
result.usage.totalTokens; // number | undefined (only calls that reported it)
```

| Field               | Meaning                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `modelCalls`        | Model and decision calls this run made. Always a number. Each decision retry counts separately. |
| `inputTokens`       | Partial sum, see below.                                                                         |
| `outputTokens`      | Partial sum.                                                                                    |
| `totalTokens`       | Partial sum.                                                                                    |
| `reasoningTokens`   | Partial sum.                                                                                    |
| `cachedInputTokens` | Partial sum.                                                                                    |

Caveats worth internalizing:

- **Partial sums.** Each token field sums only the calls that reported it, and is `undefined` only when _no_ call reported it. A run mixing a real SDK executor (reports usage) with a scripted mock (does not) yields a sum over the reporting subset, not `undefined`. Do not read a token total as "the whole run" unless every executor reports.
- **`modelCalls` is always there**, even when nothing reports tokens. It is the one number you can trust unconditionally.
- **Per run, not per conversation.** A resumed run counts only its own calls, never the history behind `snapshot`/`events`. Add prior results' totals yourself for a conversation-wide figure.
- **Usage comes from your executor.** `runAgent` reads `usage` off the raw executor result: our `{ output, usage }` envelope, a Vercel AI SDK result (same flat field names), or any custom executor following that shape. Non-finite values are dropped.

Summing across a resume chain is host code:

```ts
function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    modelCalls: a.modelCalls + b.modelCalls,
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    cachedInputTokens: sum(a.cachedInputTokens, b.cachedInputTokens),
  };
}
```

## Per-call usage

Two seams, both live and both read-only:

- `onResult(request, { output, raw })`: `raw` is your executor's verbatim result, so `raw.usage` is that call's usage in whatever shape the executor produced.
- `onTrace` `request.end`: a normalized `usage?: AgentCallUsage`, present only when the executor reported one. See [Observability](observability.md#the-versioned-trace-stream).

```ts
await runAgent(machine, {
  input,
  executors,
  onResult: (request, { raw }) => {
    const usage = (raw as { usage?: AgentCallUsage }).usage;
    if (usage) {
      console.log(request.kind, request.id, usage);
    }
  },
  onTrace: (event) => {
    if (event.type === "request.end" && event.usage) {
      console.log(event.request.id, event.usage.totalTokens);
    }
  },
});
```

Use these for dashboards, per-tenant metering, and cost alerts. Neither can stop the run. To feed the machine, use `@agent.usage` below.

## `maxModelCalls`: the global backstop

`maxModelCalls` caps the number of model and decision calls one run may make. Default `100`. Decision retries count separately.

```ts
const result = await runAgent(machine, { input, executors, maxModelCalls: 20 });

if (result.status === "error" && result.cause === "max-model-calls") {
  result.usage.modelCalls; // 20
  result.snapshot; // resume from here after raising the cap
}
```

- The overrun is thrown **into the invoke that would have made the call**. With nothing handling it, the run settles `{ status: 'error', cause: 'max-model-calls' }`, with `usage`, `snapshot`, and `events` intact.
- An `onError` on that invoke **catches it like any other failure**. A machine whose invoke has `onError: { target: 'someState' }` can therefore settle `done` at the cap instead of `error`. Route `onError` deliberately, or leave it off where you want the cap to surface.
- It counts calls, not tokens or dollars, and it is host-owned: the machine cannot read how much budget is left.

Treat it as the runaway-loop backstop. Anything the machine's own logic should react to belongs in a guard.

## Budgets as guards

A budget is data, not a runtime feature:

- **Limits enter via `input`** and land in `context` (`maxTurns`, `maxTokens`, `maxDollars`).
- **Counters live in `context`**, folded in by the transitions that carry the data.
- **Guards are ordinary transition functions**: over budget, return a transition into a final `outOfBudget` state, or return `undefined` so the expensive event is not takeable at all.

Nothing here is agent-specific. It is the same [guard](machines.md#transitions) mechanism the rest of the machine uses, which is why it composes with decisions: a candidate event whose transition returns `undefined` is never offered to the model.

### What reaches the machine

Important, because it decides which counters you can keep:

- A **text invoke's `onDone` output is the normalized output only**. The runner returns `{ output }` and drops the rest of the executor envelope, so `usage` on the envelope does not appear in `onDone` (`src/run-agent.ts`).
- A **decision delivers only the chosen event**. `resolveDecision` returns the validated event; the executor's `usage` is dropped (`src/decision.ts`).
- **`@agent.usage` carries the tokens instead.** After every settled model call that reported usage, `runAgent` delivers a reserved `@agent.usage` event to the machine, so `context` can fold it and guards can read it.

So turn counters and token counters are both free: increment turns in `onDone`, fold tokens in `@agent.usage`.

### The `@agent.usage` event

<!-- AGENT_USAGE_EVENT_TYPE and AgentUsageEvent from src/effects.ts -->

```ts
{
  type: '@agent.usage',
  usage: { inputTokens?, outputTokens?, totalTokens?, reasoningTokens?, cachedInputTokens? },
  kind?: 'text' | 'decision' | 'plan',  // which request reported it
  id?: string,                          // the request's durable invoke id
  src?: string,                         // the request's invoke src
  model?: string,                       // the model ref it targeted
  name?: string,                        // a text request's registered name
}
```

Rules worth knowing before you wire it:

- **Declared for you.** `setupAgent`/`createAgentSchemas` register `'@agent.usage'` (with the payload schema above) in every agent's events, so it shows up in `schemas.events` and its handler is typed — `event.usage.totalTokens` narrows — without declaring anything. Declaring it yourself in `events` is an error: the `@agent.` namespace is reserved.
- **Opt-in by construction.** The event is delivered only when the machine's active states declare a `'@agent.usage'` transition **explicitly**. Declare none and nothing changes: no extra transition, no extra trace event, no extra event-log entry. A catch-all `on: { '*': … }` is not an opt-in — it never receives the event, so a wildcard machine's context and event log are byte-identical to a run without the feature.
- **Declare it machine-level.** A root `on: { '@agent.usage': … }` catches every call whatever state made it. A state-scoped handler only catches calls made while that state is active, which silently drops the rest.
- **Never model-facing.** The `@agent.*` namespace is excluded from `getAcceptedEvents` and `parseAgentEvent`, so `@agent.usage` is never offered as a decision candidate (not even under an `allowedEvents: ['*']` wildcard) and cannot be forged from a wire message.
- **It rides the event log.** A delivered `@agent.usage` is journaled like any other external input, so events-only recovery (`runAgent({ events })`) replays the folded tokens without re-calling a model.
- **A crash between the usage and its call's result is healed.** Usage is journaled when the call settles, before the call's own result, so the guard sees the tokens in the same step that consumes the result. A log truncated inside that window would otherwise replay the tokens AND re-execute the pending call. Events-only recovery therefore drops a trailing usage entry whose call is still pending in the folded state: the re-executed call reports its own tokens, counted once.
- **Stragglers are dropped, not delivered.** A call that settles after the run's cycle has resolved (an idle settle, a `done`/`error` settle, an abort) still folds into `result.usage`, but its machine event is dropped — the same on `runAgent` and `createAgentActor`, so a late arrival can never re-open an already-returned idle result. Watch for `usage.dropped` on `onTrace` if a counter looks short.
- **Delivered to the run's root machine**, including usage from requests inside an invoked child machine. Attribute those with the event's `id`/`src`/`model`.
- **Only what your executor reports.** No `usage` on the executor result means no event. In particular, [`simulateAgent`](verify.md) scripts return no usage, so a token counter stays `0` under simulation. Simulate the shape of the loop; test the budget itself with `runAgent` and a usage-reporting mock, as the library's own tests do.

Opt in with a transition — nothing to declare in `events`:

```ts
import { AGENT_USAGE_EVENT_TYPE, setupAgent } from "@statelyai/agent";

const agent = setupAgent({ schemas });

const machine = agent.createMachine({
  // …context, states
  on: {
    // Typed from the default registration: `event.usage`, `event.kind`, …
    [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
      context: { tokens: context.tokens + (event.usage.totalTokens ?? 0) },
    }),
  },
});
```

### Recipe: turn and token budget

A machine-level `@agent.usage` handler folds every call's tokens into `context`; an ordinary guard stops the loop when the budget is spent:

```ts
import { z } from "zod";
import {
  AGENT_USAGE_EVENT_TYPE,
  createAgentSchemas,
  createTextLogic,
  runAgent,
  setupAgent,
} from "@statelyai/agent";

const researchStep = createTextLogic({
  schemas: { input: z.object({ topic: z.string(), turn: z.number() }), output: z.string() },
  model: "openai/gpt-5.4-mini",
  prompt: ({ input }) => `Research ${input.topic}. Turn ${input.turn}. One new fact.`,
});

const schemas = createAgentSchemas({
  // Limits arrive as input.
  input: z.object({ topic: z.string(), maxTurns: z.number(), maxTokens: z.number() }),
  context: z.object({
    topic: z.string(),
    notes: z.array(z.string()),
    turns: z.number(),
    tokens: z.number(),
    maxTurns: z.number(),
    maxTokens: z.number(),
  }),
  output: z.object({
    notes: z.array(z.string()),
    turns: z.number(),
    tokens: z.number(),
    stoppedBy: z.string(),
  }),
  // No `events` entry for '@agent.usage' — setupAgent declares it for you.
});

const agent = setupAgent({ schemas, actors: { researchStep } });

const machine = agent.createMachine({
  // Limits become plain context data.
  context: ({ input }) => ({
    topic: input.topic,
    notes: [],
    turns: 0,
    tokens: 0,
    maxTurns: input.maxTurns,
    maxTokens: input.maxTokens,
  }),
  // Machine-level, so every model call's tokens land wherever they were spent.
  on: {
    [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
      context: { tokens: context.tokens + (event.usage.totalTokens ?? 0) },
    }),
  },
  initial: "researching",
  states: {
    researching: {
      invoke: {
        id: "research",
        src: "researchStep",
        input: ({ context }) => ({ topic: context.topic, turn: context.turns + 1 }),
        // Only the turn counter here — the tokens already arrived on their own.
        onDone: ({ context, output }) => ({
          target: "checkingBudget",
          context: { notes: [...context.notes, output], turns: context.turns + 1 },
        }),
        // No onError on purpose: an overrun of maxModelCalls surfaces as the
        // run's error result instead of being swallowed here.
      },
    },
    checkingBudget: {
      // The budget guard: an ordinary transition function reading context.
      always: ({ context }) =>
        context.turns >= context.maxTurns || context.tokens >= context.maxTokens
          ? { target: "outOfBudget" }
          : { target: "researching" },
    },
    outOfBudget: {
      type: "final",
      output: ({ context }) => ({
        notes: context.notes,
        turns: context.turns,
        tokens: context.tokens,
        stoppedBy: context.tokens >= context.maxTokens ? "tokens" : "turns",
      }),
    },
  },
});

// Scripted, keyless executor. `usage` on the result is all it takes — the same
// field `result.usage` aggregates is the one `@agent.usage` carries.
let call = 0;
const executors = {
  generateText: async () => ({
    output: `fact ${++call}`,
    usage: { totalTokens: 520 },
  }),
};

const result = await runAgent(machine, {
  input: { topic: "otter migration", maxTurns: 5, maxTokens: 1500 },
  maxModelCalls: 20,
  executors,
});

if (result.status === "done") {
  result.output.stoppedBy; // 'tokens' (3 calls, 1560 >= 1500)
}
result.usage; // { totalTokens: 1560, modelCalls: 3 }
```

Two things to note about the shape:

- The loop goes `researching -> checkingBudget -> researching`. A transition targeting its own state does **not** re-enter it, so a self-targeting `onDone` would not re-run the invoke. Bounce through a check state.
- The tokens land **between** the call settling and its `onDone`, so `checkingBudget` always reads a counter that includes the call it just made.

### Alternative: fold usage into the request's output

Before `@agent.usage` this was the only way to get tokens into `context`, and it still has a use: the tokens arrive **inside** `onDone`, in the same transition as the output, and they survive `simulateAgent` because a script can return them.

Give the request an output shape that carries usage, and have the executor fill it:

```ts
const researchStep = createTextLogic({
  schemas: {
    input: z.object({ topic: z.string() }),
    output: z.object({ note: z.string(), usage: z.object({ totalTokens: z.number() }) }),
  },
  model: "openai/gpt-5.4-mini",
  prompt: ({ input }) => `Research ${input.topic}. One new fact.`,
});

const executors = {
  generateText: async () => {
    const usage = { totalTokens: 520 };
    return {
      output: { note: "otters raft", usage }, // reaches onDone
      usage, // aggregated into result.usage
    };
  },
};

// …then in the machine:
onDone: ({ context, output }) => ({
  target: "checkingBudget",
  context: {
    notes: [...context.notes, output.note],
    tokens: context.tokens + output.usage.totalTokens,
  },
});
```

The cost is that it only works for output shapes you own: a shared request or a third-party executor cannot be reshaped, and a decision has no output to reshape at all. `@agent.usage` covers all three. With a real host, wrap your existing executor rather than writing one: call it, then return `{ output: { ...yourOutput, usage: result.usage }, usage: result.usage }`.

### Guarding a decision

The same guard makes an over-budget choice **impossible**, not merely discouraged. An event whose transition returns `undefined` is not a legal candidate, so the model is never offered it:

```ts
deciding: {
  invoke: {
    id: 'chooseNext',
    src: 'agent.decide',
    input: {
      model: 'openai/gpt-5.4-mini',
      prompt: 'Research more, or summarize what we have?',
      allowedEvents: ['RESEARCH_MORE', 'SUMMARIZE'],
    },
  },
  on: {
    // Over budget this returns undefined, so RESEARCH_MORE is not takeable.
    RESEARCH_MORE: ({ context }) =>
      context.tokens < context.maxTokens ? { target: 'researching' } : undefined,
    SUMMARIZE: { target: 'summarizing' },
  },
}
```

## Estimating cost

The library ships no price data and never estimates cost. Keep a price table in host code:

```ts
// USD per 1M tokens. Fill in from your provider's pricing page.
const PRICES: Record<string, { input: number; output: number }> = {
  "openai/gpt-5.4-mini": { input: 0, output: 0 },
};

function estimateCost(model: string, usage: AgentUsage | AgentCallUsage): number {
  const price = PRICES[model];
  if (!price) {
    throw new Error(`No price for model '${model}'.`);
  }
  const input = ((usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)) * price.input;
  const output = (usage.outputTokens ?? 0) * price.output;
  return (input + output) / 1_000_000;
}

estimateCost("openai/gpt-5.4-mini", result.usage);
```

`result.usage` is aggregated across every model the run used, so a per-model figure needs per-call attribution:

```ts
let spentUsd = 0;

await runAgent(machine, {
  input,
  executors,
  onTrace: (event) => {
    if (event.type !== "request.end" || !event.usage) {
      return;
    }
    // A decision carries `model` directly; text and plan requests carry it on `input`.
    const model =
      event.request.kind === "decision" ? event.request.model : event.request.input.model;
    spentUsd += estimateCost(model, event.usage);
  },
});
```

`@agent.usage` carries the same `model` attribution, so the machine can keep a per-model spend counter in `context` — and guard on it — rather than only reporting one from the host.

Cached input tokens are usually billed at a discount rather than free; subtracting them as above is a floor, not an exact invoice. Reconcile against your provider's billing, and treat these numbers as budget signals.

## Related

- [Observability](observability.md): the trace stream `request.end` usage rides on.
- [Event log](event-log.md): the journal a delivered `@agent.usage` is recorded in, and replayed from.
- [Machines](machines.md#transitions): guards as return values.
- [Decisions](decisions.md): why a guarded-out event is never offered to the model.
- [Human in the loop](human-in-the-loop.md): pausing and resuming across run boundaries.
