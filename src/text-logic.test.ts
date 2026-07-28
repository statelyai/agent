import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, toPromise } from "xstate";
import {
  createAgentSchemas,
  createTextLogic,
  runAgent,
  setupAgent,
  type AgentRequestExecutor,
  type AgentTextRequest,
  type AgentTools,
} from "./index.js";
import { bindRequestExecutor, parseModelRef, parseStructuredEnvelope } from "./adapter/index.js";
import { type AgentRequest } from "./steps/index.js";
import {
  buildEnvelopeSchema,
  executeAgentTextRequest,
  type AgentRequestExecutorInfo,
} from "./text-logic.js";

// Focused coverage for the `mode: 'stream'` path of `createTextLogic`:
// the `onChunk` seam, streamText-missing errors, structured-output behavior,
// interleaved parallel streams, and `.withExecutor(...)` on a stream logic.
// The happy-path request lowering / `.execute()` dispatch is already covered
// in setup-agent.test.ts and run-agent.test.ts.
describe('createTextLogic({ mode: "stream" })', () => {
  const streamJoke = createTextLogic({
    mode: "stream",
    schemas: { input: z.object({ topic: z.string() }), output: z.string() },
    model: "test-model",
    prompt: ({ input }) => `Joke about ${input.topic}.`,
  });

  test("runAgent delivers chunks in order and assembles the full text via onChunk", async () => {
    const agent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ topic: z.string(), joke: z.string().nullable() }),
        input: z.object({ topic: z.string() }),
        output: z.object({ joke: z.string() }),
      }),
      actors: { streamJoke },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, joke: null }),
      initial: "streaming",
      states: {
        streaming: {
          invoke: {
            id: "streamJoke",
            src: "streamJoke",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: "done",
              context: { joke: output as string },
            }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ joke: context.joke ?? "" }) },
      },
    });

    const chunks: string[] = [];
    const chunkRequests: AgentRequest[] = [];
    const parts = ["Why ", "did ", "the ", "actor ", "cross?"];

    const result = await runAgent(machine, {
      input: { topic: "state machines" },
      onChunk: (chunk, info) => {
        chunks.push(chunk);
        chunkRequests.push(info.request);
      },
      executors: {
        generateText: async () => {
          throw new Error("generateText should not be used for stream requests");
        },
        streamText: async (
          _request: AgentTextRequest & { tools: AgentTools },
          info?: AgentRequestExecutorInfo,
        ) => {
          for (const part of parts) {
            info?.onChunk?.(part);
          }
          return { output: parts.join("") };
        },
      },
    });

    // chunk delivery order preserved
    expect(chunks).toEqual(parts);
    // full text assembled from chunks equals the final resolved text
    expect(chunks.join("")).toBe("Why did the actor cross?");
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toEqual({ joke: "Why did the actor cross?" });

    // onChunk carries the AgentRequest that produced each chunk
    expect(chunkRequests).toHaveLength(parts.length);
    for (const req of chunkRequests) {
      expect(req).toEqual(
        expect.objectContaining({ kind: "text", id: "streamJoke", mode: "stream" }),
      );
    }
  });

  test("runAgent: a stream request with no streamText executor throws", async () => {
    const agent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ topic: z.string() }),
        input: z.object({ topic: z.string() }),
      }),
      actors: { streamJoke },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic }),
      initial: "streaming",
      states: {
        streaming: {
          invoke: {
            id: "streamJoke",
            src: "streamJoke",
            input: ({ context }) => ({ topic: context.topic }),
          },
        },
      },
    });

    await expect(
      runAgent(machine, {
        input: { topic: "x" },
        executors: {
          generateText: async () => ({ output: "nope" }),
        },
      }),
    ).rejects.toThrow(/streamText/);
  });

  test("executeAgentTextRequest: stream mode with no streamText executor throws naming the id", async () => {
    await expect(
      executeAgentTextRequest(
        "stream",
        "myStream",
        { model: "test-model" },
        { generateText: async () => ({ output: "nope" }) },
      ),
    ).rejects.toThrow(/no executor.*stream.*'myStream'/i);
  });

  test("executeAgentTextRequest: stream mode passes info (onChunk/signal) through to streamText", async () => {
    const seen: string[] = [];
    let sawSignal = false;
    const controller = new AbortController();

    const { output } = await executeAgentTextRequest(
      "stream",
      "myStream",
      { model: "test-model", prompt: "go" },
      {
        generateText: async () => {
          throw new Error("generateText should not be used");
        },
        streamText: async (_request, info) => {
          info?.onChunk?.("a");
          info?.onChunk?.("b");
          sawSignal = info?.signal === controller.signal;
          return { output: "ab" };
        },
      },
      {},
      { onChunk: (c) => seen.push(c), signal: controller.signal },
    );

    expect(seen).toEqual(["a", "b"]);
    expect(sawSignal).toBe(true);
    expect(output).toBe("ab");
  });

  test("stream mode with a structured (object) output schema validates and returns the object", async () => {
    const streamStructured = createTextLogic({
      mode: "stream",
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.object({ setup: z.string(), punchline: z.string() }),
      },
      model: "test-model",
      prompt: ({ input }) => input.topic,
    });

    // the lowered request still carries the structured output schema
    expect(streamStructured.request({ topic: "x" }).outputSchema).toBe(
      streamStructured.schemas.output,
    );

    // streamText returning an { object } result is normalized + schema-validated
    await expect(
      streamStructured.execute(
        { topic: "actors" },
        {
          generateText: async () => {
            throw new Error("generateText should not be used");
          },
          streamText: async () => ({
            output: { setup: "Knock knock.", punchline: "XState." },
          }),
        },
      ),
    ).resolves.toEqual({ setup: "Knock knock.", punchline: "XState." });

    // output failing the schema surfaces as a validation error
    await expect(
      streamStructured.execute(
        { topic: "actors" },
        {
          generateText: async () => ({ output: {} }),
          streamText: async () => ({ output: { setup: "only setup" } }),
        },
      ),
    ).rejects.toThrow();
  });

  test(".withExecutor(...) on a stream logic runs as an actor and streams via emit-free executor", async () => {
    const bound = streamJoke.withExecutor(async ({ input, request }) => {
      expect(request.model).toBe("test-model");
      expect(request.prompt).toBe(`Joke about ${input.topic}.`);
      return { output: `bound joke about ${input.topic}` };
    });

    // still a stream logic
    expect(bound.mode).toBe("stream");

    const actor = createActor(bound, { input: { topic: "reducers" } });
    actor.start();
    await expect(toPromise(actor)).resolves.toBe("bound joke about reducers");
  });

  test("parallel stream requests interleave: onChunk disambiguates by request id", async () => {
    const streamA = createTextLogic({
      mode: "stream",
      schemas: { input: z.object({}), output: z.string() },
      model: "test-model",
      prompt: () => "a",
    });
    const streamB = createTextLogic({
      mode: "stream",
      schemas: { input: z.object({}), output: z.string() },
      model: "test-model",
      prompt: () => "b",
    });

    const agent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ a: z.string().nullable(), b: z.string().nullable() }),
        input: z.object({}),
        output: z.object({ a: z.string(), b: z.string() }),
      }),
      actors: { streamA, streamB },
    });

    const machine = agent.createMachine({
      context: { a: null, b: null },
      type: "parallel",
      output: ({ context }) => ({ a: context.a ?? "", b: context.b ?? "" }),
      states: {
        left: {
          initial: "streaming",
          states: {
            streaming: {
              invoke: {
                id: "streamA",
                src: "streamA",
                input: {},
                onDone: ({ output }) => ({ target: "done", context: { a: output as string } }),
              },
            },
            done: { type: "final" },
          },
        },
        right: {
          initial: "streaming",
          states: {
            streaming: {
              invoke: {
                id: "streamB",
                src: "streamB",
                input: {},
                onDone: ({ output }) => ({ target: "done", context: { b: output as string } }),
              },
            },
            done: { type: "final" },
          },
        },
      },
    });

    const chunksById: Record<string, string[]> = { streamA: [], streamB: [] };

    const result = await runAgent(machine, {
      input: {},
      onChunk: (chunk, info) => {
        if (info.request.kind === "text") {
          chunksById[info.request.id]?.push(chunk);
        }
      },
      executors: {
        generateText: async () => {
          throw new Error("generateText should not be used");
        },
        streamText: async (request, info) => {
          // emit two chunks tagged with which stream produced them
          const tag = request.prompt === "a" ? "A" : "B";
          info?.onChunk?.(tag);
          info?.onChunk?.(tag);
          return { output: `${tag}${tag}` };
        },
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // each stream resolved to its own tagged text
    expect(result.output).toEqual({ a: "AA", b: "BB" });
    // chunks are disambiguated by request id even though both streams ran
    expect(chunksById.streamA).toEqual(["A", "A"]);
    expect(chunksById.streamB).toEqual(["B", "B"]);
  });
});

