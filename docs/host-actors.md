# Host Actors

`setupAgent(...)` auto-provides built-in `agent.generateText` and `agent.streamText` actor sources. `createTextLogic(...)` describes reusable named model work. The host still owns execution.

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
  parseOutput,
  setupAgent,
} from '@statelyai/agent';
import { assign } from 'xstate';

const schemas = createAgentSchemas({
  context: contextSchema,
  input: inputSchema,
  output: outputSchema,
  events: eventSchemas,
});

const agent = setupAgent({ schemas });

const machine = agent.createMachine({
  initial: 'generating',
  states: {
    generating: {
      invoke: {
        id: 'draft',
        src: 'agent.generateText',
        input: ({ context }) => ({
          model: 'openai/gpt-5.4-nano',
          prompt: context.prompt,
          outputSchema: resultSchema,
          temperature: 0.2,
          eventTypes: ['APPROVE', 'REVISE'],
        }),
        onDone: {
          target: 'done',
          actions: assign({
            result: ({ event }) => parseOutput(resultSchema, event.output),
          }),
        },
      },
    },
    done: { type: 'final' },
  },
});

let step = machine.initial(input);

while (!step.done) {
  for (const task of step.tasks) {
    const output = await machine.execute(task, {
      generateText: (request) => generateText(request),
      streamText: (request) => streamText(request),
    });
    step = machine.resolve(step, task, output);
  }
}
```

Every agent invoke should have a durable `id`; that ID is used to resume the matching `onDone` transition.

`machine.execute(...)` is convenience only. You can still inspect `task.input`, `task.tools`, and `task.events`, then call any SDK yourself.

For external events, advance the same step object:

```ts
step = machine.transition(step, { type: 'REVISE', prompt: nextPrompt });
```

Use `initialTransition(...)`, `transition(...)`, and `transitionResult(...)` directly when a host wants to own the full XState action list instead of the `step.tasks` abstraction.

## User Input

Use `agent.userInput` when workflow logic needs to wait for a human. It is a normal invoked actor; the host owns how the request is delivered and resumed.

```ts
import { fromPromise } from 'xstate';

const machine = setupAgent.fromConfig(config).provide({
  actors: {
    'agent.userInput': fromPromise(async ({ input }) => {
      return showFormAndWaitForSubmit(input);
    }),
  },
});
```

Static config uses the same actor source:

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

When you want XState to execute named text invokes directly, provide implementations with `logic.withExecutor(...)`. Use direct `agent.generateText` / `agent.streamText` invokes when the request belongs at the state node; use `createTextLogic(...)` when the model-call shape should be named and reused.

```ts
const executableDraftText = draftText.withExecutor(
  async ({ request, signal }) => {
    const result = await generateText({
      model: resolveModel(request.model),
      system: request.system,
      prompt: request.prompt ?? '',
      output: Output.object({ schema: request.outputSchema as never }),
      abortSignal: signal,
    });
    return result.output;
  }
);
```

For app-level adapters, overriding with `withExecutor(...)` is often cleaner:

```ts
import { generateText, Output } from 'ai';

const actors = {
  draftText: draftText.withExecutor(async ({ request, signal }) => {
    if (request.outputSchema) {
      const result = await generateText({
        model: resolveModel(request.model),
        system: request.system,
        prompt: request.prompt ?? '',
        output: Output.object({ schema: request.outputSchema as never }),
        abortSignal: signal,
      });
      return result.output;
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
const draftText = createTextLogic({
  kind: 'generate',
  schemas: {
    input: draftInputSchema,
    output: resultSchema,
  },
  model: 'openai/gpt-5.4-nano',
  prompt: ({ input }) => input.prompt,
  metadata: ({ input }) => ({
    traceId: input.requestId,
  }),
});

const agent = setupAgent({
  schemas,
  actors: {
    draftText,
  },
});
```

This is different from XState `meta`. XState `meta` describes state nodes and transitions for tooling. Text logic `metadata` is runtime input passed to the host actor.

## Streaming

Streaming chunks should stay in the host side channel: HTTP stream, WebSocket, AI SDK UI stream, stdout, tracing callback, etc. The machine transitions on the final text. That keeps snapshots deterministic and replayable.

The same task logic can be executed with `generateText(...)` or `streamText(...)`; the host decides.

## Low-Level Primitive

Use `createTextLogic(...)` for reusable named model calls with typed source names, typed invoke input, typed `event.output`, and schema-typed machine event tools.

Standalone inspection:

```ts
const request = draftText.request({ prompt: 'Draft a launch email.' });
```

Standalone execution:

```ts
const output = await draftText.execute(
  { prompt: 'Draft a launch email.' },
  { generateText, streamText }
);
```

## Why This Shape

The machine stays portable and visualizable. The host keeps full runtime control. You can use existing SDK code directly, but the workflow still gets typed transitions, XState snapshots, inspection, testing, and graph export.
