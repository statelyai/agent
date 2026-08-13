---
title: Tools
description: Define tools, attach them to a text request, and let the host run the tool loop while the machine stays in one state.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Tools belong to a request, not to a machine state. The machine decides when a request runs. The model picks which tools to call. The host executes them. The machine does not see the intermediate tool calls.

<!-- viz: data-flow figure of the tool loop: machine invokes a tool-carrying request -> host executor runs model/tool turns up to maxSteps -> final output validated -> single onDone transition back in the machine -->

## The tool contract

<!-- AgentTool/AgentToolDescriptor from src/types.ts -->

`AgentTool` is a minimal structural contract, so tools from any SDK work without changes:

| Field           | Type                                 | Meaning                                          |
| --------------- | ------------------------------------ | ------------------------------------------------ |
| `description?`  | `string`                             | What the model reads to decide whether to call.  |
| `inputSchema?`  | Standard Schema or any schema object | Arguments contract.                              |
| `outputSchema?` | Standard Schema or any schema object | Result contract, when the host wants one.        |
| `execute?`      | `(...args) => unknown`               | The implementation the host runs.                |
| anything else   | `unknown`                            | Passed through untouched (`providerOptions`, …). |

- A bare function is shorthand for `execute`, typed as `AgentToolExecute`.
- `AgentTools` is `Record<string, AgentTool | undefined>`, keyed by tool name.
- `inputSchema` is widened to `object` so an SDK-native tool assigns without a cast. Core reads it as a Standard Schema when it can.

A native AI SDK tool owns its input typing, so the argument to `execute` needs no cast:

```ts
import { tool } from "ai";
import { z } from "zod";

const calculate = tool({
  description: "Do arithmetic on two numbers.",
  inputSchema: z.object({ op: z.enum(["add", "multiply"]), a: z.number(), b: z.number() }),
  execute: async ({ op, a, b }) => ({ value: op === "add" ? a + b : a * b }), // typed
});
```

Without an SDK, a plain object is enough. Core reads `description` and `inputSchema`, then runs `execute`:

```ts
const calculate = {
  description: "Do arithmetic on two numbers.",
  inputSchema: z.object({ op: z.enum(["add", "multiply"]), a: z.number(), b: z.number() }),
  execute: async (input: unknown) => {
    const { op, a, b } = input as { op: "add" | "multiply"; a: number; b: number };
    return { value: op === "add" ? a + b : a * b };
  },
};
```

## Attaching tools to a request

Put `tools` on any [text request](text-requests.md), either inline in `setupAgent({ requests })` or on a standalone `createTextLogic`.

- `maxSteps` is a typed field on the request. It bounds the host-side tool loop. Without it, the request is single-step.
- `toolChoice` constrains selection. It accepts `'auto'`, `'none'`, `'required'`, or `{ type: 'tool', name }`.

```ts no-check
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";
import { defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

const models = defineModels({ assistant: openai("gpt-5.4-mini") });

const agentSetup = setupAgent({
  models,
  context: z.object({ query: z.string(), finalAnswer: z.string().nullable() }),
  input: z.object({ query: z.string() }),
  output: z.object({ finalAnswer: z.string() }),
  requests: {
    answer: {
      schemas: { input: z.object({ query: z.string() }), output: z.string() },
      model: "assistant",
      system: "Answer in one sentence. Use calculate for arithmetic.",
      prompt: ({ input }) => input.query,
      tools: { calculate },
      maxSteps: 5,
    },
  },
});

export const toolCallingMachine = agentSetup.createMachine({
  id: "tool-calling",
  context: ({ input }) => ({ query: input.query, finalAnswer: null }),
  initial: "answering",
  states: {
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({ target: "done", context: { finalAnswer: output } }),
      },
    },
    done: { type: "final", output: ({ context }) => ({ finalAnswer: context.finalAnswer ?? "" }) },
  },
});
```

Run the machine with any executor set. The machine is the same for scripted and real models.

```ts
import { runAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const result = await runAgent(toolCallingMachine, {
  input: { query: "What is 42 times 17?" },
  executors: createAiSdkExecutors({ models }),
});
```

For the full version, with three real tools and progress reported through `onTransition`, see [examples/tool-calling/index.ts](../examples/tool-calling/index.ts).

## Execution flow through the host

<!-- toAiSdkTools / maxStepsSetting from src/ai-sdk/mappers.ts and src/ai-sdk/index.ts -->

1. The machine invokes the request. Core lowers it to an `AgentTextRequest` carrying `tools`, `toolChoice`, and `metadata`.
2. The executor maps tools to its SDK. `createAiSdkExecutors` passes a native `tool({...})` through unchanged and wraps a plain descriptor or bare function in `tool()`. A tool with no `inputSchema` gets a permissive one.
3. `maxSteps` becomes `stopWhen: stepCountIs(maxSteps)`. The loop runs entirely inside the executor. The adapter still reads `metadata.maxSteps` as a fallback for requests written before `maxSteps` was typed, and the typed field wins.
4. The final output is validated against the request's output schema and returned to `onDone`.

Two consequences follow:

- Tool-carrying requests do not retry. The AI SDK adapter retries invalid structured output only when the request has no tools, because a tool loop may already have caused side effects.
- `metadata` is host-owned. A host that does not understand a key ignores it, so requests stay portable.

The raw executor result, including tool calls and results, reaches host code through `runAgent`'s `onResult(request, { raw })` and the `request.end` trace event. See [Observability](observability.md).

## Tool results in messages

<!-- message model from src/types.ts and src/utils.ts -->

The message model includes tool parts, so a conversation that contains tool traffic is stored as plain machine context:

- `ToolCallPart`: `{ type: 'tool-call', toolCallId, toolName, input }`.
- `ToolResultPart`: `{ type: 'tool-result', toolCallId, toolName, output }`, where `output` is `{ type: 'text' | 'json' | 'error-text' | 'error-json' | 'content', value }`.
- A `tool`-role message carries only tool-result parts. Build one with `toolMessage(...)`.

```ts
import { appendMessages, toolMessage } from "@statelyai/agent";

const recordToolResult = appendMessages([
  toolMessage([
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "calculate",
      output: { type: "json", value: { value: 714 } },
    },
  ]),
]);
```

Build these parts by hand only when the machine owns the loop, such as in a ReAct-style machine or when replaying a transcript. With a host-run tool loop, the intermediate calls stay inside the executor. See [Messages](messages.md).

## Presets and ejecting

`createToolLoopMachine` from `@statelyai/agent/machines` is a prebuilt version of the machine above: one `answering` state and one tool-carrying request. See [Preset machines](machines-presets.md) for its options, including `maxSteps`.

Eject from the preset when the tool loop needs machine states of its own:

- To model approval as machine states, with approve, edit, and reject steps that persist and resume, eject to [examples/review-tool-calls](../examples/review-tool-calls/index.ts).
- To model each think, act, and observe turn as its own transition, see [examples/react-agent](../examples/react-agent/index.ts).

> **Note:** There is no built-in MCP client and no built-in tool-approval gate. MCP discovery, auth, and transport are the host's responsibility. Pass the discovered tool descriptors into `tools` like any other tool. See [Scope](scope.md).

## Related

- Read more about [Text requests](text-requests.md), the request a tool attaches to, including structured and streaming output.
- Read more about [Hosts](hosts.md), including executors, model aliases, and writing your own adapter.
- Read more about [Messages](messages.md), the message model that tool parts live in.
- Read more about [Preset machines](machines-presets.md), including `createToolLoopMachine`.
