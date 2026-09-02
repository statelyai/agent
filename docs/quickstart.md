# Quickstart

Install core:

```sh
pnpm add @statelyai/agent@alpha xstate@alpha zod
```

Add `ai` and a provider only when using the optional AI SDK adapter.

## Define one artifact

```ts no-check
const agent = setupAgent({
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: z.object({ answer: z.string() }),
  requests: {
    answer: {
      model: "fast",
      schemas: { input: z.object({ prompt: z.string() }), output: z.string() },
      prompt: ({ input }) => input.prompt
    }
  }
});

const machine = agent.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: "answering",
  states: {
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output }
        })
      }
    },
    done: {
      type: "final",
      output: ({ context }) => ({ answer: context.answer ?? "" })
    }
  }
});
```

## Run it

```ts no-check
const result = await runAgent(machine, {
  input: { prompt: "Why state machines?" },
  executors: {
    generateText: async (request, { signal }) => {
      const response = await sdk.generate(request, { signal });
      return { output: response.text, messages: response.messages };
    }
  }
});

if (result.status === "done") console.log(result.output);
```

Requests have a semantic `name`, resolved `input`, model reference, schemas, prompt/messages, and tools. The machine owns control flow; the executor owns the provider call.

## Test with no API key

```ts no-check
const scripted = createScriptedExecutors({
  text: { answer: [{ output: "Because transitions constrain behavior." }] }
});

await runAgent(machine, {
  input: { prompt: "Why?" },
  executors: scripted
});

console.log(scripted.calls);
```

Continue with [Choosing a run mode](choosing-a-run-mode.md), [Messages](messages.md), and [Persistence](persistence.md).
