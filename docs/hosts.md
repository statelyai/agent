# Hosts and executors

The machine owns agent control flow. A host supplies model request executors.

```ts no-check
const result = await runAgent(machine, {
  input,
  executors: {
    generateText: async (request, { signal }) => {
      const response = await mySdk.generate({
        model: request.model,
        prompt: request.prompt,
        signal
      });
      return { output: response.text, messages: response.messages };
    }
  }
});
```

Text, stream, and decision executors all receive `(request, info)`; cancellation is `info.signal`.

## Idempotency keys

Execution is at-least-once. A host runs the request and then journals its completion, so a crash between the two re-executes the request on resume. `runAgent({ store, threadId })` makes the log durable *before* each call, which bounds the duplicate to the one call that was in flight; it does not remove it.

`info.callKey` makes the duplicate safe to drop. Its format is `<executionId>:<requestId>#<n>`:

- `executionId` is the log's lineage id, pinned in the reserved `@agent.init` entry's `metadata` and inherited by every resume.
- `requestId` is the invoke site, and `n` counts that site's completions in the log — each iteration of a looped state gets its own key.
- A decision retry appends its attempt ordinal: `<executionId>:<requestId>#<n>.<attempt>`, where `attempt` is the number of prior failed attempts. Each retry is a different request, so it gets a different key.
- A resumed run re-executing an in-flight request passes the same `callKey` as the original attempt.
- A fork copies the init entry, so it keeps the parent's lineage id and can reuse results cached under the parent's keys for the requests it has not changed.
- It is `undefined` off the `runAgent` path (a bare `provideExecutors` bind) and on a run with no event log.

The key names the call *site*, not the request. A fork inherits the parent's lineage id, so a fork that changes what it asks at the same invoke site produces the same key for a different request. Cache on `callKey` **and** a fingerprint of the request, and reuse the cached result only when the request also matches. Pass `callKey` to a provider as its dedupe key for that identical request:

```ts no-check
const executors = {
  generateText: async (request, info) => {
    const fingerprint = JSON.stringify([request.model, request.prompt, request.messages]);
    const cached = info.callKey ? results.get(info.callKey) : undefined;
    if (cached?.fingerprint === fingerprint) return cached.result;
    const result = await callProvider(request, { idempotencyKey: info.callKey });
    if (info.callKey) results.set(info.callKey, { fingerprint, result });
    return result;
  }
};
```

See [The event log](event-log.md).

## Optional AI SDK default

```ts no-check
import { defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({ fast: openai("gpt-5.4-mini") });
const agent = setupAgent({ models, /* schemas and requests */ });

await runAgent(machine, { input });
```

A registry created by `defineModels` carries an optional AI SDK executor factory. Explicit executors merge over those defaults. Core does not import or require the AI SDK at runtime.

## Executor-owned structured retries

Retry policy belongs to the SDK or host executor. For example, a host may retry a tool-free AI SDK structured-output failure once while preserving the runner's abort signal:

```ts no-check
import { NoObjectGeneratedError } from "ai";

const aiSdk = createAiSdkExecutors({ models });
const executors = {
  ...aiSdk,
  generateText: async (request, info) => {
    try {
      return await aiSdk.generateText(request, info);
    } catch (error) {
      const hasTools = Object.keys(request.tools ?? {}).length > 0;
      if (hasTools || !NoObjectGeneratedError.isInstance(error)) throw error;
      return aiSdk.generateText(request, info);
    }
  }
};
```

Tool-bearing calls are not retried here because tools may have side effects. Use the framework's own interruption and retry facilities when available; Stately Agent forwards messages and execution to it.

## Resume events off the wire

A host that resumes a run from an HTTP request or a socket frame parses the payload at the boundary, then hands the parsed event to `runAgent`:

```ts no-check
let event;
try {
  event = parseAgentEvent(machine, await request.json());
} catch (error) {
  return Response.json({ error: String(error) }, { status: 400 });
}

const result = await runAgent(machine, { store, threadId, event, executors });

if (result.ignored) {
  return Response.json(
    { error: `'${result.ignored.type}' does not apply right now` },
    { status: 409 }
  );
}
```

- `parseAgentEvent(machineOrSnapshot, payload)` takes `unknown` and returns the event typed as the machine's event union. Give it the machine to read the event schemas `setupAgent` registered, or any snapshot of it.
- It throws `AgentInvalidEventPayloadError` (code `invalid-event-payload`) for a payload that is not an object with a string `type`, a reserved `@agent.*` type, or fields that fail the schema. That is the 400.
- It does not ask whether the current state handles the event, and `runAgent` adds no check of its own.
- An event the resumed state has no transition for is ignored: the run settles normally and `result.ignored` holds the event. Answer 409 if the client should know nothing happened.

See [Persistence](persistence.md#resume-with-an-event-off-the-wire).

## Uncontrolled XState actor

```ts no-check
const bound = provideExecutors(machine, executors);
const actor = createActor(bound, { input });
actor.start();
```

## One request

`executeAgentRequest` runs an individual typed request. It is useful in evals and raw SDK adapters without inventing a second machine lifecycle.

Framework-owned concerns—storage, durable execution, retries, queues, and tool-loop interruption recovery—remain with the framework.
