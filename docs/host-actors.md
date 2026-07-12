---
title: Host actors
description: The machine declares typed actor requests; the host executes them with executors or actor implementations, on any SDK or runtime.
---

`setupAgent(...)` gives a machine typed, built-in actor sources for model work: `agent.generateText` / `agent.streamText` for inline text requests, `agent.decide` for decisions, `agent.userInput` for human input, plus co-located `requests:` when a call deserves a reusable name. Decisions are state-local: author them inline on the invoke with `src: 'agent.decide'`. In every case, the machine only *declares* the request; the host executes it by supplying executors to `runAgent(...)` (or the step helpers) or by providing actor implementations directly.

The machine declares:

- state flow
- `invoke.src` naming a registered actor (a builtin like `agent.generateText`/`agent.decide`, or a name from `requests:`/`actorSources:`)
- typed invoke `input`
- typed `onDone.event.output`

The host provides:

- Vercel AI SDK, Cloudflare Workers AI, LangChain, local models, or custom code — via executors (`generateText`/`streamText`/`decide`) or `.withExecutor(...)`
- streaming side channels
- tracing/logging
- persistence and transport

## Quickstart pattern

<!-- inline agent.generateText + runAgent, from src/setup-agent.ts and src/index.ts -->

Inline `agent.generateText` is the fastest path for a one-off text request:

```ts
import {
  parseOutput,
  runAgent,
  setupAgent,
} from '@statelyai/agent';

const agent = setupAgent({
  context: contextSchema,
  input: inputSchema,
  output: outputSchema,
  events: eventSchemas,
});
const machine = agent.createMachine({
  initial: 'generating',
  states: {
    generating: {
      invoke: {
        id: 'draft',
        src: 'agent.generateText',
        input: ({ context }) => ({
          model: 'openai/gpt-5.4-mini',
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

const result = await runAgent(machine, {
  input,
  generateText: (request) => generateText(request), // any SDK
  streamText: (request) => streamText(request),
});
```

Every agent invoke should have a durable `id` — it's how a resumed/replayed run matches the invoke back to its `onDone` transition.

When a request is reusable — called from more than one state, or worth testing standalone — extract it into `requests:` (co-located on `setupAgent`) or `createTextLogic(...)` (standalone). `runAgent(...)` is convenience only: you can always inspect `request.input`/`request.tools` and call `initialAgentStep(...)`, `executeAgentRequest(...)`, `resolveAgentStep(...)` yourself, or drop to XState's `initialTransition(...)`/`transition(...)` when a host wants to own every XState action directly. See [`../readme.md`](../readme.md#the-step-path-durable-hosts) for the step-path host loop.

For external events, advance the same step object:

```ts
step = transitionAgentStep(machine, step, { type: 'REVISE', prompt: nextPrompt });
```

## User input

