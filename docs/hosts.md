# Hosts and executors

The machine owns agent control flow. A host supplies model request executors.

```ts no-check
const result = await runAgent(machine, {
  input,
  executors: {
    generateText: async (request, { signal }) => {
      const response = await mySdk.generate({
        model: request.model,
        prompt: request.prompt,
        signal
      });
      return { output: response.text, messages: response.messages };
    }
  }
});
```

Text, stream, and decision executors all receive `(request, info)`; cancellation is `info.signal`.

## Optional AI SDK default

```ts no-check
import { defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({ fast: openai("gpt-5.4-mini") });
const agent = setupAgent({ models, /* schemas and requests */ });

await runAgent(machine, { input });
```

A registry created by `defineModels` carries an optional AI SDK executor factory. Explicit executors merge over those defaults. Core does not import or require the AI SDK at runtime.

## Uncontrolled XState actor

```ts no-check
const bound = provideExecutors(machine, executors);
const actor = createActor(bound, { input });
actor.start();
```

## One request

`executeAgentRequest` runs an individual typed request. It is useful in evals and raw SDK adapters without inventing a second machine lifecycle.

Framework-owned concerns—storage, durable execution, retries, queues, and tool-loop interruption recovery—remain with the framework.
