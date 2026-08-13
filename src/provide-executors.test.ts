import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, toPromise } from "xstate";
import {
  AGENT_TRACE_SCHEMA_VERSION,
  AGENT_USAGE_EVENT_TYPE,
  createAgentSchemas,
  createTextLogic,
  provideExecutors,
  runAgent,
  setupAgent,
  traceTransitions,
  type AgentTraceEvent,
  type ChosenEvent,
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
    const agent = setupAgent({ schemas, actors: { draftText } });
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
    const agent = setupAgent({ schemas, actors: { streamDraft } });
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

  test("merges options.actors before binding; an executor-bound override is left as-is", async () => {
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
    const agent = setupAgent({ schemas, actors: { draftText } });
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
        actors: { draftText: draftText.withExecutor(async () => ({ output: "overridden" })) },
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
    const agent = setupAgent({ schemas, actors: { streamDraft } });
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

  test("a declared createMachine({ version }) is stamped on uncontrolled trace envelopes", async () => {
    const draftText = createTextLogic({
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.topic,
    });
    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string() }),
      input: z.object({ topic: z.string() }),
    });
    const machine = setupAgent({ schemas, actors: { draftText } }).createMachine({
      version: "7",
      context: ({ input }: { input: { topic: string } }) => ({ topic: input.topic }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            src: "draftText",
            input: ({ context }: { context: { topic: string } }) => ({ topic: context.topic }),
            onDone: { target: "done" },
          },
        },
        done: { type: "final" },
      },
    } as never);

    const trace: AgentTraceEvent[] = [];
    const push = (event: AgentTraceEvent) => trace.push(event);
    const bound = provideExecutors(
      machine,
      {
        generateText: async () => ({ output: "ok" }),
      } as never,
      { onTrace: push },
    );
    const actor = createActor(bound, { inspect: traceTransitions(push), input: { topic: "cats" } });
    actor.start();
    await toPromise(actor);

    expect(trace.length).toBeGreaterThan(0);
    for (const event of trace) {
      expect(event.machineVersion).toBe("7");
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

describe("provideExecutors + '@agent.usage'", () => {
  const usageSchemas = createAgentSchemas({
    input: z.object({ maxTokens: z.number() }),
    context: z.object({
      notes: z.array(z.string()),
      tokens: z.number(),
      maxTokens: z.number(),
      seen: z.array(z.string()),
    }),
    output: z.object({ notes: z.array(z.string()), tokens: z.number() }),
  });
  const researchStep = createTextLogic({
    name: "researchStep",
    schemas: { input: z.object({ turn: z.number() }), output: z.string() },
    model: "test-model",
    prompt: ({ input }) => `Turn ${input.turn}.`,
  });
  const usageAgent = setupAgent({ schemas: usageSchemas, actors: { researchStep } });

  const buildBudgetMachine = (declareUsage: boolean) =>
    usageAgent.createMachine({
      context: ({ input }) => ({ notes: [], tokens: 0, maxTokens: input.maxTokens, seen: [] }),
      on: declareUsage
        ? {
            [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
              context: {
                tokens: context.tokens + (event.usage.totalTokens ?? 0),
                seen: [
                  ...context.seen,
                  `${event.kind ?? "?"}:${event.id ?? "?"}:${event.model ?? "?"}`,
                ],
              },
            }),
          }
        : {
            "*": ({ context, event }) => ({ context: { seen: [...context.seen, event.type] } }),
          },
      initial: "researching",
      states: {
        researching: {
          invoke: {
            id: "research",
            src: "researchStep",
            input: ({ context }) => ({ turn: context.notes.length + 1 }),
            onDone: ({ context, output }) => ({
              target: "checkingBudget",
              context: { notes: [...context.notes, output] },
            }),
          },
        },
        checkingBudget: {
          always: ({ context }) =>
            context.tokens >= context.maxTokens ? { target: "done" } : { target: "researching" },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ notes: context.notes, tokens: context.tokens }),
        },
      },
    });

  const usageExecutors = {
    generateText: async () => ({ output: "a fact", usage: { totalTokens: 400, inputTokens: 300 } }),
  };

  test("delivers a settled call's usage to the invoking machine actor, so a guard can stop it", async () => {
    const bound = provideExecutors(buildBudgetMachine(true), usageExecutors);
    const actor = createActor(bound, { input: { maxTokens: 1000 } });
    actor.start();
    const output = await toPromise(actor);

    // 3 calls x 400 tokens = 1200 >= 1000: the budget guard stopped the loop.
    expect(output).toEqual({ notes: ["a fact", "a fact", "a fact"], tokens: 1200 });
    // Same attribution payload runAgent delivers.
    expect(actor.getSnapshot().context.seen).toEqual([
      "text:research:test-model",
      "text:research:test-model",
      "text:research:test-model",
    ]);
  });

  test("a wildcard-only machine DOES receive it (plain XState wildcard semantics, as in runAgent)", async () => {
    const wildcardSchemas = createAgentSchemas({
      context: z.object({ tokens: z.number(), seen: z.array(z.string()) }),
      output: z.object({ tokens: z.number(), seen: z.array(z.string()) }),
    });
    const wildcardAgent = setupAgent({ schemas: wildcardSchemas, actors: { researchStep } });
    const wildcardMachine = wildcardAgent.createMachine({
      context: { tokens: 0, seen: [] },
      on: {
        "*": ({ context, event }) => ({ context: { seen: [...context.seen, event.type] } }),
      },
      initial: "researching",
      states: {
        researching: {
          invoke: {
            id: "research",
            src: "researchStep",
            input: { turn: 1 },
            onDone: { target: "done" },
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ tokens: context.tokens, seen: context.seen }),
        },
      },
    });

    const actor = createActor(provideExecutors(wildcardMachine, usageExecutors));
    actor.start();
    const output = await toPromise(actor);

    expect(output.seen).toContain(AGENT_USAGE_EVENT_TYPE);
    // The wildcard handler only records event types, so tokens stay 0.
    expect(output.tokens).toBe(0);
  });

  test("a decision call's usage reaches the machine too", async () => {
    const decisionSchemas = createAgentSchemas({
      context: z.object({ tokens: z.number(), kinds: z.array(z.string()) }),
      output: z.object({ tokens: z.number(), kinds: z.array(z.string()) }),
      events: { GO: z.object({}) },
    });
    const decisionAgent = setupAgent({ schemas: decisionSchemas });
    const machine = decisionAgent.createMachine({
      context: () => ({ tokens: 0, kinds: [] }),
      on: {
        [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
          context: {
            tokens: context.tokens + (event.usage.totalTokens ?? 0),
            kinds: [...context.kinds, `${event.kind ?? "?"}:${event.id ?? "?"}`],
          },
        }),
      },
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            id: "choose",
            src: "agent.decide",
            input: { model: "test-model", prompt: "pick", allowedEvents: ["GO"] as const },
          },
          on: { GO: { target: "done" } },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ tokens: context.tokens, kinds: context.kinds }),
        },
      },
    });

    const bound = provideExecutors(machine, {
      decide: async () => ({ event: { type: "GO" } as ChosenEvent, usage: { totalTokens: 77 } }),
    });
    const actor = createActor(bound);
    actor.start();

    expect(await toPromise(actor)).toEqual({ tokens: 77, kinds: ["decision:choose"] });
  });
});

