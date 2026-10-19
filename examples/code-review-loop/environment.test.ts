/**
 * The ENVIRONMENT on its own: the ship invariant proven with `canReach`, the
 * RETRY rules as guards, and runs over mock author/reviewer/self-check
 * executors with a fake `runChecks`. No keys, no network, no claude CLI.
 */
import { describe, expect, test, vi } from "vitest";
import { createMachine, type AnyMachineSnapshot, type AnyStateMachine } from "xstate";
import {
  createAgentRuntime,
  eventFromInteraction,
  getInteraction,
  runToQuiescence,
  type AgentDecisionExecutor,
  type ChosenEvent,
} from "@statelyai/agent";
import { createInMemoryEventLogStore, getDecisionAttempts } from "@statelyai/agent/log";
import { canReach, lintAgentMachine, type ExplorePathsOptions } from "@statelyai/agent/testing";
import {
  MAX_ROUNDS,
  MAX_TOTAL_ROUNDS,
  codeReviewLoopMachine,
  createRunChecks,
  retryBlocker,
  triagePayloads,
  type ReviewContext,
} from "./environment.js";
import { briefOf, getTask } from "./tasks.js";
import {
  draft,
  fakeRunner,
  mockAuthorAndReviewer,
  reference,
  reviewContext,
} from "./test-doubles.js";

// ─── The proof ───
//
// Every invoke forks over an adversarial output table plus a failure: the
// self-check ok or not, the review approved or not with minor, major, and
// novel issues (approved-with-a-novel-issue included), and the checks
// passed, failed on a visible test, failed on an unknown name, or failed
// with no name at all. The triage decision forks over RETRY and every
// ESCALATE reason, and over a decider that gives up; the human wait forks
// over APPROVE, REQUEST_CHANGES, and REJECT. The outputs are not tied to the
// patch, so this covers every author, reviewer, and test run, not only the
// fixtures.
//
// `dedupeBy` explores each guard-relevant projection once: the state value,
// round, round limit, human approval, and the parts of checks, review, and
// self-check that a guard or choice reads. Two snapshots with the same
// projection have the same futures, so `complete: true` makes
// `reachable: false` a proof within the round ceiling.

const issue = (severity: "minor" | "major" | "novel") => ({ severity, note: severity });
const failure = new Error("down");

const projection = (snapshot: AnyMachineSnapshot) => {
  const c = snapshot.context as ReviewContext;
  return JSON.stringify([
    snapshot.value,
    c.round,
    c.roundLimit,
    c.humanApproved,
    c.checks && [c.checks.passed, [...c.checks.failingTests].sort()],
    c.review && [c.review.approved, [...new Set(c.review.issues.map((i) => i.severity))].sort()],
    c.selfCheck?.ok,
  ]);
};

const proofOptions: ExplorePathsOptions = {
  input: { taskId: "slugify" },
  payloads: () => ({
    RETRY: [{ feedback: "explore", focus: "all" }],
    REQUEST_CHANGES: [{ notes: "explore" }],
    REJECT: [{ reason: "explore" }],
  }),
  outputs: {
    writePatch: ["export const patch = 1;"],
    selfCheckPatch: [
      { ok: true, concerns: [] },
      { ok: false, concerns: ["maybe"] },
    ],
    reviewPatch: [
      { approved: true, issues: [] },
      { approved: false, issues: [issue("minor")] },
      { approved: false, issues: [issue("major")] },
      { approved: false, issues: [issue("novel")] },
      { approved: true, issues: [issue("novel")] },
    ],
    runChecks: [
      { passed: true, failingTests: [], output: "" },
      { passed: false, failingTests: ["collapses runs of separators"], output: "" },
      { passed: false, failingTests: ["not a visible test"], output: "" },
      { passed: false, failingTests: [], output: "SyntaxError" },
    ],
  },
  errors: {
    writePatch: failure,
    selfCheckPatch: failure,
    reviewPatch: failure,
    runChecks: failure,
    "agent.decide": failure,
  },
  dedupeBy: projection,
  // Each round spends at most 6 branch points (patch, self-check, review,
  // checks, triage, a person), for at most MAX_TOTAL_ROUNDS rounds.
  maxDepth: 6 * MAX_TOTAL_ROUNDS + 6,
  maxPaths: 1_000_000,
  maxNodes: 2_000_000,
};

