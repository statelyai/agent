---
title: Usage and budgets
description: Read token usage off a run, cap runaway loops with maxModelCalls, and enforce turn and token budgets as ordinary machine guards.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers how to read token usage from a run and how to enforce budgets on it.

## Overview

Usage is available at three layers, listed from coarsest to finest.

- After the run, `result.usage` gives the aggregated model-call usage for that run.
- During the run, on the host side, `onResult` and `onTrace` see each call's usage as it lands.
- During the run, on the machine side, the reserved `@agent.usage` event delivers each call's tokens to the machine. Budgets then live in `context` and are enforced by ordinary guards.

The first two layers are observational. Only the third can change what the agent does.

<!-- viz: usage flow: executor result -> runAgent aggregation into result.usage, -> onResult/onTrace on the host, -> @agent.usage event into machine context and guards -->

## The usage result

<!-- AgentUsage from src/text-logic.ts; aggregation in src/run-agent.ts -->

Every settled `RunAgentResult` carries `usage`, on all three variants: `done`, `idle`, and `error`.

```ts
const result = await runAgent(machine, { input, executors });

result.usage.modelCalls; // number, always present
result.usage.totalTokens; // number | undefined (only calls that reported it)
```

| Field                                                                                | Meaning                                                                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `modelCalls`                                                                         | Model and decision calls this run made. Always a number. Each decision retry counts separately. |
| `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens` | Partial sums. See the notes below.                                                              |

Four things affect how you read these numbers.

- Token fields are partial sums. Each field sums only the calls that reported it, and is `undefined` only when no call reported it. A run that mixes a real SDK executor, which reports usage, with a scripted mock, which does not, yields a sum over the reporting subset only. Do not treat a token total as the whole run unless every executor reports usage.
- `modelCalls` is always present, even when nothing reports tokens.
- Usage is per run, not per conversation. A resumed run counts only its own calls, not the history behind `snapshot` or `events`. Add prior results' totals yourself for a conversation-wide figure.
- Usage comes from your executor. `runAgent` reads `usage` from the raw executor result. That can be the `{ output, usage }` envelope, a Vercel AI SDK result, which uses the same flat field names, or any custom executor following that shape. Non-finite values are dropped.

### Billing

`result.usage` is the authoritative record of what a run spent. Usage folds into the totals before the machine is involved, so a call counts even when its `@agent.usage` event is never delivered. A straggler that settles after the run resolved counts, and so does a call whose event no active state accepts. Only the machine event is dropped, and the drop is traced as `usage.dropped`. Counters in `context` are control flow, not billing: they only see the calls the machine reacted to.

Two caveats apply.

- `modelCalls` counts only calls admitted by the budget. A call rejected by `maxModelCalls` is not counted, because it was never made.
- Usage covers this run only. A resumed run does not re-add the history behind `snapshot` or `events`.

Summing across a resume chain is host code.

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

Two callbacks report usage per call. Both are live and read-only.

