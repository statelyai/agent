/**
 * Test doubles for this example. Tests only; nothing here is exported from index.ts.
 *
 *   - `mockAuthorAndReviewer`: examples/mock-model.ts answers for `writePatch`,
 *     `selfCheckPatch`, and `reviewPatch`. The author writes the task's
 *     `draft.mjs` first (or `reference.mjs` when there is no draft), and the
 *     reference once it gets feedback. A novel task has no reference, so its
 *     author keeps writing the draft. The reviewer approves the reference and
 *     names the draft's flaw; on a novel task it says the spec and the tests
 *     contradict each other.
 *   - `fakeRunner`: a `TestRunner` that answers from a table of what each
 *     fixture variant does. tasks.test.ts checks the table against the real
 *     `node --test` runner.
 *   - `issueJudge`: examples/mock-judge.ts answering `classifyIssue`'s
 *     `novel` question: novel when an issue says something contradicts.
 */
import type { AgentTextRequest } from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors, type MockTextEntry } from "../mock-model.js";
import type { CheckResult, Suite, TestRunner } from "./checks.js";
import type { Review, ReviewContext, SelfCheck } from "./environment.js";
import { ALL_TASKS, briefOf, getTask, readFixture, type TaskBrief } from "./tasks.js";

export const reference = (id: string) => readFixture(id, "reference.mjs");
export const draft = (id: string) => readFixture(id, "draft.mjs");

/** What the reviewer says about each task's draft. */
export const DRAFT_FLAWS: Record<string, string> = {
  slugify: "Leading and trailing dashes are not trimmed, and diacritics are not stripped.",
  chunk: "The last partial chunk is dropped.",
  "parse-duration": "Compound durations such as 1h30m throw instead of adding up.",
  truncate: "The result is one character longer than max.",
  "round-half":
    "The spec rounds -2.5 away from zero to -3, but the visible test expects -2: the spec and the tests contradict each other.",
  "merge-config":
    "The spec concatenates arrays, but the visible test expects the override array to replace the base one: the spec and the tests contradict each other.",
};

/**
 * What each fixture variant does under each suite, as `node --test` reports
 * it: the failing test names (empty = passed). Any other code fails every
 * visible test.
 */
export const VARIANT_RESULTS: Record<
  string,
  Partial<Record<"draft" | "reference", Record<Suite, string[]>>>
> = {
  clamp: { reference: { visible: [], hidden: [] } },
  slugify: {
    draft: {
      visible: ["trims leading and trailing dashes"],
      hidden: ["strips diacritics", "all separators becomes empty"],
    },
    reference: { visible: [], hidden: [] },
  },
  chunk: {
    draft: {
      visible: ["keeps the partial last chunk"],
      hidden: ["a size larger than the array gives one chunk"],
    },
    reference: { visible: [], hidden: [] },
  },
  "parse-duration": {
    draft: { visible: [], hidden: ["parses compound durations", "parses a three-part duration"] },
    reference: { visible: [], hidden: [] },
  },
  "round-half": {
    draft: { visible: [], hidden: ["rounds -2.5 away from zero", "rounds -0.5 away from zero"] },
  },
  truncate: {
    draft: {
      visible: ["truncates to exactly max characters with an ellipsis"],
      hidden: ["a max of 1 returns just the ellipsis", "the result is never longer than max"],
    },
    reference: { visible: [], hidden: [] },
  },
  "capitalize-words": { reference: { visible: [], hidden: [] } },
  "merge-config": {
    draft: { visible: [], hidden: ["concatenates arrays, base first"] },
  },
};

/** Which variant `code` is, for a task. */
function variantOf(taskId: string, code: string): "draft" | "reference" | undefined {
  if (code === reference(taskId)) return "reference";
  if (code === draft(taskId)) return "draft";
  return undefined;
}

export const fakeRunner: TestRunner = async (task, code, suite) => {
  const variant = variantOf(task.id, code);
  const failing = variant
    ? (VARIANT_RESULTS[task.id]?.[variant]?.[suite] ?? [])
    : getTask(task.id).visibleTestNames;
  const result: CheckResult = {
    passed: failing.length === 0,
    failingTests: failing,
    output: failing.length
      ? failing.map((name) => `not ok - ${name}`).join("\n")
      : "all tests passed",
  };
  return result;
};

type PatchInput = { task: TaskBrief; patch: string };
type WriteInput = { task: TaskBrief; round: number; previous: string; feedback: string };

/** The scripted author: the draft first, the reference once there is feedback. */
export const mockAuthor: MockTextEntry = (request: AgentTextRequest) => {
  const { task, feedback } = request.input as WriteInput;
  const first = draft(task.id) ?? reference(task.id)!;
  return feedback ? (reference(task.id) ?? first) : first;
};

export const mockSelfCheck: MockTextEntry = (request: AgentTextRequest): SelfCheck => {
  const { task, patch } = request.input as PatchInput;
  return variantOf(task.id, patch) === "reference"
    ? { ok: true, concerns: [] }
    : { ok: false, concerns: ["some edge cases may be unhandled"] };
};

export const mockReview: MockTextEntry = (request: AgentTextRequest): Review => {
  const { task, patch } = request.input as PatchInput;
  return variantOf(task.id, patch) === "reference"
    ? { approved: true, issues: [] }
    : {
        approved: false,
        issues: [{ severity: "major", note: DRAFT_FLAWS[task.id] ?? "The patch is wrong." }],
      };
};

/** The author, self-check, and reviewer over the shared mock model. */
export function mockAuthorAndReviewer(
  overrides: Record<string, MockTextEntry | MockTextEntry[]> = {},
) {
  return createMockModelExecutors({
    text: {
      writePatch: mockAuthor,
      selfCheckPatch: mockSelfCheck,
      reviewPatch: mockReview,
      ...overrides,
    },
  });
}

/** A mock decision model for `classifyIssue`: novel when an issue says something contradicts. */
export function issueJudge() {
  return createMockJudge({
    novel: (state) =>
      (state as { issues: { note: string }[] }).issues.some((issue) =>
        /contradict/i.test(issue.note),
      ),
  });
}

/** A review-loop context for probes: slugify after one round, overridable. */
export function reviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  const task = briefOf(ALL_TASKS.find((t) => t.id === "slugify")!);
  return {
    task,
    round: 1,
    roundLimit: 3,
    patch: draft("slugify")!,
    feedback: "",
    selfCheck: { ok: true, concerns: [] },
    review: { approved: true, issues: [] },
    checks: { passed: true, failingTests: [], output: "all tests passed" },
    escalation: "",
    humanApproved: false,
    notice: "",
    ...overrides,
  };
}