const SEARCH_TIMEOUT_MS = 60_000;

/** A copy of the loop whose auto-ship guard forgets the reviewer: checks passing is enough. */
function brokenLoop(): AnyStateMachine {
  const config = codeReviewLoopMachine.config as Record<string, any>;
  return createMachine({
    ...config,
    states: {
      ...config.states,
      triaging: {
        type: "choice",
        choice: ({ context }: { context: ReviewContext }) =>
          context.checks?.passed
            ? { target: "checkingShip" }
            : context.round >= context.roundLimit
              ? { target: "humanReview" }
              : { target: "deciding" },
      },
    },
  } as never);
}

const formatPath = (path: ChosenEvent[]) =>
  path
    .map((event) => {
      const output = (event as { output?: unknown }).output;
      return output === undefined ? event.type : `${event.type}(${JSON.stringify(output)})`;
    })
    .join(" → ");

describe("the review loop (the environment)", () => {
  test("lints clean and states its goal", () => {
    expect(lintAgentMachine(codeReviewLoopMachine)).toEqual([]);
    expect(codeReviewLoopMachine.root.description).toMatch(/^Ship a patch for each coding task/);
  });

  test(
    "canReach proof: no author, reviewer, check result, triage, or person reaches illegallyShipped",
    async () => {
      const started = performance.now();
      const violation = await canReach(codeReviewLoopMachine, "illegallyShipped", proofOptions);
      console.log(
        `proof: reachable=${violation.reachable} complete=${violation.complete} ` +
          `(${Math.round(performance.now() - started)}ms)`,
      );
      expect(violation).toMatchObject({ reachable: false, complete: true });

      // The search is real: the same options reach every outcome.
      for (const state of ["shipped", "humanReview", "rejected", "failed"]) {
        const reached = await canReach(codeReviewLoopMachine, state, proofOptions);
        expect(reached.reachable, state).toBe(true);
      }
    },
    SEARCH_TIMEOUT_MS,
  );

  test(
    "a guard copy that ships on passing checks alone IS caught, with a witness",
    async () => {
      const leak = await canReach(brokenLoop(), "illegallyShipped", proofOptions);
      expect(leak.reachable).toBe(true);
      console.log(`broken-guard witness: ${formatPath(leak.witness!)}`);
      const types = leak.witness!.map((event) => event.type);
      expect(types.at(-1)).toBe("xstate.done.actor.runChecks");
    },
    SEARCH_TIMEOUT_MS,
  );
});

// ─── Runs over mock executors ───

/** A plain-function triage decider that takes the first offered option of `type`, else ESCALATE. */
const prefer =
  (type: "RETRY" | "ESCALATE"): AgentDecisionExecutor =>
  async (request) => {
    const options = request.options ?? [];
    const chosen = options.find((o) => o.event.type === type) ?? options[0];
    if (!chosen) throw new Error("no options offered");
    return { event: chosen.event };
  };

function runtime(
  decide: AgentDecisionExecutor,
  options: { store?: ReturnType<typeof createInMemoryEventLogStore>; threadId?: string } = {},
) {
  const text = mockAuthorAndReviewer();
  return {
    text,
    create: () =>
      createAgentRuntime(codeReviewLoopMachine, {
        executors: { generateText: text.generateText, decide },
        actors: { runChecks: createRunChecks(fakeRunner) },
        ...(options.store ? { store: options.store, threadId: options.threadId ?? "t" } : {}),
      }),
  };
}

