# @statelyai/agent — Alpha P0 Design

Status: **implemented** (branch `p0-alpha`, 2026-07-02). P0 landed as four commits — messages, decisions, runAgent, sweep + fixtures — and the branch has since carried follow-on P1 work: the AI SDK adapter, a `setupAgent` event-payload narrowing fix, example migration to the blessed authoring path, a docs rewrite, and a co-located-decisions detour (`setupAgent({ decisions })`) that was added and then reverted in favor of state-local decisions. Verified green at every commit. This document specified the exact type shapes and behavior before code landed; it is now the reference for what shipped. One naming refinement vs the spec: `RunAgentOptions.userInput` is typed via the named `AgentUserInputExecutor` alias (identical signature).

Scope (P0 only):

1. `AgentMessage` parts model + `messagesSchema` (breaking)
2. Decision primitive: `agent.decide` + `createDecisionLogic` + `allowedEvents` + `resolveDecision`
3. `runAgent` as a `createActor` wrapper (return union `done|idle|error`, resume, `onTransition`, `maxModelCalls`)
4. Step-helper separation + `normalizeGeneratorResult` simplification

Deferred to P1+ (not in this doc): `createAiSdkExecutors`, `setupAgent` surface consolidation, example rewrites, the `decide`-block sugar, docs.

---

## 1. `AgentMessage` — parts model

### 1.1 Motivation

Today (`src/types.ts`):

```ts
export type AgentMessage = { role: string; content: string; [key: string]: unknown };
```

`content: string` can't carry multimodal input or tool-call/tool-result turns, and widening it later is breaking. We spend the break now by mirroring AI SDK v6 `ModelMessage` **structurally, in-library** (no import from `ai`, so `ai` stays an optional peer).

### 1.2 New types (`src/types.ts`)

```ts
export type DataContent = string | Uint8Array | ArrayBuffer;
export type ProviderOptions = Record<string, Record<string, unknown>>;

export interface TextPart {
  type: 'text';
  text: string;
  providerOptions?: ProviderOptions;
}

export interface ImagePart {
  type: 'image';
  image: DataContent | URL;
  mediaType?: string;
  providerOptions?: ProviderOptions;
}

export interface FilePart {
  type: 'file';
  data: DataContent | URL;
  mediaType: string;
  filename?: string;
  providerOptions?: ProviderOptions;
}

export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerOptions?: ProviderOptions;
}

export type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: unknown }
  | { type: 'content'; value: Array<TextPart | ImagePart> };

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
  providerOptions?: ProviderOptions;
}

export type SystemMessage = {
  role: 'system';
  content: string;
  providerOptions?: ProviderOptions;
};
export type UserMessage = {
  role: 'user';
  content: string | Array<TextPart | ImagePart | FilePart>;
  providerOptions?: ProviderOptions;
};
export type AssistantMessage = {
  role: 'assistant';
  content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>;
  providerOptions?: ProviderOptions;
};
export type ToolMessage = {
  role: 'tool';
  content: Array<ToolResultPart>;
  providerOptions?: ProviderOptions;
};

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;
```

**Decisions baked in:**

- Tool-results live in a `tool`-role message (AI SDK convention), not folded into user messages (Anthropic convention). Adapter maps identity.
- `Buffer` dropped from `DataContent` (it extends `Uint8Array`; keeps core runtime-agnostic).
- `ReasoningPart` and tool-approval parts **omitted** — non-breaking to add later.
- The open `[key: string]: unknown` index signature is **removed**. `providerOptions` is the sanctioned passthrough. → *migration break for anyone stuffing arbitrary fields onto messages.*
- **Durable persistence stance (blueprint):** binary parts (`Uint8Array`/`ArrayBuffer`) and `URL` instances are not JSON-serializable; persisting context is the host's concern. Machines that persist snapshots/event logs should carry URL strings or base64 in parts. Enforced by documentation only — JSDoc on `ImagePart`/`FilePart` plus the persistence recipe. No serializer in P0.

### 1.3 Helpers (`src/utils.ts`)

```ts
export function systemMessage(content: string): SystemMessage;
export function userMessage(
  content: string | Array<TextPart | ImagePart | FilePart>
): UserMessage;
export function assistantMessage(
  content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>
): AssistantMessage;
export function toolMessage(content: Array<ToolResultPart>): ToolMessage; // NEW
```

Widening `content` params is backward-compatible for existing `userMessage('...')` call sites.

### 1.4 `messagesSchema`

Rewrite the validator (`setup-agent.ts`) to accept the union: `role ∈ {system,user,assistant,tool}`, and `content` either a string (where allowed) or an array of parts each with a known `type`. Rejects unknown roles and unknown part types.

### 1.5 Migration impact

- `AgentTextRequest.messages: AgentMessage[]` unchanged in name; element type changes.
- `toModelMessages` in the AI SDK host example currently does `role as 'user'|'assistant'|'system'` and passes `content` through as a string — becomes an explicit identity map to `ModelMessage` (P1, in `/ai-sdk`).
- Any example reading `message.content` as `string` unconditionally must narrow. Grep required.

**OPEN Q1.1:** keep `ToolResultOutput` as the 5-variant union above, or start with just `{ type:'text'|'json'; value }` and add error/content later? (Union is non-breaking to extend.)

