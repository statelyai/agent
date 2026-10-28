import { describe, expect, test } from "vitest";
import { z } from "zod";
import { generateText, stepCountIs, streamText, tool, type LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import OpenAI from "openai";
import { createAgentRuntime, runToQuiescence, setupAgent } from "./index.js";
import { createAiSdkExecutors } from "./ai-sdk/index.js";
import { createOpenAiExecutors } from "./openai/index.js";
import {
  compareRecordings,
  createRecorder,
  RecordingDivergenceError,
  type RecordedEffect,
  type Recorder,
  type Recording,
} from "./testing/index.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// A scripted model: one tool call, then a text answer.
function scriptedModel() {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async () =>
      step++ === 0
        ? {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "c1",
                toolName: "getWeather",
                input: JSON.stringify({ city: "Paris" }),
              },
            ],
            finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
            usage,
            warnings: [],
            response: { id: "r1", timestamp: new Date(0), modelId: "mock" },
          }
        : {
            content: [{ type: "text" as const, text: "Sunny in Paris." }],
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage,
            warnings: [],
            response: { id: "r2", timestamp: new Date(0), modelId: "mock" },
          },
  });
}

function weatherTools(recorder: Recorder) {
  return recorder.tools({
    getWeather: tool({
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "sunny" }),
    }),
  });
}

// The original: a plain AI SDK tool loop.
async function original(recorder: Recorder, model: LanguageModel) {
  const { text } = await generateText({
    model,
    tools: weatherTools(recorder),
    stopWhen: stepCountIs(5),
    prompt: "Weather in Paris?",
  });
  recorder.output(text);
}

// The port: the same call, owned by a machine.
function portMachine(models: Record<string, LanguageModel>, transform = (text: string) => text) {
  const agent = setupAgent({
    context: z.object({ answer: z.string() }),
    output: z.object({ answer: z.string() }),
    models,
  });
  return agent.createMachine({
    context: { answer: "" },
    initial: "answering",
    states: {
      answering: {
        invoke: {
          src: "agent.generateText",
          input: ({ context }) => ({
            model: "main",
            prompt: "What's the weather in Paris?",
            tools: context.answer === "" ? toolsFor.current! : {},
            maxSteps: 5,
          }),
          onDone: ({ event }) => ({
            target: "done",
            context: { answer: transform(event.output.result as string) },
          }),
        },
      },
      done: { type: "final", output: ({ context }) => context },
    },
  });
}
const toolsFor: { current?: ReturnType<typeof weatherTools> } = {};

async function port(recorder: Recorder, transform?: (text: string) => string) {
  const models = { main: recorder.model(new MockLanguageModelV3()) };
  toolsFor.current = weatherTools(recorder);
  const result = await runToQuiescence(
    createAgentRuntime(portMachine(models, transform), {
      executors: createAiSdkExecutors({ models }),
    }),
  );
  if (result.status !== "done") throw result.status === "error" ? result.error : new Error("idle");
  recorder.output(result.output.answer);
}

async function recordOriginal(): Promise<Recording> {
  const recorder = createRecorder();
  await original(recorder, recorder.model(scriptedModel()));
  // Golden files go through JSON; replay must survive it.
  return JSON.parse(JSON.stringify(recorder.recording));
}

