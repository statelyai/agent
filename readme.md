# @statelyai/agent

**Alpha.** The API changed completely in this release and is still settling. Expect breaking changes before 2.0 stable. Feedback and issues welcome.

Author AI agents as typed XState state machines — a portable blueprint of what your agent can do. The machine decides: what states exist, which transitions are legal, which model calls happen, and which events the model may choose *right now*. Your host executes: call the Vercel AI SDK, Cloudflare Workers AI, a raw provider fetch, or anything else — the machine never talks to a model directly.

## Quickstart

<!-- setupAgent + runAgent quickstart, based on examples/joke/index.ts and examples/twenty-questions/index.ts -->

```ts
import { z } from 'zod';
import {
  createAgentSchemas,
  parseOutput,
  runAgent,
  setupAgent,
} from '@statelyai/agent';
import { createAiSdkExecutors } from '@statelyai/agent/ai-sdk';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

const answerSchema = z.object({ answer: z.string() });

const schemas = createAgentSchemas({
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: answerSchema,
});

const agent = setupAgent({
  schemas,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: 'openai/gpt-4.1-mini',
      prompt: ({ input }) => input.prompt,
    },
  },
});

const machine = agent.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: 'answering',
  states: {
    answering: {
      invoke: {
        id: 'answer',
        src: 'answerQuestion',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { answer: parseOutput(answerSchema, output).answer },
        }),
      },
    },
    done: { type: 'final', output: ({ context }) => ({ answer: context.answer ?? '' }) },
  },
});

function resolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ''));
}

const result = await runAgent(machine, {
  input: { prompt: 'Why state machines?' },
  ...createAiSdkExecutors({ resolveModel }),
});

if (result.status === 'done') {
  console.log(result.output.answer);
}
```

In published form: `import ... from '@statelyai/agent'` for authoring, `import { createAiSdkExecutors } from '@statelyai/agent/ai-sdk'` for the shipped Vercel AI SDK host adapter.

## Decisions

<!-- decision primitive, based on src/setup-agent.ts (agent.decide builtin, createDecisionLogic, resolveDecision) and examples/twenty-questions/index.ts -->

This is the headline feature. A **decision** is the model choosing exactly one **currently-legal** machine event — not free text, not an arbitrary tool call. The machine declares which events are candidates; XState's guards decide which of those are actually legal from the current state; the model picks among the survivors.

Decisions are **local to the state that makes them** — authored inline with the built-in `agent.decide` actor source, right on the invoke that needs one. Candidates default to that state's own legal events, or narrow them with `allowedEvents`, typed against the machine's event-schema keys so a typo'd event name is a compile error, not a runtime surprise:

```ts
deciding: {
  invoke: {
    id: 'chooseAction',
    src: 'agent.decide',
    input: ({ context }) => ({
      model: 'openai/gpt-4.1-mini',
      system: 'Ask one yes/no question at a time, or guess once confident.',
      prompt: `Questions remaining: ${context.questionsRemaining}`,
      // Typed against the machine's event-schema keys — a typo here is a
      // compile error, not a runtime surprise.
      allowedEvents: ['ASK', 'GUESS'] as const,
    }),
    onDone: sendDecision(),          // delivers the chosen event into this state's `on:`
    onError: { target: 'stumped' },  // retries exhausted
  },
  on: {
    // ASK is only legal while questions remain — returning `undefined`
    // makes the transition illegal for a guard-rejected choice.
    ASK: ({ context, event }) =>
      context.questionsRemaining > 0
        ? { target: 'awaitingAnswer', context: { /* ... */ } }
        : undefined,
    GUESS: ({ context, event }) => ({ target: 'revealing', context: { guess: event.answer } }),
  },
},
```

`allowedEvents` narrows the *declared* candidates; XState's guards then decide what's actually legal from the current snapshot. A model choosing an event that's declared but currently illegal doesn't get through — `resolveDecision` checks `snapshot.can(event)` before accepting it. Guards make illegal choices **impossible**, not just discouraged by a system prompt.

Validation runs three checks, each producing a typed failure that's fed back to the model on retry (default 2 retries, so up to 3 attempts):