describe("bindRequestExecutor", () => {
  const summarize = createTextLogic({
    schemas: { input: z.object({ topic: z.string() }), output: z.string() },
    model: "test-model",
    prompt: ({ input }) => `Summarize ${input.topic}.`,
  });

  test("adapts a raw executor: defaults tools to {}, forwards signal, unwraps output", async () => {
    const seen: { request: AgentTextRequest & { tools: AgentTools }; hasSignal: boolean }[] = [];
    const executor: AgentRequestExecutor = (request, info) => {
      seen.push({ request, hasSignal: info?.signal instanceof AbortSignal });
      return { output: `summary of ${request.prompt}` };
    };

    const bound = bindRequestExecutor(summarize, executor);
    const actor = createActor(bound, { input: { topic: "actors" } }).start();
    const output = await toPromise(actor);

    expect(output).toBe("summary of Summarize actors.");
    expect(seen[0]?.request.tools).toEqual({});
    expect(seen[0]?.hasSignal).toBe(true);
  });

  test("does not clobber tools the lowered request already declares", async () => {
    const withTools = createTextLogic({
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "test-model",
      tools: { search: { description: "search" } } as unknown as AgentTools,
      prompt: () => "hi",
    });
    let capturedTools: AgentTools | undefined;
    const bound = bindRequestExecutor(withTools, (request) => {
      capturedTools = request.tools;
      return { output: "ok" };
    });

    await toPromise(createActor(bound, { input: { topic: "x" } }).start());
    expect(capturedTools).toHaveProperty("search");
  });
});

