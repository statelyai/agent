# Debugging

Use the XState inspection protocol for framework behavior and Agent traces for request behavior.

```ts no-check
const result = await runAgent(machine, {
  input,
  executors,
  inspect: (event) => inspector.next(event),
  onTrace: (event) => logger.write(serializeTraceEvent(event))
});
```

`inspect` is the raw XState stream. `onTrace` adds Agent request start/end/error, chunks, usage, emitted events, transitions, and the terminal run result.

Common errors:

| Error | Meaning |
| --- | --- |
| `AgentInvalidEventPayloadError` | A payload passed to `parseAgentEvent` was not `{ type, ... }`, used a reserved `@agent.*` type, or failed the machine's event schema. |
| `AgentDecisionExhaustedError` | Every proposed decision was unknown, invalid, or guard-rejected. |
| `AgentMaxModelCallsExceededError` | The run exceeded its configured model-call budget. |
| XState version error | The persisted snapshot version needs the machine's native `migrate` function. |

An event the active state has no transition for is not an error: the run settles normally and the event comes back as `result.ignored`.

`lintAgentMachine` reports only Agent-specific mistakes: decisions with no candidate events, direct object request sources that a host cannot bind, and returned messages with no `agent.messages` transition. General state-machine lint belongs in XState tooling.
