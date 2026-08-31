# @statelyai/agent

## 2.0.0-alpha.22

### Minor Changes

- [#111](https://github.com/statelyai/agent/pull/111) [`02622cd`](https://github.com/statelyai/agent/commit/02622cdab676e7dc2d12962cd94eb796e87d1112) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Four API contract fixes.**

  - Agent text requests now require exactly one non-empty `prompt` or non-empty `messages` array at every execution boundary, matching the executor types.
  - `createDecisionLogic` is now exported from the package root (along with its `DecisionLogic` return type), matching the already-exported `DecisionLogicConfig`.
  - The machine preset factories (`createToolLoopMachine`, `createSequentialMachine`, `createParallelMachine`, `createLoopMachine`, `createRouterMachine`, `createSupervisorMachine`, `createHandoffMachine`) return typed machines instead of `AnyStateMachine`. Router, supervisor, and handoff are generic over their route/worker/agent maps, so inputs, outputs, and per-name events (`ROUTE_<name>`, `DELEGATE_<name>`, `transfer_to_<name>`) are all inferred — malformed input like `{ prompt: 123 }` is now a compile error.
  - `messagesSchema` validates role-appropriate parts, supported media payloads, nested tool-result content, and required output values in addition to each part's fields. Extra fields are still allowed.

## 2.0.0-alpha.21

### Minor Changes

- [#109](https://github.com/statelyai/agent/pull/109) [`19298f4`](https://github.com/statelyai/agent/commit/19298f45fa665d0eab092fe46c36147b88992b52) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **AI SDK v7.** The `ai` peer dependency is now `^7`, paired with `@ai-sdk/openai@^4`.

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

### Patch Changes

- [#109](https://github.com/statelyai/agent/pull/109) [`19298f4`](https://github.com/statelyai/agent/commit/19298f45fa665d0eab092fe46c36147b88992b52) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Works with XState 6.0.0-alpha.47 and later.** Two type regressions surfaced by alpha.47, both in this package's own plumbing rather than in a machine you write.

  - `setupAgent({ guards, delays })` typed both slots through XState's fully generic `AnySetupConfig`, so a source saw `MachineContext` instead of the agent's own context. alpha.47 tightened those source types, which rejected the parameter annotations that were previously the only way to type them. Both slots are now typed from the agent's own context and event schemas, so an inline source is contextually typed and no annotation is needed.
  - alpha.47 resolves a machine's input type to `<input> | undefined`. `AgentInputFrom` matched that union against the input-schema brand, `undefined` never matched an object type, and the brand was dropped — so a field declared with a schema default read as required at the `runAgent({ input })` call site. The brand is now unwrapped through the optional union.

  The `xstate` peer range is unchanged (`>=6.0.0-alpha.46 <6.0.0`); both fixes hold on alpha.46 as well.

## 2.0.0-alpha.20

### Minor Changes

- [#99](https://github.com/statelyai/agent/pull/99) [`11ff1ac`](https://github.com/statelyai/agent/commit/11ff1ac010a6a0adf147f2cd29f71182ca3899e6) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`runDurableAgent`: run an agent machine on xstate's durable runtime.** Built on the new experimental `xstate/durable` entrypoint (`createDurable`), with the existing `AgentLogEntry` event log as the journal — journal in, run to `done`/`idle`, journal out. A resume folds the journal through pure transitions: an invoke whose completion is journaled is never re-started (recorded model calls never re-execute), while work in flight at a crash re-executes live.

  ```ts
  const first = await runDurableAgent(machine, { input, executors });
  // persist first.entries; later, in a new process:
  const next = await runDurableAgent(machine, {
    entries: first.entries,
    event: { type: "APPROVE" },
    executors,
  });
  ```

  Requires `xstate@>=6.0.0-alpha.41` (peer range bumped). Also in the upgrade:

  - Fixed cross-version snapshot resume under alpha.41: restored snapshots carry an own `machine` reference that made `runAgent`'s version-alignment path re-raise the mismatch it had just resolved.
  - `snapshot._nodes` reads replaced with the now-public `snapshot.nodes`.

## 2.0.0-alpha.19

### Minor Changes

- [#96](https://github.com/statelyai/agent/pull/96) [`0d71b2c`](https://github.com/statelyai/agent/commit/0d71b2c639e1204d97ed8b5af58a2c5395d4a228) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Alpha API consistency pass.** Breaking renames and removals to settle the surface before 2.0 stable.

  Renames:

  - `isSuspended` → `isIdle` and `suspendedTags` → `idleTags`, matching `status: 'idle'`.
  - `canReach` returns `{ reachable, witness }` (was `{ canReach, witness }`).
  - `AgentEventLogConflictError.actualLength` → `actualIndex`.
  - `createLoopMachine({ maxIterations })` → `maxTurns`; `createToolLoopMachine({ maxTurns })` → `maxSteps`.
  - Budget breach error code `max-model-calls-exceeded` → `max-model-calls`, thrown as the exported `AgentMaxModelCallsExceededError` so `onError` can branch on `event.error.code`.

  Removals:

  - `persistSnapshot`: use XState-native `actor.getPersistedSnapshot()`, `machine.getPersistedSnapshot(snapshot)`, or `result.persistedSnapshot`.
  - `verifyReplay`: use `replay(machine, events, { verify: 'strict' })`.
  - `assertAgentMachine`: use `lintAgentMachine(machine, { throw: true })`.
  - `explorePaths({ textOutputs })`: use the `text`, `invokes`, and `userInput` channels.
  - `fork({ atEventId })`: `upToIndex` (exclusive) is the only fork address.
  - `runAgent({ onIllegalResumeEvent })`: illegal resume events always reject.
  - `runAgent({ machineVersion })`: `createMachine({ version })` is the single source, with a structural hash fallback for unversioned machines. A machine declaring XState-native `migrate` owns version mismatches.
  - `runSeam` `{ model }` seam form: seams are addressed by `{ request, occurrence }`; the implicit last-entry repeat is now opt-in `repeatLast: true`.
  - The tool-loop preset's `interruptOn` metadata convention (core never acted on it; tool-call gating is on the roadmap).

  Behavior changes:

  - `'*'` transitions now receive `@agent.usage` (plain XState wildcard semantics). Model-facing `allowedEvents` still excludes `@agent.*`.
  - `provideExecutors` binds executors recursively into child agent machines, same as `runAgent`.
  - `decide` executors take `(request, info)` like the text executors, and `resolveDecision(request, executors, options)` takes the executor set (`missing-decide-executor` error code).
  - Requests take a typed top-level `maxSteps` (the AI SDK adapter still reads `metadata.maxSteps` as a fallback).
  - `setupAgent` throws for any `requests`/`actors` key starting with `agent.` (reserved prefix).
  - All scripted queues throw when they run dry; `createScriptedExecutors` and `simulateAgent` scripts gain a `userInput` queue.
  - `getStateMeta` merges deterministically: deeper states win, and equal-depth parallel siblings merge by state id.

  New:

  - `validateAgentConfig(config)` at `@statelyai/agent/validate` (Ajv is an optional peer; the root bundle stays dependency-free).
  - `getSnapshotRequests(snapshot, options)` and `getSnapshotNodes(snapshot)` replace reading `snapshot._nodes` when hosting request interpretation.

## 2.0.0-alpha.18

### Minor Changes

- [`9064bd3`](https://github.com/statelyai/agent/commit/9064bd36b9fd53de947c26031ac6dadc505ca6b9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`getAgentSchemas(machine)` reads the schema pack a machine was built with.**

  Both `setupAgent(...).createMachine(...)` and `setupAgent.fromConfig(...)` register their compiled schemas against the machine, but only the TS path handed them back to the caller. A host that receives a machine object alone — a generic runner, a UI that renders an input form — had nothing to read, and JSON-authored machines carry no `machine.schemas` to sniff.

  ```ts
  import { getAgentSchemas } from "@statelyai/agent";

  const schemas = getAgentSchemas(machine); // AgentSchemas | undefined
  const event = parseAgentEvent(snapshot, raw, { events: schemas?.events });
  ```

  Returns `undefined` for machines not built by `setupAgent` (a plain xstate machine). Registration is keyed on the machine object, so read it from the machine the setup returned, not from a `machine.provide(...)` result. `AgentSchemas` is now exported as a type.

## 2.0.0-alpha.17

### Minor Changes

- [#92](https://github.com/statelyai/agent/pull/92) [`eda0988`](https://github.com/statelyai/agent/commit/eda0988b4561b9da469c3b27593bd20def09c65b) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `setupAgent.fromConfig(...)` machines can now declare a suspension predicate, so JSON-authored agents settle idle deterministically instead of via `runAgent`'s timing heuristic (which logs a warning):

  - **`suspendedTags` in the workflow config** (declarative, serializable): a list of state tags marking intentional waits for an external event. `fromConfig` lowers it into a `snapshot.hasTag(...)` predicate. Every listed tag must appear in some state's `tags` — an unused entry throws at build time. The published `schemas/agent-workflow.json` gains the optional `suspendedTags` property (backward compatible).

  ```jsonc
  {
    "suspendedTags": ["awaiting-approval"],
    "states": {
      "awaitingApproval": {
        "tags": ["awaiting-approval"],
        "on": { "APPROVE": { "target": "resolved" } }
      }
    }
  }
  ```

  - **`isSuspended` on `FromConfigOptions`** (host-side function, for predicates JSON can't express): registered the same machine-carried way as `setupAgent({ isSuspended })`, surviving `machine.provide(...)`. Takes precedence over the config's `suspendedTags`; a `runAgent({ isSuspended })` host override beats both.

## 2.0.0-alpha.16

### Minor Changes

- [#90](https://github.com/statelyai/agent/pull/90) [`ff88518`](https://github.com/statelyai/agent/commit/ff8851829fd12056daea8dd1d7a8262c61ecc795) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Simplification pass across the codebase and docs, with a few breaking API cleanups:

  - **Breaking:** `executeAgentRequest(request, executors)` now always returns `Promise<{ output, raw }>`. The `{ verbose: true }` option and the output-only overload are gone; destructure `output` where you previously took the bare return value.
  - **Breaking:** `ScriptedDecisionValue`'s event-envelope arm no longer carries a `[key: string]: unknown` index signature, so the union discriminates properly. A `ChosenEvent` is still identified by its string `type`, even when its payload has an `event` key.
  - **Breaking (internal):** `getAgentRequestsWith` merged into `getAgentRequests(actions, options)`; pass `{ machine, snapshot }` in options.
  - `SeamTurn.meta` is now typed from the machine's own meta schema instead of `Record<string, unknown>`; `MetaOfSnapshot` is exported from utils.
  - `JsonSerializableTraceEvent` is now derived from `AgentTraceEvent`, so new trace variants can no longer silently miss the JSON-safe side (same shape, alias form in d.ts).
  - `onChunk`, `onResult`, and `onTransition` are implemented as projections of the `onTrace` stream (documented as sugar; same payloads, order, and timing).
  - The internal usage reader is unified under the public name `getCallUsage` (implementation was previously duplicated behind `extractCallUsage`).
  - Bug fix: `simulateAgent` no longer drains the caller's `script.text` queues (they are now copied like `decisions`/`invokes`).
  - Removed dead code (`resolveAgentRequests`, unused fields, unexported error subclasses, identity wrappers), deduplicated internal helpers, and consolidated docs so each concept has one owning page.

## 2.0.0-alpha.15

### Minor Changes

- [#88](https://github.com/statelyai/agent/pull/88) [`d857a8a`](https://github.com/statelyai/agent/commit/d857a8ae4a16b155d4694f8f556dca55b124c7ce) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Machine input is validated against its schema, and defaulted fields are optional at the call site.**

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

## 2.0.0-alpha.14

### Minor Changes

- [`333e93e`](https://github.com/statelyai/agent/commit/333e93ee4b2f53874c639c985476db1eebb8b108) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Long-lived invoked children now work with the idle/resume host path:

  - `runAgent` idle detection no longer treats an invoked child machine that is itself idle (waiting for events, no busy descendants, no pending eventless/after work) as in-flight work, so machines with a long-lived invoked agent can settle idle instead of hanging.
  - Idle results always include `persistedSnapshot` (previously only alongside pending user inputs). Resume from it — `runAgent(machine, { snapshot: result.persistedSnapshot, event })` — to restore invoked children with their accumulated state; resuming from the live `snapshot` restarts children fresh.

- [`333e93e`](https://github.com/statelyai/agent/commit/333e93ee4b2f53874c639c985476db1eebb8b108) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Remove the `agent.plan` builtin; use an explicit `agent.decide` loop (see todo-nl example).

  A multi-event command is now authored as a loop in the machine: a `planning` state invokes `agent.decide` for one event, applying it re-enters `planning` for the next step, and an explicit machine event (e.g. `DONE`) exits the loop. The applied trail lives in context and is appended to each step's prompt. Control flow stays visible in the statechart.

  Removed: the `agent.plan` invoke src, `PLAN_DONE_EVENT_TYPE`, `PlanLogic`, `AgentPlanInput`, `AgentPlanOutput`, `AgentPlanRequest`, and the `kind: 'plan'` request/effect/usage variants.

## 2.0.0-alpha.13

### Patch Changes

- [`25c940c`](https://github.com/statelyai/agent/commit/25c940c3300d290a34c43b3fc3aeae63d0eaef61) Thanks [@davidkpiano](https://github.com/davidkpiano)! - The raw Vercel AI SDK `generateText`/`streamText` functions now typecheck when passed directly as executors (`executors: { generateText, streamText }`) — no casts needed. `AgentRequestExecutor` now receives an `AgentExecutorTextRequest` (exported): the same runtime object as before, typed so it is assignable to `ai`'s call options (`prompt`/`messages` mutually exclusive; `tools`/`toolChoice`/`messages` widened). Hand-written executors annotating `AgentTextRequest & { tools: AgentTools }` remain assignable unchanged. `AiSdkShapedTextResult`/`AiSdkShapedStreamResult` swap their index signatures for explicit optional passthrough fields so `ai`'s result interfaces are admitted.

## 2.0.0-alpha.12

### Minor Changes

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **One error base class with stable codes, and JSON-safe trace events.**

  ```ts
  try {
    await generateResult(machine, { input, executors });
  } catch (error) {
    if (error instanceof AgentError && error.code === "agent-idle") {
      // branch on the code — no instanceof ladder, survives bundle boundaries
    }
  }
  ```

  - New exported `AgentError` base class: every error the package throws extends it and carries a stable kebab-case `code` — `agent-idle`, `illegal-resume-event`, `snapshot-version-mismatch`, `decision-exhausted`, `lint-failed`, `event-log-conflict`, `non-serializable-event`, `replay-machine-mismatch`, `replay-divergence`, `max-model-calls-exceeded`, `scripted-executors-exhausted`, `seam-script-exhausted`.
  - **Breaking (alpha)** renames for prefix consistency, no aliases: `IllegalResumeEventError` → `AgentIllegalResumeEventError`, `SnapshotVersionMismatchError` → `AgentSnapshotVersionMismatchError`, `DecisionExhaustedError` → `AgentDecisionExhaustedError`, `ReplayMachineMismatchError` → `AgentReplayMachineMismatchError`, `ReplayDivergenceError` → `AgentReplayDivergenceError`. `AgentLintError.diagnostics` is now `readonly`.
  - New `serializeTraceEvent(event, { includeRaw? })` projects an `AgentTraceEvent` into a `JSON.stringify`-safe `JsonSerializableTraceEvent` for JSONL traces. Snapshots take the same JSON round-trip as `persistSnapshot`; `request.end`'s raw SDK object is dropped unless `includeRaw`; functions, `undefined`, symbols and cyclic back-references are dropped; `Error`s serialize as `{ name, message, stack?, code? }` instead of `{}`. Never throws.
  - `RunAgentErrorCause` is now exported (it was already reachable through `result.cause`).

- [`466f3ff`](https://github.com/statelyai/agent/commit/466f3ffd67690b383182d91e601dfc9046a00257) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Token budgets are now ordinary state machine logic.** Every settled model call that reports usage delivers a reserved `@agent.usage` event to the running machine, so spend lives in context and a budget is just a transition.

  ```ts
  const machine = setup.createMachine({
    // Declaring the transition IS the opt-in; `event.usage` is typed already.
    on: {
      "@agent.usage": ({ context, event }) => {
        const tokens = context.tokens + (event.usage.totalTokens ?? 0);
        return tokens > 50_000
          ? { target: ".done", context: { tokens } }
          : { context: { tokens } };
      },
    },
    // ...
  });
  ```

  - Delivered after every settled text, decision, and plan-step call as `{ type: '@agent.usage', usage, kind, id, src, model, name }`. New `AGENT_USAGE_EVENT_TYPE` constant and `AgentUsageEvent` type.
  - `setupAgent` / `createAgentSchemas` / `setupAgent.fromConfig` register `'@agent.usage'` **by default**, so the handler autocompletes and `event.usage` types with nothing declared. It also shows up in `schemas.events` for hosts introspecting the pack.
  - **Delivery is gated on an explicit transition.** The event is sent only when an active state declares `'@agent.usage'` by name. A catch-all `on: { '*': … }` does not count and never receives it; a machine with no handler sees no extra transition, trace event, or log entry. Declare it machine-level to catch every call.
  - **Breaking: `@agent.` is a reserved namespace.** Declaring `'@agent.usage'` in your own `events` throws. Hosts cannot send into the namespace either — `parseAgentEvent` rejects it and `getAcceptedEvents` drops it before `allowedEvents` matching, so `@agent.usage` and `@agent.init` are never decision candidates (not even under a `'*'` wildcard). Rename any event of yours starting with `@agent.`.
  - **Usage entries are spend records.** When the event is reported the cost already happened, so entries are durable, append-only facts — there is no dedupe or rollback. Replay folds every one, and a call re-executed by crash recovery journals its own usage on top, so a recovered total covers both the lost call and its retry. That is the true cumulative spend.
  - A call that settles after the run's cycle resolved is a straggler: its tokens still fold into `result.usage`, but the machine event is dropped (identically on the `runAgent` and `createAgentActor` paths) and surfaced on `onTrace` as `usage.dropped`.
  - Usage from a request inside an invoked child machine reports to the run's root machine, attributed by `id`/`src`/`model`.
  - Scripted `simulateAgent` runs report no usage, so a counter stays `0` under simulation. Test the budget itself with a usage-reporting mock executor.
  - **Works without `runAgent`.** On the uncontrolled `provideExecutors` path the event reaches the machine actor that invoked the bound request, with the same explicit-declaration gate; delivery follows `provideExecutors`' binding boundary, so an invoked child machine needs its own `provideExecutors(...)`. On the step path, new root export `getCallUsage(raw)` normalizes a raw executor result's usage so a host can journal the event itself (the typed event union carries the attribution fields alongside `usage`). See the "Usage without runAgent" docs section.

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Every run result now reports what it spent.** `usage` is on all three `RunAgentResult` variants (`done`, `idle`, `error`), so a run's cost needs no side-channel.

  ```ts
  const result = await runAgent(machine, { input, executors });
  console.log(
    `${result.usage.modelCalls} calls, ${result.usage.totalTokens ?? 0} tokens`
  );
  ```

  - New `AgentUsage` type (and per-call `AgentCallUsage`): `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens`, plus an always-present `modelCalls`.
  - `generateResult(...)` resolves `{ output, snapshot, events, usage }` — the shape `generateText` users expect.
  - Executors report per-call usage on their result: `{ output, usage }` for text, `{ event, usage }` for `decide`. The AI SDK's `LanguageModelUsage` already fits, so `createAiSdkExecutors` needs no wiring.
  - Token fields are partial sums: each sums only the calls that reported it and stays `undefined` when none did. Only `modelCalls` is always present, and it counts every call (decision retries separately). Aggregation is per-run — a resumed run counts its own calls only.
  - `request.end` trace events carry the optional per-call `usage` on both the `runAgent` and `provideExecutors` paths; `serializeTraceEvent` passes it through.

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Removed the `@statelyai/agent/steps` and `@statelyai/agent/adapter` subpaths.** Everything they exported is now on the root barrel — import from `@statelyai/agent`.

  The package's entry points are now `.`, `./ai-sdk`, `./machines`, `./otel`, `./sqlite`, and `./agent-workflow.json`.

  Newly on the root barrel:

  - From `/steps`: `executeAgentRequest`, `resolveDecision`, `renderDecisionAttempts`, `PLAN_DONE_EVENT_TYPE`, plus `AgentRequest`, `AgentPlanRequest`, `AgentStepRequest`, `DecisionLogicConfig`, `ResolveDecisionOptions`, `AgentRequestSource`.
  - From `/adapter`: `bindRequestExecutor`, `buildEnvelopeSchema`, `getAgentOutputMode`, `parseStructuredEnvelope`, `parseModelRef`, `parseOutput`, `getJsonSchema`, `getJsonSchemaSync`, `isStandardSchema`, `getMachineStructuralHash`, plus `AgentOutputMode`, `StructuredOutputEnvelope`.

  Not carried over (no longer public; the functions remain internal): `matchesEventPattern`, `validateSchemaSync`, `isStructuredOutputSchema`.

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Committed the `isSuspended` option name (no longer provisional), and added a dev warning when a run falls back to the timing heuristic.**

  ```ts
  await runAgent(machine, {
    input,
    executors,
    isSuspended: (snapshot) => snapshot.hasTag("waiting"),
  });
  ```

  Declare the predicate on `setupAgent({ isSuspended })` or per-run on `runAgent(machine, { isSuspended })`; the run-level option wins. When a run settles idle via the timing heuristic because neither was declared, `runAgent` now emits a one-time warning suggesting a deterministic predicate. No behavior change otherwise, and the warning is suppressed when `NODE_ENV === "production"`.

- [`99ff897`](https://github.com/statelyai/agent/commit/99ff897c183071ca3dc3e5a1a037c36f9a471f4c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`createAgentRun(machine, options)`: a run's trace events as an async stream.** Returns `{ events, result }` — the canonical handle for an SSE endpoint, a JSONL logger, or a progress UI.

  ```ts
  const run = createAgentRun(machine, { input, executors });
  for await (const event of run.events) {
    if (event.type === "request.end") console.log(event.type);
  }
  const result = await run.result;
  ```

  - `events` is a single-consumer `AsyncIterableIterator<AgentTraceEvent>` yielding in `runAgent`'s emission order (`run.start` → request/chunk/transition/emit → `run.end`), completing once `run.end` is delivered. Buffered unboundedly, so a slow or absent consumer never blocks the run — iterate, or await `result` first and drain after.
  - `result` is the same promise `runAgent` returns, with identical settle behavior: a run-level failure resolves `{ status: 'error' }`, and only bind-time programmer errors reject.
  - The run starts on the call, not on first iteration. A supplied `options.onTrace` is composed, not replaced. Options pass straight through, so resuming from a persisted `snapshot` (+ resume `event`) streams that run identically.
  - Breaking out of `events` early stops delivery but does not cancel the run (`result` still settles). Pass `options.signal` to abort.

- [`99ff897`](https://github.com/statelyai/agent/commit/99ff897c183071ca3dc3e5a1a037c36f9a471f4c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`getAgentEffects` / `replay`: the two primitives over the append-only event log.** Fold a journal of external inputs through xstate's pure `initialTransition`/`transition` and the whole machine lifecycle — crash recovery, fork resume, time travel — becomes deterministic replay, because the journaled completion order IS the serialization.

  ```ts
  const { snapshot, effects } = replay(machine, entries); // pure: executes nothing
  for (const effect of effects) {
    if (effect.kind === "text") {
      const output = await executeAgentRequest(effect, executors);
      entries.push(
        createReplayEntry(machine, entries, effect.toDoneEvent(output))
      );
    }
  }
  ```

  - `getAgentEffects(machine, snapshot, actions, { history })` maps a transition's ORDERED executable actions — reconciled with the still-owed effects visible only on the snapshot — into an `AgentEffect[]` a host starts at the frontier. Kinds mirror what one transition can start: `text` / `decision` / `plan` (agent invokes), `task` (any other host-run invoke), `delay` (an `after(...)` timer), and `execute` (a fire-and-forget action — custom entry action, `sendTo`, `cancel` — run once, never journaled). Document order within a transition is preserved; snapshot-owed effects (a re-surfacing `agent.plan`, children spawned earlier and still pending) append after.
  - Each `requestId` is `${siteId}#${n}`, `n` the 1-based occurrence derived from the journal (done AND error both count), so the same log yields identical requestIds on every replay.
  - `text` and `task` effects carry `toDoneEvent(output)` / `toErrorEvent(error)`, which mint the exact `xstate.done.actor.<id>` / `xstate.error.actor.<id>` events xstate's actor system would deliver — pushing them into the journal and calling `transition` is indistinguishable from a live run.
  - `replay(machine, entries, { input })` folds an `AgentLogEntry[]` WITHOUT executing anything and returns `{ snapshot, effects }`: the final snapshot plus the effects still owed at the frontier. Entries are validated with `assertAgentLogEntry`.
  - `initEntry(machine, input?)` builds the reserved first journal entry (`{ type: '@agent.init', input }`) that makes a log self-contained. `replay` consumes it to recover the machine input with no side-channel, preferring it over an explicit `options.input`.

- [`99ff897`](https://github.com/statelyai/agent/commit/99ff897c183071ca3dc3e5a1a037c36f9a471f4c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`AgentEventLogStore`: the append-only event log is now the authoritative durability artifact.** The journal of external inputs (effect completions, user events, timer firings) is the source of truth; deterministic replay derives every snapshot from it, a fork is a copied log prefix, and the type-only `AgentSnapshotStore` becomes a mere idle-point compaction cache over what the log already implies.

  ```ts
  const store = createInMemoryEventLogStore();
  await store.append({ threadId: "t1", expectedIndex: 0, entries });
  const next = await store.length("t1"); // the next expectedIndex
  await store.fork({ threadId: "t1", newThreadId: "t1-branch", upToIndex: 1 });
  const all = await store.read("t1", { from: 0 });
  ```

  - `append({ threadId, expectedIndex, entries })` commits contiguous entries under optimistic concurrency, rejecting with `AgentEventLogConflictError` (carrying `threadId`, `expectedIndex`, `actualLength`) when a concurrent writer got there first — two hosts racing on one thread resolve to exactly one winner.
  - `read(threadId, { from })` catches up incrementally, `length(threadId)` gives the next `expectedIndex`, and `fork({ threadId, newThreadId, upToIndex })` copies a prefix onto a fresh thread for time travel or a divergent branch (`atEventId` is the alternative, mutually exclusive cutoff).
  - `createInMemoryEventLogStore()` is a deep-copying reference implementation.
  - `assertEventLogStoreConformance(create)` is a single-tier, runner-agnostic conformance suite validating any store against the reference's semantics. See `@statelyai/agent/sqlite` for a durable one.

- [`99ff897`](https://github.com/statelyai/agent/commit/99ff897c183071ca3dc3e5a1a037c36f9a471f4c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`setupAgent.fromConfig(...)` now accepts host implementations for guards and actions**, lowering configs onto XState v6's `createMachineFromConfig` JSON layer. A JSON-authored agent can finally branch on real logic.

  ```ts
  const { machine } = setupAgent.fromConfig(config, {
    compileSchema,
    guards: { isFromHuman: ({ context }) => context.sender === "human" },
    actions: { notify: (params) => console.log(params.who) },
  });
  ```

  - **`guards`**: a guard string without `{{ }}` is a named guard reference resolved against `fromConfig(config, { guards })`, called with `{ context, event }`. Previously a bare-string guard was evaluated as a truthy literal, so the transition fired unconditionally. An unresolvable named guard is now a build-time error.
  - **`actions`**: named action types (`{ type, params }`) resolve against `fromConfig(config, { actions })`, in transition actions as well as `entry`/`exit`, and receive the template-resolved `params`. Unresolvable names are a build-time error (previously transition-level named actions threw and entry/exit ones were silently unwired).
  - `{{ }}` template expressions, choice states, emitted events, request lowering, `agent.decide` validation, and sibling-target linting are unchanged.

  Breaking edges of the rewrite: a `choice` branch can no longer carry `actions` (use `assign` or the target state's `entry`; this throws at build time); a state key containing `.` now throws, since the dot is reserved as the state-path separator; and invoke-level `meta` is accepted by the type but dropped rather than carried onto the machine.

- [`54866c2`](https://github.com/statelyai/agent/commit/54866c21280adc3875156e76291bc1922734d757) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **New `@statelyai/agent/machines` subpath: preset machine factories.** Seven factories for the agent shapes every framework converges on, each a thin composition over `setupAgent(...).createMachine(...)` that returns an ordinary, fully inspectable machine (executors are still supplied separately to `runAgent`).

  ```ts
  import { createToolLoopMachine } from "@statelyai/agent/machines";

  const machine = createToolLoopMachine({
    model: "openai/gpt-5.4-mini",
    instructions: "Answer using the tools available.",
    maxTurns: 8,
  });
  const result = await runAgent(machine, { input, executors });
  ```

  - `createToolLoopMachine({ model, instructions?, tools?, outputSchema?, maxTurns?, interruptOn? })`: one request, host-run tool loop, `maxTurns` lowered to `metadata.maxSteps`.
  - `createSequentialMachine({ model, steps })`: a prompt chain, one state per step, each step's output feeding the next.
  - `createRouterMachine({ model, instructions?, routes, fallback? })`: one `agent.decide` picks one declared route; undeclared routes have no event, state, or transition.
  - `createParallelMachine({ model, branches })`: static fan-out, joined into a keyed result object.
  - `createLoopMachine({ model, body, until, maxIterations })`: bounded repeat with a guard-enforced iteration budget.
  - `createSupervisorMachine({ model, instructions?, workers, maxTurns? })`: delegate to a worker or `FINISH` each turn, results accumulating.
  - `createHandoffMachine({ agents, defaultActiveAgent, model? })`: peer swarm where `transfer_to_<name>` moves the mic and control does not return.

  Each preset carries `version: "1"` (XState's standard `createMachine({ version })` prop), so persisted snapshots and event logs are stamped by topology with nothing to pass — a topology change bumps the machine version (`"2"`), a minor package release at most. The `machineVersion` resolution that makes this work ships in `session-actor-crash-recovery`. See `docs/machines-presets.md` and `examples/preset-machine`.

- [`09bf309`](https://github.com/statelyai/agent/commit/09bf309255f07eeb619a13cf92b0596ed1dcb9da) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **New `@statelyai/agent/otel`: agent traces as OpenTelemetry GenAI spans.** `createOtelTraceHandler` maps the versioned `AgentTraceEvent` stream onto GenAI-semconv spans, so any OTLP-ingesting backend (Braintrust, Langfuse, LangSmith, Honeycomb, Datadog, Grafana Tempo) is an endpoint and headers away.

  ```ts
  import { createOtelTraceHandler } from "@statelyai/agent/otel";

  const onTrace = createOtelTraceHandler({ tracer, providerName: "openai" });
  const result = await runAgent(machine, { input, executors, onTrace });
  onTrace.dispose(); // required on the uncontrolled path, where no run.end arrives
  ```

  - One `invoke_agent` span per run, one child `chat`/`plan` span per model call, transitions/emissions/dropped usage as span events.
  - `gen_ai.*` attributes: operation name, request model, provider name, agent name/version, token usage. Pass `tracer` **or** `tracerProvider`; set `providerName` yourself, since the trace stream carries only a model ref and the bridge cannot infer it. `agentName` defaults to the machine's `id`, and `attributes` adds your own to every span.
  - Prompt and output bodies are **off by default** (semconv marks message content opt-in); pass `captureContent: true` for `gen_ai.input.messages` / `gen_ai.output.messages`. Sizes are always recorded.
  - Ships no exporter and owns no SDK lifecycle: `@opentelemetry/api` is an optional peer dependency and you bring the `Tracer`.
  - Works on both paths. `runAgent`'s `onTrace` gives the full run boundary; on the uncontrolled `provideExecutors` + `traceTransitions` path the run span opens on the first event and closes on `dispose()`.

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Pruned dead root type exports and made a `setupAgent({ states })` typo a build error.**

  - Removed root type exports no consumer could use: `AgentMachine`, `AgentMachineConfig`, `AgentRequestConfig` (a pure alias of `TextLogicConfig`), `DecisionLogic`, `AgentSetupStateSchema`, `AgentStateNarrowing`, `TextLogicInput`, `TextLogicOutput`, `AgentRequestMode`, `AgentModelMap`, `EventPayload`, `EventUnion`, `NormalizedEventSchemas`, `AgentEventSchemaInput`, `AgentEventSchemaInputMap`, `AllowedEventPattern`, `DataContent`, `ProviderOptions`, `ToolResultOutput`, `AgentToolSchema`. `AgentMachine`, `AgentMachineConfig`, `AgentRequestConfig`, `TextLogicInput` and `TextLogicOutput` are gone from the source too — the first two hardcoded `TActors = {}` and so could not describe a real machine.
  - `setupAgent({ states })` now throws at `createMachine` time when a narrowing key does not name a state in the machine config, naming the bad key and listing the valid ones. A typo was previously a silent no-op. Keys are matched literally against each nesting level, so a narrowing key is a single state name, never a dotted path.
  - Moved the `getAcceptedEvents` JSDoc onto the function it documents.

  Separately, `setupAgent.fromConfig` rejects a dotted state key outright — see the `from-config-host-guards` changeset — and lint's reachability for config machines is fixed in `lint-reachability-from-config`.

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Breaking: removed the `@statelyai/agent/zod` and `@statelyai/agent/openai-compat` subpaths.**

  - **`./zod`.** `zodAgentMessages()` is gone — a one-line convenience over `z.custom`, not worth a public entry point. Declare the field inline instead:

    ```ts
    import { z } from "zod";
    import type { AgentMessage } from "@statelyai/agent";

    const context = z.object({
      messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
    });
    ```

    With the subpath gone, `zod` is no longer a peer dependency of the package.

  - **`./openai-compat`.** `createOpenAiCompatExecutors` and its mappers are gone. The executor contract is three plain functions — write them against whatever client you use. `examples/openai-sdk-host` shows the hand-rolled version against the official `openai` package; `@statelyai/agent/ai-sdk` remains the supported batteries-included adapter.

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Renamed `runAgentToCompletion` to `generateResult`, and it now resolves the whole done result instead of the bare output** — `result.output` plus run metadata (`result.snapshot`, replayable `result.events`, `result.usage`), mirroring `generateText`'s text-plus-metadata shape. Still throws `AgentIdleError` on an unexpected idle. New exported type `GenerateResult<TMachine>`.

  ```ts
  // Before
  const output = await runAgentToCompletion(machine, { input, executors });
  // After
  const result = await generateResult(machine, { input, executors });
  result.output;
  ```

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Text requests no longer need `output: z.string()` on every plain request, and `setupAgent.fromConfig` now returns `{ machine, schemas }`.**

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

- [`ea78056`](https://github.com/statelyai/agent/commit/ea780560ece5f6de8a9ae0bd58ab52a6f73f34d9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Every `runAgent` result now carries `events`: the replayable log of the run.** A versioned, strictly JSON-safe `AgentLogEntry[]` that reproduces the run without executing a single model or tool call.

  ```ts
  const saved: AgentLogEntry[] = [];
  await runAgent(machine, {
    input,
    executors,
    onEvent: (entry) => saved.push(entry),
  });
  // After a crash the log alone is enough — no snapshot, no re-called models.
  const resumed = await runAgent(machine, { events: saved, executors });
  ```

  - Entries carry identity, acceptance time, machine identity/version, and state/effect verification hashes. Capture them in flight with `onEvent`, or pass a preceding result's `events` back when resuming by snapshot to keep one complete replay history across runs.
  - Strict replay verification, event-id forking, and structural event-log diffs: replay rejects machine mismatches and reports the first state/effect divergence (`verifyReplay`, `diffEventLogs`, `createReplayEntry`).
  - **Requires XState `6.0.0-alpha.25` or newer.** Agent APIs match XState's renamed source surface: use `actors`, `machine.sources.actors`, and callback `actors` instead of `actorSources` / `machine.implementations.actorSources`.
  - Replay uses XState's canonical internal event protocol: actor completions carry `actorId`/`sessionId`, delayed work replays from `xstate.timer` events, and globally unique actor sessions are rebound when folding the log through a new actor system.

- [`09bf309`](https://github.com/statelyai/agent/commit/09bf309255f07eeb619a13cf92b0596ed1dcb9da) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`runSeam`: seam evals as one root export.** It runs a machine end to end with every model call scripted except one, and returns that call's answer plus the trajectory slices around it — the recipe that previously took ~200 lines of routing, driving and slicing in every eval.

  ```ts
  const run = await runSeam(emailDrafter, {
    scripts: { promptEvaluator: [vague, complete], emailDrafter: [draft] },
    seam: { request: "evaluatePrompt" }, // or { model: 'promptEvaluator', occurrence: 0 }
    candidate: createAiSdkExecutors({ models }).generateText, // omit for a keyless run
    respond: ({ state }) =>
      state === "prompting"
        ? { type: "PROMPT_SUBMITTED", prompt }
        : { type: "SEND" },
  });

  matchesTrajectory(run.after.statePath, ["needsMoreInfo", "drafting"]);
  matchesTrajectory(run.after.events, ["MORE_INFO", "SEND", "END"]);
  ```

  - The seam is addressed by request `name` or by `model` key, plus a 0-based `occurrence`, so "the second `draftEmail` call" is a value. A `scripts` key is a request `name` when one is scripted under it, else a `model` key.
  - `scripts` follows `createScriptedExecutors` entry conventions (values, `{ output, usage }` envelopes, functions of the request). Each queue's last entry repeats, so a live seam that branches down a longer path never runs dry.
  - `respond` is the reactive simulated user, called at every idle pause with `{ snapshot, state, meta, turn, result }`. Supply `executors` for a machine that also decides; text slots are always owned by the routing.
  - `candidate` is just an executor, so a live model, a candidate prompt or a fine-tune all plug in; without one the whole run is keyless.
  - The result is `{ result, seamOutput, callsBeforeSeam, before, after }`, where `before` / `after` are `{ statePath, events }` pairs ready for `matchesTrajectory`. The split is the seam's own effect completion, so `after` is exactly the branch the seam caused. Note `result.events` covers the whole run while `result.usage` accounts only for the last leg.

- [`466f3ff`](https://github.com/statelyai/agent/commit/466f3ffd67690b383182d91e601dfc9046a00257) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`createScriptedExecutors`: run any agent machine with no API key.** A keyless, dependency-free executor set (root export) that plays back a script instead of calling a model, so `runAgent` / `provideExecutors` work end to end with nothing installed but core. The quickstart's first run is now keyless.

  ```ts
  const result = await runAgent(moderationMachine, {
    input: { comment: "honestly this update is terrible", trust: 20 },
    executors: createScriptedExecutors({
      // Plain values play back FIFO. An entry can also be a function of the
      // request, which says where it was called from: `request.id` is the invoke
      // id, `request.events` the state's legal candidates, `request.name` the
      // text request's name.
      decisions: [(request) => ({ type: request.events[0]!.type })],
      text: ["a scripted draft"],
    }),
  });
  ```

  - Supplies all three slots (`generateText`, `streamText`, `decide`). `decisions` answers decisions and `agent.plan`; `text` answers text requests, with `generateText` and `streamText` sharing one FIFO queue.
  - Entries are plain values or functions of the request, so one script serves a branching or looping machine: route on `request.name`, on a decision's candidate `events`, or on its prior failed `attempts`.
  - An entry may be the raw executor envelope (`{ output, usage }` / `{ event, reason, usage }`), so scripted runs exercise usage aggregation too. A text entry counts as the envelope only when its own keys are `output` plus optionally `usage` / `raw`; an object owning any other key (`{ output: 'draft', confidence: 0.9 }`) is the output value, siblings intact. For a structured request whose output really is `{ output }`, wrap it once more: `{ output: { output: '…' } }`.
  - A dry queue throws a descriptive error naming the pending request (and, for decisions, the candidate events). Queues are copied on creation, so one script object seeds many independent runs.

  New exported types: `ScriptedExecutorsScript`, `ScriptedDecisionEntry`, `ScriptedDecisionValue`, `ScriptedTextEntry`.

- [`54866c2`](https://github.com/statelyai/agent/commit/54866c21280adc3875156e76291bc1922734d757) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`createAgentActor`: a long-lived agent session, plus events-only crash recovery.** The live actor survives idle settles, so a multi-turn conversation is one actor and one event log instead of a snapshot round-trip per turn.

  ```ts
  const session = createAgentActor(machine, { input, executors });
  await session.settled(); // resolves at the next quiescence
  session.actor.send({ type: "SEND" }); // re-opens the cycle
  await session.settled();
  session.usage().totalTokens; // cumulative across every turn
  session.events; // one replayable log for the whole session
  session.stop();
  ```

  - **`createAgentActor(machine, options)`** is runAgent's engine with a session lifecycle; `runAgent` is now the one-shot wrapper over the same engine. See `examples/session-actor`.
  - **Events-only resume**: `runAgent(machine, { events })` with no snapshot derives the resume state from a self-contained log. Recorded results replay rather than re-execute, and a request that was still in flight when the log ended re-executes idempotently on restore. See `examples/crash-recovery` and the event-log docs.
  - **Machine `version` respected**: `machineVersion` resolves as explicit option → the machine's own `createMachine({ version })` → structural hash, and the version gate also reads XState's persisted `version` field. After the gate decides (`throw` / `warn` / `ignore`, or `migrateSnapshot`, which takes precedence), the snapshot's `version` is aligned before restore so XState's own mismatch throw never double-fires — a live `result.snapshot` JSON round-trip resumes cleanly under a versioned machine. The preset machines in `@statelyai/agent/machines` are the payoff (see that changeset).
  - **Executor correlation**: text executors receive `info.runId` and `info.requestId` (the durable invoke id); decision requests carry `runId` alongside `signal`. Non-breaking, and it makes caching, rate-limit and span middleware plain executor composition.

- [`466f3ff`](https://github.com/statelyai/agent/commit/466f3ffd67690b383182d91e601dfc9046a00257) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **The `generate-machine` agent skill now ships in the package.** Point a coding agent at `node_modules/@statelyai/agent/skills/generate-machine/` instead of copying it out of the repo.

  `skills/generate-machine/SKILL.md` teaches the full machine-authoring loop: read the shipped `agent-workflow.json` schema, author an `AgentWorkflowConfig`, validate it with Ajv, lower it via `setupAgent.fromConfig`, check with `assertAgentMachine` / `lintAgentMachine`, dry-run with `simulateAgent`, and repair on errors. See `docs/generate-machines.md`.

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **New `@statelyai/agent/sqlite`: durable persistence on Node's built-in `node:sqlite`** — zero new dependencies, Node-only (>= 22.18).

  ```ts
  import { createSqliteEventLogStore } from "@statelyai/agent/sqlite";

  const log = createSqliteEventLogStore({ database: "./agent.db" });
  await log.append({ threadId: "thread-1", expectedIndex: 0, entries });
  log.close();
  ```

  - `createSqliteEventLogStore({ database, tableName? })` is a durable `AgentEventLogStore` that passes `assertEventLogStoreConformance`. Entries live in one table keyed by `(thread_id, idx)` with a unique `(thread_id, entry_id)` index; `append` runs its length check and inserts inside a single `BEGIN IMMEDIATE` transaction, so racing appends resolve to exactly one winner and a stale `expectedIndex` rejects with `AgentEventLogConflictError`.
  - `createSqliteSnapshotStore({ database, tableName? })` is an `AgentSnapshotStore` upsert over a `key -> JSON` table.
  - `database` takes a file path (or `':memory:'`) to open, or an existing `node:sqlite` `DatabaseSync` handle so both stores can share one connection. `close()` closes only a handle the store opened itself; a passed-in handle stays the caller's to close.

- [`99ff897`](https://github.com/statelyai/agent/commit/99ff897c183071ca3dc3e5a1a037c36f9a471f4c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Dropped the `AgentStep` envelope in favor of the thin effect/replay loop.** A host now drives an agent machine directly over the append-only journal with `getAgentEffects` + `replay`, resolving each frontier effect itself — no opaque step object in between.

  No longer public: `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `resolveAgentRequests` (and `ResolveAgentRequestsOptions`), `getAgentRequests`, and the `AgentStep` type. They remain internal implementation detail.

  What you use instead (all on the root barrel, since `/steps` is gone too): the effect/replay primitives `getAgentEffects`, `replay`, `initEntry`, `createReplayEntry` (`+ AGENT_INIT_EVENT_TYPE`, `AgentEffect`, `GetAgentEffectsOptions`, `ReplayOptions`, `ReplayResult`); the per-effect resolvers `executeAgentRequest` (a `text` effect) and `resolveDecision` (a `decision`/`plan` step); the decision helpers `renderDecisionAttempts` / `PLAN_DONE_EVENT_TYPE`; and the request/effect types.

  Two things become host responsibility (the envelope used to bake them in):

  - **Concurrency.** `resolveAgentRequests` resolved a step's parallel text requests with `Promise.all` and applied outputs in request-array order. The thin loop resolves one frontier effect per fold; a host that wants concurrency runs `Promise.all` over the frontier's `text` effects and folds the outputs in effect-array order.
  - **Plan stepping.** Driving an `agent.plan` invoke (per-step decision request, the applied trail, the four stop reasons) is a small host loop over the re-surfacing `plan` effect + `resolveDecision`. The applied trail is derived from the journal — it is not folded onto the re-surfaced effect under pure replay.

  Migration (a text/decision run):

  ```ts
  import { initialTransition, transition } from "xstate";
  import {
    createReplayEntry,
    executeAgentRequest,
    getAgentEffects,
    initEntry,
    resolveDecision,
  } from "@statelyai/agent";

  const entries = [initEntry(machine, input)];
  let [snapshot, actions] = initialTransition(machine, input);
  while (snapshot.status === "active") {
    const effects = getAgentEffects(machine, snapshot, actions, {
      history: entries,
    });
    let next;
    for (const effect of effects) {
      if (effect.kind === "execute") {
        effect.exec();
        continue;
      }
      if (effect.kind === "text") {
        next = effect.toDoneEvent(await executeAgentRequest(effect, executors));
        break;
      }
      if (effect.kind === "decision") {
        next = await resolveDecision(effect.request, executors.decide!, {
          canTake: (event) => snapshot.can(event),
        });
        break;
      }
    }
    if (!next) break; // idle: persist `entries`, resume later via `replay`
    entries.push(createReplayEntry(machine, entries, next));
    [snapshot, actions] = transition(machine, snapshot, next);
  }
  return snapshot.output;
  ```

  `runAgent` is unchanged; only the low-level step path moved.

- [`09bf309`](https://github.com/statelyai/agent/commit/09bf309255f07eeb619a13cf92b0596ed1dcb9da) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`matchesTrajectory`: the trajectory matcher for machine agents.** Root export, dependency-free, and it scores either a state path or an event log with the same call.

  ```ts
  const path = matchesTrajectory(statePath, ["prompting", "drafting", "sent"]);
  expect(path.matched, JSON.stringify(path.firstMiss)).toBe(true);

  matchesTrajectory(result.events, [
    "PROMPT_SUBMITTED",
    { type: "MORE_INFO" },
    "SEND",
  ]);
  ```

  It compares a run's trajectory against an expected one as an ordered subsequence (gaps allowed, order enforced), with `{ exact: true }` for strict equality. Both trajectories may be state values from `onTransition` (strings, dot paths like `'review.editing'`, or the nested value XState reports) or events from `result.events` (`AgentLogEntry[]`, bare event objects, or event types).

  The result serves tests and eval scorers alike: `matched`, `matchedCount` / `expectedCount`, a `score` (0..1) for partial credit, and a JSON-safe `firstMiss` of `{ index, expected, searchedFrom }` saying where the run diverged.

### Patch Changes

- [`466f3ff`](https://github.com/statelyai/agent/commit/466f3ffd67690b383182d91e601dfc9046a00257) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Fixed `lintAgentMachine` falsely reporting every state of a `setupAgent.fromConfig(...)` machine as dead.** `unreachable-state` and `missing-final` no longer fire on config-built machines.

  XState's JSON layer folds a transition carrying a context patch (`assign`) into a single opaque `to` resolver, dropping its `target` from `machine.config` — so the static reachability walk saw no edges into those states and reported them, and every final state with them, as unreachable. The lowering now retains the config's declared transition targets (`on` / `always` / `after` / `onDone` / `choice`, plus each invoke's `onDone` / `onError`) alongside the machine, and lint reads reachability from those. Reachability is now exact for config machines rather than approximated: a genuinely orphaned state is still reported.

  - `lintAgentMachine(machine)` works as-is on `fromConfig` machines — no API change — and the retained targets survive `machine.provide(...)`.
  - Config-built machines no longer need `{ disable: ["unreachable-state", "missing-final"] }` as a workaround. The shipped `generate-machine` skill's guidance stands: do not disable checks.
  - Hand-authored machines are unchanged: a dynamic (function) transition still over-approximates rather than false-flag, and a transition object carrying only a `to` resolver is now treated as opaque instead of as a targetless in-state transition.

- [`6454a4f`](https://github.com/statelyai/agent/commit/6454a4f6189262ca8c8f1ff4610c51868184f960) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`schemas/agent-workflow.json` now matches what `setupAgent.fromConfig(...)` actually accepts.** The published schema had drifted, rejecting valid configs and accepting ones the lowering throws on. `src/workflow-config-schema.test.ts` validates it against the JSON agent example plus a config exercising every fixed area.

  - **`guard` accepts a bare named-guard string**: `guard: "isFromHuman"` (resolved against `fromConfig`'s `guards`) was runtime-supported but schema-invalid. The `{ type, params }` object form — which the lowering throws on — was schema-valid; it is now removed.
  - **Root `actors` added**: placeholder actor sources were supported by the type and the lowering but absent from the schema, so `additionalProperties: false` rejected valid configs.
  - **`requests.*.reasoning` added** (structured-output envelope opt-in).
  - **Tool schemas renamed to `inputSchema` / `outputSchema`**, matching `AgentToolDescriptor` (the schema had `input` / `output`).
  - **`toolChoice` no longer accepts a `{{ }}` expression**: it is passed to the provider verbatim, never template-evaluated.
  - **`invoke.meta` removed**: the translation drops it (xstate's `InvokeJSON` has no `meta`), so the schema no longer advertises it.
  - **State and transition `meta` are plain JSON**, not expression objects: both pass through verbatim without template evaluation.

## 2.0.0-alpha.11

### Minor Changes

- [`3228715`](https://github.com/statelyai/agent/commit/32287157c0efe327d75f6f4e4d73f161c106527d) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Public API reorganization: a leaner root barrel, with adapter-author and durable-host plumbing moved behind two new subpaths. Breaking (alpha).

  **New subpaths**

  - `@statelyai/agent/steps` — the durable, per-model-call step path and decision control-flow: `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `getAgentRequests`, `executeAgentRequest`, `resolveAgentRequests`, `resolveDecision`, `renderDecisionAttempts`, `PLAN_DONE_EVENT_TYPE` (plus `AgentStep`/`AgentRequest`/`AgentPlanRequest`/`AgentStepRequest`, `ResolveAgentRequestsOptions`, `ResolveDecisionOptions`, `DecisionLogicConfig`).
  - `@statelyai/agent/adapter` — the adapter-author seam: `bindRequestExecutor`, `buildEnvelopeSchema`, `parseStructuredEnvelope`, `getAgentOutputMode`, `isStructuredOutputSchema`, `parseOutput`, `parseModelRef`, `getJsonSchema`, `getJsonSchemaSync`, `isStandardSchema`, `validateSchemaSync`, `getMachineStructuralHash`, `matchesEventPattern` (plus `StructuredOutputEnvelope`, `AgentOutputMode`).

  All of the above moved OFF the root barrel — update imports to the new subpaths.

  **Removed outright**

  - `EVENT_TOOL_PREFIX` (now internal; it just prefixes generated event tool names as `send_event_`).
  - `extractJsonSchema` from `@statelyai/agent/openai-compat` — use `getJsonSchema` from `@statelyai/agent/adapter` (identical function).

  **Other changes**

  - New root type export `PlanLogic` — fixes TS4023 "cannot be named" when re-exporting a machine that uses `agent.plan`.
  - `AgentRequestExecutors` slots are now all optional (`generateText?`, `streamText?`, `decide?`); a missing slot is still a clear bind-time error when the machine needs it. Adapter result sets (`AiSdkExecutors`, `OpenAiCompatExecutors`) still require all three.
  - `SimulationScript.userInput` renamed to `invokes` (the by-src scripted-invoke channel for `simulateAgent`; unrelated to the `agent.userInput` actor).

- [`f5a9b86`](https://github.com/statelyai/agent/commit/f5a9b8641ae25433aa3b368f7266804d740994b7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Versioned trace schema, shared identically across the controlled and uncontrolled paths:

  - **`schemaVersion`.** Every `onTrace` event now carries `schemaVersion` (currently `1`), exported as the const `AGENT_TRACE_SCHEMA_VERSION`. Consumers can gate on it.
  - **`onTrace` for `provideExecutors`.** `ProvideExecutorsOptions` gains `onTrace`, emitting request-level events (`request.start`, `request.end` incl. lifted `reasoning`, `request.error`, `stream.chunk`) with shapes identical to `runAgent`. Because one bound machine can back many concurrent root actors, envelope state (`runId`, monotonic `seq`) is minted per root actor at runtime — two concurrent actors get distinct `runId`s and independent `seq`.
  - **`traceTransitions(onTrace)`.** New exported xstate `inspect` handler that emits `machine.transition` trace events sharing the same versioned envelope and per-root-actor `seq` registry, so pairing it with `provideExecutors`' `onTrace` yields one ordered stream. The uncontrolled path has no `run.start`/`run.end` (no run boundary) by design.

### Patch Changes

- [`f5a9b86`](https://github.com/statelyai/agent/commit/f5a9b8641ae25433aa3b368f7266804d740994b7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Examples now import the package by name (`@statelyai/agent`, `@statelyai/agent/ai-sdk`, `@statelyai/agent/zod`) instead of relative `../../src/...` paths, so each example is copy-paste-able outside the repo. Repo-level tsconfig/vitest aliases keep those names resolving to `src/` for the local dev loop.

- [`f5a9b86`](https://github.com/statelyai/agent/commit/f5a9b8641ae25433aa3b368f7266804d740994b7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `runAgent`'s `inspect` option now accepts an observer object (`{ next }`) as
  well as a function, matching `createActor`. `@statelyai/inspect`'s
  `inspector.inspect` now plugs in directly: `runAgent(machine, { inspect: inspector.inspect })`.

- [`f7d7446`](https://github.com/statelyai/agent/commit/f7d7446b55465da8d97b642a415c3ee569d76290) Thanks [@davidkpiano](https://github.com/davidkpiano)! - DX pass: one `runAgent`, first-class uncontrolled mode, trimmed surface.

  - **Breaking:** `@statelyai/agent/ai-sdk` no longer exports `runAgent` or `createAgent`. It is adapters-only (`defineModels`, `createAiSdkExecutors`). Use core `runAgent(machine, { input, executors: createAiSdkExecutors({ models }) })`; mix adapters by spreading executor sets.
  - **Breaking:** adapter-internal mappers (`toAiSdkTools`, `toAiSdkCallSettings`, `toAiSdkToolChoice`, `toAiSdkEventTools`, `toDecisionMessages`, `isStructuredOutputRequest`, `extractFirstJsonValue`, `toOpenAiMessages`, `toOpenAiCallSettings`, `toOpenAiTools`, `toOpenAiEventTools`) are no longer exported. `extractJsonSchema` stays.
  - **New:** `provideExecutors(machine, executors, options?)` binds every agent actor source in one call, returning a machine ready for a plain `createActor(...)` — the uncontrolled-mode counterpart to `runAgent`.
  - Text requests now fail fast when both `prompt` and `messages` are missing.
  - **Fix:** `setupAgent.fromConfig` no longer silently drops transition-level `actions` (emits and assigns on transitions now fire).
  - `setupAgent.fromConfig` now rejects invalid transition targets and `onDone` on `agent.decide` invokes at build time; `lintAgentMachine` warns on undeclared `on:` events (`undeclared-event`).
  - A decide executor returning a malformed result now throws a descriptive error instead of routing silently into `onError`.
  - `agent-workflow.json` schema: accepts a root `$schema` key; removed the unimplemented `queryLanguage` property.

## 2.0.0-alpha.10

### Minor Changes

- [`4b9421c`](https://github.com/statelyai/agent/commit/4b9421cb7bbc94b1ea534993a2bfba9f4133635e) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`assertAgentMachine(machine, options?)`**: one-line pass/fail wrapper over `lintAgentMachine` for tests and generation loops. Silent when clean; throws the new `AgentLintError` (findings on `.diagnostics`, message formatted like the CLI lint report) on any error-severity finding. `warnings: true` fails warning-severity findings too, and `disable` forwards to lint. New exports: `assertAgentMachine`, `AgentLintError`, `AssertAgentMachineOptions`.

## 2.0.0-alpha.9

### Minor Changes

- [`96094f7`](https://github.com/statelyai/agent/commit/96094f760bd281f766a89dbb1d6d97813ed4345d) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Trace events and live message emissions now carry the run's machine identity:

  - **Trace envelope.** Every `onTrace` event now carries `machineId` and `machineVersion` alongside `runId`, `seq`, and `timestamp`: the same identity stamped onto settled snapshots as `agentMeta`.
  - **`onMessage` info arg.** `onMessage` now receives a second argument, `info: AgentMessageInfo` (`{ runId, machineId, machineVersion }`). The message objects themselves are unchanged (they stay clean model input); the identity travels on the info arg. Existing one-argument handlers keep working.
  - New exported types `AgentRunMeta` (the snapshot stamp's shape) and `AgentMessageInfo`.

## 2.0.0-alpha.8

### Minor Changes

- [`2042f38`](https://github.com/statelyai/agent/commit/2042f387b54033e5f8aef894a4bf17322c979a81) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Reduce common-case agent ceremony:

  - Payload-less events accept `{}` instead of an empty object schema.
  - `@statelyai/agent/ai-sdk` exports an explicit AI SDK `runAgent` host using the machine's model registry.
  - `createAgent` provides a one-call AI SDK machine plus `run(input)` entry point.

## 2.0.0-alpha.7

### Minor Changes

- [`4ae254e`](https://github.com/statelyai/agent/commit/4ae254e23ae76696b7211e4034c66c4747b7433c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - DX sweep: structured-output resilience, per-state narrowing sugar, string userInput, host helpers.

  - **Structured-output resilience (AI SDK adapter).** `createAiSdkExecutors.generateText` now repairs a malformed structured response by extracting the first complete JSON value (models occasionally emit two concatenated `{ result }` envelopes), and retries the request once on `NoObjectGeneratedError`. Retry applies only to tool-free requests — a request carrying tools may already have executed side effects, so it fails fast instead. New export: `extractFirstJsonValue`.
  - **Per-state context narrowing sugar.** `setupAgent({ states })` entries accept `{ context: { field: schema } }` — declare only the fields that change; every other field keeps the base context schema. Resolves to xstate's full `{ schemas: { context } }` form (still supported). Empty `{}` state entries are no longer needed. New types: `AgentSetupStateSchema`, `AgentStateNarrowing`.
  - **`agent.userInput` resolves to `string`.** The builtin's output and `AgentUserInputExecutor` are now typed `string` (what the human typed) instead of `unknown`, so `onDone: ({ output }) => …` needs no coercion. The unused `schema` field was removed from `AgentUserInput`; for structured input, classify the string in a follow-up state or register a custom actor source.
  - **Host helpers.** `parseModelRef(ref)` splits a portable `"provider/model-id"` ref; `parseStructuredEnvelope(request, value)` is the checked unwrap of the structured-output envelope (replaces `as StructuredOutputEnvelope` casts in hand-rolled hosts); `bindRequestExecutor` accepts `{ onChunk }` for streaming logics.

## 2.0.0-alpha.6

### Patch Changes

- [`40c540d`](https://github.com/statelyai/agent/commit/40c540dc229848b23668b94dbf8cbe10bc8bba70) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Hardening and clean-up for the (unreleased) `getRequests` state-interpretation pass:

  - A plain invoke-driven resume no longer drops a `messages` log carried in on the snapshot — any non-empty log is re-stamped on settle, matching `agentMeta`.
  - A decide call that resolves after the run has settled no longer appends its `[chose: ...]` marker (no stray post-settle `onMessage`).
  - Interpret `request.end` traces now lift `reasoning` off the raw executor result, matching the invoke-driven text path.
  - The synthetic trace src is the exported `INTERPRET_SOURCE` constant (`"agent.interpret"`) beside the other `agent.*` source names.
  - The `getRequests` hook's second parameter is named `agentContext` to disambiguate from machine context; docs now cover `getRequests`/`messages`/`onMessage` (xstate-as-agent-workflow, examples index).

## 2.0.0-alpha.5

### Minor Changes

- [`caec90b`](https://github.com/statelyai/agent/commit/caec90b7f3d573fc4bf59221053b0aa152fd748c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - New `runAgent` option: `getRequests` — the override to the default invoke-driven contract. By default, agent work is whatever the machine invokes (`agent.generateText`, TextLogic, `agent.decide`, …). With `getRequests`, whenever the machine would otherwise settle idle, the hook reads the snapshot and returns the model request(s) to run instead — so a plain prose-annotated XState machine with zero invokes (prompts in state `description`s, `meta`, tags, or any lookup you like) runs as an agent unmodified. There is no blessed prompt source: `getRequests` is a recipe seam, and the docs/example ship a copy-paste prompts-in-descriptions recipe.

  Each `AgentStateRequest` carries `model` (executor model name), `prompt`, optional `system`, `kind: 'text' | 'decision'`, `allowedEvents`, and an explicit `onDone` advancement contract: a literal event object, or a function of the text output returning the event to send (payload included) — no implicit auto-send; omitted `onDone` means a `decide` call chooses among the currently-legal events, gated by `snapshot.can`. Passes run text calls concurrently against a frozen pass-start history, then append to the log and send events sequentially in request order, so the message log is deterministic regardless of executor latency (parallel regions supported).

  The run aggregates a message log across requests and stamps it onto every settled `snapshot.messages` (like `agentMeta`), so persist/resume round-trips it with no wiring. Read it with the new `getAgentMessages(snapshot)` accessor; observe it live with the new `onMessage` callback; seed it with `runAgent(..., { messages })` — an array appends to the resumed history, a `(prior) => AgentMessage[]` function takes full control. See examples/described-workflow.

## 2.0.0-alpha.4

### Minor Changes

- [`5851499`](https://github.com/statelyai/agent/commit/5851499bae56d41d546ae75712193db264fc492f) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Step-path parity for plans and concurrent text requests by default.

  - **`agent.plan` on the step path.** An `agent.plan` invoke now surfaces as a re-surfacing `kind: 'plan'` `AgentPlanRequest` (`{ id, src, input, events, applied, stepsRemaining }`) — all plain serializable data. Resolve one decision per step (candidates include the reserved `agent.plan.done` move); a real machine event advances the plan and the next step re-surfaces it, while the done move / a `stopOn` event / an exhausted budget / no legal events completes it with `{ steps, stopped }`. `resolveAgentRequests` drives all of this natively, one plan step per call, so the two-line durable host loop works with plans unchanged. Semantics match `runAgent` exactly (same validation/retry, same stop reasons `'done' | 'stop-event' | 'max-steps' | 'no-legal-events'`, exit-cancels-invoke). `agent.plan` is now a stateful, transition-based ledger actor: the in-progress plan state (applied trail + remaining budget) lives in the plan invoke child's own snapshot `context`, so it lands at `children.<id>.snapshot.context` in a persisted snapshot for free — surviving a full `getPersistedSnapshot` → JSON → restore round-trip and resuming identically mid-plan. Both hosts (the step path and `runAgent`) drive the same ledger through shared drivers.
  - **Concurrent text requests are the default.** `resolveAgentRequests` resolves all pending text requests of a step in parallel (`Promise.all`) — parallel statechart regions are genuinely concurrent — applying outputs in request-array order (deterministic for durable replay). Decisions and plans stay one-at-a-time (applying either changes the legal candidate set). A host that wants strictly sequential text resolution loops the manual `executeAgentRequest` + `resolveAgentStep` helpers one at a time.

  - **Partial executor sets on the step path.** `resolveAgentRequests` and `executeAgentRequest` now accept a `Partial<AgentRequestExecutors>` — each request kind demands only its own executor (`generateText`/`streamText` for text, `decide` for decisions and plans), so a decision- or plan-only step needs no `generateText`. A missing needed executor throws a descriptive per-kind error naming the request (matching `runAgent`'s bind-time style), e.g. `this step's text request '<src>' needs a 'generateText' executor but none was provided.`

  New exported type: `AgentPlanRequest` (added to the `AgentStepRequest` union).

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
