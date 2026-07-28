import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAgentSchemas,
  createTextLogic,
  runAgent,
  setupAgent,
  type AgentTextRequest,
  type AgentTools,
} from "./index.js";

// Raw AI SDK functions pass to `runAgent`'s `generateText`/`streamText`
// directly: their `{ text }`/`{ textStream }` return shapes are admitted by
// `AgentRequestExecutor`'s widened return type — no cast needed. These fakes
// stand in for `ai`'s own functions.

// Fake AI-SDK-shaped executors (no `ai` import). generateText resolves a
// GenerateTextResult-like `{ text, content }`; streamText resolves a
// StreamTextResult-like `{ textStream, text }`.

function makeGenerateTextMachine(output: z.ZodTypeAny) {
  const schemas = createAgentSchemas({
    context: z.object({ prompt: z.string(), result: z.any() }),
    input: z.object({ prompt: z.string() }),
    output: z.object({ result: z.any() }),
  });
  const answer = createTextLogic({
    schemas: { input: z.object({ prompt: z.string() }), output },
    model: "test-model",
    prompt: ({ input }) => input.prompt,
  });
  const agent = setupAgent({ schemas, actors: { answer } });
  return agent.createMachine({
    context: ({ input }) => ({ prompt: input.prompt, result: null }),
    initial: "answering",
    states: {
      answering: {
        invoke: {
          id: "answer",
          src: "answer",
          input: ({ context }) => ({ prompt: context.prompt }),
          onDone: ({ output }) => ({ target: "done", context: { result: output } }),
        },
      },
      done: { type: "final", output: ({ context }) => ({ result: context.result }) },
    },
  });
}

describe("blessed AI SDK executors", () => {
  test("raw generateText result ({ text, content }) works end-to-end", async () => {
    const machine = makeGenerateTextMachine(z.string());
    const generateText = async (_request: AgentTextRequest & { tools: AgentTools }) => ({
      text: "hello",
      content: [],
    });

    const result = await runAgent(machine, {
      input: { prompt: "hi" },
      executors: {
        generateText,
      },
    });
    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({ result: "hello" });
  });

  test("raw streamText result ({ textStream, text }) forwards chunks and completes", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), draft: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ draft: z.string() }),
    });
    const draft = createTextLogic({
      mode: "stream",
      schemas: { input: z.object({ prompt: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.prompt,
    });
    const agent = setupAgent({ schemas, actors: { draft } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            id: "draft",
            src: "draft",
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({ target: "done", context: { draft: output } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
      },
    });

    const streamText = (_request: AgentTextRequest & { tools: AgentTools }) => ({
      textStream: (async function* () {
        yield "a";
        yield "b";
      })(),
      text: Promise.resolve("ab"),
    });

    const chunks: string[] = [];
    const result = await runAgent(machine, {
      input: { prompt: "hi" },
      onChunk: (chunk) => chunks.push(chunk),
      executors: {
        generateText: async () => ({ output: "" }),
        streamText,
      },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({ draft: "ab" });
    expect(chunks).toEqual(["a", "b"]);
  });

  test("structured request parses JSON text via outputSchema", async () => {
    const machine = makeGenerateTextMachine(z.object({ answer: z.string() }));
    const generateText = async (_request: AgentTextRequest & { tools: AgentTools }) => ({
      text: JSON.stringify({ answer: "42" }),
      content: [],
    });

    const result = await runAgent(machine, {
      input: { prompt: "q" },
      executors: {
        generateText,
      },
    });
    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({
      result: { answer: "42" },
    });
  });

  test("malformed structured text throws the helpful createAiSdkExecutors error", async () => {
    const machine = makeGenerateTextMachine(z.object({ answer: z.string() }));
    const generateText = async (_request: AgentTextRequest & { tools: AgentTools }) => ({
      text: "not json at all",
      content: [],
    });

    const result = await runAgent(machine, {
      input: { prompt: "q" },
      executors: {
        generateText,
      },
    });
    expect(result.status).toBe("error");
    expect(String(result.status === "error" ? result.error : "")).toMatch(
      /createAiSdkExecutors from '@statelyai\/agent\/ai-sdk'/,
    );
  });

  test("garbage result still fires the invalid-envelope error", async () => {
    const machine = makeGenerateTextMachine(z.string());
    const generateText = async (_request: AgentTextRequest & { tools: AgentTools }) =>
      ({ nonsense: true }) as never;

    const result = await runAgent(machine, {
      input: { prompt: "q" },
      executors: {
        generateText,
      },
    });
    expect(result.status).toBe("error");
    expect(String(result.status === "error" ? result.error : "")).toMatch(
      /must return\s+\{ output \}/,
    );
  });
});
