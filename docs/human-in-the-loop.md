---
title: Human in the loop
description: Pause an agent for human input by settling idle, persist the snapshot anywhere, and resume in a different process.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## The idle-first model

<!-- idle settle and snapshot resume behavior from src/run-agent.ts -->

A state waiting on a human is just a state with no invoke and an `on:` handler for the human's event. No `interrupt()` to learn.

- When nothing is in flight, `runAgent` settles **`{ status: 'idle', snapshot }`** instead of hanging.
- Persist the snapshot, present the human their choices, resume by handing the snapshot back with the chosen event.
- The machine decides which events are legal; the host delivers them.

The machine itself is unchanged between the run that settled and the run that resumes.

> **Note:** Idle is a whole-machine condition. If one region of a parallel machine waits for a human while a sibling still has work running, the run finishes that work first. Waits modeled with `agent.userInput` are exempt (pending placeholders that never block the settle). See [Parallel machines and pending user input](#parallel-machines-and-pending-user-input).

### Custom wait signals

<!-- setupAgent({ isSuspended }) and RunAgentOptions.isSuspended from src/run-agent.ts, src/setup-agent.ts -->

By default `runAgent` detects a resting state with a timing heuristic. To settle intentional waits deterministically, tell the machine what "suspended" means. There is no built-in tag; you choose the signal (a tag, a `snapshot.matches(...)`, or a `meta` field). Declare it once with `setupAgent({ isSuspended })` and the predicate travels with the machine, including through `machine.provide(...)`:

```ts no-check
const agentSetup = setupAgent({
  // ...schemas...
  isSuspended: (snapshot) => snapshot.hasTag('awaiting-review'),
});

// ...then mark the waiting states with the tag you chose:
reviewing: {
  tags: ['awaiting-review'],
  on: { APPROVE: { target: 'published' } },
},
```

A host can override per run by passing `isSuspended` to `runAgent` directly. Resolution order: `runAgent` option → machine-carried predicate → timing heuristic.

> The `isSuspended` option name is provisional and may change before 2.0.

## A waiting state

The `reviewing` state has no invoke. Once reached, nothing happens until a human sends `APPROVE` or `REJECT`:

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({ topic: z.string(), draft: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ published: z.boolean(), draft: z.string() }),
  events: {
    APPROVE: {},
    REJECT: z.object({ reason: z.string() }),
  },
  requests: {
    writeDraft: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => input.topic,
    },
  },
});

const machine = agentSetup.createMachine({
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output } }),
      },
    },
    reviewing: {
      on: {
        APPROVE: { target: "published" },
        REJECT: ({ context, event }) => ({
          target: "drafting",
          context: { topic: `${context.topic}\nRevision: ${event.reason}` },
        }),
      },
    },
    published: {
      type: "final",
      output: ({ context }) => ({ published: true, draft: context.draft ?? "" }),
    },
  },
});
```

## Idle settle and resume

The first `runAgent` runs the draft, reaches `reviewing`, settles `idle`. Persist the snapshot, wait for the human, resume with `{ snapshot, event }`:

```ts
import { persistSnapshot } from "@statelyai/agent";

const first = await runAgent(machine, {
  input: { topic: "release notes" },
  executors,
});
// first.status === 'idle'
const persisted = persistSnapshot(first.snapshot);

// ...later, possibly a different process, the human approved...
const second = await runAgent(machine, {
  snapshot: persisted,
  event: { type: "APPROVE" },
  executors,
});
// second.status === 'done'
```

`persistSnapshot(snapshot)` handles the round-trip: it deep-clones to plain JSON via `JSON.stringify`/`JSON.parse`, returning the exact shape you store and feed back to `runAgent({ snapshot })`. It drops or throws on non-JSON values exactly as `JSON.stringify` would, so the persisted value matches what a real persistence layer sees.

> **`persistedSnapshot` vs `snapshot`.** An idle result always carries `snapshot`, the live settled snapshot. It also carries `persistedSnapshot` when the settle left pending `agent.userInput` invokes, because the live `snapshot` cannot round-trip active children: persisting it in that case silently drops those invokes, and the loss only surfaces on resume. Persist `result.persistedSnapshot ?? result.snapshot` and both cases are covered.

## The human's choices

<!-- getAcceptedEvents from src/events.ts -->

The `getAcceptedEvents(snapshot)` helper returns one descriptor per **currently-legal** event: its `type`, a synthetic `toolName`, and its payload schema when registered. Drive the loop off it:

```ts
import { getAcceptedEvents, runAgent } from "@statelyai/agent";

let result = await runAgent(machine, { input, executors });

while (result.status === "idle") {
  const choices = getAcceptedEvents(result.snapshot);
  const event = await promptUser(choices);
  result = await runAgent(machine, {
    snapshot: result.snapshot,
    event,
    executors,
  });
}
```

A generic host that builds the event dynamically (form input, a webhook payload, an interaction protocol) can't type it against a specific machine. `parseAgentEvent(snapshot, event)` validates the `{ type, ...payload }` at runtime against accepted event types and registered payload schemas, returning it typed as the machine's event union or throwing a descriptive error. It replaces `event as never` casts in meta-driven hosts:

```ts
import { parseAgentEvent } from "@statelyai/agent";

