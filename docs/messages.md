---
title: Messages
description: Build and store conversation history as a parts-based message model that mirrors the AI SDK without depending on it.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## The message model

<!-- AgentMessage union and part types from src/types.ts -->

This page covers the message model, the builder helpers, and how to store and persist conversation history.

An `AgentMessage` is a parts-based discriminated union that represents one conversation turn. It structurally mirrors the Vercel AI SDK's `ModelMessage`, but core does not depend on the `ai` package. Build messages, store them in machine context, and pass them to a [text request](text-requests.md) or [decision](decisions.md) through the `messages` field.

```ts
type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;
```

The `content` field is a string or an array of typed parts, depending on `role`:

| `role` | `content` |
| ------ | --------- |
| `system` | A string. |
| `user` | A string, or an array of `TextPart`, `ImagePart`, and `FilePart` parts. |
| `assistant` | A string, or an array of `TextPart`, `FilePart`, `ToolCallPart`, and `ToolResultPart` parts. |
| `tool` | An array of `ToolResultPart`. |

`ImagePart` and `FilePart` can hold binary data or a `URL` instance, neither of which is JSON-serializable. See [Persisting messages](#persisting-messages).

## Message builders

<!-- message builder helpers from src/utils.ts -->

Build each role with its helper:

```ts
import { assistantMessage, systemMessage, userMessage } from "@statelyai/agent";

const messages = [
  systemMessage("You draft concise emails."),
  userMessage("Draft a launch email."),
  assistantMessage("Here is a first draft: ..."),
];
```

Both `userMessage` and `assistantMessage` also accept a parts array for multimodal content:

```ts
userMessage([
  { type: "text", text: "What is in this image?" },
  { type: "image", image: "https://example.com/photo.png" },
]);
```

The `toolMessage(parts)` helper builds a `role: "tool"` message from `ToolResultPart` values. Each tool result follows the assistant message whose `ToolCallPart` invoked it. Use `toolMessage` to seed `runAgent({ messages })` with a prior conversation in which tools ran, or to append tool results from a custom host:

```ts
const messages = [
  userMessage("What is the weather in Paris?"),
  assistantMessage([
    { type: "tool-call", toolCallId: "call_1", toolName: "getWeather", input: { city: "Paris" } },
  ]),
  toolMessage([
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "getWeather",
      output: { type: "json", value: { tempC: 18 } },
    },
  ]),
];
```

## Store messages in context

Messages are plain context state. Declare the `messages` field with `z.custom<AgentMessage[]>` and append to it over transitions:

```ts
import { setupAgent, type AgentMessage } from "@statelyai/agent";
import { z } from "zod";

const agentSetup = setupAgent({
  context: z.object({
    prompt: z.string(),
    messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
  }),
});
```

`z.custom` keeps the exact `AgentMessage[]` type at author time and performs a shallow runtime check. That check is enough when the array is built from the helpers above. Use the root `messagesSchema` export for messages that arrive from outside your process.

Append with `appendMessages`, which returns a transition result that adds one or more messages. Pass a message, an array, or a function of `{ context, event }`:

```ts no-check
import { appendMessages, userMessage } from '@statelyai/agent';

// inside a state
on: {
  USER_REPLIED: appendMessages(({ event }) => userMessage(event.text)),
}
```

`appendMessages` is a pure helper. It returns a `{ context, event } => { context }` function and mutates nothing, so it fits anywhere a transition function fits, and it needs only a `messages: AgentMessage[]` field on context.

A request that needs history sends it through `messages` instead of a bare `prompt`. [examples/email-drafter/agent-logic.ts](../examples/email-drafter/agent-logic.ts) keeps a running `messages` array in context and feeds it to a `createTextLogic` request.

### Validating messages with messagesSchema

`messagesSchema` is a root export typed as `StandardSchemaV1<AgentMessage[]>`. It checks that every message has a known `role` and that `content` is a string or an array of known parts. Use it as a standalone validator on messages that arrive from outside your process, such as an HTTP body, a stored transcript, or a client resume payload:

```ts
import { messagesSchema, type AgentMessage } from "@statelyai/agent";

const result = await messagesSchema["~standard"].validate(await request.json());
if (result.issues) {
  throw new Error(result.issues.map((issue: { message: string }) => issue.message).join("; "));
}
const messages: AgentMessage[] = result.value;
```

You can also use `messagesSchema` directly wherever a Standard Schema is accepted, such as a `createAgentSchemas` pack field or a `createTextLogic` input schema.

Never nest `messagesSchema` inside a `z.object`. It is a Standard Schema value, not a Zod type, so Zod infers the field as `unknown`. Use the `z.custom<AgentMessage[]>` recipe above for a context field.

## Persisting messages

> **Warning:** `ImagePart` and `FilePart` can carry binary data as a `Uint8Array` or `ArrayBuffer`, or a `URL` instance. None of these are JSON-serializable. When you persist machine context that contains messages, store binary content as base64 strings and URLs as strings. The library does not convert them for you.

Everything else in a message is plain JSON. A history built from strings, base64, and URL strings survives a snapshot round-trip. See [Human in the loop](human-in-the-loop.md) for the persistence flow this applies to.
