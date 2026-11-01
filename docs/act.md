---
title: Acting on events
description: Let the model send any number of the current state's accepted events in one tool loop, each answered with what it changed.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

`agent.act` is a builtin invoke that runs one `generateText` request with a host-side tool loop. Its tools are the invoking state's accepted events, plus any plain `tools`. The loop may make multiple provider model calls. The model calls the tools in any order, zero or more times, and each call is delivered to the machine.

- `agent.decide` sends exactly one event per decision. See [Decisions](decisions.md).
- `agent.act` sends zero to many events, and sees the result of each one before it calls the next.

## Invoking `agent.act`

```ts
import { createAgentSchemas, setupAgent } from "@statelyai/agent";
import { z } from "zod";

const agent = setupAgent({
  schemas: createAgentSchemas({
    context: z.object({ items: z.array(z.string()), note: z.string() }),
    events: {
      ADD: z.object({ item: z.string() }),
      CHECKOUT: z.object({}),
      APPROVE: z.object({}),
    },
  }),
});

agent.createMachine({
  context: { items: [], note: "" },
  initial: "shopping",
  states: {
    shopping: {
      invoke: {
        src: "agent.act",
        input: { model: "quick", prompt: "Add milk and eggs, then check out." },
        // Runs when the loop ends while `shopping` is still active.
        onDone: ({ context, event }) => ({
          target: "idle",
          context: { ...context, note: String(event.output) },
        }),
      },
      on: {
        ADD: ({ context, event }) => ({
          context: { ...context, items: [...context.items, event.item] },
        }),
        CHECKOUT: ({ context }) => (context.items.length > 0 ? { target: "paid" } : undefined),
        // A person sends APPROVE, so the model is not offered it.
        APPROVE: { target: "paid", meta: { actor: "human" } },
      },
    },
    idle: {},
    paid: { type: "final" },
  },
});
```

The model sees two tools, one for `ADD` and one for `CHECKOUT`. It calls `ADD` twice and `CHECKOUT` once. `CHECKOUT` moves the machine to `paid`, so the loop stops and `onDone` does not run.

## Input

| Field                                                                                 | Description                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `model`                                                                               | Model ref. Required.                                                                              |
| `name`                                                                                | Semantic request identity. Defaults to the invoke id.                                             |
| `system`, `prompt`, `messages`                                                        | Same as a text request. See [Text requests](text-requests.md).                                    |
| `allowedEvents`                                                                       | Event types offered as tools, intersected with what the state accepts. Omitted means all of them. |
| `tools`                                                                               | Plain tools offered beside the event tools. See [Tools](tools.md).                                |
| `maxSteps`                                                                            | Bound on the host's tool loop. Default `DEFAULT_ACT_MAX_STEPS` (20).                              |
| `temperature`, `maxOutputTokens`, `topP`, `topK`, `seed`, `stopSequences`, `metadata` | Passed through to the request.                                                                    |

## Event tools

- Each accepted event becomes one tool. The tool name is the event's tool name, and its input is the event's payload schema.
- Events tagged `meta: { actor: "human" }` are never offered. See [Events a person sends](decisions.md#events-a-person-sends).
- Calls run one at a time, in call order, even when the host runs tools concurrently.
- A payload that fails the event's schema answers with the validation error. Nothing is sent.
- An event the current snapshot does not accept answers `'<type>' is not allowed in state <value>`. Nothing is sent.
- An accepted event is sent to the machine. The call waits for the transition to commit, then answers with a delta: `{ state }` when the state value changed, and `changed` with each context key that changed (values truncated to 120 characters).

## When the loop ends

- The model stops calling tools, or the loop reaches `maxSteps`: the invoke completes with the final text as `event.output`.
- The invoking state exits, for example because an event targeted another state: every later call answers `ACT_STATE_EXITED` (`"state exited; stopped"`), the executor's signal aborts, and the invoke reports nothing.

## Execution

- `agent.act` runs on the `generateText` executor, as one text request carrying the event tools. Any adapter with a host-side tool loop runs it. See [Hosts](hosts.md).
- Usage, the model-call budget, and traces count it like any text request. See [Usage and budgets](usage-and-budgets.md).
- Events it sends are journaled like any delivered event, in delivery order. See [The event log](event-log.md).
- `lintAgentMachine` reports `decide-allows-human-event` when its literal `allowedEvents` names a human-tagged event.

> **Warning:** An act loop does not resume mid-flight. After a crash, the events it already sent replay from the journal, and if the invoking state is still active the invoke restarts with a fresh model call.

## Related

- [Decisions](decisions.md)
- [Tools](tools.md)
- [Hosts](hosts.md)
