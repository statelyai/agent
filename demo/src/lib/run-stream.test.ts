import { describe, expect, test } from "vitest";
import type { TraceEntry } from "./agent-runner";
import { readRunStream, streamRun, type RunChunk } from "./run-stream";
import { createShellStore } from "./shell-store";
import { traceSteps, type TraceStep } from "./trace-view";

type Request = { id: string; src: unknown };

function transition(type: string, value: TraceEntry["value"], at: number): TraceEntry {
  return { event: { type }, value, context: {}, at, kind: "transition" };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

describe("run streams", () => {
  test("chunks arrive while the run is going, then the result", async () => {
    const release = deferred();
    const seen: RunChunk[] = [];
    const poet: Request = { id: "0.root.versing", src: "poet" };
    const stream = streamRun(async ({ onChunk }) => {
      onChunk("Eight ", { request: poet });
      onChunk("arms", { request: poet });
      await release.promise;
      return { status: "done" };
    }, new AbortController().signal);

    const result = readRunStream(stream, (chunk) => seen.push(chunk), new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Both chunks were read before the run finished.
    expect(seen.map((chunk) => chunk.delta)).toEqual(["Eight ", "arms"]);
    expect(seen[0]).toMatchObject({ key: "0.root.versing", label: "poet", call: 1 });

    release.resolve();
    await expect(result).resolves.toEqual({ status: "done" });
  });

  test("a second call of the same request is numbered apart", async () => {
    const seen: RunChunk[] = [];
    const stream = streamRun(async ({ onChunk }) => {
      onChunk("first", { request: { id: "telling", src: "tellJoke" } });
      onChunk("second", { request: { id: "telling", src: "tellJoke" } });
      return null;
    }, new AbortController().signal);
    await readRunStream(stream, (chunk) => seen.push(chunk), new AbortController().signal);
    expect(seen.map((chunk) => chunk.call)).toEqual([1, 2]);
  });

  test("steps arrive while the run is going, in the order they were recorded", async () => {
    const release = deferred();
    const entries: TraceEntry[] = [];
    const stream = streamRun(async ({ onStep }) => {
      onStep(transition("GO", "working", 5));
      onStep({ ...transition("progress", "working", 8), kind: "emitted" });
      await release.promise;
      onStep(transition("DONE", "done", 20));
      return { status: "done" };
    }, new AbortController().signal);

    const result = readRunStream(
      stream,
      () => {},
      new AbortController().signal,
      (entry) => entries.push(entry),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entries.map((entry) => entry.event.type)).toEqual(["GO", "progress"]);

    release.resolve();
    await expect(result).resolves.toEqual({ status: "done" });
    expect(entries.map((entry) => entry.event.type)).toEqual(["GO", "progress", "DONE"]);
    // The server's own elapsed times, as the settled trace will carry them.
    expect(entries.map((entry) => entry.at)).toEqual([5, 8, 20]);
  });

  test("two sessions' runs each feed only their own live log", async () => {
    const gameTurn = deferred();
    const storyTurn = deferred();
    // Interleaved on one server: the game's roll lands mid-way through the story.
    const game = streamRun(async ({ onStep }) => {
      await gameTurn.promise;
      onStep(transition("HUMAN_ROLL", { playing: "humanTurn" }, 1));
      storyTurn.resolve();
      return { status: "idle" };
    }, new AbortController().signal);
    const story = streamRun(async ({ onStep }) => {
      onStep(transition("xstate.init", "planning", 0));
      onStep(transition("OUTLINE", "writing", 2));
      gameTurn.resolve();
      await storyTurn.promise;
      onStep(transition("DRAFT", "done", 3));
      return { status: "done" };
    }, new AbortController().signal);

    // What the chat does: each run's steps append to that chat's live log.
    const read = (stream: typeof game) => {
      const live: TraceStep[] = [];
      const done = readRunStream(
        stream,
        () => {},
        new AbortController().signal,
        (entry) => live.push(...traceSteps([entry])),
      );
      return { live, done };
    };
    const gameChat = read(game);
    const storyChat = read(story);
    await Promise.all([gameChat.done, storyChat.done]);

    expect(gameChat.live.map((step) => `${step.label} → ${step.state}`)).toEqual([
      "HUMAN_ROLL → playing.humanTurn",
    ]);
    expect(storyChat.live.map((step) => step.label)).toEqual(["OUTLINE", "DRAFT"]);
  });

  test("a failed run rejects with its message", async () => {
    const stream = streamRun(async () => {
      throw new Error("Set OPENAI_API_KEY");
    }, new AbortController().signal);
    await expect(readRunStream(stream, () => {}, new AbortController().signal)).rejects.toThrow(
      "Set OPENAI_API_KEY",
    );
  });

  test("cancelling rejects at once with an AbortError and aborts the run", async () => {
    let runSignal: AbortSignal | undefined;
    const stream = streamRun(({ signal }) => {
      runSignal = signal;
      return new Promise(() => {});
    }, new AbortController().signal);
    const cancel = new AbortController();
    const result = readRunStream(stream, () => {}, cancel.signal);

    cancel.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    // Reading stopped, which cancels the stream, which aborts the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runSignal?.aborted).toBe(true);
  });
});

describe("a cancelled turn", () => {
  test("is its own status, not an error, so it renders once", () => {
    const store = createShellStore({ type: "example", id: "joke" });
    store.trigger.turnPushed({ id: 1, input: "cats", role: "user", status: "loading" });
    const { epoch } = store.getSnapshot().context;
    store.trigger.turnFailed({ epoch, id: 1, message: "Run cancelled.", cancelled: true });
    expect(store.getSnapshot().context.turns[0]).toMatchObject({ status: "cancelled" });
    expect(store.getSnapshot().context.turns[0]).not.toHaveProperty("error");
  });
});
