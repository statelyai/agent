import { describe, expect, test } from "vitest";
import { createAsyncLogic, setup } from "xstate";
import { z } from "zod";
import { describeMachine } from "./describe-machine.js";
import { setupAgent } from "./setup-agent.js";
import type { SchemaCompiler } from "./workflow-config.js";
import type { StandardSchemaV1 } from "./types.js";

// Accepts anything and keeps the JSON Schema readable, like a real engine
// that implements the Standard Schema JSON Schema extension.
const compileSchema: SchemaCompiler = (jsonSchema) =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => jsonSchema },
    },
  }) as StandardSchemaV1;

const refundAgent = setupAgent({
  context: z.object({ amount: z.number(), attempts: z.number(), note: z.string() }),
  events: {
    APPROVE: z.object({}).describe("A reviewer approves the refund"),
    REJECT: z
      .object({ reason: z.string().describe("Why the refund was rejected") })
      .describe("A reviewer rejects the refund"),
    NOTE: z.object({ text: z.string(), urgent: z.boolean().optional() }),
    RETRY: z.object({}),
  },
  delays: { reviewTimeout: 60_000 },
});

const refundMachine = refundAgent.createMachine({
  id: "refund",
  description: "Resolve every refund request correctly and quickly.",
  context: { amount: 0, attempts: 0, note: "" },
  initial: "triage",
  states: {
    triage: {
      description: "Route the request by amount",
      type: "choice",
      choice: ({ context }) => (context.amount > 100 ? { target: "review" } : { target: "paying" }),
    },
    review: {
      description: "A human reviews large refunds",
      tags: ["waiting"],
      meta: { interaction: { label: "Approve this refund?" } },
      initial: "pending",
      states: {
        pending: {
          on: {
            NOTE: ({ context, event }) => ({ context: { note: context.note + event.text } }),
          },
          after: { reviewTimeout: { target: "escalated" } },
        },
        escalated: { description: "Waited too long" },
      },
      on: {
        APPROVE: { target: "paying", description: "Pay it out" },
        REJECT: ({ event }) => ({ target: "rejected", context: { note: event.reason } }),
      },
    },
    paying: {
      invoke: {
        src: "agent.generateText",
        id: "payout",
        onDone: { target: "done" },
        onError: ({ context }) =>
          context.attempts < 3
            ? { target: "paying", context: { attempts: context.attempts + 1 } }
            : { target: "rejected" },
      },
      on: {
        RETRY: ({ context }) => (context.attempts < 3 ? { target: "paying" } : undefined),
      },
      after: { 5000: { target: "rejected" } },
    },
    done: { type: "final", description: "Refund paid" },
    rejected: { type: "final" },
  },
});

