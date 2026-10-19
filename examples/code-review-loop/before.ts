/**
 * BEFORE: the code-review factory as a hand-rolled loop, the starting point
 * of Part 2 in docs/from-a-loop.md. environment.ts is the same factory as a
 * machine.
 *
 * Every dependency takes the input and returns the output of the matching
 * machine request or actor (`writePatch`, `selfCheckPatch`, `reviewPatch`,
 * `runChecks`), so each line maps to one machine construct. `askHuman`
 * answers with the machine's APPROVE or REJECT event. before.test.ts runs it
 * with fakes.
 */
import type { CheckResult } from "./checks.js";
import type { Review, SelfCheck } from "./environment.js";
import type { TaskBrief } from "./tasks.js";

type PatchInput = { task: TaskBrief; patch: string };

export type FactoryDeps = {
  writePatch: (input: {
    task: TaskBrief;
    round: number;
    previous: string;
    feedback: string;
  }) => Promise<string>;
  selfCheck: (input: PatchInput) => Promise<SelfCheck>;
  reviewPatch: (input: PatchInput) => Promise<Review>;
  runChecks: (input: { taskId: string; file: string; patch: string }) => Promise<CheckResult>;
  askHuman: (input: {
    task: TaskBrief;
    patch: string;
    round: number;
    reason: string;
  }) => Promise<{ type: "APPROVE" } | { type: "REJECT"; reason: string }>;
};

export type FactoryResult = {
  outcome: "shipped" | "rejected";
  rounds: number;
  humanApproved: boolean;
  patch: string;
};

export async function runFactory(task: TaskBrief, deps: FactoryDeps): Promise<FactoryResult> {
  let patch = task.starter;
  let feedback = "";
  let round = 0;

  const escalate = async (reason: string): Promise<FactoryResult> => {
    const answer = await deps.askHuman({ task, patch, round, reason }); // blocks the process
    return answer.type === "APPROVE"
      ? { outcome: "shipped", rounds: round, humanApproved: true, patch }
      : { outcome: "rejected", rounds: round, humanApproved: false, patch };
  };

  while (round < 3) {
    patch = await deps.writePatch({ task, round, previous: patch, feedback });
    round++;
    const [self, review] = await Promise.all([
      deps.selfCheck({ task, patch }),
      deps.reviewPatch({ task, patch }),
    ]);
    const checks = await deps.runChecks({ taskId: task.id, file: task.file, patch });

    // A novel issue goes to a person even when the reviewer approved.
    if (review.issues.some((issue) => issue.severity === "novel")) {
      return escalate("the reviewer marked an issue novel");
    }
    if (checks.passed && review.approved && self.ok) {
      return { outcome: "shipped", rounds: round, humanApproved: false, patch };
    }
    // A failure outside every visible test (a crash, a timeout) is not retried.
    if (
      !checks.passed &&
      !checks.failingTests.some((name) => task.visibleTestNames.includes(name))
    ) {
      return escalate("the checks failed outside every visible test");
    }
    feedback = [
      checks.passed
        ? ""
        : `Failing visible tests: ${checks.failingTests.join(", ")}\n${checks.output}`,
      ...review.issues.map((issue) => `Reviewer [${issue.severity}]: ${issue.note}`),
      ...self.concerns.map((concern) => `Self-check: ${concern}`),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return escalate("round cap");
}
