import { expect, test } from "vitest";
import { z } from "zod";
import { appendMessages, getMessageText, isAgentMessages, runAgent, setupAgent } from "./index.js";

test("request actors expose framework-native messages through an explicit machine transition", async () => {
  const nativeMessage = z.object({ kind: z.literal("native"), body: z.string() });
  const agent = setupAgent({
    context: z.object({ messages: z.array(nativeMessage) }),
    input: z.object({}),
    output: z.object({ messages: z.array(nativeMessage) }),
    requests: {
      answer: {
        schemas: { output: z.string() },
        model: "test",
        prompt: "answer",
      },
    },
  });
  const machine = agent.createMachine({
    context: { messages: [] },
    output: ({ context }) => ({ messages: context.messages }),
    initial: "answering",
    on: {
      "agent.messages": appendMessages(),
    },
    states: {
      answering: {
        invoke: {
          src: "answer",
          onDone: { target: "done" },
        },
      },
      done: { type: "final" },
    },
  });

  const result = await runAgent(machine, {
    input: {},
    executors: {
      generateText: async () => ({
        output: "ok",
        messages: [{ kind: "native", body: "framework response" }],
      }),
    },
  });

  expect(result.status).toBe("done");
  if (result.status !== "done") return;
  expect(result.output.messages).toEqual([{ kind: "native", body: "framework response" }]);
  expect((result.snapshot as { messages?: unknown }).messages).toBeUndefined();
});

test("appendMessages can target an explicit context key", () => {
  const transition = appendMessages({ key: "researchMessages" });
  const result = transition({
    context: { researchMessages: [{ id: 1 }] },
    event: {
      type: "agent.messages",
      request: "research",
      actorId: "research-1",
      messages: [{ id: 2 }],
    },
  });

  expect(result.context.researchMessages).toEqual([{ id: 1 }, { id: 2 }]);
});

test("getMessageText reads string and text-part content", () => {
  expect(getMessageText({ role: "assistant", content: "hello" })).toBe("hello");
  expect(
    getMessageText({
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "file", data: "ignored", mediaType: "text/plain" },
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "lookup",
          output: { type: "text", value: "second" },
        },
      ],
    }),
  ).toBe("first\nsecond");
});

test("isAgentMessages guards a zod context field with the messagesSchema validator", () => {
  expect(isAgentMessages([{ role: "user", content: "hi" }])).toBe(true);
  expect(isAgentMessages([{ role: "narrator", content: "hi" }])).toBe(false);
  expect(isAgentMessages("nope")).toBe(false);

  const schema = z.object({ messages: z.custom<unknown>(isAgentMessages) });
  expect(schema.safeParse({ messages: [{ role: "assistant", content: "ok" }] }).success).toBe(true);
  expect(schema.safeParse({ messages: [{ role: "assistant" }] }).success).toBe(false);
});
