# LangGraph Core Replacement Design

## Goal

Evolve `agent` into a LangGraph-core replacement in terms of runtime behavior and developer outcomes, while improving on LangGraph through a simpler, more explicit state-machine model.

The target is semantic parity for core orchestration use cases, not API compatibility. Developers should be able to build the same classes of systems in `agent` that they can build with LangGraph core, but using `agent`'s state-machine API and philosophy.

## Core Philosophies

The design is constrained by these principles:

1. Logic is pure.
   The semantic center remains:

   ```ts
   (currentState, event) => {
     return { nextState, effects };
   }
   ```

   State transition logic should stay deterministic, replayable, and inspectable.

2. Effect execution is first-class.
   The runtime must make it easy to both transition state and execute effects, but without collapsing transition logic into effectful code. Effects are driven by the machine, not hidden as the machine.

3. Durability is core.
   `agent` should treat persisted state and event history as first-class runtime concerns, not as optional add-ons.

4. Runner-agnostic execution.
   The runtime must be able to run anywhere: Node, Vercel, Cloudflare, Durable Objects, workers, and other environments. Storage and execution coordination must be abstracted behind portable interfaces.

5. Improve on LangGraph rather than imitate it.
   Do not copy LangGraph's graph-builder surface area or its more complex runtime semantics where a simpler state-machine formulation produces the same outcome.

## Scope

In scope:

- core orchestration behavior currently covered by `@langchain/langgraph`
- runtime behavior tests and runnable examples from LangGraph core, rewritten as `agent`-idiomatic equivalents
- persistence, replay, resume, streaming, pending states, submachine composition, and high-value prebuilt agent patterns

Out of scope for this design:

- LangGraph monorepo packages outside core
- API/CLI/server packages
- UI framework SDKs and app templates
- type-level compatibility with LangGraph
- exact API or import-path matching

## Design Summary

`agent` should become a durable run engine for state machines.

A machine definition remains declarative and mostly pure:

- states
- transitions
- invoke/effect boundaries
- final outputs

A run becomes the primary runtime object:

- backed by an append-only replay journal
- accelerated by persisted snapshots
- observable through a first-class event stream
- resumable from persisted state
- portable across runners via abstract persistence and scheduling interfaces

This yields a model where the semantics are simple:

- transitions are deterministic
- invokes are explicit effect boundaries
- external and internal machine events drive progress
- streaming is run-level, not bolted on
- persistence is a core contract

## Runtime Model

The machine model should stay state-machine-first rather than graph-builder-first.

### Machine Definition

A machine definition remains responsible for:

- context initialization
- current state value
- transition handlers
- invoke definitions
- terminal outputs

The machine should continue to express workflows such as:

- branching
- tool-using agents
- human review loops
- multi-step planning and execution
- nested machine orchestration

### Run Model

Introduce a durable session as the central execution concept.

`sessionId` should be the canonical persisted identifier.

`run` can still be a useful public term for the live handle returned by the runtime, but the durable identity should align with actor/session terminology.

Each run has:

- `sessionId`
- `machineId`
- input payload
- current snapshot
- append-only replay journal
- status
- subscribers

Suggested shape:

```ts
interface AgentRun {
  sessionId: string;
  status: "active" | "pending" | "done" | "error";
  getSnapshot(): AgentSnapshot;
  send(event: { type: string; [key: string]: unknown }): Promise<void>;
  on(type: string, handler: (event: unknown) => void): () => void;
}
```

An async-iterator surface is still useful, but it is additive. The emitter-style `on(...)` API is the required phase-1 contract.

`on(...)` is a live listener only. It should not be treated as a history or replay API. Historical actor events belong to the journal/store layer.

### Durable Execution Boundaries

Phase 1 durability should exist at machine boundaries, not inside arbitrary user async code.

Persist the replayable machine events:

- external events sent to the actor
- internal machine events emitted by the runtime
- invoke completion events
- invoke failure events

Do not claim sub-invoke durability for plain `Promise.all(...)` or arbitrary nested promises.

### Pending and Human-in-the-Loop

Do not introduce an interrupt primitive as a core concept.

Use explicit pending states and external events:

```ts
review: {
  on: {
    approve: { target: "send" },
    reject: { target: "revise" },
  },
}
```

This preserves:

