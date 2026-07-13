# @statelyai/agent

## 2.0.0-alpha.3

### Minor Changes

- [`5fefcc2`](https://github.com/statelyai/agent/commit/5fefcc2ad6687861dda3b3b3380a1a929c794fe6) Thanks [@davidkpiano](https://github.com/davidkpiano)! - New keyless verification surface — lint, simulate, and explore an agent machine with no API key and no model calls. A coding agent that generates a machine can now close the loop and self-verify it.

  - **`lintAgentMachine(machine, options?)`** — static structural checks over a built machine (TS-authored or `setupAgent.fromConfig`-compiled), returning `AgentLintDiagnostic[]` (`{ code, severity, path, message }`). Checks: `unreachable-state`, `decide-without-events`, `unserializable-context`, `direct-object-src`, `final-without-output`, `missing-final`. Reachability is conservative — dynamic (function) transitions over-approximate, so it never false-flags a live state.
  - **`simulateAgent(machine, { input, script, maxSteps? })`** — a deterministic, model-free playthrough on the pure step path. The `script` supplies responses by invoke `src` (FIFO queues) for `decisions`, `text`, and `userInput`. Returns `{ status: 'done' | 'idle' | 'exhausted', snapshot, trail }`, and throws a descriptive error (naming the pending request) when the script runs dry.
  - **`explorePaths(machine, { input, maxDepth?, maxPaths?, textOutputs? })`** — enumerates decision and idle-state external-event branches, reporting reached states, per-path terminals, and a `prunedByGuard` count (guard-rejected candidates). Bounded by `maxDepth` (default 8) and `maxPaths` (default 200).
  - **`canReach(machine, statePath, opts)`** — thin wrapper over `explorePaths` returning `{ canReach, witness }` (the event sequence that reaches the state).
  - **`statelyai-agent lint <workflow.json>` CLI** — a thin binary that structure-only-lints a machine authored as data (`AgentWorkflowConfig` JSON), exiting `1` on any error-severity finding. The library bundles no JSON Schema engine, so the CLI compiles with a permissive pass-through compiler; use the API with a real compiler for full schema-aware linting.

  New exported types: `AgentLintDiagnostic`, `AgentLintSeverity`, `LintAgentMachineOptions`, `SimulationScript`, `SimulateAgentOptions`, `SimulateAgentResult`, `SimulationTrailEntry`, `ExplorePathsOptions`, `AgentPathReport`, `AgentPathTerminal`, `CanReachResult`.

- [`9f626be`](https://github.com/statelyai/agent/commit/9f626be042ab83d7f0e41af0bb2bb57fc1de29ea) Thanks [@davidkpiano](https://github.com/davidkpiano)! - New core exports and a `@statelyai/agent/zod` subpath, plus the uniform structured-output envelope.

  - **`tools` accepts SDK-native tool objects** — a request's `tools` entry is now a minimal **structural contract** (`description?`, `inputSchema?`, `outputSchema?`, `execute?`, plus any extra fields), so an AI SDK `tool({...})`, an MCP-style descriptor, or a plain object all drop in with no wrapper and no cast — the SDK you built the tool with owns its `execute(input, options)` typing. Extra fields (`providerOptions`, `toModelOutput`, …) pass through untouched. The `ai-sdk` adapter detects a tool that already carries its own Standard Schema `inputSchema` and hands it to the SDK **unchanged** (its validation/`execute`/extras survive); `openai-compat` and raw hosts read only `description`/`inputSchema` and ignore the rest. New exported guard **`isStandardSchema(value)`** and type **`AgentToolSchema`** support this. **Breaking:** the `defineTool(...)` helper is removed — use your SDK's tool constructor (e.g. `import { tool } from 'ai'`) or a plain descriptor instead.
  - **Uniform structured-output envelope** — every structured request (object, array, or union output schema) is now sent to the provider wrapped as a root object `{ result: <schema> }` — THE wire contract for structured output. A root object is universally accepted, so a bare `z.union`/`z.discriminatedUnion` or array root that many providers reject as a response schema now works transparently: the `ai-sdk` and `openai-compat` adapters (and the raw OpenAI/Anthropic example hosts) build the envelope for the provider call and unwrap `.result` before validation, so user-facing output types stay the bare declared schema. New exported helper `buildEnvelopeSchema(schema, { reasoning? })` and `StructuredOutputEnvelope` type build/type it for custom hosts. (Replaces the previous top-level-union-only `isTopLevelUnionSchema`/`wrapResultSchema` helpers, which are removed.)
  - **Reasoning opt-in** — set `reasoning: true` on a structured request (`createTextLogic`/`setupAgent({ requests })`/`AgentTextRequest`) to add an optional string `reasoning` field to the envelope, listed before `result` so property order nudges the model to reason first. The reasoning is surfaced on the raw executor result (`AiSdkGenerateResult.reasoning`), via `runAgent`'s `onResult` raw, and as a `reasoning` field on the `request.end` `onTrace` event — never in machine context/output. Ignored for text-mode requests.
  - **`getJsonSchema(schema)` / `getJsonSchemaSync(schema)`** — pull the JSON Schema off a `StandardSchemaV1` via its `~standard.jsonSchema.input()` extension (async/sync split; sync returns `undefined` for async producers). The `openai-compat` adapter's internal extraction now delegates to these.
  - **`renderDecisionAttempts(request)`** — the transport-agnostic "render prior failed decision attempts as feedback messages" logic, returning `AgentMessage[]`. Both shipped adapters now build their retry feedback from it.
  - **`parseAgentEvent(snapshot, event, options?)`** — runtime-validates a dynamically-built `{ type, ...payload }` against a snapshot's currently-accepted events and registered payload schemas, returning the event typed as the machine's event union (recovered from the snapshot type) so meta-driven hosts drop the `event as never` cast.
  - **`@statelyai/agent/zod`** subpath (optional `zod` peer, same pattern as `ai` for `./ai-sdk`) exporting **`zodAgentMessages()`** — a `z.ZodType<AgentMessage[]>` replacing the hand-rolled `z.custom<AgentMessage[]>((v) => Array.isArray(v))` recipe.

## 2.0.0-alpha.2

### Minor Changes

- [`6d71a1e`](https://github.com/statelyai/agent/commit/6d71a1efd6863091adf2e8bd46a734486bd54742) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Breaking:** `runAgent` / `runAgentToCompletion` no longer accept flat `generateText`, `streamText`, and `decide` options. Host executors are now passed as a single nested `executors` option — the same `AgentRequestExecutors` set the step path (`executeAgentRequest` / `resolveAgentRequests`) takes:

  ```ts
  // before
  await runAgent(machine, { input, ...createAiSdkExecutors({ models }) });
  await runAgent(machine, { input, generateText, decide });

  // after
  await runAgent(machine, {
    input,
    executors: createAiSdkExecutors({ models }),
  });
  await runAgent(machine, { input, executors: { generateText, decide } });
  ```

  Every slot in `executors` is optional (`Partial<AgentRequestExecutors>`): each executor kind is still bind-time-checked only when the machine actually reaches a request of that kind, so e.g. a stream-only machine may pass `executors: { streamText }` alone. `userInput` stays a top-level option.

- [`ec4e022`](https://github.com/statelyai/agent/commit/ec4e022b5530e13318e7fcb4ee3eeaa4fe41dd4f) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Run-to-completion helper, snapshot version stamping, and observation/store ergonomics:

  - **`runAgentToCompletion(machine, options)`**: wraps `runAgent` for run-to-done flows and returns the machine's output directly. A `done` result resolves with `result.output`; an `idle` result throws `AgentIdleError` (carrying the idle `snapshot` and the `acceptedTypes` that could resume it); an `error` result rethrows the underlying `Error`, or wraps a non-`Error` in an `Error` whose `.cause` is the `RunAgentErrorCause` and `.error` the raw value. Use `runAgent` directly when idle is expected.
  - **Snapshot version stamping.** Every settled result's `snapshot` (and `persistedSnapshot` when present) now carries a plain, JSON-safe `agentMeta: { machineId, version }` field. `version` defaults to `getMachineStructuralHash(machine)` — a new exported, dependency-free hash over the machine's structure (state ids/nesting, transition event types + targets, invoke srcs, `initial`), ignoring functions/prompts — or an explicit `options.machineVersion`. On resume, a mismatched incoming stamp is handled per `options.onVersionMismatch` (`'throw'` default → `SnapshotVersionMismatchError` with `from`/`to`, `'warn'`, `'ignore'`) or via `options.migrateSnapshot(snapshot, { from, to })` (its return value is resumed from). Unstamped snapshots are always accepted.
  - **`inspectTransitions(handler)`**: wraps `runAgent`'s `inspect` option — filters the system-wide inspection stream to `@xstate.transition` events and hands the handler the typed snapshot + actorRef (with `id`/`src`), for attributing invoked child machines. New `InspectedActorRef` type.
  - **`AgentSnapshotStore`** type-only export: the shared `load(id)`/`save(id, snapshot)` contract so userland snapshot stores interoperate. Zero runtime.

## 2.0.0-alpha.1

### Major Changes

- [#67](https://github.com/statelyai/agent/pull/67) [`e46fc52`](https://github.com/statelyai/agent/commit/e46fc52d999ee66ac869b686d2f8cfe3570c84f9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Breaking: canonical `{ output }` executor envelope, optional `generateText` on `runAgent`, and unified `onChunk`.

  - **Executors must return `{ output }`.** A `generateText`/`streamText` executor (and a `TextLogic` `.withExecutor(...)` callback) must now return an envelope `{ output: <value> }`, where `output` is the text string or structured object. Optional passthrough fields (usage, toolCalls, finishReason, raw, ...) are allowed alongside `output`. The old silent unwrapping of `object` / `text` / bare values is removed: a non-envelope return is a runtime error naming the request id ("executors must return { output }"). `withExecutor` is typed from the logic's output schema, so `{ output: T }` is inferred and a wrong shape is a compile error. `createAiSdkExecutors` now returns `{ output }` from both `generateText` and `streamText`.
  - **`generateText` is optional on `runAgent`.** A machine with only plain actors (no text or decision request) runs with zero executors. A missing `generateText`/`streamText`/`decide` remains a loud bind-time error when the machine actually invokes an unbound text/decision source.
  - **`onChunk` is unified to `(chunk, { request })`** across `runAgent` and the AI SDK per-actor streaming wrappers.

- [#67](https://github.com/statelyai/agent/pull/67) [`e46fc52`](https://github.com/statelyai/agent/commit/e46fc52d999ee66ac869b686d2f8cfe3570c84f9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Breaking: `setupAgent({ actorSources })` rename and open model refs.

  - **`setupAgent({ actors })` is now `setupAgent({ actorSources })`.** The config key that registers actor source implementations is renamed to match XState v6's `setup({ actorSources })` and the already-correct `machine.provide({ actorSources })` / `runAgent(machine, { actorSources })`. The step-helper options key is renamed the same way: `initialAgentStep`/`transitionAgentStep`/`resolveAgentStep`/`getMachineAgentRequests`/`getAgentRequests` now take `{ actorSources }` instead of `{ actors }`. The runtime collision guard between `actorSources` and `requests` keeps working, with an updated message. Agent-object properties such as `agent.requests` are unchanged.
  - **Model refs are open strings.** A request's `model:` field accepts any string. When a `models` map is registered its keys still autocomplete, but any other string is legal (`AgentModelRef` widened to `(keyof TModels & string) | (string & {})`). The `models` map is optional; refs are opaque routing keys resolved by the host or the AI SDK adapter (its `models` map or `resolveModel`). Identity-map ceremony (`const models = { "x": "x" } as const`) is no longer needed for bare refs.

### Minor Changes

- [#67](https://github.com/statelyai/agent/pull/67) [`4953d4c`](https://github.com/statelyai/agent/commit/4953d4c2cb785e370d227802ae1476f1b0eff80c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - New `agent.plan` builtin: a multi-event decision. Where `agent.decide` picks exactly one legal event, `agent.plan` applies an ordered sequence of them: each step re-reads the live snapshot, asks the `decide` executor for one legal event (same validation and `rejected-by-guard` retry loop as a decision), sends it to the machine, and repeats.

  Every step is offered a built-in done move — a reserved `agent.plan.done` candidate (`PLAN_DONE_EVENT_TYPE`). Choosing it ends the plan with `stopped: 'done'` and is never sent to the machine, so machines need no no-op sentinel event of their own. The plan also ends at `maxSteps` (default 8), when no legal candidate remains, or when an applied event exits the invoking state. `stopOn` remains for the rarer "send this real event AND stop" case (`stopped: 'stop-event'`).

  The applied trail is appended to the prompt each step. Partial application, no rollback. `onDone` output is `{ steps, stopped }`. Requires `runAgent` (snapshot-aware host); no new executor slot. See docs/decisions.md and examples/todo-nl.

- [#67](https://github.com/statelyai/agent/pull/67) [`e1ee37b`](https://github.com/statelyai/agent/commit/e1ee37bc49dc46039484e645a32855c558d8f2b1) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `allowedEvents` (on the `agent.decide` and `agent.plan` builtins) now accepts a single string as well as an array, plus wildcard patterns: `'*'` matches every currently-legal event, and `'ns.*'` matches a dotted namespace (`'todo.*'` → `todo.add`, `todo.toggle`, …). Patterns are typed against the declared dotted event types, so a namespace that matches nothing is a compile error; exact types and patterns can mix (`['todo.*', 'reset']`). Wildcards expand against the live snapshot, so they require a snapshot-aware host (`runAgent` or the step path); under a bare `createActor(...)`, list event types explicitly.

- [#67](https://github.com/statelyai/agent/pull/67) [`66a8b9d`](https://github.com/statelyai/agent/commit/66a8b9d98b077549a6242b7de3cb375880a30d8a) Thanks [@davidkpiano](https://github.com/davidkpiano)! - API polish for alpha:

  - `setupAgent({ states })`: per-state context schemas (xstate `setup({ states })`) narrow `context` inside declared states (invoke inputs, transition fns, final outputs), removing defensive `?? default` fallbacks.
  - New helpers: `persistSnapshot(snapshot)` (JSON round-trip clone for idle-snapshot persistence) and `bindRequestExecutor(logic, executor)` (bind a child machine's text logic to a raw request executor without casts).
  - `createDecisionLogic` removed from the public API. Decisions are state-local: use `src: 'agent.decide'` inline; reuse the input builder function, not an actor (see docs/decisions.md).
  - Step vocabulary unified: `getMachineAgentRequests` renamed to `getAgentRequests`; the old hand-passed-options `getAgentRequests` is internal (`getAgentRequestsWith`); `doneEvent`/`transitionResult` are internal. Public step path: `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `getAgentRequests`, `executeAgentRequest`.
  - Fixed stale `setupAgent` JSDoc that documented unimplemented result methods.

- [#67](https://github.com/statelyai/agent/pull/67) [`1faf4e1`](https://github.com/statelyai/agent/commit/1faf4e1838a4483580e524e37ccc85911caa68ed) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `runAgent`'s `generateText`/`streamText` executors now accept the raw Vercel AI SDK functions directly (`runAgent(machine, { generateText, streamText })` with the functions imported from `ai`). Their result shapes are unwrapped natively: `generateText`'s `{ text }` and `streamText`'s `{ textStream }` (chunks forwarded to `onChunk`, final text from `await result.text`). Structured-output requests through raw functions are best-effort (JSON-parsed against the `outputSchema`); use `createAiSdkExecutors` from `@statelyai/agent/ai-sdk` for reliable structured output. `decide` still requires an adapter.

- [#67](https://github.com/statelyai/agent/pull/67) [`e46fc52`](https://github.com/statelyai/agent/commit/e46fc52d999ee66ac869b686d2f8cfe3570c84f9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `runAgent`'s executors now inherit down the whole actor tree.

  Agent requests inside invoked child machines — at any depth — inherit the `generateText`/`streamText`/`decide` executors passed to `runAgent`, the same host-backed wrappers the top-level machine's own requests get. A child request participates in the run's `maxModelCalls` budget, `onTrace`, `onChunk`, and `onResult` exactly like a parent request. No per-child `.provide` ceremony is needed:

  ```ts
  runAgent(parentMachine, { input, generateText }); // child requests inherit generateText
  ```

  Rules:

  - **Inheritance is the default** for any request reached through string-keyed actor sources (invoke `src` strings, registered `actorSources`), arbitrarily deep, cycle-safe.
  - **Explicit bindings win.** A request that carries its own executor (`.withExecutor(...)`, `bindRequestExecutor(...)`, or a child's own `.provide({ actorSources })`) keeps it — the parent's executors are never called for it.
  - **Missing executors still fail fast.** A reachable request whose required executor kind was not passed (e.g. a child stream request with no `streamText`) throws a loud bind-time error naming the invoke chain and the request `src`, before any actor runs.
  - **Escape hatch.** Dynamically created logics (e.g. machine factories used with `enq.spawn`) and children invoked as direct-object `src` objects aren't reachable by the static bind walk; bind those explicitly with `bindRequestExecutor(...)` / `.withExecutor(...)`, or register the child as a string-keyed source.

  This replaces the previous alpha behavior, where a child machine was treated as one opaque actor and an unbound child request threw a bind-time error demanding a nested `.provide`.

- [`6011394`](https://github.com/statelyai/agent/commit/60113943ea6bf0f5cbd371c6cc84ea819a9bb931) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `agent.decide` now delivers its chosen event automatically, and `sendDecision` is removed (breaking).

  When a decision resolves under `runAgent`, the chosen event is sent to the invoking actor directly (mirroring `agent.plan`) and the invoke completes with that event as its output. The delivered event's transition — defined by the state's own `on:` — usually exits the invoking state, which cancels the invoke, so `onDone` normally never fires. If the transition stays in-state, the invoke completes and an explicit `onDone` (now optional and rarely needed) observes the chosen event as output. `onError` (retries exhausted) is unchanged.

  Because delivery is built in, `sendDecision` is gone — no `onDone: sendDecision()`, no import, no deprecation shim. Remove those lines; delivery already happens. In JSON workflows (`setupAgent.fromConfig`), a decide invoke no longer auto-wires `onDone` and no longer rejects a declared `onDone`.

  New: `defineModels` helper (exported from `@statelyai/agent/ai-sdk`). An identity function whose return type is the nameable `AiSdkModelMap<keyof T & string>`, so an exported `const models = defineModels({ ... })` needs no `Record<'a' | 'b', LanguageModel>` annotation and never trips TS2742 — model-ref keys still infer at `createAiSdkExecutors({ models })` and `setupAgent({ models })`.

- [#67](https://github.com/statelyai/agent/pull/67) [`3bcaef9`](https://github.com/statelyai/agent/commit/3bcaef9290d06fff5eb17d0271ca981a36a116a3) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `AgentRequestExecutor`'s return type is widened to also admit the raw Vercel AI SDK result shapes: `AiSdkShapedTextResult` (`{ text }`) and `AiSdkShapedStreamResult` (`{ textStream }`), alongside the existing `{ output }` `AgentRequestExecutorResult` envelope. Raw `ai` `generateText`/`streamText` functions now pass to `runAgent`'s `generateText`/`streamText` executors without a cast (`normalizeGeneratorResult` already unwrapped these shapes at runtime; this aligns the types). Type-only change, no runtime behavior change. The two new type names are exported from the package root.

- [#70](https://github.com/statelyai/agent/pull/70) [`ca0dad3`](https://github.com/statelyai/agent/commit/ca0dad31b07f64b3a6e03d1ba2f76be977ec64c4) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Two `runAgent` additions for human-in-the-loop resume:

  - **Explicit suspension detection.** New exported `WAIT_TAG` (`'agent.wait'`): put it in a state's `tags` to mark an intentional wait for an external event. When the machine rests in a tagged snapshot and nothing is in flight, `runAgent` settles idle deterministically instead of relying on the `setTimeout(0)` timing heuristic. New `RunAgentOptions.isSuspended?: (snapshot) => boolean` customizes detection (default `(s) => s.hasTag(WAIT_TAG)`). Whole-machine idle semantics and the `agent.userInput` placeholder exemption are unchanged, and untagged machines fall back to the heuristic exactly as before — fully backward compatible. (Provisional name: `isSuspended` may change before 2.0.)

  - **Illegal resume events throw.** Resuming with `{ snapshot, event }` whose `type` the restored state cannot take now throws `IllegalResumeEventError` (carrying `eventType` and `acceptedTypes`) before delivering the event — a programmer error in the same class as `runAgent`'s bind-time throws, rather than a silent drop. A type-legal event a guard rejects is not an error (the machine takes no transition and settles normally). Opt out with `RunAgentOptions.onIllegalResumeEvent: 'ignore'` to restore the older silent behavior. `IllegalResumeEventError` is exported.

- [#67](https://github.com/statelyai/agent/pull/67) [`d9d5dbd`](https://github.com/statelyai/agent/commit/d9d5dbd0033e7bc5c6703d3105ebade7d9e824d5) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Breaking: `maxTokens` renamed to `maxOutputTokens` across the request contract (`AgentTextRequest`, `AgentDecisionRequest`, decision/plan inputs, `TextLogicConfig`, workflow config). Rationale: `AgentTextRequest` is now spread-compatible with the Vercel AI SDK's `generateText`/`streamText` options — an AI SDK host is `generateText({ ...request, model })` plus model-ref resolution.

- [#67](https://github.com/statelyai/agent/pull/67) [`3bcaef9`](https://github.com/statelyai/agent/commit/3bcaef9290d06fff5eb17d0271ca981a36a116a3) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add `@statelyai/agent/openai-compat`, a second shipped adapter. `createOpenAiCompatExecutors({ baseUrl, apiKey?, headers?, fetch?, model?, models? })` returns a complete `{ generateText, streamText, decide }` executor set over the OpenAI Chat Completions wire format via raw `fetch`, with zero runtime dependencies. Works with any compatible endpoint — Groq, Together, Ollama, vLLM, OpenRouter, LM Studio, and OpenAI itself. Unlike the raw AI SDK path, this includes `decide` (tool-per-event + `tool_choice: "required"`) and reliable structured output (`response_format` json_schema). Pass a `fetch` override for Workers or tests.

- [#67](https://github.com/statelyai/agent/pull/67) [`66b180d`](https://github.com/statelyai/agent/commit/66b180d5eed8fab629e08176ac16c81a1b41aa98) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Lowered text requests now carry their registered name: `AgentTextRequest.name` is stamped from the `setupAgent({ requests })` key (also via `setupAgent.fromConfig`), or from the new `TextLogicConfig.name` for standalone `createTextLogic` actors. Host executors, per-request routers, and test mocks can route on `request.name` instead of sniffing `system`/`prompt` text.

- [#67](https://github.com/statelyai/agent/pull/67) [`1faf4e1`](https://github.com/statelyai/agent/commit/1faf4e1838a4483580e524e37ccc85911caa68ed) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add `resolveAgentRequests(machine, step, executors, options?)`, a step-path helper that collapses the manual host loop. It resolves the current step's pending request — text via `executeAgentRequest` + `resolveAgentStep`, decision via `resolveDecision` (with `canTake` wired to `step.snapshot.can`) + `transitionAgentStep` — and returns the next step, so a complete durable host is `while (!step.done) step = await resolveAgentRequests(machine, step, executors)`. Plan requests are not yet surfaced on the step path.

### Patch Changes

- [#70](https://github.com/statelyai/agent/pull/70) [`ca0dad3`](https://github.com/statelyai/agent/commit/ca0dad31b07f64b3a6e03d1ba2f76be977ec64c4) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Six correctness fixes from a source audit:

  - **ai-sdk `streamText` now honors `metadata.maxSteps`** — like `generateText`, so a streaming tool loop is bounded instead of running unbounded (both share one `maxStepsSetting` helper).
  - **openai-compat `decide` now forwards an abort signal** — `resolveDecision` threads its `options.signal` onto the request (`AgentDecisionRequest.signal`), and both adapters forward it to the underlying model call, so an in-flight decision is cancellable (symmetric with the text executors).
  - **`RunAgentResult` error `cause` split** — the overloaded `'machine'` is now `'machine' | 'decision-exhausted' | 'stopped'`: an unhandled `DecisionExhaustedError` (or one wrapped in the error's `cause` chain) settles `'decision-exhausted'`, an external stop settles `'stopped'`, and any other machine error state stays `'machine'` (`'aborted'`/`'max-model-calls'` unchanged).
  - **Reserved `agent.*` actor keys are enforced** — `setupAgent({ actorSources })`/`{ requests }` now throws if a key collides with a builtin (`agent.generateText`, `agent.streamText`, `agent.userInput`, `agent.decide`, `agent.plan`) instead of silently clobbering it via spread order. Deliberate overrides are still possible via `machine.provide({ actorSources })`.
  - **Dev-only snapshot-serialization warning** — when a run settles idle, in non-production it walks the machine context once and `console.warn`s (at most once per run, naming the offending path) if it holds a value that won't survive JSON persist/resume (`Date`, `Map`, `Set`, function, `undefined`, `bigint`, class instance, circular). Never throws.
  - **Decision adapters: the event's own `type` always wins** — confirmed both adapters already spread the chosen event's `type` last, so a stray `type` key in the model's tool input can never override the machine event type; added regression tests locking this in.

- [#67](https://github.com/statelyai/agent/pull/67) [`e46fc52`](https://github.com/statelyai/agent/commit/e46fc52d999ee66ac869b686d2f8cfe3570c84f9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Improve type-level DX so authoring no longer forces user-side casts:

  - `createDecisionLogic`'s `allowedEvents` resolver now receives its `input` typed
    from the `schemas.input` schema (was `unknown`).
  - `resolveDecision` is now generic over the machine's event union: typing
    `canTake` (e.g. `(e: GameEvent) => snapshot.can(e)`) makes it return that union,
    removing the re-narrowing parser hosts previously hand-wrote.
  - `AllowedEvents` gained a `TInput` parameter to carry the resolver input type.

  Also cleaned up stale casts/annotations in examples that these (and existing
  inference) made unnecessary: child-machine `onDone` output and `invoke.input`
  `context` were already correctly inferred.

- [#67](https://github.com/statelyai/agent/pull/67) [`e46fc52`](https://github.com/statelyai/agent/commit/e46fc52d999ee66ac869b686d2f8cfe3570c84f9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add `getStateMeta(snapshot)` — returns the merged, typed `meta` of a snapshot's active state(s).

  It replaces the untyped `Object.values(snapshot.getMeta())[0]` cast used to read a state's interaction protocol in human-in-the-loop hosts. The return type is recovered from the snapshot's own `getMeta()` type, so a schema-typed machine (`setupAgent({ meta })`) yields the meta schema's output type; pass an explicit type param for untyped snapshots. Meta from every active state is shallow-merged (later/deeper wins for nested and parallel machines), returning `{}` when no active state declares meta.

## 2.0.0-alpha.0

### Major Changes

- [#67](https://github.com/statelyai/agent/pull/67) [`d750efc`](https://github.com/statelyai/agent/commit/d750efcf98f21ce6ca250a2944521fa8e0b3f09a) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Rewrite `@statelyai/agent` as a typed, host-agnostic authoring layer for agent state machines on XState v6. The machine is a portable blueprint: it decides which states exist, which model calls happen, and which events are legal right now; your host executes them with any SDK.

  **Authoring**

  - `setupAgent({ schemas | context/events/input/output/meta, actors, requests })`: schema-first machine authoring (Standard Schema — Zod, Valibot, ArkType) with typed context, events, invoke inputs/outputs, and state/transition `meta`.
  - `createTextLogic(...)` for reusable, schema-typed model calls; co-located `requests:` for inline ones.
  - **Decisions**: the model chooses exactly one _currently-legal_ machine event. Author state-locally with the `agent.decide` builtin (typed `allowedEvents` against your event schema keys; omitted = all currently-legal events) plus `sendDecision()`, or reusably with `createDecisionLogic(...)`. Core validates (`unknown-event` / `invalid-payload` / `rejected-by-guard` via `snapshot.can`) and retries with attempts fed back to the model; how the model is coerced is adapter business.
  - **Machines as data**: full agent workflows — states, transitions, guards, text requests, decisions, human steps — can be defined as pure JSON, validated against the published `@statelyai/agent/agent-workflow.json` schema, and lowered with `setupAgent.fromConfig(...)`. `fromConfig(...)` requires a `compileSchema` option to compile the config's JSON Schemas into runtime validators — bring your own engine (Ajv, @cfworker/json-schema, ...) or pass the exported `minimalSchemaCompiler` to opt into the built-in subset validator (type/properties/required/items/enum/const only).

  **Messages**

  - `AgentMessage` is a parts-based discriminated union (system/user/assistant/tool with text/image/file/tool-call/tool-result parts), structurally mirroring AI SDK `ModelMessage` with no dependency on `ai`. Adds `toolMessage(...)`; `messagesSchema` validates roles and per-role content shapes.

  **Running**

  - `runAgent(machine, { input, generateText, streamText?, decide?, ... })`: bind executors, run to settlement, get `{ status: 'done' | 'idle' | 'error' }`. Idle-first human-in-the-loop: waiting states settle `idle` with a JSON-serializable snapshot; resume with `{ snapshot, event }`. Observation-only callbacks (`onTransition`, `onResult`, `onChunk`); `maxModelCalls` budget; `AbortSignal` support; bind-time errors for anything unbound.
  - Step path for durable hosts: `initialAgentStep` / `transitionAgentStep` / `resolveAgentStep` / `resolveDecision` give per-model-call checkpoints (Cloudflare Workflows, Temporal, etc.); `step.requests` is a `kind`-discriminated union of text and decision requests; delayed transitions surface as schedulable actions.
  - `createAiSdkExecutors({ resolveModel })` from `@statelyai/agent/ai-sdk`: the shipped Vercel AI SDK adapter (structured output, streaming with chunk observation, tool-per-event decide, `metadata.maxSteps` tool loops). `ai` is an optional peer dependency; core depends only on `xstate` (peer).

  **Removed / breaking**

  - `createAgentMachine(...)`, `@statelyai/agent/local`, and the custom runtime surface: runtime is normal XState actors and snapshots.
  - `agentEvents` / `eventTypes` (event tools on text requests) → replaced by decisions and `allowedEvents`.
  - `getAvailableEvents` → `getAcceptedEvents`; `getEventTools` and `AgentRequestLogic` removed.
  - `runAgent` returns the `done | idle | error` status union instead of the machine output, and never throws on a waiting machine.
  - `AgentMessage` is the new union shape; the open index signature is gone. Persisted contexts holding old-shape messages need manual migration.
  - Executor results are unwrapped as `object → text → output`; `toolResults` inspection removed.

## 1.1.6

### Patch Changes

- [#54](https://github.com/statelyai/agent/pull/54) [`140fdce`](https://github.com/statelyai/agent/commit/140fdceb879dea5a32f243e89a8d87a9c524e454) Thanks [@XavierDK](https://github.com/XavierDK)! - - Addressing an issue where the fullStream property was not properly copied when using the spread operator (...). The problem occurred because fullStream is an iterator, and as such, it was not included in the shallow copy of the result object.
  - Update all packages

## 1.1.5

### Patch Changes

- [#49](https://github.com/statelyai/agent/pull/49) [`ae505d5`](https://github.com/statelyai/agent/commit/ae505d56b432a92875699507fb694628ef4d773d) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update `ai` package

## 1.1.4

### Patch Changes

- [#47](https://github.com/statelyai/agent/pull/47) [`185c149`](https://github.com/statelyai/agent/commit/185c1498f63aef15a3194032df3dcdcb2b33d752) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update `ai` and `xstate` packages

## 1.1.3

### Patch Changes

- [#45](https://github.com/statelyai/agent/pull/45) [`3c271f3`](https://github.com/statelyai/agent/commit/3c271f306c4ed9553c155e66cec8aa4284e9c813) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Fix reading the actor logic

## 1.1.2

### Patch Changes

- [#43](https://github.com/statelyai/agent/pull/43) [`8e7629c`](https://github.com/statelyai/agent/commit/8e7629c347b29b704ae9576aa1af97e6cd693bc7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update dependencies

## 1.1.1

### Patch Changes

- [#41](https://github.com/statelyai/agent/pull/41) [`b2f2b73`](https://github.com/statelyai/agent/commit/b2f2b7307e96d7722968769aae9db2572ede8ce7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update dependencies

## 1.1.0

### Minor Changes

- [#39](https://github.com/statelyai/agent/pull/39) [`3cce30f`](https://github.com/statelyai/agent/commit/3cce30fc77d36dbed0abad805248de9f64bf8086) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Added four new methods for easily retrieving agent messages, observations, feedback, and plans:

  - `agent.getMessages()`
  - `agent.getObservations()`
  - `agent.getFeedback()`
  - `agent.getPlans()`

  The `agent.select(…)` method is deprecated in favor of these methods.

- [#40](https://github.com/statelyai/agent/pull/40) [`8b7c374`](https://github.com/statelyai/agent/commit/8b7c37482d5c35b2b3addc2f88e198526f203da7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Correlation IDs are now provided as part of the result from `agent.generateText(…)` and `agent.streamText(…)`:

  ```ts
  const result = await agent.generateText({
    prompt: "Write me a song",
    correlationId: "my-correlation-id",
    // ...
  });

  result.correlationId; // 'my-correlation-id'
  ```

  These correlation IDs can be passed to feedback:

  ```ts
  // ...

  agent.addFeedback({
    reward: -1,
    correlationId: result.correlationId,
  });
  ```

- [#40](https://github.com/statelyai/agent/pull/40) [`8b7c374`](https://github.com/statelyai/agent/commit/8b7c37482d5c35b2b3addc2f88e198526f203da7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Changes to agent feedback (the `AgentFeedback` interface):

  - `goal` is now optional
  - `observationId` is now optional
  - `correlationId` has been added (optional)
  - `reward` has been added (optional)
  - `attributes` are now optional

- [#38](https://github.com/statelyai/agent/pull/38) [`21fb17c`](https://github.com/statelyai/agent/commit/21fb17c65fac1cbb4a8b08a04a58480a6930a0a9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - You can now add `context` Zod schema to your agent. For now, this is meant to be passed directly to the state machine, but in the future, the schema can be shared with the LLM agent to better understand the state machine and its context for decision making.

  Breaking: The `context` and `events` types are now in `agent.types` instead of ~~`agent.eventTypes`.

  ```ts
  const agent = createAgent({
    // ...
    context: {
      score: z.number().describe("The score of the game"),
      // ...
    },
  });

  const machine = setup({
    types: agent.types,
  }).createMachine({
    context: {
      score: 0,
    },
    // ...
  });
  ```

### Patch Changes

- [`5f863bb`](https://github.com/statelyai/agent/commit/5f863bb0d89d90f30d0a9aa1f0dd2a35f0eeb45b) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Use nanoid

- [#37](https://github.com/statelyai/agent/pull/37) [`dafa815`](https://github.com/statelyai/agent/commit/dafa8157cc1b5adbfb222c146dbc84ab2eed8894) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Messages are now properly included in `agent.decide(…)`, when specified.

## 0.1.0

### Minor Changes

- [#32](https://github.com/statelyai/agent/pull/32) [`537f501`](https://github.com/statelyai/agent/commit/537f50111b5f8edc1a309d1abb8fffcdddddbc03) Thanks [@davidkpiano](https://github.com/davidkpiano)! - First minor release of `@statelyai/agent`! The API has been simplified from experimental earlier versions. Here are the main methods:

  - `createAgent({ … })` creates an agent
  - `agent.decide({ … })` decides on a plan to achieve the goal
  - `agent.generateText({ … })` generates text based on a prompt
  - `agent.streamText({ … })` streams text based on a prompt
  - `agent.addObservation(observation)` adds an observation and returns a full observation object
  - `agent.addFeedback(feedback)` adds a feedback and returns a full feedback object
  - `agent.addMessage(message)` adds a message and returns a full message object
  - `agent.addPlan(plan)` adds a plan and returns a full plan object
  - `agent.onMessage(cb)` listens to messages
  - `agent.select(selector)` selects data from the agent context
  - `agent.interact(actorRef, getInput)` interacts with an actor and makes decisions to accomplish a goal

## 0.0.8

### Patch Changes

- [#22](https://github.com/statelyai/agent/pull/22) [`8a2c34b`](https://github.com/statelyai/agent/commit/8a2c34b8a99161bf47c72df8eed3f5d3b6a19f5f) Thanks [@davidkpiano](https://github.com/davidkpiano)! - The `createSchemas(…)` function has been removed. The `defineEvents(…)` function should be used instead, as it is a simpler way of defining events and event schemas using Zod:

  ```ts
  import { defineEvents } from "@statelyai/agent";
  import { z } from "zod";
  import { setup } from "xstate";

  const events = defineEvents({
    inc: z.object({
      by: z.number().describe("Increment amount"),
    }),
  });

  const machine = setup({
    types: {
      events: events.types,
    },
    schema: {
      events: events.schemas,
    },
  }).createMachine({
    // ...
  });
  ```

## 0.0.7

### Patch Changes

- [#18](https://github.com/statelyai/agent/pull/18) [`dcaabab`](https://github.com/statelyai/agent/commit/dcaababe69255b7eaff3347d0cf09469d3e6cc78) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `context` is now optional for `createSchemas(…)`

## 0.0.6

### Patch Changes

- [#16](https://github.com/statelyai/agent/pull/16) [`3ba5fb2`](https://github.com/statelyai/agent/commit/3ba5fb2392b51dee71f2585ed662b4ee9ecd6c41) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Update to XState 5.8.0

## 0.0.5

### Patch Changes

- [#9](https://github.com/statelyai/agent/pull/9) [`d8e7b67`](https://github.com/statelyai/agent/commit/d8e7b673f6d265f37b2096b25d75310845860271) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add `adapter.fromTool(…)`, which creates an actor that chooses agent logic based on a input.

  ```ts
  const actor = adapter.fromTool(() => "Draw me a picture of a donut", {
    // tools
    makeIllustration: {
      description: "Makes an illustration",
      run: async (input) => {
        /* ... */
      },
      inputSchema: {
        /* ... */
      },
    },
    getWeather: {
      description: "Gets the weather",
      run: async (input) => {
        /* ... */
      },
      inputSchema: {
        /* ... */
      },
    },
  });

  //...
  ```

## 0.0.4

### Patch Changes

- [#5](https://github.com/statelyai/agent/pull/5) [`ae473d7`](https://github.com/statelyai/agent/commit/ae473d73399a15ac3199d77d00eb44a0ea5626db) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Simplify API (WIP)

- [#5](https://github.com/statelyai/agent/pull/5) [`687bed8`](https://github.com/statelyai/agent/commit/687bed87f29bd1d13447cc53b5154da0fe6fdcab) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add `createSchemas`, `createOpenAIAdapter`, and change `createAgent`

## 0.0.3

### Patch Changes

- [#1](https://github.com/statelyai/agent/pull/1) [`3dc2880`](https://github.com/statelyai/agent/commit/3dc28809a7ffd915a69d9f3374531c31fc1ee357) Thanks [@mellson](https://github.com/mellson)! - Adds a convenient way to run the examples with `pnpm example ${exampleName}`. If no example name is provided, the script will print the available examples. Also, adds a fun little loading animation to the joke example.

## 0.0.2

### Patch Changes

- e125728: Added `createAgent(...)`
