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
| `AgentIllegalResumeEventError` | The restored active state does not accept the supplied event type. |
| `AgentDecisionExhaustedError` | Every proposed decision was unknown, invalid, or guard-rejected. |
| `AgentMaxModelCallsExceededError` | The run exceeded its configured model-call budget. |
| XState version error | The persisted snapshot version needs the machine's native `migrate` function. |

`lintAgentMachine` reports only Agent-specific mistakes: decisions with no candidate events, direct object request sources that a host cannot bind, and returned messages with no `agent.messages` transition. General state-machine lint belongs in XState tooling.
