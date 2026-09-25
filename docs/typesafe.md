---
title: Judgments with TypeSafe (Jev)
description: Ask classification, grading, relevance, and yes/no questions with a TypeSafe System One model, and branch on the typed answers in a machine.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers when a step is a judgment, the `@statelyai/agent/typesafe` adapter, question design, reading answers, and testing without a key.

## Judgments and generations

A **judgment** is a step whose output is an enum, a boolean, a score in a range, or a list of those, computed over evidence the machine already holds. A **generation** is a step whose output is free text the machine forwards.

- Judgments go to Jev, TypeSafe's System One model. It answers narrow typed questions over explicit state and returns probabilities, not prose. Routing a ticket, grading a document's relevance, scoring a draft, and reading a reviewer's reply as approve or reject are judgments.
- Generations stay [text requests](text-requests.md). Drafting a reply, rewriting a query, answering from documents, and writing a plan are generations.
- Decisions the model makes by choosing a machine event stay on [`agent.decide`](decisions.md). Checks that are pure code stay in code.

## Install

`@typesafe-ai/sdk` is an optional peer dependency.

```sh
pnpm add @typesafe-ai/sdk
```

The SDK client reads `TYPESAFE_API_KEY` from the environment when no key is passed.

## createSystemOneLogic

<!-- adapter surface from src/typesafe/index.ts -->

`createSystemOneLogic` wraps one `client.systemOne` call as XState async actor logic. Register it under `setupAgent({ actors })` and invoke it by name like any other actor.

```ts
import { z } from "zod";
import { choice, noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import { setupAgent } from "@statelyai/agent";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";

/** Route to a team only when Jev is at least this sure; otherwise a human triages. */
export const ROUTING_CONFIDENCE = 0.6;
/** A ticket is flagged urgent when the probability of "blocking" clears this. */
export const URGENT_THRESHOLD = 0.5;

export function createClassifyTicket(client?: TypeSafeClient) {
  return createSystemOneLogic({
    client,
    state: (input: { ticket: string; plan: string }) => ({
      ticket: input.ticket,
      plan: input.plan,
    }),
    questions: () => ({
      team: choice("Which team should handle `ticket`?", {
        billing: "Charges, refunds, invoices, or plan changes.",
        technical: "Errors, outages, or a feature not working as documented.",
        unclear: "`ticket` does not say enough to pick a team.",
      }),
      urgent: noul("Does `ticket` describe a problem blocking the customer right now?"),
    }),
  });
}

const agentSetup = setupAgent({
  context: z.object({
    ticket: z.string(),
    plan: z.string(),
    team: z.string().nullable(),
    urgent: z.boolean(),
  }),
  input: z.object({ ticket: z.string(), plan: z.string() }),
  output: z.object({ team: z.string().nullable(), urgent: z.boolean() }),
  actors: { classifyTicket: createClassifyTicket() },
});

export const triageMachine = agentSetup.createMachine({
  context: ({ input }) => ({ ticket: input.ticket, plan: input.plan, team: null, urgent: false }),
  initial: "classifying",
  states: {
    classifying: {
      invoke: {
        src: "classifyTicket",
        input: ({ context }) => ({ ticket: context.ticket, plan: context.plan }),
        onDone: ({ output }) => {
          const { team, urgent } = output.answers;
          return team.choice !== "unclear" && team.confidence >= ROUTING_CONFIDENCE
            ? {
                target: "routed",
                context: { team: team.choice, urgent: urgent.noul >= URGENT_THRESHOLD },
              }
            : { target: "needsHuman" };
        },
        onError: { target: "needsHuman" },
      },
    },
    routed: {
      type: "final",
      output: ({ context }) => ({ team: context.team, urgent: context.urgent }),
    },
    needsHuman: {
      type: "final",
      output: () => ({ team: null, urgent: false }),
    },
  },
});
```

| Option      | Type                            | Description                                                                                                           |
| ----------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `state`     | `(input) => EntryType`          | The evidence the questions are asked over, from the invoke input. Text, a JSON object, or an array.                   |
| `questions` | `(input) => Questions`          | Questions keyed by the name the answer is read back under. Build them with the SDK's `choice`, `noul`, and `score`.    |
| `model`     | `string`                        | Model name. Defaults to the client's default model (`jev-latest`).                                                   |
| `client`    | `TypeSafeClient`                | The SDK client. Omitted, one is constructed from the environment on the first invoke.                                 |