- `unknown-event` — the model picked a type outside `allowedEvents`
- `invalid-payload` — the payload doesn't match that event's schema
- `rejected-by-guard` — the type and payload are fine, but the state's guard says no right now

Exhausting retries throws `DecisionExhaustedError`, caught by the invoke's `onError`. How the model is actually coerced into choosing one option (tool-per-event with forced tool choice, structured output over an event union, etc.) is host/adapter business — see `createAiSdkExecutors`'s `decide` executor below. Core only validates and retries; it never talks to a model.

When a decision's logic is reusable, exported, or worth testing standalone (independent of any one machine), pull it out with `createDecisionLogic(...)` and register it under `actors:` instead of inlining it — see [`examples/game-agent/index.ts`](examples/game-agent/index.ts), which exports `chooseMove` and narrows `allowedEvents` as a function of input (HP-gated moves).

See [`examples/twenty-questions/index.ts`](examples/twenty-questions/index.ts) (decision loop + guard rejection + idle HITL) and [`examples/game-agent/index.ts`](examples/game-agent/index.ts) (`allowedEvents` as a function of input, narrowing move options by HP).

## Human-in-the-loop & persistence

<!-- idle-first HITL, based on src/setup-agent.ts (runAgent) and examples/langgraph-human-in-the-loop/index.ts -->

There's no `interrupt()` call to learn. A state that's waiting on a human is just a state with no invoke and an `on:` handler for the human's event. When `runAgent` reaches a point where nothing is in flight, it settles `{ status: 'idle', snapshot }` instead of hanging — the snapshot is a plain, JSON-serializable object. Resume by handing that snapshot back with the event:

```ts
let result = await runAgent(machine, { input, ...executors });

while (result.status === 'idle') {
  const event = await promptUser(getAcceptedEvents(result.snapshot));
  result = await runAgent(machine, { snapshot: result.snapshot, event, ...executors });
}

if (result.status === 'done') {
  console.log(result.output);
}
```

Between iterations you're free to persist `result.snapshot` anywhere — a database row, a queue message, `localStorage` — and resume in a different process later. `runAgent` stops its actor on every settle (`done`/`idle`/`error`); resuming is always by snapshot, never by holding a live actor around.

For inline human input without settling (a CLI prompt mid-run, say), invoke the builtin `agent.userInput` actor and supply `RunAgentOptions.userInput`. If a machine uses `agent.userInput` with neither that option nor a provided actor source, `runAgent` fails at bind time recommending the idle-state pattern instead.

See [`examples/langgraph-human-in-the-loop/index.ts`](examples/langgraph-human-in-the-loop/index.ts) and [`examples/langgraph-snapshot-persistence/index.ts`](examples/langgraph-snapshot-persistence/index.ts).

## Messages

<!-- AgentMessage parts model, based on src/types.ts and src/utils.ts -->

`AgentMessage` is a parts-based, discriminated union mirroring the Vercel AI SDK's `ModelMessage` shape structurally (no dependency on `ai` in core):

```ts
type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;
```

`content` is a string or an array of typed parts (`TextPart`, `ImagePart`, `FilePart`, `ToolCallPart`, `ToolResultPart`) depending on role. Build messages with `systemMessage(...)`, `userMessage(...)`, `assistantMessage(...)`, `toolMessage(...)`, and validate a message list against `messagesSchema`.

```ts
import { userMessage, assistantMessage } from '@statelyai/agent';

context: {
  messages: [userMessage('Draft a launch email.'), assistantMessage('Sure — ...')],
}
```

Caveat: `ImagePart`/`FilePart` can carry binary data (`Uint8Array`/`ArrayBuffer`) or a `URL` instance, neither of which is JSON-serializable. If you persist machine context (snapshots, event logs) that contains messages, keep binary content as base64 strings or URL strings in those parts — the library does not serialize this for you.

## Hosts & adapters

<!-- createAiSdkExecutors and the raw executor contract, from src/ai-sdk/index.ts -->