const event = parseAgentEvent(result.snapshot, { type: chosenType, ...formPayload });
result = await runAgent(machine, { snapshot: result.snapshot, event, executors });
```

Legality comes from the machine, not a system prompt: `getAcceptedEvents` reports only events the snapshot can take, so a UI built from these choices cannot drive an illegal transition.

## Persist and resume across processes

Persist the snapshot anywhere: a database row, a queue message, `localStorage`, a file. `runAgent` stops its actor on every settle path (`done`, `idle`, `error`), so resume is **always by snapshot**, never by holding a live actor. A crash, a redeploy, or a days-long wait all resume identically. (To persist after every model call, not only at settle, see [Steps](steps.md).)

The recurring shape: **run to idle → serialize the snapshot to a handle → store it → later, load and resume with an event**. The handle is just the JSON-serialized snapshot; nothing else travels with it, because the snapshot is the whole process state.

- [file-snapshot-store](../examples/file-snapshot-store/index.ts): a `node:fs` store keyed by session id, resumed across several fresh `runAgent` calls (SQLite variant sketched inline).
- [machine-as-tool](../examples/machine-as-tool/index.ts): the same handle passed through a host harness's tool call. `startTool` runs to idle and returns the handle; `resumeTool` revives it and delivers the event.

The `AgentSnapshotStore` type (`load(id): Promise<Snapshot | undefined>`, `save(id, snapshot): Promise<void>`) is exported so stores interoperate. **Type-only**: the library ships no implementation; a store (file, SQLite, KV row) is userland.

To _render_ the choices from a stored handle, rehydrate it and read them:

```ts
import { createActor } from "xstate";
import { getAcceptedEvents } from "@statelyai/agent";

const snapshot = createActor(machine, { snapshot: JSON.parse(handle) }).getSnapshot();
const choices = getAcceptedEvents(snapshot); // one descriptor per legal event
```

**Resume cannot re-run earlier work.** A resumed snapshot starts _at_ the waiting state, so earlier states never re-enter: side effects and model calls that ran before the pause run exactly once, however many times you resume. Nothing to isolate. (Contrast inline-interrupt designs, where code before the interrupt call re-executes on resume unless manually isolated in its own node.) Re-running work is always an explicit, authored transition, such as a `REJECT` targeting the drafting state again. Pinned by a test in `src/run-agent.test.ts` ("pre-idle side effects and model calls run exactly once").

> **Context must be JSON-serializable.** Persisted snapshots round-trip through `JSON.stringify`/`JSON.parse`, so anything in `context` that is not plain JSON silently corrupts on resume: `Date` becomes a string, `Map`/`Set` become `{}`, class instances lose their prototype. Keep non-serializable handles (sessions, db clients, sockets) in closures and store only their serializable ids in `context`; see [threading host context](hosts.md#threading-host-context-into-actors-and-requests).

### Illegal resume events

<!-- AgentIllegalResumeEventError and onIllegalResumeEvent from src/run-agent.ts -->

Resuming with an event the restored state cannot take is a programmer error, so `runAgent` throws `AgentIllegalResumeEventError` (carrying `eventType` and `acceptedTypes`) before delivering it: a thrown error, not an `error`-status settle. No need to pre-check legality:

```ts
import { AgentIllegalResumeEventError, runAgent } from "@statelyai/agent";

try {
  await runAgent(machine, { snapshot, event: { type: "NOPE" }, executors });
} catch (error) {
  if (error instanceof AgentIllegalResumeEventError) {
    // error.acceptedTypes lists what the restored state does accept
  }
}
```

A type-legal event a **guard** rejects is not an illegal resume event: no transition, and the run settles per normal semantics. To restore the older silent-drop behavior, pass `onIllegalResumeEvent: 'ignore'`.

### Resuming across machine versions

<!-- agentMeta stamping, onVersionMismatch, migrateSnapshot from src/run-agent.ts -->

Every settled snapshot carries a plain `agentMeta: { machineId, version }` field that survives the JSON round-trip, so a snapshot persisted for days remembers which machine shape produced it. `version` defaults to `getMachineStructuralHash(machine)`: a dependency-free hash over the machine's structure (state ids/nesting, transition event types and targets, invoke srcs, `initial`), ignoring prompts, guards, and other functions.

On resume, `runAgent` compares the incoming stamp against the current machine's version. If they differ (a state or transition added, removed, or retargeted since the snapshot was saved):

- `onVersionMismatch: 'throw'` (default) throws `AgentSnapshotVersionMismatchError` with `from`/`to`.
- `'warn'` logs once and proceeds; `'ignore'` proceeds silently.
- `migrateSnapshot(snapshot, { from, to })` (when provided) runs instead; its return value is the snapshot resumed from, so you can adapt an old snapshot to the new shape.

An unstamped snapshot (no `agentMeta`) is always accepted. Pass an explicit `machineVersion` (semver or build id) to control migration boundaries yourself rather than tracking the structural hash.

```ts
try {
  await runAgent(machine, { snapshot, event, executors });
} catch (error) {
  if (error instanceof AgentSnapshotVersionMismatchError) {
    // error.from / error.to: the machine changed since this snapshot was saved
  }
}
```

> **Branch on `error.code`.** Both errors extend `AgentError`, which carries a `.code` string (`'illegal-resume-event'`, `'snapshot-version-mismatch'`). Where `instanceof` is unreliable (errors crossing a bundle or process boundary), check the code instead.

### Reading interaction meta

Schema-typed state `meta` gives the host a typed interaction label or view hints. Legal choices still come from `getAcceptedEvents`. Meta is keyed by state id, so pull it off an idle snapshot with `getStateMeta`:

```ts
import { getStateMeta } from "@statelyai/agent";

