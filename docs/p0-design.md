# @statelyai/agent — Alpha P0 Design

Status: **draft for review**. This specifies the exact type shapes and behavior for the P0 (foundational + breaking) work before any code lands. Annotate inline. Nothing here is built yet.

Scope (P0 only):

1. `AgentMessage` parts model + `messagesSchema` (breaking)
2. Decision primitive: `agent.decide` + `createDecisionLogic` + `allowedEvents` + `resolveDecision`
3. `runAgent` as a `createActor` wrapper (return union `done|idle|error`, resume, `onIdle`, `maxModelCalls`)
4. Step-helper separation + `normalizeRequestExecutionResult` simplification

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

Rewrite the validator (`setup-agent.ts`) to accept the union: `role ∈ {system,user,assistant,tool}`, and `content` either a string (where allowed) or an array of parts each with a known `type`. Reject unknown roles/part types.

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
- **Step runtime (durable hosts):** the host calls `resolveDecision(...)` → `chosenEvent`, then `transitionAgentStep(...)`.

Both call the same `resolveDecision` core.

### 2.2 `allowedEvents` (canonical name)

Hard-rename from `agentEvents` (authoring) / `eventTypes` (request). **No alias** (pre-release). Lives only on decisions.

```ts
export type AllowedEvents<TEvent extends string = string> =
  | readonly TEvent[]
  | ((args: { input: unknown }) => readonly TEvent[]);
```

Semantics: declared candidates **∩ snapshot-legal events**. Omitted ⇒ all legal events. Resolver form allowed (runtime narrowing, e.g. HP-gated moves). Because it's intersected with legal events, a resolver can only ever *narrow* the real surface.

### 2.3 `createDecisionLogic`

```ts
export interface DecisionLogicConfig<
  TInputSchema extends StandardSchemaV1 = StandardSchemaV1,
  TEvent extends string = string,
> {
  schemas?: { input: TInputSchema };
  model: Resolve<string, InferOutput<TInputSchema>>;
  system?: Resolve<string | undefined, InferOutput<TInputSchema>>;
  prompt?: Resolve<string | undefined, InferOutput<TInputSchema>>;
  messages?: Resolve<AgentMessage[] | undefined, InferOutput<TInputSchema>>;
  allowedEvents?:
    | readonly TEvent[]
    | ((args: { input: InferOutput<TInputSchema> }) => readonly TEvent[]);
  maxRetries?: number; // default 2
  temperature?: Resolve<number | undefined, InferOutput<TInputSchema>>;
  maxTokens?: Resolve<number | undefined, InferOutput<TInputSchema>>;
  // ...same model params as TextLogic
  metadata?: Resolve<Record<string, unknown> | undefined, InferOutput<TInputSchema>>;
}

export interface DecisionLogic<...> extends AsyncActorLogic<
  ChosenEvent,          // output = the raised event object
  DecisionInput
> {
  readonly kind: 'statelyai.decisionLogic';
  readonly maxRetries: number;
  request(input): AgentDecisionRequest;   // parallel to TextLogic.request
  withExecutor(execute): DecisionLogic<...>;
}

export type ChosenEvent = { type: string; [key: string]: unknown };
```

- No `output` schema (a decision has no output value; its output *is* the event).
- `toolChoice` is forced `'required'` internally — not user-configurable.
- Standalone `createDecisionLogic` types `allowedEvents` only as `string[]` (it doesn't know the machine's events). The co-located form (inside `setupAgent`, P1) will type it against event-schema keys.

### 2.4 Builtin `agent.decide` (v6-alpha-correct syntax)

Zero-config counterpart, symmetric with `agent.generateText`/`agent.streamText`. Invoked with inline input. **Side effects go through the `enq` param of a transition function — there is no `{ actions: [...] }` key and no standalone `raise()`/action-creator in v6 alpha** (verified against `xstate@6.0.0-alpha.16`: `types.v6.d.ts:416-436`, `types.d.ts:207-226`). The chosen event is delivered with **`enq.sendTo(self, output)`** — an *external, observable* send (so it lands in the event log; see §4.3), **not** `enq.raise` (internal, invisible).

```ts
choosingMove: {
  invoke: {
    src: 'agent.decide',
    input: ({ context }) => ({
      model: 'openai/gpt-4.1-mini',
      system: 'Choose exactly one legal move.',
      prompt: `Player ${context.playerHp} / Enemy ${context.enemyHp}`,
      allowedEvents: context.playerHp <= 6 ? lowHpMoves : defaultMoves, // optional
      maxRetries: 2,
    }),
    onDone: sendDecision(),           // ≡ ({ output, self }, enq) => enq.sendTo(self, output)
    onError: { target: 'fumbled' },   // retries exhausted (§2.6)
  },
  on: {
    ATTACK: ({ context }) => ({ target: 'summarizing', context: { /* … */ } }),
    DEFEND: { target: 'summarizing' },
    FLEE: { target: 'done' },
  },
}
```

