import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic, createMachine } from "xstate";
import { setupAgent } from "./index.js";
import { canReach, explorePaths } from "./testing/index.js";

// A loop of up to three turns the host can PAUSE, RESUME, and STOP while a
// turn runs. With `honorStop: false`, a stopped loop starts another turn.
function createPausableLoop({ honorStop = true } = {}) {
  const agent = setupAgent({
    context: z.object({ turns: z.number(), paused: z.boolean(), stopped: z.boolean() }),
    events: { PAUSE: z.object({}), RESUME: z.object({}), STOP: z.object({}) },
    actors: {
      turn: createAsyncLogic<{ ok: boolean }>({ run: async () => ({ ok: true }) }),
    },
  });
  const flags = {
    PAUSE: ({ context }: { context: { turns: number; paused: boolean; stopped: boolean } }) => ({
      context: { ...context, paused: true },
    }),
    RESUME: ({ context }: { context: { turns: number; paused: boolean; stopped: boolean } }) => ({
      context: { ...context, paused: false },
    }),
    STOP: ({ context }: { context: { turns: number; paused: boolean; stopped: boolean } }) => ({
      context: { ...context, stopped: true },
    }),
  };
  return agent.createMachine({
    context: { turns: 0, paused: false, stopped: false },
    initial: "running",
    states: {
      running: {
        invoke: {
          src: "turn",
          onDone: ({ context }) => ({
            target: "checking",
            context: { ...context, turns: context.turns + 1 },
          }),
        },
        on: flags,
      },
      checking: {
        type: "choice",
        choice: ({ context }) =>
          honorStop && context.stopped
            ? { target: "stopped" }
            : context.turns >= 3
              ? { target: "finished" }
              : context.paused
                ? { target: "paused" }
                : { target: "running" },
      },
      paused: { on: { ...flags, RESUME: { target: "checking", context: undefined } } },
      stopped: { type: "final" },
      finished: { type: "final" },
    },
  });
}

const options = {
  outputs: { turn: [{ ok: true }] },
  interleave: "pending" as const,
  maxDepth: 80,
  maxPaths: 100_000,
};
const noTurnAfterStop = {
  after: "STOP",
  reach: (step: { started: string[] }) => step.started.includes("turn"),
};

describe("canReach — default key", () => {
  test("an interleaved search with no dedupeBy finishes and proves the rule", async () => {
    const explored = await explorePaths(createPausableLoop(), { ...options, maxDepth: 8 });
    // Every path in full: the interleavings outgrow the caps.
    expect(explored.complete).toBe(false);

    const started = performance.now();
    const result = await canReach(createPausableLoop(), noTurnAfterStop, options);
    expect(result).toMatchObject({ reachable: false, complete: true });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("still finds the violation a mutant allows", async () => {
    const result = await canReach(
      createPausableLoop({ honorStop: false }),
      noTurnAfterStop,
      options,
    );
    expect(result.reachable).toBe(true);
  });

  test("a loop over finitely many states is a complete search", async () => {
    const loop = createMachine({
      initial: "a",
      states: {
        a: { on: { NEXT: { target: "b" } } },
        b: { on: { NEXT: { target: "a" } } },
        never: {},
      },
    });
    expect(await canReach(loop, "never", { maxDepth: 50 })).toMatchObject({
      reachable: false,
      complete: true,
    });
  });

  test("context that is not plain data is not merged", async () => {
    // JSON writes every Map as `{}`, which would merge these states.
    const machine = createMachine({
      context: { m: new Map<number, number>() },
      initial: "idle",
      states: {
        idle: {
          on: {
            ADD: ({ context }) => ({
              context: { m: new Map([...context.m, [context.m.size, 1]]) },
            }),
          },
        },
      },
    });
    const result = await canReach(machine, (snapshot) => snapshot.context.m.size >= 2, {
      maxDepth: 3,
    });
    expect(result.reachable).toBe(true);
  });
});
