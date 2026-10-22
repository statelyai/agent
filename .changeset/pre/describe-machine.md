---
"@statelyai/agent": minor
---

**`describeMachine`.** `describeMachine(machine, { snapshot? })` renders any machine, from a config or from TypeScript, as deterministic plain text for a model to read: `Machine <id>`, then `Goal: <description>`, then every state with its transitions (guard, target, context keys set), then the event schemas with their fields (the agent machine's, or a plain XState machine's own `schemas.events`). Pass `snapshot` to mark the active states with `*`. Use it as the prompt for a model that proposes an improved machine, or as context for a decider.

```ts
import { describeMachine } from "@statelyai/agent";

const prompt = `Propose an improved machine for this goal.\n\n${describeMachine(machine)}`;
```