- Each invoke sends one `systemOne` request. Independent questions over the same state belong in the same call: they run in parallel and cannot see one another's answers.
- When `questions` returns an empty object, such as one `noul` per document over an empty list, the actor resolves with `answers: {}` and zero usage without sending a request or constructing a client.
- The actor's output is `{ answers, model, usage }`. `answers` is typed from the questions, so `output.answers.team.choice` is the union of the `team` labels.
- Without `client`, the client is built when the actor first runs, not when the machine is defined. A missing `TYPESAFE_API_KEY` rejects that invoke with the SDK's `TypeSafeError`, which the invoke's `onError` handles.
- The actor's abort signal is passed to the request. Aborting the run, or leaving the invoking state, cancels the call.

## Question design

- **Named state fields.** Pass the evidence as an object with named fields, such as `{ ticket, plan }` or `{ question, documents }`, and refer to them in instructions by backticked path, such as `` `documents[2]` ``.
- **One narrow judgment per question.** Put the judgment in the instructions and the possible answers in the criteria, each with a concrete description. Include a no-match label, such as `unclear`, when no answer may fit. Order score levels from lowest to highest, each describing a concrete situation.
- **Thresholds as exported constants in a guard.** Jev returns probabilities; the machine decides. Compare them against an exported constant in `onDone` or a guard, such as `ROUTING_CONFIDENCE` above, so a test can drive each branch with a value on either side.

The TypeSafe docs cover question design in depth: [primitives](https://docs.typesafe.ai/primitives.md), [state](https://docs.typesafe.ai/concepts/state.md), and [confidence](https://docs.typesafe.ai/confidence.md).

## Reading answers

<!-- response shapes from @typesafe-ai/sdk (ChoiceResponse, NoulResponse, ScoreResponse) -->

| Question | Answer fields                                | Read in `onDone`                                                                |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| `choice` | `choice`, `confidence`, `probabilities`      | `output.answers.team.choice` is the selected label.                             |
| `noul`   | `noul`                                       | `output.answers.urgent.noul` is the probability of yes, from 0 to 1.            |
| `score`  | `score`, `confidence`, `legend`, `probabilities` | `output.answers.quality.score` is the expected level index; it can fall between levels. |

A `score` question takes its levels as an array, lowest first. The answer's `score` is an expected value over those levels, so compare it with a threshold instead of testing for equality:

```ts
import { score } from "@typesafe-ai/sdk";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";

/** Accept a draft at or above "clear with minor issues". */
export const ACCEPT_SCORE = 2;

const gradeDraft = createSystemOneLogic({
  state: (input: { brief: string; draft: string }) => input,
  questions: () => ({
    quality: score("How well does `draft` meet `brief`?", [
      "Off-topic or missing the requested content.",
      "On-topic but unclear or incomplete.",
      "Clear and complete with minor issues.",
      "Clear, complete, and ready to send.",
    ]),
  }),
});

// In the invoking state:
// onDone: ({ output }) =>
//   output.answers.quality.score >= ACCEPT_SCORE ? { target: "done" } : { target: "revising" },
```

## Testing with a fake fetch

`TypeSafeClient` takes a `fetch` option. A client built over a scripted `fetch` runs the SDK's own request building and response parsing against canned answers, with no key and no network. Pass it through `runAgent({ actors })` to replace the registered default.

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { runAgent } from "@statelyai/agent";
import { expect, test } from "vitest";

const jev = new TypeSafeClient({
  apiKey: "test-key",
  retry: { maxRetries: 0 },
  fetch: async (_url, init) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    return Response.json({
      model,
      answers: {
        team: {
          type: "choice",
          choice: "billing",
          confidence: 0.9,
          probabilities: { billing: 0.9, technical: 0.05, unclear: 0.05 },
        },
        urgent: { type: "noul", noul: 0.2 },
      },
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  },
});

test("routes a double charge to billing", async () => {
  const result = await runAgent(triageMachine, {
    input: { ticket: "I was charged twice this month.", plan: "pro" },
    actors: { classifyTicket: createClassifyTicket(jev) },
  });

  expect(result.status === "done" && result.output).toEqual({ team: "billing", urgent: false });
});
```

Record the parsed request bodies inside the fake `fetch` to assert on the state and questions the machine sent.

## Example

[examples/corrective-rag](../examples/corrective-rag/index.ts) grades retrieved documents with one `noul` per document in a single call, keeps the ones that clear `RELEVANCE_THRESHOLD`, and routes to a query rewrite when none survive. The rewrite and the answer stay text requests.

## Related

- [Text requests](text-requests.md)
- [Decisions](decisions.md)
- [Coming from LangGraph](langgraph-comparison.md)
