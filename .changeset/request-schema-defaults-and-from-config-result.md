---
"@statelyai/agent": minor
---

**Text requests no longer need `output: z.string()` on every plain request, and `setupAgent.fromConfig` now returns `{ machine, schemas }`.**

```ts
const draft = createTextLogic({
  schemas: { input: z.object({ topic: z.string() }) }, // output defaults to string
  model: "openai/gpt-5.4-mini",
  prompt: ({ input }) => `Draft about ${input.topic}.`,
});
```

- A text request's `schemas.output` is now optional and defaults to a string schema. `schemas.input` is optional too — a request that declares none takes no invoke `input`. `onDone`'s `output` still infers exactly: `string` when `output` is omitted, the schema's type when present.
- `setupAgent({ requests })` entries keep their `schemas` key (use `schemas: {}` for a request with neither) — an entry dropping it entirely defeats the map's type inference, so it stays a compile error. Standalone `createTextLogic(...)` configs may omit `schemas` outright.
- **Breaking (alpha):** `setupAgent.fromConfig(config, options)` returns `{ machine, schemas }` instead of the bare machine. Update call sites to `const { machine } = setupAgent.fromConfig(...)`. `schemas` is the compiled `AgentSchemaPack` (`context`, `events`, `input`, `output`, `meta`, `emitted`) — a JSON-authored agent has no TypeScript types, so hosts need it at runtime, e.g. `parseAgentEvent(snapshot, raw, { events: schemas.events })`.
