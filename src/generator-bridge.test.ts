import { describe, expect, test } from "vitest";
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { createGeneratorBridge, runAgent, setupAgent } from "./index.js";

/** A loop head over passes: `pass` reports `continue`, `done`, or `closed`. */
const loopMachine = setupAgent({
  context: z.object({ passes: z.number(), max: z.number() }),
  input: z.object({ max: z.number() }),
  output: z.object({ kind: z.string(), passes: z.number() }),
  actors: {
    pass: createAsyncLogic<{ kind: string }, { pass: number }>({
      run: async () => ({ kind: "done" }),
    }),
  },
}).createMachine({
  context: ({ input }) => ({ passes: 0, max: input.max }),
  initial: "head",
  states: {
    head: {
      type: "choice",
      choice: ({ context }) =>
        context.passes >= context.max ? { target: "capped" } : { target: "passing" },
    },
    passing: {
      invoke: {
        src: "pass",
        input: ({ context }) => ({ pass: context.passes }),
        onDone: ({ context, output }) => ({
          target:
            output.kind === "continue" ? "head" : output.kind === "closed" ? "closed" : "done",
          context: { ...context, passes: context.passes + 1 },
        }),
      },
    },
    capped: {
      type: "final",
      output: ({ context }) => ({ kind: "capped", passes: context.passes }),
    },
    closed: {
      type: "final",
      output: ({ context }) => ({ kind: "closed", passes: context.passes }),
    },
    done: { type: "final", output: ({ context }) => ({ kind: "done", passes: context.passes }) },
  },
});

/** A carved loop: the legacy pass is a generator, the loop head is the machine. */
function carve(
  legacyPass: (pass: number) => AsyncGenerator<string, "continue" | "done", undefined>,
  max = 3,
) {
  return async function* () {
    const bridge = createGeneratorBridge<string>();
    const pass = createAsyncLogic<{ kind: string }, { pass: number }>({
      run: async ({ input }) => {
        const step = await bridge.forward(legacyPass(input.pass));
        return { kind: step.closed ? "closed" : step.value };
      },
    });
    const result = yield* bridge.stream(
      runAgent(loopMachine, { input: { max }, actors: { pass } }),
    );
    if (result.status !== "done")
      throw result.status === "error" ? result.error : new Error("idle");
    return result.output;
  };
}

describe("createGeneratorBridge", () => {
  test("yields every pass's values in order and returns the run", async () => {
    const loop = carve(async function* (pass) {
      yield `${pass}a`;
      yield `${pass}b`;
      return pass < 1 ? "continue" : "done";
    });
    const values: string[] = [];
    const gen = loop();
    let step = await gen.next();
    while (!step.done) {
      values.push(step.value);
      step = await gen.next();
    }
    expect(values).toEqual(["0a", "0b", "1a", "1b"]);
    expect(step.value).toEqual({ kind: "done", passes: 2 });
  });

  test("the producer waits for each pull, as at `yield`", async () => {
    const log: string[] = [];
    const loop = carve(async function* () {
      log.push("before a");
      yield "a";
      log.push("after a");
      yield "b";
      return "done";
    });
    for await (const value of loop()) {
      log.push(`got ${value}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`handled ${value}`);
    }
    expect(log).toEqual(["before a", "got a", "handled a", "after a", "got b", "handled b"]);
  });

  test("a break unwinds the legacy generator before the loop exits", async () => {
    const log: string[] = [];
    const loop = carve(async function* () {
      try {
        yield "a";
        yield "b";
        return "continue";
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.push("cleaned up");
      }
    });
    for await (const value of loop()) {
      log.push(`got ${value}`);
      break;
    }
    log.push("after loop");
    expect(log).toEqual(["got a", "cleaned up", "after loop"]);
  });

  test("a stopped consumer gets the run's result and the machine sees `closed`", async () => {
    const loop = carve(async function* () {
      yield "a";
      return "continue";
    });
    const gen = loop();
    await gen.next();
    // A return completion skips the code after `yield*`: the value is the run itself.
    const step = await gen.return(undefined as never);
    expect(step.done).toBe(true);
    expect(step.value).toMatchObject({ status: "done", output: { kind: "closed", passes: 1 } });
  });

  test("a cleanup that throws after a break reaches the consumer", async () => {
    const failure = new Error("cleanup failed");
    const loop = carve(async function* () {
      try {
        yield "started";
        return "continue";
      } finally {
        // oxlint-disable-next-line no-unsafe-finally
        throw failure;
      }
    });
    const consume = async () => {
      for await (const _value of loop()) break;
    };
    await expect(consume()).rejects.toBe(failure);
  });

  test("a stream returned before its first pull still releases puts", async () => {
    const bridge = createGeneratorBridge<string>();
    let settle!: (value: string) => void;
    const gen = bridge.stream(new Promise<string>((resolve) => (settle = resolve)));
    const pending = bridge.put("event");
    await gen.return(undefined as never);
    settle("done");
    await expect(pending).resolves.toBe(false);
  });

  test("values yielded while unwinding still reach the consumer", async () => {
    const loop = carve(async function* () {
      try {
        yield "a";
        return "continue";
      } finally {
        yield "cleanup";
      }
    });
    const gen = loop();
    expect(await gen.next()).toEqual({ done: false, value: "a" });
    expect(await gen.return(undefined as never)).toEqual({ done: false, value: "cleanup" });
    expect(await gen.next()).toEqual({ done: true, value: { kind: "closed", passes: 1 } });
  });

  test("`.throw()` reaches the legacy generator", async () => {
    const loop = carve(async function* () {
      try {
        yield "a";
      } catch (error) {
        yield `caught ${(error as Error).message}`;
      }
      return "done";
    });
    const gen = loop();
    await gen.next();
    expect(await gen.throw(new Error("interrupt"))).toEqual({
      done: false,
      value: "caught interrupt",
    });
    expect(await gen.next()).toEqual({ done: true, value: { kind: "done", passes: 1 } });
  });

  test("an uncaught `.throw()` fails the run with the same error", async () => {
    const loop = carve(async function* () {
      yield "a";
      return "done";
    });
    const gen = loop();
    await gen.next();
    const interrupt = new Error("interrupt");
    await expect(gen.throw(interrupt)).rejects.toBe(interrupt);
  });

  test("a put after the run settles resolves false", async () => {
    const bridge = createGeneratorBridge<string>();
    const values: string[] = [];
    for await (const value of bridge.stream(Promise.resolve("settled"))) values.push(value);
    expect(values).toEqual([]);
    await expect(bridge.put("late")).resolves.toBe(false);
  });

  test("a put pending when the run settles is released", async () => {
    const bridge = createGeneratorBridge<string>();
    let settle!: (value: string) => void;
    const settled = new Promise<string>((resolve) => (settle = resolve));
    const gen = bridge.stream(settled);
    const first = bridge.put("a");
    expect(await gen.next()).toEqual({ done: false, value: "a" });
    const orphan = bridge.put("b");
    settle("stopped");
    await expect(orphan).resolves.toBe(false);
    expect(await gen.next()).toEqual({ done: true, value: "stopped" });
    await expect(first).resolves.toBe(true);
  });
});
