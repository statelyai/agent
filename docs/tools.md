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
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

const models = { assistant: openai("gpt-6-luna") };

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
        onDone: ({ output }) => ({ target: "done", context: { finalAnswer: output.result } }),
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
  executors: createAiSdkExecutors({ models }),
  input: { query: "What is 42 times 17?" },
});
```

For approval and progress around real tools, see [review-tool-calls](https://github.com/statelyai/agent/blob/next/examples/review-tool-calls/index.ts).

## Execution flow through the host

<!-- toAiSdkTools / maxStepsSetting from src/ai-sdk/mappers.ts and src/ai-sdk/index.ts -->

1. The machine invokes the request. Core lowers it to an `AgentTextRequest` carrying `tools`, `toolChoice`, and `metadata`.
2. The executor maps tools to its SDK. `createAiSdkExecutors` passes a native `tool({...})` through unchanged and wraps a plain descriptor or bare function in `tool()`. A tool with no `inputSchema` gets a permissive one.
3. `maxSteps` becomes `stopWhen: stepCountIs(maxSteps)`. The loop runs entirely inside the executor.
4. The final output is validated against the request's output schema and returned to `onDone` as `output.result`, next to the executor's response messages in `output.messages`.

The machine observes the request boundary, not each intermediate tool call. For
example, `maxSteps: 5` permits up to five AI SDK-controlled steps before the
machine receives `onDone`. Model individual calls as states when the machine
must approve, persist, retry, or reject them separately.

Two consequences follow:

- Tool-carrying requests do not retry. The AI SDK adapter retries invalid structured output only when the request has no tools, because a tool loop may already have caused side effects.
- `metadata` is host-owned. A host that does not understand a key ignores it, so requests stay portable.

The raw executor result, including tool calls and results, reaches host code through `runAgent`'s `onResult(request, { raw })` and the `request.end` trace event. See [Observability](observability.md).

## Tool results in messages

<!-- message model from src/types.ts and src/utils.ts -->

Tool calls and results stay in the executor framework's native message objects. A tool-carrying request resolves with them in `output.messages`, and the machine stores them explicitly as context in `onDone`:

```ts no-check
answering: {
  invoke: {
    src: "answer",
    input: ({ context }) => ({ query: context.query }),
    onDone: ({ context, output }) => ({
      target: "done",
      context: {
        finalAnswer: output.result,
        messages: [...context.messages, ...output.messages],
      },
    }),
  },
},
```

Build these parts by hand only when the machine owns the loop, such as in a ReAct-style machine or when replaying a transcript. With a host-run tool loop, the intermediate calls stay inside the executor. See [Messages](messages.md).

## Beyond one request

Model the tool loop as machine states when it needs states of its own:

- To approve or deny each of a turn's tool calls before it runs, model approval as states. See [Approval gate](#approval-gate).
- To approve, edit, or reject one proposed call, with a model redo on reject, start from [examples/review-tool-calls](https://github.com/statelyai/agent/blob/next/examples/review-tool-calls/index.ts).
- To model each think, act, and observe turn as its own transition, use explicit request, tool, and observation states.

> **Note:** There is no built-in MCP client. MCP discovery, auth, and transport are the host's responsibility. Pass the discovered tool descriptors into `tools` like any other tool. See [Scope](scope.md).

## Approval gate

Approval is not a library feature. It is a state that waits for a person's event, plus a rule check in context. [examples/approve-tool-calls](https://github.com/statelyai/agent/blob/next/examples/approve-tool-calls/index.ts) gates one model turn's tool calls this way:

- **Calls and rules in context.** The proposed calls, a `cursor`, and the approve-always rules persist with the snapshot.
- **Proposal order.** `next` is a choice state over the call at `cursor`. A rule that matches the call runs it; otherwise the machine waits in `reviewing`.
- **Events a person sends.** `APPROVE`, `APPROVE_ALWAYS`, and `DENY` are tagged `meta: { actor: "human" }`, so no model-facing decision offers them. `reviewing` declares a `meta.interaction`, so `runAgent` settles `idle` there.
- **Narrow rules.** `APPROVE_ALWAYS` stores the call's tool and arguments. A later call, in this batch or a later one, matches only with the same tool and the same arguments. Key order in the arguments does not matter.

```ts no-check
next: {
  type: "choice",
  choice: ({ context }) => {
    const call = context.calls[context.cursor];
    if (!call) return { target: "done" };
    if (context.rules.some((rule) => ruleMatches(rule, call))) return { target: "running" };
    return { target: "reviewing" };
  },
},
reviewing: {
  meta: { interaction: { label: describeCall, events: { APPROVE: "Approve", APPROVE_ALWAYS: "Always", DENY: "Deny" } } },
  on: {
    APPROVE: { target: "running", meta: { actor: "human" } },
    APPROVE_ALWAYS: {
      target: "running",
      meta: { actor: "human" },
      context: ({ context }) => ({ rules: [...context.rules, toRule(context.calls[context.cursor])] }),
    },
    DENY: { target: "next", meta: { actor: "human" }, context: ({ context }) => denied(context) },
  },
},
running: {
  invoke: {
    src: "runTool",
    input: ({ context }) => ({ call: context.calls[context.cursor] }),
    // Advance past the call, so a rule it just created does not run it again.
    onDone: ({ context, output }) => ({ target: "next", context: executed(context, output) }),
    onError: ({ context, event }) => ({ target: "next", context: failed(context, event.error) }),
  },
},
```

`denied`, `executed`, and `failed` append the call's result and advance `cursor`. The example spells them out.

The run loop resumes the persisted snapshot with each answer:

```ts no-check
let result = await runAgent(approveToolCallsMachine, { input: { calls, rules }, actors: { runTool } });
while (result.status === "idle") {
  // preserveWhitespace keeps argument values exact in the prompt.
  const event = await askPerson(getInteraction(result.snapshot, { preserveWhitespace: true })); // your approval UI
  result = await runAgent(approveToolCallsMachine, { snapshot: result.persist(), event, actors: { runTool } });
}
```

Prove the safety rule with `canReach`. With only `DENY` available to the host, the call that no rule covers never runs:

```ts no-check
const result = await canReach(approveToolCallsMachine, wipeRuns, {
  input: { calls: [npmTest, wipe], rules: [{ tool: "runCommand", args: { cmd: "npm test" } }] },
  outputs: { runTool: ["ok"] },
  hostEvents: ["DENY"],
  payloads: () => ({ DENY: [{}, { reason: "no" }] }),
});
// { reachable: false, complete: true }
```

Copy the example and change what your domain needs: run approved calls concurrently, widen a rule to a glob or a command prefix, or add an edit step. Rerun the proof after each change. A rule matched by tool name alone fails it.

### AI SDK `needsApproval`

A tool with `needsApproval: true` comes back from `generateText` unexecuted, as a `tool-approval-request` content part. Run those calls through the machine, then answer each request in a `tool` message:

- **Executed.** `tool-approval-response` with `approved: true`, plus the machine's `tool-result`. The SDK skips an approved call that already has a result, so it does not run twice.
- **Denied.** `tool-approval-response` with `approved: false`. The SDK reports it to the model as denied.
- **Failed.** `approved: true` plus an `error-text` tool result.

```ts no-check
import { generateText, type ModelMessage } from "ai";

