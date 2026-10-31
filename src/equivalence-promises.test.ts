import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { createRecorder } from "./testing/index.js";

const asyncResults: [string, (promise: Promise<unknown>) => PromiseLike<unknown>][] = [
  ["native Promise", (promise) => promise],
  ["thenable", (promise) => ({ then: promise.then.bind(promise) })],
  [
    "callable thenable",
    (promise) => Object.assign(() => undefined, { then: promise.then.bind(promise) }),
  ],
  ["cross-realm Promise", (promise) => runInNewContext("Promise.resolve(promise)", { promise })],
];

describe.each(asyncResults)("recording tools returning a %s", (_name, wrap) => {
  test("records the settled value and replays asynchronously without executing the tool", async () => {
    const recorder = createRecorder();
    const result = recorder.tool("lookup", () => wrap(Promise.resolve({ answer: 42 })))();
    await expect(result).resolves.toEqual({ answer: 42 });
    const recording = JSON.parse(JSON.stringify(recorder.recording));
    expect(recording.effects[0]).toMatchObject({ output: { answer: 42 } });
    expect(recording.effects[0].sync).toBeUndefined();

    const live = vi.fn(() => Promise.resolve("must not execute"));
    const replay = createRecorder({ replay: recording });
    const replayed = replay.tool("lookup", live)();
    expect(replayed).toBeInstanceOf(Promise);
    await expect(replayed).resolves.toEqual({ answer: 42 });
    expect(live).not.toHaveBeenCalled();
  });

  test("records rejections and replays them asynchronously", async () => {
    const recorder = createRecorder();
    const error = new TypeError("lookup failed");
    await expect(recorder.tool("lookup", () => wrap(Promise.reject(error)))()).rejects.toBe(error);
    const recording = JSON.parse(JSON.stringify(recorder.recording));
    expect(recording.effects[0]).toMatchObject({
      error: { name: "TypeError", message: "lookup failed" },
    });
    expect(recording.effects[0].sync).toBeUndefined();

    const live = vi.fn(() => Promise.resolve("must not execute"));
    const replayed = createRecorder({ replay: recording }).tool("lookup", live)();
    expect(replayed).toBeInstanceOf(Promise);
    await expect(replayed).rejects.toMatchObject({ name: "TypeError", message: "lookup failed" });
    expect(live).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "tracks overlapping calls until settlement (reject: %s)",
    async (reject) => {
      const recorder = createRecorder();
      let resolve!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise((res, rej) => {
        resolve = res;
        fail = rej;
      });
      const result = recorder.tool("wait", () => wrap(pending))();
      const settled = Promise.resolve(result).catch(() => undefined);
      expect(recorder.tool("overlap", () => 1)()).toBe(1);
      if (reject) fail(new Error("failed"));
      else resolve(42);
      await settled;
      expect(recorder.tool("later", () => 2)()).toBe(2);
      expect(
        recorder.recording.effects.map((effect) => effect.kind === "tool" && effect.concurrent),
      ).toEqual([undefined, true, undefined]);
    },
  );
});

test("ordinary values, including a non-callable then property, stay synchronous", () => {
  for (const value of [undefined, null, 0, "answer", { then: "metadata", answer: 42 }]) {
    const recorder = createRecorder();
    expect(recorder.tool("lookup", () => value)()).toBe(value);
    const recording = JSON.parse(JSON.stringify(recorder.recording));
    expect(recording.effects[0].sync).toBe(true);
    expect(createRecorder({ replay: recording }).tool("lookup", () => undefined)()).toEqual(value);
  }
});

test("ordinary throws stay synchronous during recording and replay", () => {
  const recorder = createRecorder();
  const error = new TypeError("invalid input");
  expect(() =>
    recorder.tool("lookup", () => {
      throw error;
    })(),
  ).toThrow(error);
  const recording = JSON.parse(JSON.stringify(recorder.recording));
  expect(recording.effects[0].sync).toBe(true);
  expect(() => createRecorder({ replay: recording }).tool("lookup", () => undefined)()).toThrow(
    "invalid input",
  );
});
