---
title: Quickstart
description: Install @statelyai/agent and run your first agent machine end to end.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Installation

<!-- pinned alpha install; peers consistent with package.json -->

```bash
npm install @statelyai/agent@alpha xstate@alpha zod ai@^6 @ai-sdk/openai@^3
```

- The `@alpha` tag floats. Install it once, then pin what it resolved to (`npm ls @statelyai/agent`) so a later alpha cannot change the API under you.
- `xstate` is the one required peer. The library requires **XState v6 alpha.25 or newer**.
- `ai` (the Vercel AI SDK) and `@ai-sdk/openai` back the shipped adapter, `createAiSdkExecutors`. Core has no runtime dependency besides `xstate`, and the first run below needs neither the adapter nor an API key.
- Provider packages must match your `ai` major. `@ai-sdk/openai@^3` pairs with `ai@^6`; a bare `@ai-sdk/openai` resolves to `@latest`, whose `LanguageModel` spec version may not match your `ai` peer.
- The package is **ESM-first**; every entry also ships a CommonJS build, so `require()` works. The examples use top-level `await`, which needs ESM: set `"type": "module"` in `package.json` (or use `.mts` files).

## Your first agent

A comment moderator. The model reads a comment and picks one of three events; the machine owns the trust threshold that decides whether publishing is even legal.

Two pieces do the work:

- `setupAgent` declares the schemas and events, then `createMachine` authors the control flow from them.
- `createScriptedExecutors` plays back canned answers through the executor contract, so this first version runs end to end with **no API key**.

```ts
import { createScriptedExecutors, runAgent, setupAgent } from "@statelyai/agent";
import { z } from "zod";

const outcomeSchema = z.enum(["published", "flagged", "blocked"]);

const agentSetup = setupAgent({
  context: z.object({
    comment: z.string(),
    trust: z.number(),
    outcome: outcomeSchema,
    reason: z.string().nullable(),
  }),
  input: z.object({ comment: z.string(), trust: z.number() }),
  output: z.object({ outcome: outcomeSchema, reason: z.string().nullable() }),
  events: {
    PUBLISH: {}, // `{}` is shorthand for a payload-less event
    FLAG: z.object({ reason: z.string() }),
    BLOCK: {},
  },
});

const moderationMachine = agentSetup.createMachine({
  // Comments start flagged; only the machine can clear one.
  context: ({ input }) => ({ ...input, outcome: "flagged", reason: null }),
  output: ({ context }) => ({ outcome: context.outcome, reason: context.reason }),
  initial: "reviewing",
  states: {
    reviewing: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "fast",
          system: "PUBLISH harmless comments, FLAG borderline ones with a reason, BLOCK abuse.",
          prompt: `Comment: ${context.comment}\nAuthor trust score: ${context.trust}`,
          allowedEvents: ["PUBLISH", "FLAG", "BLOCK"],
        }),
      },
      on: {
        // The guard owns the threshold, not the model: under 50 this returns
        // undefined, so PUBLISH is illegal and the model has to choose again.
        PUBLISH: ({ context }) =>
          context.trust >= 50
            ? { target: "published", context: { outcome: "published" } }
            : undefined,
        FLAG: ({ event }) => ({ target: "flagged", context: { reason: event.reason } }),
        BLOCK: () => ({ target: "blocked", context: { outcome: "blocked" } }),
      },
    },
    published: { type: "final" },
    flagged: { type: "final" },
    blocked: { type: "final" },
  },
});

const result = await runAgent(moderationMachine, {
  input: { comment: "honestly this update is terrible", trust: 20 },
  executors: createScriptedExecutors({
    decisions: [{ type: "FLAG", reason: "Borderline tone." }],
  }),
});

if (result.status === "done") {
  console.log(result.output); // { outcome: 'flagged', reason: 'Borderline tone.' }
}
```

Save it as `agent.ts` in a project with `"type": "module"` in its `package.json`, then run it:

```bash
npx tsx agent.ts
```

It prints `{ outcome: 'flagged', reason: 'Borderline tone.' }`. The scripted decision took the place of a model call. Everything else (the guard, the retry, the final state, the schema-checked output) is the real machine.