describe("verified equivalence (AI SDK)", () => {
  test("records model calls, tool calls, and output in order", async () => {
    const recording = await recordOriginal();
    expect(recording.effects.map((effect) => effect.kind)).toEqual([
      "model",
      "tool",
      "model",
      "output",
    ]);
    expect(recording.effects[1]).toMatchObject({
      kind: "tool",
      name: "getWeather",
      step: 1,
      input: { city: "Paris" },
      output: { city: "Paris", forecast: "sunny" },
    });
  });

  test("a faithful port replays with no model and no tools, and is equivalent", async () => {
    const recording = await recordOriginal();
    const replay = createRecorder({ replay: recording });
    await port(replay);
    expect(compareRecordings(recording, replay.recording)).toEqual({ equivalent: true });
  });

  test("a port that changes the output is caught at the output", async () => {
    const recording = await recordOriginal();
    const replay = createRecorder({ replay: recording });
    await port(replay, (text) => text.toUpperCase());
    expect(compareRecordings(recording, replay.recording).divergence).toMatchObject({
      reason: "output",
      index: 3,
    });
  });

  test("a model call that changes shape is reported, since its recorded answer may not fit", async () => {
    const recording = await recordOriginal();
    const replay = createRecorder({ replay: recording });
    const models = { main: replay.model(new MockLanguageModelV3()) };
    const { text } = await generateText({ model: models.main, prompt: "no tools" }).catch(() => ({
      text: "",
    }));
    replay.output(text);
    expect(compareRecordings(recording, replay.recording).divergence?.reason).toBe(
      "model-call-shape",
    );
    expect(
      compareRecordings(recording, replay.recording, { modelCalls: "none" }).divergence?.reason,
    ).toBe("kind");
  });

  test("an extra model call throws in replay and shows up as an extra effect", async () => {
    const recording = await recordOriginal();
    const replay = createRecorder({ replay: recording });
    const model = replay.model(new MockLanguageModelV3());
    const tools = weatherTools(replay);
    await generateText({ model, tools, stopWhen: stepCountIs(5), prompt: "x" });
    await expect(generateText({ model, prompt: "again" })).rejects.toThrow(
      RecordingDivergenceError,
    );
    expect(compareRecordings(recording, replay.recording).divergence).toMatchObject({
      reason: "extra-effect",
      actual: { kind: "model", error: { name: "RecordingDivergenceError" } },
    });
  });

  test("a tool call with different arguments throws in replay and is reported", async () => {
    const recording = await recordOriginal();
    const replay = createRecorder({ replay: recording });
    const run = replay.tool("getWeather", async (input: { city: string }) => input);
    replay.model(new MockLanguageModelV3());
    await expect(run({ city: "Lyon" })).rejects.toThrow(RecordingDivergenceError);
    expect(compareRecordings(recording, replay.recording).divergence?.reason).toBe(
      "missing-effect",
    );
  });

  test("streamed calls record their parts and replay them", async () => {
    const recorder = createRecorder();
    const model = recorder.model(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "response-metadata" as const, id: "r", timestamp: new Date(0), modelId: "m" },
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: "Hel" },
              { type: "text-delta" as const, id: "t", delta: "lo" },
              { type: "text-end" as const, id: "t" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage,
              },
            ],
          }),
        }),
      }),
    );
    const first = streamText({ model, prompt: "hi" });
    recorder.output(await first.text);
    const recording: Recording = JSON.parse(JSON.stringify(recorder.recording));

    const replay = createRecorder({ replay: recording });
    const second = streamText({ model: replay.model(new MockLanguageModelV3()), prompt: "hi" });
    replay.output(await second.text);
    expect(await second.text).toBe("Hello");
    expect(compareRecordings(recording, replay.recording)).toEqual({ equivalent: true });
  });

  test("normalize redacts values that differ on every run", async () => {
    const recording = await recordOriginal();
    const replay = createRecorder({ replay: recording });
    await port(replay, (text) => `${text} (${Math.random()})`);
    const redact = (effect: RecordedEffect): RecordedEffect =>
      effect.kind === "output"
        ? { ...effect, value: String(effect.value).replace(/ \(.*\)$/, "") }
        : effect;
    expect(compareRecordings(recording, replay.recording, { normalize: redact })).toEqual({
      equivalent: true,
    });
  });

  test("parallel tool calls compare equal in any finishing order", () => {
    const tool = (name: string, input: unknown) => ({
      kind: "tool" as const,
      name,
      step: 1,
      input,
      output: 1,
    });
    const model = {
      kind: "model" as const,
      seam: "ai-sdk" as const,
      method: "doGenerate",
      call: 0,
      request: {},
    };
    const a: Recording = { version: 1, effects: [model, tool("a", 1), tool("b", 2)] };
    const b: Recording = { version: 1, effects: [model, tool("b", 2), tool("a", 1)] };
    expect(compareRecordings(a, b)).toEqual({ equivalent: true });
  });
});

