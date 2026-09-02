import { expect, test } from "vitest";
import type { ModelMessage } from "ai";
import type { AgentTool } from "@statelyai/agent";
import { runToolCallingExample } from "./index.js";

function executeTool(tool: AgentTool | undefined, input: unknown) {
  return typeof tool === "function" ? tool(input) : tool?.execute?.(input);
}

test("the host tool loop returns native messages that the machine appends", async () => {
  const responseMessages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "calculate",
          input: { operation: "multiply", a: 6, b: 7 },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "calculate",
          output: { type: "json", value: { value: 42 } },
        },
      ],
    },
    { role: "assistant", content: "6 times 7 is 42." },
  ];

  const output = await runToolCallingExample("What is 6 times 7?", {
    generateText: async (request) => {
      expect(request.maxSteps).toBe(5);
      const result = (await executeTool(request.tools?.calculate, {
        operation: "multiply",
        a: 6,
        b: 7,
      })) as { value: number };
      expect(result.value).toBe(42);
      return { output: "6 times 7 is 42.", messages: responseMessages };
    },
  });

  expect(output.answer).toBe("6 times 7 is 42.");
  expect(output.messages).toEqual([
    { role: "user", content: "What is 6 times 7?" },
    ...responseMessages,
  ]);
});
