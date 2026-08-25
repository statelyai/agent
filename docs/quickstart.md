---
title: Quickstart
description: Install @statelyai/agent and run your first agent machine end to end.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page builds an agent piece by piece, from installation to a live model call. For a single copy-paste example, see the [overview](index.md).

## Installation

<!-- pinned alpha install; peers consistent with package.json -->

```bash
pnpm add @statelyai/agent@alpha xstate@alpha zod ai@^7 @ai-sdk/openai@^4
```

- The `@alpha` tag floats. Install it once, then run `npm ls @statelyai/agent` and pin the resolved version, so a later alpha cannot change the API.
- `xstate` is the only required peer dependency, at v6 alpha.46 or newer. Node must be 22.18 or newer.
- Provider packages must match your `ai` major version. `@ai-sdk/openai@^4` pairs with `ai@^7`. A bare `@ai-sdk/openai` resolves to `@latest`, whose `LanguageModel` spec version may not match your `ai` peer.
- The package is ESM-first. Every entry point also ships a CommonJS build, so `require()` works. The examples use top-level `await`, which requires ESM. Set `"type": "module"` in `package.json`, or use `.mts` files.

## First agent

The first agent is a comment moderator. The model reads a comment and picks one of three events. The machine owns the trust threshold that decides whether publishing is legal.

Two functions do the work:

- `setupAgent` declares the schemas and events. `createMachine` authors the control flow from them.
- `createScriptedExecutors` plays back canned answers through the executor contract, so this first version runs end to end without an API key.

<!-- viz: moderation machine: reviewing -> published/flagged/blocked, with the trust >= 50 guard on PUBLISH and the retry back into reviewing when the guard rejects -->

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
  // Comments start flagged.
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
        // Returns undefined below a trust score of 50, which rejects PUBLISH.
        PUBLISH: ({ context }) =>
          context.trust >= 50
            ? { target: "published", context: { outcome: "published" } }
            : undefined,
        FLAG: ({ event }) => ({
          target: "flagged",
          context: { outcome: "flagged", reason: event.reason },
        }),
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
    decisions: [{ type: "PUBLISH" }, { type: "FLAG", reason: "Borderline tone." }],
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

It prints `{ outcome: 'flagged', reason: 'Borderline tone.' }`. The scripted decisions replaced the model calls. The first decision consumes the `PUBLISH` entry, and the trust guard rejects it because the author's trust score is 20. The decision is requested again, consumes the `FLAG` entry, and the machine reaches `flagged`. The guard, the retry, the final state, and the schema-checked output all come from the real machine.

The `model` value is a plain string. The `models` registry is optional and only narrows the type of that string. It is never consulted at run time, and scripted executors ignore it because they route on the request name.

### Real model executors

To call a real model, replace the executors. The machine does not change. Add a `models` registry, which also types the `model` keys, then pass the AI SDK adapter to `runAgent` instead of the script.

