import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, toPromise } from "xstate";
import {
  AGENT_TRACE_SCHEMA_VERSION,
  createAgentSchemas,
  createTextLogic,
  provideExecutors,
  runAgent,
  setupAgent,
  traceTransitions,
  type AgentTraceEvent,
} from "./index.js";

/** Drops the versioned envelope fields, leaving only the trace payload. */
function stripEnvelope(event: AgentTraceEvent): Record<string, unknown> {
  const { schemaVersion, runId, seq, timestamp, machineId, machineVersion, ...payload } =
    event as AgentTraceEvent & Record<string, unknown>;
  void schemaVersion;
  void runId;
  void seq;
  void timestamp;
  void machineId;
  void machineVersion;
  return payload;
}

describe("provideExecutors", () => {
  test("binds a mode:'generate' text source to generateText (end-to-end createActor run, typed output)", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string(), draft: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ draft: z.string() }),
    });
    const draftText = createTextLogic({
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.topic,
    });
    const agent = setupAgent({ schemas, actorSources: { draftText } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, draft: null }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            src: "draftText",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({ target: "done", context: { draft: output } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
      },
    });

    const seen: string[] = [];
    const bound = provideExecutors(machine, {
      generateText: async (request) => {
        seen.push(request.prompt ?? "");
        return { output: "a draft about cats" };
      },
    });

    const actor = createActor(bound, { input: { topic: "cats" } });
    actor.start();
    const output = await toPromise(actor);

    expect(output).toEqual({ draft: "a draft about cats" });
    expect(seen).toEqual(["cats"]);
  });

  test("binds a mode:'stream' text source to streamText and threads onChunk", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string(), streamed: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ streamed: z.string() }),
    });
    const streamDraft = createTextLogic({
      mode: "stream",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.topic,
    });
    const agent = setupAgent({ schemas, actorSources: { streamDraft } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, streamed: null }),
      initial: "streaming",
      states: {
        streaming: {
          invoke: {
            src: "streamDraft",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({ target: "done", context: { streamed: output as string } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ streamed: context.streamed ?? "" }) },
      },
    });

    const chunks: string[] = [];
    const bound = provideExecutors(
      machine,
      {
        generateText: async () => ({ output: "" }),
        streamText: async (_request, info) => {
          info?.onChunk?.("he");
          info?.onChunk?.("llo");
          return { output: "hello" };
        },
      },
      { onChunk: (chunk) => chunks.push(chunk) },
    );

    const actor = createActor(bound, { input: { topic: "dogs" } });
    actor.start();
    const output = await toPromise(actor);

    expect(output).toEqual({ streamed: "hello" });
    expect(chunks).toEqual(["he", "llo"]);
  });

  test("binds an agent.decide source to decide and auto-delivers the chosen event", async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      events: { ATTACK: z.object({}), FLEE: z.object({}) },
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: { model: "test-model", allowedEvents: ["ATTACK", "FLEE"] as const },
          },
          on: { ATTACK: { target: "attacked" }, FLEE: { target: "fled" } },
        },
        attacked: { type: "final" },
        fled: { type: "final" },
      },
    });

    const bound = provideExecutors(machine, {
      generateText: async () => ({ output: "" }),
      decide: async () => ({ event: { type: "ATTACK" } }),
    });

    const actor = createActor(bound, { input: {} });
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().value).toBe("attacked");
  });

  test("throws at bind time when a required executor kind is missing", () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      events: { ATTACK: z.object({}) },
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: { model: "test-model", allowedEvents: ["ATTACK"] as const },
          },
          on: { ATTACK: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    expect(() => provideExecutors(machine, { generateText: async () => ({ output: "" }) })).toThrow(
      /no 'decide' executor/,
    );
  });

  test("merges options.actorSources before binding; an executor-bound override is left as-is", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ draft: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ draft: z.string() }),
    });
    const draftText = createTextLogic({
      schemas: { input: z.object({}), output: z.string() },
      model: "test-model",
      prompt: "draft",
    });
    const agent = setupAgent({ schemas, actorSources: { draftText } });
    const machine = agent.createMachine({
      context: () => ({ draft: null }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            src: "draftText",
            input: {},
            onDone: ({ output }) => ({ target: "done", context: { draft: output as string } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
      },
    });

    // The override carries its own executor, so provideExecutors must leave it
    // untouched rather than rebinding it to `executors.generateText`.
    const bound = provideExecutors(
      machine,
      { generateText: async () => ({ output: "from executors.generateText" }) },
      {
        actorSources: { draftText: draftText.withExecutor(async () => ({ output: "overridden" })) },
      },
    );

    const actor = createActor(bound, { input: {} });
    actor.start();
    const output = await toPromise(actor);

    expect(output).toEqual({ draft: "overridden" });
  });
});

