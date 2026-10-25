# API simplification for agent authors

Based on `527a5e2` (`next`, October 25, 2026). Branch: `ccr-1d1b3124-dvsyao`.

## The design rule

Coding agents write most of the code that uses this package, and agents rewrite the policy machines from traces. That changes what a good API looks like:

- **One way per concept.** An agent copies whichever form it saw last. Two equivalent spellings split the examples, the docs and the generated code, and every reviewer has to know both.
- **Data before closures.** A policy that improves between runs has to be something a model can write, diff and gate: an `AgentWorkflowConfig`, not a factory that takes callbacks.
- **The type checker and the gates are the feedback loop.** An undeclared event should be a compile error, and an invalid policy should fail `verifyAgentConfig` with a JSON pointer, not fail at run time.
- **A small root.** The root entry should hold what authoring and running need. Adapter-authoring and log internals belong on their own subpaths, where an agent only finds them when it is writing an adapter or a store.

## Why this beats a LangGraph graph for self-improving agents

| | LangGraph `StateGraph` | Stately Agent machine |
| --- | --- | --- |
| What the model may do next | Whatever the node function returns; routing is a function returning a node name | Only an event the current state accepts. `agent.decide` offers exactly those, and guards refuse the rest |
| What an improver edits | Python/TS node functions and edges, built imperatively | A JSON policy (`AgentWorkflowConfig`) inside a fixed TypeScript environment |
| Gate before it runs | None built in | `verifyAgentConfig`: schema, vocabulary, lowering, lint, exploration |
| Proving a rule holds | Tests over sampled runs | `canReach` over every listed event sequence and payload variant |
| Scoring a candidate | Re-run and compare outputs | Replay the event log with no model calls; refused attempts are in the log (`getDecisionAttempts`) |
| Resume | Checkpointer plus `Command({ resume })`, an untyped value | A typed event against a persisted snapshot or the log |

The simplifications below protect that advantage. Each removal leaves the improver fewer forms to emit and reviewers fewer forms to check.

## Done in this branch

| Removed | Use instead | Why |
| --- | --- | --- |
| `runToQuiescence(createAgentRuntime(m, opts), init)` | `runAgent(m, { ...opts, ...init })` | The same call spelled two ways: 119 example files used one spelling and 58 the other |
| `createAgentSchemas`, `setupAgent({ schemas })` | `setupAgent({ context, events, input, output })` | Two schema forms. Omitting `events` now means "no custom events", so an undeclared event is a type error |
| `agent.generateText`, `agent.streamText` (inline) | A `requests` entry, invoked by key | Not in any example. Bypassed the vocabulary gate, and under the runtime it dropped inline `outputSchema` |
| `@statelyai/agent/machines` (7 presets, ~2,300 lines with tests and docs) | The examples (`prompt-chaining`, `agent-supervisor`, `swarm-handoff`, `map-reduce`, `review-tool-calls`) | No example imported it, and presets took closures, so they could not be JSON policies |
| `assertAgentMachine` | `lintAgentMachine(m, { throw: true })` | Alias |
| `inspectTransitions`, `parseOutput`, `bindRequestExecutor`, `WithAgentUsageEvent` | `inspect`; the validated `onDone` output; `withExecutor` or `provideExecutors`; `WithAgentEvents` | Wrappers and aliases |
| Six `@statelyai/agent/log` exports, ~18 adapter mapper exports | Nothing (internal) | Only `src` and tests used them |

Bugs fixed on the way, each with a regression test:

- A final state without an `output` reported another final state's output. The "single final output" sugar existed in three copies (`setupAgent`, `fromConfig`, the step path), and XState already sets the root output from the final state it reaches. All three copies are deleted.
- A decision with its own executor was replaced by the host's `decide` at the top level of a run, but not in a child machine or under `provideExecutors`. A decision inside a child machine used the root's event schemas. A decision bound twice lost `allowedEvents`. The runtime, child and `provideExecutors` paths now share one binder, `bindAgentSources`. These were findings 05 and 09 of `plans/portable-agent-audit.md`.
- The AI SDK adapter passed `maxSteps: NaN` or `Infinity` to `stepCountIs`, so the tool loop never stopped.

Net, in non-test source: about 3,400 lines deleted and 1,200 added (half of those are adapter mappers moved into private files), 7 fewer root exports, one fewer subpath, and all three adapters built from one internal kit (`src/internal/adapter-kit.ts`).

## Proposed next

These need a decision from a maintainer, because they change documented behavior or a contract others implement. They are ranked by value to an agent author.

### 1. One observation option: `onTrace`

`runAgent` takes seven observers: `onTrace`, `onTransition`, `onChunk`, `onResult`, `on`, `onEvent` and `inspect`. Three of them (`onTransition`, `onChunk`, `onResult`) are documented as sugar over `onTrace`. Instead, let `onTrace` take a function or a handler map keyed by trace type:

```ts no-check
runAgent(machine, {
  executors,
  input,
  onTrace: {
    "machine.transition": ({ snapshot }) => progress.push(getStatePath(snapshot)),
    "stream.chunk": ({ chunk, request }) => send(request.id, chunk),
  },
});
```

- Keep `on`, for the machine's own emitted vocabulary, and `inspect`, the raw XState passthrough for the Stately Inspector.
- Rename `onEvent` to `onLogEntry`: it receives log entries, not events.
- This removes `createTraceDispatch`, the `TraceSinks` type and the per-callback ordering rules (about 70 lines plus docs).
- Migration cost: `onTransition` appears in about 60 example files. A codemod handles it, the same way this branch's `runAgent` codemod did.

### 2. Move adapter-authoring helpers to `@statelyai/agent/executors`

