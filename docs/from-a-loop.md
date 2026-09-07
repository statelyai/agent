---
title: Migrating from a hand-rolled loop
description: Convert a while-loop tool-calling agent into an agent machine one step at a time.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page refactors a working `while`-loop agent into an agent machine without rewriting your model calls. Your SDK calls, tools, and retry logic become the [executors](hosts.md). The machine replaces only the control flow.

The call site stays one line. Where you had this:

```ts no-check
const result = await generateText({ model, prompt, tools });
```

you end with this:

```ts
const result = await runAgentLoop(machine, { input, executors, onIdle });
```

The `generateText` call still exists. It moves into the executors, and the loop around it becomes the machine. The result carries `result.output`, the live `result.snapshot`, native `result.persist()`, and aggregated `result.usage`.

For the design work behind this refactor, read [Thinking in state machines](thinking-in-state-machines.md). It covers how to find the states in a loop before you write any of them down.

## Starting point: a hand-rolled loop

The starting point is a support agent written as a `while` loop against an SDK. It has the shape most real loops have: the model calls one tool freely, and it proposes one action that a human must approve first.

```ts
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const emailSchema = z.object({ to: z.string(), subject: z.string(), body: z.string() });

const search = tool({
  description: "Search the support knowledge base.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ results: [`top doc for ${query}`] }),
});

const sendEmail = tool({
  description: "Send an email to the customer.",
  inputSchema: emailSchema,
  execute: async ({ to }) => ({ sent: true, id: `msg_${to}` }),
});

async function runSupportAgent(request: string, approve: (draft: unknown) => Promise<boolean>) {
  const messages: any[] = [{ role: "user", content: request }];
  let sent = false;
  let steps = 0;

  while (true) {
    if (steps++ >= 8) return { sent, stopped: "step-limit" };

    const { toolCalls, text } = await generateText({
      // Model IDs here are illustrative; substitute your provider's current models.
      model: openai("gpt-5.4-mini"),
      messages,
      tools: { search, sendEmail },
    });
    if (!toolCalls?.length) return { sent, reply: text };

    for (const call of toolCalls) {
      if (call.toolName === "sendEmail") {
        if (!(await approve(call.input))) return { sent, pending: true }; // loop state is lost here
        sent = true;
      }
      // push the tool result onto messages, continue the loop
    }
  }
}
```

This loop has three problems:

- Nothing stops `sendEmail` from running before the model has searched.
- The approval rule is an `if` statement inside the tool switch, so a prompt can steer around the branch that reaches it.
- The human pause returns `{ pending: true }` and discards the loop's state, so the run cannot resume.

## Step 1: implicit phases as explicit states

The loop has phases: answering with tools, deciding what to do next, waiting on a human, then sending. Name each phase as a state. Declare the schemas and the setup with `setupAgent`.

A tool the machine must gate is not a tool any more. It becomes an actor the machine invokes, written with XState's `createAsyncLogic`.

```ts
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";
import { defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

const models = defineModels({ quick: openai("gpt-5.4-mini") });

const emailSchema = z.object({ to: z.string(), subject: z.string(), body: z.string() });

// The loop's sendEmail implementation, unchanged, wrapped as an actor.
const sendEmailActor = createAsyncLogic({
  schemas: { input: emailSchema, output: z.object({ id: z.string() }) },
  run: async ({ input }): Promise<{ id: string }> => ({ id: `msg_${input.to}` }),
});

const agentSetup = setupAgent({
  models,
  actors: { sendEmail: sendEmailActor },
  context: z.object({
    request: z.string(),
    reply: z.string(),
    draft: emailSchema.nullable(),
    sent: z.boolean(),
  }),
  input: z.object({ request: z.string() }),
  output: z.object({ sent: z.boolean(), reply: z.string() }),
  events: {
    SEND_EMAIL: emailSchema,
    DONE: z.object({ reply: z.string() }),
    APPROVE: {}, // {} is shorthand for a payload-less event
    REJECT: {},
  },
});
```

`createAsyncLogic` takes `{ schemas, run }`. Annotate `run`'s return type when it resolves an array or another literal; the schema type parameters are `const`, so an unannotated array literal infers as a readonly tuple.

The phases become the states `assisting`, `deciding`, `awaitingApproval`, `sending`, and `finished`.

<!-- viz: support machine: assisting (text request with the search tool) -> deciding (agent.decide) -> awaitingApproval (SEND_EMAIL) -> sending (APPROVE) -> finished / finished (DONE or REJECT) -->

## Step 2: free tools stay tools, the gated action becomes a decision

A converted loop splits its tools in two, and the split is the whole refactor:

| In the loop                    | In the machine                                                          |
| ------------------------------ | ----------------------------------------------------------------------- |
| A tool with no side effect you gate | Stays a tool on a [text request](text-requests.md). The host runs the tool loop inside one state. |
| A tool a human or a rule must approve | Becomes an event the model proposes through `agent.decide`, plus a state that invokes the real work. |