`agent.userInput` is one of the two waiting styles; see [Choosing between the two waiting styles](human-in-the-loop.md#choosing-between-the-two-waiting-styles) for when to pick it over an idle state. It's a normal invoked actor; the host owns how the request is delivered and resumed. Two ways to implement it:

**`RunAgentOptions.userInput`** — the inline path, for gathering input without settling the run:

```ts
const result = await runAgent(machine, {
  input,
  generateText,
  userInput: async (input) => showFormAndWaitForSubmit(input),
});
```

**A provided actor source** — for the step path, or when `runAgent`'s inline path doesn't fit:

```ts
import { createAsyncLogic } from 'xstate';

const machine = setupAgent
  .fromConfig(config, { compileSchema })
  .provide({
    actorSources: {
      'agent.userInput': createAsyncLogic({
        run: async ({ input }) => showFormAndWaitForSubmit(input),
      }),
    },
  });
```

If a machine invokes `agent.userInput` and neither is supplied, `runAgent` fails at bind time — before any model call — naming the actor and recommending the idle-state pattern instead.

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

## Decisions and allowed events

A decision's `allowedEvents` declares which machine events are candidates for the model to choose from; XState's guards then decide which of those are actually legal from the current snapshot. `getAgentRequests(machine, actions, snapshot)` (used internally by the step helpers, drawing schemas and actor sources from the machine's registered `setupAgent` options) intersects the two and puts the survivors on the decision request's `events` field — separate from the model-call input, so the model sees only options it could actually take:

```ts
const requests = getAgentRequests(machine, actions, snapshot);
const request = requests[0]; // kind: 'decision'
request.events.map((event) => event.type);
// ['ATTACK', 'DEFEND'] — HEAL and FLEE excluded, whether by allowedEvents or by guard
```

Resolve the decision to get the chosen, validated event:

```ts
const event = await resolveDecision(request, decide);
// { type: 'ATTACK', target: 'orc' }
```

`resolveDecision` retries on an unknown event type, an invalid payload, or a guard rejection — see [`../readme.md`](../readme.md#decisions) for the full validation/retry contract. This is also why `getAcceptedEvents(...)` (type-only filtering, no guard evaluation) is not sufficient on its own for "is this choice legal": `resolveDecision`'s `snapshot.can(event)` check is what actually closes the gap at apply time.

## Actor runtime

When you want XState to execute a named text/decision invoke directly — rather than routing every request through `runAgent`'s executor slots — provide an implementation with `logic.withExecutor(...)`:

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

Then run any machine with those actors, bypassing `runAgent`'s executor slots entirely:

```ts
createActor(machine.provide({ actorSources: { draftText: executableDraftText } }), { input }).start();
```

This is the same mechanism `runAgent` uses internally to bind `generateText`/`streamText`/`decide` — `.withExecutor(...)` is just the lower-level form, useful when a text/decision logic should carry its own execution wherever it's used, independent of the host loop.

## Metadata

Use `metadata` for host-specific details. It's intentionally uninterpreted by `@statelyai/agent`, except for the one adapter-level convention `createAiSdkExecutors` reads: `metadata.maxSteps` bounds a multi-step AI SDK tool-call loop for that request (see [`../readme.md`](../readme.md#hosts--adapters)).

```ts
const draftText = createTextLogic({
  schemas: { input: draftInputSchema, output: resultSchema },
  model: 'openai/gpt-5.4-mini',
  prompt: ({ input }) => input.prompt,
  metadata: ({ input }) => ({ traceId: input.requestId }),
});
```

This is different from XState `meta`, which describes state nodes/transitions for tooling (see [`../examples/email-drafter/index.ts`](../examples/email-drafter/index.ts) for a schema-typed `meta` example). Text/decision logic `metadata` is runtime input passed to the host executor.

## Threading host context into actors and requests

Agents often need host-owned values (a session handle, a db client, auth or billing ids) reaching the code that makes a model call. There is no dedicated `hostContext` option today. Three sanctioned patterns cover the need, and which one to reach for depends on whether the value is serializable and whether the executor needs it per call.

**(a) Through machine `input` into context, then into actor `input`.** Pass ids and plain values as machine `input`, land them in `context`, and map them into each actor's `input`. Good for serializable identifiers that the machine should carry across transitions and persist in snapshots.

```ts
const machine = agent.createMachine({
  context: ({ input }) => ({ tenantId: input.tenantId, prompt: input.prompt }),
  states: {
    answering: {
      invoke: {
        src: 'answerQuestion',
        input: ({ context }) => ({ prompt: context.prompt, tenantId: context.tenantId }),
        // ...
      },
    },
  },
});
```

**(b) Close over host objects when defining actors at host level.** For non-serializable handles (a live session, a db client, an open socket), close over them where you define the actor via `.provide({ actorSources })` or `.withExecutor(...)`. The handle lives in the closure, never in `context`.

```ts
function buildMachine(session: Session, db: DbClient) {
  return baseMachine.provide({
    actorSources: {
      draftEmail: draftEmail.withExecutor(async ({ request }) => {
        const history = await db.loadThread(request.threadId);
        return session.prompt(request.prompt, { history });
      }),
    },
  });
}
```

Non-serializable handles must **not** live in `context` if you persist snapshots: they won't survive serialization and will break resume. Keep sessions, clients, and sockets in the closure; keep only their serializable ids in `context`.

**(c) Per-call reference ids belong in request input schemas.** When the executor needs a value on every call (an auth token, a billing id, a per-request trace or reference id), put it in the request's input schema so it's typed and validated at the call site rather than smuggled through `metadata`. Use `metadata` only for host-specific hints the machine should not type (see above).

A dedicated `hostContext` option is under consideration to make (a) less repetitive, but it is **not shipped**. Until then, these three patterns are the supported approach.

## Streaming

Streaming chunks stay in the host side channel: HTTP stream, WebSocket, AI SDK UI stream, stdout, tracing callback, etc. The machine transitions on the final text — that keeps snapshots deterministic and replayable. `runAgent`'s `onChunk(chunk, { request })` callback is the observation seam; it's void, so it can't affect control flow.

The same request can run through `generateText(...)` or `streamText(...)` — the host decides, by choosing which executor to supply or which method `createTextLogic`'s `mode` invokes.

## Raw AI SDK functions

The `generateText`/`streamText` executors accept the raw Vercel AI SDK functions directly — no adapter needed:

```ts
import { generateText, streamText } from 'ai';

await runAgent(machine, { input, generateText, streamText });
```

An `AgentTextRequest` is spread-compatible with the AI SDK's call options, and their result shapes are unwrapped natively: `generateText`'s `{ text }` and `streamText`'s `{ textStream }` (chunks reach `onChunk`, final text is `await result.text`).

Two caveats:

- **Structured output is best-effort.** For a request with an `outputSchema`, the raw text is `JSON.parse`d and validated; a parse failure throws. For reliable structured output, use `createAiSdkExecutors` from `@statelyai/agent/ai-sdk` or `createOpenAiCompatExecutors` from `@statelyai/agent/openai-compat`.
- **`decide` needs an adapter.** The tool-per-event mapping lives in `createAiSdkExecutors` (and `createOpenAiCompatExecutors`); there is no raw AI SDK function for it.

For any OpenAI-compatible Chat Completions endpoint (Groq, Together, Ollama, vLLM, OpenRouter, LM Studio, OpenAI itself), `createOpenAiCompatExecutors({ baseUrl, apiKey?, models? })` from `@statelyai/agent/openai-compat` is a second shipped adapter — a complete `{ generateText, streamText, decide }` set over raw `fetch` with zero dependencies (pass a `fetch` override for Workers or tests).

## Low-level primitive

Use `createTextLogic(...)` for reusable named model calls with typed source names, typed invoke input, typed `event.output`, and a schema-typed request shape.

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

## Why this shape

The machine stays portable — it never imports a model SDK. The host keeps full runtime control: swap `createAiSdkExecutors` for a raw `fetch`, add tracing at the `onResult` seam, or drop to `.withExecutor(...)` when a request should carry its own execution. The workflow still gets typed transitions, XState snapshots, inspection, and testing throughout. Visualization is intentionally out of scope for this package — see the alpha-status note in [`../readme.md`](../readme.md#alpha-status--whats-not-here-yet).