`createAiSdkExecutors({ resolveModel })` from `@statelyai/agent/ai-sdk` is the one adapter this package ships. It builds the `{ generateText, streamText, decide }` executor set `runAgent` needs, mapping requests onto `generateText`/`streamText`/tool-forced `generateText` calls from the Vercel AI SDK. For multi-step tool loops, set `metadata.maxSteps` on a request — the adapter forwards it as `stopWhen: stepCountIs(maxSteps)`; a request with no `maxSteps` stays single-step.

`ai` is an optional peer dependency — core `src/` has zero runtime dependencies besides `xstate` (also a peer). Nothing stops you from writing your own executor set; the contract is just three functions taking plain request objects and returning plain results:

```ts
import type { AgentRequestExecutors } from '@statelyai/agent';

const executors: AgentRequestExecutors = {
  generateText: async (request) => {
    const res = await fetch('https://api.example.com/v1/generate', {
      method: 'POST',
      body: JSON.stringify({ model: request.model, prompt: request.prompt }),
    });
    return { text: await res.text() };
  },
};

await runAgent(machine, { input, ...executors });
```

Any SDK, or raw `fetch`, works — the machine has no idea which one you used.

## The step path (durable hosts)

<!-- step helpers for per-model-call checkpointing, from src/setup-agent.ts and examples/ai-sdk-game-host/index.ts -->

`runAgent` checkpoints only at `done`/`idle`/`error` — good enough for most hosts, but not for Cloudflare Workflows, Temporal, or anything that needs a durable checkpoint after *every* model call. For that, use the lower-level step helpers directly:

```ts
let step = initialAgentStep(machine, input, { schemas, actors });

while (!step.done) {
  const [request] = step.requests;

  if (request.kind === 'decision') {
    const chosenEvent = await resolveDecision(request, decide);
    step = transitionAgentStep(machine, step, chosenEvent, { schemas, actors });
    continue;
  }

  const output = await executeAgentRequest(request, executors);
  step = resolveAgentStep(machine, step, request, output, { schemas, actors });
}

console.log(step.snapshot.output);
```

Each `step` is a plain, inspectable object — `{ snapshot, actions, requests, done }` — so a host can persist it after every model call rather than only at the end. `step.requests` is a `kind`-discriminated union (`'text' | 'decision'`); a durable host can serialize the request, schedule the call, and resume later.

Delayed transitions (`after`) surface in `step.actions` as schedulable raise actions rather than running on a live timer — the host owns the clock (a Workflow sleep, a Temporal timer, a queue delay) and applies the event via `transitionAgentStep` when it fires.

See [`examples/ai-sdk-game-host/index.ts`](examples/ai-sdk-game-host/index.ts) (Vercel AI SDK step loop), [`examples/tanstack-ai-host/index.ts`](examples/tanstack-ai-host/index.ts) (TanStack AI step loop sketch), and [`examples/cloudflare-workers-ai-host/index.ts`](examples/cloudflare-workers-ai-host/index.ts) / [`examples/cloudflare-agent-host/index.ts`](examples/cloudflare-agent-host/index.ts) (Cloudflare sketches — illustrative, excluded from typechecking pending the `agents`/Workers AI package surface settling).