- deterministic replay
- explicit control flow
- durable resume semantics
- runner portability

### Submachine Composition

Do not introduce graph/subgraph composition as a first-class structural primitive in phase 1.

Instead, allow composition through normal execution:

```ts
writing: {
  invoke: async ({ context }) => {
    return executeAgentMachine(writerMachine, {
      input: {
        topic: context.topic,
        research: context.research,
      },
    });
  },
}
```

This is sufficient for most LangGraph subgraph outcomes without graph-specific composition APIs.

## Purity and Effects

The central architectural requirement is preserving pure transition logic while still making effects first-class.

Conceptually, every runtime step should be explainable as:

```ts
const { nextState, effects } = transition(currentState, event);
```

Where:

- `nextState` is deterministic
- `effects` are explicit runtime work to perform next

In practice, current `agent` APIs already combine these concerns inside state configs. The design should move the runtime toward an explicit internal split even if the external authoring API remains ergonomic.

That means:

- transition logic should remain replayable without rerunning effects
- effect lifecycle should be represented through emitted machine events
- invoke results should be fed back as events, not hidden mutations

This should follow the same philosophy as XState invoke completion:

- invoke completion becomes an internal done event
- invoke failure becomes an internal error event
- the machine progresses by consuming events, not by direct mutation from effect code

This is the main improvement opportunity over LangGraph's more graph-runtime-centric model.

## Persistence Model

The canonical persisted representation is an append-only replay journal.

Snapshots are derived state used to accelerate replay and resume.

### Replay Journal

The replay journal is the source of truth. It contains the actual events consumed by the actor, including synthetic internal events produced by the runtime.

Suggested minimal replayable event family:

```ts
type JournalEvent =
  | { type: "xstate.init"; input?: unknown; at: number }
  | { type: "user.message"; [key: string]: unknown; at: number }
  | { type: "approve"; at: number }
  | { type: "xstate.done.invoke.research"; output: unknown; at: number }
  | {
      type: "xstate.error.invoke.research";
      error: SerializedError;
      at: number;
    };
```

The exact event naming can be refined, but the important property is that invoke done/error are actor events, not metadata records.

### Runtime and Audit Events

Derived runtime records can still exist for observability and subscriptions, but they are not the canonical replay source.

Examples:

- state entered
- transition applied
- snapshot persisted
- session completed
- session failed

These belong in the runtime event stream and diagnostics layer.

### Snapshots

Suggested snapshot shape:

```ts
type AgentSnapshot = {
  value: string;
  context: Record<string, unknown>;
  status: "active" | "done" | "error" | "pending";
  createdAt: number;
  sessionId: string;
  input: Record<string, Record<string, unknown>>;
  output?: unknown;
  error?: SerializedError;
};

type PersistedSnapshot = {
  sessionId: string;
  snapshot: AgentSnapshot;
  afterSequence: number;
  createdAt: number;
};
```

This aligns the live snapshot shape closely with XState snapshots:

- `value`
- `context`
- `status`

with additional metadata such as:

- `createdAt`
- `sessionId`
- optional `output`
- optional `error`

The `afterSequence` field identifies the last replayable journal event already reflected in the snapshot, so replay can resume from a known journal offset without inventing a separate semantic version.

### Replay Model

Restore a run by:

1. loading the latest snapshot
2. replaying all journal events after that snapshot
3. reconstructing the current live run state

If no snapshot exists, replay from `xstate.init`.

### Storage Interface

Persistence must be abstracted behind a portable interface:

```ts
interface RunStore {
  append(sessionId: string, event: JournalEvent): Promise<void>;
  loadEvents(sessionId: string, afterSequence?: number): Promise<JournalEvent[]>;
  loadLatestSnapshot(sessionId: string): Promise<PersistedSnapshot | null>;
  saveSnapshot(snapshot: PersistedSnapshot): Promise<void>;
}
```

This is what makes the runtime portable to:

- in-memory test stores
- SQL or key-value stores
- Cloudflare Durable Objects
- Vercel-backed durable layers
- custom app infrastructure

### Important Phase 1 Constraint

Invoke internals are opaque unless user code or future helpers explicitly expose finer-grained durable progress.

This means:

- plain async code remains ergonomic
- invoke-level durability is honest
- future `task(...)` or `parallel(...)` helpers remain additive

