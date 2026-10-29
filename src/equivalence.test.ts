import { describe, expect, test } from "vitest";
import { z } from "zod";
import { APICallError, generateText, stepCountIs, streamText, tool, type LanguageModel } from "ai";
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
  type RecordedModelCall,
  sameModelCallShape,
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
    expect(compareRecordings(recording, replay.recording)).toEqual({
      equivalent: true,
      divergences: [],
    });
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
    ).toBe("model-error"); // the refused call failed in the port
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
    expect(compareRecordings(recording, replay.recording)).toEqual({
      equivalent: true,
      divergences: [],
    });
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
      divergences: [],
    });
  });

  test("every divergence is listed, and one extra effect does not shift the rest", () => {
    const model = (call: number) => ({
      kind: "model" as const,
      seam: "ai-sdk" as const,
      method: "doGenerate",
      call,
      request: {},
    });
    const tool = (name: string, input: unknown, step: number) => ({
      kind: "tool" as const,
      name,
      step,
      input,
      output: null,
    });
    const original: Recording = {
      version: 1,
      effects: [
        model(0),
        tool("lookup", 1, 1),
        model(1),
        tool("pay", 10, 2),
        { kind: "output", value: "ok" },
      ],
    };
    const port: Recording = {
      version: 1,
      effects: [
        model(0),
        tool("lookup", 1, 1),
        tool("audit", 1, 1),
        model(1),
        tool("pay", 11, 2),
        { kind: "output", value: "ok" },
      ],
    };
    const report = compareRecordings(original, port);
    expect(report.divergences.map((d) => d.reason)).toEqual(["extra-effect", "tool-input"]);
    expect(report.divergence).toBe(report.divergences[0]);
  });

  test("a per-call match allows a shape change made on purpose, in replay and in comparison", async () => {
    const recording = await recordOriginal();
    const allowFirst = (expected: RecordedModelCall, actual: RecordedModelCall) =>
      expected.call === 0 || sameModelCallShape(expected, actual);

    const strict = createRecorder({ replay: recording });
    await expect(
      generateText({ model: strict.model(new MockLanguageModelV3()), prompt: "no tools" }),
    ).rejects.toThrow(RecordingDivergenceError);

    const lenient = createRecorder({ replay: recording, modelCalls: allowFirst });
    await generateText({
      model: lenient.model(new MockLanguageModelV3()),
      prompt: "no tools",
    }).catch(() => undefined);
    const report = compareRecordings(recording, lenient.recording, { modelCalls: allowFirst });
    expect(report.divergences.map((d) => d.reason)).not.toContain("model-call-shape");
  });

  test("a tool the original ran synchronously replays synchronously", () => {
    const recorder = createRecorder();
    const add = recorder.tool("add", (pair: [number, number]) => pair[0] + pair[1]);
    expect(add([1, 2])).toBe(3);
    const replay = createRecorder({ replay: JSON.parse(JSON.stringify(recorder.recording)) });
    const replayed = replay.tool("add", (pair: [number, number]) => pair[0] + pair[1]);
    expect(replayed([1, 2])).toBe(3);
    expect(compareRecordings(recorder.recording, replay.recording).equivalent).toBe(true);
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
    const concurrent = { concurrent: true as const };
    const a: Recording = {
      version: 1,
      effects: [model, tool("a", 1), { ...tool("b", 2), ...concurrent }],
    };
    const b: Recording = {
      version: 1,
      effects: [model, tool("b", 2), { ...tool("a", 1), ...concurrent }],
    };
    expect(compareRecordings(a, b)).toEqual({ equivalent: true, divergences: [] });
  });

  test("sequential tool calls in a different order diverge", () => {
    const tool = (name: string) => ({ kind: "tool" as const, name, step: 0, input: {}, output: 1 });
    const a: Recording = { version: 1, effects: [tool("charge"), tool("ship")] };
    const b: Recording = { version: 1, effects: [tool("ship"), tool("charge")] };
    expect(compareRecordings(a, b).equivalent).toBe(false);
  });

  test("a tool call that starts while another runs is recorded as concurrent", async () => {
    const recorder = createRecorder();
    const wait = recorder.tool("wait", async (name: string) => name);
    await Promise.all([wait("a"), wait("b")]);
    await wait("c");
    expect(
      recorder.recording.effects.map((effect) => effect.kind === "tool" && effect.concurrent),
    ).toEqual([undefined, true, undefined]);
  });

  test("replay matches tool calls through normalize, so a generated id still replays", async () => {
    const recorder = createRecorder();
    await recorder.tool(
      "save",
      async (row: { id: string; text: string }) => row.text,
    )({
      id: "id-1",
      text: "hi",
    });
    const redact = (effect: RecordedEffect): RecordedEffect =>
      effect.kind === "tool"
        ? { ...effect, input: { ...(effect.input as object), id: "?" } }
        : effect;
    const replay = createRecorder({ replay: recorder.recording, normalize: redact });
    const saved = await replay.tool(
      "save",
      async (_row: { id: string; text: string }) => "unused",
    )({ id: "id-2", text: "hi" });
    expect(saved).toBe("hi");
    expect(
      compareRecordings(recorder.recording, replay.recording, { normalize: redact }).equivalent,
    ).toBe(true);
  });

  test("a model call that fails on one side only, or uses another method, diverges", () => {
    const model = (extra: Partial<RecordedModelCall>): RecordedModelCall => ({
      kind: "model",
      seam: "openai",
      method: "chat.completions.create",
      call: 0,
      request: {},
      ...extra,
    });
    const run = (effect: RecordedModelCall): Recording => ({
      version: 1,
      effects: [effect, { kind: "output", value: "ok" }],
    });
    const failed = compareRecordings(
      run(model({})),
      run(model({ error: { name: "APIError", message: "500" } })),
    );
    expect(failed.divergence?.reason).toBe("model-error");
    const moved = compareRecordings(run(model({})), run(model({ method: "responses.create" })));
    expect(moved.divergence?.reason).toBe("model-method");
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
    expect(compareRecordings(recording, replay.recording)).toEqual({
      equivalent: true,
      divergences: [],
    });
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
    expect(compareRecordings(recorder.recording, replay.recording)).toEqual({
      equivalent: true,
      divergences: [],
    });
  });

  test("create keeps the SDK's withResponse, in record and in replay", async () => {
    const response = new Response(null, { headers: { "x-request-id": "req_1" } });
    const create = (params: unknown) =>
      Object.assign(Promise.resolve({ echo: params }), {
        withResponse: async () => ({ data: { echo: params }, response, request_id: "req_1" }),
      });
    const recorder = createRecorder();
    const client = recorder.openai({ responses: { create } });
    const recorded = await client.responses.create({ input: "hi" }).withResponse();
    expect(recorded).toEqual({ data: { echo: { input: "hi" } }, response, request_id: "req_1" });

    const replay = createRecorder({ replay: recorder.recording });
    const replayed = await replay
      .openai({ responses: { create } })
      .responses.create({ input: "hi" })
      .withResponse();
    expect(replayed.data).toEqual({ echo: { input: "hi" } });
    expect(replayed.request_id).toBeNull();
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

describe("verified equivalence (ports that change on purpose)", () => {
  const offering = (...names: string[]) => ({
    prompt: [],
    tools: names.map((name) => ({ type: "function", name, inputSchema: {} })),
  });
  const answer = (text: string) => ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  });
  const modelEffect = (
    call: number,
    extra: Partial<RecordedModelCall> = {},
  ): RecordedModelCall => ({
    kind: "model",
    seam: "ai-sdk",
    method: "doGenerate",
    call,
    request: offering(),
    response: answer(`answer ${call}`),
    ...extra,
  });
  // A replay model whose calls take untyped options, for driving the seam directly.
  const replayModel = (recorder: Recorder) =>
    recorder.model(new MockLanguageModelV3()) as unknown as {
      doGenerate(options: unknown): Promise<{ content: { text: string }[] }>;
    };

  test("replay finds each answer by shape, so a dropped call does not shift the rest", async () => {
    const recording: Recording = {
      version: 1,
      effects: [
        modelEffect(0, { request: offering("plan") }),
        modelEffect(1, { request: offering("write") }),
      ],
    };
    const replay = createRecorder({ replay: recording });
    const result = await replayModel(replay).doGenerate(offering("write"));
    expect(result.content[0]!.text).toBe("answer 1");
    expect(replay.recording.effects[0]).toMatchObject({ call: 0, replayed: 1 });
    expect(compareRecordings(recording, replay.recording).divergences).toMatchObject([
      { reason: "missing-effect", expected: { call: 0 } },
    ]);
  });

  test("replay answers a tool call made after a different number of model calls", async () => {
    const recording: Recording = {
      version: 1,
      effects: [
        modelEffect(0),
        modelEffect(1),
        { kind: "tool", name: "save", step: 2, input: { id: 1 }, output: "saved" },
      ],
    };
    const replay = createRecorder({ replay: recording });
    await replayModel(replay).doGenerate(offering());
    await expect(
      replay.tool("save", async (_row: { id: number }) => "live")({ id: 1 }),
    ).resolves.toBe("saved");
  });

  test("repeated identical tool calls get their results in recorded order", async () => {
    const poll = (step: number, output: string): RecordedEffect => ({
      kind: "tool",
      name: "status",
      step,
      input: { id: 1 },
      output,
    });
    const recording: Recording = {
      version: 1,
      effects: [poll(0, "pending"), modelEffect(0), poll(1, "ready")],
    };
    const replay = createRecorder({ replay: recording });
    const status = replay.tool("status", async (_input: { id: number }) => "live");
    await replayModel(replay).doGenerate(offering()); // the port asks the model first
    await expect(status({ id: 1 })).resolves.toBe("pending");
    await expect(status({ id: 1 })).resolves.toBe("ready");
  });

  test("a score question with another number of levels changes shape", () => {
    const grade = (criteria: unknown[]) =>
      modelEffect(0, {
        method: "doDecide",
        request: { questions: { grade: { type: "score", instructions: "", criteria } } },
      });
    expect(sameModelCallShape(grade(["bad", "good"]), grade(["poor", "fine"]))).toBe(true);
    expect(sameModelCallShape(grade(["bad", "good"]), grade(["bad", "ok", "good"]))).toBe(false);
  });

  test("translate adapts a recorded answer to a call changed on purpose, and the pair compares equal", async () => {
    const recording: Recording = {
      version: 1,
      effects: [
        modelEffect(0, {
          method: "doStream",
          response: {},
          stream: [{ type: "text-delta", id: "t", delta: "streamed" }],
        }),
        { kind: "output", value: "streamed" },
      ],
    };
    const replay = createRecorder({
      replay: recording,
      translate: (recorded, actual) =>
        recorded.method === "doStream" && actual.method === "doGenerate"
          ? {
              response: answer(
                (recorded.stream as { delta?: string }[]).map((part) => part.delta ?? "").join(""),
              ),
            }
          : undefined,
    });
    const result = await replayModel(replay).doGenerate(offering("decide"));
    replay.output(result.content[0]!.text);
    expect(replay.recording.effects[0]).toMatchObject({ translated: true, replayed: 0 });
    expect(compareRecordings(recording, replay.recording)).toMatchObject({ equivalent: true });
  });

  test("fallback answers what the recording cannot, and those effects still count as extra", async () => {
    const recording: Recording = { version: 1, effects: [modelEffect(0)] };
    const replay = createRecorder({
      replay: recording,
      fallback: {
        model: new MockLanguageModelV3({ doGenerate: async () => answer("stand-in") as never }),
        tools: true,
      },
    });
    const model = replayModel(replay);
    await model.doGenerate(offering());
    const retry = await model.doGenerate(offering());
    expect(retry.content[0]!.text).toBe("stand-in");
    await expect(replay.tool("check", async (n: number) => n * 2)(21)).resolves.toBe(42);
    expect(replay.recording.effects.slice(1)).toMatchObject([
      { kind: "model", unrecorded: true },
      { kind: "tool", unrecorded: true, output: 42 },
    ]);
    expect(compareRecordings(recording, replay.recording).divergences.map((d) => d.reason)).toEqual(
      ["extra-effect", "extra-effect"],
    );
  });

  test("kinds compares only what a port did, not how it asked the model", () => {
    const tools: RecordedEffect[] = [
      { kind: "tool", name: "send", step: 1, input: { to: "a" }, output: "ok" },
      { kind: "output", value: "sent" },
    ];
    const original: Recording = {
      version: 1,
      effects: [modelEffect(0, { method: "doStream" }), ...tools],
    };
    const port: Recording = {
      version: 1,
      effects: [modelEffect(0), modelEffect(1, { request: offering("decide") }), ...tools],
    };
    expect(compareRecordings(original, port).equivalent).toBe(false);
    expect(compareRecordings(original, port, { kinds: ["tool", "output"] }).equivalent).toBe(true);
  });

  test("normalize can drop an effect, such as a repeat of an idempotent write", () => {
    const write: RecordedEffect = {
      kind: "tool",
      name: "saveUrls",
      step: 0,
      input: ["a"],
      output: null,
    };
    const original: Recording = {
      version: 1,
      effects: [write, { ...write, step: 1 }, { kind: "output", value: "done" }],
    };
    const port: Recording = { version: 1, effects: [write, { kind: "output", value: "done" }] };
    const sameWrite = (x: RecordedEffect, y: RecordedEffect) =>
      x.kind === "tool" &&
      y.kind === "tool" &&
      x.name === y.name &&
      JSON.stringify(x.input) === JSON.stringify(y.input);
    const dropRepeats = (
      effect: RecordedEffect,
      index: number,
      effects: readonly RecordedEffect[],
    ) =>
      effects.slice(0, index).some((earlier) => sameWrite(earlier, effect)) ? undefined : effect;
    expect(compareRecordings(original, port).equivalent).toBe(false);
    expect(compareRecordings(original, port, { normalize: dropRepeats }).equivalent).toBe(true);
  });

  test("a decision model's doDecide is recorded and replayed, and matched by its questions", async () => {
    const decide = {
      questions: {
        route: { type: "choice", instructions: "", criteria: { faq: null, seat: null } },
      },
    };
    const result = { answers: { route: { type: "choice", choice: "seat" } } };
    const decisionModel = (doDecide: (options: unknown) => Promise<unknown>) => ({
      specificationVersion: "v4",
      supportedQuestionTypes: ["choice"],
      doDecide,
    });
    const recorder = createRecorder();
    await recorder.model(decisionModel(async () => result)).doDecide(decide as never);
    expect(recorder.recording.effects[0]).toMatchObject({ method: "doDecide", response: result });
    expect("doGenerate" in recorder.model(decisionModel(async () => result))).toBe(false);

    const replay = createRecorder({ replay: recorder.recording });
    const replayed = replay.model(
      decisionModel(async () => {
        throw new Error("the real model was called");
      }),
    );
    await expect(replayed.doDecide(decide as never)).resolves.toEqual(result);
    const changed = {
      questions: { route: { ...decide.questions.route, criteria: { faq: null } } },
    };
    await expect(replayed.doDecide(changed as never)).rejects.toThrow(RecordingDivergenceError);
  });

  test("a replayed error keeps its AI SDK identity, and compares by name and message only", async () => {
    const recorder = createRecorder();
    const failing = recorder.model(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new APICallError({
            message: "overloaded",
            url: "https://api.example/v1",
            requestBodyValues: { prompt: "a long prompt" },
            statusCode: 529,
            isRetryable: true,
          });
        },
      }),
    ) as unknown as { doGenerate(options: unknown): Promise<unknown> };
    await failing.doGenerate(offering()).catch(() => {});
    const recorded = recorder.recording.effects[0] as RecordedModelCall;
    expect(recorded.error).toMatchObject({
      name: "AI_APICallError",
      data: { statusCode: 529, isRetryable: true },
    });
    expect(JSON.stringify(recorded.error)).not.toContain("a long prompt");
    expect(JSON.stringify(recorded.error)).not.toContain("api.example");

    const replay = createRecorder({ replay: recorder.recording });
    const error = await replayModel(replay)
      .doGenerate(offering())
      .catch((e: unknown) => e);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).isRetryable).toBe(true);
    const port: Recording = {
      version: 1,
      effects: [{ ...recorded, error: { name: "AI_APICallError", message: "overloaded" } }],
    };
    expect(compareRecordings(recorder.recording, port).equivalent).toBe(true);
  });
});
