---
"@statelyai/agent": minor
---

**`runAgent`.** One call runs a machine to quiescence: `runAgent(machine, { input, executors })` is `runToQuiescence(createAgentRuntime(machine, options), options)` with a single options object, and returns the same `AgentRunResult`. Resume with `{ snapshot: result.persist(), event }`. A blocking host can pass `onIdle(snapshot) => Promise<event>` to answer idle states in place. `createAgentRuntime` and `runToQuiescence` are unchanged; write the loop yourself when the host is non-blocking, pushes events mid-run, or needs its own stop or checkpoint policy.

```ts
import { runAgent } from "@statelyai/agent";

const result = await runAgent(machine, { input: { topic }, executors });
if (result.status === "done") return NextResponse.json(result.output);
```
