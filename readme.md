# Stately Agent

**The logic layer for AI agents.**

Build agents as state machines to control exactly what the agent can do. The machine owns control flow; the model only ever picks a legal event. Testing, inspection, and visualization fall out for free.

Stately Agent adds model requests and decisions to XState. The state machine defines what the agent can do. Your application chooses the model, runs the requests, and stores the state.

Any agent workflow or loop can be modeled as a state machine. Model calls and tools run as effects inside it. The model proposes an event. The machine decides whether it is allowed and what happens next.

Stately Agent 2 is in alpha. APIs may change before the stable release.

[Documentation](https://stately.ai/docs/agents) · [Examples](examples/README.md) · [XState](https://github.com/statelyai/xstate)

## Three ways to start

- **Author a new agent.** Build a machine from states, decisions, and typed requests; run it locally with `runAgent`, test it with no API key, then use it in any framework or runtime with zero machine changes. See the [Quickstart](docs/quickstart.md) and [Use in any stack](docs/any-stack.md).
- **Retrofit an existing agent.** Turn a `while` loop into a machine: your SDK calls, tools, and retry code become the executors; the machine replaces only the control flow. See [Migrating from a loop](docs/from-a-loop.md).
- **Copy a known pattern.** ReAct, reflection, plan-and-execute, RAG, supervisor, and more, each a single runnable file you lift in 60 seconds. See [Agent patterns](docs/patterns.md).

## Install

<!-- install command matching the package prerelease channel and package.json peers -->

```sh
pnpm add @statelyai/agent@alpha xstate@alpha zod ai@^6 @ai-sdk/openai@^3
```

Node 22.18 or newer is required. The package is ESM-first (CommonJS builds are published too, so `require()` works) and requires XState v6 alpha.25 or newer. Provider packages must match your `ai` major: `@ai-sdk/openai@^3` pairs with `ai@^6` (a bare `@ai-sdk/openai` resolves to `@latest`, which can mismatch the `ai` peer).

## Quick start

<!-- refund decision example using setupAgent, agent.decide, a machine guard, and the AI SDK runAgent host -->

This agent reviews refund requests. The model may propose an automatic refund, but the state machine owns the $100 limit.

```ts
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { z } from "zod";

const models = defineModels({
  fast: openai("gpt-5.4-mini"),
});

const agentSetup = setupAgent({
  models,
  context: z.object({
    request: z.string(),
    amount: z.number(),
  }),
  input: z.object({
    request: z.string(),
    amount: z.number(),
  }),
  output: z.object({
    outcome: z.enum(["refunded", "review"]),
  }),
  events: {
    AUTO_REFUND: {},
    REVIEW: z.object({ reason: z.string() }),
  },
});

const refundMachine = agentSetup.createMachine({
  context: ({ input }) => input,
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "fast",
          system: "Choose AUTO_REFUND for eligible requests. Otherwise choose REVIEW.",
          prompt: `${context.request}\nAmount: $${context.amount}`,
          allowedEvents: ["AUTO_REFUND", "REVIEW"],
        }),
      },
      on: {
        AUTO_REFUND: ({ context }) => (context.amount <= 100 ? { target: "refunded" } : undefined),
        REVIEW: { target: "review" },
      },
    },
    refunded: {
      type: "final",
      output: () => ({ outcome: "refunded" }),
    },
    review: {
      type: "final",
      output: () => ({ outcome: "review" }),
    },
  },
});

const result = await runAgent(refundMachine, {
  input: {
    request: "I was charged twice for the same order.",
    amount: 75,
  },
  executors: createAiSdkExecutors({ models }),
});

if (result.status === "done") {
  console.log(result.output);
}
```

When the machine reaches `refunded`, the result is:

```text
{ outcome: 'refunded' }
```

The model chooses between the events allowed in `deciding`. The `AUTO_REFUND` transition only works when the amount is at most $100. If the model chooses it for a larger amount, the guard rejects the choice and the decision is tried again.

## The state machine

<!-- Add the state machine illustration here. -->

The example has one model decision and two final outcomes. Real machines can add approval states, retries, parallel work, child agents, and long-running waits without changing how the control flow is represented.

## Core concepts

<!-- core concepts derived from setupAgent, built-in agent actors, runAgent, and XState snapshots -->

- **Machines own control flow.** States, events, transitions, and guards define what can happen.
- **Models make bounded decisions.** `agent.decide` asks a model to choose one of the events accepted by the current state.
- **Requests are typed.** Inputs, outputs, context, and events use Standard Schema. Zod works out of the box.
- **Your code runs the model.** `runAgent` accepts executor functions. The example uses the Vercel AI SDK adapter, but the machine does not depend on a provider.
- **Snapshots can be stored.** An agent can stop for human input, save its XState snapshot, and resume later in another process.
- **Runs export verified replay entries.** Every `runAgent` result carries a JSON-safe `AgentLogEntry[]` with event identity, timestamp, machine version, and state/effect hashes; pass it to `replay` or `verifyReplay` without repeating model or tool calls.
- **Machines can be checked without model calls.** Lint their structure, simulate scripted decisions, and explore paths without an API key.
- **Agents are XState machines.** Guards, actors, parallel states, inspection, testing, and visualization work as usual.

## Examples

<!-- starter examples derived from examples/*/metadata.json and examples/index.ts -->

- [Twenty Questions](examples/twenty-questions) shows a model choosing legal events in a loop.
- [Go Fish](examples/go-fish) pits a model against a human while the machine enforces hidden-information game rules.
- [Human in the loop](examples/human-in-the-loop) pauses, stores a snapshot, and resumes after review.
- [Ticket triage](examples/triage) returns structured data from a model request.
- [JSON agent](examples/json-agent) runs a machine defined as data.

See [all examples](examples/README.md).

## Learn more

- [Machines](docs/machines.md)
- [Text requests](docs/text-requests.md)
- [Decisions](docs/decisions.md)
- [Human in the loop](docs/human-in-the-loop.md)
- [Testing and verification](docs/verify.md)
- [Hosts and executors](docs/hosts.md)
- [Models and providers](docs/models-and-providers.md)
- [Use in any stack](docs/any-stack.md)
- [The event log](docs/event-log.md)
- [Observability](docs/observability.md)
- [Agent patterns](docs/patterns.md)
- [Migrating from a loop](docs/from-a-loop.md)