/** A plain JSON value. A `Date`, `Set`, `Map`, `BigInt`, `-0`, or cycle has no exact JSON form. */
function isJson(value: unknown, parents: object[] = []): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || parents.includes(value)) return false;
  const inner = [...parents, value];
  if (Array.isArray(value)) return Array.from(value).every((item) => isJson(item, inner));
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((item) => isJson(item, inner))
  );
}

async function answerApprovals(messages: ModelMessage[]) {
  const first = await generateText({ model, tools, messages });
  const requests = first.content.filter((part) => part.type === "tool-approval-request");
  // No call waits for a person: hand `first` to your usual tool loop.
  if (requests.length === 0) return first;

  // 1. Map the unexecuted calls to the machine input. A person approves the
  //    arguments, and a rule matches them later, so they must be exact. A call
  //    whose parsed input is not a plain JSON object (an input schema turned
  //    a string into a `Date` or a `Set`, say, or the input is `null` or an
  //    array) stays out of the machine, and step 3 answers it as failed.
  const argsOf = (input: unknown) => (input === undefined ? {} : input);
  const calls = requests
    .filter(({ toolCall }) => {
      const args = argsOf(toolCall.input);
      return typeof args === "object" && args !== null && !Array.isArray(args) && isJson(args);
    })
    .map(({ toolCall }) => ({
      id: toolCall.toolCallId,
      tool: toolCall.toolName,
      args: argsOf(toolCall.input),
    }));

  // 2. Run the approval loop above with a runTool actor that calls
  //    tools[call.tool].execute(call.args, { toolCallId: call.id, messages }),
  //    passing the execution options the SDK would pass.

  // 3. Answer every request in one tool message, matching each result by call
  //    id. An executed result goes through the tool's own `toModelOutput`, as
  //    the SDK does when it runs a tool.
  const results = new Map(result.output.results.map((entry) => [entry.id, entry]));
  const content = [];
  for (const { approvalId, toolCall } of requests) {
    const entry = results.get(toolCall.toolCallId) ?? {
      status: "failed",
      reason: "input is not plain JSON",
    };
    const approved = entry.status !== "denied";
    content.push({ type: "tool-approval-response", approvalId, approved, reason: entry.reason });
    if (!approved) continue;
    const toModelOutput = tools[toolCall.toolName]?.toModelOutput;
    content.push({
      type: "tool-result",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output:
        entry.status === "failed"
          ? { type: "error-text", value: entry.reason }
          : toModelOutput
            ? await toModelOutput({
                toolCallId: toolCall.toolCallId,
                input: toolCall.input,
                output: entry.value,
              })
            : // The SDK's default: the output as a JSON value (a `Date` becomes a string).
              { type: "json", value: JSON.parse(JSON.stringify(entry.value ?? null)) },
    });
  }
  const toolMessage: ModelMessage = { role: "tool", content };
  return generateText({
    model,
    tools,
    messages: [...messages, ...first.response.messages, toolMessage],
  });
}
```

Persist `result.output.rules` and pass them as `rules` in the next turn's input.

A host that can restart while a call waits for approval stores the snapshot, `requests`, and `first.response.messages` together, and resumes the approval loop from them. The tool message needs `requests` and the messages. The snapshot's `results` hold each tool's raw output, which `toModelOutput` reads, so the serializer must keep non-JSON outputs (a `Date`, a `BigInt`), or `runTool` must return JSON.

## Related

- Read more about [Text requests](text-requests.md), the request a tool attaches to, including structured and streaming output.
- Read more about [Hosts](hosts.md), including executors, model aliases, and writing your own adapter.
- Read more about [Messages](messages.md), the message model that tool parts live in.
- Read more about [Human in the loop](human-in-the-loop.md), including interaction metadata and payload choices.