## Streaming Model

Streaming must be a first-class capability of a run.

Separate:

1. durable runtime events
2. ephemeral stream parts

### Run-Level Events

Suggested public stream model:

```ts
type RunEmitterEvent =
  | { type: "state"; snapshot: AgentSnapshot }
  | { type: "machine.event"; event: JournalEvent }
  | { type: "runtime"; event: RuntimeEvent }
  | { type: "part"; part: StreamPart }
  | { type: "done"; output: unknown }
  | { type: "error"; error: unknown };
```

Where `machine.event` refers to replayable actor events and `runtime` refers to derived lifecycle records useful for debugging and orchestration.

These event shapes describe what a live run may emit. They do not imply that late subscribers receive replayed history through `on(...)`.

Suggested runtime event family:

```ts
type RuntimeEvent =
  | { type: "session.started"; sessionId: string; at: number }
  | { type: "session.restored"; sessionId: string; afterSequence: number; at: number }
  | { type: "snapshot.persisted"; sessionId: string; afterSequence: number; at: number }
  | { type: "session.completed"; sessionId: string; at: number }
  | { type: "session.failed"; sessionId: string; error: SerializedError; at: number };
```

Derived events such as `state.entered` and `transition.applied` are still useful for richer inspection, but they are not required for this phase.

### Stream Parts

For common model/tool streaming shapes, align with Vercel AI SDK-style part conventions where practical:

```ts
type StreamPart =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "reasoning-part"; text: string }
  | { type: "data"; data: unknown }
  | { type: "error"; errorText: string };
```

Provide convenience listeners on top:

```ts
run.on("textPart", ({ delta }) => {});
run.on("toolCall", ({ toolCallId, toolName, input }) => {});
run.on("toolResult", ({ toolCallId, output }) => {});
```

### Emission Model

Invoke code should be able to emit live parts using a separate enqueue/emission argument:

```ts
drafting: {
  invoke: async ({ context }, enq) => {
    for await (const chunk of streamText(...)) {
      enq.emit({ type: "text-delta", id: "draft", delta: chunk });
    }
    return { draft: finalText };
  },
}
```

Durable runtime events are persisted. Stream parts are ephemeral by default in phase 1.

Using a second argument is important because it preserves a useful authoring distinction:

- one-argument functions are easier to lint as pure/no-emission
- two-argument functions explicitly opt into streaming side effects

### Emitted Schemas

Machine definitions should support emitted event schemas alongside input and external event schemas.

Suggested direction:

```ts
schemas: {
  input: ...,
  events: {
    approve: ...,
    reject: ...,
  },
  emitted: {
    textPart: ...,
    toolCall: ...,
    toolResult: ...,
  },
}
```

This gives:

- typed live emissions
- runtime validation of emitted parts
- stronger UI integration
- symmetry with event schemas

## Runner-Agnostic Architecture

The runtime must not assume:

- long-lived Node processes
- a specific queue system
- a specific database
- process-local memory as truth

The core should be split into:

1. pure machine semantics
2. durable run orchestration
3. storage abstraction
4. environment-specific runner adapters

This makes it possible to showcase:

- standard Node process usage
- Vercel usage
- Cloudflare Worker usage
- Cloudflare Durable Object usage

Durable Objects are especially relevant because they demonstrate the design clearly:

- replay journal and snapshot persistence can live in DO state
- run coordination can be serialized naturally
- stream subscriptions can be implemented via the object lifecycle

The important point is that Durable Objects should be an example adapter, not the core assumption.

## Capability Mapping from LangGraph Core

### Directly Mappable

- graph orchestration -> explicit machine states and transitions
- shared state update workflows -> `invoke` + `onDone` context updates
- human-in-the-loop -> pending states + external events
- subgraphs/subflows -> nested machine execution
- streaming -> run-level event emitter + stream parts + emitted schemas
- persistence/resume -> event journal + snapshots
- prebuilt agent patterns -> curated machine factories

### Needs Reinterpretation

- reducers/channels -> avoid first-class graph-channel runtime semantics in phase 1
- graph builder APIs -> do not mirror
- `START` / `END` constants -> unnecessary as authoring primitives
- explicit interrupt primitive -> defer

### Deferred

- graph-level true concurrent branch semantics with reducer joins
- durable sub-invoke task boundaries
- remote/API client compatibility
- type-level compatibility tests

