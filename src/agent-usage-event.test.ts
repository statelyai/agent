import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAgentSchemas,
  createTextLogic,
  getAcceptedEvents,
  parseAgentEvent,
  runAgent,
  setupAgent,
  type ChosenEvent,
} from "./index.js";
import { AGENT_USAGE_EVENT_TYPE, type AgentUsageEvent } from "./usage.js";

const schemas = createAgentSchemas({
  input: z.object({ maxTokens: z.number() }),
  context: z.object({
    notes: z.array(z.string()),
    tokens: z.number(),
    maxTokens: z.number(),
    seen: z.array(z.string()),
  }),
  output: z.object({ notes: z.array(z.string()), tokens: z.number(), stoppedBy: z.string() }),
  // No `'@agent.usage'` entry: setupAgent/createAgentSchemas register it (with
  // its real payload schema) by default, so the handler below is typed without
  // the machine declaring anything.
  events: { APPROVE: z.object({}) },
});

const researchStep = createTextLogic({
  name: "researchStep",
  schemas: { input: z.object({ turn: z.number() }), output: z.string() },
  model: "test-model",
  prompt: ({ input }) => `Turn ${input.turn}.`,
});

const agent = setupAgent({ schemas, actors: { researchStep } });

/**
 * The canonical budget-as-a-guard shape: a machine-level `'@agent.usage'`
 * handler folds every settled call's tokens into context, and an ordinary
 * always-guard stops the loop once the budget is spent.
 */
const budgetMachine = agent.createMachine({
  context: ({ input }) => ({ notes: [], tokens: 0, maxTokens: input.maxTokens, seen: [] }),
  on: {
    [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
      context: {
        tokens: context.tokens + (event.usage.totalTokens ?? 0),
        seen: [...context.seen, `${event.kind ?? "?"}:${event.id ?? "?"}:${event.model ?? "?"}`],
      },
    }),
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
        context.tokens >= context.maxTokens ? { target: "outOfBudget" } : { target: "researching" },
    },
    outOfBudget: {
      type: "final",
      output: ({ context }) => ({
        notes: context.notes,
        tokens: context.tokens,
        stoppedBy: "tokens",
      }),
    },
  },
});

const textExecutors = {
  generateText: async () => ({ output: "a fact", usage: { totalTokens: 400, inputTokens: 300 } }),
};