```ts no-check
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({ fast: openai("gpt-5.4-mini") });

const agentSetup = setupAgent({
  models,
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

The model now picks the event, and `reason` contains the text it wrote. Keep the scripted executors, because your tests run against them. See [Testing without an API key](#testing-without-an-api-key).

The machine adds three properties that a direct prompt call does not have:

- The model can only pick a legal event. `allowedEvents` is intersected with the events the current state accepts, so the choice set changes as the machine moves.
- A guard can override the model. A `PUBLISH` for a low-trust author is rejected before it changes state, with `failure: 'rejected-by-guard'`, and the decision retries with that feedback. The threshold is defined in one place and a prompt cannot change it.
- The outcome is a state, not a parsed string. Every path ends in a known final state with schema-checked output, and the graph renders as a diagram.

## The `setupAgent` surface

`setupAgent` returns a **setup**, which you author machines from. It is not a running agent. It works like XState's `setup()`. Context, input, output, and event payloads are Standard Schemas, so Zod works directly and the machine's types come from those schemas.

The `model` value is a key into the `models` registry, or any string your [host](hosts.md#typed-model-aliases) resolves at run time.

Every machine can invoke the following built-in actor sources. They are reserved `src` strings. The invoke's `input` shapes each call.

| `src`                | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `agent.generateText` | Inline one-shot text (or structured-output) model call. |
| `agent.streamText`   | Same, streamed chunk by chunk through `onChunk`.        |
| `agent.decide`       | Model picks exactly one currently-legal event.          |
| `agent.userInput`    | Gather human input mid-run without settling.            |

### Named requests

A **request** is a typed, reusable model call. It has named schemas, a model, and a prompt built from its input. Use a request instead of an inline `agent.generateText` when you want to test the call by name.

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

## Running

`runAgent` drives the machine and calls your **executors** whenever the machine needs a model. It settles with one of three statuses.

| Status  | Meaning                                                                          |
| ------- | -------------------------------------------------------------------------------- |
| `done`  | The machine reached a final state. `result.output` matches your output schema.    |
| `idle`  | The machine is waiting on a human. See [Human in the loop](human-in-the-loop.md). |
| `error` | Something threw.                                                                  |

<!-- viz: runAgent lifecycle: start -> model call loop -> settle at done, idle, or error, with idle resuming back into the loop -->

Every status carries `result.events`, a versioned JSON-safe `AgentLogEntry[]` of the replayable external inputs. Each entry records identity, timestamp, machine version, and state and effect hashes. Pass the array to `replay(machine, result.events)` to reconstruct the final snapshot without re-running model or tool calls. Pass `{ verify: 'strict' }` to require every hash to match. See [The event log](event-log.md#export-events-from-runagent).

If a run must reach a final state, use `generateResult(machine, options)` instead. It resolves with the done result: `result.output`, plus `result.snapshot`, replayable `result.events`, and aggregated `result.usage`. It throws `AgentIdleError` if the machine pauses.

### Other ways to run the same machine

`runAgent` is the default, but not the only option. `provideExecutors` binds the executors onto the machine for a plain `createActor`. `runDurableAgent` owns an event-sourced durable loop, while the step path lets your host own that loop and persistence. The machine is identical in all four modes. See [Choosing a run mode](choosing-a-run-mode.md).

### Testing without an API key

`createScriptedExecutors` is the helper the first run used. It holds FIFO queues of scripted answers and consumes one entry per model call. `decisions` feeds `agent.decide`, and `text` feeds every text request.

```ts
import { createScriptedExecutors, generateResult } from "@statelyai/agent";

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

- An entry can be a function of the request, which is useful for branching or looping machines. For example: `(request) => request.name === "moderatorNote" ? … : …`.
- A `PUBLISH` rejected by the guard consumes an entry and retries with the next one, so a script can assert retry behavior.
- If the queue runs out, the executor throws an error naming the pending request.

Executors are plain functions, so you can also write a mock by hand as an object. See [Hosts and executors](hosts.md#scripted-executors). To assert a full playthrough without a run loop, use `simulateAgent`, which walks the step path from a script keyed by `src`. See [Testing and verification](verify.md).

### Live visualization

The [Stately Inspector](https://stately.ai/docs/inspector) is a web UI that draws a running machine as a diagram and highlights each state as the machine enters it. Install `@statelyai/sdk`, create an inspector, and pass its handler to the `inspect` option of `runAgent`. The run opens the diagram in your browser and updates it as the machine runs.

```ts
import { createInspector } from "@statelyai/sdk";

// Uses Stately's hosted relay by default. Pass `url` for a self-hosted relay.
const inspector = createInspector();

await runAgent(moderationMachine, {
  input: { comment: "honestly this update is terrible", trust: 20 },
  executors: createAiSdkExecutors({ models }),
  inspect: inspector.inspect,
});
```

The same machine also renders in [Stately Studio](https://stately.ai/editor) and the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=statelyai.stately-vscode). For production tracing, see [Observability](observability.md).

## Related

- [Agent machines](machines.md): authoring states, transitions, and typed context.
- [Decisions](decisions.md): let the model choose one of several legal machine events.
- [Hosts](hosts.md): model aliases, the AI SDK adapter, and writing your own executors.
- [Choosing a run mode](choosing-a-run-mode.md): `runAgent`, `provideExecutors`, or the step path.
- [Where state lives](persistence.md): the event log, snapshots, and the shipped stores.
