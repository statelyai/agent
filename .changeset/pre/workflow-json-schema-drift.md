---
"@statelyai/agent": patch
---

**`schemas/agent-workflow.json` now matches what `setupAgent.fromConfig(...)` actually accepts.** The published schema had drifted, rejecting valid configs and accepting ones the lowering throws on. `src/workflow-config-schema.test.ts` validates it against the JSON agent example plus a config exercising every fixed area.

- **`guard` accepts a bare named-guard string**: `guard: "isFromHuman"` (resolved against `fromConfig`'s `guards`) was runtime-supported but schema-invalid. The `{ type, params }` object form — which the lowering throws on — was schema-valid; it is now removed.
- **Root `actors` added**: placeholder actor sources were supported by the type and the lowering but absent from the schema, so `additionalProperties: false` rejected valid configs.
- **`requests.*.reasoning` added** (structured-output envelope opt-in).
- **Tool schemas renamed to `inputSchema` / `outputSchema`**, matching `AgentToolDescriptor` (the schema had `input` / `output`).
- **`toolChoice` no longer accepts a `{{ }}` expression**: it is passed to the provider verbatim, never template-evaluated.
- **`invoke.meta` removed**: the translation drops it (xstate's `InvokeJSON` has no `meta`), so the schema no longer advertises it.
- **State and transition `meta` are plain JSON**, not expression objects: both pass through verbatim without template evaluation.
