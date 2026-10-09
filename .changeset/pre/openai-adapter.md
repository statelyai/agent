---
"@statelyai/agent": minor
---

**Raw OpenAI SDK adapter.** `@statelyai/agent/openai` is a new package entry: `createOpenAiExecutors` builds the `{ generateText, streamText, decide }` executor set over the `openai` package's Chat Completions API, with no Vercel AI SDK in between. It was the `openai-sdk-host` example; the mapping now ships, and the example is just the host around it.

```ts
import OpenAI from "openai";
import { createOpenAiExecutors } from "@statelyai/agent/openai";

const executors = createOpenAiExecutors({
  client: new OpenAI(),
  resolveModel: (modelRef) => (modelRef === "deep" ? "gpt-5.4" : "gpt-5.4-mini"),
  settings: {
    deep: { reasoning_effort: "high" },
  },
});

await runAgent(machine, { input, executors });
```

`openai` is an optional peer dependency, accepted at `>=5.0.0 <8` and imported for types only — the client is injected, so the API key, base URL, and transport stay with the host.

`resolveModel` maps a machine's model ref to a real OpenAI model id, defaulting to identity. `settings` carries the provider knobs that are the host's business rather than the machine's, mirroring `createAiSdkExecutors({ settings })`: key it by model ref to give a ref a persona, or pass a function of the request. Settings merge under what the request declared, so a request that set `maxOutputTokens` still wins.

Beyond what the example did:

- A structured request that hit the token limit throws `AgentTruncatedError` with the partial text on `partialOutput`. A text request that hit it returns its text with `finishReason: 'length'`.
- Every result reports `usage` on the flat `AgentCallUsage` field names, folding `completion_tokens_details.reasoning_tokens` and `prompt_tokens_details.cached_tokens` onto `reasoningTokens` and `cachedInputTokens`, plus a `finishReason` normalized from OpenAI's `finish_reason` and the untouched response on `raw`. Streams ask for `stream_options: { include_usage: true }`, so they report usage too.
