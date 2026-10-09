---
"@statelyai/agent": minor
---

**`getAgentSchemas(machine)` reads the schema pack a machine was built with.**

Both `setupAgent(...).createMachine(...)` and `setupAgent.fromConfig(...)` register their compiled schemas against the machine, but only the TS path handed them back to the caller. A host that receives a machine object alone — a generic runner, a UI that renders an input form — had nothing to read, and JSON-authored machines carry no `machine.schemas` to sniff.

```ts
import { getAgentSchemas } from "@statelyai/agent";

const schemas = getAgentSchemas(machine); // AgentSchemas | undefined
const event = parseAgentEvent(snapshot, raw, { events: schemas?.events });
```

Returns `undefined` for machines not built by `setupAgent` (a plain xstate machine). Registration is keyed on the machine object, so read it from the machine the setup returned, not from a `machine.provide(...)` result. `AgentSchemas` is now exported as a type.