### Real model executors

Swap the executors. The machine does not change: add a `models` registry (which also types the `model:` keys), then hand `runAgent` the AI SDK adapter instead of the script.

```ts no-check
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({ fast: openai("gpt-5.4-mini") });

const agentSetup = setupAgent({
  models, // adds typed `model` keys; everything else is unchanged
  // …the same schemas and events
});

const result = await runAgent(moderationMachine, {
  input: { comment: "honestly this update is terrible", trust: 20 },
  executors: createAiSdkExecutors({ models }),
});
```

```bash
export OPENAI_API_KEY=sk-...
npx tsx agent.ts
```

Now the model picks the event, and `reason` is whatever it wrote. Keep the scripted set around: it is what your tests run against (see [Testing without an API key](#testing-without-an-api-key)).

What the machine does that a prompt call cannot:

- **The model only ever picks a legal event.** `allowedEvents` is intersected with the events the current state actually accepts, so the choice set moves with the machine.
- **A guard can overrule the model.** A `PUBLISH` on a low-trust author is rejected before it reaches state (`failure: 'rejected-by-guard'`) and the decision retries with that feedback. The threshold lives in one place and cannot be prompted away.
- **The outcome is a state, not a parsed string.** Every path ends in a known final state with schema-checked output, and the whole graph renders as a diagram.

## The `setupAgent` surface

`setupAgent` returns a **setup** (not a running agent) you author machines from, like XState's `setup()`. Context, input, output, and event payloads are Standard Schemas, so Zod works directly and the machine's types come from them.

The `model` value is a key into the `models` registry, so registered keys autocomplete. Unregistered strings are still allowed (the host may resolve refs at run time), so a typo surfaces at run time. See [Authoring forms](machines.md#authoring-forms).

Every machine can invoke these built-in actor sources. They are reserved `src` strings; the invoke's `input` shapes each call.

| `src`                | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `agent.generateText` | Inline one-shot text (or structured-output) model call.  |
| `agent.streamText`   | Same, streamed chunk by chunk through `onChunk`.         |
| `agent.decide`       | Model picks exactly one currently-legal event.           |
| `agent.userInput`    | Gather human input mid-run without settling.             |

### Named requests

A **request** is a typed, reusable model call: named schemas, a model, and a prompt built from its input. It is the testable counterpart to an inline `agent.generateText`.

```ts no-check
const agentSetup = setupAgent({
  models,
  // …schemas as above
  requests: {
    moderatorNote: {
      schemas: {
        input: z.object({ comment: z.string() }),
        output: z.object({ note: z.string() }),
      },
      model: "fast",
      prompt: ({ input }) => `Write a one-line moderator note for: ${input.comment}`,
    },
  },
});
```

Each request key becomes an invocable `src`:

```ts no-check
blocked: {
  invoke: {
    src: "moderatorNote",
    input: ({ context }) => ({ comment: context.comment }),
    onDone: ({ output }) => ({ target: "done", context: { reason: output.note } }),
  },
},
```

See [Text requests](text-requests.md) for tools, streaming, and messages.

## Running the machine

`runAgent` drives the machine and calls your **executors** whenever it needs a model. It settles with a `status`:

- `done`: reached a final state; `result.output` matches your output schema.
- `idle`: waiting on a human. See [Human in the loop](human-in-the-loop.md).
- `error`: something threw.

Every variant carries `result.events`, a versioned, JSON-safe `AgentLogEntry[]` of the replayable external inputs (identity, timestamp, machine version, state/effect hashes). Pass it to `replay(machine, result.events)` to reconstruct the final snapshot without re-running model or tool calls; `verifyReplay` requires every hash. See [The event log](event-log.md#export-events-from-runagent).

For a run that must go straight through to a final state, `generateResult(machine, options)` resolves with the done result — `result.output` plus metadata (`result.snapshot`, replayable `result.events`, aggregated `result.usage`), like `generateText`'s `text` + call metadata — and throws `AgentIdleError` if the machine pauses.

### Without `runAgent`

`provideExecutors` binds every agent source in one call, returning a machine you drive with a plain `createActor`. No run loop, no idle settling.

```ts
import { createActor } from "xstate";
import { provideExecutors } from "@statelyai/agent";

const executors = createAiSdkExecutors({ models });
const actor = createActor(provideExecutors(moderationMachine, executors), {
  input: { comment: "honestly this update is terrible", trust: 20 },
});
actor.subscribe((s) => s.status === "done" && console.log(s.output));
actor.start();
```

`agent.userInput` is left unbound (supply it via the third argument, `{ actors }`), and invoked child machines are not descended into. Use `runAgent` for idle handling and child rebinding.

For a **long-lived session** (chat turns, device events, sockets) that should keep `runAgent`'s event log, budgets, and traces without settling-and-restoring every turn, use `createAgentActor` instead: the same engine, but the actor survives idle settles — `session.actor.send(event)` re-opens the cycle and `await session.settled()` resolves at the next quiescence, all on one replayable log.

### Testing without an API key

`createScriptedExecutors` is the same helper the first run used: FIFO queues of scripted answers, one entry consumed per model call. `decisions` feeds `agent.decide`, `text` feeds every text request.

```ts
const executors = createScriptedExecutors({
  decisions: [{ type: "FLAG", reason: "Borderline tone." }],
  text: [{ note: "Repeat offender." }],
});

const result = await generateResult(moderationMachine, {
  input: { comment: "…", trust: 20 },
  executors,
});

expect(result.output).toEqual({ outcome: "flagged", reason: "Borderline tone." });
```

- An entry may be a **function of the request**, for branching or looping machines: `(request) => request.name === "moderatorNote" ? … : …`.
- A `PUBLISH` rejected by the guard consumes an entry and retries with the next one, so scripts assert retry behavior directly.
- Running dry throws an error naming the pending request.

Executors are plain functions, so a hand-written mock is still just an object (`generateText`/`streamText` resolve `{ output }`, `decide` resolves `{ event }`), and each entry on `agentSetup.requests` is a `TextLogic` you can bind individually with `.withExecutor(...)`:

```ts
const testMachine = provideExecutors(
  moderationMachine,
  { decide: async () => ({ event: { type: "FLAG", reason: "Borderline tone." } }) },
  {
    actors: {
      moderatorNote: agentSetup.requests.moderatorNote.withExecutor(async () => ({
        output: { note: "Repeat offender." },
      })),
    },
  },
);

const actor = createActor(testMachine, { input: { comment: "…", trust: 20 } });
actor.subscribe((snapshot) => {
  if (snapshot.status === "done") {
    console.log(snapshot.output); // { outcome: 'flagged', reason: 'Borderline tone.' }
  }
});
actor.start();
```

To assert the whole playthrough without a run loop at all, `simulateAgent` walks the pure step path from a by-`src` script. See [Testing and verification](verify.md).

### Live visualization

The [Stately Inspector](https://stately.ai/docs/inspector) is a web UI that draws a running machine as a diagram and highlights each state as it is entered. Install `@statelyai/sdk`, create an inspector, and pass its handler to `runAgent`'s `inspect` option. The run opens the diagram in your browser and updates it live:

```ts
import { createInspector } from "@statelyai/sdk";

// Uses Stately's hosted relay by default. Pass `url` for a self-hosted relay.
const inspector = createInspector();

await runAgent(moderationMachine, {
  input: { comment: "honestly this update is terrible", trust: 20 },
  executors: createAiSdkExecutors({ models }),
  inspect: inspector.inspect, // opens the diagram and lights it up live
});
```

It is the same machine you authored, so it also renders in [Stately Studio](https://stately.ai/editor) and the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=statelyai.stately-vscode). See [Observability](observability.md) for production tracing.

## Next steps

- [Agent machines](machines.md): authoring states, transitions, and typed context.
- [Decisions](decisions.md): let the model choose one of several legal machine events.
- [Hosts](hosts.md): model aliases, the AI SDK adapter, and writing your own executors.