The root still exports what only an adapter or a hand-written executor needs: `resolveDecision`, `createDecisionRequest`, `renderDecisionAttempts`, `getCallUsage`, `getCallFinishReason`, `providerOutputSchema`, `parseProviderOutput`, `getAgentOutputMode`, `getJsonSchema`, `getJsonSchemaSync`, `isStandardSchema` and the `TextLogic*` types.

- Moving them leaves a root of about 30 values covering authoring (`setupAgent`, `createTextLogic`, message helpers), running (`runAgent`, `createAgentRuntime`) and the host boundary (`parseAgentEvent`, `getAcceptedEvents`, `getInteraction`, `eventFromInteraction`, `decideNext`, `describeMachine`).
- The JSON form of the trace, `serializeTraceEvent` and `JsonSerializableTraceEvent`, belongs with the other persisted formats in `/log`.

### 3. One decision vocabulary

Decisions currently use seven names: `agent.decide`, `createDecisionLogic`, `decideNext`, `createPolicyDecider`, `resolveDecision`, `createDecisionRequest` and `renderDecisionAttempts`.

- Keep `agent.decide` for a decision inside the machine, `decideNext` for one at a plain machine's boundary, and `createPolicyDecider` to turn a policy machine into an executor.
- `createDecisionLogic` has no example. Make it the internal engine of `agent.decide`; the audit found the two duplicate their run checks and request lowering.
- The rest move to `/executors` (proposal 2).

### 4. Event schemas looked up, never passed

`getAcceptedEvents`, `parseAgentEvent` and `getInteraction` accept `{ events }` or `{ schemas }` to find event payload schemas. The "registered schemas, else `machine.schemas.events`" lookup is written out in five files.

- One `eventSchemasOf(machine)` makes the option unnecessary for every machine built by `setupAgent` or `fromConfig`.
- It also fixes `decideNext`, which reads only `machine.schemas` and so misses the payload schemas of a `fromConfig` machine.

### 5. Close the gap between the JSON schema and lowering

`schemas/agent-workflow.json` accepts configs that lowering then rejects:

- `Identifier` allows `.` in state keys.
- `choice` branches reuse `TransitionOrArray`, which allows `actions`.

A model that writes either one passes the `validate` gate and fails at `lower`, with a less specific message. Add a `StateKey` definition without `.` and a `ChoiceBranch` definition without `actions`, so the diagnostic arrives at gate 1 with a JSON pointer. This is small, and it is the gate an improver hits most.

### 6. One script vocabulary for testing

The testing helpers describe "canned outputs per source" three different ways:

| Helper | Options it takes |
| --- | --- |
| `simulateAgent` | `{ text, decisions, invokes, errors: arrays, events }` |
| `explorePaths` / `canReach` | `{ outputs, errors: single value, payloads }` |
| `runSeam` | `{ scripts }`, keyed by request name or model |

Use `{ outputs, errors, events }` keyed by src everywhere, with the same `errors` shape. An agent writing a test then uses one vocabulary.

### 7. A two-method store contract

The runtime calls only `append` and `read`. `length` is used only by the conformance suite, and `fork` is read, then `forkEventLog`, then append.

- Make both optional, or remove them and ship `forkThread(store, from, to)`.
- Hosts write less code (`examples/code-review-loop/file-store.ts`, `examples/cloudflare-agent-host/event-log-store.ts`), and so do agents asked to put the log in a new database.

### 8. Model settings mean the same thing in every adapter

- `settings` is "applies to every call" in the AI SDK and TanStack AI adapters, but "a map keyed by model ref" in the OpenAI adapter, where `settings: { reasoning_effort: "high" }` throws.
- The pair keys differ too: `{ model, settings }` in one adapter, `{ adapter, settings }` in another.
- `createAiSdkExecutors(machine)` cannot take settings, so adding any forces the caller to switch to the other overload.
- Proposal: one meaning, one pair key, and `createAiSdkExecutors(machine, { settings })`.
- Move closed-choice option encoding and the JSON-repair parse into core. Today only the AI SDK adapter has them, so OpenAI and TanStack users silently get weaker decisions.

### 9. Decide what `provideExecutors` is for

The uncontrolled path (`provideExecutors` plus `traceTransitions`) is about 450 lines: the root-trace registry, its bind context and its own validator. One example uses it. It is the only way to run an agent machine as a child of an application-owned XState actor, so removing it is a product call.

If it stays, it should be the runtime's binder with a different actor, which this branch has started (`bindSourcesForProvide`). Its separate missing-executor validator (`assertChildBindable`) should become an option on `assertMachineBindable`.

### 10. Smaller items

- **Type helpers.** `InputOf<Machine>` returns the validated input, while `InputOf<Setup>` and `AgentInputFrom` return the caller-facing side. Make `InputOf` the caller-facing side and drop `AgentInputFrom`. Drop `SnapshotOf` and `StateValueOf`, which are XState aliases.
- **`describeMachine`.** It parses TypeScript function source with about 160 lines of regex heuristics. With JSON-first policies it could describe configs exactly and TypeScript machines structurally.
- **`foldTraces` and `getDecisionRequests`.** These read traces, while the self-improvement examples read the log. Make the log the one input to diagnosis, and fold `getDecisionRequests` into `foldTraces`.
- **`compareRuns`.** It is a generic parity harness whose only consumer is the `loop-to-machine` skill. It could move into the skill as a snippet.

## Found, not fixed

- **AI SDK adapter, `streamText`.** It ignores `outputSchema`; the OpenAI and TanStack adapters throw.
- **OpenAI adapter, `streamText`.** It refuses tools; the other two run them.
- **AI SDK adapter, `decide`.** It returns the raw SDK `finishReason` (which can be `'error'`); the others return `AgentFinishReason`.
- **Adapter tests.** None of the adapters tests the "unknown tool" path.
