---
title: Judgments with the AI SDK
description: Ask classification, grading, relevance, and yes/no questions with the AI SDK's experimental_evaluate and Jev, and branch on the typed answers in a machine.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers when a step is a judgment, calling `experimental_evaluate` from an actor, the question types and their answers, thresholds, TypeSafe confidence, and testing without a key.

## Judgments and generations

A **judgment** is a step whose output is a label, a probability, or a score on a scale, computed over evidence the machine already holds. A **generation** is a step whose output is free text the machine forwards.

- Judgments go to an evaluation model through the AI SDK's `experimental_evaluate`. Jev, TypeSafe's System One model, is one such model: it answers narrow typed questions over explicit state and returns probabilities, not prose. Routing a ticket, grading a document's relevance, scoring a draft, and reading a reviewer's reply as approve or reject are judgments.
- Generations stay [text requests](text-requests.md). Drafting a reply, rewriting a query, answering from documents, and writing a plan are generations.
- Decisions the model makes by choosing a machine event stay on [`agent.decide`](decisions.md). Checks that are pure code stay in code.

`@statelyai/agent` has no judgment API of its own. A judgment is an ordinary XState actor that calls the AI SDK.

## Install

```sh
pnpm add ai @ai-sdk/typesafe-ai
```

`@ai-sdk/typesafe-ai` is the AI SDK's TypeSafe provider. `typeSafeAi.evaluationModel("jev-latest")` reads `TYPESAFE_AI_API_KEY` from the environment when it evaluates, not when the model is created.

## A judgment actor

Wrap one `experimental_evaluate` call in `createAsyncLogic`, register it under `setupAgent({ actors })`, and invoke it by name like any other actor. Take the evaluation model as a parameter so tests and hosts can pass another one.

```ts
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { setupAgent } from "@statelyai/agent";

const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** A ticket is flagged urgent when the probability that it is blocking clears this. */
export const URGENT_THRESHOLD = 0.5;

export function createClassifyTicket(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    {
      answers: {
        team: { choice: "billing" | "technical" | "unclear" };
        urgent: { probability: number };
      };
    },
    { ticket: string; plan: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { ticket: input.ticket, plan: input.plan },
        questions: {
          team: {
            type: "choice",
            instructions: "Which team should handle `ticket`?",
            criteria: {
              billing: "Charges, refunds, invoices, or plan changes.",
              technical: "Errors, outages, or a feature not working as documented.",
              unclear: "`ticket` does not say enough to pick a team.",
            },
          },
          urgent: {
            type: "boolean",
            instructions: "Does `ticket` describe a problem blocking the customer right now?",
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
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
          return team.choice === "unclear"
            ? { target: "needsHuman" }
            : {
                target: "routed",
                context: { team: team.choice, urgent: urgent.probability >= URGENT_THRESHOLD },
              };
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

- Each invoke sends one evaluation request. Independent questions over the same evidence belong in the same call, which answers every question against one shared `state`.
- `experimental_evaluate` rejects an empty `questions` map. When the questions are built from a list that can be empty, such as one boolean question per document, return `{ answers: {} }` without calling it.
- A missing `TYPESAFE_AI_API_KEY` or a failed request rejects the invoke, which the invoke's `onError` handles.
- `signal` is the actor's abort signal. Passing it as `abortSignal` cancels the call when the run is aborted or the machine leaves the invoking state.
- The output type is yours to declare. Narrow it to the fields the machine reads.

## Question types

<!-- question and answer shapes from ai's EvaluationQuestion / EvaluationAnswer (experimental_evaluate) -->

| `type`    | `criteria`                                                        | Answer                       | Read in `onDone`                                                               |
| --------- | ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `choice`  | An object of labels to descriptions, at least one label           | `{ choice, probabilities? }` | `answers.team.choice` is the selected label, typed as the union of the labels. |
| `boolean` | Optional `{ true?, false? }` descriptions                         | `{ probability }`            | `answers.urgent.probability` is the probability of true, from 0 to 1.          |
| `score`   | An array of level descriptions, lowest first, at least two levels | `{ score, probabilities? }`  | `answers.quality.score` is a level index; it can fall between levels.          |

Every question also takes `instructions`. Instructions, criteria descriptions, and `state` accept a string or JSON.

A score's `score` is the probability-weighted mean of its levels when the model returns a distribution, so compare it with a threshold instead of testing for equality. Keep the levels in an exported tuple to render the level text from an index.

```ts
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";

export const QUALITY_LEVELS = [
  "Off-topic or missing the requested content.",
  "On-topic but unclear or incomplete.",
  "Clear and complete with minor issues.",
  "Clear, complete, and ready to send.",
] as const;

/** Accept a draft at or above "Clear and complete with minor issues." */
export const ACCEPT_SCORE = 2;

