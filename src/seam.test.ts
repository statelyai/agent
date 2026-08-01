/**
 * Keyless: every test scripts the whole call plan, so the routing, the slicing
 * and the drive loop are testable with no key and no network.
 */
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { matchesTrajectory, runSeam, setupAgent } from "./index.js";
import type { SeamTurn } from "./index.js";

const assessmentSchema = z.object({ satisfied: z.boolean(), question: z.string() });
const draftSchema = z.object({ subject: z.string(), body: z.string() });

/**
 * A two-request, three-pause machine shaped like the email drafter: assess →
 * (ask)? → write → review → (write again)? → done. Requests are NAMED
 * (`assess`, `write`) and share no model key, so both addressing modes are
 * exercisable on the same run.
 */
const setup = setupAgent({
  context: z.object({
    prompt: z.string(),
    satisfied: z.boolean(),
    draft: draftSchema.nullable(),
  }),
  output: z.object({ draft: draftSchema.nullable() }),
  events: {
    SUBMIT: z.object({ prompt: z.string() }),
    MORE: z.object({ details: z.string() }),
    ANYWAY: {},
    REVISE: z.object({ changes: z.string() }),
    ACCEPT: {},
  },
  requests: {
    assess: {
      schemas: { input: z.object({ prompt: z.string() }), output: assessmentSchema },
      model: "judge",
      prompt: ({ input }) => input.prompt,
    },
    write: {
      schemas: { input: z.object({ prompt: z.string() }), output: draftSchema },
      model: "writer",
      prompt: ({ input }) => input.prompt,
    },
  },
  isSuspended: (snapshot) =>
    typeof snapshot.value === "string" &&
    ["prompting", "asking", "reviewing"].includes(snapshot.value),
});

const machine = setup.createMachine({
  context: { prompt: "", satisfied: false, draft: null },
  output: ({ context }) => ({ draft: context.draft }),
  initial: "prompting",
  states: {
    prompting: {
      on: {
        SUBMIT: ({ event }) => ({ target: "assessing", context: { prompt: event.prompt } }),
      },
    },
    assessing: {
      invoke: {
        src: "assess",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({
          target: output.satisfied ? "writing" : "asking",
          context: { satisfied: output.satisfied },
        }),
      },
    },
    asking: {
      on: {
        MORE: ({ context, event }) => ({
          target: "assessing",
          context: { prompt: `${context.prompt}\n${event.details}` },
        }),
        ANYWAY: { target: "writing" },
      },
    },
    writing: {
      invoke: {
        src: "write",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output } }),
      },
    },
    reviewing: {
      on: {
        REVISE: ({ context, event }) => ({
          target: "writing",
          context: { prompt: `${context.prompt}\nRevision: ${event.changes}` },
        }),
        ACCEPT: { target: "done" },
      },
    },
    done: { type: "final" },
  },
});

const VAGUE = { satisfied: false, question: "Who is it for?" };
const COMPLETE = { satisfied: true, question: "" };
const DRAFT = { subject: "Deploy", body: "The pipeline is twice as fast." };
const REVISED = { subject: "Deploy", body: "The pipeline is twice as fast. Ships Friday." };

type Turn = SeamTurn<typeof machine>;

/** A reactive simulated user: one clarification, then optionally one revision. */
function user(options: { prompt: string; details?: string; changes?: string }) {
  const used = { details: false, changes: false };
  return ({ state }: Turn) => {
    switch (state) {
      case "prompting":
        return { type: "SUBMIT" as const, prompt: options.prompt };
      case "asking":
        if (options.details !== undefined && !used.details) {
          used.details = true;
          return { type: "MORE" as const, details: options.details };
        }
        return { type: "ANYWAY" as const };
      case "reviewing":
        if (options.changes !== undefined && !used.changes) {
          used.changes = true;
          return { type: "REVISE" as const, changes: options.changes };
        }
        return { type: "ACCEPT" as const };
      default:
        return null;
    }
  };
}

