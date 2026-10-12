# Use in any stack

The machine is framework-independent. Adapters only supply executors and transport events/snapshots.

## Server request

```ts no-check
const result = await runAgent(machine, {
  input: await request.json(),
  executors,
});

if (result.status === "idle") {
  await frameworkStore.put(id, result.persist());
}
return Response.json(result);
```

## Resume request

```ts no-check
const snapshot = await frameworkStore.get(id);

let event;
try {
  event = parseAgentEvent(machine, await request.json());
} catch (error) {
  return Response.json({ error: String(error) }, { status: 400 });
}

const result = await runAgent(machine, { executors, snapshot, event });

if (result.ignored) {
  return Response.json(
    { error: `'${result.ignored.type}' does not apply right now` },
    { status: 409 },
  );
}
```

Parse at the boundary; `runAgent` adds no validation of its own. An event the restored state does not handle is ignored, not an error.

## Long-lived UI actor

Bind executors with `provideExecutors`, create a normal XState actor, and connect it using the framework's XState integration.

## Durable or event-pushing host

A host that cannot block on a run, such as a Durable Object woken by alarms, drives the transition loop itself. See [Write your own host loop](hosts.md#write-your-own-host-loop).

## Examples

- Next.js: [next-host](../examples/next-host)
- Cloudflare: [cloudflare-agent-host](../examples/cloudflare-agent-host), [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host)
- Mastra, LangChain: [mastra-host](../examples/mastra-host), [langchain-host](../examples/langchain-host)
- AI SDK and AG-UI streaming: [ai-sdk-ui-stream](../examples/ai-sdk-ui-stream), [tanstack-ai-stream](../examples/tanstack-ai-stream)

Use each framework's own storage, retry, queue, and interruption semantics.

## Related

- [Use in an XState 4 or 5 app](xstate-4-and-5-apps.md): isolating the agent when the app's own XState version cannot change.
