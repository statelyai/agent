# Messages

Messages are explicit machine context. Stately Agent does not keep a transcript sidecar or translate framework-native message objects. A text request resolves with the messages the executor returned, and the machine decides where they go.

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

## Reading messages off a request

<!-- AgentTextResult from src/text-logic.ts and src/index.ts -->

Every text request's invoke resolves to `{ result, messages }` (`AgentTextResult`, exported from `@statelyai/agent`). `result` is the validated output, typed from the request's output schema or `string` for plain text. `messages` is the executor's framework-native response messages, exactly as returned, and an empty array when the executor returned none. Append them to context in `onDone`:

```ts no-check
const machine = agent.createMachine({
  context: { messages: [], draft: null },
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ messages: context.messages }),
        onDone: ({ context, output }) => ({
          target: "reviewing",
          context: {
            draft: output.result,
            messages: [...context.messages, ...output.messages],
          },
        }),
      },
    },
    // ...
  },
});
```

There is no separate event or helper. A machine that ignores `output.messages` keeps no transcript, and one that appends them owns exactly what it retained. The same envelope arrives through `simulateAgent` scripts (with `messages: []`) and the [step API](steps.md).

## Validating and reading messages

<!-- messagesSchema, isAgentMessages from src/messages.ts and getMessageText from src/utils.ts, all via src/index.ts -->

`getMessageText(message)` returns the readable string content and joins text parts, including textual tool-result output, while ignoring non-text content.

To validate the field at runtime, use the `isAgentMessages` guard. A zod object cannot nest a Standard Schema directly, so wrap it:

```ts no-check
context: z.object({
  messages: z.custom<AgentMessage[]>(isAgentMessages),
}),
```

`messagesSchema` is the same validator as a Standard Schema, for `fromConfig` and `createAgentSchemas`.

This is deliberately transparent: the AI SDK executor returns AI SDK messages, another framework returns its own messages, and the machine stores those values unchanged. Tool calls and tool results remain part of that framework-native chat log.

See the runnable [`review-tool-calls`](../examples/review-tool-calls) example, where each proposed tool call becomes an explicit, persistable machine decision, and [Tools](tools.md#tool-results-in-messages) for a host-run tool loop whose native response messages are retained this way.
