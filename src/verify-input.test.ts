import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createMachine } from "xstate";
import { AgentError } from "./errors.js";
import { setupAgent } from "./index.js";
import { canReach, explorePaths, simulateAgent } from "./testing/index.js";

// A capped loop: STEP is accepted while `n < max`.
function capped() {
  const agent = setupAgent({
    context: z.object({ n: z.number(), max: z.number() }),
    input: z.object({ max: z.number().default(2) }),
    events: { STEP: {} },
  });
  return agent.createMachine({
    context: ({ input }) => ({ n: 0, max: input.max }),
    initial: "loop",
    states: {
      loop: {
        on: {
          STEP: ({ context }) =>
            context.n < context.max
              ? { target: "loop", context: { ...context, n: context.n + 1 } }
              : undefined,
        },
      },
    },
  });
}

const overCap = (snapshot: { context: { n: number; max: number } }) =>
  snapshot.context.n > snapshot.context.max;

describe("verification validates machine input", () => {
  test("canReach rejects input the machine schema rejects", async () => {
    const error = await canReach(capped(), overCap as never, {
      input: { max: "2" },
      maxDepth: 6,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("invalid-machine-input");
    expect((error as AgentError).message).toMatch(/^canReach: /);
  });

  test("explorePaths and simulateAgent reject it too", async () => {
    await expect(explorePaths(capped(), { input: { max: "2" } })).rejects.toMatchObject({
      code: "invalid-machine-input",
      message: expect.stringMatching(/^explorePaths: /),
    });
    await expect(
      simulateAgent(capped(), { input: { max: "2" }, script: {} }),
    ).rejects.toMatchObject({
      code: "invalid-machine-input",
      message: expect.stringMatching(/^simulateAgent: /),
    });
  });

  test("the search starts from the parsed input, with defaults filled", async () => {
    // `{}` parses to `{ max: 2 }`: the loop reaches n = 2 and no further.
    const atCap = await canReach(
      capped(),
      ((snapshot: { context: { n: number } }) => snapshot.context.n === 2) as never,
      { input: {}, maxDepth: 6 },
    );
    expect(atCap.reachable).toBe(true);
    const beyond = await canReach(capped(), overCap as never, { input: {}, maxDepth: 6 });
    expect(beyond).toMatchObject({ reachable: false });
  });

  test("valid input proves as before, and omitted input is not validated", async () => {
    const result = await canReach(capped(), overCap as never, { input: { max: 2 }, maxDepth: 6 });
    expect(result).toMatchObject({ reachable: false });
    // A plain machine has no input schema: input passes through.
    const plain = createMachine({ initial: "a", states: { a: {} } });
    await expect(explorePaths(plain, { input: { anything: true } })).resolves.toBeDefined();
  });
});