## LangGraph Test Port Strategy

Only port:

- runtime behavior tests
- runnable examples

Do not port:

- type-only tests
- API surface compatibility tests

### Priority Test Groups

1. Graph/state behavior
   - `graph.test.ts`
   - `errors.test.ts`
   - `constants.test.ts`

2. Execution/runtime behavior
   - selected `pregel.test.ts`
   - `pregel.read.test.ts`
   - `pregel/stream.test.ts`
   - `execution_info.test.ts`

3. Persistence and replay
   - `python_port/checkpoint.test.ts`
   - `remote-graph-resumable.test.ts`

4. Prebuilt agent behavior
   - `prebuilt.test.ts`
   - `prebuilt.int.test.ts`

5. Runtime schema behavior
   - relevant portions of `zod_state.test.ts`

Each imported test should become an `agent`-idiomatic equivalent that asserts the same end-result behavior through the state-machine runtime.

## Example Port Strategy

Priority LangGraph-equivalent examples to rebuild in `agent`:

1. quickstart
2. branching
3. wait-user-input / breakpoints
4. persistence
5. subgraph
6. tool-calling
7. create-react-agent / react-agent-from-scratch
8. multi-agent-network
9. plan-and-execute
10. reflection
11. rewoo
12. sql-agent

Each example should:

- use `agent`'s machine API
- be runnable locally
- demonstrate the same user outcome
- prefer explicit machine structure over graph-builder mimicry

## Phased Delivery Plan

### Phase 0: Lock the Core Contract

Define:

- durable run contract
- store interfaces
- restore/replay semantics
- stream event model

### Phase 1: Durable Runtime

Build:

- run object
- journal append/load
- snapshotting
- restoration
- run subscriptions

### Phase 2: Expressiveness

Build:

- better nested machine execution
- pending-state ergonomics
- inspection/trace support
- graph/diagram export

### Phase 3: Prebuilt Patterns

Build:

- ReAct-style machine factory
- tool-calling helpers
- transcript/message helpers

### Phase 4: Example Corpus

Rebuild high-value LangGraph examples in `agent`.

### Phase 5: Behavioral Regression Coverage

Port and maintain semantic-equivalence tests grouped by capability family.

## Risks

1. Conflating transition logic with invoke execution.
   This weakens replay semantics and makes portability worse.

2. Over-promising invoke-level durability.
   Plain async code is not automatically resumable at subtask granularity.

3. Recreating LangGraph builder abstractions instead of improving on them.
   This increases complexity without serving the machine-first philosophy.

4. Mixing durable and ephemeral streams carelessly.
   Runtime events and text/tool stream parts need distinct semantics.

5. Allowing runner assumptions to leak into core.
   This would compromise portability across Vercel, Cloudflare, and other environments.

## Advantages Over LangGraph

This design improves on LangGraph core in several important ways:

1. Clearer semantic center.
   LangGraph is graph-runtime-first. This design is actor/state-machine-first, so the progression model stays grounded in event consumption and snapshot derivation.

2. Better purity boundary.
   Transition logic remains conceptually pure, while effect execution is explicit and first-class rather than interwoven with graph runtime semantics.

3. Simpler human-in-the-loop model.
   Pending states plus external events are easier to reason about than a dedicated interrupt abstraction for most workflows.

4. More honest durability.
   The replay source is the actor event journal, not a mixed bag of runtime metadata. This makes replay and debugging cleaner.

5. Better portability.
   The runtime is explicitly designed to be runner-agnostic and storage-agnostic, making it a stronger fit for Vercel, Cloudflare Workers, Durable Objects, and other environments.

6. Easier mental model for composition.
   Nested machine execution is ordinary execution, not a special graph/subgraph system.

7. Better streaming ergonomics.
   Run-level subscriptions plus emitted schemas provide a clearer UI/runtime boundary than LangGraph's graph-oriented stream modes.

## Recommendation

Proceed with a capability-first expansion of `agent`'s runtime:

- keep the machine API central
- make durable runs the execution center
- treat event persistence and snapshots as first-class
- make streaming run-level and explicit
- port LangGraph tests/examples as semantic benchmarks

This produces a cleaner, more durable, and more portable core than LangGraph while still reaching the same practical developer outcomes.
