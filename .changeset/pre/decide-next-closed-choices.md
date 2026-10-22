---
"@statelyai/agent": minor
---

**Closed choices and `decideNext`.** A decision can list the concrete events a model may pick instead of asking it to write a payload.

- `agent.decide` input `payloads`: one payload list per event type, without `type`. Each payload becomes an `AgentDecisionOption` on `request.options`; an event type with no `payloads` key is offered as `{ type }`, and an empty list (`escalate: []`) withholds it. Only options the snapshot accepts are offered, and a choice that matches none is retried as `rejected-by-guard`. When the snapshot accepts no option, the invoke fails at once with `AgentDecisionExhaustedError` (no attempts, no model call), which its `onError` handles.
- `createAiSdkExecutors` presents a closed choice as one `choose_option` tool whose input is an enum of option ids such as `refund:20`. An id that is not offered, or a call to another tool, is retried, with the valid ids in the attempt's reason.
- `decideNext(snapshot, options)` asks a model to pick one event that any XState snapshot accepts now, including a plain `createMachine`/`setup` machine with no `agent.*` invoke. It takes `decide`, `model`, `allowedEvents` (exact types or wildcards), and optional `payloads(snapshot)`, `lookahead` (describe each option's state and context change; `true` reports every changed context key, an array of keys reports only those, and each value is cut at 120 characters), `system`, `prompt`, `name`, `maxRetries`, and `signal`. It returns `{ event, attempts, request }` and never sends: the host sends after re-checking `can`.

```ts
import { decideNext } from "@statelyai/agent";

const { event } = await decideNext(snapshot, {
  decide,
  model: "quick",
  allowedEvents: "desk.*",
  payloads: (s) => ({ "desk.refund": [{ amount: s.context.requested }] }),
  lookahead: true,
});
if (event && actor.getSnapshot().can(event)) actor.send(event);
```