describe("buildEnvelopeSchema", () => {
  test("envelopes an object schema as { result } and validates/unwraps", () => {
    const inner = z.object({ ok: z.boolean() });
    const envelope = buildEnvelopeSchema(inner);

    const json = envelope["~standard"].jsonSchema!.input!() as Record<string, unknown>;
    expect(json).toMatchObject({
      type: "object",
      required: ["result"],
      additionalProperties: false,
    });
    expect(json).toHaveProperty("properties.result");
    // No reasoning property without opt-in.
    expect(json).not.toHaveProperty("properties.reasoning");

    const good = envelope["~standard"].validate({ result: { ok: true } });
    expect(good).toMatchObject({ value: { result: { ok: true } } });

    const missing = envelope["~standard"].validate({ notResult: 1 });
    expect(missing).toHaveProperty("issues");

    // Inner validation failure propagates.
    const badInner = envelope["~standard"].validate({ result: { ok: "nope" } });
    expect(badInner).toHaveProperty("issues");
  });

  test("envelopes a bare union and an array uniformly (root object either way)", () => {
    for (const inner of [
      z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
      z.array(z.string()),
    ]) {
      const json = buildEnvelopeSchema(inner)["~standard"].jsonSchema!.input!() as Record<
        string,
        unknown
      >;
      expect(json).toMatchObject({ type: "object", required: ["result"] });
      expect(json).toHaveProperty("properties.result");
    }
  });

  test("reasoning opt-in adds a reasoning property BEFORE result and captures a string reasoning", () => {
    const inner = z.object({ ok: z.boolean() });
    const envelope = buildEnvelopeSchema(inner, { reasoning: true });

    const json = envelope["~standard"].jsonSchema!.input!() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(json.properties).toHaveProperty("reasoning");
    // reasoning is listed before result to nudge reason-first.
    expect(Object.keys(json.properties)).toEqual(["reasoning", "result"]);
    // reasoning stays optional — only result is required.
    expect(json.required).toEqual(["result"]);

    const withReasoning = envelope["~standard"].validate({
      reasoning: "because",
      result: { ok: true },
    });
    expect(withReasoning).toMatchObject({ value: { result: { ok: true }, reasoning: "because" } });

    // A non-string reasoning is dropped, not surfaced.
    const noReasoning = envelope["~standard"].validate({ reasoning: 42, result: { ok: true } });
    expect(noReasoning).toEqual({ value: { result: { ok: true } } });
  });
});

describe("parseModelRef", () => {
  test("splits provider/model-id refs on the first slash", () => {
    expect(parseModelRef("openai/gpt-5.4-mini")).toEqual({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    // Only the FIRST slash splits — model ids may contain slashes.
    expect(parseModelRef("openrouter/meta/llama-3")).toEqual({
      provider: "openrouter",
      modelId: "meta/llama-3",
    });
  });

  test("a ref without a slash has no provider", () => {
    expect(parseModelRef("quick")).toEqual({ provider: undefined, modelId: "quick" });
  });
});

describe("parseStructuredEnvelope", () => {
  const request = {
    outputSchema: z.object({ answer: z.string() }),
    reasoning: undefined,
  };

  test("unwraps a valid { result } envelope", () => {
    expect(parseStructuredEnvelope(request, { result: { answer: "ok" } })).toEqual({
      result: { answer: "ok" },
    });
  });

  test("surfaces reasoning when the request opted in", () => {
    expect(
      parseStructuredEnvelope(
        { ...request, reasoning: true },
        { result: { answer: "ok" }, reasoning: "because" },
      ),
    ).toEqual({ result: { answer: "ok" }, reasoning: "because" });
  });

  test("throws on a non-envelope value and on a missing outputSchema", () => {
    expect(() => parseStructuredEnvelope(request, "not an envelope")).toThrow();
    expect(() => parseStructuredEnvelope({ outputSchema: undefined }, { result: 1 })).toThrow(
      /outputSchema/,
    );
  });
});
