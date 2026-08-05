---
"@statelyai/agent": minor
---

**Machine input is validated against its schema, and defaulted fields are optional at the call site.**

XState's `schemas` are types only — it never validates, and it resolves `schemas.input` to one type shared by `createActor`'s `input` option and the `context: ({ input })` factory. A field declared with a default was therefore both absent at runtime and required at the call site.

`runAgent`/`createAgentActor` now validate `options.input` against the machine's declared input schema before the actor starts: defaults are filled and transforms applied, and the resolved value is what reaches the actor, the replayable event log, and the `run.start` trace — so a replay reproduces the run even if a default is computed. Invalid input throws an `AgentError` with code `invalid-machine-input` (like a mismatched resume snapshot; the actor never starts). Omitting `input` entirely still skips validation.

```ts
const agent = setupAgent({
  schemas: createAgentSchemas({
    context: z.object({ topic: z.string(), rounds: z.number() }),
    input: z.object({ topic: z.string(), rounds: z.number().default(3) }),
  }),
});

const machine = agent.createMachine({
  // `rounds` arrives filled in — no `?? 3` restating the default here
  context: ({ input }) => ({ topic: input.topic, rounds: input.rounds }),
  // ...
});

// `rounds` is optional at the call site; `topic` (no default) is not
await runAgent(machine, { input: { topic: "otters" } });
```

Standard Schema throughout — no validation library is referenced, so this works with whatever the machine was declared with.

Types: `runAgent`'s `input` is now `AgentInputFrom<TMachine>`, which reads the schema's pre-validation side (`~standard.types.input`) while the context factory keeps the validated side. Machines reached through `.provide(...)` lose the brand and fall back to xstate's `InputFrom`. New exported type helpers: `AgentInputFrom`, `InferInput`.
