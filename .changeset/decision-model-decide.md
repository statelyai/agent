---
"@statelyai/agent": minor
---

**`createDecisionModelDecide`.** `@statelyai/agent/ai-sdk` adds a `decide` executor backed by an AI SDK decision model, such as TypeSafe's Jev, through `experimental_decide`. It asks one `choice` question over the request's closed-choice `options` and maps the answer back to the option's event.

- `instructions` defaults to the request's `system` and `prompt`; `state` defaults to `request.input`.
- A label that is not an option is retried like any failed choice.
- `minConfidence` throws below that confidence: the escalation signal. Route it through the invoke's `onError`, or catch it at the boundary.
- A request without `options` throws. Pass `payloads` on `agent.decide`, or use `decideNext`.

```ts
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createDecisionModelDecide } from "@statelyai/agent/ai-sdk";

const decide = createDecisionModelDecide(typeSafeAi.decisionModel("jev-latest"), {
  minConfidence: 0.6,
});
```
