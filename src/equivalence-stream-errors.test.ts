import { describe, expect, test, vi } from "vitest";
import { APICallError } from "ai";
import {
  compareRecordings,
  createRecorder,
  type Recorder,
  type Recording,
} from "./testing/index.js";

const chunk = { type: "text-delta", id: "text0", delta: "partial" };
const seams = ["ai-sdk", "chat", "responses"] as const;
type Seam = (typeof seams)[number];

function openaiStream(
  recorder: Recorder,
  seam: "chat" | "responses",
  run: () => Promise<AsyncIterable<unknown>>,
): Promise<AsyncIterable<unknown>> {
  const create = (_params: { stream: boolean }) => run();
  return seam === "chat"
    ? recorder
        .openai({ chat: { completions: { create } } })
        .chat.completions.create({ stream: true })
    : recorder.openai({ responses: { create } }).responses.create({ stream: true });
}

function source(seam: Seam, parts: unknown[], error?: Error, requestError?: Error) {
  let stopped!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const cancelled = vi.fn(() => stopped());
  const run = vi.fn(async () => {
    if (requestError) throw requestError;
    if (seam !== "ai-sdk") {
      return (async function* () {
        try {
          yield* parts;
          if (error) throw error;
        } finally {
          cancelled();
        }
      })();
    }
    let index = 0;
    return {
      response: { id: "fixture" },
      stream: new ReadableStream({
        pull(controller) {
          if (index < parts.length) controller.enqueue(parts[index++]);
          else if (error) controller.error(error);
          else controller.close();
        },
        cancel: cancelled,
      }),
    };
  });
  const load = async (recorder: Recorder): Promise<AsyncIterable<unknown>> => {
    if (seam === "ai-sdk") {
      const model = recorder.model({
        doGenerate: async (_options: unknown) => ({}),
        doStream: async (_options: unknown) => (await run()) as { stream: ReadableStream<unknown> },
      });
      return (await model.doStream({})).stream;
    }
    return openaiStream(recorder, seam, async () => (await run()) as AsyncIterable<unknown>);
  };
  return { load, run, cancelled, cancellation };
}

async function consume(stream: AsyncIterable<unknown>) {
  const parts: unknown[] = [];
  try {
    for await (const part of stream) parts.push(part);
    return { parts, error: undefined };
  } catch (error) {
    return { parts, error };
  }
}

describe.each(seams)("recording a failed %s model stream", (seam) => {
  test.each([{ parts: [] }, { parts: [chunk] }])(
    "replays an iteration error after exactly the saved chunks: $parts",
    async ({ parts }) => {
      const recorder = createRecorder();
      const error = new TypeError("connection reset");
      const live = source(seam, parts, error);
      expect(await consume(await live.load(recorder))).toEqual({ parts, error });
      const saved = JSON.parse(JSON.stringify(recorder.recording));
      expect(saved.effects[0]).toMatchObject({
        stream: parts,
        streamError: { name: "TypeError", message: "connection reset" },
      });
      expect(saved.effects[0].error).toBeUndefined();

      const replay = createRecorder({ replay: saved });
      const unused = source(seam, [], new Error("must not execute"));
      // Resolving the model call itself must succeed, even with an empty failed stream.
      const stream = await unused.load(replay);
      const actual = await consume(stream);
      expect(actual.parts).toEqual(parts);
      expect(actual.error).toMatchObject({ name: "TypeError", message: "connection reset" });
      expect(unused.run).not.toHaveBeenCalled();
      expect(compareRecordings(saved, replay.recording).equivalent).toBe(true);
    },
  );

  test.each([{ parts: [] }, { parts: [chunk] }])(
    "keeps successful version1 streams ending normally: $parts",
    async ({ parts }) => {
      const recorder = createRecorder();
      expect(await consume(await source(seam, parts).load(recorder))).toEqual({
        parts,
        error: undefined,
      });
      const saved = JSON.parse(JSON.stringify(recorder.recording));
      expect(saved.version).toBe(1);
      expect(saved.effects[0].streamError).toBeUndefined();
      const replay = createRecorder({ replay: saved });
      expect(await consume(await source(seam, []).load(replay))).toEqual({
        parts,
        error: undefined,
      });
    },
  );

  test("keeps request errors in the call phase", async () => {
    const recorder = createRecorder();
    const error = new Error("request failed");
    await expect(source(seam, [], undefined, error).load(recorder)).rejects.toBe(error);
    const saved = JSON.parse(JSON.stringify(recorder.recording));
    expect(saved.effects[0].streamError).toBeUndefined();
    await expect(source(seam, []).load(createRecorder({ replay: saved }))).rejects.toThrow(
      "request failed",
    );
  });

  test("does not record an unobserved replay error after early return", async () => {
    const recorder = createRecorder();
    await consume(await source(seam, [chunk], new Error("connection reset")).load(recorder));
    const saved = JSON.parse(JSON.stringify(recorder.recording));
    const replay = createRecorder({ replay: saved });
    const stream = await source(seam, []).load(replay);
    expect(replay.recording.effects[0]).not.toHaveProperty("streamError");
    for await (const part of stream) {
      expect(part).toEqual(chunk);
      break;
    }
    expect(replay.recording.effects[0]).not.toHaveProperty("streamError");
  });

  test("passes early return to the source without inventing an iteration error", async () => {
    const recorder = createRecorder();
    // Keep the source longer than stream prefetch so early return, rather than EOF, ends it.
    const live = source(
      seam,
      Array.from({ length: 100 }, () => chunk),
    );
    for await (const _part of await live.load(recorder)) break;
    await live.cancellation;
    expect(live.cancelled).toHaveBeenCalledOnce();
    const saved = JSON.parse(JSON.stringify(recorder.recording));
    expect(saved.effects[0].streamError).toBeUndefined();
  });
});

