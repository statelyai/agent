import { expect, test } from "vitest";
import { replay } from "@statelyai/agent/log";
import { canReach } from "@statelyai/agent/testing";
import {
  createGovernor,
  governorMachine,
  LEVELS,
  runHarnessGovernorExample,
  TOOLS,
  type Level,
  type Tool,
} from "./index.js";

type Snapshot = Parameters<Exclude<Parameters<typeof canReach>[1], string>>[0];
type Context = { clearance: Level; level: Level; active: Tool | null };

const context = (snapshot: Snapshot) => snapshot.context as Context;
const rank = (level: Level) => LEVELS.indexOf(level);

/** Every classifier verdict, a label that is not a level, and a classifier failure. */
const everyBranch = (clearance: Level) => ({
  input: { clearance },
  outputs: { classify: [...LEVELS, "unlabelled"] },
  errors: { classify: new Error("classifier down") },
  dedupeBy: (snapshot: Snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
});

test("the default run denies, withholds, and resumes after a discard", async () => {
  const result = await runHarnessGovernorExample();
  expect(result.steps.map((step) => [step.tool, step.outcome])).toEqual([
    ["web_search", "result"],
    ["query_records", "result"],
    ["web_search", "denied"], // the session has seen confidential data
    ["query_records", "withheld"], // secret is above a confidential clearance
    ["read_file", "denied"], // locked
    ["read_file", "result"], // after the operator's DISCARD
  ]);
  expect(result.locked).toBe(true);
  expect(result.level).toBe("confidential");
});

test("the tool list follows the state", async () => {
  const governor = createGovernor({ clearance: "secret", classify: async () => "confidential" });
  expect(governor.allowedTools()).toEqual([...TOOLS]);

  expect(governor.authorize("query_records")).toBe(true);
  expect(governor.allowedTools()).toEqual([]); // one call at a time
  await governor.admit("a confidential record");

  expect(governor.allowedTools()).toEqual(["read_file", "query_records"]);
});

test("a classifier failure locks the session", async () => {
  const governor = createGovernor({
    clearance: "secret",
    classify: async () => {
      throw new Error("classifier down");
    },
  });
  governor.authorize("query_records");
  expect(await governor.admit("anything")).toEqual({ admitted: false, reason: "locked" });
  expect(governor.requestModel()).toBe(false);
  expect(governor.allowedTools()).toEqual([]);
});

test("a verdict that is not a level locks the session", async () => {
  const governor = createGovernor({
    clearance: "secret",
    classify: async () => "unlabelled" as Level,
  });
  governor.authorize("query_records");
  expect(await governor.admit("anything")).toEqual({ admitted: false, reason: "locked" });
});

test("a file read raises the level like any other result", async () => {
  const governor = createGovernor({ clearance: "secret", classify: async () => "confidential" });
  governor.authorize("read_file");
  await governor.admit("a confidential file");
  expect(governor.allowedTools()).toEqual(["read_file", "query_records"]);
});

test("a result with no authorized call behind it is refused", async () => {
  const classified: string[] = [];
  const governor = createGovernor({
    clearance: "secret",
    classify: async (_tool, result) => {
      classified.push(result);
      return "public";
    },
  });
  expect(await governor.admit("never authorized")).toEqual({
    admitted: false,
    reason: "not-running",
  });
  expect(classified).toEqual([]);
});

test("the log keeps refused attempts, holds no tool result, and replays", async () => {
  const result = await runHarnessGovernorExample();
  expect(result.entries.map((entry) => entry.event.type)).toEqual([
    "@agent.init",
    "TOOL_CALL",
    "TOOL_RESULT",
    "xstate.done.actor",
    "MODEL_REQUEST",
    "TOOL_CALL",
    "TOOL_RESULT",
    "xstate.done.actor",
    "MODEL_REQUEST",
    "TOOL_CALL", // web_search, refused
    "TOOL_CALL",
    "TOOL_RESULT",
    "xstate.done.actor",
    "MODEL_REQUEST", // refused: locked
    "TOOL_CALL", // read_file, refused: locked
    "DISCARD",
    "TOOL_CALL",
    "TOOL_RESULT",
    "xstate.done.actor",
    "MODEL_REQUEST",
    "END",
  ]);

  const stored = JSON.stringify(result.entries);
  expect(stored).not.toContain("412 MW");
  expect(stored).not.toContain("relay settings");

  const { snapshot } = replay(governorMachine, result.entries);
  expect(snapshot.value).toBe("ended");
  expect(snapshot.context.level).toBe("confidential");
});

test("canReach: web_search is never available once the level is above public", async () => {
  for (const clearance of LEVELS) {
    const violation = await canReach(
      governorMachine,
      (snapshot) =>
        context(snapshot).level !== "public" &&
        snapshot.can({ type: "TOOL_CALL", tool: "web_search" }),
      everyBranch(clearance),
    );
    expect(violation.reachable, clearance).toBe(false);
    expect(violation.complete, violation.unexplored?.join("; ")).toBe(true);
  }
});

test("canReach: the model is never called while a result is held", async () => {
  for (const clearance of LEVELS) {
    const violation = await canReach(
      governorMachine,
      (snapshot) => context(snapshot).active !== null && snapshot.can({ type: "MODEL_REQUEST" }),
      everyBranch(clearance),
    );
    expect(violation.reachable, clearance).toBe(false);
    expect(violation.complete).toBe(true);
  }
});

test("canReach: the session level never exceeds the clearance", async () => {
  for (const clearance of LEVELS) {
    const violation = await canReach(
      governorMachine,
      (snapshot) => rank(context(snapshot).level) > rank(context(snapshot).clearance),
      everyBranch(clearance),
    );
    expect(violation.reachable, clearance).toBe(false);
    expect(violation.complete).toBe(true);
  }
});

test("canReach: the search does reach the states the proofs rule on", async () => {
  // Without the failure branch, the only way into `locked` is a verdict.
  const { errors: _errors, ...verdictsOnly } = everyBranch("confidential");
  const locked = await canReach(governorMachine, "locked", verdictsOnly);
  expect(locked.witness).toMatchObject([
    { type: "TOOL_CALL" },
    { type: "TOOL_RESULT" },
    { type: "xstate.done.actor", output: "secret" },
  ]);

  const failed = await canReach(governorMachine, "locked", everyBranch("secret"));
  expect(failed.witness?.at(-1)?.type).toBe("xstate.error.actor");

  const raised = await canReach(
    governorMachine,
    (snapshot) => snapshot.matches("ready") && context(snapshot).level === "confidential",
    everyBranch("confidential"),
  );
  expect(raised.reachable).toBe(true);
});
