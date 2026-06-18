# Host Actors

`setupAgent(...).withTasks(...)` describes model work as named tasks. The host still owns execution.

The text logic declares:

- input and output schemas
- model reference
- prompt/messages/system content
- optional tools, machine events, metadata, and common model options

The machine declares:

- state flow
- `invoke.src` as a registered logic name
- typed invoke `input`
- typed `onDone.event.output`

The host provides:

- Vercel AI SDK, Cloudflare Workers AI, LangChain, local models, or custom code
- streaming side channels
- tracing/logging
- provider options
- persistence and transport

## Blessed Pattern

Use named text logic and plain XState `invoke` objects. For maximum framework portability, run the machine with XState's pure transition functions and execute returned agent effects yourself.

```ts
import {
  createAgentSchemas,
  setupAgent,
  transitionResult,
} from '@statelyai/agent';
import { assign, initialTransition } from 'xstate';

const schemas = createAgentSchemas({
  context: contextSchema,
  input: inputSchema,
  output: outputSchema,
  events: eventSchemas,
});

const agent = setupAgent({ schemas }).withTasks({
  draftText: {
    schemas: {
      input: draftInputSchema,
      output: resultSchema,
    },
    model: 'openai/gpt-5.4-nano',
    prompt: ({ input }) => input.prompt,
    temperature: 0.2,
    events: ['APPROVE', 'REVISE'],
  },
});

const machine = agent.createMachine({
  initial: 'generating',
  states: {
    generating: {
      invoke: {
        id: 'draft',
        src: 'draftText',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: {
          target: 'done',
          actions: assign({
            result: ({ event }) => event.output,
          }),
        },
      },
    },
    done: { type: 'final' },
  },
});

let [snapshot, actions] = initialTransition(machine, input);

while (snapshot.status !== 'done') {
  for (const task of machine.getTasks(actions, snapshot)) {
    const output = await machine.execute(task, {
      generateText: (request) => generateText(request),
      streamText: (request) => streamText(request),
    });
    [snapshot, actions] = transitionResult(machine, snapshot, task, output);
  }
}
```

Every agent invoke should have a durable `id`; that ID is used to resume the matching `onDone` transition.

`machine.execute(...)` is convenience only. You can still inspect `task.input`, `task.tools`, and `task.events`, then call any SDK yourself.

## Allowed Event Tools

Use task `events` to expose specific state transitions as tools. `getAgentEffects(...)` validates that those events are legal from the current snapshot and returns event tools separately from the model-call input.

```ts
const effects = getAgentEffects(actions, {
  snapshot,
  schemas: agent.schemas,
  actors: { chooseMove },
});

const effect = effects[0];
Object.keys(effect.tools);
// ['event.ATTACK', 'event.DEFEND']
```

Each event tool returns the event object:

```ts
await effect.tools['event.ATTACK'].execute({ target: 'orc' });
// { type: 'ATTACK', target: 'orc' }
```

Only events listed in task `events` are exposed. If an event is listed but is not legal from the current state, it is omitted.

## Actor Runtime

When you want XState to execute invokes directly, provide implementations for the named task actors with `logic.withExecutor(...)`. The lower-level `createTextLogic(...)` primitive also accepts an executor, but `withTasks(...)` is the preferred authoring path.

```ts
const executableDraftText = agent.tasks.draftText.withExecutor(
  async ({ request, signal }) => {
    const result = await generateObject({
      model: resolveModel(request.model),
      system: request.system,
      prompt: request.prompt ?? '',
      schema: request.outputSchema as never,
      abortSignal: signal,
    });
    return result.object;
  }
);
```

For app-level adapters, overriding with `withExecutor(...)` is often cleaner:

```ts
import { generateObject, generateText } from 'ai';

const actors = {
  draftText: agent.tasks.draftText.withExecutor(async ({ request, signal }) => {
    if (request.outputSchema) {
      const result = await generateObject({
        model: resolveModel(request.model),
        system: request.system,
        prompt: request.prompt ?? '',
        schema: request.outputSchema as never,
        abortSignal: signal,
      });
      return result.object;
    }

    const result = await generateText({
      model: resolveModel(request.model),
      system: request.system,
      prompt: request.prompt ?? '',
      abortSignal: signal,
    });
    return result.text as never;
  }),
};
```

Then run any machine with those actors:

```ts
createActor(machine.provide({ actors }), { input }).start();
```

## Metadata

Use `metadata` for host-specific details. It is intentionally not interpreted by `@statelyai/agent`.

```ts
const agent = setupAgent({ schemas }).withTasks({
  draftText: {
    schemas: {
      input: draftInputSchema,
      output: resultSchema,
    },
    model: 'openai/gpt-5.4-nano',
    prompt: ({ input }) => input.prompt,
    metadata: ({ input }) => ({
      traceId: input.requestId,
    }),
  },
});
```

This is different from XState `meta`. XState `meta` describes state nodes and transitions for tooling. Text logic `metadata` is runtime input passed to the host actor.

## Streaming

Streaming chunks should stay in the host side channel: HTTP stream, WebSocket, AI SDK UI stream, stdout, tracing callback, etc. The machine transitions on the final text. That keeps snapshots deterministic and replayable.

The same task logic can be executed with `generateText(...)` or `streamText(...)`; the host decides.

## Low-Level Built-Ins

`agent.generate`, `agent.stream`, and `createTextLogic(...)` still exist as low-level escape hatches. Prefer `setupAgent(...).withTasks(...)` for new authoring because it gives reusable request construction, typed source names, typed invoke input, typed `event.output`, and schema-typed machine event tools.

## Why This Shape

The machine stays portable and visualizable. The host keeps full runtime control. You can use existing SDK code directly, but the workflow still gets typed transitions, XState snapshots, inspection, testing, and graph export.
