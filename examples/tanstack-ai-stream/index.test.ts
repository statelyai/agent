import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventType, StreamProcessor, type StreamChunk } from "@tanstack/ai";
import { handleChatRequest, POST } from "./index.js";

// The route resolves real model executors when `OPENAI_API_KEY` is set. These
// tests assert the scripted playback, so the key is neutralized here rather
// than depending on whether the machine running them has one.
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Parses a raw SSE body into the ordered AG-UI events it carried. */
function parseChunks(body: string): StreamChunk[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("");
      return JSON.parse(data) as StreamChunk;
    });
}

/**
 * A valid AG-UI `RunAgentInput`. The protocol requires `threadId`, `runId`,
 * per-message `id`, and the `tools` / `context` arrays — `chatParamsFromRequest`
 * rejects anything less.
 */
function chatRequest(question: string): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "m1", role: "user", content: question }],
      tools: [],
      context: [],
    }),
  });
}

// Stringified so the assertions below read as plain wire values.
const types = (chunks: StreamChunk[]): string[] => chunks.map((chunk) => String(chunk.type));

test("the route streams the run as AG-UI events over SSE", async () => {
  const response = await handleChatRequest(chatRequest("Why state machines for agents?"));

  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  expect(response.headers.get("Cache-Control")).toBe("no-cache");

  const chunks = parseChunks(await response.text());
  const seen = types(chunks);

  // The run brackets the whole stream, and RUN_FINISHED terminates it (AG-UI
  // has no `[DONE]` sentinel).
  expect(seen[0]).toBe("RUN_STARTED");
  expect(seen[seen.length - 1]).toBe("RUN_FINISHED");
  expect(seen).not.toContain("RUN_ERROR");

  const started = chunks[0] as StreamChunk & { threadId: string; runId: string };
  expect(started.threadId).toBe("thread-1");
  expect(started.runId).toBe("run-1");

  // Every event carries the AG-UI base fields.
  for (const chunk of chunks) {
    expect(typeof chunk.type).toBe("string");
    expect(typeof chunk.timestamp).toBe("number");
  }

  // Each machine state opens and closes exactly one step, in run order.
  const steps = chunks
    .filter(
      (chunk) => chunk.type === EventType.STEP_STARTED || chunk.type === EventType.STEP_FINISHED,
    )
    .map((chunk) => `${chunk.type}:${(chunk as { stepName: string }).stepName}`);
  expect(steps).toEqual([
    "STEP_STARTED:outlining",
    "STEP_FINISHED:outlining",
    "STEP_STARTED:answering",
    "STEP_FINISHED:answering",
    "STEP_STARTED:done",
    "STEP_FINISHED:done",
  ]);

  // Two streamed requests → two assistant messages, each opened and closed.
  const opened = chunks
    .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_START)
    .map((chunk) => (chunk as { messageId: string }).messageId);
  const closed = chunks
    .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_END)
    .map((chunk) => (chunk as { messageId: string }).messageId);
  expect(opened).toEqual(["outline", "answer"]);
  expect(closed).toEqual(["outline", "answer"]);

  // Deltas are increments, and arrive between their message's start and end.
  const deltas = chunks.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT);
  expect(deltas.length).toBeGreaterThan(1);
  expect(seen.indexOf("TEXT_MESSAGE_START")).toBeLessThan(seen.indexOf("TEXT_MESSAGE_CONTENT"));
  expect(seen.lastIndexOf("TEXT_MESSAGE_CONTENT")).toBeLessThan(
    seen.lastIndexOf("TEXT_MESSAGE_END"),
  );

  // The final result rides on RUN_FINISHED: the machine's output.
  const finished = chunks[chunks.length - 1] as StreamChunk & {
    result: { outline: string; answer: string };
  };
  expect(finished.result.outline).toBe("- what they are\n- why they help");
  expect(finished.result.answer).toBe(
    "State machines make an agent's control flow explicit and replayable.",
  );
});

test("TanStack AI's own StreamProcessor reconstructs the messages from those events", async () => {
  const response = await handleChatRequest(chatRequest("Why state machines for agents?"));
  const chunks = parseChunks(await response.text());

  // `StreamProcessor` is the exact fold `useChat` applies internally, so this
  // asserts the wire output against the real client, not a reimplementation.
  const processor = new StreamProcessor();
  for (const chunk of chunks) processor.processChunk(chunk);
  const messages = processor.getMessages();

  expect(messages.map((message) => message.role)).toEqual(["assistant", "assistant"]);

  // Content lives in `parts`, coalesced into one text part per message. This is
  // the same flatten ./chat.tsx renders.
  const text = (message: (typeof messages)[number]) =>
    message.parts.map((part) => (part.type === "text" ? part.content : "")).join("");
  expect(messages.map(text)).toEqual([
    "- what they are\n- why they help",
    "State machines make an agent's control flow explicit and replayable.",
  ]);

  // Worth knowing: STEP_STARTED / STEP_FINISHED are not inert. The real
  // processor reads them as reasoning boundaries and appends an (empty)
  // `thinking` part per step, so a UI that renders every part verbatim shows
  // blanks. Filtering to text parts — as `messageText` does — is the fix.
  const thinking = messages.flatMap((message) =>
    message.parts.filter((part) => part.type === "thinking"),
  );
  expect(thinking.length).toBeGreaterThan(0);
  expect(thinking.every((part) => part.content === "")).toBe(true);
});

test("the question comes off the request body", async () => {
  const response = await handleChatRequest(chatRequest("What is an actor?"));
  const chunks = parseChunks(await response.text());
  const finished = chunks[chunks.length - 1] as StreamChunk & { type: string };

  // The mock executors ignore the prompt, so assert the run completed rather
  // than echoing input: a real model would answer the parsed question.
  expect(finished.type).toBe("RUN_FINISHED");
});

test("a body that is not valid AG-UI is rejected with a 400", async () => {
  // No threadId/runId/tools/context, and the message has no id.
  const bad = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });

  // `chatParamsFromRequest` throws a `Response`, which a Start route returns.
  const thrown = await handleChatRequest(bad).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(400);
});

test("the exported POST handler serves the route", async () => {
  const response = await POST({ request: chatRequest("Why state machines?") });
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  expect(types(parseChunks(await response.text()))).toContain("RUN_FINISHED");
});

test("a failing executor closes the stream with RUN_ERROR", async () => {
  const response = await handleChatRequest(chatRequest("Why state machines?"), {
    generateText: async () => ({ output: "" }),
    streamText: async () => {
      throw new Error("model unavailable");
    },
  });

  const chunks = parseChunks(await response.text());
  const seen = types(chunks);
  expect(seen[0]).toBe("RUN_STARTED");
  expect(seen).toContain("RUN_ERROR");
  expect(seen).not.toContain("RUN_FINISHED");
});