const interaction = getStateMeta(snapshot).interaction ?? null;
```

`getStateMeta` merges the active state(s)' meta into one object typed from the machine's meta schema (later/deeper wins for nested or parallel machines, `{}` when none declare meta). It replaces the older `Object.values(snapshot.getMeta())[0]` cast. See `readInteraction` in [machine-as-tool](../examples/machine-as-tool/index.ts).

## Inline input without settling

<!-- agent.userInput builtin and RunAgentOptions.userInput from src/run-agent.ts -->

To gather input mid-run without settling idle (a CLI prompt between two model calls), invoke the builtin `agent.userInput` actor and supply a `userInput` handler to `runAgent`:

```ts no-check
// in the machine:
reviewing: {
  invoke: {
    src: 'agent.userInput',
    input: ({ context }) => ({ prompt: `How is this draft? ${context.draft ?? ''}` }),
    onDone: ({ output }) => ({ target: 'revising', context: { feedback: output } }),
  },
}

// at the host:
await runAgent(machine, {
  input,
  executors,
  userInput: async ({ prompt }) => ask(prompt ?? ""),
});
```

The handler resolves to a `string` (what the human typed), so `onDone`'s `output` needs no cast. For structured input, gather the string(s) and parse in a follow-up state (see [twenty-questions](../examples/twenty-questions/index.ts)), or register a custom actor source in place of `agent.userInput`.

Without a handler, `agent.userInput` becomes a **pending placeholder** instead of an error (next section).

### Implementing agent.userInput

Two ways to implement the builtin:

- **`RunAgentOptions.userInput`**, the inline path shown above.
- **A provided actor source**, for the [step path](steps.md) or when the inline path doesn't fit:

```ts
import { createAsyncLogic } from "xstate";

const boundMachine = machine.provide({
  actors: {
    "agent.userInput": createAsyncLogic({
      run: async ({ input }) => showFormAndWaitForSubmit(input),
    }),
  },
});
```

If a machine invokes `agent.userInput` and neither is supplied, `runAgent` fails at bind time, before any model call, naming the actor and recommending the idle-state pattern instead.

Static [machine config](machines-as-data.md) uses the same actor source:

```yaml
invoke:
  src: agent.userInput
  input:
    prompt: "Who should receive this email?"
    schema:
      type: object
      properties:
        recipient: { type: string }
      required: [recipient]
  onDone:
    assign:
      recipient: "{{ event.output.recipient }}"
```

## Parallel machines and pending user input

<!-- pending agent.userInput placeholder and pendingUserInputs/persistedSnapshot from src/run-agent.ts -->

Whole-machine idle is not enough for parallel machines: one region may wait for a human while a sibling still has work in flight. An unhandled `agent.userInput` invoke covers this. It waits indefinitely without blocking idle detection, so the run finishes the sibling work, then settles idle with two extra fields:

- **`pendingUserInputs`**: one `{ id, input }` entry per pending `agent.userInput` invoke, carrying the invoke's resolved input (prompt, metadata) for the host to render.
- **`persistedSnapshot`**: the JSON-serializable snapshot that includes those in-flight invokes. Persist this one, not `snapshot` (see the callout above).

Resume with it plus a `userInput` handler; the restored invoke re-runs against the handler and the machine proceeds:

```ts
const first = await runAgent(machine, { input, executors });

if (first.status === "idle" && first.pendingUserInputs) {
  await store.save(JSON.stringify(first.persistedSnapshot));
  // ...later, possibly a different process...
  await runAgent(machine, {
    snapshot: JSON.parse(await store.load()),
    executors,
    userInput: async ({ prompt }) => ask(prompt ?? ""),
  });
}
```

Resuming without a handler settles idle again with the same pending inputs, so a host can safely re-enter the loop.

## Choosing a waiting style

- **Idle state** (`on:` handler, no invoke, flagged by your own `isSuspended` signal): the wait is an **event choice**; resume delivers the chosen event. Best for approve/reject flows where `getAcceptedEvents` drives a UI.
- **`agent.userInput`**: the wait is a **value request** with a prompt and schema; resume supplies the value. Best for free-form input, and the only style that lets sibling parallel regions keep working while a human is pending.

## Related

- [Steps](steps.md): durable hosts that persist after every model call.
- [The event log](event-log.md): replaying a run from its recorded external inputs.
- [Agent machines](machines.md): authoring the states and transitions a waiting state is part of.
