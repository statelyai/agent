---
"@statelyai/agent": minor
---

**Token budgets are now ordinary state machine logic.** Every settled model call that reports usage delivers a reserved `@agent.usage` event to the running machine, so spend lives in context and a budget is just a transition.

```ts
const machine = setup.createMachine({
  // Declaring the transition IS the opt-in; `event.usage` is typed already.
  on: {
    "@agent.usage": ({ context, event }) => {
      const tokens = context.tokens + (event.usage.totalTokens ?? 0);
      return tokens > 50_000 ? { target: ".done", context: { tokens } } : { context: { tokens } };
    },
  },
  // ...
});
```

- Delivered after every settled text, decision, and plan-step call as `{ type: '@agent.usage', usage, kind, id, src, model, name }`. New `AGENT_USAGE_EVENT_TYPE` constant and `AgentUsageEvent` type.
- `setupAgent` / `createAgentSchemas` / `setupAgent.fromConfig` register `'@agent.usage'` **by default**, so the handler autocompletes and `event.usage` types with nothing declared. It also shows up in `schemas.events` for hosts introspecting the pack.
- **Delivery is gated on an explicit transition.** The event is sent only when an active state declares `'@agent.usage'` by name. A catch-all `on: { '*': … }` does not count and never receives it; a machine with no handler sees no extra transition, trace event, or log entry. Declare it machine-level to catch every call.
- **Breaking: `@agent.` is a reserved namespace.** Declaring `'@agent.usage'` in your own `events` throws. Hosts cannot send into the namespace either — `parseAgentEvent` rejects it and `getAcceptedEvents` drops it before `allowedEvents` matching, so `@agent.usage` and `@agent.init` are never decision candidates (not even under a `'*'` wildcard). Rename any event of yours starting with `@agent.`.
- **Usage entries are spend records.** When the event is reported the cost already happened, so entries are durable, append-only facts — there is no dedupe or rollback. Replay folds every one, and a call re-executed by crash recovery journals its own usage on top, so a recovered total covers both the lost call and its retry. That is the true cumulative spend.
- A call that settles after the run's cycle resolved is a straggler: its tokens still fold into `result.usage`, but the machine event is dropped (identically on the `runAgent` and `createAgentActor` paths) and surfaced on `onTrace` as `usage.dropped`.
- Usage from a request inside an invoked child machine reports to the run's root machine, attributed by `id`/`src`/`model`.
- Scripted `simulateAgent` runs report no usage, so a counter stays `0` under simulation. Test the budget itself with a usage-reporting mock executor.
- **Works without `runAgent`.** On the uncontrolled `provideExecutors` path the event reaches the machine actor that invoked the bound request, with the same explicit-declaration gate; delivery follows `provideExecutors`' binding boundary, so an invoked child machine needs its own `provideExecutors(...)`. On the step path, new root export `getCallUsage(raw)` normalizes a raw executor result's usage so a host can journal the event itself (the typed event union carries the attribution fields alongside `usage`). See the "Usage without runAgent" docs section.