---

## 2. Decision primitive

### 2.1 Concept

A **decision** is an async effect that resolves to exactly **one currently-legal event** and **raises** it into the machine. No output value. Forces a tool call. It replaces the `agentEvents`-on-text-logic mechanism, which is deleted.

- **Live runtime (`runAgent`/`createActor`):** the invoked `agent.decide` actor completes with `output = chosenEvent`; the state's `onDone` delivers it via `enq.sendTo(self, output)` (§2.5) into its own `on:` handlers.
- **Step runtime (durable hosts):** the decision surfaces in `step.requests` as an `AgentDecisionRequest` (`kind: 'decision'`, §2.6); the host calls `resolveDecision(...)` → `chosenEvent`, then `transitionAgentStep(...)`.

Both call the same `resolveDecision` core. Core does **no provider mechanics** — the decision path is symmetric with the `generateText` path: the host's `decide` executor (§2.6) returns `{ event, reason? }`, and core only validates and retries.

### 2.2 `allowedEvents` (canonical name)

Hard-rename from `agentEvents` (authoring) / `eventTypes` (request). **No alias** (pre-release). Lives only on decisions.

```ts
export type AllowedEvents<TEvent extends string = string> =
  | readonly TEvent[]
  | ((args: { input: unknown }) => readonly TEvent[]);
```

Semantics: declared candidates **∩ snapshot-legal events**. Omitted ⇒ all legal events. Resolver form allowed (runtime narrowing, e.g. HP-gated moves). Because it's intersected with legal events, a resolver can only ever *narrow* the real surface.

On the `runAgent` (live) path, this intersection is not computed once at bind time — candidate events are rebuilt from the **live snapshot at decision time** (declared `allowedEvents` ∩ currently-legal events, via `getAcceptedEvents`, with machine event schemas attached), identical in shape to step discovery's `getAgentRequests`. This is now fixed: an earlier version trusted a stale/defaulted event list instead of re-deriving it per decision.

### 2.3 `createDecisionLogic`

```ts
export interface DecisionLogicConfig<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TEvent extends string = string,
> {
  schemas?: { input: TInputSchema };
  model: ResolveTextLogicValue<string, InferOutput<TInputSchema>>;
  system?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  prompt?: ResolveTextLogicValue<string | undefined, InferOutput<TInputSchema>>;
  messages?: ResolveTextLogicValue<AgentMessage[] | undefined, InferOutput<TInputSchema>>;
  allowedEvents?:
    | readonly TEvent[]
    | ((args: { input: InferOutput<TInputSchema> }) => readonly TEvent[]);
  maxRetries?: number; // default 2
  temperature?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  maxOutputTokens?: ResolveTextLogicValue<number | undefined, InferOutput<TInputSchema>>;
  // ...same model params as TextLogic
  metadata?: ResolveTextLogicValue<Record<string, unknown> | undefined, InferOutput<TInputSchema>>;
}

export interface DecisionLogic<...> extends AsyncActorLogic<
  ChosenEvent,          // output = the raised event object
  InferOutput<TInputSchema>
> {
  readonly kind: 'statelyai.decisionLogic';
  readonly maxRetries: number;
  request(input): AgentDecisionRequest;   // parallel to TextLogic.request
  withExecutor(execute): DecisionLogic<...>;
}

export type ChosenEvent = { type: string; [key: string]: unknown };
```