export function createGradeDraft(model: Experimental_EvaluationModel) {
  return createAsyncLogic<
    { answers: { quality: { score: number } } },
    { brief: string; draft: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { brief: input.brief, draft: input.draft },
        questions: {
          quality: {
            type: "score",
            instructions: "How well does `draft` meet `brief`?",
            criteria: QUALITY_LEVELS,
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

// In the invoking state:
// onDone: ({ output }) =>
//   output.answers.quality.score >= ACCEPT_SCORE ? { target: "done" } : { target: "revising" },
```

## Question design

- **Named state fields.** Pass the evidence as an object with named fields, such as `{ ticket, plan }` or `{ question, documents }`, and refer to them in instructions by backticked path, such as `` `documents[2]` ``.
- **One narrow judgment per question.** Put the judgment in the instructions and the possible answers in the criteria, each with a concrete description. Include a no-match label, such as `unclear`, when no answer may fit. Order score levels from lowest to highest, each describing a concrete situation.
- **Thresholds as exported constants.** The model returns probabilities and scores; the machine decides. Compare them against an exported constant in `onDone` or a guard, such as `URGENT_THRESHOLD` above, so a test can drive each branch with a value on either side.

The TypeSafe docs cover question design in depth: [primitives](https://docs.typesafe.ai/primitives.md), [state](https://docs.typesafe.ai/concepts/state.md), and [confidence](https://docs.typesafe.ai/confidence.md).

## TypeSafe confidence

Jev reports a confidence per question, separate from the answer's probabilities. The AI SDK result carries it in provider metadata at `providerMetadata.typesafe.confidence[questionId]`. Other evaluation models do not report it, so treat a missing value as unsure.

```ts
import { experimental_evaluate as evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";

/** Route only when Jev is at least this sure of the team. */
export const ROUTING_CONFIDENCE = 0.6;

const { answers, providerMetadata } = await evaluate({
  model: typeSafeAi.evaluationModel("jev-latest"),
  state: { ticket: "I was charged twice this month." },
  questions: {
    team: {
      type: "choice",
      instructions: "Which team should handle `ticket`?",
      criteria: { billing: "Charges and refunds.", technical: "Errors and outages." },
    },
  },
});

const reported = (providerMetadata?.typesafe?.confidence as Record<string, unknown> | undefined)
  ?.team;
const confidence = typeof reported === "number" ? reported : 0;
const route = confidence >= ROUTING_CONFIDENCE ? answers.team.choice : "needsHuman";
```

Return the confidence from the actor next to `answers`, such as `{ answers, confidence }`, and compare it against the exported constant in `onDone` or a guard.

## Testing without a key

An evaluation model is any object that implements the AI SDK's evaluation-model spec: `specificationVersion: "v4"`, `provider`, `modelId`, `supportedQuestionTypes`, and `doEvaluate`. An object that answers from a script runs `experimental_evaluate`'s own validation and result shaping, with no key and no network. Pass it to the actor factory and bind the actor through `createAgentRuntime(machine, { actors })` to replace the registered default.

```ts
import type { Experimental_EvaluationModel } from "ai";
import { runToQuiescence } from "@statelyai/agent";
import { expect, test } from "vitest";

const scripted: Experimental_EvaluationModel = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "scripted-judge",
  supportedQuestionTypes: ["choice", "boolean", "score"],
  doEvaluate: async () => ({
    answers: {
      team: { type: "choice", choice: "billing" },
      urgent: { type: "boolean", probability: 0.2 },
    },
    warnings: [],
  }),
};

test("routes a double charge to billing", async () => {
  const result = await runToQuiescence(
    createAgentRuntime(triageMachine, {
      actors: { classifyTicket: createClassifyTicket(scripted) },
    }),
    { input: { ticket: "I was charged twice this month.", plan: "pro" } },
  );

  expect(result.status === "done" && result.output).toEqual({ team: "billing", urgent: false });
});
```

- `doEvaluate` receives `{ state, questions }`. Record them to assert on the evidence and the questions the machine sent. The SDK wraps a plain `state` value in one part, `[{ type: "json", value }]`, so read the machine's value from `state[0].value`.
- To script TypeSafe confidence, return `providerMetadata: { typesafe: { confidence: { team: 0.9 } } }` from `doEvaluate`.
- The AI SDK validates answers: a `choice` must be one of the labels and the most probable one, `probabilities` must sum to 1, and a score with `probabilities` must equal their weighted mean. Omit `probabilities` from scripted answers unless a test needs them.
- The repository's examples share one scripted judge that keys answers by question id; see [examples/mock-judge.ts](../examples/mock-judge.ts).

## Example

[examples/corrective-rag](../examples/corrective-rag/index.ts) grades retrieved documents with one boolean question per document in a single `experimental_evaluate` call, keeps the ones whose probability clears `RELEVANCE_THRESHOLD`, and routes to a query rewrite when none survive. The rewrite and the answer stay text requests.

## Related

- [Text requests](text-requests.md)
- [Decisions](decisions.md)
- [Coming from LangGraph](langgraph-comparison.md)
