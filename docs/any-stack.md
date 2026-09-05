# Use in any stack

The machine is framework-independent. Adapters only supply executors and transport events/snapshots.

## Server request

```ts no-check
const result = await runAgent(machine, {
  input: await request.json(),
  executors
});

if (result.status === "idle") {
  await frameworkStore.put(id, result.persist());
}
return Response.json(result);
```

## Resume request

```ts no-check
const snapshot = await frameworkStore.get(id);
const result = await runAgent(machine, {
  snapshot,
  event: parseAgentEvent(restoredSnapshot, await request.json()),
  executors
});
```

## Long-lived UI actor

Bind executors with `provideExecutors`, create a normal XState actor, and connect it using the framework's XState integration.

## Examples

- Next.js: [next-host](../examples/next-host)
- Cloudflare: [cloudflare-agent-host](../examples/cloudflare-agent-host), [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host)
- Mastra, LangChain, Flue: [mastra-host](../examples/mastra-host), [langchain-host](../examples/langchain-host), [flue-host](../examples/flue-host)
- AI SDK and AG-UI streaming: [ai-sdk-ui-stream](../examples/ai-sdk-ui-stream), [tanstack-ai-stream](../examples/tanstack-ai-stream)

Use each framework's own storage, retry, queue, and interruption semantics.
