---
"@statelyai/agent": minor
---

**New `@statelyai/agent/typesafe`: TypeSafe System One (Jev) judgments as machine actors.** `createSystemOneLogic` wraps one `client.systemOne` call as XState async actor logic. Register it under `setupAgent({ actors })`, invoke it by name, and read the typed answers in `onDone`.

```ts
import { noul } from "@typesafe-ai/sdk";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";

const gradeDocuments = createSystemOneLogic({
  state: (input: { question: string; documents: string[] }) => input,
  questions: (input) =>
    Object.fromEntries(
      input.documents.map((_doc, i) => [
        `doc${i}`,
        noul(`Does \`documents[${i}]\` help answer \`question\`?`),
      ]),
    ),
});

// onDone: ({ output }) => output.answers.doc0.noul >= RELEVANCE_THRESHOLD ? ... : ...
```

- `state` and `questions` are functions of the invoke input; `model` is optional. The output is `{ answers, model, usage }`, with `answers` typed from the questions (`choice`, `noul`, `score`).
- `client` is optional. Omitted, a `TypeSafeClient` is built from the environment (`TYPESAFE_API_KEY`) on the first invoke, so a missing key rejects that invoke rather than module load. The run's abort signal is forwarded to the request.
- `@typesafe-ai/sdk` is an optional peer dependency, accepted at `^0.6.0`.
- The examples and the demo now use Jev for classification, grading, relevance, and yes/no checks; text requests stay for anything generative. See docs/typesafe.md.
