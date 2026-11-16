import { describe, expect, test } from "vitest";
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
    replied: { type: "final" },
    declined: { type: "final" },
    stepLimit: { type: "final" },
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
  await supportLoop(fx, maxSteps, bug);
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
      checkConformance(model, { observations: [], actors: { asist: {} } }),
    ).rejects.toMatchObject({ code: "unknown-actor-source" });
    await expect(
      checkConformance(model, { observations: [], actors: { asist: {} } }),
    ).rejects.toBeInstanceOf(AgentError);
  });
});
