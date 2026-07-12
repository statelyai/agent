import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAgentSchemas,
  createTextLogic,
  initialAgentStep,
  resolveAgentRequests,
  setupAgent,
} from "./index.js";
import type {
  AgentDecisionExecutor,
  AgentRequestExecutor,
  AgentRequestExecutors,
} from "./index.js";

// Minimal two-request agent: first a decision (pick GO or STOP), then — on GO
// — a text request that produces a summary. Exercises both request kinds
// through the single-line step loop `resolveAgentRequests` collapses to.
function createTinyAgent() {
  const agent = setupAgent({
    schemas: createAgentSchemas({
      context: z.object({ note: z.string().nullable() }),
      output: z.object({ outcome: z.string(), note: z.string() }),
      events: {
        GO: z.object({}),
        STOP: z.object({}),
      },
    }),
    actorSources: {
      summarize: createTextLogic({
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.object({ summary: z.string() }),
        },
        model: "quick",
        prompt: ({ input }) => `Summarize ${input.topic}`,
      }),
    },
  });

  const machine = agent.createMachine({
    context: () => ({ note: null }),
    initial: "deciding",
    states: {
      deciding: {
        invoke: {
          id: "decide",
          src: "agent.decide",
          input: () => ({ model: "quick", allowedEvents: ["GO", "STOP"] as const }),
        },
        on: {
          GO: { target: "summarizing" },
          STOP: { target: "stopped" },
        },
      },
      summarizing: {
        invoke: {
          id: "summarize",
          src: "summarize",
          input: () => ({ topic: "the run" }),
          onDone: ({ output }) => ({
            target: "done",
            context: { note: output.summary },
          }),
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({ outcome: "done", note: context.note ?? "" }),
      },
      stopped: {
        type: "final",
        output: () => ({ outcome: "stopped", note: "no run" }),
      },
    },
  });

  return machine;
}

function mockExecutors(opts: { move: "GO" | "STOP"; summary?: string }): {
  executors: AgentRequestExecutors;
  calls: string[];
} {
  const calls: string[] = [];

  const decide: AgentDecisionExecutor = async (request) => {
    calls.push("decide");
    const chosen = request.events.find((event) => event.type === opts.move);
    if (!chosen) {
      throw new Error(`mock decide: '${opts.move}' is not legal here.`);
    }
    return { event: { type: opts.move } };
  };

  const generateText: AgentRequestExecutor = async () => {
    calls.push("summarize");
    return { output: { summary: opts.summary ?? "It went well." } };
  };

  return { executors: { generateText, decide }, calls };
}

describe("resolveAgentRequests", () => {
  test("two-line loop drives decision → text to done with correct outputs", async () => {
    const machine = createTinyAgent();
    const { executors, calls } = mockExecutors({ move: "GO", summary: "A fine run." });

    let step = initialAgentStep(machine);
    while (!step.done) {
      step = await resolveAgentRequests(machine, step, executors);
    }

    expect(step.snapshot.output).toEqual({ outcome: "done", note: "A fine run." });
    // Decision resolved first, then the text request, in order.
    expect(calls).toEqual(["decide", "summarize"]);
  });

  test("decision event routes the machine (STOP skips the text request)", async () => {
    const machine = createTinyAgent();
    const { executors, calls } = mockExecutors({ move: "STOP" });

    let step = initialAgentStep(machine);
    while (!step.done) {
      step = await resolveAgentRequests(machine, step, executors);
    }

    expect(step.snapshot.output).toEqual({ outcome: "stopped", note: "no run" });
    expect(calls).toEqual(["decide"]);
  });

  test("throws a clear error when the decide executor is missing", async () => {
    const machine = createTinyAgent();
    const { executors } = mockExecutors({ move: "GO" });
    const step = initialAgentStep(machine);

    await expect(
      resolveAgentRequests(machine, step, { generateText: executors.generateText }),
    ).rejects.toThrow("resolveAgentRequests: no 'decide' executor provided.");
  });

  test("throws a clear error when the generateText executor is missing", async () => {
    const machine = createTinyAgent();
    const { executors } = mockExecutors({ move: "GO" });

    // Drive past the decision to reach the text request, then drop generateText.
    let step = initialAgentStep(machine);
    step = await resolveAgentRequests(machine, step, executors);
    expect(step.requests[0]?.kind).toBe("text");

    await expect(
      resolveAgentRequests(machine, step, {
        decide: executors.decide,
      } as unknown as AgentRequestExecutors),
    ).rejects.toThrow("resolveAgentRequests: no 'generateText' executor provided.");
  });
});
