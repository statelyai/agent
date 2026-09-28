# Evals

Agent requests are independently executable, while the machine gives them meaningful state and trajectory context.

## Testing without a provider

A test runs the real machine through `runAgent` and replaces only the model. `@statelyai/agent` ships no model mock. There are two ways to replace the model:

- Mock the provider with the AI SDK's `MockLanguageModelV3`. The call still runs through `createAiSdkExecutors`, so the test covers prompt rendering, structured output parsing, and decision tool calls.
- Pass plain functions as executors. The test covers the machine only.

Both examples below run this machine. It drafts an email, then scores the draft with a structured request.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agent = setupAgent({
  input: z.object({ topic: z.string() }),
  context: z.object({ topic: z.string(), draft: z.string(), score: z.number().nullable() }),
  output: z.object({ draft: z.string(), score: z.number().nullable() }),
  requests: {
    draftEmail: {
      model: "writer",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      prompt: ({ input }) => `Write a short email about ${input.topic}.`,
    },
    scoreDraft: {
      model: "judge",
      schemas: {
        input: z.object({ draft: z.string() }),
        output: z.object({ score: z.number() }),
      },
      prompt: ({ input }) => `Score this email from 1 to 5:\n${input.draft}`,
    },
  },
});

const machine = agent.createMachine({
  context: ({ input }) => ({ topic: input.topic, draft: "", score: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "draftEmail",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "scoring", context: { draft: output.result } }),
      },
    },
    scoring: {
      invoke: {
        src: "scoreDraft",
        input: ({ context }) => ({ draft: context.draft }),
        onDone: ({ output }) => ({ target: "done", context: { score: output.result.score } }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ draft: context.draft, score: context.score }),
    },
  },
});
```

### Mock the model

`MockLanguageModelV3` from `ai/test` is the AI SDK's test double for a language model. Put one in the `models` map of `createAiSdkExecutors` under each model key the machine uses.

```ts
import { MockLanguageModelV3 } from "ai/test";
import { runAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

function mockModel(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

const writer = mockModel("Checkout now supports saved cards.");
const judge = mockModel(JSON.stringify({ result: { score: 4 } }));

const result = await runAgent(machine, {
  input: { topic: "saved cards at checkout" },
  executors: createAiSdkExecutors({ models: { writer, judge } }),
});

if (result.status === "done") {
  console.log(result.output); // { draft: "Checkout now supports saved cards.", score: 4 }
}
console.log(judge.doGenerateCalls.length); // 1
```

The mock answers in the provider's format, not the request's:

- A plain-text request takes the text as is.
- A structured request asks the provider for JSON and reads the declared output from a `result` key, so the mock returns `{ "result": … }` as JSON text.
- An `agent.decide` request expects a `tool-call` content part. Its `toolName` is `send_event_<TYPE>` for the chosen event type, and its `input` is the event payload as JSON text.

`doGenerateCalls` records the options of every call, including the prompt the adapter rendered.

### Plain-function executors

An executor is a function of the request. Route on `request.name` to answer each request, and return the output value as `result`.

```ts
import { runAgent } from "@statelyai/agent";

const calls: string[] = [];

const result = await runAgent(machine, {
  input: { topic: "saved cards at checkout" },
  executors: {
    generateText: async (request) => {
      calls.push(request.name ?? "");
      switch (request.name) {
        case "draftEmail":
          return { result: "Checkout now supports saved cards." };
        case "scoreDraft":
          return { result: { score: 4 } };
        default:
          throw new Error(`No answer for request "${request.name}"`);
      }
    },
  },
});

console.log(calls); // ["draftEmail", "scoreDraft"]
```

A `decide` executor routes the same way and returns the chosen event: `decide: async (request) => ({ event: { type: "APPROVE" } })`.

`request.name` is the request's `setupAgent({ requests })` key, the `createTextLogic`/`createDecisionLogic` `name`, or the `name` on an inline `agent.decide` input. Without one, it is the invoke `id`. Route on the name, not on prompt text or call order. A run that takes a different branch then fails with a missing answer instead of receiving an answer meant for another request.

An executor that throws reaches the machine as an ordinary actor error. An invoke that declares `onError` routes it like a model failure.

## Individual request evals

Use `executeAgentRequest` with a request and executor when the eval targets one LLM call. Requests carry their semantic `name` and resolved `input`, so datasets need no prompt sniffing.

## Seam evals

`runSeam` (from `@statelyai/agent/testing`) runs the whole machine with one named request occurrence under test. The seam gets a `candidate` executor, and every other text request is answered from `scripts`. Omit `candidate` to script the seam too. Score its `seamOutput`, `calls`, state path, and XState transition events.

```ts
const run = await runSeam(machine, {
  input: { topic: "saved cards at checkout" },
  scripts: {
    draftEmail: ["Checkout now supports saved cards."],
    scoreDraft: [{ score: 4 }],
  },
  seam: { request: "scoreDraft" },
});

run.seamOutput; // { score: 4 }
run.calls.map((call) => call.source); // ["script", "script"]
```

`runSeam` routes text requests only. For a machine that also decides, pass a `decide` executor through `executors`.

### Script keys

A `scripts` key is a request `name` when `scripts` has a queue under that name. Otherwise it is the request's `model` key. A machine whose requests are named routes by name, and an unnamed one routes by model.

A request's name resolves as described in [Plain-function executors](#plain-function-executors): its declared `name`, else the invoke `id`. Name every request a script answers, so a call with no matching queue throws instead of taking an answer queued for another request.

### Entry shapes

An entry (`SeamScriptEntry`) is the request's **output value**: a bare string for a text request, or the object a structured request declares.

```ts no-check
scripts: {
  answer: ["Because transitions constrain behavior."],
  assess: [{ score: 4, notes: "clear" }]
}
```

An entry is read as an executor result instead only when its own keys are `result` plus, optionally, `messages`, `usage` and `raw`. That is how an entry reports token usage, which `run.seamUsage` reads for the seam call: `{ result: draft, usage: { totalTokens: 120 } }`. A structured request whose declared output is itself `{ result }` needs one more wrap: `{ result: { result: "…" } }`.

An entry may also be a function of the request: `answer: [(request) => "Draft about " + request.prompt]`.

### Order and repetition

Entries for a key are consumed in order. The seam consumes its slot even when `candidate` answers it, so later entries stay aligned with the call plan.

A queue that runs dry throws an `AgentError` with code `seam-script-exhausted`, naming the request. Pass `repeatLast: true` to replay a queue's last entry instead, for a live seam that sends the run down a longer branch.

## Verification

`simulateAgent`, `explorePaths`, `canReach`, and `matchesTrajectory` operate on the machine artifact. Unknown state targets and empty expected trajectories fail loudly instead of producing misleading successful scores.