`search` is the first kind. It stays in `tools` on the `assist` request, and `maxSteps` carries the loop's step cap. The machine stays in `assisting` for every search turn and sees one `onDone`.

`sendEmail` is the second kind. The model no longer calls it; it proposes a `SEND_EMAIL` event carrying the draft, and the machine decides what happens next. `sendEmail` cannot run before approval, because the only state that invokes it is entered from `APPROVE`.

```ts
const agentSetup = setupAgent({
  models,
  actors: { sendEmail: sendEmailActor },
  context: z.object({
    request: z.string(),
    reply: z.string(),
    draft: emailSchema.nullable(),
    sent: z.boolean(),
  }),
  input: z.object({ request: z.string() }),
  output: z.object({ sent: z.boolean(), reply: z.string() }),
  events: {
    SEND_EMAIL: emailSchema,
    DONE: z.object({ reply: z.string() }),
    APPROVE: {},
    REJECT: {},
  },
  requests: {
    assist: {
      model: "quick",
      schemas: { input: z.object({ request: z.string() }), output: z.string() },
      system: "You are a support agent. Search the docs before you answer.",
      prompt: ({ input }) => input.request,
      tools: { search }, // the loop's tool, unchanged
      maxSteps: 8, // the loop's step counter, unchanged
    },
  },
});

const machine = agentSetup.createMachine({
  context: ({ input }) => ({ request: input.request, reply: "", draft: null, sent: false }),
  initial: "assisting",
  states: {
    assisting: {
      invoke: {
        src: "assist",
        input: ({ context }) => ({ request: context.request }),
        onDone: ({ output }) => ({ target: "deciding", context: { reply: output } }),
      },
    },
    deciding: {
      invoke: {
        // Name the decision. Scripts and traces key on this id.
        id: "chooseAction",
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          system: "Reply directly, or send the customer an email.",
          prompt: `Draft so far: ${context.reply}`,
          allowedEvents: ["SEND_EMAIL", "DONE"], // an unknown name is a compile error
        }),
      },
      on: {
        SEND_EMAIL: ({ event }) => ({
          target: "awaitingApproval",
          context: { draft: { to: event.to, subject: event.subject, body: event.body } },
        }),
        DONE: ({ event }) => ({ target: "finished", context: { reply: event.reply } }),
      },
    },
    // ...
  },
});
```

A tool-carrying request and a decision are two different states. The request is one model call that may run many tool turns inside the host. The decision is one model call that returns exactly one event the current state accepts.

