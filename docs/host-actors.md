# Host Actors

`setupAgent(...)` is the quickstart for text agents: invoke `agent.generateText` or `agent.streamText` inline, extract returned requests, and let the host call the SDK. Use `createTextLogic(...)` when that model work deserves a reusable name. The host still owns execution.

Inline `agent.generateText` declares:

- model request fields
- optional output schema
- optional tools, machine events, metadata, and common model options

Reusable text logic also declares:

- input and output schemas for the reusable actor
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

## Quickstart Pattern

<!-- setupAgent built-in agent.generateText execution helpers exported from src/index.ts and src/setup-agent.ts -->

Use `setupAgent(...)` and inline `agent.generateText` for text-only flows. Use `runAgent(...)` for the common local loop.

```ts
import {
  createAgentSchemas,
  parseOutput,
  runAgent,
  setupAgent,
} from '@statelyai/agent';

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
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { result: parseOutput(resultSchema, output) },
        }),
      },
    },
    done: { type: 'final' },
  },
});

const output = await runAgent(machine, {
  input,
  generateText: (request) => generateText(request),
  streamText: (request) => streamText(request),
});
```

Every agent invoke should have a durable `id`; that ID is used to resume the matching `onDone` transition.

`runAgent(...)` is convenience only. You can still inspect `request.input`, `request.tools`, and `request.events`, then call any SDK yourself with `initialAgentStep(...)`, `executeAgentRequest(...)`, and `resolveAgentStep(...)`.

For external events, advance the same step object:

```ts
step = transitionAgentStep(machine, step, { type: 'REVISE', prompt: nextPrompt });
```

Use `initialTransition(...)`, `transition(...)`, and `transitionResult(...)` directly when a host wants to own the full XState action list instead of the `step.requests` abstraction.

## User Input

Use `agent.userInput` when workflow logic needs to wait for a human. It is a normal invoked actor; the host owns how the request is delivered and resumed.

```ts
import { createAsyncLogic } from 'xstate';

const machine = setupAgent.fromConfig(config).provide({
  actorSources: {
    'agent.userInput': createAsyncLogic({
      run: async ({ input }) => showFormAndWaitForSubmit(input),
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

Use a decision's `allowedEvents` to narrow which state transitions a model may choose from. `getAgentRequests(...)` intersects `allowedEvents` with the events legal from the current snapshot (via `getAcceptedEvents(...)`) and returns the surviving candidates on the decision request's `events` field, separate from the model-call input.

```ts
const requests = getAgentRequests(actions, {
  snapshot,
  schemas,
  actors: { chooseMove },
});

const request = requests[0];
request.events.map((event) => event.type);
// ['ATTACK', 'DEFEND']
```

Resolve the decision to get the chosen event:

```ts
const event = await resolveDecision(request, decide);
// { type: 'ATTACK', target: 'orc' }
```

Only events listed in `allowedEvents` are candidates. If an event is listed but is not legal from the current state, it is omitted.

## Actor Runtime

When you want XState to execute named text invokes directly, provide implementations with `logic.withExecutor(...)`. Use direct `agent.generateText` / `agent.streamText` invokes when the request belongs at the state node; use `createTextLogic(...)` when the model-call shape should be named and reused.

```ts
import { isStructuredOutputSchema, validateSchemaSync } from '@statelyai/agent';

const executableDraftText = draftText.withExecutor(
  async ({ request, signal }) => {
    if (isStructuredOutputSchema(request.outputSchema)) {
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
    return request.outputSchema
      ? validateSchemaSync(request.outputSchema, result.text)
      : result.text;
  }
);
```

For app-level adapters, overriding with `withExecutor(...)` is often cleaner:

```ts
import { generateText, Output } from 'ai';
import { isStructuredOutputSchema, validateSchemaSync } from '@statelyai/agent';

const actors = {
  draftText: draftText.withExecutor(async ({ request, signal }) => {
    if (isStructuredOutputSchema(request.outputSchema)) {
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
    return request.outputSchema
      ? validateSchemaSync(request.outputSchema, result.text)
      : result.text;
  }),
};
```

Then run any machine with those actors:

```ts
createActor(machine.provide({ actorSources: actors }), { input }).start();
```

## Metadata

Use `metadata` for host-specific details. It is intentionally not interpreted by `@statelyai/agent`.

```ts
const draftText = createTextLogic({
  mode: 'generate',
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

const agentSetup = setup({
  schemas,
  actorSources: { draftText },
});
```

This is different from XState `meta`. XState `meta` describes state nodes and transitions for tooling. Text logic `metadata` is runtime input passed to the host actor.

## Streaming

Streaming chunks should stay in the host side channel: HTTP stream, WebSocket, AI SDK UI stream, stdout, tracing callback, etc. The machine transitions on the final text. That keeps snapshots deterministic and replayable.

The same request logic can be executed with `generateText(...)` or `streamText(...)`; the host decides.

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

The machine stays portable. The host keeps full runtime control. You can use existing SDK code directly, but the workflow still gets typed transitions, XState snapshots, inspection, and testing. Visualization belongs in Stately Studio and the upcoming VS Code extension, not this package.
