---
title: Human in the loop
description: Pause an agent for human input by settling idle, persist the snapshot anywhere, and resume in a different process.
---

## The idle-first model

<!-- idle settle and snapshot resume behavior from src/run-agent.ts -->

A state waiting on a human is just a state with no invoke and an `on:` handler for the human's event. There is no `interrupt()` call to learn. When `runAgent` reaches a point where nothing is in flight, it settles **`{ status: 'idle', snapshot }`** instead of hanging. You persist the snapshot, present the human with their choices, and resume by handing the snapshot back with the chosen event.

The machine decides which events are legal in the waiting state; the host delivers the human's event. Nothing about the machine changes between the run that settled and the run that resumes.

> **Note:** Idle is a whole-machine condition: `runAgent` settles only when nothing else is in flight. In a parallel machine where one region waits for a human while a sibling still has work running, the run finishes that work first. Waits modeled with `agent.userInput` are exempt: they are pending placeholders that never block the settle. See [Parallel machines and pending user input](#parallel-machines-and-pending-user-input).

### Declare your own wait signal

<!-- setupAgent({ isSuspended }) and RunAgentOptions.isSuspended from src/run-agent.ts, src/setup-agent.ts -->

By default `runAgent` detects a resting state with a timing heuristic. To settle intentional waits deterministically instead, tell the machine what "suspended" means for it. There is no built-in tag — you choose the signal. Declare it once with `setupAgent({ isSuspended })`; the predicate travels with the machine (including through `machine.provide(...)`):

```ts
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

Tags are serializable and show up in the Stately visualizer, but the signal is yours to pick — a tag, a state match, or a `meta` field. A meta-driven flavor reuses annotations you may already have:

```ts
import { getStateMeta } from "@statelyai/agent";

const agentSetup = setupAgent({
  // ...schemas...
  isSuspended: (snapshot) => getStateMeta(snapshot).interaction !== undefined,
});
```

A host can override the machine's predicate per run by passing `isSuspended` to `runAgent` directly. Resolution order is: the `runAgent` option (host override) → the machine-carried predicate → the timing heuristic (when neither is present). A machine with no predicate falls back to the heuristic and behaves exactly as before. Any suspended wait still respects whole-machine idle — a sibling region's in-flight work runs to completion first.

```ts
await runAgent(machine, {
  input,
  executors: { generateText },
  isSuspended: (snapshot) => snapshot.matches("reviewing"),
});
```

> The `isSuspended` option name is provisional and may change before 2.0.

## A waiting state

In this drafting workflow, `reviewing` has no invoke. Once reached, nothing happens until a human sends `APPROVE` or `REJECT`:

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({ topic: z.string(), draft: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ published: z.boolean(), draft: z.string() }),
  events: {
    APPROVE: z.object({}),
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

## Settle idle, then resume

The first `runAgent` runs the draft, reaches `reviewing`, and settles `idle`. Persist the snapshot, wait for the human, resume with `{ snapshot, event }`:

```ts
const first = await runAgent(machine, {
  input: { topic: "release notes" },
  executors: { generateText },
});

console.log(first.status);
// logs 'idle'

const persisted = JSON.parse(JSON.stringify(first.snapshot));

// ...later, possibly a different process, the human approved...
const second = await runAgent(machine, {
  snapshot: persisted,
  event: { type: "APPROVE" },
  executors: { generateText },
});

console.log(second.status);
// logs 'done'
```

The snapshot is a plain, JSON-serializable object; the `JSON.stringify`/`JSON.parse` round-trip above proves it survives a real persistence layer.

## Present the human's choices

<!-- getAcceptedEvents from src/events.ts -->

`getAcceptedEvents(snapshot)` returns one descriptor per **currently-legal** event: its `type`, a synthetic `toolName`, and its payload schema when registered. Drive the loop off it:

```ts
import { getAcceptedEvents, runAgent } from "@statelyai/agent";

let result = await runAgent(machine, { input, executors: { generateText } });

while (result.status === "idle") {
  const choices = getAcceptedEvents(result.snapshot);
  const event = await promptUser(choices);
  result = await runAgent(machine, {
    snapshot: result.snapshot,
    event,
    executors: { generateText },
  });
}

if (result.status === "done") {
  console.log(result.output);
}
```

A generic host that builds the human's event dynamically (from form input, a webhook payload, an interaction protocol) can't type it against a specific machine. `parseAgentEvent(snapshot, event)` validates the `{ type, ...payload }` at runtime — accepted event types and registered payload schemas — and returns it typed as the machine's event union, throwing a descriptive error otherwise. This replaces `event as never` casts in meta-driven hosts:

```ts
import { parseAgentEvent } from "@statelyai/agent";

const event = parseAgentEvent(result.snapshot, { type: chosenType, ...formPayload });
result = await runAgent(machine, { snapshot: result.snapshot, event, executors });
```

Legality comes from the machine, not a system prompt: `getAcceptedEvents` reports only events the snapshot can actually take, so a UI built from these choices cannot drive the machine into an illegal transition.

## Persist and resume across processes

Between iterations, persist `result.snapshot` anywhere: a database row, a queue message, `localStorage`, a file. `runAgent` stops its actor on every settle path (`done`, `idle`, `error`), so resume is **always by snapshot**, never by holding a live actor. That is what makes the pause durable: a crash, a redeploy, or a days-long wait all resume identically.

For a checkpoint after every model call, not only at settle, see [Steps](steps.md).

**Resume cannot re-run earlier work.** A resumed snapshot starts _at_ the waiting state, so the states before it never re-enter: side effects and model calls that ran before the pause run exactly once, no matter how many times you resume. There is nothing to isolate and no discipline to remember. (Contrast with inline-interrupt designs, where code before the interrupt call re-executes on resume unless the author manually isolates it in its own node.) Re-running work is always an explicit, authored transition, such as a `REJECT` that targets the drafting state again. This guarantee is pinned by a test in `src/run-agent.test.ts` ("pre-idle side effects and model calls run exactly once").

> **Context must be JSON-serializable.** Persisted snapshots round-trip through `JSON.stringify`/`JSON.parse`, so anything in `context` that is not plain JSON silently corrupts on resume: `Date` becomes a string, `Map`/`Set` become `{}`, and class instances lose their prototype. Keep non-serializable handles (sessions, db clients, sockets) in closures and store only their serializable ids in `context`; see [host actors](host-actors.md#threading-host-context-into-actors-and-requests).

## Idle handles and resuming from storage

The persist-and-resume loop has one recurring shape: **run to idle → serialize the snapshot to a handle → store the handle → later, load it and resume with an event**. The handle is just the JSON-serialized snapshot; nothing else needs to travel with it, because the snapshot is the whole process state.

- [file-snapshot-store](../examples/file-snapshot-store/index.ts): a `node:fs` store keyed by session id, resumed across several fresh `runAgent` calls (with a SQLite variant sketched inline).
- [machine-as-tool](../examples/machine-as-tool/index.ts): the same handle passed through a host harness's tool call. `startTool` runs to idle and returns the handle; `resumeTool` revives it and delivers the event.

The `AgentSnapshotStore` type — `load(id): Promise<Snapshot | undefined>` and `save(id, snapshot): Promise<void>` — is exported so different stores share one shape and interoperate. It is **type-only**: the library ships no implementation; a store (file, SQLite, KV row) is userland. The file-snapshot-store example annotates its store with it.

### Illegal resume events throw

<!-- IllegalResumeEventError and onIllegalResumeEvent from src/run-agent.ts -->

Resuming with an event the restored state cannot take is a programmer error, so `runAgent` throws `IllegalResumeEventError` (carrying `eventType` and `acceptedTypes`) before delivering it — the same class as its bind-time throws, not an `error`-status settle. You do not need to pre-check legality yourself:

```ts
import { IllegalResumeEventError, runAgent } from "@statelyai/agent";

try {
  await runAgent(machine, { snapshot, event: { type: "NOPE" }, executors: { generateText } });
} catch (error) {
  if (error instanceof IllegalResumeEventError) {
    // error.acceptedTypes lists what the restored state does accept
  }
}
```

A type-legal event a **guard** rejects is not an illegal resume event: the machine simply takes no transition and the run settles per normal semantics. To restore the older silent-drop behavior, pass `onIllegalResumeEvent: 'ignore'`.

### Resuming across machine versions

<!-- agentMeta stamping, onVersionMismatch, migrateSnapshot from src/run-agent.ts -->

Every settled snapshot carries a plain `agentMeta: { machineId, version }` field (it survives the JSON round-trip). `version` defaults to `getMachineStructuralHash(machine)` — a dependency-free hash over the machine's structure (state ids/nesting, transition event types and targets, invoke srcs, `initial`), ignoring prompts, guards, and other functions. So a snapshot persisted for days remembers which machine shape produced it.

On resume, `runAgent` compares the incoming stamp against the current machine's version. If they differ (a state or transition was added, removed, or retargeted since the snapshot was saved):

- `onVersionMismatch: 'throw'` (default) throws `SnapshotVersionMismatchError` with `from`/`to`.
- `'warn'` logs once and proceeds; `'ignore'` proceeds silently.
- `migrateSnapshot(snapshot, { from, to })` — when provided — runs instead; its return value is the snapshot resumed from, so you can adapt an old snapshot to the new shape.

An unstamped snapshot (no `agentMeta`) is always accepted. Pass an explicit `machineVersion` (a semver or build id) to control migration boundaries yourself rather than tracking the structural hash.

```ts
try {
  await runAgent(machine, { snapshot, event, executors: { generateText } });
} catch (error) {
  if (error instanceof SnapshotVersionMismatchError) {
    // error.from / error.to — the machine changed since this snapshot was saved
  }
}
```

You still call `getAcceptedEvents` yourself only when you want to _render_ the choices — rehydrate the handle and read them:

```ts
import { createActor } from "xstate";
import { getAcceptedEvents } from "@statelyai/agent";

const snapshot = createActor(machine, { snapshot: JSON.parse(handle) }).getSnapshot();
const choices = getAcceptedEvents(snapshot); // one descriptor per legal event
```

### Reading interaction meta

Schema-typed state `meta` gives the host a typed interaction label or view hints to render for the human. Legal choices still come from the snapshot via `getAcceptedEvents`. Meta lives keyed by state id, so pull it off an idle snapshot with `getStateMeta`:

```ts
import { getStateMeta } from "@statelyai/agent";

const interaction = getStateMeta(snapshot).interaction ?? null;
```

`getStateMeta` merges the active state(s)' meta into one typed object (later/deeper wins for nested or parallel machines, `{}` when none declare meta), typed from the machine's meta schema. It replaces the older `Object.values(snapshot.getMeta())[0]` cast. See `readInteraction` in [machine-as-tool](../examples/machine-as-tool/index.ts).

## Inline input without settling

<!-- agent.userInput builtin and RunAgentOptions.userInput from src/run-agent.ts -->

To gather input mid-run without settling idle (a CLI prompt between two model calls, say), invoke the builtin `agent.userInput` actor and supply a `userInput` handler to `runAgent`:

```ts
reviewing: {
  invoke: {
    src: 'agent.userInput',
    input: ({ context }) => ({
      prompt: `How is this draft? ${context.draft ?? ''}`,
    }),
    onDone: ({ output }) => ({
      target: 'revising',
      context: { feedback: output },
    }),
  },
}
```

```ts
await runAgent(machine, {
  input,
  generateText,
  userInput: async ({ prompt }) => ask(prompt ?? ""),
});
```

The handler resolves to a `string` — what the human typed — so `onDone`'s `output` needs no cast. To collect structured input, gather the string(s) and parse/classify in a follow-up state (see [twenty-questions](../examples/twenty-questions/index.ts)) or register a custom actor source in place of `agent.userInput`.

Without a handler, `agent.userInput` becomes a **pending placeholder** instead of an error. See the next section.

## Parallel machines and pending user input

<!-- pending agent.userInput placeholder and pendingUserInputs/persistedSnapshot from src/run-agent.ts -->

Whole-machine idle is not enough for parallel machines: one region may wait for a human while a sibling region still has work in flight. An unhandled `agent.userInput` invoke covers this case. It waits indefinitely and does not block idle detection, so the run keeps executing sibling work and then settles idle with two extra fields:

- **`pendingUserInputs`**: one `{ id, input }` entry per pending `agent.userInput` invoke, carrying the invoke's resolved input (prompt, metadata) for the host to render.
- **`persistedSnapshot`**: a JSON-serializable snapshot that includes the in-flight invokes. Persist this one; the live `snapshot` cannot round-trip active children.

Resume with the persisted snapshot plus a `userInput` handler. The restored invoke re-runs against the handler and the machine proceeds:

```ts
const first = await runAgent(machine, { input, generateText });

if (first.status === "idle" && first.pendingUserInputs) {
  await store.save(JSON.stringify(first.persistedSnapshot));
  // ...later, possibly a different process...
  const second = await runAgent(machine, {
    snapshot: JSON.parse(await store.load()),
    generateText,
    userInput: async ({ prompt }) => ({ feedback: await ask(prompt ?? "") }),
  });
}
```

Resuming without a handler settles idle again with the same pending inputs, so a host can safely re-enter the loop.

## Choosing between the two waiting styles

- **Idle state** (`on:` handler, no invoke, flagged by your own `isSuspended` signal): the wait is an **event choice**; resume delivers the chosen event. Best for approve/reject flows where `getAcceptedEvents` drives a UI.
- **`agent.userInput`**: the wait is a **value request** with a prompt and schema; resume supplies the value. Best for free-form input, and the only style that lets sibling parallel regions keep working while a human is pending.

## Related

- [Steps](steps.md): durable hosts that checkpoint after every model call.
- [Agent machines](machines.md): authoring the states and transitions a waiting state is part of.