- `onResult(request, { output, raw })`: `raw` is your executor's verbatim result, so `raw.usage` is that call's usage in whatever shape the executor produced.
- `onTrace` on a `request.end` event: `usage?: AgentCallUsage` is normalized, and present only when the executor reported usage. See [Observability](observability.md#the-versioned-trace-stream).

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

Use these for dashboards, per-tenant metering, and cost alerts. Neither can stop the run. To deliver usage to the machine, use [`@agent.usage`](#the-agentusage-event).

## The global backstop: `maxModelCalls`

`maxModelCalls` caps the number of model and decision calls one run may make. The default is `100`. Decision retries count separately.

```ts
const result = await runAgent(machine, { input, executors, maxModelCalls: 20 });

if (result.status === "error" && result.cause === "max-model-calls") {
  result.usage.modelCalls; // 20
  result.snapshot; // resume from here after raising the cap
}
```

- The overrun is thrown into the invoke that would have made the call, as an `AgentMaxModelCallsExceededError` with `code: 'max-model-calls'`. If nothing handles it, the run settles as `{ status: 'error', cause: 'max-model-calls' }`, with `usage`, `snapshot`, and `events` intact.
- An `onError` on that invoke catches the overrun like any other failure. Branch on the code to route the budget breach separately from a model or tool failure.
- A blanket `onError: { target: 'someState' }` also catches the overrun, so the run settles `done` at the cap instead of `error`. That is a valid choice, as long as it is deliberate.
- `maxModelCalls` counts calls, not tokens or dollars. It is host-owned, so the machine cannot read how much budget is left.

```ts no-check
onError: [
  {
    guard: ({ event }) => event.error?.code === "max-model-calls",
    target: "budgetSpent",
  },
  { target: "failed" },
];
```

Use `maxModelCalls` as a runaway-loop backstop. Put anything the machine's own logic should react to in a guard.

## Retries and executor budgets

Transport-level retries, such as retries for 429 responses, timeouts, and backoff, belong in the executor or the SDK it wraps, not in the machine. The AI SDK's `maxRetries` handles them, as do the equivalent options on the OpenAI and Anthropic clients. `maxRetries` keeps AI SDK semantics: it is the number of retries made after the first attempt, so `maxRetries: 2` allows up to three attempts. A raw-`fetch` executor adds its own loop. The machine never sees a transient network failure.

Machine-level retry is different. An authored `onError` transition that re-enters a state after a semantic failure, such as a validation rejection or an exhausted decision, is control flow you model explicitly.

For finer budgets than `maxModelCalls`, such as a token cap or a per-request-`src` call count, wrap the executors. A child machine's requests inherit the parent's executors, so one wrapper counts the whole tree.

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

A wrapper is still host-side. The machine cannot read the remaining budget or react to it. For that, use `@agent.usage` and a guard.

## The `@agent.usage` event

<!-- AGENT_USAGE_EVENT_TYPE and AgentUsageEvent from src/effects.ts -->

`@agent.usage` is a reserved event that carries one model call's tokens into the machine. Four rules govern it.

- You declare nothing. `setupAgent` and `createAgentSchemas` register `'@agent.usage'` and its payload schema in every agent's events, so the handler is typed and `event.usage.totalTokens` narrows. Declaring it yourself is an error, because the `@agent.` namespace is reserved.
- Delivery is opt-in. The event is delivered only when an active state declares a transition that matches it, either `'@agent.usage'` or the wildcard `'*'`. If no active state declares one, there is no transition, no trace event, and no event-log entry. Wildcard matching follows XState semantics, so a catch-all `on: { '*': … }` does receive `@agent.usage`. Narrow the handler on `event.type` when the catch-all is meant for other events.
- Declare the handler at machine level. A root `on: { '@agent.usage': … }` catches every call regardless of which state made it. A state-scoped handler drops calls made in other states.
- Delivery goes to the run's root machine, including usage from requests inside an invoked child machine. Attribute those calls with `id`, `src`, and `model`.

The payload has this shape.

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

### Why the event exists

Model-call results reach the machine with usage stripped out.

- A text invoke's `onDone` receives the normalized output only. The runner returns `{ output }` and drops the rest of the executor envelope (`src/run-agent.ts`).
- A decision delivers only the chosen event. `resolveDecision` returns the validated event and drops the executor's `usage` (`src/decision.ts`).

`@agent.usage` carries the tokens instead. After every settled model call that reported usage, `runAgent` delivers the event to the machine, so `context` can fold it and guards can read it. You can then keep both counters in `context`: increment turns in `onDone`, and fold tokens in the `@agent.usage` handler.

### Rules

| Area                 | Rule                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not model-facing** | The `@agent.*` namespace is excluded from `getAcceptedEvents` and `parseAgentEvent`. The event is never a decision candidate, even under `allowedEvents: ['*']`, and cannot be forged from a wire message.                                                                                         |
| **Durability**       | The event is folded into machine context, so a native snapshot from `result.persist()` retains the counters when a later `runAgent({ snapshot })` resumes.                                                                                                                                         |
| **Spend records**    | The cost is already incurred when the event is reported, so entries are append-only facts. Replay folds every entry, and a call re-executed by crash recovery journals its own usage on top. A recovered total therefore reflects cumulative cost, including the call whose result the crash lost. |
| **Stragglers**       | A call that settles after a `runAgent` leg resolved still folds into `result.usage`, but its machine event is dropped. Watch `usage.dropped` on `onTrace` if a counter looks short.                                                                                                                |
| **Coverage**         | Only usage your executor reports is delivered. No `usage` on the result means no event. [`simulateAgent`](verify.md) scripts return no usage, so a token counter stays `0` under simulation. Test budgets with `runAgent` and a usage-reporting mock.                                              |

Opt in with a transition.

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

A budget is data in `context`, not a separate runtime feature.

- Limits enter through `input` and land in `context`, as fields such as `maxTurns`, `maxTokens`, and `maxDollars`.
- Counters live in `context` and are folded in by the transitions that carry the data.
- Guards are ordinary transition functions. When over budget, return a transition into a final `outOfBudget` state, or return `undefined` so the expensive event cannot be taken at all.

None of this is agent-specific. It is the same [guard](machines.md#transitions) mechanism the rest of the machine uses, so it composes with decisions. A candidate event whose transition returns `undefined` is never offered to the model.

### Turn and token budget

A machine-level `@agent.usage` handler folds every call's tokens into `context`. An ordinary guard stops the loop when the budget is spent.

<!-- viz: budget machine: researching -> checkingBudget -> researching loop, exiting to final outOfBudget when turns or tokens exceed their limits, with @agent.usage folding tokens at machine level -->

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
  // Machine-level, so every model call's tokens are folded.
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
        // Tokens arrive through `@agent.usage`, so only turns are folded here.
        onDone: ({ context, output }) => ({
          target: "checkingBudget",
          context: { notes: [...context.notes, output], turns: context.turns + 1 },
        }),
        // No onError, so a maxModelCalls overrun surfaces as the run's error
        // result instead of being handled here.
      },
    },
    checkingBudget: {
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

// Scripted, keyless executor. Returning `usage` is what feeds `@agent.usage`.
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

Two details of this shape matter.

- The loop runs `researching -> checkingBudget -> researching`. A transition targeting its own state does not re-enter it, so a self-targeting `onDone` would not re-run the invoke. Route through a check state instead.
- The tokens land between the call settling and its `onDone`, so `checkingBudget` always reads a counter that includes the most recent call.

### Guarding a decision

The same guard removes an over-budget choice from the decision entirely. An event whose transition returns `undefined` is not a legal candidate, so the model is never offered it.

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

Delivery is built in, but it follows the binding boundary. `provideExecutors` does not descend into invoked child machines, so a child with its own agent invokes needs its own `provideExecutors(...)` call. Until it has one, its calls report no usage anywhere. `runAgent` rebinds children and reports their usage to the root. There is no run cycle on the [uncontrolled path](any-stack.md#controlled-and-uncontrolled), so no stragglers are dropped either.

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

On [the step path](steps.md#token-usage-on-this-path) the host holds the raw executor result. Normalize it with `getCallUsage(raw)` and append the event yourself. The entry is journaled, so `replay` reproduces the folded counter exactly.

### Plain XState: manual send

In a hand-rolled loop over `actor.send`, `@agent.usage` is an ordinary event.

```ts
const result = await generateText(request);
if (result.usage) {
  actor.send({ type: "@agent.usage", usage: result.usage });
}
```

A `setupAgent` machine already declares `'@agent.usage'` in its event union. A machine built with a plain `setup()` must declare it.

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

The library ships no price data and never estimates cost. Keep a price table in host code.

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

`result.usage` is aggregated across every model the run used, so a per-model figure needs per-call attribution.

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

`@agent.usage` carries the same `model` attribution, so the machine can keep a per-model spend counter in `context` and guard on it, instead of only reporting one from the host.

Cached input tokens are usually billed at a discount rather than free. Subtracting them as shown above gives a floor, not an exact invoice. Reconcile against your provider's billing and treat these numbers as budget signals.

## Legacy: usage in the request output

Before `@agent.usage` existed, tokens reached `context` by declaring a `usage` field on a request's own output schema and having the executor fill it. Prefer `@agent.usage`.

The older form still has two uses. The tokens arrive inside `onDone`, in the same transition as the output, and they survive `simulateAgent` because a script can return them. It only works for output shapes you own, so it cannot cover a shared request, a third-party executor, or a decision.

## Related

- [Observability](observability.md): the trace stream `request.end` usage rides on.
- [Persistence](persistence.md): storing the machine context that folded delivered usage events.
- [Machines](machines.md#transitions): guards as return values.
- [Decisions](decisions.md): why a guarded-out event is never offered to the model.
- [Human in the loop](human-in-the-loop.md): pausing and resuming across run boundaries.
- [Hosts](hosts.md): where executors, and executor-level budgets, are supplied.
