import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { AgentError } from "./errors.js";
import { setupAgent } from "./index.js";
import { traceCoverage } from "./evals/index.js";
import { canReach, checkConformance, createRecorder, type Recording } from "./testing/index.js";

// --- The existing code: a support loop, never changed by the check. ---

interface Effects {
  assist: (step: number) => Promise<{ done: boolean; email: boolean }>;
  approve: () => Promise<boolean>;
  send: () => Promise<void>;
}

type Bug = "none" | "skip-approval" | "cap-off-by-one";

async function supportLoop(fx: Effects, maxSteps: number, bug: Bug = "none") {
  for (let step = 0; bug === "cap-off-by-one" ? step <= maxSteps : step < maxSteps; step++) {
    const reply = await fx.assist(step);
    if (reply.email) {
      if (bug !== "skip-approval" && !(await fx.approve())) return "declined";
      await fx.send();
    }
    if (reply.done) return "replied";
  }
  return "step-limit";
}

// --- The model: the same control flow, with actors that run no code. ---

const placeholder = createAsyncLogic({
  run: async (): Promise<never> => Promise.reject(new Error("model only")),
});

const model = setupAgent({
  input: z.object({ maxSteps: z.number() }),
  context: z.object({ steps: z.number(), maxSteps: z.number(), done: z.boolean() }),
  events: { APPROVE: {}, REJECT: {} },
  actors: { assist: placeholder, send: placeholder },
}).createMachine({
  context: ({ input }) => ({ steps: 0, maxSteps: input.maxSteps, done: false }),
  initial: "checking",
  states: {
    checking: {
      type: "choice",
      choice: ({ context }) =>
        context.steps < context.maxSteps ? { target: "assisting" } : { target: "stepLimit" },
    },
    assisting: {
      invoke: {
        src: "assist",
        input: ({ context }) => ({ step: context.steps }),
        onDone: ({ context, event }) => {
          const reply = event.output as { done: boolean; email: boolean };
          const next = { ...context, steps: context.steps + 1, done: reply.done };
          if (reply.email) return { target: "awaitingApproval", context: next };
          return reply.done
            ? { target: "replied", context: next }
            : { target: "checking", context: next };
        },
      },
    },
    awaitingApproval: { on: { APPROVE: { target: "sending" }, REJECT: { target: "declined" } } },
    sending: {
      invoke: {
        src: "send",
        onDone: ({ context }) => (context.done ? { target: "replied" } : { target: "checking" }),
      },
    },
    replied: { type: "final", output: () => "replied" },
    declined: { type: "final", output: () => "declined" },
    stepLimit: { type: "final", output: () => "step-limit" },
  },
});

// --- Recording and mapping. ---

type Observation =
  | { kind: "assist"; step: number; done: boolean; email: boolean }
  | { kind: "approval"; approved: boolean }
  | { kind: "send" };

type Reply = { done: boolean; email: boolean };

async function record(replies: Reply[], approvals: boolean[], maxSteps: number, bug: Bug = "none") {
  const recorder = createRecorder();
  let r = 0;
  let a = 0;
  const fx: Effects = {
    assist: recorder.fn("assist", async () => replies[r++] ?? { done: true, email: false }),
    approve: recorder.fn("approve", async () => approvals[a++] ?? true),
    send: recorder.fn("send", async () => {}),
  };
  recorder.output(await supportLoop(fx, maxSteps, bug));
  return recorder.recording;
}

const toObservation = (effect: Recording["effects"][number]): Observation[] => {
  if (effect.kind !== "call") return [];
  const result = effect.result as Reply & boolean;
  switch (effect.name) {
    case "assist":
      return [{ kind: "assist", step: (effect.args as [number])[0], ...(result as Reply) }];
    case "approve":
      return [{ kind: "approval", approved: result as boolean }];
    case "send":
      return [{ kind: "send" }];
    default:
      return [];
  }
};