Thought of as event sourcing: each step applies exactly one event (a machine transition, a resolved model result, or a decision's chosen event). Persisting the ordered event log — not just the latest snapshot — is what makes replay and audit possible; a snapshot is a compaction checkpoint, not the source of truth.

## Static workflow configs

<!-- setupAgent.fromConfig + JSON Schema export, from src/setup-agent.ts and schemas/agent-workflow.json -->

The package also publishes a JSON Schema for static, declarative agent workflow definitions, for cases where the workflow itself is data (a visual editor, a stored config) rather than authored TypeScript:

```ts
import workflowSchema from '@statelyai/agent/agent-workflow.json';
```

```yaml
requests:
  answerQuestion:
    model: openai/gpt-4.1
    system: "Answer the user's question."
    prompt: "{{ input.question }}"
    input:
      type: object
      properties: { question: { type: string } }
      required: [question]
    output:
      type: object
      properties: { answer: { type: string } }
      required: [answer]

initial: thinking
states:
  thinking:
    invoke:
      src: answerQuestion
      input: { question: "{{ context.question }}" }
      onDone:
        target: done
        assign: { answer: "{{ event.output.answer }}" }
  done:
    type: final
```

```ts
const machine = setupAgent.fromConfig(config);
```

Values wrapped as a whole string, like `"{{ context.question }}"`, are typed expressions. The current lowering supports simple dot-path expressions over `input`, `context`, and `event`. JS authoring should use `setupAgent(...)` directly with Zod (or any Standard Schema) rather than this JSON Schema path.

## Alpha status — what's not here yet

This is a pre-release. The following are explicitly **not** shipped, and the API around them may still change:

- **Storage/checkpointer adapters.** No published SQLite/Postgres/Redis packages. Persisting snapshots or event logs is a documented recipe (see the human-in-the-loop section), not a package.
- **Tracing/OTel exporter.** No built-in exporter. Use the `onResult`/`onTransition` observation seams on `runAgent` to build your own.
- **SSE/WebSocket transport.** No shipped transport helpers — host your own stream over whatever `onChunk` gives you.
- **Dynamic-parallelism (Send-style) helpers.** Fan-out/map-reduce is expressed with plain `Promise.all(...)` over host actors today, not a dedicated primitive.
- **Nested-machine executor binding.** `runAgent` only binds executors for the top-level machine's own text/decision sources. A child machine invoked as a nested actor keeps its own `.provide({ actorSources })` binding — see [`examples/langgraph-subflows/index.ts`](examples/langgraph-subflows/index.ts).
- **Visualization tooling.** Out of package scope; Stately Studio and an in-progress VS Code extension own diagramming and inspection.

If something here blocks you, or the API surface feels wrong, open an issue — this alpha is explicitly for finding that out before 2.0 stable.

## Examples

<!-- curated examples index, from examples/README.md and examples/*/metadata.json -->

Examples live under [`examples/`](examples), one flat directory per example, run with `node --import tsx examples/<name>/index.ts`.

Start here:

- [`examples/twenty-questions/index.ts`](examples/twenty-questions/index.ts) — decisions, guard-enforced legality, idle-first HITL
- [`examples/joke/index.ts`](examples/joke/index.ts) — minimal streaming text workflow
- [`examples/email-drafter/index.ts`](examples/email-drafter/index.ts) — parts-based messages, reusable text logic, typed state/transition meta
- [`examples/game-agent/index.ts`](examples/game-agent/index.ts) — `allowedEvents` narrowed as a function of input

Human-in-the-loop and persistence:

- [`examples/langgraph-human-in-the-loop/index.ts`](examples/langgraph-human-in-the-loop/index.ts)
- [`examples/langgraph-snapshot-persistence/index.ts`](examples/langgraph-snapshot-persistence/index.ts)

Host adapters and the step path:

- [`examples/ai-sdk-host/index.ts`](examples/ai-sdk-host/index.ts), [`examples/ai-sdk-game-host/index.ts`](examples/ai-sdk-game-host/index.ts)
- [`examples/tanstack-ai-host/index.ts`](examples/tanstack-ai-host/index.ts), [`examples/cloudflare-workers-ai-host/index.ts`](examples/cloudflare-workers-ai-host/index.ts), [`examples/cloudflare-agent-host/index.ts`](examples/cloudflare-agent-host/index.ts)

Sub-agents and multi-machine composition:

- [`examples/xstate-sub-agents/index.ts`](examples/xstate-sub-agents/index.ts), [`examples/ai-sdk-sub-agents/index.ts`](examples/ai-sdk-sub-agents/index.ts), [`examples/debate-sub-agents/index.ts`](examples/debate-sub-agents/index.ts), [`examples/langgraph-subflows/index.ts`](examples/langgraph-subflows/index.ts)

Framework comparisons and parity tracking: [`docs/langgraph-parity.md`](docs/langgraph-parity.md), [`docs/langgraph-gaps.md`](docs/langgraph-gaps.md), [`docs/burr-parity.md`](docs/burr-parity.md), [`docs/crewai-parity.md`](docs/crewai-parity.md), and the full index in [`examples/README.md`](examples/README.md).

**Read the documentation: [stately.ai/docs/agents](https://stately.ai/docs/agents)**
