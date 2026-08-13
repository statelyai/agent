---
title: Human in the loop
description: Pause an agent for human input by settling idle, persist the snapshot anywhere, and resume in a different process.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page describes how an agent pauses for human input, how to persist the pause, and how to resume it in another process.

## The idle-first model

<!-- idle settle and snapshot resume behavior from src/run-agent.ts -->

A state that waits on a human is a state with no invoke and an `on:` handler for the human's event. There is no separate interrupt API.

- When nothing is in flight, `runAgent` settles with `{ status: 'idle', snapshot }` instead of hanging.
- Persist the snapshot, present the human their choices, then resume by passing the snapshot back with the chosen event.
- The machine decides which events are legal. The host delivers them.

The machine is unchanged between the run that settled and the run that resumes.

<!-- viz: idle lifecycle: runAgent -> idle settle with snapshot -> persist -> human chooses event -> runAgent(snapshot, event) -> done or idle again -->

> **Note:** Idle is a whole-machine condition. If one region of a parallel machine waits for a human while a sibling still has work running, the run finishes that work first. Waits modeled with `agent.userInput` are exempt, because they are pending placeholders that never block the settle. See [Parallel machines and pending user input](#parallel-machines-and-pending-user-input).

### Custom wait signals

<!-- setupAgent({ isIdle }) and RunAgentOptions.isIdle from src/run-agent.ts, src/setup-agent.ts -->

By default, `runAgent` detects a resting state with a timing heuristic. To settle intentional waits deterministically, tell the machine which states are idle states. The predicate is named `isIdle`.

There is no built-in tag. You choose the signal: a tag, a `snapshot.matches(...)` check, or a `meta` field. Declare it once with `setupAgent({ isIdle })`. The predicate travels with the machine, including through `machine.provide(...)`.

```ts no-check
const agentSetup = setupAgent({
  // ...schemas...
  isIdle: (snapshot) => snapshot.hasTag('awaiting-review'),
});

// ...then mark the idle states with the tag you chose:
reviewing: {
  tags: ['awaiting-review'],
  on: { APPROVE: { target: 'published' } },
},
```

A host can override the predicate for one run by passing `isIdle` to `runAgent`. The resolution order is the `runAgent` option, then the machine-carried predicate, then the timing heuristic.

## An idle state

In this machine, the `reviewing` state has no invoke. Once the machine reaches it, nothing happens until a human sends `APPROVE` or `REJECT`.

<!-- viz: state machine: drafting (invoke writeDraft) -> reviewing -> APPROVE -> published (final); reviewing -> REJECT -> drafting -->


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

The first `runAgent` call runs the draft, reaches `reviewing`, and settles `idle`. Persist the snapshot, wait for the human, then resume with `{ snapshot, event }`.

```ts
const first = await runAgent(machine, {
  input: { topic: "release notes" },
  executors,
});

if (first.status === "idle") {
  const persisted = JSON.parse(JSON.stringify(first.persistedSnapshot));

  // ...later, possibly a different process, the human approved...
  const second = await runAgent(machine, {
    snapshot: persisted,
    event: { type: "APPROVE" },
    executors,
  });
  // second.status === 'done'
}
```

A settled result already carries persistable snapshots, so there is no library helper for the round-trip. Store the value with whatever your persistence layer uses, and pass what you read back as `runAgent({ snapshot })`. Outside a `runAgent` result, take the snapshot from `actor.getPersistedSnapshot()` on a live actor, or `machine.getPersistedSnapshot(snapshot)` for a snapshot you hold. Serializing through `JSON.stringify` and `JSON.parse` in a sample shows exactly what a real store sees, including any non-JSON value it would drop.

> **Persist `persistedSnapshot` on an idle result.** An idle result carries two snapshots: `snapshot`, the live settled snapshot, and `persistedSnapshot`, the JSON-serializable one. The live `snapshot` cannot round-trip active children, so persisting it drops any pending `agent.userInput` invoke silently, and the loss only surfaces on resume. Narrow on `status === 'idle'` and persist `persistedSnapshot`. Where a value can also come from a non-idle result, `result.persistedSnapshot ?? result.snapshot` is correct. The rest of this page assumes that rule.

## Rules of resume

<!-- verified against src/run-agent.ts (resume checks, onVersionMismatch, migrateSnapshot) and src/event-log-store.ts (fork, append) -->

**Resume with an event the restored state accepts.** `runAgent` checks legality before starting the actor. It throws `AgentIllegalResumeEventError`, carrying `eventType` and `acceptedTypes`, instead of dropping the event silently.

```ts no-check
// Wrong: the event the UI showed five minutes ago may no longer be legal.
await runAgent(machine, { snapshot, event: { type: "APPROVE" }, executors });

// Right: read the legal set off the restored snapshot, or validate at the boundary.
const choices = getAcceptedEvents(snapshot); // { type, toolName, schema? }[]
await runAgent(machine, { snapshot, event: parseAgentEvent(snapshot, payload), executors });
```

**Persist before you surface anything to the human.** `runAgent` owns no store and stops its actor on every settle path, so an unpersisted snapshot is lost when the process ends. Persist `persistedSnapshot ?? snapshot`, as described in [Idle settle and resume](#idle-settle-and-resume).

```ts no-check
// Wrong: the notification can outlive the process that holds the only copy.
notifyReviewer(result.snapshot);

// Right: durable first, then tell the human.
await store.save(threadId, result.persistedSnapshot ?? result.snapshot);
notifyReviewer(threadId);
```

**Give a divergent resume its own thread.** `runAgent` does not track thread identity, so resuming one persisted snapshot twice runs it twice. The log layer enforces branching. `fork` requires a `newThreadId` and refuses a thread that already has entries. `append` rejects duplicate event ids within a thread.

```ts no-check
// Wrong: two resumes of the same snapshot, both appending to one thread.
await store.append({ threadId: "session-1", expectedIndex: 7, entries: branchA });
await store.append({ threadId: "session-1", expectedIndex: 7, entries: branchB }); // conflict

// Right: fork first, then let each branch own its thread.
await store.fork({ threadId: "session-1", newThreadId: "session-1-alt", upToIndex: 7 });
await store.append({ threadId: "session-1-alt", expectedIndex: 7, entries: branchB });
```

**Match the machine version, or migrate deliberately.** A snapshot stamped by an older machine shape can resume into transitions that no longer exist. By default, `runAgent` throws `AgentSnapshotVersionMismatchError`, carrying `from`, `to`, and `machineId`.

```ts no-check
// Wrong: silencing the check leaves the snapshot pointing at a state that moved.
await runAgent(machine, { snapshot, event, executors, onVersionMismatch: "ignore" });

// Right: adapt the old shape with a host-owned migration.
await runAgent(machine, {
  snapshot,
  event,
  executors,
  migrateSnapshot: (old, { from, to }) => upgradeSnapshot(old, from, to),
});
```

Read more about [Illegal resume events](#illegal-resume-events) and [Machine-version resume](#machine-version-resume).

## The human's choices

<!-- getAcceptedEvents from src/events.ts -->

The `getAcceptedEvents(snapshot)` helper returns one descriptor per currently legal event. Each descriptor has the event `type`, a synthetic `toolName`, and the payload schema when one is registered. Drive the loop from these descriptors.

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

A generic host builds the event dynamically from form input, a webhook payload, or an interaction protocol, so it cannot type the event against a specific machine. `parseAgentEvent(snapshot, event)` validates the `{ type, ...payload }` object at runtime against the accepted event types and registered payload schemas. It returns the event typed as the machine's event union, or throws a descriptive error. Use it instead of an `event as never` cast in meta-driven hosts.

```ts
import { parseAgentEvent } from "@statelyai/agent";

const event = parseAgentEvent(result.snapshot, { type: chosenType, ...formPayload });
result = await runAgent(machine, { snapshot: result.snapshot, event, executors });
```

The machine determines legality, not a system prompt. `getAcceptedEvents` reports only events the snapshot can take, so a UI built from these descriptors cannot drive an illegal transition.

## Persist and resume across processes

Persist the snapshot anywhere: a database row, a queue message, `localStorage`, or a file. `runAgent` stops its actor on every settle path (`done`, `idle`, `error`), so resume is always by snapshot, never by holding a live actor. A crash, a redeploy, and a days-long wait all resume the same way. To persist after every model call instead of only at settle, see [Steps](steps.md).

The sequence is: run to idle, serialize the snapshot to a handle, store the handle, then load it later and resume with an event. The handle is the JSON-serialized snapshot. Nothing else travels with it, because the snapshot holds the whole process state.

<!-- viz: cross-process resume sequence: process A runAgent -> idle -> persisted snapshot -> store; process B load -> runAgent(snapshot, event) -> done -->

- [file-snapshot-store](../examples/file-snapshot-store/index.ts): a `node:fs` store keyed by session id, resumed across several fresh `runAgent` calls. A SQLite variant is sketched inline.
- [machine-as-tool](../examples/machine-as-tool/index.ts): the same handle passed through a host harness's tool call. `startTool` runs to idle and returns the handle. `resumeTool` restores it and delivers the event.

The `AgentSnapshotStore` type is exported so stores interoperate. It declares `load(id): Promise<Snapshot | undefined>` and `save(id, snapshot): Promise<void>`. The type is exported without an implementation. Write your own store against a file, SQLite, or a key-value row.

To render the choices from a stored handle, restore the snapshot and read them.

```ts
import { createActor } from "xstate";
import { getAcceptedEvents } from "@statelyai/agent";

const snapshot = createActor(machine, { snapshot: JSON.parse(handle) }).getSnapshot();
const choices = getAcceptedEvents(snapshot); // one descriptor per legal event
```

Resume cannot re-run earlier work. A resumed snapshot starts at the idle state, so earlier states are never re-entered. Side effects and model calls that ran before the pause run exactly once, however many times you resume. Re-running work is always an authored transition, such as a `REJECT` that targets the drafting state again. A test in `src/run-agent.test.ts` named "pre-idle side effects and model calls run exactly once" pins this behavior.

> **Context must be JSON-serializable.** Persisted snapshots round-trip through `JSON.stringify` and `JSON.parse`, so anything in `context` that is not plain JSON corrupts silently on resume. A `Date` becomes a string, a `Map` or `Set` becomes `{}`, and class instances lose their prototype. Keep non-serializable handles such as sessions, database clients, and sockets in closures, and store only their serializable ids in `context`. See [threading host context](hosts.md#threading-host-context-into-actors-and-requests).

### Illegal resume events

<!-- AgentIllegalResumeEventError from src/run-agent.ts -->

Resuming with an event the restored state cannot take is a programmer error. `runAgent` throws `AgentIllegalResumeEventError`, carrying `eventType` and `acceptedTypes`, before delivering the event. This is a thrown error, not an `error`-status settle, so you do not need to pre-check legality.

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

A type-legal event that a guard rejects is not an illegal resume event. No transition happens, and the run settles under normal semantics. There is no option to ignore an illegal resume event. It always rejects.

### Machine-version resume

<!-- agentMeta stamping, onVersionMismatch, migrateSnapshot from src/run-agent.ts -->

Every settled snapshot carries a plain `agentMeta: { machineId, version }` field that survives the JSON round-trip, so a snapshot persisted for days records which machine shape produced it. `version` is the machine's own `version` from XState's `createMachine({ version })`, which is the single source of truth. A machine that declares no version falls back to `getMachineStructuralHash(machine)`, a dependency-free hash over the machine's structure. The hash covers state ids and nesting, transition event types and targets, invoke srcs, and `initial`. It ignores prompts, guards, and other functions.

On resume, `runAgent` compares the incoming stamp against the current machine's version. The versions differ when a state or transition was added, removed, or retargeted since the snapshot was saved. In that case:

- `onVersionMismatch: 'throw'`, the default, throws `AgentSnapshotVersionMismatchError` with `from` and `to`.
- `onVersionMismatch: 'warn'` logs once and proceeds. `'ignore'` proceeds silently.
- `migrateSnapshot(snapshot, { from, to })`, when provided, runs instead of the above. Its return value is the snapshot resumed from, so you can adapt an old snapshot to the new shape.

A snapshot with no `agentMeta` stamp is always accepted. Declare `createMachine({ version })`, such as a semver string or a build id, to control migration boundaries yourself instead of tracking the structural hash.

A machine that declares XState's own `createMachine({ version, migrate })` owns its mismatches. `runAgent` neither throws nor rewrites the snapshot's version in that case, so `migrate` sees the true `fromVersion`. A `migrateSnapshot` option still wins when you pass one, which is the seam for host-owned migrations of a machine you do not control.

```ts
try {
  await runAgent(machine, { snapshot, event, executors });
} catch (error) {
  if (error instanceof AgentSnapshotVersionMismatchError) {
    // error.from / error.to: the machine changed since this snapshot was saved
  }
}
```

> **Branch on `error.code`.** Both errors extend `AgentError`, which carries a `.code` string: `'illegal-resume-event'` and `'snapshot-version-mismatch'`. Check the code where `instanceof` is unreliable, such as when errors cross a bundle or process boundary.

### Reading interaction meta

Schema-typed state `meta` gives the host a typed interaction label or view hints. Legal choices still come from `getAcceptedEvents`. Meta is keyed by state id, so read it off an idle snapshot with `getStateMeta`.

```ts
import { getStateMeta } from "@statelyai/agent";

const interaction = getStateMeta(snapshot).interaction ?? null;
```

`getStateMeta` merges the meta of the active states into one object, typed from the machine's meta schema. A deeper state's meta wins over an ancestor's, and between parallel siblings at the same depth the later state id alphabetically wins, so the merge is deterministic. It returns `{}` when no active state declares meta. Use it instead of the older `Object.values(snapshot.getMeta())[0]` cast. See `readInteraction` in [machine-as-tool](../examples/machine-as-tool/index.ts).

## Inline input without settling

<!-- agent.userInput builtin and RunAgentOptions.userInput from src/run-agent.ts -->

To gather input mid-run without settling idle, such as a CLI prompt between two model calls, invoke the builtin `agent.userInput` actor and supply a `userInput` handler to `runAgent`.

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

The handler resolves to a `string`, which is what the human typed, so the `output` in `onDone` needs no cast. For structured input, gather the strings and parse them in a follow-up state. See [twenty-questions](../examples/twenty-questions/index.ts). You can also register a custom actor source in place of `agent.userInput`.

Without a handler, `agent.userInput` becomes a pending placeholder instead of an error. See [Parallel machines and pending user input](#parallel-machines-and-pending-user-input).

### Implementing agent.userInput

There are two ways to implement the builtin.

- `RunAgentOptions.userInput` is the inline path shown above.
- A provided actor source works for the [step path](steps.md), or when the inline path does not fit.

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

If a machine invokes `agent.userInput` and you supply neither implementation, `runAgent` fails at bind time, before any model call. The error names the actor and recommends the idle-state pattern.

### Scripted user input in tests

`createScriptedExecutors` takes a `userInput` script: one flat queue of answers consumed in order. The returned object carries a `userInput` handler alongside the executor slots, so pass it to `runAgent`'s `userInput` option. A queue that runs dry throws.

```ts no-check
const scripted = createScriptedExecutors({
  text: ["a draft"],
  userInput: ["sam@example.com", "yes"],
});

const result = await runAgent(machine, {
  input,
  executors: scripted,
  userInput: scripted.userInput,
});
```

Static [machine config](machines-as-data.md) uses the same actor source.

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

Whole-machine idle is not enough for parallel machines, because one region may wait for a human while a sibling still has work in flight. An unhandled `agent.userInput` invoke covers this case. It waits indefinitely without blocking idle detection, so the run finishes the sibling work and then settles idle with two extra fields.

- `pendingUserInputs` holds one `{ id, input }` entry per pending `agent.userInput` invoke. The `input` is the invoke's resolved input, such as the prompt and metadata, for the host to render.
- `persistedSnapshot` is the JSON-serializable snapshot that includes those in-flight invokes. This is the case the `persistedSnapshot ?? snapshot` rule in [Idle settle and resume](#idle-settle-and-resume) exists for.

Resume with `persistedSnapshot` and a `userInput` handler. The restored invoke re-runs against the handler and the machine proceeds.

<!-- viz: parallel machine idle: region A pending agent.userInput placeholder alongside region B still running an effect; run settles idle only after B finishes, carrying pendingUserInputs + persistedSnapshot -->


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

Resuming without a handler settles idle again with the same pending inputs, so a host can re-enter the loop safely.

## Waiting styles

There are two ways to model a wait.

- An idle state is a state with an `on:` handler, no invoke, and your own `isIdle` signal. The wait is an event choice, and resume delivers the chosen event. Use it for approve and reject flows where `getAcceptedEvents` drives a UI.
- `agent.userInput` is a value request with a prompt and a schema, and resume supplies the value. Use it for free-form input. It is the only style that lets sibling parallel regions keep working while a human is pending.

## Related

- [Steps](steps.md): durable hosts that persist after every model call.
- [The event log](event-log.md): replaying a run from its recorded external inputs.
- [Agent machines](machines.md): authoring the states and transitions an idle state is part of.