Rules that were `if` statements can move into the transition instead of a separate state. A transition function that returns `undefined` rejects the choice, and the decision retries with typed feedback. See [transitions](machines.md#transitions) and [Decisions](decisions.md).

## Step 3: the pause as an idle state

The loop's `return { pending: true }` becomes a waiting state with no invoke. `runAgent` settles as `idle` in that state instead of discarding the run. The snapshot is plain JSON, so you can persist it anywhere.

```ts no-check
    // ...
    awaitingApproval: {
      // No invoke: the run settles { status: 'idle', snapshot } here.
      meta: {
        interaction: {
          // Paths are relative to context: `{draft.to}`, not `{context.draft.to}`.
          label: 'Send this email to {draft.to}?',
          events: {
            APPROVE: { label: 'Send', style: 'primary' },
            REJECT: { label: 'Discard', style: 'danger' },
          },
        },
      },
      on: {
        APPROVE: { target: 'sending' },
        REJECT: { target: 'finished' },
      },
    },
    sending: {
      invoke: {
        src: 'sendEmail',
        input: ({ context }) => context.draft!,
        onDone: () => ({ target: 'finished', context: { sent: true } }),
      },
    },
    finished: {
      type: 'final',
      output: ({ context }) => ({ sent: context.sent, reply: context.reply }),
    },
    // ...
```

The `meta.interaction` block is what a host renders for the pause. Declare `meta: interactionMetaSchema` on `setupAgent` to have it typechecked. See [Human in the loop](human-in-the-loop.md).

## Step 4: the run with `runAgentLoop`

The loop ran N turns, so its replacement is `runAgentLoop`. It calls `runAgent`, hands each idle snapshot to `onIdle`, and resumes with the event you return. Returning nothing ends the run. Your existing approval callback becomes the body of `onIdle`.

```ts
import { runAgentLoop } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const executors = createAiSdkExecutors({ models });

const result = await runAgentLoop(machine, {
  input: { request: "Refund my duplicate charge" },
  executors,
  onIdle: async ({ snapshot }) =>
    (await approve(snapshot.context.draft)) ? { type: "APPROVE" } : { type: "REJECT" },
});

if (result.status === "done") console.log(result.output); // { sent: true, reply: '...' }
```

For a single leg that hands the pause back to a caller, use `runAgent` and resume it later. This is the form an HTTP handler wants, because the pause outlives the request.

```ts
const result = await runAgent(machine, { input: { request: "Refund my duplicate charge" }, executors });

if (result.status === "idle") {
  const wire = JSON.stringify(result.persist()); // stored by your DB or queue
  const restored = JSON.parse(wire); // read in a fresh process, with no live objects

  const resumed = await runAgent(machine, {
    snapshot: restored,
    event: { type: "APPROVE" },
    executors,
  });
  if (resumed.status === "done") console.log(resumed.output);
}
```

<!-- viz: resume flow: runAgent settles idle -> persisted snapshot -> JSON in a store -> new process parses -> runAgent(snapshot, event) -> done -->

See [Choosing a run mode](choosing-a-run-mode.md) for the full set. The executors hold your existing model code:

- The `createAiSdkExecutors` adapter wraps the AI SDK.
- The `generateText` and `streamText` slots also accept the raw AI SDK functions. Another SDK or a raw `fetch` works the same way.
- The tools, retry logic, and provider calls you already wrote move across unchanged.

Only the `while` loop is removed. See [Hosts](hosts.md).

## Existing server integration

The machine is host-agnostic, so it runs wherever your loop ran. For a request handler that runs straight through and owns its own actor, bind the executors with `provideExecutors` and run a plain XState actor instead of `runAgent`.

```ts no-check
import { createActor } from "xstate";
import { provideExecutors } from "@statelyai/agent";

app.post("/support", async (req, res) => {
  const actor = createActor(provideExecutors(machine, executors), {
    input: { request: req.body.request },
  });
  actor.subscribe((s) => {
    if (s.status === "done") res.json(s.output);
  });
  actor.start();
});
```

To handle the human pause over HTTP, persist the snapshot with `runAgent` and resume it on a later request. [Use in any stack](any-stack.md) runs one machine in local, Express, and Cloudflare hosts without machine changes.

## Behavior preservation

Before you ship, pin the new machine's behavior with a deterministic playthrough that uses no model. `simulateAgent` scripts the decisions and traverses the same machine transitions as `runAgent`, with no API key and no network access.

```ts
import { simulateAgent } from "@statelyai/agent";

// The agent must stop for approval instead of sending.
const result = await simulateAgent(machine, {
  input: { request: "Refund my duplicate charge" },
  script: {
    text: { assist: ["Looks like a duplicate charge."] },
    decisions: {
      chooseAction: [{ type: "SEND_EMAIL", to: "a@b.co", subject: "Refund", body: "Done." }],
    },
  },
});
expect(result.status).toBe("idle");
```

Script one entry per decision attempt, including attempts a transition rejects. A rejected decision consumes its entry, and the retry consumes the next one. If a queue runs dry while a request is pending, `simulateAgent` throws an error naming the request's kind, src, and id.

Script keys are request names. A named request is keyed by its `setupAgent` key (`assist`). An inline `agent.decide` has no name, so it is keyed by its invoke `id` (`chooseAction`); without an explicit `id`, that key is a generated state path. `simulateAgent` also accepts the `src` (`agent.decide`) for an inline decision. The `invokes` channel cans the output of any non-model actor.

`explorePaths` enumerates every branch, and `canReach` returns `{ reachable, witness }` for one target state. See [Testing and verification](verify.md).

## Make model work explicit

If an existing machine does not invoke its model work, add an ordinary XState invoke. The state graph should remain the single artifact that says what runs and when; `runAgent` does not interpret descriptions or metadata as hidden requests.

```ts no-check
const machine = existingMachine.provide({ actors: { writeDraft } });

// In the machine config:
drafting: {
  invoke: {
    src: "writeDraft",
    input: ({ context }) => ({ topic: context.topic }),
    onDone: ({ output }) => ({
      target: "reviewing",
      context: { draft: output },
    }),
  },
}
```

The actor can be a normal promise actor or Agent request logic. Prompts may still come from state metadata or an external map, but the invoke remains explicit. This keeps execution visible to XState tooling, persistence, inspection, and tests.

## Related

For what the machine gives you over the loop, see the [overview](index.md).

For a worked version of this conversion, see [retrofit](../examples/retrofit/index.ts). It refactors a tangled loop one step at a time with the behavior pinned by tests, in the order `before.ts`, `step1.ts`, `step2.ts`, `step3.ts`, and `index.ts`.

The same conversion works from shapes other than a `while` loop:

- [plain-xstate](../examples/plain-xstate/index.ts): a standard XState machine driven with no agent-specific setup.
- [todo-nl](../examples/todo-nl/index.ts): natural-language commands mapped onto machine events.
- [Coming from LangGraph](langgraph-comparison.md): the same conversion from a `StateGraph`.
- [Thinking in state machines](thinking-in-state-machines.md): the design tutorial behind this refactor, worked through on one triage agent.