const check = (recording: Recording, maxSteps: number) =>
  checkConformance(model, {
    input: { maxSteps },
    observations: recording.effects.flatMap(toObservation),
    actors: {
      assist: {
        observes: "assist",
        matches: ({ input, observation }) =>
          (input as { step: number }).step === (observation as { step: number }).step,
        output: ({ observation }) => {
          const { done, email } = observation as Reply;
          return { done, email };
        },
      },
      send: { observes: "send" },
    },
    events: {
      approval: (o) => ({ type: (o as { approved: boolean }).approved ? "APPROVE" : "REJECT" }),
    },
  });

describe("checkConformance", () => {
  test("runs of the unchanged code conform, and their traces feed traceCoverage", async () => {
    const runs = [
      await record([{ done: true, email: false }], [], 3),
      await record(
        [
          { done: false, email: true },
          { done: true, email: false },
        ],
        [true],
        3,
      ),
      await record([{ done: false, email: true }], [false], 3),
      await record([], [], 0),
    ];
    const reports = [];
    for (const [i, recording] of runs.entries()) {
      reports.push(await check(recording, i === 3 ? 0 : 3));
    }
    for (const report of reports) {
      expect(report.deviation).toBeUndefined();
      expect(report.conforms).toBe(true);
      expect(report.status).toBe("done");
    }
    expect(reports.map((r) => r.consumed)).toEqual([1, 4, 2, 0]);
    expect(reports.every((r) => r.unobserved.length === 0)).toBe(true);
    const coverage = traceCoverage(
      model,
      reports.map((r) => r.trace),
    );
    expect(coverage.unvisitedStates).toEqual([]);
  });

  test("the model's own rule is provable: nothing is sent without approval", async () => {
    const result = await canReach(
      model,
      {
        after: "xstate.init",
        reach: (step) => step.started.includes("send") && !step.event.type.startsWith("APPROVE"),
      },
      {
        input: { maxSteps: 2 },
        outputs: {
          assist: [
            { done: false, email: true },
            { done: true, email: false },
          ],
          send: [undefined],
        },
      },
    );
    expect(result).toMatchObject({ reachable: false, complete: true });

    // Mutation check: a model that sends straight from assisting breaks the rule.
    const broken = setupAgent({
      input: z.object({ maxSteps: z.number() }),
      context: z.object({}),
      actors: { assist: placeholder, send: placeholder },
    }).createMachine({
      context: () => ({}),
      initial: "assisting",
      states: {
        assisting: { invoke: { src: "assist", onDone: { target: "sending" } } },
        sending: { invoke: { src: "send", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const witness = await canReach(
      broken,
      {
        after: "xstate.init",
        reach: (step) => step.started.includes("send") && !step.event.type.startsWith("APPROVE"),
      },
      {
        input: { maxSteps: 2 },
        outputs: { assist: [{ done: true, email: true }], send: [undefined] },
      },
    );
    expect(witness.reachable).toBe(true);
  });

  test("code that sends without approval deviates where the model waits for one", async () => {
    const recording = await record([{ done: true, email: true }], [], 3, "skip-approval");
    const report = await check(recording, 3);
    expect(report.conforms).toBe(false);
    expect(report.deviation).toMatchObject({
      reason: "extra-observations",
      index: 1,
      expected: "idle, waiting for an event",
      observed: { kind: "send" },
      state: "awaitingApproval",
    });
  });

  test("code that runs one step past the cap deviates at that step", async () => {
    const replies = [1, 2, 3].map(() => ({ done: false, email: false }));
    const report = await check(await record(replies, [], 2, "cap-off-by-one"), 2);
    expect(report.deviation).toMatchObject({
      reason: "extra-observations",
      index: 2,
      expected: "end of run",
      observed: { kind: "assist", step: 2 },
      state: "stepLimit",
    });
  });

  test("a recording that ends early is a missing observation", async () => {
    const recording = await record(
      [
        { done: false, email: false },
        { done: true, email: false },
      ],
      [],
      3,
    );
    const truncated = { ...recording, effects: recording.effects.slice(0, 1) };
    const report = await check(truncated, 3);
    expect(report.deviation).toMatchObject({
      reason: "missing-observation",
      index: 1,
      expected: "assist",
    });
    expect(report.status).toBe("error");
  });

  test("an observation of the wrong kind, and an input that does not fit, are reported", async () => {
    const wrongKind = await checkConformance(model, {
      input: { maxSteps: 3 },
      observations: [{ kind: "send" }],
      actors: { assist: { observes: "assist" }, send: { observes: "send" } },
    });
    expect(wrongKind.deviation).toMatchObject({
      reason: "unexpected-observation",
      index: 0,
      expected: "assist",
      observed: { kind: "send" },
    });

    const mismatch = await check(
      {
        version: 1,
        effects: [
          {
            kind: "call",
            name: "assist",
            call: 0,
            args: [5],
            result: { done: true, email: false },
          },
        ],
      },
      3,
    );
    expect(mismatch.deviation).toMatchObject({
      reason: "input-mismatch",
      index: 0,
      expected: "assist",
      actorInput: { step: 0 },
    });
    expect(mismatch.consumed).toBe(0);
  });

  test("an actor with no observes is unchecked and listed; error rejects it", async () => {
    const report = await checkConformance(model, {
      input: { maxSteps: 3 },
      observations: [{ kind: "assist" }],
      actors: {
        assist: { observes: "assist", output: () => ({ done: false, email: true }) },
        send: {},
      },
      events: { approval: () => ({ type: "APPROVE" }) },
    });
    expect(report.deviation).toBeUndefined();
    expect(report.status).toBe("idle");

    const failed = await checkConformance(model, {
      input: { maxSteps: 3 },
      observations: [{ kind: "assist" }, { kind: "approval" }],
      actors: {
        assist: { observes: "assist", output: () => ({ done: false, email: true }) },
        send: { error: () => new Error("smtp down") },
      },
      events: { approval: () => ({ type: "APPROVE" }) },
    });
    expect(failed.unobserved).toEqual(["send"]);
    expect(failed.status).toBe("error");
    expect(failed.conforms).toBe(true);
  });

  test("an observation whose event the idle model ignores is a deviation, not consumed", async () => {
    const recording = await record([{ done: true, email: true }], [true], 3);
    const report = await checkConformance(model, {
      input: { maxSteps: 3 },
      observations: recording.effects.flatMap(toObservation),
      actors: {
        assist: { observes: "assist", output: () => ({ done: true, email: true }) },
        send: { observes: "send" },
      },
      // A mapping bug: the approval maps to an event the model does not accept.
      events: { approval: () => ({ type: "APPROVED" }) },
    });
    expect(report.conforms).toBe(false);
    expect(report.deviation).toMatchObject({
      reason: "ignored-event",
      index: 1,
      observed: { kind: "approval" },
      state: "awaitingApproval",
    });
    expect(report.consumed).toBe(1);
  });

  test("a model that invokes inline logic is rejected before anything runs", async () => {
    let ran = false;
    const inline = setupAgent({
      context: z.object({}),
      actors: { send: placeholder },
    }).createMachine({
      context: () => ({}),
      initial: "working",
      states: {
        working: {
          invoke: {
            src: createAsyncLogic({
              run: async () => {
                ran = true;
              },
            }),
            onDone: { target: "done" },
          },
        },
        done: { type: "final" },
      },
    });
    await expect(
      checkConformance(inline, { observations: [], actors: { send: {} } }),
    ).rejects.toMatchObject({
      code: "inline-actor-source",
      message: expect.stringContaining("working"),
    });
    expect(ran).toBe(false);
  });

  test("a callback that throws fails the check instead of passing as an actor failure", async () => {
    const recording = await record([{ done: true, email: false }], [], 3);
    const observations = recording.effects.flatMap(toObservation);
    for (const which of ["matches", "error", "output"] as const) {
      const boom = () => {
        throw new Error(`bad ${which}`);
      };
      await expect(
        checkConformance(model, {
          input: { maxSteps: 3 },
          observations,
          actors: { assist: { observes: "assist", [which]: boom }, send: { observes: "send" } },
        }),
      ).rejects.toMatchObject({
        code: "conformance-callback-error",
        message: `checkConformance: actors.assist.${which} threw: bad ${which}`,
      });
    }
  });

  test("an invoked src with no entry deviates; an entry the model does not declare throws", async () => {
    const recording = await record([{ done: true, email: true }], [true], 3);
    const report = await checkConformance(model, {
      input: { maxSteps: 3 },
      observations: recording.effects.flatMap(toObservation),
      actors: { assist: { observes: "assist", output: () => ({ done: true, email: true }) } },
      events: { approval: () => ({ type: "APPROVE" }) },
    });
    expect(report.deviation).toMatchObject({ reason: "unmapped-actor", expected: "send" });

    await expect(
      // @ts-expect-error the model declares no src "asist"
      checkConformance(model, { observations: [], actors: { asist: {} } }),
    ).rejects.toMatchObject({ code: "unknown-actor-source" });
    await expect(
      // @ts-expect-error the model declares no src "asist"
      checkConformance(model, { observations: [], actors: { asist: {} } }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  test("output checks the code's return value against the model's output", async () => {
    const recording = await record([{ done: true, email: true }], [false], 3);
    const observations = recording.effects.flatMap(
      (effect): (Observation | { kind: "returned"; value: unknown })[] =>
        effect.kind === "output"
          ? [{ kind: "returned", value: effect.value }]
          : toObservation(effect),
    );
    const options = {
      input: { maxSteps: 3 },
      actors: {
        assist: { observes: "assist" as const, output: () => ({ done: true, email: true }) },
        send: { observes: "send" as const },
      },
      events: {
        approval: (o: { approved: boolean }) => ({ type: o.approved ? "APPROVE" : "REJECT" }),
      },
      output: {
        observes: "returned" as const,
        matches: ({ output, observation }: { output: unknown; observation: { value: unknown } }) =>
          output === observation.value,
      },
    };

    const report = await checkConformance(model, { ...options, observations });
    expect(report).toMatchObject({ conforms: true, consumed: 3, status: "done" });

    // The code reported a send it never made: the model ended in declined.
    const lied = observations.map((o) => (o.kind === "returned" ? { ...o, value: "replied" } : o));
    expect(
      (await checkConformance(model, { ...options, observations: lied })).deviation,
    ).toMatchObject({
      reason: "output-mismatch",
      index: 2,
      expected: 'output "declined"',
      observed: { kind: "returned", value: "replied" },
      state: "declined",
    });

    // The code never returned (it threw), and the model finished.
    const threw: typeof observations = observations.filter((o) => o.kind !== "returned");
    expect(
      (await checkConformance(model, { ...options, observations: threw })).deviation,
    ).toMatchObject({
      reason: "missing-observation",
      index: 2,
      expected: "output (returned)",
    });

    // Without output, a recorded return value is one more observation.
    const { output: _, ...unchecked } = options;
    expect((await checkConformance(model, { ...unchecked, observations })).deviation).toMatchObject(
      {
        reason: "extra-observations",
        observed: { kind: "returned" },
      },
    );

    await expect(
      checkConformance(model, {
        ...options,
        observations,
        output: {
          observes: "returned",
          matches: () => {
            throw new Error("bad output");
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "conformance-callback-error",
      message: "checkConformance: output.matches threw: bad output",
    });
  });

  test("an event's matches compares the observation with the model's context", async () => {
    const observations = [
      { kind: "assist", step: 0, done: false, email: true },
      { kind: "approval", approved: true, shownAtStep: 1 },
      { kind: "send" },
      { kind: "assist", step: 1, done: true, email: false },
    ];
    const run = (shownAtStep: number) =>
      checkConformance(model, {
        input: { maxSteps: 3 },
        observations: observations.map((o) => (o.kind === "approval" ? { ...o, shownAtStep } : o)),
        actors: {
          assist: {
            observes: "assist",
            output: ({ observation }) => {
              const { done, email } = observation as unknown as Reply;
              return { done, email };
            },
          },
          send: { observes: "send" },
        },
        events: {
          approval: {
            event: (o) => ({
              type: (o as unknown as { approved: boolean }).approved ? "APPROVE" : "REJECT",
            }),
            matches: ({ observation, context }) =>
              (observation as unknown as { shownAtStep: number }).shownAtStep ===
              (context as { steps: number }).steps,
          },
        },
      });

    expect((await run(1)).conforms).toBe(true);
    const report = await run(0);
    expect(report.deviation).toMatchObject({
      reason: "input-mismatch",
      index: 1,
      expected: "event approval",
      observed: { kind: "approval", shownAtStep: 0 },
      state: "awaitingApproval",
    });
    expect(report.consumed).toBe(1);
  });

  test("callbacks are typed from the machine and the observations", () => {
    // Type-only: the calls below never run.
    const typesOnly = () => {
      const observations: Observation[] = [];
      void checkConformance(model, {
        input: { maxSteps: 3 },
        observations,
        actors: {
          assist: {
            observes: "assist",
            output: ({ observation, input }) => {
              expectTypeOf(observation).toEqualTypeOf<Extract<Observation, { kind: "assist" }>>();
              expectTypeOf(input).toBeUnknown();
              return { done: observation.done, email: observation.email };
            },
          },
          send: {},
        },
        events: {
          approval: {
            event: (o) => ({ type: o.approved ? "APPROVE" : "REJECT" }),
            matches: ({ observation, context }) => {
              expectTypeOf(observation).toEqualTypeOf<Extract<Observation, { kind: "approval" }>>();
              expectTypeOf(context.steps).toBeNumber();
              return true;
            },
          },
        },
      });
      void checkConformance(model, {
        observations,
        actors: {
          // @ts-expect-error "asist" is no observation kind
          assist: { observes: "asist" },
        },
      });
      void checkConformance(model, {
        observations,
        actors: {
          // @ts-expect-error "asist" is no actor src the model declares
          asist: {},
        },
      });
      const withInput = setupAgent({
        context: z.object({}),
        actors: {
          lookup: createAsyncLogic({
            schemas: { input: z.object({ id: z.string() }) },
            run: async (): Promise<never> => Promise.reject(new Error("model only")),
          }),
        },
      }).createMachine({
        context: {},
        initial: "a",
        states: {
          a: { invoke: { src: "lookup", input: { id: "x" }, onDone: { target: "b" } } },
          b: {},
        },
      });
      void checkConformance(withInput, {
        observations: [{ kind: "lookup" }],
        actors: {
          lookup: {
            observes: "lookup",
            matches: ({ input }) => {
              expectTypeOf(input).toEqualTypeOf<{ id: string }>();
              return true;
            },
          },
        },
      });
    };
    expect(typesOnly).toBeTypeOf("function");
  });

  describe("schemas", () => {
    const replySchema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text") }),
      z.object({ kind: z.literal("calls"), calls: z.array(z.string()) }),
    ]);
    const typed = setupAgent({
      context: z.object({}),
      events: { USER: z.object({ text: z.string() }) },
      actors: {
        callModel: createAsyncLogic({
          schemas: { output: replySchema },
          run: async (): Promise<never> => Promise.reject(new Error("model only")),
        }),
        lookup: createAsyncLogic({
          schemas: { output: z.string() },
          run: async (): Promise<never> => Promise.reject(new Error("model only")),
        }),
      },
    }).createMachine({
      context: {},
      initial: "waiting",
      states: {
        waiting: { on: { USER: { target: "calling" } } },
        calling: {
          invoke: {
            src: "callModel",
            onDone: ({ event }) =>
              event.output.kind !== "text" &&
              (event.output as { calls: string[] }).calls.find((name) => name === "lookup")
                ? { target: "looking" }
                : { target: "done" },
          },
        },
        looking: { invoke: { src: "lookup", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });
    const observations = [{ kind: "user" }, { kind: "model" }, { kind: "lookup" }];
    const run = (answers: { model?: unknown; lookup?: unknown; text?: unknown }) =>
      checkConformance(typed, {
        observations,
        actors: {
          callModel: {
            observes: "model",
            output: () => answers.model ?? { kind: "calls", calls: ["lookup"] },
          },
          lookup: { observes: "lookup", output: () => answers.lookup ?? "found" },
        },
        events: { user: () => ({ type: "USER", text: answers.text ?? "hi" }) as never },
      });

    test("an output that fails the actor's output schema is an invalid-output deviation", async () => {
      expect((await run({})).conforms).toBe(true);

      const report = await run({ lookup: 42 });
      expect(report).toMatchObject({ conforms: false, consumed: 2 });
      expect(report.deviation).toMatchObject({
        reason: "invalid-output",
        index: 2,
        expected: "lookup",
        observed: { kind: "lookup" },
        state: "looking",
      });
      expect(report.deviation?.schemaError).toEqual(expect.any(String));
    });

    test("a malformed model-call output is an invalid-output deviation, not a TypeError", async () => {
      const report = await run({ model: { kind: "bogus" } });
      expect(report.deviation).toMatchObject({
        reason: "invalid-output",
        index: 1,
        expected: "callModel",
        state: "calling",
      });
    });

    test("an event payload that fails the event's schema is an invalid-event deviation", async () => {
      const report = await run({ text: 7 });
      expect(report).toMatchObject({ conforms: false, consumed: 0 });
      expect(report.deviation).toMatchObject({
        reason: "invalid-event",
        index: 0,
        expected: "event user",
        observed: { kind: "user" },
        state: "waiting",
      });
      expect(report.deviation?.schemaError).toContain("Invalid event payload for 'USER'");
    });

    test("an output is checked against the actor a provide replaced, not the setup actor", async () => {
      const provided = typed.provide({
        actors: {
          // A replacement whose output type differs from the setup actor's.
          lookup: createAsyncLogic({
            schemas: { output: z.number() },
            run: async (): Promise<never> => Promise.reject(new Error("model only")),
          }) as never,
        },
      });
      const check = (lookup: unknown) =>
        checkConformance(provided, {
          observations,
          actors: {
            callModel: { observes: "model", output: () => ({ kind: "calls", calls: ["lookup"] }) },
            lookup: { observes: "lookup", output: () => lookup },
          },
          events: { user: () => ({ type: "USER", text: "hi" }) },
        });

      expect((await check(42)).conforms).toBe(true);
      expect((await check("found")).deviation).toMatchObject({
        reason: "invalid-output",
        expected: "lookup",
      });
    });

    test("the model receives the event as its schema parsed it", async () => {
      const defaulted = setupAgent({
        context: z.object({}),
        events: { USER: z.object({ text: z.string(), lang: z.string().default("en") }) },
      }).createMachine({
        context: {},
        initial: "waiting",
        states: {
          waiting: {
            on: { USER: ({ event }) => (event.lang === "en" ? { target: "done" } : undefined) },
          },
          done: { type: "final" },
        },
      });
      const report = await checkConformance(defaulted, {
        observations: [{ kind: "user" }],
        actors: {},
        events: { user: () => ({ type: "USER", text: "hi" }) as never },
      });
      expect(report.deviation).toBeUndefined();
      expect(report.conforms).toBe(true);
    });
  });
});
