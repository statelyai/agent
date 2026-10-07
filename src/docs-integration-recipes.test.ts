import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { Snapshot } from "xstate";
import { createAgentRuntime, runToQuiescence, setupAgent } from "./index.js";

describe("documentation integration recipes", () => {
  test("an app can store an opaque snapshot and resume it with an event", async () => {
    const agent = setupAgent({
      context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ answer: z.string() }),
      events: { ANSWER: z.object({ answer: z.string() }) },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, answer: null }),
      initial: "waiting",
      states: {
        waiting: {
          on: {
            ANSWER: ({ event }) => ({
              target: "done",
              context: { answer: event.answer },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({
            answer: `${context.prompt}: ${context.answer}`,
          }),
        },
      },
    });

    async function startGeneration(input: { prompt: string }): Promise<{ snapshot: unknown }> {
      const result = await runToQuiescence(createAgentRuntime(machine), { input });
      if (result.status !== "idle") throw new Error(`Expected idle, got ${result.status}`);
      return { snapshot: result.persist() };
    }

    async function resumeGeneration(snapshot: unknown, answer: string): Promise<string> {
      const result = await runToQuiescence(createAgentRuntime(machine), {
        snapshot: snapshot as Snapshot<unknown>,
        event: { type: "ANSWER", answer },
      });
      if (result.status !== "done") throw new Error(`Expected done, got ${result.status}`);
      return result.output.answer;
    }

    const stored = JSON.parse(JSON.stringify(await startGeneration({ prompt: "Ship" })));
    await expect(resumeGeneration(stored.snapshot, "Approved")).resolves.toBe("Ship: Approved");
  });
});
