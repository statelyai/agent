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
        input: { model: "quick", prompt: "Pay out the refund" },
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

  test("a shorthand target inside a context patch stays", () => {
    const machine = setup({}).createMachine({
      context: { target: "" },
      initial: "working",
      states: {
        working: {
          on: {
            SAVE: ({ event }) => {
              const target = (event as unknown as { target: string }).target;
              return { context: { target } };
            },
          },
        },
      },
    });
    expect(describeMachine(machine)).toContain("on SAVE → (stays); sets target");
  });

  test("a conditional target expression stays conditional, and a returned context is not an alias", () => {
    const machine = setup({}).createMachine({
      context: { ready: false, n: 0 },
      initial: "working",
      states: {
        working: {
          on: {
            GO: ({ context }) => ({ target: context.ready ? "done" : "working" }),
            SET: ({ event }) => {
              const patch = (event as unknown as { patch: { n: number } }).patch;
              return { context: { ...patch } };
            },
          },
        },
        done: {},
      },
    });
    const text = describeMachine(machine);
    expect(text).toMatch(/on GO → .*\(conditional\)/);
    expect(text).toContain("…patch");
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

  test("reads every return path: local constants, early returns and fall-through", () => {
    const machine = setup({}).createMachine({
      context: { step: 0, ready: false },
      initial: "working",
      states: {
        working: {
          on: {
            SHORT: ({ context }) => {
              const target = context.step > 0 ? "done" : "failed";
              return { target };
            },
            EARLY: ({ context }) => {
              if (!context.ready) return { target: "failed" };
              return { target: "done", context: { step: context.step + 1 } };
            },
            MAYBE: ({ context }) => {
              if (context.ready) return { target: "done" };
            },
            STAY_OR_GO: ({ context }) =>
              context.ready ? { target: "done" } : { context: { step: 1 } },
            TEMPLATE: () => ({ target: `done` }),
            THROWS: ({ context }) => {
              if (context.ready) return { target: "done" };
              throw new Error("not ready");
            },
          },
        },
        done: {},
        failed: {},
      },
    });
    const text = describeMachine(machine);
    expect(text).toContain("on SHORT → done, failed (conditional)");
    expect(text).toContain("on EARLY → failed, done (conditional); sets step");
    expect(text).toContain("on MAYBE → done (conditional)");
    expect(text).toContain("on STAY_OR_GO → done (conditional); sets step");
    expect(text).toContain("on TEMPLATE → done");
    expect(text).toContain("on THROWS → done\n");
  });

  test("a known target beside an unknown one shows both", () => {
    const pick = (ready: boolean) => (ready ? "done" : "working");
    const machine = setup({}).createMachine({
      context: { ready: false },
      initial: "working",
      states: {
        working: {
          on: {
            GO: ({ context }) =>
              context.ready ? { target: "done" } : { target: pick(context.ready) },
          },
        },
        done: {},
      },
    });
    expect(describeMachine(machine)).toContain("on GO → done, ? (conditional)");
  });

  test("reads a method-shorthand transition and an unparseable source", () => {
    const machine = setup({}).createMachine({
      context: { n: 0 },
      initial: "working",
      states: {
        working: {
          on: {
            METHOD: ({ context }) => ({ target: "done", context: { n: context.n + 1 } }),
            NATIVE: () => ({ target: "done" }),
          },
        },
        done: {},
      },
    });
    const { on } = (
      machine.config as unknown as { states: { working: { on: Record<string, unknown> } } }
    ).states.working;
    Object.defineProperty(on.METHOD, "toString", {
      value: () =>
        'METHOD({ context }) { return { target: "done", context: { n: context.n + 1 } }; }',
    });
    Object.defineProperty(on.NATIVE, "toString", { value: () => "function () { [native code] }" });
    const text = describeMachine(machine);
    expect(text).toContain("on METHOD → done; sets n");
    expect(text).toContain("on NATIVE → ?");
  });

  test("prints each function transition's source with source: true", () => {
    const machine = setup({}).createMachine({
      context: { ready: false },
      initial: "working",
      states: {
        working: {
          on: {
            GO: { target: "done" },
            CHECK: ({ context }) => (context.ready ? { target: "done" } : undefined),
          },
        },
        done: {},
      },
    });
    const { on } = (
      machine.config as unknown as { states: { working: { on: Record<string, unknown> } } }
    ).states.working;
    Object.defineProperty(on.CHECK, "toString", {
      value: () =>
        '({ context }) => {\n          if (!context.ready) return undefined;\n          return { target: "done" };\n        }',
    });
    expect(describeMachine(machine, { source: true })).toMatchInlineSnapshot(`
      "Machine 
      States (initial: working):
        working
            on GO → done
            on CHECK → done (conditional)
              | ({ context }) => {
              |   if (!context.ready) return undefined;
              |   return { target: "done" };
              | }
        done"
    `);
    expect(describeMachine(machine)).not.toContain("|");
  });

  test("source: true prints entry and exit actions; helpers print in their own section", () => {
    const fn = (code: string) => new Function(`return ${code}`)() as never;
    const withinLimit = fn(`(turn, limit) => turn < limit`);
    const machine = setup({}).createMachine({
      context: { turn: 0, limit: 3 },
      initial: "working",
      states: {
        working: {
          entry: fn(`(_, enq) => enq.emit({ type: "started" })`),
          exit: fn(`() => {}`),
          on: {
            NEXT: fn(
              `({ context }) => withinLimit(context.turn, context.limit) ? { target: "working" } : { target: "done" }`,
            ),
          },
        },
        done: {},
      },
    });
    expect(describeMachine(machine, { source: true, helpers: { withinLimit } }))
      .toMatchInlineSnapshot(`
        "Machine 
        States (initial: working):
          working
              entry
                | (_, enq) => enq.emit({ type: "started" })
              exit
                | () => {}
              on NEXT → working, done (conditional)
                | ({ context }) => withinLimit(context.turn, context.limit) ? { target: "working" } : { target: "done" }
          done
        Helpers:
          withinLimit
            | (turn, limit) => turn < limit"
      `);
    expect(describeMachine(machine)).not.toContain("entry");
  });

  test("vite SSR import rewrites are read and printed as written", () => {
    const fn = (code: string) =>
      new Function("__vite_ssr_import_3__", `return ${code}`)({
        next: () => "done",
        Target: { done: "done" },
      }) as never;
    const machine = setup({}).createMachine({
      initial: "working",
      states: {
        working: {
          on: {
            GO: fn(
              `({ context }) => ({ target: __vite_ssr_import_3__.Target.done, context: (0, __vite_ssr_import_3__.next)(context) })`,
            ),
          },
        },
        done: {},
      },
    });
    const text = describeMachine(machine, { source: true });
    expect(text).not.toContain("__vite_ssr_import");
    expect(text).toContain("| ({ context }) => ({ target: Target.done, context: next(context) })");
    const withDefault = setup({}).createMachine({
      initial: "working",
      states: {
        working: {
          on: {
            GO: fn(
              `({ context }) => (__vite_ssr_import_3__.default(context) ? { target: "done" } : undefined)`,
            ),
          },
        },
        done: {},
      },
    });
    expect(describeMachine(withDefault)).toContain("on GO → done (conditional)");
  });

  test("an exhaustive switch or if/else does not decline; spreads and mutations count", () => {
    const fn = (code: string) => new Function(`return ${code}`)() as never;
    const machine = setup({}).createMachine({
      context: { failed: false },
      initial: "working",
      states: {
        working: {
          on: {
            SWITCH: fn(`({ event }) => {
              switch (event.kind) {
                case "a": return { target: "done" };
                default: return { target: "done" };
              }
            }`),
            SWITCH_BREAK: fn(`({ event }) => {
              switch (event.kind) {
                case "a": break;
                default: return { target: "done" };
              }
            }`),
            IF_ELSE: fn(`({ context }) => {
              if (context.failed) { return { target: "failed" }; } else { throw new Error("x"); }
            }`),
            SPREAD_OVERRIDE: fn(`() => ({ target: "done", ...{ target: "failed" } })`),
            SPREAD_UNKNOWN: fn(`({ event }) => ({ target: "done", ...event.patch })`),
            SPREAD_BEFORE: fn(`({ event }) => ({ ...event.patch, target: "done" })`),
            NESTED_WRITE: fn(`({ event }) => {
              let next = "done";
              event.items.forEach((item) => { if (item.failed) next = "failed"; });
              return { target: next };
            }`),
            MUTATED: fn(`({ context }) => {
              const transition = { target: "done" };
              if (context.failed) transition.target = "failed";
              return transition;
            }`),
          },
        },
        done: {},
        failed: {},
      },
    });
    const text = describeMachine(machine);
    expect(text).toContain("on SWITCH → done\n");
    expect(text).toContain("on SWITCH_BREAK → done (conditional)");
    expect(text).toContain("on IF_ELSE → failed\n");
    expect(text).toContain("on SPREAD_OVERRIDE → failed\n");
    expect(text).toContain("on SPREAD_UNKNOWN → ?");
    expect(text).toContain("on SPREAD_BEFORE → done\n");
    expect(text).toContain("on MUTATED → ?");
    expect(text).toContain("on NESTED_WRITE → ?");
  });
});
