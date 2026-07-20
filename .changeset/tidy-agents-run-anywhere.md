---
"@statelyai/agent": patch
---

DX pass: one `runAgent`, first-class uncontrolled mode, trimmed surface.

- **Breaking:** `@statelyai/agent/ai-sdk` no longer exports `runAgent` or `createAgent`. It is adapters-only (`defineModels`, `createAiSdkExecutors`). Use core `runAgent(machine, { input, executors: createAiSdkExecutors({ models }) })`; mix adapters by spreading executor sets.
- **Breaking:** adapter-internal mappers (`toAiSdkTools`, `toAiSdkCallSettings`, `toAiSdkToolChoice`, `toAiSdkEventTools`, `toDecisionMessages`, `isStructuredOutputRequest`, `extractFirstJsonValue`, `toOpenAiMessages`, `toOpenAiCallSettings`, `toOpenAiTools`, `toOpenAiEventTools`) are no longer exported. `extractJsonSchema` stays.
- **New:** `provideExecutors(machine, executors, options?)` binds every agent actor source in one call, returning a machine ready for a plain `createActor(...)` — the uncontrolled-mode counterpart to `runAgent`.
- Text requests now fail fast when both `prompt` and `messages` are missing.
- **Fix:** `setupAgent.fromConfig` no longer silently drops transition-level `actions` (emits and assigns on transitions now fire).
- `setupAgent.fromConfig` now rejects invalid transition targets and `onDone` on `agent.decide` invokes at build time; `lintAgentMachine` warns on undeclared `on:` events (`undeclared-event`).
- A decide executor returning a malformed result now throws a descriptive error instead of routing silently into `onError`.
- `agent-workflow.json` schema: accepts a root `$schema` key; removed the unimplemented `queryLanguage` property; CLI usage no longer advertises the unimplemented `--no-schemas` flag.
