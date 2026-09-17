import { expect, test } from "vitest";
import { z } from "zod";
import { getMessageText, isAgentMessages, runAgent, setupAgent } from "./index.js";

test("request actors resolve with the executor's framework-native messages on output.messages", async () => {
  const agent = setupAgent({
    context: z.object({ messages: z.array(z.unknown()) }),
    input: z.object({}),
    output: z.object({ messages: z.array(z.unknown()) }),
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
    states: {
      answering: {
        invoke: {
          src: "answer",
          onDone: ({ context, output }) => ({
            target: "done",
            context: { messages: [...context.messages, ...output.messages] },
          }),
        },
      },
      done: { type: "final" },
    },
  });

  const result = await runAgent(machine, {
    input: {},
    executors: {
      generateText: async () => ({
        result: "ok",
        messages: [{ kind: "native", body: "framework response" }],
      }),
    },
  });

  expect(result.status).toBe("done");
  if (result.status !== "done") return;
  expect(result.output.messages).toEqual([{ kind: "native", body: "framework response" }]);
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
