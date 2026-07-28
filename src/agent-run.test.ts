import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAgentRun } from "./agent-run.js";
import {
  createAgentSchemas,
  createTextLogic,
  runAgent,
  setupAgent,
  type AgentTextRequest,
  type AgentTools,
  type AgentTraceEvent,
} from "./index.js";

// A one-request streaming machine: `writing` invokes a `mode: 'stream'` text
// request, then completes with the streamed joke. Shared by the ordering,
// composition, slow-consumer, and early-break tests so a `stream.chunk` event
// is present in the stream.
function buildStreamMachine() {
  const agent = setupAgent({
    context: z.object({ joke: z.string().nullable() }),
    output: z.object({ joke: z.string() }),
    requests: {
      joke: {
        schemas: { input: z.object({}), output: z.string() },
        model: "m",
        mode: "stream",
        prompt: () => "joke",
      },
    },
  });

  return agent.createMachine({
    context: { joke: null },
    initial: "writing",
    states: {
      writing: {
        invoke: {
          src: "joke",
          input: () => ({}),
          onDone: ({ output }) => ({ target: "done", context: { joke: output } }),
        },
      },
      done: { type: "final", output: ({ context }) => ({ joke: context.joke ?? "" }) },
    },
  });
}

describe("createAgentRun", () => {
  test("streams events in runAgent's emission order, ending after run.end", async () => {
    const machine = buildStreamMachine();
    const run = createAgentRun(machine, {
      executors: {
        generateText: async () => ({ output: "" }),
        streamText: async (_request, info) => {
          info?.onChunk?.("knock ");
          info?.onChunk?.("knock");
          return { output: "knock knock" };
        },
      },
    });

    const events: AgentTraceEvent<typeof machine>[] = [];
    for await (const event of run.events) {
      events.push(event);
    }
    const result = await run.result;

    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({ joke: "knock knock" });

    const types = events.map((event) => event.type);
    expect(types[0]).toBe("run.start");
    expect(types.at(-1)).toBe("run.end");

    const reqStart = types.indexOf("request.start");
    const firstChunk = types.indexOf("stream.chunk");
    const reqEnd = types.indexOf("request.end");
    expect(reqStart).toBeGreaterThanOrEqual(0);
    expect(firstChunk).toBeGreaterThan(reqStart);
    expect(reqEnd).toBeGreaterThan(firstChunk);
    expect(types.lastIndexOf("machine.transition")).toBeGreaterThan(reqEnd);

    // The streamed events carry runAgent's own monotonic seq (1..n), in order.
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  });

  test("slow consumer: awaiting result first still drains every buffered event", async () => {
    const machine = buildStreamMachine();
    const run = createAgentRun(machine, {
      executors: {
        generateText: async () => ({ output: "" }),
        streamText: async (_request, info) => {
          info?.onChunk?.("a");
          info?.onChunk?.("b");
          return { output: "ab" };
        },
      },
    });

    // Consume the result BEFORE touching `events`: the run has fully settled,
    // yet the unbounded buffer must have held every event, including run.end.
    const result = await run.result;
    expect(result.status).toBe("done");

    const events: AgentTraceEvent<typeof machine>[] = [];
    for await (const event of run.events) {
      events.push(event);
    }

    const types = events.map((event) => event.type);
    expect(types[0]).toBe("run.start");
    expect(types.at(-1)).toBe("run.end");
    expect(types).toContain("stream.chunk");
  });

  test("composes options.onTrace: the caller's sink sees the same events the iterator yields", async () => {
    const machine = buildStreamMachine();
    const sink: AgentTraceEvent<typeof machine>[] = [];

    const run = createAgentRun(machine, {
      onTrace: (event) => sink.push(event),
      executors: {
        generateText: async () => ({ output: "" }),
        streamText: async (_request, info) => {
          info?.onChunk?.("x");
          return { output: "x" };
        },
      },
    });

    const yielded: AgentTraceEvent<typeof machine>[] = [];
    for await (const event of run.events) {
      yielded.push(event);
    }
    await run.result;

    expect(yielded).toEqual(sink);
    expect(sink.at(-1)?.type).toBe("run.end");
  });

  test("resume: streams the resumed run from its own run.start to run.end done", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), draft: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ draft: z.string() }),
      events: { APPROVE: z.object({}) },
    });

    const draftText = createTextLogic({
      schemas: { input: z.object({ prompt: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.prompt,
    });

    const agent = setupAgent({ schemas, actors: { draftText } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            id: "draft",
            src: "draftText",
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({ target: "awaitingApproval", context: { draft: output } }),
          },
        },
        awaitingApproval: {
          on: { APPROVE: { target: "done" } },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ draft: context.draft ?? "" }),
        },
      },
    });

    const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => ({
      output: `Draft: ${request.prompt}`,
    });

    // Run to idle, persist the snapshot.
    const first = await runAgent(machine, {
      input: { prompt: "notes" },
      executors: { generateText },
    });
    expect(first.status).toBe("idle");
    if (first.status !== "idle") {
      throw new Error("expected idle");
    }

    // Resume via createAgentRun with the persisted snapshot + resume event.
    const run = createAgentRun(machine, {
      snapshot: first.snapshot,
      event: { type: "APPROVE" },
      executors: { generateText },
    });

    const events: AgentTraceEvent<typeof machine>[] = [];
    for await (const event of run.events) {
      events.push(event);
    }
    const result = await run.result;

    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({ draft: "Draft: notes" });

    expect(events[0]?.type).toBe("run.start");
    const last = events.at(-1);
    expect(last?.type).toBe("run.end");
    expect(last?.type === "run.end" ? last.status : undefined).toBe("done");
  });

  test("early break stops delivery but not the run; result still settles", async () => {
    const machine = buildStreamMachine();
    const run = createAgentRun(machine, {
      executors: {
        generateText: async () => ({ output: "" }),
        streamText: async () => ({ output: "done" }),
      },
    });

    const seen: AgentTraceEvent<typeof machine>[] = [];
    for await (const event of run.events) {
      seen.push(event);
      break; // bail after the very first event
    }

    // The run keeps going despite the abandoned iterator.
    const result = await run.result;
    expect(result.status).toBe("done");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("run.start");
  });

  test("error run: iterator ends with run.end status error and result resolves", async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.object({}) },
      model: "test-model",
    });
    const agent = setupAgent({ schemas, actors: { step } });
    const machine = agent.createMachine({
      context: {},
      initial: "working",
      states: {
        working: {
          invoke: { id: "step", src: "step", input: {}, onDone: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    const run = createAgentRun(machine, {
      input: {},
      executors: {
        generateText: async () => {
          throw new Error("boom");
        },
      },
    });

    const events: AgentTraceEvent<typeof machine>[] = [];
    for await (const event of run.events) {
      events.push(event);
    }
    // The failure surfaces as a resolved error result, not a rejection.
    const result = await run.result;

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("machine");

    const last = events.at(-1);
    expect(last?.type).toBe("run.end");
    expect(last?.type === "run.end" ? last.status : undefined).toBe("error");
  });
});
