/**
 * The hand-rolled loop (before.ts) over plain fakes: no keys, no network.
 * The last test runs the same outage through the machine.
 */
import { describe, expect, test, vi } from "vitest";
import { type AgentTextRequest, runAgent } from "@statelyai/agent";
import { runFactory, type FactoryDeps } from "./before.js";
import { codeReviewLoopMachine, createRunChecks, type Review } from "./environment.js";
import { createPolicyDecide, loadPolicy, withPolicy } from "./policy.js";
import { briefOf, getTask } from "./tasks.js";
import {
  DRAFT_FLAWS,
  draft,
  fakeRunner,
  mockAuthorAndReviewer,
  mockReview,
  reference,
} from "./test-doubles.js";

const notAsked: FactoryDeps["askHuman"] = async () => {
  throw new Error("askHuman should not be called");
};

/** The same scripted author, self-check, reviewer, and checks as the machine's tests, as plain functions. */
function fakes(overrides: Partial<FactoryDeps> = {}): FactoryDeps {
  return {
    writePatch: async ({ task, feedback }) => {
      const first = draft(task.id) ?? reference(task.id)!;
      return feedback ? (reference(task.id) ?? first) : first;
    },
    selfCheck: async ({ task, patch }) =>
      patch === reference(task.id)
        ? { ok: true, concerns: [] }
        : { ok: false, concerns: ["maybe"] },
    // The reviewer marks a contradiction between spec and tests `novel`.
    reviewPatch: async ({ task, patch }) =>
      patch === reference(task.id)
        ? { approved: true, issues: [] }
        : {
            approved: false,
            issues: [
              {
                severity: /contradict/.test(DRAFT_FLAWS[task.id] ?? "") ? "novel" : "major",
                note: DRAFT_FLAWS[task.id] ?? "The patch is wrong.",
              },
            ],
          },
    runChecks: ({ taskId, file, patch }) => fakeRunner({ id: taskId, file }, patch, "visible"),
    askHuman: notAsked,
    ...overrides,
  };
}

describe("the hand-rolled loop", () => {
  test("a clean task ships on round 1 without a person", async () => {
    const result = await runFactory(briefOf(getTask("clamp")), fakes());
    expect(result).toEqual({
      outcome: "shipped",
      rounds: 1,
      humanApproved: false,
      patch: reference("clamp"),
    });
  });

  test("a failing visible test retries with feedback, then ships on round 2", async () => {
    const deps = fakes();
    const writePatch = vi.fn(deps.writePatch);
    const result = await runFactory(briefOf(getTask("slugify")), { ...deps, writePatch });
    expect(result).toMatchObject({ outcome: "shipped", rounds: 2 });
    expect(writePatch.mock.calls[1]![0].feedback).toContain("trims leading and trailing dashes");
  });

  test("a novel task escalates on round 1, and the person's answer ends the run", async () => {
    const askHuman = vi.fn<FactoryDeps["askHuman"]>(async () => ({
      type: "REJECT",
      reason: "fix the spec first",
    }));
    const result = await runFactory(briefOf(getTask("round-half")), fakes({ askHuman }));
    expect(askHuman).toHaveBeenCalledWith(
      expect.objectContaining({ round: 1, reason: "the reviewer marked an issue novel" }),
    );
    expect(result).toMatchObject({ outcome: "rejected", rounds: 1 });
  });

  // The loop's weakness: a thrown dependency rejects the whole run. Round 1's
  // patch, its review, and the feedback live only in local variables, so a
  // reviewer outage in round 2 loses the task, and no person is asked.
  test("a reviewer outage rejects the loop's promise and loses the round", async () => {
    const deps = fakes();
    let reviews = 0;
    const reviewPatch: FactoryDeps["reviewPatch"] = async (input) => {
      if (++reviews === 2) throw new Error("reviewer unavailable");
      return deps.reviewPatch(input);
    };
    const askHuman = vi.fn(notAsked);
    await expect(
      runFactory(briefOf(getTask("slugify")), { ...deps, reviewPatch, askHuman }),
    ).rejects.toThrow("reviewer unavailable");
    expect(askHuman).not.toHaveBeenCalled();
  });

  test("the machine routes the same outage to a person, with the patch and the round", async () => {
    let reviews = 0;
    const review = mockReview as (request: AgentTextRequest) => Review;
    const text = mockAuthorAndReviewer({
      reviewPatch: (request: AgentTextRequest) => {
        if (++reviews === 2) throw new Error("reviewer unavailable");
        return review(request);
      },
    });
    const result = await runAgent(codeReviewLoopMachine, {
      executors: withPolicy(text, createPolicyDecide(loadPolicy("v0"))),
      actors: { runChecks: createRunChecks(fakeRunner) },
      input: { taskId: "slugify" },
    });
    expect(result.status).toBe("idle");
    expect(result.snapshot.value).toBe("humanReview");
    expect(result.snapshot.context).toMatchObject({ round: 2, patch: reference("slugify") });
  });
});

describe("the hand-rolled loop follows the machine's rules", () => {
  const askedWith: string[] = [];
  const recordAsk: FactoryDeps["askHuman"] = async ({ reason }) => {
    askedWith.push(reason);
    return { type: "REJECT", reason: "no" };
  };

  test("an approval that flags a novel issue goes to a person, not to ship", async () => {
    askedWith.length = 0;
    const result = await runFactory(
      briefOf(getTask("clamp")),
      fakes({
        reviewPatch: async () => ({
          approved: true,
          issues: [{ severity: "novel", note: "the spec contradicts the tests" }],
        }),
        askHuman: recordAsk,
      }),
    );
    expect(result.outcome).not.toBe("shipped");
    expect(askedWith).toEqual(["the reviewer marked an issue novel"]);
  });

  test("a failure outside every visible test is escalated, not retried", async () => {
    askedWith.length = 0;
    const writePatch = vi.fn<FactoryDeps["writePatch"]>(async ({ task }) => reference(task.id)!);
    await runFactory(
      briefOf(getTask("clamp")),
      fakes({
        writePatch,
        runChecks: async () => ({ passed: false, failingTests: [], output: "timed out" }),
        askHuman: recordAsk,
      }),
    );
    expect(writePatch).toHaveBeenCalledTimes(1);
    expect(askedWith).toEqual(["the checks failed outside every visible test"]);
  });
});
