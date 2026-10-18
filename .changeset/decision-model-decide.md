---
"@statelyai/agent": minor
---

**Decision models in the models map.** `createAiSdkExecutors` accepts an AI SDK decision model, such as TypeSafe's Jev, as a `models` entry next to the language models. A decide request whose model ref names a decision model is answered through `experimental_decide`.

- The request must be a closed choice: `payloads` on `agent.decide`, or `decideNext`. A request without `options` throws.
- It asks one `choice` question. Each option id is a label, and its criterion is the option's description, or the event as JSON when it has none. The instructions are the request's `system` and `prompt`, and the state is the request's `input`.
- A label that is not an option is retried like any failed choice.
- The result carries `confidence` when the model reports it. Branch on it in your own code.
- A text request on a decision model throws.

```ts
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const executors = createAiSdkExecutors({
  models: { desk: openai("gpt-5.4-mini"), judge: typeSafeAi.decisionModel("jev-latest") },
});
```
