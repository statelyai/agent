---
title: Human in the loop
description: Pause an agent for human input by settling idle, persist the snapshot anywhere, and resume in a different process.
---

## The idle-first model

<!-- idle settle and snapshot resume behavior from src/run-agent.ts -->

A state waiting on a human is just a state with no invoke and an `on:` handler for the human's event. There is no `interrupt()` call to learn. When `runAgent` reaches a point where nothing is in flight, it settles **`{ status: 'idle', snapshot }`** instead of hanging. You persist the snapshot, present the human with their choices, and resume by handing the snapshot back with the chosen event.

The machine decides which events are legal in the waiting state; the host delivers the human's event. Nothing about the machine changes between the run that settled and the run that resumes.

> **Note:** Idle is a whole-machine condition: `runAgent` settles only when nothing else is in flight. In a parallel machine where one region waits for a human while a sibling still has work running, the run finishes that work first. Waits modeled with `agent.userInput` are exempt: they are pending placeholders that never block the settle. See [Parallel machines and pending user input](#parallel-machines-and-pending-user-input).

## A waiting state

In this drafting workflow, `reviewing` has no invoke. Once reached, nothing happens until a human sends `APPROVE` or `REJECT`:

```ts
import { z } from 'zod';
import { setupAgent } from '@statelyai/agent';

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
      model: 'writer',
      prompt: ({ input }) => input.topic,
    },
  },
});

const machine = agentSetup.createMachine({
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  initial: 'drafting',
  states: {
    drafting: {
      invoke: {
        src: 'writeDraft',
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: 'reviewing', context: { draft: output } }),
      },
    },
    reviewing: {
      on: {
        APPROVE: { target: 'published' },
        REJECT: ({ context, event }) => ({
          target: 'drafting',
          context: { topic: `${context.topic}\nRevision: ${event.reason}` },
        }),
      },
    },
    published: {
      type: 'final',
      output: ({ context }) => ({ published: true, draft: context.draft ?? '' }),
    },
  },
});
```

## Settle idle, then resume

The first `runAgent` runs the draft, reaches `reviewing`, and settles `idle`. Persist the snapshot, wait for the human, resume with `{ snapshot, event }`:

```ts
const first = await runAgent(machine, { input: { topic: 'release notes' }, generateText });

console.log(first.status);
// logs 'idle'

const persisted = JSON.parse(JSON.stringify(first.snapshot));

// ...later, possibly a different process, the human approved...
const second = await runAgent(machine, {
  snapshot: persisted,
  event: { type: 'APPROVE' },
  generateText,
});

console.log(second.status);
// logs 'done'
```

The snapshot is a plain, JSON-serializable object; the `JSON.stringify`/`JSON.parse` round-trip above proves it survives a real persistence layer.

## Present the human's choices

<!-- getAcceptedEvents from src/events.ts -->

`getAcceptedEvents(snapshot)` returns one descriptor per **currently-legal** event: its `type`, a synthetic `toolName`, and its payload schema when registered. Drive the loop off it:

```ts
import { getAcceptedEvents, runAgent } from '@statelyai/agent';

let result = await runAgent(machine, { input, generateText });

while (result.status === 'idle') {
  const choices = getAcceptedEvents(result.snapshot);
  const event = await promptUser(choices);
  result = await runAgent(machine, { snapshot: result.snapshot, event, generateText });
}

if (result.status === 'done') {
  console.log(result.output);
}
```

Legality comes from the machine, not a system prompt: `getAcceptedEvents` reports only events the snapshot can actually take, so a UI built from these choices cannot drive the machine into an illegal transition.

## Persist and resume across processes

Between iterations, persist `result.snapshot` anywhere: a database row, a queue message, `localStorage`, a file. `runAgent` stops its actor on every settle path (`done`, `idle`, `error`), so resume is **always by snapshot**, never by holding a live actor. That is what makes the pause durable: a crash, a redeploy, or a days-long wait all resume identically.

For a checkpoint after every model call, not only at settle, see [Steps](steps.md).

## Inline input without settling

<!-- agent.userInput builtin and RunAgentOptions.userInput from src/run-agent.ts -->

To gather input mid-run without settling idle (a CLI prompt between two model calls, say), invoke the builtin `agent.userInput` actor and supply a `userInput` handler to `runAgent`:

```ts
reviewing: {
  invoke: {
    src: 'agent.userInput',
    input: ({ context }) => ({
      prompt: `How is this draft? ${context.draft ?? ''}`,
      schema: z.object({ feedback: z.string() }),
    }),
    onDone: ({ event }) => ({
      target: 'revising',
      context: { feedback: (event.output as { feedback: string }).feedback },
    }),
  },
}
```

```ts
await runAgent(machine, {
  input,
  generateText,
  userInput: async ({ prompt }) => ({ feedback: await ask(prompt ?? '') }),
});
```

Without a handler, `agent.userInput` becomes a **pending placeholder** instead of an error. See the next section.

## Parallel machines and pending user input

<!-- pending agent.userInput placeholder and pendingUserInputs/persistedSnapshot from src/run-agent.ts -->

Whole-machine idle is not enough for parallel machines: one region may wait for a human while a sibling region still has work in flight. An unhandled `agent.userInput` invoke covers this case. It waits indefinitely and does not block idle detection, so the run keeps executing sibling work and then settles idle with two extra fields:

- **`pendingUserInputs`**: one `{ id, input }` entry per pending `agent.userInput` invoke, carrying the invoke's resolved input (prompt, schema, and so on) for the host to render.
- **`persistedSnapshot`**: a JSON-serializable snapshot that includes the in-flight invokes. Persist this one; the live `snapshot` cannot round-trip active children.

Resume with the persisted snapshot plus a `userInput` handler. The restored invoke re-runs against the handler and the machine proceeds:

```ts
const first = await runAgent(machine, { input, generateText });

if (first.status === 'idle' && first.pendingUserInputs) {
  await store.save(JSON.stringify(first.persistedSnapshot));
  // ...later, possibly a different process...
  const second = await runAgent(machine, {
    snapshot: JSON.parse(await store.load()),
    generateText,
    userInput: async ({ prompt }) => ({ feedback: await ask(prompt ?? '') }),
  });
}
```

Resuming without a handler settles idle again with the same pending inputs, so a host can safely re-enter the loop.

Choosing between the two waiting styles:

- **Idle state** (`on:` handler, no invoke): the wait is an event choice; resume delivers the event. Best for approve/reject flows where `getAcceptedEvents` drives a UI.
- **`agent.userInput`**: the wait is a value request with a prompt and schema; resume supplies the value. Best for free-form input, and the only style that lets sibling parallel regions keep working while a human is pending.

## Related

- [Steps](steps.md): durable hosts that checkpoint after every model call.
- [Agent machines](machines.md): authoring the states and transitions a waiting state is part of.