// Factories: the simulated user carries per-run state ("details used"), so each
// test gets its own.
const clarifyRun = () => ({
  scripts: { assess: [VAGUE, COMPLETE], write: [DRAFT] },
  respond: user({ prompt: "Tell them the pipeline is faster.", details: "Send it to the team." }),
});

const reviseRun = () => ({
  scripts: { assess: [COMPLETE], write: [DRAFT, REVISED] },
  respond: user({ prompt: "Tell the team the pipeline is faster.", changes: "Add the ship date." }),
});

describe("runSeam", () => {
  test("keyless: with no candidate the seam is scripted too and the run completes", async () => {
    const run = await runSeam(machine, { ...clarifyRun(), seam: { request: "assess" } });

    expect(run.result.status).toBe("done");
    expect(run.seamOutput).toEqual(VAGUE);
    expect(run.callsBeforeSeam).toBe(0);
  });

  test("slices exactly at the seam (hand-computed run)", async () => {
    const run = await runSeam(machine, { ...clarifyRun(), seam: { request: "assess" } });

    // The whole run: prompting → assessing → asking → assessing → writing →
    // reviewing → done. The seam is the FIRST `assess` call, made from
    // `assessing`, so everything from `asking` on is the branch it caused.
    expect([...run.before.statePath, ...run.after.statePath]).toEqual([
      "prompting",
      "assessing",
      "asking",
      "assessing",
      "writing",
      "reviewing",
      "done",
    ]);
    expect(run.before.statePath).toEqual(["prompting", "assessing"]);
    expect(run.after.statePath).toEqual(["asking", "assessing", "writing", "reviewing", "done"]);

    // The event slice opens with the seam's OWN effect completion.
    const after = run.after.events.map((entry) => entry.event.type);
    expect(after[0]).toMatch(/^xstate\.done/);
    expect(after).toContain("MORE");
    expect(after).toContain("ACCEPT");
    const before = run.before.events.map((entry) => entry.event.type);
    expect(before[0]).toBe("@agent.init");
    expect(before).toContain("SUBMIT");
    expect(before.filter((type) => type.startsWith("xstate.done"))).toEqual([]);

    // Both slices concatenate back to the whole log.
    expect([...run.before.events, ...run.after.events]).toEqual(run.result.events);
    // And they are `matchesTrajectory` input as-is.
    expect(matchesTrajectory(run.after.statePath, ["asking", "writing", "done"]).matched).toBe(
      true,
    );
    expect(matchesTrajectory(run.after.events, ["MORE", "ACCEPT"]).matched).toBe(true);
  });

  test("routes only the addressed occurrence to the candidate", async () => {
    const seen: string[] = [];
    const run = await runSeam(machine, {
      ...reviseRun(),
      seam: { request: "write", occurrence: 1 },
      candidate: async (request) => {
        seen.push(request.name ?? request.model);
        return { output: { subject: "Deploy", body: "Unchanged." } };
      },
    });

    // Three calls in the run (assess, write, write); exactly one is the seam.
    expect(seen).toEqual(["write"]);
    expect(run.callsBeforeSeam).toBe(2);
    expect(run.seamOutput).toEqual({ subject: "Deploy", body: "Unchanged." });
    expect(run.result.status).toBe("done");
    if (run.result.status !== "done") return;
    expect(run.result.output.draft?.body).toBe("Unchanged.");
    // The FIRST draft stayed scripted: the seam is the revision alone.
    expect(run.before.statePath).toContain("writing");
  });

  test("addresses the same call by model key", async () => {
    const seen: string[] = [];
    const run = await runSeam(machine, {
      ...reviseRun(),
      seam: { model: "writer", occurrence: 1 },
      candidate: async (request) => {
        seen.push(request.model);
        return { output: REVISED };
      },
    });

    expect(seen).toEqual(["writer"]);
    expect(run.callsBeforeSeam).toBe(2);
    expect(run.after.statePath).toEqual(["reviewing", "done"]);
  });

  test("the last scripted answer repeats, so a longer branch never runs dry", async () => {
    // One scripted draft, but the user asks for a revision: the `write` queue
    // is called twice and its last entry covers the second call.
    const run = await runSeam(machine, {
      scripts: { assess: [COMPLETE], write: [DRAFT] },
      respond: user({ prompt: "Tell the team.", changes: "Add the ship date." }),
      seam: { request: "assess" },
    });

    expect(run.result.status).toBe("done");
    if (run.result.status !== "done") return;
    expect(run.result.output.draft).toEqual(DRAFT);
    expect(run.after.statePath).toEqual(["writing", "reviewing", "writing", "reviewing", "done"]);
  });

  test("a dry queue fails the run, naming the request that went unanswered", async () => {
    // An executor error is a machine error, like any other failing invoke: the
    // run settles `error` rather than throwing out of `runSeam`.
    const run = await runSeam(machine, {
      scripts: { assess: [COMPLETE] },
      respond: user({ prompt: "Tell the team." }),
      seam: { request: "assess" },
    });

    expect(run.result.status).toBe("error");
    if (run.result.status !== "error") return;
    expect(String((run.result.error as Error).message)).toMatch(
      /no scripted answer left for request 'write' \(model 'writer'\)/,
    );
  });

  test("respond stops the run: no answer means stop at the idle pause", async () => {
    const run = await runSeam(machine, {
      scripts: { assess: [COMPLETE], write: [DRAFT] },
      seam: { request: "assess" },
    });

    expect(run.result.status).toBe("idle");
    expect(run.result.snapshot.value).toBe("prompting");
    // The seam was never reached.
    expect(run.callsBeforeSeam).toBe(-1);
    expect(run.seamOutput).toBeUndefined();
    expect(run.after.statePath).toEqual([]);
    expect(run.after.events).toEqual([]);
    expect(matchesTrajectory(run.after.statePath, ["writing"]).matched).toBe(false);
  });

  test("respond sees the pause's snapshot, state, meta and turn index", async () => {
    const turns: Array<{ state: unknown; turn: number }> = [];
    await runSeam(machine, {
      scripts: { assess: [COMPLETE], write: [DRAFT] },
      seam: { request: "assess" },
      respond: (turn) => {
        turns.push({ state: turn.state, turn: turn.turn });
        expect(turn.snapshot.status).toBe("active");
        expect(turn.meta).toEqual({});
        return turn.state === "prompting"
          ? { type: "SUBMIT" as const, prompt: "Tell the team." }
          : { type: "ACCEPT" as const };
      },
    });

    expect(turns).toEqual([
      { state: "prompting", turn: 0 },
      { state: "reviewing", turn: 1 },
    ]);
  });

  test("maxTurns bounds the drive loop", async () => {
    const run = await runSeam(machine, {
      scripts: { assess: [COMPLETE], write: [DRAFT] },
      seam: { request: "assess" },
      // The user always revises: without a bound this never settles `done`.
      respond: ({ state }) =>
        state === "prompting"
          ? { type: "SUBMIT" as const, prompt: "Tell the team." }
          : state === "reviewing"
            ? { type: "REVISE" as const, changes: "again" }
            : null,
      maxTurns: 3,
    });

    expect(run.result.status).toBe("idle");
    expect(run.after.statePath.filter((state) => state === "writing")).toHaveLength(3);
  });

  test("a candidate that branches differently is scored on the branch it caused", async () => {
    const strict = await runSeam(machine, {
      ...clarifyRun(),
      seam: { request: "assess" },
      // A candidate that waves the vague prompt through: no clarification round.
      candidate: async () => ({ output: COMPLETE }),
    });

    expect(strict.after.statePath).not.toContain("asking");
    expect(matchesTrajectory(strict.after.statePath, ["asking"]).matched).toBe(false);
    expect(strict.result.status).toBe("done");
  });
});
