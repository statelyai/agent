---
title: Thinking in state machines
description: A design tutorial. Take one hand-rolled agent loop, name the states hiding inside it, and turn them into a machine you can test, resume, and inspect.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page shows how to find the states hidden in an agent loop, name them, and write them down as a machine. A typical loop already contains a state machine, spread across a `while` loop, a few booleans, and an `if` ladder.

The example is a support triage agent. It classifies a ticket, drafts a reply, has the reply reviewed, and sometimes hands off to a human.

For the mechanical refactor of an existing codebase, see [Migrating from a hand-rolled loop](from-a-loop.md). This page covers the design work that comes first.

<!-- xstate version requirement from package.json#peerDependencies -->

> **Version requirement.** Build the machine with the `xstate` install this package peers on, v6 alpha.46 or newer. See [Installation](quickstart.md#installation). Machines authored for XState v5 usually port with few changes, but a machine object imported from a separate `xstate@5` install does not bind. Write event-transition guards as functions that return `undefined`. XState v6 drops named string guards on `on`, and the function form is what makes `snapshot.can(event)` reflect the guard.

## The loop to model

The following loop is a working version of the agent.

```ts no-check
async function triage(ticket: string) {
  let category: string | null = null;
  let draft: string | null = null;
  let revisions = 0;
  let escalated = false;

  while (true) {
    if (!category) {
      category = await classify(ticket);
      if (category === "unknown") escalated = true;
    } else if (escalated) {
      const reply = await waitForHumanReply(ticket, draft); // can block for days
      return reply;
    } else if (!draft) {
      draft = await writeReply(ticket, category);
    } else {
      const verdict = await review(draft); // "send" | "revise" | "escalate"
      if (verdict === "send") return draft;
      if (verdict === "escalate") escalated = true;
      if (verdict === "revise") {
        if (revisions >= 2) return draft; // stop revising
        revisions++;
        draft = null;
      }
    }
  }
}
```

The loop is correct, but four things are hard to do with it:

- Testing requires mocking `classify`, `writeReply`, and `review`, and assuming the branch order is right.
- Resuming is not possible. `waitForHumanReply` holds the process open, and the four local variables are not written down anywhere.
- Observing the run requires a `console.log` at every branch, because the loop never names where it is.
- Bounding the work depends on one `revisions >= 2` check that a later edit can bypass.

## The implicit states

Read the loop again and ask what the agent is in the middle of at any instant. The answers are the states. They are already in the source, under other names.

| In the loop                          | The state it is really in |
| ------------------------------------ | ------------------------- |
| `!category`                          | `classifying`             |
| `category` set, deciding what's next | `routing`                 |
| `!draft`                             | `drafting`                |
| draft exists, verdict pending        | `reviewing`               |
| `escalated`, blocked in `await`      | `awaitingHuman`           |
| `return draft`                       | `sent` (final)            |

<!-- viz: support triage machine: classifying -> routing (choice) -> drafting -> reviewing -> sending/awaitingHuman, with the REVISE loop back to drafting capped by revisions < 2 -->

Look for the following patterns in any loop:

- A nullable local variable such as `draft` marks a state boundary. Before the value exists and after it exists are different states.
- A boolean flag such as `escalated` is a state named as an adjective.
- A string verdict such as `"send" | "revise" | "escalate"` is an event set.
- A counter compared to a constant such as `revisions >= 2` is a guard.
- A blocking `await` on a person is a wait, not work.

Two states can run the same code and still be different states. `drafting` after classification and `drafting` after a revision run the same code, but only the second increments a counter. The loop needs a flag to tell them apart. The machine tells them apart by which transition arrived.

## States as prompts

Each state that calls the model owns one prompt. The model does one of two things: it produces a value, or it chooses an event. `classify` and `writeReply` produce values, so they become text logic, and the prompt sits next to the state that uses it.

```ts no-check
const classifyTicket = createTextLogic({
  schemas: { input: z.object({ ticket: z.string() }), output: z.string() },
  model: "triage",
  system: "Classify the ticket as billing, technical, or unknown. Output one word.",
  prompt: ({ input }) => input.ticket,
});
```

The `classifying` state invokes this logic. Its `onDone` sets where the value lands and which state comes next. Keep one prompt per state. A prompt that describes three jobs at once can do the wrong one.

## Transitions as legal moves

In the loop, `review` returned a string and the loop branched on it. In the machine, the model chooses an event from a list the machine supplies, and the transition is the branch.

```ts no-check
reviewing: {
  invoke: {
    src: 'agent.decide',
    input: ({ context }) => ({
      model: 'reviewer',
      system: 'Review the drafted reply. SEND it, ask to REVISE, or ESCALATE to a human.',
      prompt: `Ticket:\n${context.ticket}\n\nDraft:\n${context.draft}`,
      allowedEvents: ['SEND', 'REVISE', 'ESCALATE'],
    }),
  },
  on: {
    SEND: { target: 'sending' },
    ESCALATE: { target: 'awaitingHuman' },
    REVISE: { target: 'drafting' },
  },
},
```

A returned string can hold any value, and every caller has to validate it. A chosen event is checked against the snapshot before it takes effect, so an event the state does not accept never happens. See [Decisions](decisions.md).

## Guards as policy

`revisions >= 2` was a rule inside a branch. As a guard, it becomes part of the graph, and it applies to the model rather than being described to it.

Write event transitions as functions that return `undefined` when the move is illegal.

```ts no-check
// Wrong: the cap lives in the prompt.
system: 'Ask to REVISE at most twice.',

// Right: the cap is a transition.
REVISE: ({ context, event }) =>
  context.revisions < 2
    ? { target: 'drafting', context: { note: event.note, revisions: context.revisions + 1 } }
    : undefined,
```

Returning `undefined` has an effect on the decision. The decision core checks each candidate with `snapshot.can(event)`, records the refusal as `rejected-by-guard`, and asks the model again with the remaining legal moves.

## Idle states as waits

`await waitForHumanReply(...)` holds a process open for work that may take days. If the process dies, everything before that line is lost.

A wait is a state with no invoke and an `on` handler.

```ts no-check
awaitingHuman: {
  on: {
    HUMAN_REPLY: ({ event }) => ({ target: 'sending', context: { draft: event.reply } }),
  },
},
```

When no work is in flight, `runAgent` settles with `{ status: 'idle', snapshot }` instead of hanging. Persist the snapshot and show the person their options. [`getAcceptedEvents(snapshot)`](human-in-the-loop.md) lists the legal events. To resume later, in the same process or another one, pass the snapshot back with the event. See [Human in the loop](human-in-the-loop.md).

## The finished machine

The machine below makes the same four model calls and applies the same policy as the loop, without the flags. The `routing` state uses `type: "choice"`, which resolves its branch immediately, without an event or a model call. See [Choice states](machines.md#choice-states).

```ts
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createTextLogic, runAgent, setupAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

// Model IDs here are illustrative; substitute your provider's current models.
const models = defineModels({
  triage: openai("gpt-5.4-mini"),
  reviewer: openai("gpt-5.4-mini"),
});

const classifyTicket = createTextLogic({
  schemas: { input: z.object({ ticket: z.string() }), output: z.string() },
  model: "triage",
  system: "Classify the ticket as billing, technical, or unknown. Output one word.",
  prompt: ({ input }) => input.ticket,
});

const writeReply = createTextLogic({
  schemas: {
    input: z.object({ ticket: z.string(), category: z.string(), note: z.string() }),
    output: z.string(),
  },
  model: "triage",
  system: "You write support replies. Output only the reply.",
  prompt: ({ input }) =>
    `Ticket (${input.category}):\n${input.ticket}\n\nReviewer note:\n${input.note}`,
});

const agentSetup = setupAgent({
  models,
  context: z.object({
    ticket: z.string(),
    category: z.string().nullable(),
    draft: z.string().nullable(),
    note: z.string(),
    revisions: z.number(),
    via: z.enum(["model", "human"]),
  }),
  events: {
    SEND: {},
    REVISE: z.object({ note: z.string() }),
    ESCALATE: z.object({ reason: z.string() }),
    HUMAN_REPLY: z.object({ reply: z.string() }),
  },
  input: z.object({ ticket: z.string() }),
  output: z.object({ reply: z.string(), via: z.enum(["model", "human"]) }),
  actors: { classifyTicket, writeReply },
});

const triageMachine = agentSetup.createMachine({
  id: "triage",
  context: ({ input }) => ({
    ticket: input.ticket,
    category: null,
    draft: null,
    note: "",
    revisions: 0,
    via: "model" as const,
  }),
  output: ({ context }) => ({ reply: context.draft ?? "", via: context.via }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classifyTicket",
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: ({ output }) => ({ target: "routing", context: { category: output } }),
      },
    },
    // `type: 'choice'` is a library pseudo-state, not native XState.
    routing: {
      type: "choice",
      choice: ({ context }) =>
        context.category === "unknown" ? { target: "awaitingHuman" } : { target: "drafting" },
    },
    drafting: {
      invoke: {
        src: "writeReply",
        input: ({ context }) => ({
          ticket: context.ticket,
          category: context.category ?? "unknown",
          note: context.note,
        }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output } }),
      },
    },
    reviewing: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "reviewer",
          system: "Review the drafted reply. SEND it, ask to REVISE, or ESCALATE to a human.",
          prompt: `Ticket:\n${context.ticket}\n\nDraft:\n${context.draft}`,
          allowedEvents: ["SEND", "REVISE", "ESCALATE"],
        }),
        onError: { target: "awaitingHuman" }, // reached after retries are exhausted
      },
      on: {
        SEND: { target: "sending" },
        ESCALATE: { target: "awaitingHuman" },
        REVISE: ({ context, event }) =>
          context.revisions < 2
            ? {
                target: "drafting",
                context: { note: event.note, revisions: context.revisions + 1 },
              }
            : undefined,
      },
    },
    // No invoke. The run settles as idle here, and you persist the snapshot.
    awaitingHuman: {
      on: {
        HUMAN_REPLY: ({ event }) => ({
          target: "sending",
          context: { draft: event.reply, via: "human" as const },
        }),
      },
    },
    sending: { type: "final" },
  },
});

const result = await runAgent(triageMachine, {
  input: { ticket: "I was charged twice for March." },
  executors: createAiSdkExecutors({ models }),
});
if (result.status === "done") console.log(result.output.reply);
if (result.status === "idle") console.log("waiting on a human", result.snapshot);
```

Every local variable from the loop is now either context or a state name. The loop's `escalated` flag becomes `output.via`, which records whether the model or a human produced the reply.

The revision cap behaves differently from the loop. The loop returned the current draft once `revisions >= 2`. The machine's guard returns `undefined`, so the third `REVISE` is rejected and the reviewer must choose `SEND` or `ESCALATE` instead. To reproduce the loop's behavior, target `sending` from the rejected branch instead of returning `undefined`.

For what the machine gives you over the loop, see the [overview](index.md).

## Machines you cannot rewrite

The design work above assumes you are writing the machine. Two cases do not require that.

- The machine already exists and contains nothing agent-specific. Any machine whose invokes resolve to values and whose events you can enumerate can be driven. Use [`getAcceptedEvents(snapshot)`](human-in-the-loop.md) for the candidates and call [`resolveDecision`](steps.md#standalone-decision-resolution) gated by `snapshot.can(event)`. See [plain-xstate](../examples/plain-xstate/index.ts).
- The machine has no invokes, and prompts live in state `description` fields, in `meta`, or in an external lookup. It runs unmodified through the `getRequests` option of `runAgent`. See [Retrofit with `getRequests`](from-a-loop.md#retrofit-with-getrequests) and the runnable [described-workflow](../examples/described-workflow/index.ts) example.

Prompts do not have to live in the machine. Remove them, leave bare `src` strings, and bind a separate prompt map through the `actors` option of `runAgent`, which is shorthand for `machine.provide({ actors })`. The graph is the same in both cases, which is what lets a machine round-trip through JSON with `setupAgent.fromConfig`. See [Machines as data](machines-as-data.md).

## Related

- [Migrating from a hand-rolled loop](from-a-loop.md): the same translation applied to a working refund agent, one step at a time.
- [Agent machines](machines.md): the authoring reference for states, requests, and transitions.
- [Decisions](decisions.md): candidate events, retries, and guard rejection.
- [Agent patterns](patterns.md): common shapes this decomposition produces, one runnable file each.
