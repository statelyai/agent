# Advanced: bare XState actors and hand-written executors

Most hosts call `runAgent`, or drive the [step API](steps.md) themselves. This page covers the two things underneath those: binding executors onto a machine so it runs as a plain XState actor, and writing an executor without an adapter.

## `provideExecutors`: the machine as a plain actor

`provideExecutors(machine, executors)` returns a `machine.provide(...)`-ed copy whose `agent.generateText`, `agent.streamText`, and `agent.decide` sources call your executors. What comes back is an ordinary XState machine, so `createActor` runs it with no run loop around it.

```ts no-check
import { createActor } from "xstate";
import { provideExecutors } from "@statelyai/agent";

const actor = createActor(provideExecutors(machine, executors), { input });
actor.start();
actor.send({ type: "USER_REPLIED", text: "Continue" });
```

Reach for this when:

- **Your application already owns the actor.** A framework's XState integration (`useActor`, an actor registry, a durable actor runtime) wants a machine, not a promise of a result.
- **The agent machine is a child in a larger XState system.** Invoke or spawn the bound machine from a parent machine like any other actor logic; its decisions and requests run inside the parent's actor system.
- **The actor is long-lived.** A chat session, a game loop, or a device controller keeps one actor running across many human turns instead of resuming from a snapshot per turn.

What you give up compared with `runAgent`: there is no idle settling, no `maxModelCalls` cap, no event log or `snapshot`/`event` resume options, and no `run.start`/`run.end` trace boundary. The actor runs until you stop it. Usage events (`@agent.usage`) are still delivered to the machine, and `onTrace` still receives the request-level trace.

```ts no-check
const bound = provideExecutors(machine, executors, {
  onChunk: (chunk) => stream.write(chunk),
  onTrace: (event) => log.push(event),
});
```

- `actors` merges extra actor sources before binding, the same shape as `machine.provide({ actors })`.
- `onChunk` receives every chunk of every `mode: 'stream'` request.
- `onTrace` receives `request.start`, `request.end`, `request.error`, and `stream.chunk` events with the same envelope `runAgent` emits, minted per root actor. Pair it with `traceTransitions` on the actor's `inspect` option to fold `machine.transition` events into the same stream.

`provideExecutors` does not descend into invoked child machines. A child with its own agent requests needs its own `provideExecutors(...)` call, or `bindRequestExecutor` on its request logic (below). `runAgent` rebinds children for you.

## Writing an executor by hand

An executor is a plain function. `generateText` and `streamText` take the lowered request and return the same shape the machine receives in the invoke's `onDone`:

```ts no-check
const executors = {
  generateText: async (request, info) => {
    const response = await mySdk.generate({
      model: request.model,
      system: request.system,
      messages: request.messages,
      signal: info?.signal,
    });
    return {
      result: response.text,
      messages: response.messages,
      usage: { inputTokens: response.usage.input, outputTokens: response.usage.output },
    };
  },
};
```

- `result` is the value: the text, or the structured object the request's output schema describes. Core validates it against that schema.
- `messages` are the provider's response messages for this call. They arrive on `output.messages` in `onDone`, so the machine decides what to keep.
- `usage` is this call's token usage on the flat `inputTokens`/`outputTokens`/`totalTokens` names. `runAgent` folds it into the run's aggregate and the `@agent.usage` event.
- Anything else (`finishReason`, `toolCalls`, `raw`) rides along to `onResult(request, { raw })` and the `request.end` trace.

`streamText` returns the same shape once the stream finishes and calls `info.onChunk` for each chunk on the way. `decide` returns `{ event }`, the machine event the model chose from `request.events`; see [Decisions](decisions.md).

### Structured output

A structured request carries `request.outputSchema`. Ask the provider for the schema wrapped in a root object, which every provider accepts, and return the parsed `result`:

```ts no-check
import { getJsonSchema, parseProviderOutput, providerOutputSchema } from "@statelyai/agent";

if (request.outputSchema) {
  const schema = providerOutputSchema(request.outputSchema, { reasoning: request.includeReasoning });
  const jsonSchema = await getJsonSchema(schema);
  const raw = await mySdk.generateJson({ ...call, schema: jsonSchema });
  return parseProviderOutput(request, raw); // { result, reasoning? }
}
```

`providerOutputSchema` builds the `{ result, reasoning? }` schema to send. `parseProviderOutput` validates the provider's JSON against it and returns `{ result, reasoning? }`, which is already a valid executor result. The machine still validates `result` against the schema it declared.

### Sharing one executor with a child machine

`bindRequestExecutor(logic, executor)` binds a request's `TextLogic` to a `generateText`-shaped function, so a parent and its child machines can share one executor without a second `provideExecutors` call:

```ts no-check
childMachine.provide({
  actors: {
    researchTopic: bindRequestExecutor(childSetup.requests.researchTopic, executors.generateText),
  },
});
```

### Helpers for the raw result

- `getCallUsage(raw)` reads a call's normalized usage off any executor result.
- `getCallFinishReason(raw)` reads its normalized finish reason.
- `parseOutput(schema, value)` validates a bare value against a request's declared schema, for hosts that unwrap provider output themselves.

The adapters in `@statelyai/agent/ai-sdk` and `@statelyai/agent/openai` are built from exactly these pieces. Read them when a provider needs something this page does not cover.
