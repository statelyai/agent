---
"@statelyai/agent": minor
---

**New `@statelyai/agent/machines` subpath: preset machine factories.** Seven factories for the agent shapes every framework converges on, each a thin composition over `setupAgent(...).createMachine(...)` that returns an ordinary, fully inspectable machine (executors are still supplied separately to `runAgent`).

```ts
import { createToolLoopMachine } from "@statelyai/agent/machines";

const machine = createToolLoopMachine({
  model: "openai/gpt-5.4-mini",
  instructions: "Answer using the tools available.",
  maxTurns: 8,
});
const result = await runAgent(machine, { input, executors });
```

- `createToolLoopMachine({ model, instructions?, tools?, outputSchema?, maxTurns?, interruptOn? })`: one request, host-run tool loop, `maxTurns` lowered to `metadata.maxSteps`.
- `createSequentialMachine({ model, steps })`: a prompt chain, one state per step, each step's output feeding the next.
- `createRouterMachine({ model, instructions?, routes, fallback? })`: one `agent.decide` picks one declared route; undeclared routes have no event, state, or transition.
- `createParallelMachine({ model, branches })`: static fan-out, joined into a keyed result object.
- `createLoopMachine({ model, body, until, maxIterations })`: bounded repeat with a guard-enforced iteration budget.
- `createSupervisorMachine({ model, instructions?, workers, maxTurns? })`: delegate to a worker or `FINISH` each turn, results accumulating.
- `createHandoffMachine({ agents, defaultActiveAgent, model? })`: peer swarm where `transfer_to_<name>` moves the mic and control does not return.

Each preset carries `version: "1"` (XState's standard `createMachine({ version })` prop), so persisted snapshots and event logs are stamped by topology with nothing to pass — a topology change bumps the machine version (`"2"`), a minor package release at most. The `machineVersion` resolution that makes this work ships in `session-actor-crash-recovery`. See `docs/machines-presets.md` and `examples/preset-machine`.
