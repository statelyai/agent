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

## The usage result

<!-- AgentUsage from src/text-logic.ts; aggregation in src/run-agent.ts -->

Every settled `RunAgentResult` carries `usage`, on all three variants (`done`, `idle`, `error`):

```ts
const result = await runAgent(machine, { input, executors });

result.usage.modelCalls; // number, always present
result.usage.totalTokens; // number | undefined (only calls that reported it)
```

| Field                                                                                | Meaning                                                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `modelCalls`                                                                         | Model and decision calls this run made. Always a number. Each decision retry counts separately. |
| `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens` | Partial sums, see below.                                                                       |

Caveats:

- **Partial sums.** Each token field sums only the calls that reported it, and is `undefined` only when _no_ call reported it. A run mixing a real SDK executor (reports usage) with a scripted mock (does not) yields a sum over the reporting subset. Do not read a token total as "the whole run" unless every executor reports.
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

## Retries and executor budgets

Transport-level retries (429s, timeouts, backoff) belong in the executor or the SDK it wraps, not the machine. The AI SDK's `maxRetries` (and the OpenAI/Anthropic client equivalents) handles them; a raw-`fetch` executor adds its own loop. The machine never sees a transient network failure. Machine-level retry is different: an authored `onError` transition re-entering a state after a _semantic_ failure (a validation rejection, an exhausted decision) is control flow you model explicitly.

For finer budgets than `maxModelCalls` (a token cap, a per-request-`src` call count), wrap the executors. A child machine's requests inherit the parent's executors, so one wrapper counts the whole tree:

```ts
function withBudget(base: AgentRequestExecutors, maxCalls: number): AgentRequestExecutors {
  const calls = new Map<string, number>();
  return {
    ...base,
    generateText: async (request, info) => {
      const name = request.name ?? "(anonymous)";
      const n = (calls.get(name) ?? 0) + 1;
      calls.set(name, n);
      if (n > maxCalls) throw new Error(`Budget exceeded for '${name}'`);
      return base.generateText!(request, info);
    },
  };
}

await runAgent(machine, { input, executors: withBudget(executors, 20) });
```

A wrapper is still host-side: the machine cannot read the remaining budget or react to it. For that, use `@agent.usage` and a guard.

## The `@agent.usage` event

<!-- AGENT_USAGE_EVENT_TYPE and AgentUsageEvent from src/effects.ts -->

```ts no-check
{
  type: '@agent.usage',
  usage: { inputTokens?, outputTokens?, totalTokens?, reasoningTokens?, cachedInputTokens? },
  kind?: 'text' | 'decision',           // which request reported it
  id?: string,                          // the request's durable invoke id
  src?: string,                         // the request's invoke src
  model?: string,                       // the model ref it targeted
  name?: string,                        // a text request's registered name
}
```

### Rationale

Model-call results reach the machine stripped of usage:

- A **text invoke's `onDone` output is the normalized output only**. The runner returns `{ output }` and drops the rest of the executor envelope (`src/run-agent.ts`).
- A **decision delivers only the chosen event**. `resolveDecision` returns the validated event; the executor's `usage` is dropped (`src/decision.ts`).

`@agent.usage` carries the tokens instead: after every settled model call that reported usage, `runAgent` delivers it to the machine, so `context` can fold it and guards can read it. Turn counters and token counters are therefore both free: increment turns in `onDone`, fold tokens in `@agent.usage`.

### Rules

| Area              | Rule                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Declaration**   | `setupAgent`/`createAgentSchemas` register `'@agent.usage'` and its payload schema in every agent's events, so the handler is typed (`event.usage.totalTokens` narrows) with nothing to declare. Declaring it yourself is an error: the `@agent.` namespace is reserved.                                      |
| **Opt-in**        | Delivered only when an active state declares a `'@agent.usage'` transition **explicitly**. Declare none and nothing changes: no transition, no trace event, no event-log entry. A catch-all `on: { '*': … }` never receives it, so a wildcard machine is byte-identical to a run without the feature.         |
| **Placement**     | Declare it machine-level. A root `on: { '@agent.usage': … }` catches every call whatever state made it; a state-scoped handler silently drops calls made elsewhere.                                                                                                                                          |
| **Not model-facing** | The `@agent.*` namespace is excluded from `getAcceptedEvents` and `parseAgentEvent`, so it is never a decision candidate (not even under `allowedEvents: ['*']`) and cannot be forged from a wire message.                                                                                                |
| **Durability**    | Journaled like any other external input, so events-only recovery (`runAgent({ events })`) replays the folded tokens without re-calling a model.                                                                                                                                                              |
| **Spend records** | The cost already happened when the event is reported, so entries are append-only facts. Replay folds every one, and a call re-executed by crash recovery journals its own usage on top. A recovered total reflects true cumulative cost, including the call whose result the crash lost. You really did spend it. |
| **Stragglers**    | A call settling after the run's cycle resolved (idle settle, `done`/`error` settle, abort) still folds into `result.usage`, but its machine event is dropped, on both `runAgent` and `createAgentActor`, so a late arrival cannot re-open a returned idle result. Watch `usage.dropped` on `onTrace` if a counter looks short. |
| **Scope**         | Delivered to the run's root machine, including usage from requests inside an invoked child machine. Attribute those with `id`/`src`/`model`.                                                                                                                                                                 |
| **Coverage**      | Only what your executor reports. No `usage` on the result means no event. [`simulateAgent`](verify.md) scripts return no usage, so a token counter stays `0` under simulation: test budgets with `runAgent` and a usage-reporting mock.                                                                       |

