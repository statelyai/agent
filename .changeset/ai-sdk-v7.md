---
"@statelyai/agent": minor
---

**AI SDK v7.** The `ai` peer dependency is now `^7`, paired with `@ai-sdk/openai@^4`.

The structured-output envelope opt-in is now `includeReasoning`, on `createTextLogic`, on `AgentTextRequest`, and in `agent-workflow.json`. AI SDK v7 repurposed `reasoning` as a reasoning-effort setting, and a boolean under that name both collided with it and broke the invariant that an `AgentTextRequest` is spread-compatible with the SDK's call options — which is what lets the raw `ai` `generateText`/`streamText` functions work as executors with no adapter.

```ts
export const triageTicket = createTextLogic({
  schemas: { input: z.object({ ticket: z.string() }), output: triageSchema },
  model: "careful",
  includeReasoning: true, // was `reasoning: true`
  prompt: ({ input }) => input.ticket,
});
```

Reasoning effort itself is not a core field. What it means differs per provider — an enum for one, a thinking-token budget for another, nothing for a third — so a machine that named a level would stop being portable. It belongs to the host, alongside the API key, and a `models` entry can now carry it:

```ts
const models = defineModels({
  quick: openai("gpt-5.4-mini"),
  deep: { model: openai("gpt-5.4"), settings: { reasoning: "xhigh" } },
});

// the machine picks a persona by name, as it already did
requests: { finalReview: { model: "deep", schemas, prompt: … } }
```

The ref is the unit a machine already names and already has typed, so this gives per-request effort without putting a provider's vocabulary in the machine. Swap in a host whose map defines `deep` differently and every request follows, unedited.

`createAiSdkExecutors` also gains a top-level `settings` for a default across every call, or a function of the request for knobs that do not generalize into a persona. Settings accept anything the AI SDK's call options accept, typed against the installed `ai` version, and apply to `generateText`, `streamText`, and `decide`. They resolve least-specific first: the host's `settings`, then the ref's own, then what the request declared. `model`, the prompt fields, `tools`, and `toolChoice` are not settable in either place.

The rest of the migration is inside `createAiSdkExecutors`:

- v7 rejects `role: 'system'` inside `messages` unless the caller opts in. The adapter opts in, because an agent's messages are machine-authored server-side content, so `systemMessage()` keeps working.
- v7 moved `reasoningTokens` under `usage.outputTokenDetails` and the cached-input count under `usage.inputTokenDetails.cacheReadTokens`. The adapter folds both onto the flat fields `AgentUsage` aggregates, and passes the SDK's own shape (including `raw`) through untouched.
- `AgentToolDescriptor.description` now also accepts a function, matching a v7 tool whose description is computed per call.
