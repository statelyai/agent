---
title: Context compaction
description: Bound a chat loop's message history by folding stale turns into a running summary from an explicit compaction state.
---

## The problem

<!-- explicit-state compaction pattern from examples/context-compaction/index.ts -->

The Vercel AI SDK core does not auto-compact `messages`. Resend the full array every turn and a long conversation grows without bound:

- Cost and latency scale with history length.
- Eventually the context window overflows and the call fails.

This is userland work, and this library's answer is to make it a **machine state**, not hidden middleware:

- The compaction boundary is visible in the state chart.
- You can pause, persist, and inspect exactly when the agent compacts.
- The trigger is an authored transition, not a heuristic buried in a wrapper.

[examples/context-compaction/index.ts](../examples/context-compaction/index.ts) is the full runnable example; its tests drive the loop with mock executors.

## Context shape

The machine carries the history, the running summary, and the thresholds in its own context:

```ts
context: z.object({
  messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
  summary: z.string().nullable(),
  turns: z.number(),
  maxMessages: z.number(), // compact once history grows past this
  keepRecent: z.number(), // messages kept verbatim after compaction
  pendingInput: z.string().nullable(),
}),
```

`maxMessages` and `keepRecent` arrive as machine input with defaults, so the same machine runs with different budgets.

## The two requests

Two `requests` entries on `setupAgent`:

- **`respond`**: the chat reply. Rendered from the running summary (as a system message) plus only the recent messages.
- **`summarize`**: folds the prior summary and the stale messages into one compact summary, as structured output `z.object({ summary: z.string() })`.

```ts
respond: {
  // ...
  messages: ({ input }) => [
    ...(input.summary
      ? [systemMessage(`Summary of earlier conversation:\n${input.summary}`)]
      : []),
    ...input.messages,
  ],
},
```

The `summarize` system prompt tells the model what survives compaction: concrete facts, names, numbers, decisions, open questions; pleasantries dropped.

## The loop

```
awaitingUser → routingInput → responding → checkingWindow ──→ awaitingUser
                    │                            │
                    └→ done (final)              └→ compacting → awaitingUser
```

- `awaitingUser` invokes `agent.userInput`; typing `exit` (or nothing) routes to `done`.
- `responding` invokes `respond` and appends the user and assistant messages.
- `checkingWindow` is a `type: 'choice'` state: over budget goes to `compacting`, otherwise back to the prompt.

```ts
checkingWindow: {
  type: 'choice',
  choice: ({ context }) =>
    context.messages.length > context.maxMessages
      ? { target: 'compacting' }
      : { target: 'awaitingUser' },
},
```

## The compacting state

`compacting` summarizes everything except the last `keepRecent` messages, then keeps only those:

```ts
compacting: {
  invoke: {
    src: 'summarize',
    input: ({ context }) => ({
      priorSummary: context.summary,
      staleMessages: context.messages.slice(0, -context.keepRecent),
    }),
    onDone: ({ context, output }) => ({
      target: 'awaitingUser',
      context: {
        summary: output.summary,
        messages: context.messages.slice(-context.keepRecent),
      },
    }),
    // If summarization fails, keep going without dropping history.
    onError: { target: 'awaitingUser' },
  },
},
```

Passing `priorSummary` back in makes the summary *running*: each compaction folds the previous one in, so no fact needs to survive more than one hop.

## Summary as context

After compaction, every `respond` call sends the summary as a system message plus the last `keepRecent` messages. Tokens per turn stay bounded no matter how long the conversation runs; older turns stay available as compacted facts rather than verbatim transcript.

## Tuning the thresholds

- **Higher `maxMessages`**: fewer summarize calls, more verbatim fidelity, larger per-turn context.
- **Higher `keepRecent`**: recent nuance survives compaction, at the cost of window size.
- `keepRecent` should stay comfortably below `maxMessages`, or the machine compacts on nearly every turn.

Counting messages is the simplest trigger. The same shape works with a token estimate: change the `checkingWindow` predicate, nothing else moves.

## Testing without a model

Executors are injected, so the tests in [examples/context-compaction/index.test.ts](../examples/context-compaction/index.test.ts) drive the full loop with a mock `generateText` and a scripted `userInput`, asserting that:

- History is capped at `keepRecent` and the summary comes from the summarize request.
- The first `respond` after compaction receives the summary as a system message.
- `exit` settles `done` with `{ summary, messages, turns }`.

> **Note: system prompts double as the executor's routing key.** A host executor sees the *rendered* request (`model`, `system`, `messages`/`prompt`), not the request's name or raw input. A mock (or a router picking providers per request) can only tell `respond` from `summarize` by inspecting those fields, usually `system`. Keep each request's system prompt distinguishable: an early draft of this example used the phrase "running summary" in both prompts, and the mock routed `respond` calls to the summarize branch, failing output validation.

## Extending

- **Token budget**: swap the message-count predicate for a token estimate over `context.messages`.
- **Persist at the boundary**: `compacting` is a real state, so [snapshot persistence](human-in-the-loop.md#persist-and-resume-across-processes) can checkpoint right before or after it.
- **Different retention**: keep pinned messages (system instructions, tool results) out of the stale slice before summarizing.

## Related

- [Text requests](text-requests.md): declaring `respond` and `summarize` with typed schemas.
- [Messages](messages.md): the `AgentMessage` shape and message helpers.
- [Human in the loop](human-in-the-loop.md): `agent.userInput` and the idle-first waiting model.
