# Messages

Messages are explicit machine context. Stately Agent does not keep a transcript sidecar or translate framework-native message objects.

Declare the schema from the framework you use:

```ts no-check
import type { ModelMessage } from "ai";

const agent = setupAgent({
  context: z.object({
    messages: z.custom<ModelMessage[]>(),
  }),
  // ...
});
```

When an executor returns framework messages, Stately Agent sends one ordinary `agent.messages` event. Add one top-level transition to retain them:

```ts no-check
const machine = agent.createMachine({
  context: { messages: [] },
  on: {
    "agent.messages": appendMessages(),
  },
  // ...
});
```

The default key is `messages`. Use `appendMessages({ key: "history" })` for another context field.

<!-- AGENT_MESSAGES_EVENT_TYPE, appendMessages, and getMessageText from src/messages.ts, src/utils.ts, and src/index.ts -->

Use `AGENT_MESSAGES_EVENT_TYPE` instead of the string literal when sharing the
handler. `getMessageText(message)` returns the readable string content and
joins text parts, including textual tool-result output, while ignoring
non-text content.

This is deliberately transparent: the AI SDK executor returns AI SDK messages, another framework returns its own messages, and the machine stores those values unchanged. Tool calls and tool results remain part of that framework-native chat log.

See the runnable [`tool-calling`](../examples/tool-calling) example for an AI
SDK-owned tool loop whose native response messages are retained this way. Compare
[`review-tool-calls`](../examples/review-tool-calls) when each proposed call must
become an explicit, persistable machine decision.
