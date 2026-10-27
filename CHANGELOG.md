# @statelyai/agent

## 2.0.0-alpha.33

### Minor Changes

- [#181](https://github.com/statelyai/agent/pull/181) [`407e2a6`](https://github.com/statelyai/agent/commit/407e2a6c03e463d4b8d92997cf59e72b30301511) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Four eval helpers in `@statelyai/agent/testing`.**
  
  - `traceCoverage(machine, traces, { reachable? })` reports which states and handlers no trace exercised. Coverage is per handler: a state and an event it handles, with the targets it declares and the ones runs reached. `always` handlers are listed as unobservable, because traces record one step per macrostep.
  - `repeatRuns({ scenarios, k, run, passed })` runs each scenario `k` times and reports passes, pass@k, pass^k, distinct paths, and the state where the runs diverged. `report.passHat(j)` estimates the suite's pass^j. `summarizeRepeats` builds the same report from runs collected elsewhere.
  - `judgeAgreement(rows, { positive?, groupBy? })` compares a judge's labels with confirmed human labels: accuracy, per-label recall, the confusion matrix, disagreements, the true positive and true negative rates, and a correction for the judge's bias.
  - `firstDivergence(actual, reference)` finds the first step where a run departs from a reference trace or an expected trajectory, and names the state it was in.
  - `foldTraces` takes a `blame` option and adds a `blamed` column: failed runs counted once, against the state their failure started in. Rows now always include `blamed`, which is 0 without `blame`.

## 2.0.0-alpha.32

### Patch Changes

- [#178](https://github.com/statelyai/agent/pull/178) [`efe9dd0`](https://github.com/statelyai/agent/commit/efe9dd029b1fd4b333010f84997e4568eb760eea) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **A fork is its own lineage.** `forkEventLog` and `store.fork` give the fork's init entry a fresh `metadata.executionId` and `metadata.forkedFrom: { executionId?, logIndex }` (the parent's id, when it has one, and the cutoff). Before, a fork kept its parent's execution id, so a call the fork made at the same site got the same `info.callKey` as the parent's, and a cache keyed on it could return the parent's result.
  
  - **A custom store's `fork` must store what `forkEventLog` returns** for the prefix. `assertEventLogStoreConformance` now checks the lineage, and its fixtures start with a real init entry.
  - A snapshot taken on the parent no longer takes the fast path when resuming the fork; the fork's log is folded instead. A version bridge still accepts it while the fork has appended nothing since its cutoff.
  - Explicit `events` for a stored thread must also match its init entry's `executionId`, so a parent's log is refused for its fork's thread.

## 2.0.0-alpha.31

### Minor Changes

- [#173](https://github.com/statelyai/agent/pull/173) [`37707bd`](https://github.com/statelyai/agent/commit/37707bdd0ca0b103095596e8250d86ca6f837035) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`createPolicyDecider` runs a policy machine as a decide executor.** Each decision request starts one policy run, whose output event is the choice. The input defaults to the request's `metadata.facts`, offered events, `system`, and `prompt`; the policy's token usage is reported on the result. A run that does not end `done` with an event throws `AgentError` with code `policy-not-done`. With a `store`, each decision's policy run gets its own thread (`policy:<callKey>:<SHA-256 of the input>` by default, or `threadId: (request, info) => ...`). The input must be JSON: the default drops `undefined` keys, and anything else that is not JSON throws before the run.
  
  **`getDecisionRequests` reads the decisions a run asked for from its trace.** From `@statelyai/agent/testing`: `getDecisionRequests(trace, { name? })` returns each decision's first-attempt request with the states it was asked in, from a live or serialized trace, for eval rows and policy probes.

### Patch Changes

- [#172](https://github.com/statelyai/agent/pull/172) [`5a877e9`](https://github.com/statelyai/agent/commit/5a877e9701d56d1096250ef2f33c40c226d52997) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `describeMachine` shows a state's interaction when its label is computed from context (`[interaction: computed label]`) or absent (`[interaction]`). Before, only a string label was shown, so a host's human step looked like an ordinary state.

- [#176](https://github.com/statelyai/agent/pull/176) [`28d17d9`](https://github.com/statelyai/agent/commit/28d17d9d161bfc70aff9c94ccaac89dcf800c142) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Events a person sends, and ignored events in traces.
  
  - **`meta: { actor: "human" }` on a transition** means a person sends its event. `agent.decide` and `decideNext` never offer it: a closed choice lists its options in `withheld`, and a choice of it anyway is retried. `getAcceptedEvents(snapshot, { actor: "agent" })` returns the same model-facing list. `describeMachine` marks the transition `(human)`.
  - **New lint check `decide-allows-human-event`** (error): a decision's literal `allowedEvents` names a tagged event. `verifyAgentConfig` fails its `lint` gate on it.
  - **`machine.transition` trace events carry `ignored: true`** for the host event the state had no transition for, the one `result.ignored` reports. `foldTraces` counts them per state as `ignored`.

- [#174](https://github.com/statelyai/agent/pull/174) [`37ac4e7`](https://github.com/statelyai/agent/commit/37ac4e70cd4257ae9d96ab6070d8e218b51a409a) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Fixes from installing the package in an existing app for the first time.
  
  - **Plain objects from another realm are JSON.** A jest test's vm context gives objects another `Object.prototype`, so `metadata`, store reads, and errors from there were rejected and a run could silently lose its log. The log's checks now accept them.
  - **A run with a `store` fails rather than run unlogged** when its first entry cannot be written: `{ status: "error", cause: "journal" }`.
  - **Journaled errors keep their `code`** (a string or a number), and `replay` turns them back into `Error` objects. They carry an `"@error": true` marker, so a thrown plain `{ name, message }` replays as the plain object it was.
  - **A throwing `onTrace`, `onTransition`, `onChunk`, `onResult`, `onEvent`, or `on` handler no longer fails the run**; it is reported with `console.error`.
  - **Reusing a thread id with different input throws `thread-input-mismatch`** instead of returning the other run's result.
  - **`setupAgent` throws `invalid-schema` for a schema without `~standard`** (zod 3.23 and earlier) instead of skipping its validation.
  - **`describeMachine` prints `?`** for a transition whose target comes from a helper call, instead of `(stays)`.
  - **Subpath types resolve under `moduleResolution: "node"`** (`typesVersions`), and `engines` allows Node 22.
  - **`ai` peer floor is 7.0.128,** the first release with `experimental_decide`, which `@statelyai/agent/ai-sdk` imports.
  - **Undefined fields are dropped from input and events** before they are journaled, as `JSON.stringify` drops them. Any other value the log cannot hold fails a run that has a `store`, and stops the log with a `console.warn` when it does not, instead of failing one way for input and another for events.
  - **`setupAgent` throws `invalid-request`** for a request with neither `prompt` nor `messages`, instead of every call failing inside the invoke.
  - **`ExploreSnapshot` and `CanReachTarget` types** from `@statelyai/agent/testing`, for exploration callbacks in an app whose own `xstate` is another version.
  - **`CHANGELOG.md` ships in the package,** and a new "Upgrading between alphas" page lists the breaking changes since earlier alphas.
  - **`runSeam`'s `respond` may return a promise,** so a seam eval can answer idle pauses with a real async client.

## 2.0.0-alpha.30

### Minor Changes

- [#170](https://github.com/statelyai/agent/pull/170) [`7e97c1f`](https://github.com/statelyai/agent/commit/7e97c1f6c6e079db3233b4a86ffd0b82107a29f2) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`compareRuns` checks a port against the code it replaces.** From `@statelyai/agent/testing`: `compareRuns({ scenarios, baseline, candidate })` runs each scenario through both and labels it `same`, `intended` (the candidate broke no rule where the baseline broke one, or only the candidate reached the expected outcome), or `regression`. It compares outcomes and effects, not tool-call order.

- [#170](https://github.com/statelyai/agent/pull/170) [`7e97c1f`](https://github.com/statelyai/agent/commit/7e97c1f6c6e079db3233b4a86ffd0b82107a29f2) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`metadata` stamps a run's log.** `createAgentRuntime` and `runAgent` take `metadata`, host-owned JSON stored on the log's `@agent.init` entry next to the reserved `executionId`: a policy version, model ids, a scenario. A resume keeps the first run's stamp. A value that is not JSON throws before the run starts.

### Patch Changes

- [#170](https://github.com/statelyai/agent/pull/170) [`98829e2`](https://github.com/statelyai/agent/commit/98829e2c48b1915710530cb202f1d9eabc24cad2) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `describeMachine` marks a transition function as `(conditional)` when its source is minified (`void 0`, a ternary with no spaces), as bundlers and `tsx` print it.

## 2.0.0-alpha.29

### Minor Changes

- [#155](https://github.com/statelyai/agent/pull/155) [`a6d05dc`](https://github.com/statelyai/agent/commit/a6d05dccc1d963859b4dcdd5f117a41265bc67aa) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Declare models once.** `createAiSdkExecutors` and `createTanStackAiExecutors` now accept a machine built by `setupAgent(...).createMachine`, or the `setupAgent(...)` result itself, and read the `models` declared in `setupAgent({ models })`: `createAiSdkExecutors(machine)` replaces `createAiSdkExecutors({ models })` when the map is already on the setup. The options form is unchanged and still takes `settings`. A wrong-shaped argument, including a setup or machine that declared no models, now throws when the executors are built, naming what it got. Core stays provider-free.

- [#161](https://github.com/statelyai/agent/pull/161) [`48f6a9f`](https://github.com/statelyai/agent/commit/48f6a9f92e2440bb57df1178a5de2062d01bf461) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Closed choices and `decideNext`.** A decision can list the concrete events a model may pick instead of asking it to write a payload.
  
  - `agent.decide` input `payloads`: one payload list per event type, without `type`. Each payload becomes an `AgentDecisionOption` on `request.options`; an event type with no `payloads` key is offered as `{ type }`, and an empty list (`escalate: []`) withholds it. Only options the snapshot accepts are offered, and a choice that matches none is retried as `rejected-by-guard`. When the snapshot accepts no option, the invoke fails at once with `AgentDecisionExhaustedError` (no attempts, no model call), which its `onError` handles.
  - `createAiSdkExecutors` presents a closed choice as one `choose_option` tool whose input is an enum of option ids such as `refund:20`. An id that is not offered, or a call to another tool, is retried, with the valid ids in the attempt's reason.
  - `decideNext(snapshot, options)` asks a model to pick one event that any XState snapshot accepts now, including a plain `createMachine`/`setup` machine with no `agent.*` invoke. It takes `decide`, `model`, `allowedEvents` (exact types or wildcards), and optional `payloads(snapshot)`, `lookahead` (describe each option's state and context change; `true` reports every changed context key, an array of keys reports only those, and each value is cut at 120 characters), `system`, `prompt`, `name`, `maxRetries`, and `signal`. It returns `{ event, attempts, request }` and never sends: the host sends after re-checking `can`.
  
  ```ts
  import { decideNext } from "@statelyai/agent";
  
  const { event } = await decideNext(snapshot, {
    decide,
    model: "quick",
    allowedEvents: "desk.*",
    payloads: (s) => ({ "desk.refund": [{ amount: s.context.requested }] }),
    lookahead: true,
  });
  if (event && actor.getSnapshot().can(event)) actor.send(event);
  ```

- [#164](https://github.com/statelyai/agent/pull/164) [`9da8d10`](https://github.com/statelyai/agent/commit/9da8d1057c5bce998b6ad8475d690fded07580af) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`decideNext` reports what the guards blocked.** The result has `withheld: ChosenEvent[]`: every `allowedEvents` type and payload, built like the offered options, that `snapshot.can(event)` rejected. It is filled when nothing is offered too. `AgentDecisionRequest.withheld` holds the same list, and a closed choice under the runtime (`agent.decide` with `payloads`) sets it as well, so a decision's `request.start` trace shows it.

- [#161](https://github.com/statelyai/agent/pull/161) [`48f6a9f`](https://github.com/statelyai/agent/commit/48f6a9f92e2440bb57df1178a5de2062d01bf461) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Decision models in the models map.** `createAiSdkExecutors` accepts an AI SDK decision model, such as TypeSafe's Jev, as a `models` entry next to the language models. A decide request whose model ref names a decision model is answered through `experimental_decide`.
  
  - The request must be a closed choice: `payloads` on `agent.decide`, or `decideNext`. A request without `options` throws.
  - It asks one `choice` question. Each option id is a label, and its criterion is the option's description, or the event as JSON when it has none. The instructions are the request's `system` and `prompt`, and the state is the request's `input`.
  - A label that is not an option is retried like any failed choice. A retry appends the earlier attempts' reasons to the instructions, so the model sees why its last answer failed.
  - The result carries `confidence` when the model reports it. Branch on it in your own code.
  - A text request on a decision model throws.
  
  ```ts
  import { openai } from "@ai-sdk/openai";
  import { typeSafeAi } from "@ai-sdk/typesafe-ai";
  import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
  
  const executors = createAiSdkExecutors({
    models: { desk: openai("gpt-5.4-mini"), judge: typeSafeAi.decisionModel("jev-latest") },
  });
  ```

- [#161](https://github.com/statelyai/agent/pull/161) [`48f6a9f`](https://github.com/statelyai/agent/commit/48f6a9f92e2440bb57df1178a5de2062d01bf461) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`describeMachine`.** `describeMachine(machine, { snapshot? })` renders any machine, from a config or from TypeScript, as deterministic plain text for a model to read: `Machine <id>`, then `Goal: <description>`, then every state with its transitions (guard, target, context keys set), then the event schemas with their fields (the agent machine's, or a plain XState machine's own `schemas.events`). Pass `snapshot` to mark the active states with `*`. Use it as the prompt for a model that proposes an improved machine, or as context for a decider.
  
  ```ts
  import { describeMachine } from "@statelyai/agent";
  
  const prompt = `Propose an improved machine for this goal.\n\n${describeMachine(machine)}`;
  ```

- [#161](https://github.com/statelyai/agent/pull/161) [`730d64c`](https://github.com/statelyai/agent/commit/730d64c3bc4492153a61446e1c7a26d70e2fd1a9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`AgentEventLogStore.listThreads`.** An optional store method, `listThreads({ prefix?, limit?, cursor? })`, returns `{ threadIds, cursor? }`: the threads holding at least one entry, paged by an opaque cursor. `createInMemoryEventLogStore()` implements it, and `assertEventLogStoreConformance` checks it only when a store has it, so existing stores keep compiling and passing.

- [#161](https://github.com/statelyai/agent/pull/161) [`48f6a9f`](https://github.com/statelyai/agent/commit/48f6a9f92e2440bb57df1178a5de2062d01bf461) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Payload and output branching in `explorePaths` and `canReach`.** Exploration no longer applies every event as a bare `{ type }`, so guards that read the payload are explored too.
  
  **Breaking:** `explorePaths` and `canReach` no longer take `text` or `invokes`. Move each canned value into a one-element `outputs` list: `text: { parse: { total: 42 } }` becomes `outputs: { parse: [{ total: 42 }] }`. `simulateAgent`'s `script.text` and `script.invokes` queues are unchanged.
  
  - `payloads(snapshot)`: payloads per event type at each branch point. A type with an entry forks once per payload, at decisions and idle waits; guard-rejected variants count in `prunedByGuard`. A decide input's own `payloads` become that decision's branch set.
  - A type with no entry is filled from its event schema: each finite field (`enum`, `const`, `boolean`, `null`, or a union of those) contributes its values, and an optional one also the omitted case, up to 64 combinations. Plain XState machines are filled from their own `schemas.events`. A type the fill cannot enumerate (a non-finite field, or over 64) is listed in the new `report.unexpandedEvents`, so you know which `payloads` entries to add. A type with no schema is listed too when a transition for it could read the payload (a function transition, a guard, a `matches` pattern, or a `context` mapper).
  - `outputs`: every output to try per src, for text requests and invoked actors alike. A one-element list is a canned output. Two or more fork one branch each, so `onDone` branching on the output is explored down every arm. Each forked branch records `{ type: 'xstate.done.actor.<id>', output }` in the path.
  - `dedupeBy(snapshot)`: a key for settled snapshots, each explored once, so converging branches stay tractable.
  - `maxNodes` (default 100,000) caps the branch points expanded, bounding work and memory on loopy machines where `maxPaths` alone cannot. `hitPathCap` is true when either cap cut exploration short.
  - `canReach` results carry `complete`. It is false when a cap or `maxDepth` cut the search short, a branch stopped `needs-output`, or an event type was not fully expanded, so `reachable: false` is a proof only when `complete` is true.
  
  ```ts
  const violation = await canReach(refundMachine, "illegallyIssued", {
    payloads: () => ({ ISSUE: [0, 100, 100.01, 500].map((amount) => ({ amount })) }),
    outputs: { lookupOrder: [{ found: true }, { found: false }] },
    dedupeBy: (snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
  });
  ```

- [#164](https://github.com/statelyai/agent/pull/164) [`9da8d10`](https://github.com/statelyai/agent/commit/9da8d1057c5bce998b6ad8475d690fded07580af) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`foldTraces` turns many runs into per-state stats.** From `@statelyai/agent/testing`: `foldTraces(traces, { failed })` takes one trace per run, live or serialized, and returns `{ state, visits, failures, withheld }` per state. Visits read `machine.transition`'s `from.value` and `snapshot.value`; `withheld` sums a decision's `request.withheld` from its first `request.start`.

- [#161](https://github.com/statelyai/agent/pull/161) [`730d64c`](https://github.com/statelyai/agent/commit/730d64c3bc4492153a61446e1c7a26d70e2fd1a9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Interactions can offer one button per payload, not only one per event type.
  
  - `meta.interaction.choices`: a list of `{ label, event, style? }`, each carrying the full event it sends ("Seat 2" for `ACCUSE { seat: 2 }`), or a context path string holding an array of the same shape, for choices computed at runtime.
  - `getInteraction(snapshot).choices` resolves either form, interpolates `{context.path}` in labels, and keeps only the events the schema and `snapshot.can` accept. The `events` list is unchanged.
  - `eventFromInteraction(snapshot, { choice })` returns a choice's event by index or label. A label several choices share throws and asks for the index.
  - `textEvent` also takes `{ type, field }` to name the field free text fills; `getInteraction` reports it as `textField`. The bare form still fills `text`.
  - `getInteraction` and `eventFromInteraction` fall back to a plain XState machine's `schemas.events` when no `setupAgent` schemas are registered.
  - New type: `AgentInteractionChoice`.

- [#161](https://github.com/statelyai/agent/pull/161) [`730d64c`](https://github.com/statelyai/agent/commit/730d64c3bc4492153a61446e1c7a26d70e2fd1a9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Decision attempts in the event log.** The log now keeps the decision attempts the machine did not accept, on the entry they explain, so a decider can be improved from its traces:
  
  - An `agent.decide` invoke that lands after failed tries records them on the delivered event's entry as `entry.attempts`.
  - A decision that exhausts its retries keeps `code: "decision-exhausted"` and `attempts` on its `xstate.error.actor` entry's normalized `error`.
  - A host that decides with `decideNext` passes its `attempts` with the event: `runToQuiescence(runtime, { event, attempts })` (or `runAgent(machine, { event, attempts })`), or `runtime.transition(state, event, { attempts })` in a host-owned loop.
  - `getDecisionAttempts(entries)` in `@statelyai/agent/log` lists them as `{ index, eventType, attempts }[]`.
  
  Replay ignores both fields, and logs written before them replay unchanged. `AGENT_EVENT_SCHEMA_VERSION` stays `1`: `assertAgentLogEntry` already accepted unknown envelope fields, so older readers accept the new ones.

- [#164](https://github.com/statelyai/agent/pull/164) [`9da8d10`](https://github.com/statelyai/agent/commit/9da8d1057c5bce998b6ad8475d690fded07580af) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`recordLog(actor)` records a plain actor run.** From `@statelyai/agent/log`: attach it to a `createActor` actor before `start()`, and `log.entries` is an event log of the run (init entry, then every event the root machine processed, invoke outputs inline) that `replay` folds with no actor executed. An actor created from a `snapshot` starts its log from that snapshot.

- [#152](https://github.com/statelyai/agent/pull/152) [`cc5a7a6`](https://github.com/statelyai/agent/commit/cc5a7a675d88573df137ea10a4f44201225c495c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`runAgent`.** One call runs a machine to quiescence: `runAgent(machine, { input, executors })` is `runToQuiescence(createAgentRuntime(machine, options), options)` with a single options object, and returns the same `AgentRunResult`. Resume with `{ snapshot: result.persist(), event }`. A blocking host can pass `onIdle(snapshot) => Promise<event>` to answer idle states in place. `createAgentRuntime` and `runToQuiescence` are unchanged; write the loop yourself when the host is non-blocking, pushes events mid-run, or needs its own stop or checkpoint policy.
  
  ```ts
  import { runAgent } from "@statelyai/agent";
  
  const result = await runAgent(machine, { input: { topic }, executors });
  if (result.status === "done") return NextResponse.json(result.output);
  ```

- [#149](https://github.com/statelyai/agent/pull/149) [`545fcee`](https://github.com/statelyai/agent/commit/545fcee025e2ce5b04859071d6022d18416a71a8) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **TanStack AI adapter.** `@statelyai/agent/tanstack-ai` adds `createTanStackAiExecutors`, the `{ generateText, streamText, decide }` executor set over TanStack AI's `chat()`, alongside the AI SDK and OpenAI adapters. Any TanStack AI text adapter is a model:
  
  ```ts
  import { openaiText } from "@tanstack/ai-openai";
  import { createTanStackAiExecutors } from "@statelyai/agent/tanstack-ai";
  
  const executors = createTanStackAiExecutors({
    models: { quick: openaiText("gpt-5.4-mini") },
  });
  ```
  
  - `models`, `resolveModel`, and `settings` work as in `createAiSdkExecutors`; a model entry can be `{ adapter, settings }`.
  - Structured output, tool loops bounded by `maxSteps` (in `generateText` and `streamText`), response `messages`, forced-tool decisions, usage summed over model turns, and `AgentTruncatedError` all follow the shared adapter contract.
  - A request's generation settings and `toolChoice` map onto `modelOptions` for the `openai`, `anthropic`, and `gemini` providers. For others, map them in a `settings` function.
  
  `@tanstack/ai` (`>=0.66.0 <1`) is a new optional peer dependency.

- [#164](https://github.com/statelyai/agent/pull/164) [`9da8d10`](https://github.com/statelyai/agent/commit/9da8d1057c5bce998b6ad8475d690fded07580af) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`machine.transition` traces carry `from`.** `from: { value: StateValue }` is the state value the event arrived in, emitted by `createAgentRuntime`/`runAgent` and by `traceTransitions`, and kept by `serializeTraceEvent`. The first transition of a stream (the init event, or a restore on resume) has no earlier state, so its `from.value` equals its `snapshot.value`.

- [#161](https://github.com/statelyai/agent/pull/161) [`48f6a9f`](https://github.com/statelyai/agent/commit/48f6a9f92e2440bb57df1178a5de2062d01bf461) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`verifyAgentConfig`.** `@statelyai/agent/validate` adds one call that runs every pre-run gate on a model-authored `AgentWorkflowConfig` and stops at the first failure: `validate` (shipped JSON Schema), `vocabulary` (the actors, requests, named guards, actions, decision events, and model refs in `allow`), `lower` (`setupAgent.fromConfig`), `lint` (`lintAgentMachine`), and `explore` (`explorePaths` per `explore.inputs` entry, every path ending in `explore.terminals`). With `allow` given, a raw `{ "@expr": ... }` slot anywhere in the config fails `vocabulary`, since xstate would evaluate it in place of the literals the lists check. `explore` also fails on an empty `explore.inputs`, on a `maxPaths` or `maxNodes` cap that cut exploration short, and on `unexpandedEvents` (event types whose payloads were not all tried; add `payloads` entries). Other `explore` keys pass through to `explorePaths`; script text requests and invoked actors with `outputs`, not `text` or `invokes`, as for `explorePaths` (see the breaking note there). It never throws on a bad config. Each gate is `{ name, ok, detail? }`, and `detail` is a model-readable repair prompt.
  
  ```ts
  import { verifyAgentConfig } from "@statelyai/agent/validate";
  
  const result = await verifyAgentConfig(candidate, {
    compileSchema,
    allow: { requests: ["draftReply"], events: ["APPROVE", "DENY"], models: ["openai/gpt-5.4-mini"] },
    explore: { inputs: [{ amount: 5 }, { amount: 500 }], outputs: { draftReply: [{ reply: "" }] } },
  });
  const failed = result.gates.find((gate) => !gate.ok);
  if (failed) feedback.push(`gate '${failed.name}' failed: ${failed.detail}`);
  ```

- [#165](https://github.com/statelyai/agent/pull/165) [`9858657`](https://github.com/statelyai/agent/commit/98586570888e87e57647c2c647708184fbb3f63b) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Require XState `6.0.0-alpha.69`** (was `6.0.0-alpha.64`) as both the peer and dev dependency.
  
  **Breaking:** XState `alpha.69` changes what your code and your stored data see:
  
  - Renamed exports: `serializeMachine` is now `machineToJSON`, `createMachineFromConfig` is now `machineFromJSON`, and `ExecutableActionObjectFromLogic` is now `ExecutableEffectFrom`.
  - Persisted snapshots list `timers` as an array, and `version` moved to `machine.version`.
  - XState's lifecycle events are `xstate.init` and `xstate.stop` (were `@xstate.init` and `@xstate.stop`). The agent runtime's own init event in `onTransition` and the event log is still `@xstate.init`.
  - `"xstate.error.actor.*"` is no longer a valid `on` key. Use `"xstate.error.actor"`.
  - A host timer scheduler (`timers: { schedule, cancel }`) still receives `{ id, delay }`, but `id` is now an opaque JSON string. Pass it back unchanged as `{ type: "xstate.timer", id }`.

### Patch Changes

- [#147](https://github.com/statelyai/agent/pull/147) [`9d32376`](https://github.com/statelyai/agent/commit/9d3237698e71b83d7a671a799ffab6085338f43c) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Move judgments to the AI SDK's non-deprecated decision API (`ai` 7.0.133, `@ai-sdk/typesafe-ai` 3.0.16):
  
  - `experimental_evaluate` → `experimental_decide`
  - `Experimental_EvaluationModel` / `Experimental_EvaluationQuestion` → `Experimental_DecisionModel` / `Experimental_DecisionQuestion`
  - `typeSafeAi.evaluationModel("jev-latest")` → `typeSafeAi.decisionModel("jev-latest")`
  - Scripted judges implement `doDecide` instead of `doEvaluate`. The SDK now hands a model its `state` as parts, so a plain value arrives as `[{ type: "json", value }]`.

- [#166](https://github.com/statelyai/agent/pull/166) [`126603f`](https://github.com/statelyai/agent/commit/126603fd6c5057f2beeb212ebb2003209376e7a1) Thanks [@davidkpiano](https://github.com/davidkpiano)! - The AI SDK adapter passes provider-defined tools such as `openai.tools.webSearch()` through unchanged. Before, it rebuilt them as plain tools without their `id`, so the provider never ran them.

- [#161](https://github.com/statelyai/agent/pull/161) [`730d64c`](https://github.com/statelyai/agent/commit/730d64c3bc4492153a61446e1c7a26d70e2fd1a9) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `canReach` now returns a shortest witness. It searches breadth first by path length, so the witness has the fewest events of any path within `maxDepth`, with each recorded invoke outcome (`xstate.done.actor.*`, `xstate.error.actor.*`) counted as one event. A retry loop no longer pads it. `complete` keeps its meaning, `dedupeBy` stays sound, `maxNodes` bounds the breadth-first frontier, and `explorePaths` still walks depth first with an unchanged report.

- [#163](https://github.com/statelyai/agent/pull/163) [`2847e22`](https://github.com/statelyai/agent/commit/2847e229f18a51a22bd2371cea53c0c95b9457d8) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `examples/code-review-loop`: a review that approves a patch but still flags a `novel` issue now goes to a person instead of shipping. `checkingShip` enforces the same rule, so the `canReach` proof covers it. `docs/from-a-loop.md` gains Part 2, which ports the software-factory loop in `examples/code-review-loop/before.ts` to the machine and improves its triage from traces.

- [#159](https://github.com/statelyai/agent/pull/159) [`4e68ca8`](https://github.com/statelyai/agent/commit/4e68ca8f3995c2d400411193f63d410eeb0e9a48) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Fix: `agent.decide` honors the invoke input's `maxRetries`.** `createAgentRuntime` and `simulateAgent` used the builtin decision logic's fixed budget of 2 retries and ignored `maxRetries` set in an `agent.decide` invoke's input. The lowered request now carries the input's `maxRetries` and both hosts prefer it, falling back to the logic's configured value (so `createDecisionLogic({ maxRetries })` behaves as before).

- [#160](https://github.com/statelyai/agent/pull/160) [`aa875e7`](https://github.com/statelyai/agent/commit/aa875e7ed945a785c4ccff87c3ad9bd04f5dd849) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Void async actors journal.** An invoked `createAsyncLogic` actor whose `run` resolves `undefined` (or `null`, which XState's `data ?? output` coalesce turns into `undefined`) no longer makes the event log throw `NonSerializableAgentEventError` on its `xstate.done.actor` event. The journaled entry omits the `output` key instead; replay folds it identically.

- [#153](https://github.com/statelyai/agent/pull/153) [`45d6383`](https://github.com/statelyai/agent/commit/45d63832d610a69030ff99e84dc34fca452d2b51) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Events declared with the `{}` shorthand in `setupAgent({ events: { APPROVE: {} } })` now convert to an empty-object JSON Schema when offered to a model. Listing one under `agent.decide({ allowedEvents })` with `createAiSdkExecutors` previously failed with "Standard schema vendor 'statelyai-agent' does not support JSON Schema conversion."

- [#161](https://github.com/statelyai/agent/pull/161) [`4672646`](https://github.com/statelyai/agent/commit/46726465ebb5195cbee3fd0c43d81c57a88888a5) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `explorePaths` and `canReach` follow a decision that cannot succeed the way a live run does.
  
  - A decision with no candidate the snapshot takes (its guards refuse every one, or a closed choice has nothing on offer) exhausts: the branch records `{ type: 'xstate.error.actor.<id>' }` and takes the invoke's `onError`, or ends in an `error` terminal without one. It used to end without a branch, so `canReach` could report a state behind that `onError` as unreachable while a live run reached it.
  - With an `errors` entry for a decision src, the failure and the candidate events are sibling branches, each one level of `maxDepth` deep. The candidates used to spend two levels, so a path within `maxDepth` could stop as `max-depth`.
  - A wait where the guards refuse every offered event records an `idle` terminal and lists those types in `unexpandedEvents`, so `canReach` reports `complete: false`. The path used to end with nothing recorded, which could make an empty payload table look like a proof.
  - An explorer `payloads` entry of `[]` for a type a wait accepts lists that type in `unexpandedEvents`, because its branches were skipped.

- [#149](https://github.com/statelyai/agent/pull/149) [`545fcee`](https://github.com/statelyai/agent/commit/545fcee025e2ce5b04859071d6022d18416a71a8) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Tested against the latest integration packages: `ai` 7.0.133, `@ai-sdk/openai` 4.0.89, `openai` 7.30, `@anthropic-ai/sdk` 0.132, LangChain 1.5/1.6, Mastra 1.75, Braintrust 3.37, and TanStack AI 0.66. Peer ranges are unchanged. The package is now built with TypeScript 7 and tsdown 0.23.

- [#162](https://github.com/statelyai/agent/pull/162) [`1e46eb7`](https://github.com/statelyai/agent/commit/1e46eb70d3728ae08927589de812ebcef2c13608) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Parallel invokes replay from the store.** A run whose parallel state invokes two or more actors no longer records a state hash that its own replay cannot reproduce. When a second child settled before the first child's completion was delivered, the hash on that completion's entry included the second child as `done`, while replay (which never starts children) holds it active, so resuming the thread from the store alone threw `AgentReplayDivergenceError`. Each entry's `verification.stateHash` is now taken from the pure fold of the log, the state `replay` reaches. Logs recorded without that race keep the same hashes; a log already recorded with the race still fails verification and can be resumed with its `snapshot` cache.

- [#151](https://github.com/statelyai/agent/pull/151) [`c8f68ce`](https://github.com/statelyai/agent/commit/c8f68ce82673a55b9d6ac59eb19e741495520105) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Two more examples.** `examples/rank-candidates` ranks a list against a brief: Jev scores each candidate and judges near-duplicate pairs, while code applies the threshold, sort, per-bucket quota and top-k cut-off, with a reason for every cut. `examples/answer-reuse` judges the help article a search already found before spending an agent call, investigates at most once, and settles idle for a person when the answer still does not pass.

- [#162](https://github.com/statelyai/agent/pull/162) [`d99266d`](https://github.com/statelyai/agent/commit/d99266de813f320d0584d1241477801f69e3af72) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Two more environment and policy examples.**
  
  - `examples/code-review-loop` keeps the review loop fixed: generate, then a self-check and an independent review in parallel, then checks, then ship, retry or ask a person. `canReach` proves it never ships without passing checks and approval. A JSON triage policy decides between retrying and escalating, and it is improved from event-log traces against hidden tests. It runs on Claude Code in headless mode.
  - `examples/tic-tac-toe` is a plain XState game that knows nothing about AI, with the agent playing O at its boundary through `decideNext`. A JSON policy over low-level board features climbs from "first empty cell" to a policy that `canReach` proves never loses to any opponent.

## 2.0.0-alpha.28

### Patch Changes

- [#145](https://github.com/statelyai/agent/pull/145) [`da82c86`](https://github.com/statelyai/agent/commit/da82c86f973f56b880956f0ea6779534068c08d5) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Correct the Cloudflare and XState 4/5 integration recipes so incoming events and persisted snapshots are passed through the `runToQuiescence` initialization argument.

## 2.0.0-alpha.27

### Minor Changes

- [#142](https://github.com/statelyai/agent/pull/142) [`b65991b`](https://github.com/statelyai/agent/commit/b65991b505625283903a30fdd899a9d4f1a101bd) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Breaking: `runAgent` is replaced by a small loop you can run anywhere.**

  `createAgentRuntime(machine, options)` returns the helpers for one run, built on XState's durable transition loop (`xstate/durable`):

  ```ts
  const runtime = createAgentRuntime(machine, { executors });
  let [state, effects] = await runtime.start({ input });
  await runtime.execute(effects);
  for (let event; (event = await runtime.nextEvent()); ) {
    [state, effects] = runtime.transition(state, event);
    await runtime.execute(effects);
  }
  const result = await runtime.finish(); // done | idle | error
  ```

  `runToQuiescence(runtime, init)` is that loop as one call, for scripts and request handlers. Migrate `runAgent(machine, { executors, input, snapshot, event })` to `runToQuiescence(createAgentRuntime(machine, { executors }), { input, snapshot, event })`.

  - `execute` only starts work. Every completion, child message and timer lands in one mailbox, and `nextEvent` hands out whichever arrived first, one event per transition.
  - A run settles when nothing is in flight: no request, child or in-process timer still working. It no longer settles because a state looks idle.
  - Root `after` timers run in-process by default. Pass `timers: { schedule, cancel }` to own them in a durable scheduler; the run then settles with the timer pending, and the host delivers `{ type: "xstate.timer", id }` (`AgentTimerEvent`) when it fires.
  - Cancelling a run aborts its in-flight requests, and the persisted snapshot still resumes the work the cancel cut off.
  - Bind-time errors (a missing executor, an unbound actor) throw from `createAgentRuntime` instead of rejecting a promise.
  - Emitted events are reported after the transition that caused them.

  Removed: `runAgent`, `runAgentStream`, `AgentStreamEvent`, the public step functions (`initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `rejectAgentStep`, `executeAgentRequest`, `AgentStep`), `setupAgent({ isIdle })`, `fromConfig`'s `isIdle` option and the config's `idleTags`. `isAgentIdle` stays, to tell a human wait from a stuck machine once a run settles. Renamed: `RunAgentOptions` → `AgentRuntimeOptions` + `AgentRunInit`, `RunAgentResult` → `AgentRunResult`, `RunAgentErrorCause` → `AgentRunErrorCause`.

- [#142](https://github.com/statelyai/agent/pull/142) [`a5edd87`](https://github.com/statelyai/agent/commit/a5edd870ec795f6d0c8b54cf6478e184415296e0) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Restore agent runs with XState's `execution.restore()` instead of sending a
  synthetic machine event, so wildcard transitions are not triggered during
  restoration and in-flight children and pending timers resume through the
  durable adapter. Preserve timer deadlines and stop in-flight child requests
  through XState's public runtime API. Require XState `6.0.0-alpha.64` (pinned
  while its experimental durable APIs evolve).

## 2.0.0-alpha.26

### Minor Changes

- [#139](https://github.com/statelyai/agent/pull/139) [`11854c6`](https://github.com/statelyai/agent/commit/11854c6b33c940b427fa58e94b5d460c7a69d408) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Breaking: `createScriptedExecutors` is removed.** The library no longer ships a model mock. `createScriptedExecutors` and the `ScriptedByName`, `ScriptedDecisionEntry`, `ScriptedDecisionValue`, `ScriptedExecutors`, `ScriptedExecutorsScript`, and `ScriptedTextEntry` types are gone from both `@statelyai/agent` and `@statelyai/agent/testing`.

  To test a machine without a live model, mock at the provider or pass a plain function:

  - Mock the model with the AI SDK's own `MockLanguageModelV3` (from `ai/test`) and run it through `createAiSdkExecutors`, so the test covers the real adapter path.
  - Or pass a plain executor: `executors: { generateText: async (request) => ({ result: "…" }), decide: async () => ({ event: { type: "WRITE" } }) }`.

  `runSeam` is unchanged. Its `scripts` entries are now typed `SeamScriptEntry` (exported from `@statelyai/agent/testing`), with the same conventions: a value, an `{ result, usage? }` executor result, or a function of the request.

## 2.0.0-alpha.25

### Minor Changes

- [#134](https://github.com/statelyai/agent/pull/134) [`edb7597`](https://github.com/statelyai/agent/commit/edb75976d8b7432d1e8041985f25075e43d96437) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Tighten the executor contract around SDK hosts.

  - **Removed `agent.userInput`**, the `userInput` run option, `pendingUserInputs`, `PendingUserInput`, `AgentUserInput`, `AgentUserInputExecutor`, the scripted `userInput` channel, and the `userInput` shorthand in `simulateAgent`/`explorePaths` scripts (use `invokes` keyed by src). A human's turn is an idle state with accepted events; see the human-in-the-loop docs.
  - **Executors return `{ result }` only.** The raw Vercel AI SDK result shapes (`{ text }`, `{ textStream }`) are no longer sniffed, `AiSdkShapedTextResult`/`AiSdkShapedStreamResult` are gone, and `AgentExecutorTextRequest` keeps precise `tools`/`messages` types instead of widening them to `any`. Use `createAiSdkExecutors` or a plain function.
  - **Removed `defineModels`.** Pass the plain `models` map to `setupAgent({ models })` and to `createAiSdkExecutors({ models })`; the machine's model refs are typed from its keys either way. No executors are attached implicitly; pass `executors` explicitly to `runAgent`. (A library that exports its map from a package with declaration emit annotates it as `AiSdkModelMap<'quick' | 'deep'>`, as with any exported AI SDK value.)
  - **Removed the `eventToolName` resolver** (`AgentEventToolNameResolver`). Event tool names are always `send_event_<TYPE>`.
  - **`parseModelRef` moved** to `@statelyai/agent/ai-sdk`.

- [#134](https://github.com/statelyai/agent/pull/134) [`2a0e5ea`](https://github.com/statelyai/agent/commit/2a0e5ea83301138b3bc1065c2f66740a469e474e) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Simplify the public API surface.

  - **New entry points.** Testing and eval tooling moved to `@statelyai/agent/testing` (`lintAgentMachine`, `assertAgentMachine`, `simulateAgent`, `explorePaths`, `canReach`, `createScriptedExecutors`, `matchesTrajectory`, `runSeam`). Event-log primitives moved to `@statelyai/agent/log` (`replay`, `forkEventLog`, `initEntry`, `createReplayEntry`, `getUsageFromEvents`, `createInMemoryEventLogStore`, `assertEventLogStoreConformance`, and friends). The root keeps `AgentLogEntry`, `AgentEventLogStore`, and the errors `runAgent` throws.
  - **Step API exported.** `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `rejectAgentStep`, and the `AgentStep` type are now public from the root, alongside `executeAgentRequest`. This is the pure `(state, event) => (state, requests)` view of a machine that `simulateAgent` already ran on; any host can drive it.
  - **Removed `runAgentLoop`.** Write the loop: `while (result.status === "idle") result = await runAgent(machine, { snapshot: result.persist(), event, executors })`.
  - `executeAgentRequest` now takes an `AgentStepRequest` only; the undocumented effect-shaped argument is gone.
  - `EventLogStoreConformanceHarness` no longer accepts an unused `expect` field.

- [#134](https://github.com/statelyai/agent/pull/134) [`c130184`](https://github.com/statelyai/agent/commit/c130184af400dbe13af0d6cc44e78d7ce1cde941) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Text requests resolve to `{ result, messages }` on both sides of the executor contract, and the `agent.messages` event is removed.

  - **`onDone` output is `{ result, messages }`.** Every text request (`requests`, `agent.generateText`, `agent.streamText`, `createTextLogic`) now resolves its invoke with `AgentTextResult<T>` (exported from `@statelyai/agent`): `output.result` is the validated result, typed from the request's output schema or `string`, and `output.messages` is the executor's framework-native response messages (`AgentMessage[]`, empty when the executor returned none). This is universal, not opt-in. Read `output.result` where you read `output` before, and append `output.messages` to `context.messages` in `onDone` to retain a transcript. Decisions and non-agent actors are unchanged.
  - **JSON workflows.** Template expressions that read a request's output move from `{{ event.output.<field> }}` to `{{ event.output.result.<field> }}` (`{{ event.output.result }}` for a plain-text request). Non-request `actors` invokes still read `{{ event.output.<field> }}`.
  - **Executors return the same shape.** `generateText`/`streamText` executors return `{ result, messages?, usage?, ... }` instead of `{ output, ... }`: `result` is the value, `messages` the provider's response messages. `AgentRequestExecutorResult`, `createScriptedExecutors` entries (`{ result, usage }` to report usage), `bindRequestExecutor`, `TextLogic.withExecutor`, and `onResult(request, { result, raw })` all follow. The `request.end` trace event is unchanged.
  - **`executeAgentRequest` returns `{ result, messages, raw }`** (was `{ output, raw }`). Pass `{ result, messages }` straight to `resolveAgentStep`.
  - **Provider schema helpers renamed.** `buildEnvelopeSchema` is `providerOutputSchema`, `parseStructuredEnvelope` is `parseProviderOutput`, and `StructuredOutputEnvelope` is `ProviderStructuredOutput`. They build and parse the `{ result, reasoning? }` object a provider is asked for; the parsed value is already an executor result.
  - **Removed:** the reserved `agent.messages` event, `appendMessages`, the setup result's `appendMessages`, `AGENT_MESSAGES_EVENT_TYPE`, the `AgentMessagesEvent`/`AgentMessagesEventPayload` types, and the `unhandled-agent-messages` lint code. `messagesSchema`, `isAgentMessages`, and `getMessageText` remain.

- [#134](https://github.com/statelyai/agent/pull/134) [`19b42ab`](https://github.com/statelyai/agent/commit/19b42ab94676697bda206d81149d80bbe7126c99) Thanks [@davidkpiano](https://github.com/davidkpiano)! - State `meta` is typed by default. `setupAgent` now types every state's `meta` as `AgentInteractionMeta` keyed by the machine's declared events (exported as `AgentDefaultMeta`), so a `meta.interaction` choice or `textEvent` naming an undeclared event is a compile error, with no `meta` schema to pass. A machine that declares its own `meta` schema replaces the default. `AgentInteractionDescriptor` and `AgentInteractionMeta` take the event-type union as a type parameter.

- [#131](https://github.com/statelyai/agent/pull/131) [`1429090`](https://github.com/statelyai/agent/commit/1429090906ba9d8e6cee45525bbeaac8d54b2af6) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Require xstate `6.0.0-alpha.57`.**

  The peer range moves to `>=6.0.0-alpha.57 <6.0.0`. Nothing in the library's own
  API changes; the bump picks up alpha.57's structural setup state contracts
  (`type` / `id` / `initial` / `history` / `target` / `route` in `setup({ states })`,
  with strict transition targets) and the new `transitionMeta` schema.

  alpha.57 also fixes declaration emit for machines built with `setup({ states })`
  (statelyai/xstate#5722): the types those declarations reach for — `ActiveStateContext`,
  `RootContextMarker`, the strict-target markers — are exported from the package
  entry point now, so a package that exports such a machine can be built with
  `declaration: true` again.

## 2.0.0-alpha.24

### Patch Changes

- [#127](https://github.com/statelyai/agent/pull/127) [`6b542ab`](https://github.com/statelyai/agent/commit/6b542abe62ab2a63230f97d3866557fb028bd4d4) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `examples/triage`: the classifier's `confidence` is required. Its default made OpenAI strict structured output reject every classification, so every live run escalated as unclassified. `examples/consensus-review` starters carry `source`; `examples/snapshot-migration`, `examples/plain-xstate`, and `examples/portable-xstate-loop` describe their idle states.

  Demo: resolves the library from `src/` (a stale `dist/` no longer runs old code under new examples), keeps the viz embed mounted across example switches and drives it through `@statelyai/sdk`'s `createStatelyEmbed`, sends JSON-authored machines to Viz as config, runs text starters on machines without a prompt input, and shows chat-loop replies kept only in message history.

## 2.0.0-alpha.23

### Minor Changes

- [#115](https://github.com/statelyai/agent/pull/115) [`8375f50`](https://github.com/statelyai/agent/commit/8375f50bd0f548136ff21d514979cfa4790b3028) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Simplify the alpha API around a single portable XState machine artifact.

  - Add semantic request names/inputs, name-keyed scripted executors, exported type helpers, framework-native `agent.messages` events, typed `appendMessages`, `getInteraction`, `eventFromInteraction`, `isAgentIdle`, `runAgentLoop`, and `runAgentStream`.
  - Let `defineModels` provide optional AI SDK executors without adding an AI SDK dependency to core.
  - Use native XState persisted snapshots, machine `version`/`migrate`, structural idle states, and framework-owned durability/storage/retry behavior.
  - Remove the Agent event log, replay/durable runners, SQLite adapters, implicit request extraction, hidden message state, host idle override, `generateResult`/`createAgentActor`, custom per-state schema sugar, general XState lint rules, and Agent-specific failure status proposal.
  - Reduce and rewrite the example/docs catalog around named requests, native snapshots, interactions, evals, and non-trivial state-machine control flow.

- [#119](https://github.com/statelyai/agent/pull/119) [`77879cb`](https://github.com/statelyai/agent/commit/77879cbf0b230dc620a1dc5af470ca4c130568b1) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **The event log is the source of truth for a run.** `runAgent` journals the root machine's external inputs as `AgentLogEntry` values, and a run resumes from that log.

  - `result.events` is a complete, self-contained log segment: a reserved `@agent.init` entry (carrying `input` or a persisted `snapshot`, plus a per-lineage `metadata.executionId`), then every host event, child completion, timer, `@agent.usage`, and `agent.messages` event. Raised events are re-derived on replay.
  - `onEvent(entry)` observes each entry as it is appended. `verification` (default on) stamps a per-entry `stateHash` from the live snapshot.
  - `runAgent({ events })` resumes by replay. Recorded results are never re-executed; an in-flight request re-executes with the same `info.callKey`.
  - A `snapshot` alongside the log is a cache: trusted when its `agentMeta` lineage id, index, and hash match the tail, otherwise the log wins. A diverged cache throws `AgentSnapshotDivergedError` (`snapshot-diverged`). `persist()` stamps `agentMeta: { machineId, version, logId, logIndex }`.
  - Across a `machine.version` change, pass the old `events` and the migrated `snapshot`; the result starts a new segment whose init entry records `metadata.migratedFrom`. Old events without a snapshot throw `AgentMachineVersionMismatchError`.
  - Snapshot-only resume also yields a replayable log.
  - `@agent.usage` entries are always journaled; `result.usage` folds them via `getUsageFromEvents`. Delivery to the machine is still gated on a declared transition.
  - Executors receive `info.callKey` (`<executionId>:<requestId>#<n>`), identical across crash re-execution, for provider and tool idempotency.
  - New exports: `replay`, `forkEventLog`, `getLogExecutionId`, `getSnapshotStateHash`, `agentCallOccurrence`, `AgentEventLogStore`, `createInMemoryEventLogStore`, `assertEventLogStoreConformance`, `AgentEventLogConflictError`, `AgentReplayDivergenceError`, `AgentEventLogError`.
  - Durability stays with the host. No durable runner and no SQLite subpath; the Cloudflare Durable Object example persists the journal in SQLite and drives each turn with `runAgent`.

- [#119](https://github.com/statelyai/agent/pull/119) [`8b7f21a`](https://github.com/statelyai/agent/commit/8b7f21a01b30c26520a0b90cdc72211fff0b9c6e) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add the event log as the source of truth for a run; a snapshot is a verified cache over it.

  - `runAgent` journals the root machine's external inputs as `AgentLogEntry` values: the reserved `@agent.init` entry, host events, child completions, timers, `@agent.usage`, and `agent.messages`. `result.events` is a complete, self-contained log; `onEvent` delivers each entry as it is appended; `verification` (default on) stamps a per-entry state hash computed from the live snapshot.
  - `runAgent({ events })` resumes by replaying the log. Recorded results are reused, never re-executed; a request that was in flight re-executes with the same `info.callKey`. A `snapshot` passed alongside the log is trusted only when its `agentMeta` lineage id, index, and hash match the log's tail; otherwise the log wins, and a diverged cache throws `AgentSnapshotDivergedError`.
  - Across a `machine.version` change, pass the old `events` and the migrated `snapshot`; the result starts a new log segment whose init entry carries the snapshot and `metadata.migratedFrom`. Old events without a snapshot throw `AgentMachineVersionMismatchError`.
  - Every `@agent.usage` event is journaled as a spend record whether or not the machine handles it; `result.usage` folds the log (`getUsageFromEvents`).
  - Executors receive `info.callKey`, a deterministic per-call idempotency key (`<executionId>:<requestId>#<n>`).
  - New exports: `replay`, `forkEventLog`, `initEntry`, `createReplayEntry`, `validateReplayEntries`, `getLogExecutionId`, `getSnapshotStateHash`, `agentCallOccurrence`, `rebindActorSession`, `AgentEventLogStore`, `createInMemoryEventLogStore`, `assertEventLogStoreConformance`, `AgentEventLogConflictError`, `AgentReplayDivergenceError`, `AgentEventLogError`, `NonSerializableAgentEventError`.
  - Durability stays with the host. The Cloudflare Durable Object example persists the journal in SQLite through the store interface and drives each turn with `runAgent`.

- [#123](https://github.com/statelyai/agent/pull/123) [`5a384af`](https://github.com/statelyai/agent/commit/5a384af797275048c76ef56eb61016a04af07c2f) Thanks [@davidkpiano](https://github.com/davidkpiano)! - One `runAgent` addition for human-in-the-loop resume:

  - **Explicit suspension detection.** Declare what "suspended" means for a machine with `setupAgent({ isSuspended: (snapshot) => boolean })`: a wait-state predicate the machine carries (it survives `machine.provide(...)`), so `runAgent` settles those resting snapshots idle deterministically instead of relying on the `setTimeout(0)` timing heuristic. You choose the signal: a tag, a state match, or a `meta` field (e.g. `(s) => s.hasTag('awaiting-review')` or `(s) => getStateMeta(s).interaction !== undefined`). `RunAgentOptions.isSuspended?: (snapshot) => boolean` remains a per-run host override. Resolution order: host option → machine-carried predicate → timing heuristic (when neither is present). Whole-machine idle semantics and the `agent.userInput` placeholder exemption are unchanged; a machine with no predicate falls back to the heuristic exactly as before. (Provisional name: `isSuspended` may change before 2.0.) **Breaking:** the previously exported `WAIT_TAG` constant and the `hasTag(WAIT_TAG)` default are removed. Declare your own signal via `setupAgent({ isSuspended })` or the `runAgent` option.

- [#122](https://github.com/statelyai/agent/pull/122) [`f953f5e`](https://github.com/statelyai/agent/commit/f953f5e5bd3f60aace430067fbaf6c7ec48dc975) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Normalized `finishReason`.** Executor results can report why a call stopped, as `'stop' | 'length' | 'tool-calls' | 'content-filter' | 'other'` (the `AgentFinishReason` type). `createAiSdkExecutors` sets it on every text, structured, and streamed result, mapping the provider's vocabulary onto those five and leaving the raw value on `raw`. `runAgent` lifts it onto the `request.end` trace event next to `usage`, and `serializeTraceEvent` passes it through.

  **`AgentTruncatedError`.** A `'length'` finish costs different things for different requests, so the adapter throws only when it would otherwise return nothing usable:

  - Text request: the text it did produce comes back, with `finishReason: 'length'`. Nothing throws.
  - Structured request: an envelope that never closed is not an answer, so `createAiSdkExecutors` throws.

  The error extends `AgentError` with the code `'truncated'` and carries `requestName`, `requestId`, and `partialOutput`, so an invoke branches on it without an `instanceof` check across bundles:

  ```ts
  onError: [
    {
      guard: ({ event }) => event.error.code === "truncated",
      target: "askingForLess",
    },
    { target: "failed" },
  ];
  ```

  Core never throws it. Truncation is a host observation — only an adapter knows a call ran out of tokens.

- [#122](https://github.com/statelyai/agent/pull/122) [`f953f5e`](https://github.com/statelyai/agent/commit/f953f5e5bd3f60aace430067fbaf6c7ec48dc975) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Raw OpenAI SDK adapter.** `@statelyai/agent/openai` is a new package entry: `createOpenAiExecutors` builds the `{ generateText, streamText, decide }` executor set over the `openai` package's Chat Completions API, with no Vercel AI SDK in between. It was the `openai-sdk-host` example; the mapping now ships, and the example is just the host around it.

  ```ts
  import OpenAI from "openai";
  import { createOpenAiExecutors } from "@statelyai/agent/openai";

  const executors = createOpenAiExecutors({
    client: new OpenAI(),
    resolveModel: (modelRef) =>
      modelRef === "deep" ? "gpt-5.4" : "gpt-5.4-mini",
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

- [#119](https://github.com/statelyai/agent/pull/119) [`77879cb`](https://github.com/statelyai/agent/commit/77879cbf0b230dc620a1dc5af470ca4c130568b1) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **`runAgent` can own the event log's durability.** Pass a store and a thread and the run reads its resume log from storage and writes every entry back, write-ahead.

  ```ts
  const result = await runAgent(machine, {
    store,
    threadId: "session-1",
    input,
    executors,
  });
  ```

  - `store` (an `AgentEventLogStore`) plus `threadId` (required with it, `AgentError` code `missing-thread-id` otherwise). With no `events`, the thread's log is the resume — an empty thread starts fresh from `input`.
  - Each entry is appended at its own `index` as `expectedIndex`, so a concurrent writer conflicts instead of interleaving.
  - **Append-before-execute.** No text or decision call starts until every entry before it is durable; pure transitions never wait. The result resolves only once the run's writes have landed.
  - A rejected write aborts in-flight work and settles `{ status: 'error', cause: 'journal' }` — a new `RunAgentErrorCause`. No further calls run.
  - Passing `events` as well keeps that log as the resume, and the thread's length must match it.
  - `onEvent` is unchanged: a synchronous observer, never awaited. Persisting there stays at-least-once; `store` is the write-ahead seam.
  - `runAgentLoop` threads `store`/`threadId` through, reading the thread each turn instead of carrying the log itself.

- [#123](https://github.com/statelyai/agent/pull/123) [`5a384af`](https://github.com/statelyai/agent/commit/5a384af797275048c76ef56eb61016a04af07c2f) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `createScriptedExecutors` is now one rule: answers keyed by request name, consumed in order, with the last entry for a name repeating forever.

  ```ts
  createScriptedExecutors({
    text: { draft: ["first pass", "revised"] },
    decisions: { route: [{ type: "PUBLISH" }] },
  });
  ```

  Removed: `repeat`, `strict`, positional (un-named) arrays, `scripted.scriptError`, `scripted.assertScriptOk()`, and the exported `AgentScriptedExecutorError`. A request the script has no route for throws a plain `Error("No scripted answer for request 'x'. Known: a, b")` from inside the executor, which reaches the machine as an ordinary actor error. `scripted.calls` still records every call, so assert exact call counts through it.

  `"*"` remains the fallback key, and `userInput` remains a flat array.

  Docs: the quickstart's first run is a three-line inline executor (`executors: { generateText: async () => ({ output: "…" }) }`) with no helper import; `createScriptedExecutors` is documented in `evals.md`, and `models-and-providers.md` shows the AI SDK's own `MockLanguageModelV3` from `ai/test` for testing the adapter path.

- [#122](https://github.com/statelyai/agent/pull/122) [`f953f5e`](https://github.com/statelyai/agent/commit/f953f5e5bd3f60aace430067fbaf6c7ec48dc975) Thanks [@davidkpiano](https://github.com/davidkpiano)! - **Scripted invoke failures.** `simulateAgent`, `explorePaths`, and `canReach` can now fail a request instead of resolving it, so a state that only an invoke's `onError` reaches is testable with no model and no keys.

  A `SimulationScript` gains an `errors` channel, keyed by the same srcs as `text`/`invokes`/`decisions`. An entry is consumed before that src's output queue, so the first call fails and later calls fall through to the outputs as usual.

  ```ts
  const result = await simulateAgent(machine, {
    script: {
      errors: { parse: [{ code: "truncated" }] },
      text: { parse: [{ total: 42 }] }, // still queued: the error was taken first
    },
  });
  // result.snapshot.value → the target of the `parse` invoke's onError
  ```

  A failure value is any value. An `Error` is the usual one, and a plain object reaches the `onError` transition as `event.error` untouched, so a machine that branches on `event.error.code` needs no provider error class to test. An entry keyed by a decision src stands in for retry exhaustion. A rejection nothing catches errors the machine and throws, as a live run does.

  Every `trail` entry's `resolvedRequest` now reports an `outcome` of `'output'` or `'error'`, and a rejected one carries the failure value on `error`.

  `explorePaths` and `canReach` take a matching `errors` map of one canned failure per src. A src listed there forks an extra branch where the invoke is rejected — both branches when the src also has an output, the failing one alone when it does not. Each fork counts against `maxDepth`, and the failing branch records `{ type: 'xstate.error.actor.<id>' }` in the path, so a witness names the failure that got there.

  ```ts
  const failure = await canReach(machine, "failed", {
    errors: { parse: new Error("truncated response") },
  });
  // failure.reachable → true; failure.witness → [{ type: 'xstate.error.actor.parse' }]
  ```

- [#120](https://github.com/statelyai/agent/pull/120) [`5ec7e57`](https://github.com/statelyai/agent/commit/5ec7e577c338a2d66183694a2f333915344e6991) Thanks [@davidkpiano](https://github.com/davidkpiano)! - New exports for the interaction, decision, and verification surfaces:

  - `interactionMetaSchema` (plus the `AgentInteractionMeta`, `AgentInteractionDescriptor`, and `AgentInteractionEventMeta` types) validates the `meta.interaction` shape `getInteraction` reads, so machines stop restating it.
  - `getInteraction(snapshot, { preserveWhitespace })` keeps deliberately multi-line labels intact; the default still collapses whitespace.
  - `getInteraction` and `eventFromInteraction` are now generic over the snapshot, so the returned choices and event are typed as the machine's own event union instead of `EventObject`.
  - `createDecisionRequest({ model, events, ... })` builds an `AgentDecisionRequest` for `resolveDecision`, filling in `kind`, `id`, `attempts`, and each candidate's `toolName`.
  - `getStatePath(snapshot)` renders nested and parallel state values as one deterministic string (`review.editing`, `p:{left.x,right.y}`).
  - `DoneActorEventOf<TLogic, TId?>` types a wildcard `xstate.done.actor` handler for dynamically spawned children.
  - `lintAgentMachine` adds the `invoke-without-on-error` warning for an invoke with no `onError` and no ancestor error handling.
  - `createScriptedExecutors` now fails with a clear error naming the known script keys when a name-keyed `text`/`decisions` script has no route for a request name.
  - `isAgentMessages(value)` is the type guard behind `messagesSchema`, for zod context schemas: `messages: z.custom<AgentMessage[]>(isAgentMessages)`. A zod object cannot nest a Standard Schema directly; the `messagesSchema` doc comment now says so.

- [#123](https://github.com/statelyai/agent/pull/123) [`5a384af`](https://github.com/statelyai/agent/commit/5a384af797275048c76ef56eb61016a04af07c2f) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Events off the wire are parsed at the boundary, and an event the state does not handle is ignored rather than refused.

  State machines ignore events they have no transition for. The library no longer turns that into an error.

  **`parseAgentEvent(machineOrSnapshot, payload, options?)`** is the one boundary parser. It takes `unknown` (hand it `await request.json()`), reads the event schemas `setupAgent` registered on the machine, and returns the event typed as the machine's event union. It throws the new `AgentInvalidEventPayloadError` (code `invalid-event-payload`) when the payload is not an object with a string `type`, names a reserved `@agent.*` type, or fails its registered schema. It does not look at the current state: payload shape is what a schema can check.

  ```ts
  let event;
  try {
    event = parseAgentEvent(machine, await request.json());
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }

  const result = await runAgent(machine, { store, threadId, event, executors });

  if (result.ignored) {
    return Response.json(
      { error: `'${result.ignored.type}' does not apply here` },
      { status: 409 }
    );
  }
  ```

  **`result.ignored`** is the resume event the root actor took no transition for (no state change, no actions). The run settles normally, usually back to `idle` at the same state. The event is still journaled like any other external input, so a replay ignores it again. A host that wants a 4xx checks this; nothing else has to.

  **Breaking (alpha):**

  - `AgentIllegalResumeEventError` is removed. `runAgent({ snapshot, event })` no longer throws when the restored state has no transition for `event` — it sends it and reports `result.ignored`.
  - `parseAgentEvent` no longer throws on an event type the current state does not accept, and no longer takes `eventToolName`. It now accepts a machine as well as a snapshot, and an `unknown` payload.
  - `eventFromInteraction` throws `AgentInvalidEventPayloadError` instead of `AgentIllegalResumeEventError` for a choice the interaction does not offer.

### Patch Changes

- [#126](https://github.com/statelyai/agent/pull/126) [`685a54e`](https://github.com/statelyai/agent/commit/685a54e73fe8c0fe0b3fd09b3763cdfb43e9e6a7) Thanks [@davidkpiano](https://github.com/davidkpiano)! - `examples/consensus-review`: `runConsensusReviewExample` takes `patch` instead of `input`. The host decides whether a patch is trusted; a caller-supplied patch is always external and always reaches human review.

- [#124](https://github.com/statelyai/agent/pull/124) [`2cf061e`](https://github.com/statelyai/agent/commit/2cf061e3031cb8b63c351d36ff4e0ac04891056e) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Add offline examples for parallel reviewer quorum, booking compensation, and host-scheduled approval deadlines, with typed machines, failure-path tests, and host ownership documentation.

- [#123](https://github.com/statelyai/agent/pull/123) [`4bd87d9`](https://github.com/statelyai/agent/commit/4bd87d93b7fcb1b85393b7beeca4d2dceaa890ee) Thanks [@davidkpiano](https://github.com/davidkpiano)! - Registered schemas now survive `machine.provide(...)`. `runAgent` starts its actor from a rebound machine, so `parseAgentEvent(result.snapshot, ...)` and `getInteraction(result.snapshot)` found no schemas and skipped validation: a bad payload passed through unchecked, and a choice whose payload the schema says is incomplete was judged against an `undefined` field. The registry is now keyed on the machine's root `config` as well as the machine object — `config` is shared by reference across `.provide` — so a result snapshot resolves the same pack `setupAgent` registered. `getAgentSchemas` reads through the same fallback.

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