describe("describeMachine", () => {
  test("shows an interaction whose label is computed, or that has no label", () => {
    const machine = setup({}).createMachine({
      context: { amount: 240 },
      initial: "approving",
      states: {
        approving: {
          meta: {
            interaction: {
              label: ({ context }: { context: { amount: number } }) =>
                `Approve $${context.amount}?`,
            },
          } as never,
        },
        replying: { meta: { interaction: { textEvent: "REPLIED" } } as never },
      },
    });

    const text = describeMachine(machine);
    expect(text).toContain("approving [interaction: computed label]");
    expect(text).toContain("replying [interaction]");
  });

  test("marks a minified transition that may decline as conditional", () => {
    // Bundlers and tsx print `undefined` as `void 0` and drop the spaces around `?`.
    const always = new Function(
      'return ({ context }) => context.broken?{target:"stopped"}:void 0',
    )() as never;
    const machine = setup({}).createMachine({
      context: { broken: false },
      initial: "paying",
      states: { paying: { always }, stopped: {} },
    });

    expect(describeMachine(machine)).toContain("always → stopped (conditional)");
  });

  test("a question mark inside a string does not make a transition conditional", () => {
    const always = new Function(
      'return ({ context }) => ({ target: "stopped", context: { prompt: "Approve?" } })',
    )() as never;
    const machine = setup({}).createMachine({
      context: { prompt: "" },
      initial: "paying",
      states: { paying: { always }, stopped: {} },
    });

    expect(describeMachine(machine)).toContain("always → stopped; sets prompt");
  });

  test("a transition that returns a helper's result is unknown, not (stays)", () => {
    const next = (ready: boolean) => (ready ? { target: "done" as const } : undefined);
    const machine = setup({}).createMachine({
      context: { ready: false },
      initial: "working",
      states: {
        working: {
          on: {
            CHECK: ({ context }) => next(context.ready),
            WRAPPED: ({ context }) => next(context.ready),
            PICK: ({ context }) => {
              const ready = !context.ready;
              return next(ready);
            },
            NOTE: () => ({ context: { ready: true } }),
            MAP: ({ context }) => ({
              context: { ready: [context.ready].map((value) => Boolean(value))[0]! },
            }),
          },
        },
        done: {},
      },
    });

    // As authored: the transpiler drops these grouping parentheses.
    const { on } = (
      machine.config as unknown as { states: { working: { on: Record<string, unknown> } } }
    ).states.working;
    Object.defineProperty(on.WRAPPED, "toString", {
      value: () => "({ context }) => (next(context.ready))",
    });

    const text = describeMachine(machine);
    expect(text).toContain("on CHECK → ?");
    expect(text).toContain("on WRAPPED → ?");
    expect(text).toContain("on PICK → ?");
    expect(text).toContain("on NOTE → (stays)");
    // A call inside a nested callback is not the transition's own result.
    expect(text).toContain("on MAP → (stays)");
  });

  test("a target held in a variable is unknown, not (stays)", () => {
    const machine = setup({}).createMachine({
      context: { step: 0 },
      initial: "working",
      states: {
        working: {
          on: {
            NEXT: ({ context }) => {
              const next = ["working", "done"][context.step]!;
              return { target: next };
            },
            SHORT: ({ context }) => {
              const target = context.step > 0 ? "#done" : "#working";
              return { target };
            },
          },
        },
        done: { id: "done" },
      },
    });
    // As the dev build prints them: minified, no spaces.
    const { on } = (
      machine.config as unknown as { states: { working: { on: Record<string, unknown> } } }
    ).states.working;
    Object.defineProperty(on.NEXT, "toString", {
      value: () => '({context:e})=>{const t=["working","done"][e.step];return{target:t}}',
    });
    Object.defineProperty(on.SHORT, "toString", {
      value: () => "({ context }) => { const target = pick(context); return { target }; }",
    });

    const text = describeMachine(machine);
    expect(text).toContain("on NEXT → ?");
    expect(text).toContain("on SHORT → ?");
  });

  test("a spread of the current context sets nothing", () => {
    const machine = setup({}).createMachine({
      context: { outcome: "", toExecute: [] as string[], extra: {} as object },
      initial: "working",
      states: {
        working: {
          on: {
            DECIDE: ({ context: ctx }) => ({
              context: { ...ctx, outcome: "ok", toExecute: [] },
            }),
            MERGE: ({ context, event }) => ({
              context: { ...context, ...(event as unknown as { patch: object }).patch },
            }),
          },
        },
      },
    });
    const { on } = (
      machine.config as unknown as { states: { working: { on: Record<string, unknown> } } }
    ).states.working;
    // Minified: the context binding is renamed.
    Object.defineProperty(on.DECIDE, "toString", {
      value: () => '({context:e})=>({context:{...e,outcome:"ok",toExecute:[]}})',
    });
    const text = describeMachine(machine);
    expect(text).toContain("on DECIDE → (stays); sets outcome, toExecute");
    // A spread of anything else may set keys the source cannot name.
    expect(text).toContain("on MERGE → (stays); sets …event.patch");
  });

  test("an unconditional onError is not (conditional)", () => {
    const machine = setup({
      actors: { work: createAsyncLogic({ run: async () => 1 }) },
    }).createMachine({
      context: { error: null as string | null },
      initial: "working",
      states: {
        working: {
          invoke: {
            src: "work",
            onDone: { target: "done" },
            onError: ({ event }) => ({
              target: "failed",
              context: {
                error: event.error instanceof Error ? event.error.message : null,
              },
            }),
          },
        },
        done: {},
        failed: {},
      },
    });
    expect(describeMachine(machine)).toContain("error → failed; sets error");
  });

  test("describes a TS-authored machine", () => {
    expect(describeMachine(refundMachine)).toMatchInlineSnapshot(`
      "Machine refund
      Goal: Resolve every refund request correctly and quickly.
      States (initial: triage):
        triage (choice) — Route the request by amount
            choice → review, paying (conditional)
        review (initial: pending) [tags: waiting] [interaction: "Approve this refund?"] — A human reviews large refunds
            on APPROVE → paying — Pay it out
            on REJECT → rejected; sets note
          pending
              on NOTE → (stays); sets note
              after reviewTimeout (60s) → escalated
          escalated — Waited too long
        paying
            on RETRY → paying (conditional)
            after 5s → rejected
            invoke agent.generateText (payout)
              done → done
              error → paying, rejected (conditional); sets attempts
        done (final) — Refund paid
        rejected (final)
      Events:
        APPROVE — A reviewer approves the refund
        NOTE
          text: string
          urgent?: boolean
        REJECT — A reviewer rejects the refund
          reason: string — Why the refund was rejected
        RETRY"
    `);
  });

  test("lists a plain xstate machine's described events from its own schemas", () => {
    const machine = setup({
      schemas: { events: { X: z.object({ amount: z.number() }).describe("pay") } },
    }).createMachine({
      id: "plain",
      initial: "idle",
      states: { idle: { on: { X: { target: "idle" } } } },
    });
    expect(describeMachine(machine).split("\n").slice(-2)).toEqual([
      "  X — pay",
      "    amount: number",
    ]);
  });

  test("leads with the goal", () => {
    const lines = describeMachine(refundMachine).split("\n");
    expect(lines[0]).toBe("Machine refund");
    expect(lines[1]).toBe("Goal: Resolve every refund request correctly and quickly.");
  });

  test("marks the current states from a snapshot", () => {
    const snapshot = refundMachine.resolveState({
      value: { review: "pending" },
      context: { amount: 500, attempts: 0, note: "" },
    });
    expect(describeMachine(refundMachine, { snapshot })).toMatchInlineSnapshot(`
      "Machine refund
      Goal: Resolve every refund request correctly and quickly.
      States (initial: triage) (* = current):
        triage (choice) — Route the request by amount
            choice → review, paying (conditional)
      * review (initial: pending) [tags: waiting] [interaction: "Approve this refund?"] — A human reviews large refunds
            on APPROVE → paying — Pay it out
            on REJECT → rejected; sets note
        * pending
              on NOTE → (stays); sets note
              after reviewTimeout (60s) → escalated
          escalated — Waited too long
        paying
            on RETRY → paying (conditional)
            after 5s → rejected
            invoke agent.generateText (payout)
              done → done
              error → paying, rejected (conditional); sets attempts
        done (final) — Refund paid
        rejected (final)
      Events:
        APPROVE — A reviewer approves the refund
        NOTE
          text: string
          urgent?: boolean
        REJECT — A reviewer rejects the refund
          reason: string — Why the refund was rejected
        RETRY"
    `);
  });

  test("omits the goal line when the machine has no description", () => {
    const machine = setupAgent({ context: z.object({}) }).createMachine({
      id: "bare",
      context: {},
      initial: "idle",
      states: { idle: {} },
    });
    expect(describeMachine(machine)).toMatchInlineSnapshot(`
      "Machine bare
      States (initial: idle):
        idle"
    `);
  });

  test("describes a fromConfig machine from its config", () => {
    const { machine } = setupAgent.fromConfig(
      {
        id: "ticket",
        description: "Answer the customer's ticket so they never write back.",
        schemas: {
          context: { type: "object" },
          events: {
            ESCALATE: { type: "object", description: "Hand the ticket to a human" },
            REPLY: {
              type: "object",
              description: "Answer the ticket directly",
              properties: { tone: { enum: ["formal", "casual"], description: "Reply tone" } },
              required: ["tone"],
            },
          },
        },
        context: { tone: "formal", drafts: 0 },
        initial: "triaging",
        states: {
          triaging: {
            description: "Decide how to handle the ticket",
            invoke: { src: "agent.decide", onError: { target: "escalated" } },
            on: {
              ESCALATE: { target: "escalated" },
              REPLY: {
                target: "drafting",
                assign: { tone: "{{ event.tone }}" },
                description: "Draft a reply",
              },
            },
          },
          drafting: {
            initial: "writing",
            states: {
              writing: {
                on: { WRITTEN: { target: "checked", assign: { drafts: "{{ context.drafts }}" } } },
              },
              checked: { type: "final" },
            },
            onDone: { target: "checking" },
            after: { 30000: { target: "escalated" } },
          },
          checking: {
            type: "choice",
            choice: [
              { guard: "{{ context.approved }}", target: "sent" },
              { guard: "isRetryable", target: "drafting" },
              { target: "escalated" },
            ],
          },
          sent: { type: "final", tags: ["done"] },
          escalated: { type: "final", description: "A human owns it now" },
        },
      },
      { compileSchema, guards: { isRetryable: () => true } },
    );
    expect(describeMachine(machine)).toMatchInlineSnapshot(`
      "Machine ticket
      Goal: Answer the customer's ticket so they never write back.
      States (initial: triaging):
        triaging — Decide how to handle the ticket
            on ESCALATE → escalated
            on REPLY → drafting; sets tone — Draft a reply
            invoke agent.decide
              error → escalated
        drafting (initial: writing)
            onDone → checking
            after 30s → escalated
          writing
              on WRITTEN → checked; sets drafts
          checked (final)
        checking (choice)
            choice if context.approved → sent
            choice if isRetryable → drafting
            choice else → escalated
        sent (final) [tags: done]
        escalated (final) — A human owns it now
      Events:
        ESCALATE — Hand the ticket to a human
        REPLY — Answer the ticket directly
          tone: "formal" | "casual" — Reply tone"
    `);
  });

  test("marks unresolvable and target-free function transitions", () => {
    const machine = setupAgent({
      context: z.object({ next: z.string(), count: z.number() }),
    }).createMachine({
      id: "fns",
      context: { next: "b", count: 0 },
      initial: "a",
      on: { RESET: { target: ".a" } },
      states: {
        a: {
          on: {
            COMPUTED: ({ context }) => ({ target: context.next }),
            COUNT: ({ context }) => ({ context: { count: context.count + 1 } }),
            ALWAYS_B: () => ({ target: "b" }),
            SPREAD: ({ context }) => ({ context: { ...context, count: 0 } }),
          },
        },
        b: { type: "parallel", states: { x: {}, y: {} } },
      },
    });
    expect(describeMachine(machine)).toMatchInlineSnapshot(`
      "Machine fns
      Any state:
        on RESET → a
      States (initial: a):
        a
            on COMPUTED → ?
            on COUNT → (stays); sets count
            on ALWAYS_B → b
            on SPREAD → (stays); sets count
        b (parallel)
          x
          y"
    `);
  });
});