describe("provideExecutors onTrace / traceTransitions", () => {
  // A tiny one-request machine, reused across the parity tests. The invoke
  // carries an explicit `id` so both paths mint the same request id.
  const buildStreamMachine = () => {
    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string(), streamed: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ streamed: z.string() }),
    });
    const streamDraft = createTextLogic({
      mode: "stream",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.topic,
    });
    const agent = setupAgent({ schemas, actorSources: { streamDraft } });
    return agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, streamed: null }),
      initial: "streaming",
      states: {
        streaming: {
          invoke: {
            id: "draft",
            src: "streamDraft",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({ target: "done", context: { streamed: output as string } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ streamed: context.streamed ?? "" }) },
      },
    });
  };

  const streamExecutors = () => ({
    generateText: async () => ({ output: "" }),
    streamText: async (_request: unknown, info?: { onChunk?: (chunk: string) => void }) => {
      info?.onChunk?.("he");
      info?.onChunk?.("llo");
      return { output: "hello" };
    },
  });

  const requestTypes = new Set(["request.start", "request.end", "stream.chunk"]);

  test("request.start/request.end/stream.chunk shapes are identical to runAgent (modulo envelope)", async () => {
    // One shared machine instance, so `request.input.outputSchema` (a schema
    // object holding functions) is reference-identical across both paths.
    const machine = buildStreamMachine();

    const runTrace: AgentTraceEvent[] = [];
    await runAgent(machine, {
      input: { topic: "cats" },
      executors: streamExecutors(),
      onTrace: (event) => runTrace.push(event as AgentTraceEvent),
    });

    const provideTrace: AgentTraceEvent[] = [];
    const bound = provideExecutors(machine, streamExecutors(), {
      onTrace: (event) => provideTrace.push(event as AgentTraceEvent),
    });
    const actor = createActor(bound, { input: { topic: "cats" } });
    actor.start();
    await toPromise(actor);

    const runRequests = runTrace.filter((e) => requestTypes.has(e.type)).map(stripEnvelope);
    const provideRequests = provideTrace.filter((e) => requestTypes.has(e.type)).map(stripEnvelope);

    // Same request lifecycle, same shapes.
    expect(provideRequests.map((e) => e.type)).toEqual([
      "request.start",
      "stream.chunk",
      "stream.chunk",
      "request.end",
    ]);
    expect(provideRequests).toEqual(runRequests);
  });

  test("uncontrolled stream has contiguous seq starting at 1, including transition events", async () => {
    const trace: AgentTraceEvent[] = [];
    const push = (event: AgentTraceEvent) => trace.push(event);

    const bound = provideExecutors(buildStreamMachine(), streamExecutors(), { onTrace: push });
    const actor = createActor(bound, { inspect: traceTransitions(push), input: { topic: "cats" } });
    actor.start();
    await toPromise(actor);

    // One unified stream: a single runId, seq contiguous from 1.
    expect(new Set(trace.map((e) => e.runId)).size).toBe(1);
    const seqs = trace.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: trace.length }, (_, i) => i + 1));

    // Both request-level and transition events participate; no run boundary.
    expect(trace.some((e) => e.type === "machine.transition")).toBe(true);
    expect(trace.some((e) => e.type === "request.start")).toBe(true);
    expect(trace.some((e) => e.type === "run.start" || e.type === "run.end")).toBe(false);

    // Every event carries the versioned schema stamp.
    for (const event of trace) {
      expect(event.schemaVersion).toBe(AGENT_TRACE_SCHEMA_VERSION);
    }
  });

  test("two concurrent actors from one bound machine get distinct runIds and independent seq", async () => {
    const trace: AgentTraceEvent[] = [];
    const bound = provideExecutors(buildStreamMachine(), streamExecutors(), {
      onTrace: (event) => trace.push(event as AgentTraceEvent),
    });

    const actorA = createActor(bound, { input: { topic: "a" } });
    const actorB = createActor(bound, { input: { topic: "b" } });
    actorA.start();
    actorB.start();
    await Promise.all([toPromise(actorA), toPromise(actorB)]);

    const runIds = [...new Set(trace.map((e) => e.runId))];
    expect(runIds.length).toBe(2);

    // Each actor's request stream is independently numbered from 1.
    for (const runId of runIds) {
      const seqs = trace
        .filter((e) => e.runId === runId)
        .map((e) => e.seq)
        .sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    }
  });
});
