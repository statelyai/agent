---
title: Messages
description: Build and store conversation history as a parts-based message model that mirrors the AI SDK without depending on it.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## The message model

<!-- AgentMessage union and part types from src/types.ts -->

`AgentMessage` is a parts-based, discriminated union representing one conversation turn. It structurally mirrors the Vercel AI SDK's `ModelMessage`, but core has no dependency on `ai`. Build messages, store them in machine context, and pass them to a [text request](text-requests.md) or [decision](decisions.md) through the `messages` field.

```ts
type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;
```

`content` is a string or an array of typed parts, depending on `role`:

- **`system`**: a string.
- **`user`**: a string, or `TextPart` / `ImagePart` / `FilePart` parts.
- **`assistant`**: a string, or `TextPart` / `FilePart` / `ToolCallPart` / `ToolResultPart` parts.
- **`tool`**: an array of `ToolResultPart`.

## Build messages

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

`userMessage` and `assistantMessage` also accept a parts array for multimodal content:

```ts
userMessage([
  { type: "text", text: "What is in this image?" },
  { type: "image", image: "https://example.com/photo.png" },
]);
```

`toolMessage(parts)` builds a `role: "tool"` message from `ToolResultPart`s; each tool result follows the assistant message whose `ToolCallPart` invoked it. Use it to seed `runAgent({ messages })` with a prior conversation where tools ran, or to append tool results from a custom host:

```ts
const messages = [
  userMessage("What is the weather in Paris?"),
  assistantMessage([
    { type: "tool-call", toolCallId: "call_1", toolName: "getWeather", input: { city: "Paris" } },
  ]),
  toolMessage([
    { type: "tool-result", toolCallId: "call_1", toolName: "getWeather", output: { type: "json", value: { tempC: 18 } } },
  ]),
];
```

## Store messages in context

Messages are plain context state. Declare a `messages` field validated by `messagesSchema`, and grow it over transitions:

```ts
import { messagesSchema, setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({
    prompt: z.string(),
    messages: messagesSchema,
  }),
});
```

Append with `appendMessages`, which returns a transition result adding one or more messages. Pass a message, an array, or a function of `{ context, event }`:

```ts
import { appendMessages, userMessage } from '@statelyai/agent';

on: {
  USER_REPLIED: appendMessages(({ event }) => userMessage(event.text)),
}
```

A request that needs history sends it through `messages` instead of a bare `prompt`. [examples/email-drafter/index.ts](../examples/email-drafter/index.ts) keeps a running `messages` array in context and feeds it to a `createTextLogic` request.

### A lightweight messages field

`messagesSchema` gives full structural validation of each part. When the array comes from library helpers you already trust, a shallow `Array.isArray` check is enough: use `zodAgentMessages()` from `@statelyai/agent/zod` (optional `zod` peer), which returns a `z.ZodType<AgentMessage[]>` with the exact type at author time.

```ts
import { zodAgentMessages } from '@statelyai/agent/zod';

context: z.object({
  messages: zodAgentMessages(),
}),
```

The no-dependency fallback is the same recipe inline: `messages: z.custom<AgentMessage[]>((v) => Array.isArray(v))`.

## Persisting messages

> **Warning:** `ImagePart` and `FilePart` can carry binary data (`Uint8Array` or `ArrayBuffer`) or a `URL` instance, none of which are JSON-serializable. When persisting machine context with messages, store binary content as base64 strings and URLs as strings; the library does not convert this for you.

Everything else in a message is plain JSON, so a history built from strings, base64, and URL strings survives a snapshot round-trip cleanly. See [Human in the loop](human-in-the-loop.md) for the persistence flow this applies to.
