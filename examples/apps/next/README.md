# Next App Router Examples

These files show the same `@statelyai/agent` examples in a shape you can drop directly into a Next.js App Router project.

Included routes:

- `app/api/chat/route.ts`: AI SDK UI message streaming route
- `app/api/review-sessions/route.ts`: start a durable review session
- `app/api/review-sessions/[sessionId]/route.ts`: fetch a review session snapshot
- `app/api/review-sessions/[sessionId]/events/route.ts`: send events to a review session
- `app/api/stream-sessions/route.ts`: start a streaming session
- `app/api/stream-sessions/[sessionId]/route.ts`: fetch a streaming session snapshot
- `app/api/stream-sessions/[sessionId]/stream/route.ts`: consume the streaming SSE response

The route handlers are backed by:

- [`examples/next-app-router.ts`](/Users/davidkpiano/Code/agent/examples/next-app-router.ts)
- [`examples/next-ai-sdk-ui.ts`](/Users/davidkpiano/Code/agent/examples/next-ai-sdk-ui.ts)