test("iteration errors preserve SDK identity and retry information after JSON serialization", async () => {
  const error = new APICallError({
    message: "retry later",
    url: "https://fixture.invalid",
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });
  const recorder = createRecorder();
  await consume(await source("ai-sdk", [chunk], error).load(recorder));
  const saved = JSON.parse(JSON.stringify(recorder.recording));
  const replayed = await consume(
    await source("ai-sdk", []).load(createRecorder({ replay: saved })),
  );
  expect(APICallError.isInstance(replayed.error)).toBe(true);
  expect(replayed.error).toMatchObject({
    statusCode: 503,
    isRetryable: true,
    message: "retry later",
  });
});

test("comparison distinguishes successful EOF, iteration failure and request failure", () => {
  const error = { name: "Error", message: "connection reset" };
  const effect = {
    kind: "model" as const,
    seam: "ai-sdk" as const,
    method: "doStream",
    call: 0,
    request: {},
    stream: [chunk],
  };
  const failed: Recording = { version: 1, effects: [{ ...effect, streamError: error }] };
  const successful: Recording = { version: 1, effects: [effect] };
  const requestFailed: Recording = { version: 1, effects: [{ ...effect, error }] };
  expect(compareRecordings(failed, successful).divergence?.reason).toBe("model-error");
  expect(compareRecordings(successful, failed).divergence?.reason).toBe("model-error");
  expect(compareRecordings(failed, requestFailed).divergence?.reason).toBe("model-error");
});

test("translated model answers retain their iteration error", async () => {
  const recorder = createRecorder();
  await consume(await source("ai-sdk", [chunk], new Error("connection reset")).load(recorder));
  const replay = createRecorder({
    replay: JSON.parse(JSON.stringify(recorder.recording)),
    translate: (recorded) => ({ stream: recorded.stream, streamError: recorded.streamError }),
  });
  const actual = await consume(await source("ai-sdk", []).load(replay));
  expect(actual.parts).toEqual([chunk]);
  expect(actual.error).toMatchObject({ message: "connection reset" });
});

test("cancelling an AI SDK stream with a pending read is not a provider failure", async () => {
  let start!: () => void;
  let release!: () => void;
  let stop!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const original = new ReadableStream({
    pull() {
      start();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    cancel() {
      release();
      stop();
    },
  });
  const recorder = createRecorder();
  const model = recorder.model({
    doGenerate: async (_options: unknown) => ({}),
    doStream: async (_options: unknown) => ({ stream: original }),
  });
  const reader = (await model.doStream({})).stream.getReader();
  const pending = reader.read();
  await started;
  await reader.cancel("consumer stopped");
  await stopped;
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(recorder.recording.effects[0]).not.toHaveProperty("streamError");
});

test.each(["chat", "responses"] as const)(
  "a consumer throw into %s does not become a replayed provider failure",
  async (seam) => {
    const recorder = createRecorder();
    const live = source(seam, [chunk, chunk]);
    const iterator = (await live.load(recorder))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: chunk });
    const consumerError = new Error("consumer aborted");
    await expect(iterator.throw?.(consumerError)).rejects.toBe(consumerError);
    await live.cancellation;
    expect(recorder.recording.effects[0]).not.toHaveProperty("streamError");
    const replay = createRecorder({ replay: JSON.parse(JSON.stringify(recorder.recording)) });
    expect(await consume(await source(seam, []).load(replay))).toEqual({
      parts: [chunk],
      error: undefined,
    });
  },
);

test.each(["chat", "responses"] as const)(
  "records %s iterator acquisition and result access errors at consumption",
  async (seam) => {
    for (const failure of ["factory", "next-getter", "done-getter", "value-getter"]) {
      const error = new Error(`source ${failure} failed`);
      let index = 0;
      const stream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          if (failure === "factory") throw error;
          return {
            get next() {
              if (failure === "next-getter") throw error;
              return async () => {
                if (index++ === 0) return { done: false as const, value: chunk };
                return {
                  get done() {
                    if (failure === "done-getter") throw error;
                    return false as const;
                  },
                  get value() {
                    throw error;
                  },
                };
              };
            },
          };
        },
      };
      const recorder = createRecorder();
      const live = await openaiStream(recorder, seam, async () => stream);
      const actual = await consume(live);
      const parts = failure === "factory" || failure === "next-getter" ? [] : [chunk];
      expect(actual).toEqual({ parts, error });
      const saved = JSON.parse(JSON.stringify(recorder.recording));
      expect(saved.effects[0]).toMatchObject({ streamError: { message: error.message } });
      expect(saved.effects[0].error).toBeUndefined();
      const replay = createRecorder({ replay: saved });
      const replayed = await consume(await openaiStream(replay, seam, async () => stream));
      expect(replayed.parts).toEqual(parts);
      expect(replayed.error).toMatchObject({ message: error.message });
    }
  },
);