Opt in with a transition:

```ts no-check
import { AGENT_USAGE_EVENT_TYPE, setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({ schemas });

const machine = agentSetup.createMachine({
  // …context, states
  on: {
    // Typed from the default registration: `event.usage`, `event.kind`, …
    [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
      context: { tokens: context.tokens + (event.usage.totalTokens ?? 0) },
    }),
  },
});
```

## Budgets as guards

A budget is data, not a runtime feature:

- **Limits enter via `input`** and land in `context` (`maxTurns`, `maxTokens`, `maxDollars`).
- **Counters live in `context`**, folded in by the transitions that carry the data.
- **Guards are ordinary transition functions**: over budget, return a transition into a final `outOfBudget` state, or return `undefined` so the expensive event is not takeable at all.

Nothing here is agent-specific. It is the same [guard](machines.md#transitions) mechanism the rest of the machine uses, which is why it composes with decisions: a candidate event whose transition returns `undefined` is never offered to the model.

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
});

const agentSetup = setupAgent({ schemas, actors: { researchStep } });

const machine = agentSetup.createMachine({
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
        // Only the turn counter here; the tokens already arrived on their own.
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

// Scripted, keyless executor. `usage` on the result is all it takes: the same
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

### Guarding a decision

The same guard makes an over-budget choice **impossible**, not merely discouraged. An event whose transition returns `undefined` is not a legal candidate, so the model is never offered it:

```ts no-check
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

## Usage without runAgent

### Uncontrolled: `provideExecutors` + `createActor`

Delivery is built in, but it follows the binding boundary: `provideExecutors` does not descend into invoked child machines, so a child with its own agent invokes needs its own `provideExecutors(...)`; until it has one, its calls report no usage anywhere. `runAgent` rebinds children and reports their usage to the root. There is no run cycle on the [uncontrolled path](any-stack.md#controlled-and-uncontrolled), so there are no dropped stragglers either.

```ts no-check
import { createActor, toPromise } from "xstate";
import { provideExecutors } from "@statelyai/agent";

// `machine` declares `on: { '@agent.usage': … }` as above.
const actor = createActor(provideExecutors(machine, { generateText }), {
  input: { topic: "otters", maxTokens: 1500 },
});
actor.start();

const output = await toPromise(actor); // stoppedBy: 'tokens'
```

### Step path: an ordinary event

On [the step path](steps.md#token-usage-on-this-path) the host holds the raw executor result, so it normalizes it with `getCallUsage(raw)` and appends the event itself. Because the entry is journaled, `replay` reproduces the folded counter exactly.

### Plain XState: manual send

In a hand-rolled loop over `actor.send`, the event is just an event:

```ts
const result = await generateText(request);
if (result.usage) {
  actor.send({ type: "@agent.usage", usage: result.usage });
}
```

A `setupAgent` machine already declares `'@agent.usage'` in its event union. A machine built with a plain `setup()` declares it itself:

```ts
import { z } from "zod";
import { createActor, setup } from "xstate";

const machine = setup({
  schemas: {
    context: z.object({ tokens: z.number() }),
    events: {
      // The reserved type, declared by hand.
      "@agent.usage": z.object({ usage: z.object({ totalTokens: z.number().optional() }) }),
      GO: z.object({}),
    },
  },
}).createMachine({
  context: { tokens: 0 },
  on: {
    "@agent.usage": ({ context, event }) => ({
      context: { tokens: context.tokens + (event.usage.totalTokens ?? 0) },
    }),
  },
  // …states
});
```

## Cost estimation

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

```ts no-check
let spentUsd = 0;

await runAgent(machine, {
  input,
  executors,
  onTrace: (event) => {
    if (event.type !== "request.end" || !event.usage) {
      return;
    }
    // A decision carries `model` directly; a text request carries it on `input`.
    const model =
      event.request.kind === "decision" ? event.request.model : event.request.input.model;
    spentUsd += estimateCost(model, event.usage);
  },
});
```

`@agent.usage` carries the same `model` attribution, so the machine can keep a per-model spend counter in `context` and guard on it, rather than only reporting one from the host.

Cached input tokens are usually billed at a discount rather than free; subtracting them as above is a floor, not an exact invoice. Reconcile against your provider's billing and treat these numbers as budget signals.

## Legacy: usage in the request output

Before `@agent.usage`, tokens reached `context` by declaring a `usage` field on a request's own output schema and having the executor fill it. Prefer `@agent.usage`.

The old form still has two narrow uses: the tokens arrive inside `onDone`, in the same transition as the output, and they survive `simulateAgent` because a script can return them. It only works for output shapes you own, so a shared request, a third-party executor, and a decision are all out of reach.

## Related

- [Observability](observability.md): the trace stream `request.end` usage rides on.
- [Event log](event-log.md): the journal a delivered `@agent.usage` is recorded in, and replayed from.
- [Machines](machines.md#transitions): guards as return values.
- [Decisions](decisions.md): why a guarded-out event is never offered to the model.
- [Human in the loop](human-in-the-loop.md): pausing and resuming across run boundaries.
- [Hosts](hosts.md): where executors, and executor-level budgets, are supplied.