`allowedEvents` omitted ⇒ every legal event of `choosingMove` is offered. On `onDone` with no `target`, the machine stays in `choosingMove` (the completed invoke is not re-run), then the sent event is processed by the state's `on:` handlers.

### 2.5 `sendDecision()` helper (a transition function, not an action)

Because v6 alpha has no action-creators, the helper is a **transition-function factory**, not an action object:

```ts
export function sendDecision(): (
  args: { output: ChosenEvent; self: AnyActorRef },
  enq: EnqueueObject
) => void;
// ≡ ({ output, self }, enq) => { enq.sendTo(self, output); }
```

Delivered via `sendTo(self, …)` (external event) rather than `enq.raise(…)` (internal) specifically so the decision is recorded in the observable event stream — this is what makes event sourcing (§4.3) work. The P3 `decide:` state-block sugar lowers to exactly this invoke + `sendDecision()` + `onError`.

### 2.6 `resolveDecision` — validation + retry core

Mode-3 guard-legality uses **`snapshot.can(event)`** (v6's preflight predicate — "whether sending the event will cause a non-forbidden transition"; `State.d.ts:63-71`), which is cleaner than dry-run-and-compare (there is no `.changed` flag on snapshots in v6). The core takes a `canTake` probe so the caller supplies snapshot access:

```ts
export interface ResolveDecisionOptions {
  maxRetries?: number; // default 2 (⇒ up to 3 attempts)
  signal?: AbortSignal;
  /** Mode-3 guard check. Omit ⇒ mode-3 skipped (modes 1–2 only). */
  canTake?: (event: ChosenEvent) => boolean;
}

export interface DecisionAttempt {
  event?: ChosenEvent;
  failure: 'no-tool-call' | 'unknown-tool' | 'invalid-payload' | 'rejected-by-guard';
  reason: string;
}

export class DecisionExhaustedError extends Error {
  attempts: DecisionAttempt[];
}

export async function resolveDecision(
  request: AgentDecisionRequest,
  executor: AgentRequestExecutor,
  options?: ResolveDecisionOptions
): Promise<ChosenEvent>;
```

Per attempt:

1. Build the request: event tools from `allowedEvents ∩ getAcceptedEvents(snapshot)`, `toolChoice: 'required'`.
2. Run executor; extract the tool call → no call = `no-tool-call`; unknown name = `unknown-tool`.
3. Validate tool input against that event's schema → fail = `invalid-payload`.
4. **Mode 3:** `options.canTake?.(candidateEvent) === false` ⇒ `rejected-by-guard`.
5. Any failure ⇒ append a model-legible feedback message ("You chose `HEAL`, unavailable now: no potions. Choose again."), decrement budget, retry.
6. Success ⇒ return `chosenEvent`. Budget exhausted ⇒ throw `DecisionExhaustedError(attempts)`.

**Call sites — who supplies `canTake` (three-tier, resolving the old §2.8 risk):**

- **`runAgent` (live) — supported API, no internals.** `runAgent` creates the actor, so it provides its *own* `agent.decide` source that closes over an `actorRef` holder (assigned right after `createActor`, before any decision runs): `canTake: (e) => actorRef.getSnapshot().can(e)`. The actor sits in the deciding state while the executor runs, so `.can()` reflects that state's guards. **Full modes 1–3.**
- **Step path (durable host) — supported API.** The host has the snapshot: `canTake: (e) => snapshot.can(e)`, then `transitionAgentStep(...)`. **Full modes 1–3.**
- **Bare `createActor` with `agent.decide` (escape hatch) — best-effort via internals.** The async actor's `run` args are `{ input, system, self, signal }` (no typed `parent`), but `self._parent` exists (untyped, `@internal`; `types.d.ts:736`). The builtin reads it best-effort:
  ```ts
  const parent = (self as any)?._parent;
  const canTake = typeof parent?.getSnapshot === 'function'
    ? (e: ChosenEvent) => { try { return parent.getSnapshot().can(e); } catch { return true; } }
    : undefined; // → modes 1–2 only
  ```
  Guarded so a future xstate rename degrades to modes 1–2 rather than throwing. **Mode-3 when `_parent` resolves, else modes 1–2.** (Q6.2.)

On success the `agent.decide` actor completes with `output = chosenEvent` (→ `sendDecision()` sends it via `enq.sendTo(self, …)`); on `DecisionExhaustedError` it rejects (→ invoke `onError`, payload carries `attempts`).

### 2.7 `getAcceptedEvents` guard note

`getAcceptedEvents` (renamed from `getAvailableEvents`, §3.1) filters by event *type* only ([setup-agent.ts:768]) — it does not evaluate guards. So the mode-3 `snapshot.can()` check is load-bearing: it's the only thing catching a type-legal-but-guard-rejected choice. Keep the candidate-*type* list as-is (over-exposes); `resolveDecision` closes the gap at apply time.

### 2.8 Removals

- `agentEvents` from `TextLogicConfig` and the workflow-config request path.
- `eventTypes` from `AgentTextRequest` (folded into the decision request shape).
- `AgentRequestLogic` alias (it extended `TextLogic` adding nothing) — collapse.

**Risk retired.** The earlier "async actor needs parent snapshot" risk is resolved by having `runAgent` (which owns the actor ref) supply `canTake` via `actor.getSnapshot().can()`. No `self._parent`/`system` traversal from inside async logic is required. Only the bare-`createActor` escape hatch loses mode-3, which is acceptable.

---

## 3. `runAgent` — `createActor` wrapper

### 3.1 Signature

A non-final machine can *always* accept events, so it is never "paused." The only distinction is whether it is **doing work** or **idle** (settled, nothing in flight). The result is a three-variant union; the accepted-event list is **derived** from the snapshot (via `getAcceptedEvents`), not embedded.

```ts
export interface RunAgentOptions {
  input?: unknown;

  // resume
  snapshot?: Snapshot<unknown>;
  event?: AnyEventObject;

  // execution
  generateText: AgentRequestExecutor;
  streamText?: AgentRequestExecutor;
  onChunk?: (chunk: string) => void;
  onResult?: (request: AgentRequest, result: { output: unknown; raw: unknown }) => void; // §4.4

  // control
  onIdle?: (
    result: { snapshot: AnyMachineSnapshot }
  ) => Promise<AnyEventObject | undefined> | AnyEventObject | undefined;
  maxModelCalls?: number; // default 100
  signal?: AbortSignal;
}

export type RunAgentResult<TMachine extends AnyStateMachine> =
  | { status: 'done'; output: OutputFrom<TMachine>; snapshot: SnapshotFrom<TMachine> }
  | { status: 'idle'; snapshot: SnapshotFrom<TMachine> }
  | { status: 'error'; error: unknown; snapshot: SnapshotFrom<TMachine> };

export async function runAgent<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions
): Promise<RunAgentResult<TMachine>>;

/** Renamed from getAvailableEvents. "Events this state can accept right now." */
export function getAcceptedEvents(snapshot: AnyMachineSnapshot): AgentEventDescriptor[];
```

- **`done`** — a final state reached (`snapshot.status === 'done'`).
- **`idle`** — settled, no in-flight work; caller may `getAcceptedEvents(result.snapshot)`, send an event, or persist.
- **`error`** — a `runAgent`-level failure: `maxModelCalls` exceeded, decision exhausted surfacing as a machine error, or aborted `signal`. Programmer errors (bad config, missing executor) still throw. **(Q3.1 resolved: `error` is a variant, not a throw.)**

### 3.2 Behavior

1. **Bind executors once.** Walk the machine's registered actor sources; for each `TextLogic`/`DecisionLogic` (and the `agent.*` builtins), wrap with an executor that:
   - calls `generateText` (or `streamText`, forwarding `onChunk`),
   - increments a shared model-call counter; on exceeding `maxModelCalls`, settles the run `error`,
   - for `agent.decide`, runs `resolveDecision(request, executor, { canTake: (e) => actor.getSnapshot().can(e) })` (§2.6 — `runAgent` owns the actor ref ⇒ full modes 1–3),
   - invokes `onResult(request, { output, raw })` with the raw executor result (§4.4).
2. `provided = machine.provide({ actorSources: bound })`.
3. `actor = createActor(provided, { input, snapshot })`.
4. `actor.start()`; if `options.event`, `actor.send(event)`.
5. **Settle loop.** Subscribe; on each snapshot:
   - `status === 'done'` ⇒ `{ status:'done', output, snapshot }`.
   - `status === 'error'` ⇒ `{ status:'error', error: snapshot.error, snapshot }`.
   - `isIdle(snapshot)` and not done ⇒ if `onIdle`, `await onIdle({ snapshot })`; a returned event ⇒ `actor.send(event)` and continue; `undefined` ⇒ `{ status:'idle', snapshot }`. No `onIdle` ⇒ `{ status:'idle', snapshot }`.
6. `maxModelCalls`/abort ⇒ settle `{ status:'error', … }` with snapshot.

### 3.3 Idle detection (`isIdle`) — v6-verified

Per the spike, `snapshot.status ∈ {'active','done','error','stopped'}` and `snapshot.children` is `Record<string, AnyActorRef | undefined>`; each child exposes `getSnapshot()`. There is **no** public field for pending internal (`always`/raised/`after`) events, so "no pending internal work" is only *approximable* via `getNextTransitions`:

```ts
function isIdle(snapshot: AnyMachineSnapshot): boolean {
  if (snapshot.status !== 'active') return false;
  const childrenBusy = Object.values(snapshot.children ?? {})
    .some((c) => c?.getSnapshot?.().status === 'active');   // in-flight invoked actors
  if (childrenBusy) return false;
  const hasAlways = getNextTransitions(snapshot).some((t) => t.eventType === '');
  return !hasAlways;                                        // approximate "no eventless work"
}
```

Debounce to a macrotask before declaring idle (children spin up across transitions), re-check on each emission. Residual imprecision (already-scheduled `after`/raised events aren't snapshot-visible) is acceptable — a stray idle just hands control back to the caller, who can resend.

### 3.4 Serverless resume recipe

```ts
let r = await runAgent(machine, { input, ...executors });        // → idle (awaiting approval)
await store.put(threadId, r.snapshot);                           // persist snapshot (or event log, §4.3)
// ...later, new process, human approved...
const snapshot = await store.get(threadId);
r = await runAgent(machine, { snapshot, event: { type: 'APPROVE' }, ...executors });
```

### 3.5 What `runAgent` is NOT

No per-model-call durable checkpoint — whole-machine snapshots at `done`/`idle`/`error` only. Per-request checkpointing and event-sourced durability are the **step-helper** path (§4).

---

## 4. Step helpers + result normalization

### 4.1 Positioning

`initialAgentStep` / `transitionAgentStep` / `resolveAgentStep` / `executeAgentRequest` / `getAgentRequests` remain **first-class**, documented as the **durable / inspectable** path (per-model-call checkpoints for Cloudflare Workflows, Temporal, Inngest, DBOS). No API change beyond §4.2. Not deprecated; a peer of `runAgent`, chosen by use case.

### 4.2 `normalizeRequestExecutionResult` simplification

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
- **Durable path:** the recorded step envelope carries `{ event, raw }` (§4.3).

---

## 5. Breaking-change summary (for the alpha changeset)

1. `AgentMessage` is now a discriminated union; `content` is `string | Part[]`; the open index signature is gone.
2. `agentEvents` (config) and `eventTypes` (request) removed → decisions + `allowedEvents`.
3. `runAgent` return type changes from `OutputFrom<TMachine>` to `RunAgentResult<TMachine>` (`done | idle | error`); it no longer throws on a waiting machine, and `onPause`→`onIdle`.
4. `runAgent` now runs *all* invokes (was: model-only) — machines with side-effecting actors that previously errored now execute.
5. `getAvailableEvents` renamed `getAcceptedEvents`.
6. `AgentRequestLogic` alias removed.
7. `normalizeRequestExecutionResult` no longer inspects `toolResults`.

---

## 6. Resolved decisions & remaining questions

**Resolved this pass:**

- **Q1.1** — `ToolResultOutput`: ship the full 5-variant union now (comprehensive from the start).
- **Q3.1** — `runAgent` failures are a third `{ status:'error' }` result variant, not a throw (§3.1).
- **Q4.1** — raw result retained via verbose `executeAgentRequest`, `onResult` hook, and the recorded event envelope (§4.4).
- **Q-spike (xstate 6.0.0-alpha.16)** — resolved (§2.4–2.6, §3.3): no action-creators (`enq`-based transition fns); decision delivery = `enq.sendTo(self, …)` not `enq.raise`; mode-3 uses `snapshot.can(event)` with `canTake` supplied by `runAgent` (`actor.getSnapshot().can`) / step host (`snapshot.can`); async actors can't read parent snapshot, so bare `createActor` gets modes 1–2 only; `isIdle` = active + no busy children + no pending `always` (approximate).

**Resolved:**

- **Q6.1** — helper name is **`sendDecision()`** (it's a `sendTo(self, …)`, not a raise).
- **Q6.2** — bare `createActor` uses **best-effort mode-3 via the untyped `self._parent`** (guarded; degrades to modes 1–2), not a hard limitation. Blessed paths (`runAgent`/step) stay off internals (§2.6).
- **Q6.3** — P0 fixes only the *shapes* (recorded envelope carries `{ event, raw }`, §4.3/§4.4); the first event-log storage adapter ships in P3.

**P0 design is locked.** No open questions.