describe("a run over mock author, reviewer, and checks", () => {
  test("happy path: a correct first patch ships on round 1 without asking the policy", async () => {
    const decide = vi.fn(prefer("RETRY"));
    const { create, text } = runtime(decide);
    const result = await runToQuiescence(create(), { input: { taskId: "clamp" } });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output).toMatchObject({ outcome: "shipped", rounds: 1, humanApproved: false });
    expect(result.output.patch).toBe(reference("clamp"));
    expect(decide).not.toHaveBeenCalled();
    // Self-check and review ran in parallel on the same patch.
    expect(text.calls.map((call) => call.name).sort()).toEqual([
      "reviewPatch",
      "selfCheckPatch",
      "writePatch",
    ]);
  });

  test("failing checks -> RETRY with the failing tests -> ships on round 2", async () => {
    const store = createInMemoryEventLogStore();
    const seen: unknown[] = [];
    const { create, text } = runtime(
      async (request, info) => {
        seen.push(request.options?.map((o) => o.event));
        return prefer("RETRY")(request, info);
      },
      { store, threadId: "slugify" },
    );
    const result = await runToQuiescence(create(), { input: { taskId: "slugify" } });
    expect(result.status === "done" && result.output).toMatchObject({
      outcome: "shipped",
      rounds: 2,
    });

    // The closed choice: RETRY per focus (all, tests, review), then every ESCALATE reason.
    expect(seen[0]).toEqual([
      expect.objectContaining({ type: "RETRY", focus: "all" }),
      expect.objectContaining({ type: "RETRY", focus: "tests" }),
      expect.objectContaining({ type: "RETRY", focus: "review" }),
      { type: "ESCALATE", reason: "spec is ambiguous or contradictory" },
      { type: "ESCALATE", reason: "needs a design decision" },
      { type: "ESCALATE", reason: "repeated failures" },
    ]);
    // The second patch was written from the feedback, which names the failing test.
    const writes = text.calls.filter((call) => call.name === "writePatch");
    expect(writes).toHaveLength(2);
    expect((writes[1]!.input as { feedback: string }).feedback).toContain(
      "trims leading and trailing dashes",
    );
    // The thread holds the whole run, init first.
    const entries = await store.read("slugify");
    expect(entries[0]?.event.type).toBe("@agent.init");
    expect(entries.some((entry) => entry.event.type === "RETRY")).toBe(true);
  });

  test("a novel issue withholds RETRY: humanReview idles with an interaction, APPROVE resumes from the persisted snapshot", async () => {
    const offered: string[][] = [];
    // The reviewer marks the contradiction novel.
    const text = mockAuthorAndReviewer({
      reviewPatch: {
        approved: false,
        issues: [{ severity: "novel", note: "the spec contradicts the visible tests" }],
      },
    });
    const decideSpy: AgentDecisionExecutor = async (request, info) => {
      offered.push((request.options ?? []).map((o) => o.event.type));
      return prefer("RETRY")(request, info);
    };
    const novelRuntime = () =>
      createAgentRuntime(codeReviewLoopMachine, {
        executors: { generateText: text.generateText, decide: decideSpy },
        actors: { runChecks: createRunChecks(fakeRunner) },
      });

    let result = await runToQuiescence(novelRuntime(), { input: { taskId: "round-half" } });
    expect(result.status).toBe("idle");
    expect(result.snapshot.matches("humanReview")).toBe(true);
    // Only ESCALATE was offered, so even a RETRY-first decider escalated.
    expect(offered.at(-1)).toEqual(["ESCALATE", "ESCALATE", "ESCALATE"]);
    expect(result.snapshot.context.escalation).toBe(
      "Escalated: spec is ambiguous or contradictory.",
    );

    const interaction = getInteraction(result.snapshot);
    expect(interaction?.label).toContain("Escalated: spec is ambiguous or contradictory.");
    expect(interaction?.events?.map((e) => e.type).sort()).toEqual([
      "APPROVE",
      "REJECT",
      "REQUEST_CHANGES",
    ]);
    // Typed text is a change request, never a silent approve or reject.
    expect(eventFromInteraction(result.snapshot, { text: "follow the spec" })).toEqual({
      type: "REQUEST_CHANGES",
      notes: "follow the spec",
    });

    result = await runToQuiescence(novelRuntime(), {
      snapshot: result.persist(),
      event: { type: "APPROVE" },
    });
    expect(result.status === "done" && result.output).toMatchObject({
      outcome: "shipped",
      humanApproved: true,
      rounds: 1,
      patch: draft("round-half"),
    });
  });

  test("the round cap: a decider that always retries is stopped at MAX_ROUNDS and sent to a person", async () => {
    const { create } = runtime(prefer("RETRY"));
    // round-half's draft passes the visible tests but the reviewer never approves it.
    const result = await runToQuiescence(create(), { input: { taskId: "round-half" } });
    expect(result.status).toBe("idle");
    expect(result.snapshot.matches("humanReview")).toBe(true);
    expect(result.snapshot.context.round).toBe(MAX_ROUNDS);
    expect(result.snapshot.context.escalation).toMatch(/^Round cap/);
  });

  test("REQUEST_CHANGES grants more rounds, up to the hard ceiling", async () => {
    const { create } = runtime(prefer("RETRY"));
    let result = await runToQuiescence(create(), { input: { taskId: "round-half" } });
    result = await runToQuiescence(create(), {
      snapshot: result.persist(),
      event: { type: "REQUEST_CHANGES", notes: "follow the spec" },
    });
    expect(result.snapshot.matches("humanReview")).toBe(true);
    expect(result.snapshot.context.round).toBe(MAX_TOTAL_ROUNDS);
    // At the ceiling a person can only ship or reject.
    expect(result.snapshot.can({ type: "REQUEST_CHANGES", notes: "again" })).toBe(false);
    expect(result.snapshot.can({ type: "REJECT", reason: "no" })).toBe(true);
  });
});