- No `output` schema (a decision has no output value; its output *is* the event).
- Decisions are **generate-only** — there is no streaming decision.
- How the model is coerced into choosing (tool-per-event + `toolChoice: 'required'`, structured output over an event union, …) is **adapter business**, not core's (§2.6). `toolChoice` is therefore not configurable on decisions.
- Standalone `createDecisionLogic` types `allowedEvents` only as `string[]` (it doesn't know the machine's events). The inline `agent.decide` builtin (§2.4) types it against the machine's event-schema keys instead.
- **Superseded:** this section originally promised a co-located `setupAgent({ decisions: {...} })` form (P1) as the answer to `allowedEvents` typing. That form was built and then removed: decisions are **state-local by design** (a global decision registry duplicates the invoking state's `on:` handlers and invites drift). The typed answer is the inline `agent.decide` invoke (§2.4), whose `input` is typed against the machine's event-schema keys directly. `createDecisionLogic` remains for reusable/exported/standalone-testable decision logic registered under `actorSources:`.

### 2.4 Builtin `agent.decide` (v6-alpha-correct syntax)

Zero-config counterpart, symmetric with `agent.generateText`/`agent.streamText`. Invoked with inline input. **Side effects go through the `enq` param of a transition function — there is no `{ actions: [...] }` key and no standalone `raise()`/action-creator in v6 alpha** (verified against `xstate@6.0.0-alpha.16`: `types.v6.d.ts:416-436`, `types.d.ts:207-226`). Delivery is built into the decision actor: when the decision resolves, it sends the chosen event to the invoking actor automatically via an *external, observable* send (so it lands in the event log; see §4.3), **not** an internal `raise` (invisible).

```ts
choosingMove: {
  invoke: {
    src: 'agent.decide',
    input: ({ context }) => ({
      model: 'openai/gpt-5.4-mini',
      system: 'Choose exactly one legal move.',
      prompt: `Player ${context.playerHp} / Enemy ${context.enemyHp}`,
      allowedEvents: context.playerHp <= 6 ? lowHpMoves : defaultMoves, // optional
      maxRetries: 2,
    }),
    onError: { target: 'fumbled' },   // retries exhausted (§2.6)
  },
  on: {
    ATTACK: ({ context }) => ({ target: 'summarizing', context: { /* … */ } }),
    DEFEND: { target: 'summarizing' },
    FLEE: { target: 'done' },
  },
}
```

`allowedEvents` omitted ⇒ every legal event of `choosingMove` is offered. The chosen event is delivered to the state's `on:` handlers automatically; its transition usually exits `choosingMove`, cancelling the invoke, so `onDone` normally never runs. When the transition stays in-state, the invoke completes and an explicit `onDone` (optional, rare) observes the chosen event as output.

### 2.5 Automatic delivery (built into the decision actor)

Delivery is not a user-wired helper. When the decision resolves, the decision actor sends the chosen event to the invoking actor itself, via an external `sendTo(self, …)` (not internal `raise`) specifically so the decision is recorded in the observable event stream — this is what makes event sourcing (§4.3) work. The P3 `decide:` state-block sugar is just this invoke + `onError`.

### 2.6 `resolveDecision` — validation + retry core

Core does **no provider mechanics**. The decision path is symmetric with the `generateText` path: the host receives an `AgentDecisionRequest`, and its **`decide` executor** returns `{ event, reason? }`. *How* the model is made to choose — tool-per-event + `toolChoice: 'required'`, structured output over an event union, anything — lives in the adapter. `/ai-sdk` ships the default `decide` executor (P1); a structured-output variant is a documented recipe for providers without forced tool choice.

```ts
export interface AgentRequestExecutorInfo {
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

export type AgentRequestExecutor<TResult = AgentRequestExecutorResult> = (
  request: AgentTextRequest & { tools: AgentTools },
  info?: AgentRequestExecutorInfo
) => PromiseLike<TResult> | TResult;

/** Third executor slot, symmetric with generateText/streamText. */
export interface AgentRequestExecutors<
  TGenerateResult = AgentRequestExecutorResult,
  TStreamResult = AgentRequestExecutorResult,
> {
  generateText: AgentRequestExecutor<TGenerateResult>;
  streamText?: AgentRequestExecutor<TStreamResult>;
  decide?: AgentDecisionExecutor;
}

export type AgentDecisionExecutor = (
  request: AgentDecisionRequest
) => PromiseLike<{ event: ChosenEvent; reason?: string }>;

export interface AgentDecisionRequest {
  kind: 'decision';
  /** Durable invoke id. */
  id: string;
  model: string;
  system?: string;
  prompt?: string;
  messages?: AgentMessage[];
  /** Candidate events: declared `allowedEvents` ∩ snapshot-legal events. */
  events: AgentEventDescriptor[]; // { type, toolName, inputSchema? }
  /**
   * Prior failed attempts for THIS decision. Empty on the first attempt.
   * Adapters render these into the provider request (e.g. a trailing user
   * message: "You chose HEAL; unavailable: no potions. Choose from: …") so
   * retries converge. Core never rewrites prompts/messages — attempts are
   * data on the request, which keeps recorded requests replay-deterministic.
   */
  attempts: DecisionAttempt[];
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface ResolveDecisionOptions {
  maxRetries?: number; // default 2 (⇒ up to 3 attempts)
  signal?: AbortSignal;
  /** Mode-3 guard check. Omit ⇒ mode-3 skipped (modes 1–2 only). */
  canTake?: (event: ChosenEvent) => boolean;
}

export interface DecisionAttempt {
  event?: ChosenEvent;
  failure: 'unknown-event' | 'invalid-payload' | 'rejected-by-guard';
  reason: string;
}

export class DecisionExhaustedError extends Error {
  attempts: DecisionAttempt[];
}

export async function resolveDecision(
  request: AgentDecisionRequest,
  executor: AgentDecisionExecutor,
  options?: ResolveDecisionOptions
): Promise<ChosenEvent>;
```

`AgentRequestExecutorInfo` is populated on the live `runAgent` path only; the step path's `executeAgentRequest` never passes it. Sync returns (`TResult`, not just `PromiseLike<TResult>`) are allowed from an executor.

Mode-3 guard-legality uses **`snapshot.can(event)`** (v6's preflight predicate — "whether sending the event will cause a non-forbidden transition"; `State.d.ts:63-71`), which is cleaner than dry-run-and-compare (there is no `.changed` flag on snapshots in v6). The core takes a `canTake` probe so the caller supplies snapshot access.

Per attempt:

1. Call `executor({ ...request, attempts })`.
2. Validate the returned event: type ∈ `request.events` → else `unknown-event`; payload against that event's schema → else `invalid-payload`; **mode 3:** `options.canTake?.(event) === false` → `rejected-by-guard`. (Adapter-internal failures such as "model made no tool call" surface as `unknown-event` or an executor throw.)
3. Any failure ⇒ append a `DecisionAttempt`, decrement budget, retry.
4. Success ⇒ return `chosenEvent`. Budget exhausted ⇒ throw `DecisionExhaustedError(attempts)`.

Each executor call counts against `runAgent`'s `maxModelCalls` (a decision that retries twice = 3 model calls).

**Missing executor:** if the machine registers any `DecisionLogic`/`agent.decide` usage and no `decide` executor is available, `runAgent` fails **at bind time** with an error naming the missing slot — not mid-run (§3.2).

**Step discovery:** `getAgentRequests` detects `DecisionLogic` invokes (`kind: 'statelyai.decisionLogic'`) alongside `TextLogic` and emits `AgentDecisionRequest` entries. `AgentRequest` gains `kind: 'text'`; `AgentStep.requests` becomes `Array<AgentRequest | AgentDecisionRequest>` and hosts switch on `kind`. `executeAgentRequest` stays text-only; decisions go through `resolveDecision` + `transitionAgentStep`.

**Call sites — who supplies `canTake` (two-tier; the `self._parent` escape hatch is deleted):**

- **`runAgent` (live) — supported API, no internals.** `runAgent` creates the actor, so it provides its *own* `agent.decide` source that closes over an `actorRef` holder (assigned right after `createActor`, before any decision runs): `canTake: (e) => actorRef.getSnapshot().can(e)`. The actor sits in the deciding state while the executor runs, so `.can()` reflects that state's guards. **Full modes 1–3.**
- **Step path (durable host) — supported API.** The host has the snapshot: `canTake: (e) => snapshot.can(e)`, then `transitionAgentStep(...)`. **Full modes 1–3.** The shipped `twenty-questions` example wires this directly off the step object: `canTake: (e) => step.snapshot.can(e)`.
- **Bare `createActor` with `agent.decide` — modes 1–2 only** (type + payload validation, no guard check). Documented limitation; no untyped-internals traversal in a v1 alpha. A new constraint on this tier: an **omitted `allowedEvents` under bare `createActor` is a fail-fast error** — with no snapshot to enumerate legal events against, "all legal events" can't be resolved, so it must be declared explicitly. `runAgent` and the step path both support omitted `allowedEvents` (⇒ all legal events) fully, since both have a snapshot to intersect against.

On success the `agent.decide` actor resolves with the chosen event as output and delivers it to the invoking actor itself via `enq.sendTo(self, …)`; on `DecisionExhaustedError` it rejects (→ invoke `onError`, error carries `attempts`).

### 2.7 `getAcceptedEvents` guard note

`getAcceptedEvents` (renamed from `getAvailableEvents`, §3.1) filters by event *type* only (see `getAcceptedEvents` in `setup-agent.ts`) — it does not evaluate guards. So the mode-3 `snapshot.can()` check is load-bearing: it's the only thing catching a type-legal-but-guard-rejected choice. Keep the candidate-*type* list as-is (over-exposes); `resolveDecision` closes the gap at apply time.

### 2.8 Removals

- `agentEvents` from `TextLogicConfig` and the workflow-config request path.
- `eventTypes` from `AgentTextRequest` (folded into the decision request shape).
- `AgentRequestLogic` alias (it extended `TextLogic` adding nothing) — collapse.
- `getEventTools` and execute-carrying event tools — event exposure is decision-owned; `getAcceptedEvents` returns plain descriptors and adapters build provider tools from them.
- The `self._parent` best-effort mode-3 hack (old Q6.2) — bare `createActor` is modes 1–2, documented.

**Risk retired.** The earlier "async actor needs parent snapshot" risk is resolved by having `runAgent` (which owns the actor ref) supply `canTake` via `actor.getSnapshot().can()`. No `self._parent`/`system` traversal from inside async logic is required — bare `createActor` simply runs without the guard check (modes 1–2).

---

## 3. `runAgent` — `createActor` wrapper

### 3.1 Signature

A non-final machine can *always* accept events, so it is never "paused." The only distinction is whether it is **doing work** or **idle** (settled, nothing in flight). The result is a three-variant union; the accepted-event list is **derived** from the snapshot (via `getAcceptedEvents`), not embedded.

```ts
export interface RunAgentOptions<TMachine extends AnyStateMachine>
  extends AgentRequestExecutors {
  input?: InputFrom<TMachine>;

  // resume
  snapshot?: Snapshot<unknown>;
  event?: EventFromLogic<TMachine>;

  // implementations — sugar for machine.provide({ actorSources }) before the run
  actorSources?: Record<string, AnyActorLogic>;

  /**
   * Optional human-input handler for `agent.userInput` invokes (CLI prompt,
   * web form, Slack, …). Idle-first HITL stays the default: model human input
   * as event-waiting states and `runAgent` settles `idle`. Provide this only
   * when input should be gathered inline without settling. If the machine
   * uses `agent.userInput` and neither this nor an actor source is provided,
   * bind-time error (message recommends the idle-state pattern).
   */
  userInput?: (input: AgentUserInput) => PromiseLike<unknown>;

  // observation — all void; no callback controls the run
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (
    request: AgentRequest | AgentDecisionRequest,
    result: { output: unknown; raw: unknown }
  ) => void; // §4.4
  /** Fires on every machine transition (snapshot + causing event). Pure
   * observation — progress UIs, logging, tracing. Cannot send events. */
  onTransition?: (
    snapshot: SnapshotFrom<TMachine>,
    event: EventFromLogic<TMachine>
  ) => void;

  // control
  maxModelCalls?: number; // default 100
  signal?: AbortSignal;
}

export type RunAgentResult<TMachine extends AnyStateMachine> =
  | { status: 'done'; output: OutputFrom<TMachine>; snapshot: SnapshotFrom<TMachine> }
  | { status: 'idle'; snapshot: SnapshotFrom<TMachine> }
  | {
      status: 'error';
      cause: 'aborted' | 'max-model-calls' | 'decision-exhausted' | 'machine' | 'stopped';
      error: unknown;
      snapshot: SnapshotFrom<TMachine>;
    };

export async function runAgent<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>
): Promise<RunAgentResult<TMachine>>;

/** Renamed from getAvailableEvents. "Events this state can accept right now." */
export function getAcceptedEvents(snapshot: AnyMachineSnapshot): AgentEventDescriptor[];
```

Typing is load-bearing: `input`/`event`/`onTransition` are machine-typed (`InputFrom`/`EventFromLogic`), not `unknown`/`AnyEventObject` — the run boundary is where users touch the library, and the typesafety pitch dies there otherwise. `onChunk` carries `{ request }` because parallel states interleave streams; changing the callback arity later is breaking, so it lands now.

**No continuation callback.** There is deliberately no `onIdle`-style hook that returns an event to be sent back — idle always settles and the caller resumes explicitly (§3.4). Rationale: (a) the actor is stopped on every settle and snapshot round-trip is lossless, so an inline hook adds zero capability over the resume loop; (b) "return an event and it gets sent" is implicit control flow in a library whose identity is explicit transitions, and it creates a runaway class (a hook that always returns an event loops forever consuming no model calls); (c) policies people would put there ("idle too long → CANCEL", defaults) belong in the machine (`after`, guards); (d) callers needing reactive mid-run injection use bare `createActor` — `runAgent` is a convenience host, not a second runtime. Observation callbacks (`onTransition`, `onResult`, `onChunk`) are all void.

- **`done`** — a final state reached (`snapshot.status === 'done'`).
- **`idle`** — settled, no in-flight work; caller may `getAcceptedEvents(result.snapshot)`, send an event via resume, or persist. The canonical interactive loop:

  ```ts
  let r = await runAgent(machine, { input, executors });
  while (r.status === 'idle') {
    const event = await promptUser(getAcceptedEvents(r.snapshot));
    r = await runAgent(machine, { snapshot: r.snapshot, event, executors });
  }
  ```
- **`error`** — a `runAgent`-level failure, discriminated by `cause`: `'aborted'` (signal fired), `'max-model-calls'` (budget exceeded), `'decision-exhausted'` (machine error state whose error is/wraps an unhandled `DecisionExhaustedError`), `'machine'` (any other machine error state), or `'stopped'` (external stop). Programmer errors (bad config, missing executor/actor source) still throw — at bind time (§3.2). **(Q3.1 resolved: `error` is a variant, not a throw.)**

### 3.2 Behavior

1. **Merge implementations.** Conceptually `provided = machine.provide({ actorSources: options.actorSources })` happens first; binding then walks the machine's **effective** (post-provide) actor sources. This makes `runAgent` work identically for machines pre-provided by the caller. String-keyed sources only — an invoke whose `src` is a direct logic object cannot be rebound.
2. **Bind executors once.** For each effective `TextLogic`/`DecisionLogic` (and the `agent.*` builtins), wrap with an executor that:
   - for `TextLogic`: calls `generateText` (or `streamText`, forwarding `onChunk(chunk, { request })`),
   - for `DecisionLogic`/`agent.decide`: runs `resolveDecision(request, decide, { canTake: (e) => actor.getSnapshot().can(e) })` (§2.6 — `runAgent` owns the actor ref ⇒ full modes 1–3),
   - increments a shared model-call counter; on exceeding `maxModelCalls`, settles the run `{ status: 'error', cause: 'max-model-calls' }`,
   - invokes `onResult(request, { output, raw })` with the raw executor result (§4.4).

   **Fail fast at bind time** (throw, not an `'error'` result), naming the offending source: a `TextLogic` in `STREAM` mode with no `streamText` executor (the runtime bind-time throw — `generateText` itself can never be missing, since it's a required field on `RunAgentOptions`/`AgentRequestExecutors` and its absence is a compile-time TypeScript error), a decision with no `decide`, `agent.userInput` with neither `options.userInput` nor a provided actor source (error text recommends the idle-state HITL pattern), any other placeholder actor with no implementation, or a direct-object `src` that needs execution but can't be rebound. Detection is by logic `kind`, so machines built with raw `setup()` (no `setupAgent` registration) bind identically.
3. `actor = createActor(provided, { input, snapshot })`.
4. `actor.start()`; if `options.event`, `actor.send(event)`.
5. **Settle loop.** Subscribe; on each snapshot:
   - `status === 'done'` ⇒ `{ status:'done', output, snapshot }`.
   - `status === 'error'` ⇒ `{ status:'error', cause: <'decision-exhausted' if snapshot.error is/wraps an unhandled DecisionExhaustedError, else 'machine'>, error: snapshot.error, snapshot }`.
   - `status === 'stopped'` (external stop) ⇒ `{ status:'error', cause:'stopped', error: new Error('Actor stopped externally.'), snapshot }` — without this the settle loop hangs forever.
   - `isIdle(snapshot)` and not done ⇒ `{ status:'idle', snapshot }`. No callback consulted — idle always settles; the caller resumes (§3.4).
   - every transition ⇒ `onTransition(snapshot, event)` (observation only, exceptions in the callback are the caller's).
6. `maxModelCalls` ⇒ `{ status:'error', cause:'max-model-calls', … }`; abort ⇒ `{ status:'error', cause:'aborted', … }`.
7. **The actor is stopped on every settle path** (`done`/`idle`/`error`). Resume is always by snapshot (§3.4), never by holding a live actor.

### 3.3 Idle detection (`isIdle`) — v6-verified

Per the spike, `snapshot.status ∈ {'active','done','error','stopped'}` and `snapshot.children` is `Record<string, AnyActorRef | undefined>`; each child exposes `getSnapshot()`. There is **no** public field for pending internal (`always`/raised/`after`) events, so "no pending internal work" is only *approximable* via `getNextTransitions`:

```ts
function isIdle(snapshot: AnyMachineSnapshot): boolean {
  if (snapshot.status !== 'active') return false;
  const childrenBusy = Object.values(snapshot.children ?? {})
    .some((c) => c?.getSnapshot?.().status === 'active');   // in-flight invoked actors
  if (childrenBusy) return false;
  const hasPendingWork = getNextTransitions(snapshot).some(
    (t) => t.eventType === ''                               // eventless (`always`)
      || t.eventType.startsWith('xstate.after')             // pending `after` timer
  );
  return !hasPendingWork;
}
```

A state with an `after` delay is **working** (waiting on its own clock), not idle — settling there would strand the timer, since the actor is stopped on settle (§3.2.7). In the live path timers otherwise just run on the actor's clock; no special handling beyond this check. *(Spike S2 verified: delayed transitions surface as `xstate.after.<delay>.<stateId>` in `getNextTransitions`.)*

Debounce to a macrotask before declaring idle (children spin up across transitions), re-check on each emission. Residual imprecision (already-scheduled raised events aren't snapshot-visible) is acceptable — a stray idle just hands control back to the caller, who can resend.

### 3.4 Serverless resume recipe

```ts
let r = await runAgent(machine, { input, executors });        // → idle (awaiting approval)
await store.put(threadId, r.snapshot);                           // persist snapshot (or event log, §4.3)
// ...later, new process, human approved...
const snapshot = await store.get(threadId);
r = await runAgent(machine, { snapshot, event: { type: 'APPROVE' }, executors });
```

### 3.5 What `runAgent` is NOT

No per-model-call durable checkpoint — whole-machine snapshots at `done`/`idle`/`error` only. Per-request checkpointing and event-sourced durability are the **step-helper** path (§4).

---

## 4. Step helpers + result normalization

### 4.1 Positioning

`initialAgentStep` / `transitionAgentStep` / `resolveAgentStep` / `executeAgentRequest` / `getAgentRequests` remain **first-class**, documented as the **durable / inspectable** path (per-model-call checkpoints for Cloudflare Workflows, Temporal, Inngest, DBOS). API change: `AgentStep.requests` is now `Array<AgentRequest | AgentDecisionRequest>`, discriminated by `kind` (§2.6), plus §4.2. Not deprecated; a peer of `runAgent`, chosen by use case. `transitionAgentStep` accepts either a raw snapshot or a previous `AgentStep` as its second argument, unwrapping `.snapshot` when given the latter — callers can thread the whole step object through without manually plucking the snapshot out.

### 4.2 `normalizeGeneratorResult` simplification

Old normalizer duck-typed `toolResults` first (the legacy path where a decision event arrived inside `toolResults`) then `object`→`output`→`text`. With decisions now handled explicitly by `resolveDecision` (which extracts the chosen event from tool calls itself), the generic normalizer only unwraps **generator** output:

```ts
async function normalizeGeneratorResult(result: unknown): Promise<unknown> {
  const r = await result;
  if (!r || typeof r !== 'object') return r;
  if ('object' in r) return await (r as any).object;
  if ('text' in r) return await (r as any).text;
  if ('output' in r) return await (r as any).output;
  return r;
}
```

The fragile "first `toolResults[].output`" heuristic is **deleted**. Decision result extraction is explicit and lives in `resolveDecision`.

### 4.3 Event sourcing (the real durable story)

The step helpers are already event-driven: `transitionAgentStep` applies one event, `resolveAgentStep` applies one model-result event (`xstate.done.actor.<id>`), and a decision applies one sent event (§2.5). So durability is **event sourcing**, not (only) snapshot serialization:

> Persist the ordered event log. Replay it through the pure `transition(...)` function to reconstruct state. A snapshot is an optional *compaction checkpoint*, not the source of truth.

This is why decisions deliver via `enq.sendTo(self, …)` (external, recorded) rather than `enq.raise` (internal, invisible) — a raised event would not appear in the log and replay would diverge. Concretely, a durable host records, per step: the applied event **and** the raw executor result (§4.4) that produced it, so replay is deterministic (recorded outputs substitute for live model calls) and auditable (usage/tool-calls preserved).

Not built in P0 (no storage adapter) — but the *shape* is fixed here so the step API and the recorded-event envelope support it. Storage adapters are P3.

### 4.4 Raw executor result (Q4.1 resolved)

The raw executor result (tool calls, token usage, finish reason) is retained — required for observability *and* event-sourced replay/audit. It surfaces in three reachable places, none bloating the common return:

```ts
// step path: opt-in verbose return
export function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors
): Promise<unknown>;                                  // normalized value (unchanged default)
export function executeAgentRequest(
  request: AgentRequest,
  executors: AgentRequestExecutors,
  options: { verbose: true }
): Promise<{ output: unknown; raw: unknown }>;         // both
```

- **Step path:** `executeAgentRequest(req, exec, { verbose: true }) → { output, raw }`.
- **Live path:** `runAgent`'s `onResult(request, { output, raw })` callback (§3.1) — also the OTel/tracing seam (P3 exporters plug in here).
- **Durable path:** the recorded step envelope carries `{ event, raw }` (§4.3). A decision's `reason` (§2.6) is adapter-surfaced explanation; it rides in `raw`, not in the event.

### 4.5 Timers in the step path

`after` delays lower to executable **delayed-raise actions** in `step.actions` — the one action family a durable host **must** execute: schedule the raised event on its own engine (Workflows timer, Temporal timer, queue delay) and apply it via `transitionAgentStep` when it fires. This is the blueprint stance applied to time: the machine declares the delay; the host owns the clock. In the live path timers run on the actor's clock and `isIdle` counts a pending `after` as busy (§3.3), so `runAgent` never settles under a live timer.

*(Spike S1 verified: `transition()`/`initialTransition()` emit `{ type: '@xstate.raise', event, delay, id }` executable actions — event + delay + id, everything a host needs to schedule and de-duplicate.)*

Timers surface only in `step.actions`; `step.requests` never contains them — a durable host scanning for model/decision work can ignore `actions` entirely, and a host scheduling timers can ignore `requests` entirely.

---

## 5. Breaking-change summary (for the alpha changeset)

1. `AgentMessage` is now a discriminated union; `content` is `string | Part[]`; the open index signature is gone.
2. `messagesSchema` now **rejects at runtime** messages that previously passed (unknown roles, unknown part types). Persisted contexts holding old-shape messages have no migration path in the alpha — documented: wipe or migrate manually.
3. `agentEvents` (config) and `eventTypes` (request) removed → decisions + `allowedEvents`.
4. `runAgent` return type changes from `OutputFrom<TMachine>` to `RunAgentResult<TMachine>` (`done | idle | error`); it no longer throws on a waiting machine. There is no continuation callback (`onPause`/`onIdle` do not exist) — idle settles and the caller resumes by snapshot. `onChunk` gains `{ request }`; `onTransition` added (observation-only).
5. `runAgent` now runs *all* invokes (was: model-only) — machines with side-effecting actors that previously errored now execute. It stops its actor on every settle; resume is snapshot-only.
6. `AgentRequestExecutors` gains optional `decide`; machines using decisions require it (bind-time throw otherwise).
7. `AgentRequest` gains `kind: 'text'`; `AgentStep.requests` becomes a `kind`-discriminated union including `AgentDecisionRequest`.
8. `getAvailableEvents` renamed `getAcceptedEvents`; `getEventTools` removed (descriptors only — adapters build tools).
9. `AgentRequestLogic` alias removed.
10. `normalizeGeneratorResult` no longer inspects `toolResults`.

---

## 6. Resolved decisions & remaining questions

**Resolved this pass:**

- **Q1.1** — `ToolResultOutput`: ship the full 5-variant union now (comprehensive from the start).
- **Q3.1** — `runAgent` failures are a third `{ status:'error' }` result variant, not a throw (§3.1).
- **Q4.1** — raw result retained via verbose `executeAgentRequest`, `onResult` hook, and the recorded event envelope (§4.4).
- **Q-spike (xstate 6.0.0-alpha.16)** — resolved (§2.4–2.6, §3.3): no action-creators (`enq`-based transition fns); decision delivery = `enq.sendTo(self, …)` not `enq.raise`; mode-3 uses `snapshot.can(event)` with `canTake` supplied by `runAgent` (`actor.getSnapshot().can`) / step host (`snapshot.can`); async actors can't read parent snapshot, so bare `createActor` gets modes 1–2 only; `isIdle` = active + no busy children + no pending `always` (approximate).

**Resolved:**

- **Q6.1** — **superseded**: delivery is built into the decision actor (a `sendTo(self, …)`, not a raise). No user-facing helper — the standalone delivery export was removed.
- **Q6.2** — ~~best-effort mode-3 via `self._parent`~~ **superseded**: the internals hack is deleted. Bare `createActor` is modes 1–2, documented (§2.6). Blessed paths (`runAgent`/step) supply `canTake` from real snapshots.
- **Q6.3** — P0 fixes only the *shapes* (recorded envelope carries `{ event, raw }`, §4.3/§4.4); the first event-log storage adapter ships in P3.
- **Q6.4** — decision executor contract is `{ event, reason? }` (§2.6): coercion mechanics (forced tool choice, structured output) live in adapters; core validates + retries. Retry feedback travels as `request.attempts` data — core never rewrites prompts.
- **Q6.5** — non-model actors reach `runAgent` via the `actorSources` option (sugar for `machine.provide`); binding walks effective post-provide sources by logic `kind`, fails fast at bind time on anything unbound (§3.2).
- **Q6.6** — binary/`URL` message parts vs persistence: host concern, documented stance only (§1.2), no serializer in P0.

**Sign-offs (resolved 2026-07-02):**

- **O1** — `AgentStep.requests` is one `kind`-discriminated union (`AgentRequest | AgentDecisionRequest`). No separate `step.decisions` array.
- **O2** — missing `decide` executor is a **bind-time error only**. No core fallback synthesizing decisions from `generateText` — that would put prompt construction + output parsing (provider mechanics) back in core, exactly what §2.6 removed. If a convenience ever ships, it's an adapter helper (e.g. `createStructuredDecide(generateText)` in `/ai-sdk`), not core.
- **O3** — **idle-first HITL**, with an optional inline handler: `RunAgentOptions.userInput` (§3.1) lets the executor gather human input without settling (CLI prompt, form, Slack). Machine uses `agent.userInput` with no handler/source ⇒ bind-time error recommending the idle-state pattern.
- **O4** — **superseded: `onIdle` is deleted entirely** (2026-07-02 review). Idle always settles; the caller owns the resume loop (§3.1 "No continuation callback"). Replaced by observation-only `onTransition(snapshot, event)`. The runaway-idle hazard class this question managed no longer exists.
- **O5** — decided, pending release mechanics: single changeset covering all §5 breaks; publish under changesets prerelease mode (`changeset pre enter alpha` → `2.0.0-alpha.x`) with the `alpha` npm dist-tag. Not yet executed — `changeset pre enter alpha` has not been run (no `.changeset/pre.json`), and `package.json` still reads `2.0.0`.

**Implementation logistics (resolved):**

- Acceptance fixtures gating P0: a **twenty-questions-style decision game** (new example replacing/extending `game-agent` as the decisions showcase — richer decision loop than one combat turn), `email-drafter` (parts messages), and human-in-the-loop (idle → persist → resume) (example since consolidated into `examples/human-in-the-loop`). Tests for these three are written first, TDD-style; remaining examples migrate in P1.
- Old tests encoding old semantics (`setup-agent.test.ts`, `examples.test.ts` sections on `agentEvents`/`getEventTools`/old `runAgent`) are **deleted and rewritten** against the new surface, not migrated in place.
- Landing: **one branch, four commits**, in dependency order: (1) message types + `messagesSchema`, (2) decision primitive + step discovery, (3) `runAgent` rewrite, (4) removals/renames sweep.

**Spikes against `xstate@6.0.0-alpha.16` — all verified empirically 2026-07-02 (scripts in `.scratch/spikes/`):**

| Spike | Verdict | Result |
| --- | --- | --- |
| S1 — step-path timers | ✅ PASS | `initialTransition` emits `{ type: '@xstate.raise', event, delay, id }` executable actions — hosts have everything to schedule; feeding the after-event back transitions correctly (§4.5 holds). |
| S2 — `after` in `getNextTransitions` | ✅ PASS | Delayed transitions appear as `xstate.after.<delay>.<stateId>`; `always` as `eventType === ''` — `isIdle`'s `startsWith('xstate.after')` check is valid (§3.3 holds). |
| S3 — onDone no-target + `sendTo(self)` | ✅ PASS* | Event arrives and takes the transition; completed invoke is **not** re-run (`runCount: 1`); the send is externally observable (v6 inspection: `@xstate.transition` events with `sent: [...]`). Output is on `event.output` in the onDone transition fn. |
| S4 — double `provide` | ✅ PASS | Chained provides **merge** (`machine.implementations.actorSources` shows both overrides) — §3.2.1 holds. |
| S5 — `snapshot.can()` payload + guards | ✅ PASS | Correct for object-form guards **and** function transitions (`HEAL: ({context,event}) => cond ? {target} : undefined`) across all cases — mode-3 holds for the dominant authoring style. |
| S6 — direct-object srcs at bind time | ⚠️ PARTIAL | Detectable — but **only via `machine.config`** (raw authored src preserved). The built tree (`machine.root.states`) normalizes object srcs to synthetic string ids (`xstate.invoke.0.(machine).b`) and silently loses the distinction. |
| S7 — zod v4 → JSON Schema | ✅ PASS | Both `['~standard'].jsonSchema.input/.output` and top-level `z.toJSONSchema(schema)` work (draft 2020-12). Use `z.toJSONSchema` where a zod instance is known; the `~standard` extension for vendor-agnostic paths. |

**Implementation notes from the spikes (binding for the P0 code):**

- **Transition functions are re-evaluated** (S3 measured 8× evaluations for one logical transition; exactly one `GO` was sent — `enq` deduplicates). All effects in transition/onDone functions MUST go through `enq`; never side-effect directly in the function body. The decision actor's built-in delivery (§2.5) already complies; the purity requirement gets a doc callout and a test.
- **Bind-time invoke enumeration walks `machine.config` recursively** (S6), never `machine.root`/built StateNodes, or object srcs masquerade as registered strings and the §3.2.2 fail-fast silently misses them.
