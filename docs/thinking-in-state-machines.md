---
title: Thinking in state machines
description: A design tutorial. Take one hand-rolled agent loop, name the states hiding inside it, and turn them into a machine you can test, resume, and inspect.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

You already have a state machine. It is spread across a `while` loop, a few booleans, an `if` ladder, and a comment that says "don't call this twice". This page teaches the translation: how to find those states, name them, and write them down.

One example carries the whole page: a **support triage agent**. It classifies a ticket, drafts a reply, has the reply reviewed, and sometimes hands off to a human. If you want the mechanical refactor of an existing codebase instead, read [Migrating from a hand-rolled loop](from-a-loop.md); this page is about the design move that comes first.

## The loop to model

Here is the agent as most people write it first. It works.

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
      const reply = await waitForHumanReply(ticket, draft); // blocks. for days.
      return reply;
    } else if (!draft) {
      draft = await writeReply(ticket, category);
    } else {
      const verdict = await review(draft); // "send" | "revise" | "escalate"
      if (verdict === "send") return draft;
      if (verdict === "escalate") escalated = true;
      if (verdict === "revise") {
        if (revisions >= 2) return draft; // give up revising
        revisions++;
        draft = null;
      }
    }
  }
}
```

Nothing here is wrong. But four things about it are hard:

- **Testing** means mocking `classify`, `writeReply`, and `review` and hoping the branch order is right.
- **Resuming** is impossible: `waitForHumanReply` holds the process, and the four locals are not written down anywhere.
- **Observing** it means adding `console.log` at every branch, because the loop never names where it is.
- **Bounding** it lives in one `revisions >= 2` check that a future edit will quietly step around.

## The implicit states

Read the loop again and ignore the code. Ask: **at any instant, what is this agent in the middle of?** The answers are the states, and they are already in the source, wearing disguises.

| In the loop                          | The state it is really in |
| ------------------------------------ | ------------------------- |
| `!category`                          | `classifying`             |
| `category` set, deciding what's next | `routing`                 |
| `!draft`                             | `drafting`                |
| draft exists, verdict pending        | `reviewing`               |
| `escalated`, blocked in `await`      | `awaitingHuman`           |
| `return draft`                       | `sent` (final)            |

The disguises to look for, in any loop:

- **A nullable local** (`draft`) is a state boundary: "before we have it" and "after we have it" are different states.
- **A boolean flag** (`escalated`) is a state you named as an adjective.
- **A string verdict** (`"send" | "revise" | "escalate"`) is an event set.
- **A counter compared to a constant** (`revisions >= 2`) is a guard.
- **A blocking `await` on a person** is not work at all. It is a wait.

Two states can look identical and still be different states. `drafting` after classification and `drafting` after a revision run the same code, but only the second one increments a counter. Where the loop needed a flag to tell them apart, the machine tells them apart by which transition arrived.

## Modeling move 1: states as prompts

Each state that calls the model owns exactly one prompt. The model only ever does two things: **produce a value** or **choose an event**. `classify` and `writeReply` produce values, so they become text logic, with the prompt sitting next to the state that uses it.

```ts no-check
const classifyTicket = createTextLogic({
  schemas: { input: z.object({ ticket: z.string() }), output: z.string() },
  model: "triage",
  system: "Classify the ticket as billing, technical, or unknown. Output one word.",
  prompt: ({ input }) => input.ticket,
});
```

The `classifying` state invokes it, and its `onDone` says where the value lands and which state comes next. One prompt per state is the constraint that pays. A prompt that has to describe three jobs is a prompt that will do the wrong one; three states with one prompt each cannot.

## Modeling move 2: transitions as legal moves

`review` returned a string that the loop then branched on. In the machine, the model does not return a string to branch on. It **chooses an event**, from a list the machine hands it, and the transition is the branch:

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

The difference from a string verdict is enforcement. A returned string can be anything, and every caller re-validates it. A chosen event is checked against the snapshot before it takes effect: an event the state does not accept never happens. See [Decisions](decisions.md).

## Modeling move 3: guards as policy

`revisions >= 2` was a rule buried inside a branch. As a guard it becomes part of the graph, which means the model is subject to it rather than asked about it.

Write event transitions as functions returning `undefined` when the move is illegal:

```ts no-check
// Wrong: the cap lives in the prompt, so the model can talk its way past it.
system: 'Ask to REVISE at most twice.',

// Right: the cap is a transition, so REVISE stops being an available move.
REVISE: ({ context, event }) =>
  context.revisions < 2
    ? { target: 'drafting', context: { note: event.note, revisions: context.revisions + 1 } }
    : undefined,
