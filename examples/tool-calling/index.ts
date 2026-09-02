/**
 * AI SDK-owned tool loop with framework-native message history.
 *
 * The request carries a real AI SDK tool and `maxSteps`; the AI SDK executor
 * owns intermediate tool calls. Its `ModelMessage[]` response is emitted as an
 * ordinary `agent.messages` event and appended explicitly by the machine.
 * The machine sees the completed request, not each intermediate tool call. See
 * `review-tool-calls` when the machine must gate individual calls.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/tool-calling/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

export const models = defineModels({ assistant: openai("gpt-5.4-mini") });

const messagesSchema = z.custom<ModelMessage[]>((value) => Array.isArray(value));

const toolCallingSetup = setupAgent({
  models,
  context: z.object({
    question: z.string(),
    answer: z.string(),
    messages: messagesSchema,
  }),
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string(), messages: messagesSchema }),
  requests: {
    answer: {
      model: "assistant",
      schemas: {
        input: z.object({ messages: messagesSchema }),
        output: z.string(),
      },
      system: "Use the calculator when arithmetic is requested, then answer concisely.",
      messages: ({ input }) => input.messages,
      tools: {
        calculate: tool({
          description: "Add or multiply two numbers.",
          inputSchema: z.object({
            operation: z.enum(["add", "multiply"]),
            a: z.number(),
            b: z.number(),
          }),
          execute: async ({ operation, a, b }) => ({
            value: operation === "add" ? a + b : a * b,
          }),
        }),
      },
      maxSteps: 5,
    },
  },
});

export const toolCallingMachine = toolCallingSetup.createMachine({
  id: "tool-calling",
  context: ({ input }) => ({
    question: input.question,
    answer: "",
    messages: [{ role: "user", content: input.question }],
  }),
  initial: "answering",
  // Transcript retention is visible machine behavior, not runner side state.
  on: {
    "agent.messages": toolCallingSetup.appendMessages(),
  },
  states: {
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ messages: context.messages }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ answer: context.answer, messages: context.messages }),
    },
  },
});

export async function runToolCallingExample(
  question: string,
  executors: AgentRequestExecutors = createAiSdkExecutors({ models }),
) {
  const result = await runAgent(toolCallingMachine, {
    input: { question },
    executors,
  });
  if (result.status !== "done") throw new Error(`Tool call ended with '${result.status}'.`);
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  console.log(await runToolCallingExample("What is 6 times 7?"));
}
