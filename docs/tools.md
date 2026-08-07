---
title: Tools
description: Define tools, attach them to a text request, and let the host run the tool loop while the machine stays in one state.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Tools belong to a **request**, not to machine states. The machine decides _when_ a request runs; the model picks which tools to call; the host executes them. The machine never sees the intermediate calls.

## The tool contract

<!-- AgentTool/AgentToolDescriptor from src/types.ts -->

`AgentTool` is a minimal structural contract, so tools from any SDK drop in unchanged:

| Field           | Type                                 | Meaning                                          |
| --------------- | ------------------------------------ | ------------------------------------------------ |
| `description?`  | `string`                             | What the model reads to decide whether to call.  |
| `inputSchema?`  | Standard Schema or any schema object | Arguments contract.                              |
| `outputSchema?` | Standard Schema or any schema object | Result contract, when the host wants one.        |
| `execute?`      | `(...args) => unknown`               | The implementation the host runs.                |
| anything else   | `unknown`                            | Passed through untouched (`providerOptions`, …). |

- A bare function is shorthand for `execute` (`AgentToolExecute`).
- `AgentTools` is `Record<string, AgentTool | undefined>`, keyed by tool name.
- `inputSchema` is deliberately widened to `object` so an SDK-native tool assigns with no cast. Core reads it as a Standard Schema when it can.

A native AI SDK tool owns its input typing, so `execute`'s argument needs no cast:

```ts
import { tool } from "ai";
import { z } from "zod";

const calculate = tool({
  description: "Do arithmetic on two numbers.",
  inputSchema: z.object({ op: z.enum(["add", "multiply"]), a: z.number(), b: z.number() }),
  execute: async ({ op, a, b }) => ({ value: op === "add" ? a + b : a * b }), // typed
});
```

With no SDK, a plain object is enough. Core reads `description`/`inputSchema` and runs `execute`:

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

Put `tools` on any [text request](text-requests.md), inline in `setupAgent({ requests })` or on a standalone `createTextLogic`. `metadata.maxSteps` bounds the host-side tool loop; without it the request is single-step. `toolChoice` (`'auto' | 'none' | 'required' | { type: 'tool', name }`) constrains selection.

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
      metadata: { maxSteps: 5 }, // bounds the host-side loop
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

Run it with any executor set; the machine is unchanged between scripted and real models.

```ts
import { runAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const result = await runAgent(toolCallingMachine, {
  input: { query: "What is 42 times 17?" },
  executors: createAiSdkExecutors({ models }),
});
```

Full version, with three real tools and progress via `onTransition`: [examples/tool-calling/index.ts](../examples/tool-calling/index.ts).

## Execution flow through the host

<!-- toAiSdkTools / maxStepsSetting from src/ai-sdk/mappers.ts and src/ai-sdk/index.ts -->

1. The machine invokes the request; core lowers it to an `AgentTextRequest` carrying `tools`, `toolChoice`, and `metadata`.
2. The executor maps tools to its SDK. `createAiSdkExecutors` passes a native `tool({...})` through unchanged and wraps a plain descriptor or bare function in `tool()`; a tool with no `inputSchema` gets a permissive one.
3. `metadata.maxSteps` becomes `stopWhen: stepCountIs(maxSteps)`. The loop runs entirely inside the executor.
4. The final output is validated against the request's output schema and returned to `onDone`.

Two consequences worth knowing:

- **Tool-carrying requests do not retry.** The AI SDK adapter retries invalid structured output only when the request has no tools, since a tool loop may already have caused side effects.
- **`metadata` is host-owned.** A host that does not understand a key ignores it, so requests stay portable.

The raw executor result (tool calls and results included) reaches host code via `runAgent`'s `onResult(request, { raw })` and the `request.end` trace event. See [Observability](observability.md).

## Tool results in messages

<!-- message model from src/types.ts and src/utils.ts -->

The portable message model has first-class tool parts, so a conversation that includes tool traffic is plain machine context:

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

You only build these by hand when the machine owns the loop (a ReAct-style machine, or replaying a transcript). With a host-run tool loop, the intermediate calls stay inside the executor. See [Messages](messages.md).

## Presets and ejecting

`createToolLoopMachine` from `@statelyai/agent/machines` is the same shape as the example above, prebuilt: one `answering` state, one request, `maxTurns` lowering to `metadata.maxSteps`.

```ts no-check
import { createToolLoopMachine } from "@statelyai/agent/machines";

const machine = createToolLoopMachine({
  model: "assistant",
  instructions: "Answer using the tools.",
  tools: { calculate },
  maxTurns: 5,
});
```

- `interruptOn: ['sendRefund']` lowers to `metadata.interruptOn`, read only by a host that implements gating. The preset stays a single state and never pauses.
- For approval as real machine states (approve / edit / reject, persistable and resumable), eject to [examples/review-tool-calls](../examples/review-tool-calls/index.ts).
- For each think/act/observe turn as its own transition, see [examples/react-agent](../examples/react-agent/index.ts).

> **Not yet:** there is no built-in MCP client and no built-in tool-approval gate. MCP discovery, auth, and transport are your host's job; pass the discovered tool descriptors into `tools` like any other tool. See [Scope](scope.md).

## Related

- [Text requests](text-requests.md): the request a tool attaches to, and structured/streaming output.
- [Hosts](hosts.md): executors, model aliases, and writing your own adapter.
- [Messages](messages.md): the message model tool parts live in.
- [Preset machines](machines-presets.md): `createToolLoopMachine` and its siblings.
