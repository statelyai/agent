---
"@statelyai/agent": minor
---

**Text-request schema defaults + `setupAgent.fromConfig` returns `{ machine, schemas }`.**

- A text request's `schemas.output` is now optional and defaults to a string schema, so `output: z.string()` no longer has to be repeated on every plain text request. `schemas.input` is optional too — a request that declares none takes no invoke `input`. `onDone`'s `output` still infers exactly: `string` when `output` is omitted, the schema's type when it is present.
- `setupAgent({ requests })` entries keep their `schemas` key (use `schemas: {}` for a request with neither) — an entry that drops it entirely defeats the map's type inference, so it stays a compile error. Standalone `createTextLogic(...)` configs may omit `schemas` outright.
- **Breaking (alpha):** `setupAgent.fromConfig(config, options)` now returns `{ machine, schemas }` instead of the bare machine. `schemas` is the compiled `AgentSchemaPack` (`context`, `events`, `input`, `output`, `meta`, `emitted`) — a JSON-authored agent has no TypeScript types, so hosts need it at runtime, e.g. `parseAgentEvent(snapshot, raw, { events: schemas.events })`. Update call sites to `const { machine } = setupAgent.fromConfig(...)`.