describe("verified equivalence (openai client)", () => {
  function fakeClient(): OpenAI {
    let calls = 0;
    return {
      chat: {
        completions: {
          create: async (params: { stream?: boolean }) => {
            calls++;
            if (params.stream) {
              return (async function* () {
                yield { choices: [{ index: 0, delta: { content: "Hi " } }] };
                yield {
                  choices: [{ index: 0, delta: { content: "there" }, finish_reason: "stop" }],
                };
              })();
            }
            return {
              id: `c${calls}`,
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: "Bonjour" },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          },
        },
      },
    } as unknown as OpenAI;
  }

  test("a raw client call and a Stately port over createOpenAiExecutors are equivalent", async () => {
    const recorder = createRecorder();
    const client = recorder.openai(fakeClient());
    const response = await client.chat.completions.create({
      model: "gpt-x",
      messages: [{ role: "user", content: "Say hello in French" }],
    });
    recorder.output(response.choices[0]!.message.content);
    const recording: Recording = JSON.parse(JSON.stringify(recorder.recording));

    const replay = createRecorder({ replay: recording });
    const agent = setupAgent({ context: z.object({ text: z.string() }), output: z.string() });
    const machine = agent.createMachine({
      context: { text: "" },
      initial: "asking",
      states: {
        asking: {
          invoke: {
            src: "agent.generateText",
            input: { model: "gpt-x", prompt: "Translate 'hello' to French" },
            onDone: ({ event }) => ({
              target: "done",
              context: { text: String(event.output.result) },
            }),
          },
        },
        done: { type: "final", output: ({ context }) => context.text },
      },
    });
    const result = await runToQuiescence(
      createAgentRuntime(machine, {
        executors: createOpenAiExecutors({
          client: replay.openai(new OpenAI({ apiKey: "replay" })),
        }),
      }),
    );
    replay.output(result.status === "done" ? result.output : undefined);
    expect(compareRecordings(recording, replay.recording)).toEqual({ equivalent: true });
  });

  test("streamed chunks record and replay as an async iterable", async () => {
    const recorder = createRecorder();
    const stream = await recorder.openai(fakeClient()).chat.completions.create({
      model: "gpt-x",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
    recorder.output(text);

    const replay = createRecorder({ replay: JSON.parse(JSON.stringify(recorder.recording)) });
    const replayed = await replay.openai(new OpenAI({ apiKey: "replay" })).chat.completions.create({
      model: "gpt-x",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    let again = "";
    for await (const chunk of replayed) again += chunk.choices[0]?.delta.content ?? "";
    replay.output(again);
    expect(again).toBe("Hi there");
    expect(compareRecordings(recorder.recording, replay.recording)).toEqual({ equivalent: true });
  });

  test("prototype methods that call create through this, like responses.parse, survive and record", async () => {
    class Responses {
      async create(params: { input: string }) {
        return { output_text: JSON.stringify({ echo: params.input }) };
      }
      async parse(params: { input: string }) {
        const response = await this.create(params);
        return { ...response, output_parsed: JSON.parse(response.output_text) };
      }
    }
    const recorder = createRecorder();
    const client = recorder.openai({ responses: new Responses() });
    const parsed = await client.responses.parse({ input: "hi" });
    expect(parsed.output_parsed).toEqual({ echo: "hi" });
    expect(recorder.recording.effects).toMatchObject([
      { kind: "model", method: "responses.create" },
    ]);
  });
});
