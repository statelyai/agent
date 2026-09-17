import { describe, expect, test } from "vitest";
import { z } from "zod";
import { setupAgent, runAgent } from "@statelyai/agent";
import { createWalkthroughExecutors, synthesize } from "./walkthrough-executors";

describe("synthesize", () => {
  test("fills an object schema with typed, named placeholders", () => {
    const value = synthesize(
      {
        type: "object",
        properties: {
          reason: { type: "string" },
          score: { type: "integer", minimum: 0, maximum: 10 },
          ok: { type: "boolean" },
          sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
          missing: { type: "array", items: { type: "string" } },
          steps: { type: "array", items: { type: "string" } },
          email: { type: "string", format: "email" },
        },
      },
      "",
      "the customer is furious about a negative balance",
    ) as Record<string, unknown>;
    expect(value.reason).toMatch(/rationale/i);
    expect(value.score).toBe(10);
    expect(value.ok).toBe(true);
    // The enum value the prompt mentions wins over the first one.
    expect(value.sentiment).toBe("negative");
    // Problem lists stay empty; work lists get entries to fan out over.
    expect(value.missing).toEqual([]);
    expect(value.steps).toHaveLength(2);
    expect(value.email).toBe("someone@example.com");
  });

  test("lifts amounts and ids the prompt already carries", () => {
    const value = synthesize(
      {
        type: "object",
        properties: { orderId: { type: "string" }, amountCents: { type: "number" } },
      },
      "",
      "Refund me $60 for order #8891.",
    ) as Record<string, unknown>;
    expect(value).toEqual({ orderId: "8891", amountCents: 6000 });
  });

  test("prefers the non-null branch of a nullable union", () => {
    expect(synthesize({ anyOf: [{ type: "string" }, { type: "null" }] }, "title")).toBe(
      "Placeholder title",
    );
  });
});

describe("createWalkthroughExecutors", () => {
  const setup = setupAgent({
    context: z.object({ asked: z.number(), answer: z.string().nullable() }),
    input: z.object({}),
    output: z.object({ asked: z.number(), answer: z.string() }),
    events: { ASK: z.object({ question: z.string() }), FINISH: z.object({ answer: z.string() }) },
    requests: {
      grade: {
        schemas: { input: z.object({ text: z.string() }), output: z.object({ score: z.number() }) },
        model: "any",
        prompt: ({ input }) => input.text,
      },
    },
  });
  const machine = setup.createMachine({
    context: { asked: 0, answer: null },
    initial: "deciding",
    states: {
      deciding: {
        invoke: {
          src: "agent.decide",
          input: { model: "any", prompt: "Ask or finish.", allowedEvents: ["ASK", "FINISH"] },
        },
        on: {
          // Via a choice state: a self-target would not restart the invoke.
          ASK: ({ context }) => ({ target: "noting", context: { asked: context.asked + 1 } }),
          FINISH: ({ event }) => ({ target: "grading", context: { answer: event.answer } }),
        },
      },
      noting: { type: "choice", choice: () => ({ target: "deciding" }) },
      grading: {
        invoke: {
          src: "grade",
          input: ({ context }) => ({ text: context.answer ?? "" }),
          onDone: { target: "done" },
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({ asked: context.asked, answer: context.answer ?? "" }),
      },
    },
  });

  test("rotates a decision through its legal events so a loop ends", async () => {
    const result = await runAgent(machine, { input: {}, executors: createWalkthroughExecutors() });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    // First turn ASK, second turn FINISH: one question asked, then done.
    expect(result.output.asked).toBe(1);
    expect(result.output.answer).toMatch(/^Placeholder/);
  });

  test("picks by the decision's prompt, so a changing prompt rotates with no shared state", async () => {
    const request = (prompt: string) => ({
      kind: "decision" as const,
      id: "0.(machine).deciding",
      name: "deciding",
      model: "any",
      input: {},
      prompt,
      events: ["A", "B", "C"].map((type) => ({ type, toolName: `send_event_${type}` })),
      attempts: [],
    });
    // Two visitors with fresh executor sets and the same prompt agree, and
    // neither advances the other: the pick is a function of the prompt.
    const alice = createWalkthroughExecutors();
    const bob = createWalkthroughExecutors();
    const first = (await alice.decide!(request("turn one"))).event.type;
    expect((await bob.decide!(request("turn one"))).event.type).toBe(first);
    // Within one run the same prompt rotates, so a re-asking loop ends.
    const second = (await alice.decide!(request("turn one"))).event.type;
    expect(second).not.toBe(first);
  });

  test("fits strings to length bounds and tries plain candidates against a pattern", () => {
    const value = synthesize({
      type: "object",
      properties: {
        code: { type: "string", pattern: "^[A-Z]{3}-\\d+$" },
        short: { type: "string", maxLength: 5 },
        long: { type: "string", minLength: 40 },
      },
    }) as Record<string, string>;
    expect(value.code).toBe("ABC-123");
    expect(value.short.length).toBeLessThanOrEqual(5);
    expect(value.long.length).toBeGreaterThanOrEqual(40);
  });

  test("does not nest placeholders when a placeholder is fed back into a prompt", async () => {
    const executors = createWalkthroughExecutors();
    const one = await executors.generateText!(
      { name: "tell", model: "any", prompt: "Tell a joke about penguins.", tools: {} },
      undefined,
    );
    const two = await executors.generateText!(
      {
        name: "improve",
        model: "any",
        prompt: `Improve this joke: ${String(one.result)}`,
        tools: {},
      },
      undefined,
    );
    expect(String(two.result)).not.toMatch(/Placeholder .* Placeholder/);
  });
});