describe("the RETRY rules", () => {
  const deciding = (overrides: Partial<ReviewContext>) =>
    codeReviewLoopMachine.resolveState({ value: "deciding", context: reviewContext(overrides) });
  const retry = { type: "RETRY", feedback: "x", focus: "all" } as const;
  const failingVisible = {
    passed: false,
    failingTests: ["trims leading and trailing dashes"],
    output: "",
  };

  test("legal on a failing visible test under the cap", () => {
    expect(deciding({ checks: failingVisible }).can(retry)).toBe(true);
    expect(retryBlocker(reviewContext({ checks: failingVisible }))).toBeUndefined();
  });

  test("refused at the round cap", () => {
    const context = { checks: failingVisible, round: MAX_ROUNDS };
    expect(deciding(context).can(retry)).toBe(false);
    expect(retryBlocker(reviewContext(context))).toMatch(/round cap/);
    expect(triagePayloads(reviewContext(context)).RETRY).toEqual([]);
  });

  test("refused when the reviewer marked an issue novel", () => {
    const context = {
      checks: failingVisible,
      review: { approved: false, issues: [{ severity: "novel" as const, note: "broken task" }] },
    };
    expect(deciding(context).can(retry)).toBe(false);
    expect(triagePayloads(reviewContext(context)).RETRY).toEqual([]);
  });

  test("refused when the checks failed outside every visible test (a crash)", () => {
    const crash = { passed: false, failingTests: ["visible-tests.mjs"], output: "SyntaxError" };
    expect(deciding({ checks: crash }).can(retry)).toBe(false);
    expect(retryBlocker(reviewContext({ checks: crash }))).toMatch(/outside every visible test/);
  });

  test("a task brief carries its visible test names", () => {
    expect(briefOf(getTask("slugify")).visibleTestNames).toContain(
      "trims leading and trailing dashes",
    );
  });

  test("the store records refused triage choices on the entry that landed", async () => {
    const store = createInMemoryEventLogStore();
    // First try is an option that was never offered; the retry lands.
    const sloppy: AgentDecisionExecutor = async (request, info) =>
      request.attempts.length === 0
        ? { event: { type: "RETRY", feedback: "made up", focus: "all" } }
        : prefer("RETRY")(request, info);
    const { create } = runtime(sloppy, { store, threadId: "sloppy" });
    const result = await runToQuiescence(create(), { input: { taskId: "chunk" } });
    expect(result.status === "done" && result.output.outcome).toBe("shipped");
    const refused = getDecisionAttempts(await store.read("sloppy"));
    expect(refused).toHaveLength(1);
    expect(refused[0]!.eventType).toBe("RETRY");
    expect(refused[0]!.attempts[0]!.failure).toBe("rejected-by-guard");
  });
});