// ─── Recursive executor inheritance (parity with runAgent) ───

describe("provideExecutors recursive child binding", () => {
  const childText = createTextLogic({
    schemas: { input: z.object({ topic: z.string() }), output: z.string() },
    model: "child-model",
    prompt: ({ input }) => input.topic,
  });

  const buildGrandchild = () => {
    const schemas = createAgentSchemas({
      context: z.object({ line: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ line: z.string() }),
    });
    return setupAgent({ schemas, actors: { childText } }).createMachine({
      context: { line: null },
      initial: "writing",
      states: {
        writing: {
          invoke: {
            id: "write",
            src: "childText",
            input: ({ context }: { context: { line: string | null } }) => {
              void context;
              return { topic: "grandchild topic" };
            },
            onDone: ({ output }: { output: unknown }) => ({
              target: "done",
              context: { line: output as string },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }: { context: { line: string | null } }) => ({ line: context.line }),
        },
      },
    } as never);
  };

  const buildParent = () => {
    const grandchild = buildGrandchild();
    const childSchemas = createAgentSchemas({
      context: z.object({ line: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ line: z.string() }),
    });
    const child = setupAgent({
      schemas: childSchemas,
      actors: { grandchild },
    }).createMachine({
      context: { line: null },
      initial: "delegating",
      states: {
        delegating: {
          invoke: {
            id: "grandchild",
            src: "grandchild",
            input: { topic: "t" },
            onDone: ({ output }: { output: unknown }) => ({
              target: "done",
              context: { line: (output as { line: string }).line },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }: { context: { line: string | null } }) => ({ line: context.line }),
        },
      },
    } as never);

    const parentSchemas = createAgentSchemas({
      context: z.object({ line: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ line: z.string() }),
    });
    return setupAgent({ schemas: parentSchemas, actors: { child } }).createMachine({
      context: { line: null },
      initial: "delegating",
      states: {
        delegating: {
          invoke: {
            id: "child",
            src: "child",
            input: { topic: "t" },
            onDone: ({ output }: { output: unknown }) => ({
              target: "done",
              context: { line: (output as { line: string }).line },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }: { context: { line: string | null } }) => ({ line: context.line }),
        },
      },
    } as never);
  };

  test("a request inside a nested child machine inherits the host executors", async () => {
    const models: string[] = [];
    const bound = provideExecutors(buildParent(), {
      generateText: async (request: { model: string }) => {
        models.push(request.model);
        return { output: "written by the grandchild" };
      },
    } as never);

    const actor = createActor(bound, { input: {} } as never);
    actor.start();
    const output = (await toPromise(actor)) as { line: string };

    expect(output).toEqual({ line: "written by the grandchild" });
    // Two levels down, and it still reached the host executor.
    expect(models).toEqual(["child-model"]);
  });

  test("child requests reach the same onTrace stream as parent ones", async () => {
    const traced: string[] = [];
    const bound = provideExecutors(
      buildParent(),
      { generateText: async () => ({ output: "ok" }) } as never,
      { onTrace: (event) => traced.push(event.type) },
    );

    const actor = createActor(bound, { input: {} } as never);
    actor.start();
    await toPromise(actor);

    expect(traced).toEqual(["request.start", "request.end"]);
  });

  test("a nested child's missing executor throws at bind time, before any actor starts", () => {
    expect(() => provideExecutors(buildParent(), {} as never)).toThrow(
      /provideExecutors: actor source 'child > grandchild > childText' is a text source but no 'generateText' executor/,
    );
  });

  test("a child machine's stream request with no streamText throws at bind time", () => {
    const streamLogic = createTextLogic({
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "child-model",
      mode: "stream",
      prompt: ({ input }) => input.topic,
    });
    const childSchemas = createAgentSchemas({
      context: z.object({ line: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ line: z.string() }),
    });
    const child = setupAgent({ schemas: childSchemas, actors: { streamLogic } }).createMachine({
      context: { line: null },
      initial: "writing",
      states: {
        writing: {
          invoke: {
            src: "streamLogic",
            input: { topic: "t" },
            onDone: ({ output }: { output: unknown }) => ({
              target: "done",
              context: { line: output as string },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }: { context: { line: string | null } }) => ({ line: context.line }),
        },
      },
    } as never);

    const parentSchemas = createAgentSchemas({
      context: z.object({ line: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ line: z.string() }),
    });
    const parent = setupAgent({ schemas: parentSchemas, actors: { child } }).createMachine({
      context: { line: null },
      initial: "delegating",
      states: {
        delegating: {
          invoke: {
            src: "child",
            input: { topic: "t" },
            onDone: { target: "done" },
          },
        },
        done: {
          type: "final",
          output: ({ context }: { context: { line: string | null } }) => ({ line: context.line }),
        },
      },
    } as never);

    // Passing generateText is not enough: the child needs streamText.
    expect(() =>
      provideExecutors(parent, { generateText: async () => ({ output: "x" }) } as never),
    ).toThrow(
      /provideExecutors: actor source 'child > streamLogic' is a streaming text source but no 'streamText' executor/,
    );
  });
});