```

Returning `undefined` does real work. The decision core checks each candidate with `snapshot.can(event)`, records the refusal as `rejected-by-guard`, and asks the model again with the remaining legal moves. **The machine's guards constrain the model.** That is the whole point.

## Modeling move 4: idle states as waits

`await waitForHumanReply(...)` was the worst line in the loop: it holds a process open for something that may take days, and everything before it is lost if the process dies.

A wait is not work. It is a state with no invoke and an `on:` handler:

```ts no-check
awaitingHuman: {
  on: {
    HUMAN_REPLY: ({ event }) => ({ target: 'sending', context: { draft: event.reply } }),
  },
},
```

When nothing is in flight, `runAgent` settles `{ status: 'idle', snapshot }` instead of hanging. Persist the snapshot, show the human their options (`getAcceptedEvents(snapshot)` lists exactly the legal ones), and resume later, in another process, by handing the snapshot back with the event. See [Human in the loop](human-in-the-loop.md).

## The finished machine

Same four model calls, same policy, no flags.

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
  }),
  events: {
    SEND: {},
    REVISE: z.object({ note: z.string() }),
    ESCALATE: z.object({ reason: z.string() }),
    HUMAN_REPLY: z.object({ reply: z.string() }),
  },
  input: z.object({ ticket: z.string() }),
  output: z.object({ reply: z.string() }),
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
  }),
  output: ({ context }) => ({ reply: context.draft ?? "" }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classifyTicket",
        input: ({ context }) => ({ ticket: context.ticket }),
        onDone: ({ output }) => ({ target: "routing", context: { category: output } }),
      },
    },
    // Deterministic, no model. `type: 'choice'` is a library pseudo-state
    // (not native XState): it resolves its `choice` branch immediately, no event.
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
        onError: { target: "awaitingHuman" }, // out of retries: let a person decide
      },
      on: {
        SEND: { target: "sending" },
        ESCALATE: { target: "awaitingHuman" },
        // The cap is a transition, not a prompt: past 2, REVISE is not a legal move.
        REVISE: ({ context, event }) =>
          context.revisions < 2
            ? {
                target: "drafting",
                context: { note: event.note, revisions: context.revisions + 1 },
              }
            : undefined,
      },
    },
    // No invoke: the wait is a state, and the snapshot is what you persist.
    awaitingHuman: {
      on: {
        HUMAN_REPLY: ({ event }) => ({ target: "sending", context: { draft: event.reply } }),
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

Every local from the loop is now either context or a state name, and the four hard things from the top are gone.

## What the machine bought you

- **Testing without a model.** `createScriptedExecutors` replays canned answers with no key and no network; `simulateAgent` walks the pure step path and returns the `trail` of every step taken; `lintAgentMachine` catches unreachable states and empty decisions with no run at all. See [Testing and verification](verify.md).
- **Resume that cannot re-run work.** A resumed snapshot starts _at_ the idle state, so `classify` and `writeReply` run exactly once however many times you resume. See [Human in the loop](human-in-the-loop.md).
- **Replay from a log.** The ordered external inputs are the durable state; folding them back through the machine reconstructs the run exactly. See [The event log](event-log.md).
- **Observability by name.** `onTrace` gives one ordered ledger of requests, transitions, and emits, and the [Stately Inspector](observability.md) highlights the diagram live. States have names now, so traces do too.
- **Bounds you cannot step around.** Guards, `maxModelCalls`, and per-run token budgets are enforced outside the prompt. See [Usage and budgets](usage-and-budgets.md).
- **A loop you can own.** When a durable host needs one model call per log append, hand the machine to the step path instead of `runAgent`: `getAgentEffects` lowers the pending work, you resolve one effect, append it, and fold it back with xstate's pure `transition`. Same machine, zero changes. See [The step path](steps.md).

## When you cannot rewrite the machine

The design move above assumes you are writing the machine. Two cases where you are not:

- **A machine that already exists**, with no agent-specific anything: any machine whose invokes resolve to values and whose events you can enumerate is drivable. Use `getAcceptedEvents(snapshot)` for the candidates and `resolveDecision` gated by `snapshot.can(event)`. See [plain-xstate](../examples/plain-xstate/index.ts).
- **A machine with no invokes at all**, where prompts live in state `description`s, `meta`, or an external lookup. It runs unmodified through `runAgent`'s `getRequests` option: [Retrofit with `getRequests`](from-a-loop.md#retrofit-with-getrequests), runnable in [described-workflow](../examples/described-workflow/index.ts).

Prompts also do not have to live in the machine: strip them out, leave bare `src` strings, and bind a separate prompt map through `runAgent`'s `actors` option (shorthand for `machine.provide({ actors })`). The graph is identical either way, which is what lets a machine round-trip through JSON via `setupAgent.fromConfig`. See [Machines as data](machines-as-data.md).

> **One version requirement.** The machine must be built with the `xstate` install this package peers on (v6 alpha.25 or newer). Machines authored for XState v5 usually port with little change, but a machine object imported from a separate `xstate@5` install will not bind. Write event-transition guards as functions returning `undefined`; v6 drops named string guards on `on:` in favor of this form, and that is what makes `snapshot.can(event)` reflect the guard.

## Related

- [Migrating from a hand-rolled loop](from-a-loop.md): the same translation applied mechanically to a working refund agent, one shippable step at a time.
- [Agent machines](machines.md): the full authoring reference for states, requests, and transitions.
- [Decisions](decisions.md): candidate events, retries, and guard rejection.
- [Agent patterns](patterns.md): the shapes this decomposition tends to produce, one runnable file each.