describe("@agent.usage (reserved per-call usage event)", () => {
  test("folds a text call's tokens into context, so a budget guard can stop the run", async () => {
    const result = await runAgent(budgetMachine, {
      input: { maxTokens: 1000 },
      executors: textExecutors,
    });

    expect(result.status).toBe("done");
    // 3 calls x 400 tokens = 1200 >= 1000.
    expect(result.status === "done" ? result.output : undefined).toEqual({
      notes: ["a fact", "a fact", "a fact"],
      tokens: 1200,
      stoppedBy: "tokens",
    });
    // The run-level aggregate still sees exactly the same calls.
    expect(result.usage).toEqual({ totalTokens: 1200, inputTokens: 900, modelCalls: 3 });
  });

  test("carries attribution: kind, invoke id, src, model, and the request name", async () => {
    const delivered: AgentUsageEvent[] = [];
    await runAgent(budgetMachine, {
      input: { maxTokens: 400 },
      executors: textExecutors,
      onTransition: (_snapshot, event) => {
        if (event.type === AGENT_USAGE_EVENT_TYPE) {
          delivered.push(event as AgentUsageEvent);
        }
      },
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual({
      type: "@agent.usage",
      kind: "text",
      id: "research",
      src: "researchStep",
      model: "test-model",
      name: "researchStep",
      usage: { totalTokens: 400, inputTokens: 300 },
    });
  });

  test("a decision call reports its usage with kind 'decision'", async () => {
    const decisionSchemas = createAgentSchemas({
      context: z.object({ tokens: z.number(), kinds: z.array(z.string()) }),
      output: z.object({ tokens: z.number(), kinds: z.array(z.string()) }),
      events: {
        GO: z.object({}),
      },
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

    const result = await runAgent(machine, {
      executors: {
        decide: async () => ({ event: { type: "GO" } as ChosenEvent, usage: { totalTokens: 77 } }),
      },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({
      tokens: 77,
      kinds: ["decision:choose"],
    });
  });

  test("a machine that declares no handler is untouched", async () => {
    const plainSchemas = createAgentSchemas({
      context: z.object({ note: z.string() }),
      output: z.object({ note: z.string() }),
    });
    const plainAgent = setupAgent({ schemas: plainSchemas, actors: { researchStep } });
    const machine = plainAgent.createMachine({
      context: { note: "" },
      initial: "researching",
      states: {
        researching: {
          invoke: {
            id: "research",
            src: "researchStep",
            input: { turn: 1 },
            onDone: ({ output }) => ({ target: "done", context: { note: output } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ note: context.note }) },
      },
    });

    const seen: string[] = [];
    const result = await runAgent(machine, {
      executors: textExecutors,
      onTransition: (_snapshot, event) => seen.push(event.type),
    });

    expect(result.status).toBe("done");
    expect(seen).not.toContain(AGENT_USAGE_EVENT_TYPE);
    // Aggregation is unaffected by delivery being skipped.
    expect(result.usage).toEqual({ totalTokens: 400, inputTokens: 300, modelCalls: 1 });
  });

  test("is never offered to a model, even under an allowedEvents wildcard", async () => {
    const result = await runAgent(budgetMachine, {
      input: { maxTokens: 400 },
      executors: textExecutors,
    });
    const snapshot = result.snapshot;

    const accepted = getAcceptedEvents(snapshot, { schemas }).map((event) => event.type);
    expect(accepted).not.toContain(AGENT_USAGE_EVENT_TYPE);

    const wildcarded = getAcceptedEvents(snapshot, { schemas, eventTypes: ["*"] }).map(
      (event) => event.type,
    );
    expect(wildcarded).not.toContain(AGENT_USAGE_EVENT_TYPE);

    const prefixed = getAcceptedEvents(snapshot, { schemas, eventTypes: ["@agent.*"] }).map(
      (event) => event.type,
    );
    expect(prefixed).toEqual([]);
  });

  test("parseAgentEvent refuses to mint one from untrusted input", async () => {
    const result = await runAgent(budgetMachine, {
      input: { maxTokens: 400 },
      executors: textExecutors,
    });

    expect(() =>
      parseAgentEvent(result.snapshot, {
        type: AGENT_USAGE_EVENT_TYPE,
        usage: { totalTokens: 999_999 },
      }),
    ).toThrow(/is not an accepted event/);
  });

  test("a wildcard-only machine DOES receive it: `on: { '*' }` matches, per plain XState semantics", async () => {
    const wildcardSchemas = createAgentSchemas({
      context: z.object({ note: z.string(), wildcards: z.array(z.string()) }),
      output: z.object({ note: z.string(), wildcards: z.array(z.string()) }),
    });
    const wildcardAgent = setupAgent({ schemas: wildcardSchemas, actors: { researchStep } });
    const wildcardMachine = wildcardAgent.createMachine({
      context: { note: "", wildcards: [] },
      on: {
        "*": ({ context, event }) => ({
          context: { wildcards: [...context.wildcards, event.type] },
        }),
      },
      initial: "researching",
      states: {
        researching: {
          invoke: {
            id: "research",
            src: "researchStep",
            input: { turn: 1 },
            onDone: ({ output }) => ({ target: "done", context: { note: output } }),
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ note: context.note, wildcards: context.wildcards }),
        },
      },
    });

    const seen: string[] = [];
    const result = await runAgent(wildcardMachine, {
      executors: textExecutors,
      onTransition: (_snapshot, event) => seen.push(event.type),
    });

    expect(result.status).toBe("done");
    expect(seen).toContain(AGENT_USAGE_EVENT_TYPE);
    expect(result.snapshot.context.wildcards).toContain(AGENT_USAGE_EVENT_TYPE);
  });

  test("a machine declaring BOTH a wildcard and an explicit handler still receives it", async () => {
    const bothSchemas = createAgentSchemas({
      context: z.object({ tokens: z.number(), wildcards: z.array(z.string()) }),
      output: z.object({ tokens: z.number(), wildcards: z.array(z.string()) }),
      events: {},
    });
    const bothAgent = setupAgent({ schemas: bothSchemas, actors: { researchStep } });
    const bothMachine = bothAgent.createMachine({
      context: { tokens: 0, wildcards: [] },
      on: {
        [AGENT_USAGE_EVENT_TYPE]: ({ context, event }) => ({
          context: { tokens: context.tokens + (event.usage.totalTokens ?? 0) },
        }),
        "*": ({ context, event }) => ({
          context: { wildcards: [...context.wildcards, event.type] },
        }),
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
          output: ({ context }) => ({ tokens: context.tokens, wildcards: context.wildcards }),
        },
      },
    });

    const seen: string[] = [];
    const result = await runAgent(bothMachine, {
      executors: textExecutors,
      onTransition: (_snapshot, event) => seen.push(event.type),
    });

    expect(result.status).toBe("done");
    expect(result.snapshot.context.tokens).toBe(400);
    expect(seen).toContain(AGENT_USAGE_EVENT_TYPE);
  });
});

describe("@agent.usage registration (declared by setupAgent, not by the machine)", () => {
  test("createAgentSchemas registers the event with its payload schema", () => {
    const pack = createAgentSchemas({ context: z.object({ n: z.number() }) });

    expect(Object.keys(pack.events)).toContain(AGENT_USAGE_EVENT_TYPE);

    const usageSchema = pack.events[AGENT_USAGE_EVENT_TYPE];
    expect(usageSchema["~standard"].validate({ usage: { totalTokens: 5 }, kind: "text" })).toEqual({
      value: { usage: { totalTokens: 5 }, kind: "text" },
    });
    // The payload schema is real, not a rubber stamp.
    expect(usageSchema["~standard"].validate({ usage: "nope" }).issues).toBeDefined();
    expect(usageSchema["~standard"].validate({ usage: { totalTokens: "x" } }).issues).toBeDefined();
    expect(usageSchema["~standard"].validate({ usage: {}, kind: "guess" }).issues).toBeDefined();
  });

  test("setupAgent's retained schemas expose it alongside the machine's own events", () => {
    expect(Object.keys(agent.schemas.events).sort()).toEqual([
      AGENT_USAGE_EVENT_TYPE,
      "APPROVE",
      "agent.messages",
    ]);
  });

  test("the machine's event union includes it — the handler is typed without declaring it", () => {
    agent.createMachine({
      context: ({ input }) => ({ notes: [], tokens: 0, maxTokens: input.maxTokens, seen: [] }),
      on: {
        // Typed from the DEFAULT registration: no `'@agent.usage'` entry in
        // `events` anywhere in this file.
        [AGENT_USAGE_EVENT_TYPE]: ({ event }) => {
          const total: number | undefined = event.usage.totalTokens;
          const kind: "text" | "decision" | undefined = event.kind;
          const name: string | undefined = event.name;
          void total;
          void kind;
          void name;
          // @ts-expect-error `spent` is not part of the '@agent.usage' payload
          void event.spent;
          return undefined;
        },
      },
      initial: "idle",
      states: { idle: {} },
    });
  });

  test("fromConfig machines get the same default registration", () => {
    // A pass-through compiler: this test only asserts which event types are
    // registered, not how a JSON Schema validates.
    const compileSchema = () => z.any();
    const { schemas: fromConfigSchemas } = setupAgent.fromConfig(
      {
        id: "usage-from-config",
        schemas: { events: { APPROVE: { type: "object" } } },
        initial: "idle",
        states: { idle: {} },
      },
      { compileSchema },
    );

    expect(Object.keys(fromConfigSchemas.events).sort()).toEqual([
      AGENT_USAGE_EVENT_TYPE,
      "APPROVE",
      "agent.messages",
    ]);

    expect(() =>
      setupAgent.fromConfig(
        {
          id: "usage-from-config-collision",
          schemas: { events: { [AGENT_USAGE_EVENT_TYPE]: { type: "object" } } },
          initial: "idle",
          states: { idle: {} },
        },
        { compileSchema },
      ),
    ).toThrow(/reserved '@agent\.' namespace/);
  });

  test("declaring it yourself is rejected: the '@agent.' namespace is reserved", () => {
    expect(() =>
      createAgentSchemas({
        context: z.object({ n: z.number() }),
        events: { [AGENT_USAGE_EVENT_TYPE]: z.object({ usage: z.object({}) }) },
      }),
    ).toThrow(/reserved '@agent\.' namespace/);

    expect(() =>
      setupAgent({
        context: z.object({ n: z.number() }),
        events: { [AGENT_USAGE_EVENT_TYPE]: z.object({ usage: z.object({}) }) },
      }),
    ).toThrow(/reserved '@agent\.' namespace/);
  });
});
