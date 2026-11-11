import { expect, test } from "vitest";
import { createActor } from "xstate";
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

/** Every clearance, with every level a session can start at: a subagent starts at its parent's. */
const SESSIONS = LEVELS.flatMap((clearance) =>
  LEVELS.filter((level) => rank(level) <= rank(clearance)).map((level) => ({ clearance, level })),
);

/** Every classifier verdict, a label that is not a level, and a classifier failure. */
const everyBranch = (input: { clearance: Level; level?: Level }) => ({
  input,
  outputs: { classify: [...LEVELS, "unlabelled"] },
  errors: { classify: new Error("classifier down") },
  dedupeBy: (snapshot: Snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
});

test("the default run denies, withholds, and resumes after a discard", async () => {
  const result = await runHarnessGovernorExample();
  expect(result.steps.map((step) => [step.tool, step.outcome])).toEqual([
    ["web_search", "result"],
    ["task", "result"],
    ["web_search", "denied"], // the subagent saw confidential data
    ["query_records", "withheld"], // secret is above a confidential clearance
    ["read_file", "denied"], // locked
    ["read_file", "result"], // after the operator's DISCARD
  ]);
  expect(result.steps[1]!.steps?.map((step) => [step.tool, step.outcome])).toEqual([
    ["query_records", "result"],
    ["web_search", "denied"],
  ]);
  // The parent sees the subagent's report, at the level the subagent ended at.
  expect(result.steps[1]).toMatchObject({
    seen: "Station A: 412 MW at 14:00.",
    level: "confidential",
  });
  expect(result.locked).toBe(true);
  expect(result.level).toBe("confidential");
});

test("subagent logs are in the order the subagents started", async () => {
  const result = await runHarnessGovernorExample({
    clearance: "secret",
    script: [
      {
        tool: "task",
        query: "outer",
        subagent: [
          {
            tool: "task",
            query: "inner",
            subagent: [{ tool: "query_records", query: "station A load" }],
          },
        ],
      },
    ],
  });
  // The outer subagent starts public. The inner one's log holds the record call.
  expect(result.subagents.map((entries) => entries[1]!.event)).toEqual([
    { type: "TOOL_CALL", tool: "task" },
    { type: "TOOL_CALL", tool: "query_records" },
  ]);
  expect(result.level).toBe("confidential");
});

test("the tool list follows the state", async () => {
  const governor = createGovernor({ clearance: "secret", classify: async () => "confidential" });
  expect(governor.allowedTools()).toEqual([...TOOLS]);

  expect(governor.authorize("query_records")).toBe(true);
  expect(governor.allowedTools()).toEqual([]); // one call at a time
  await governor.admit("a confidential record");

  expect(governor.allowedTools()).toEqual(["read_file", "query_records", "task"]);
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
  expect(governor.allowedTools()).toEqual(["read_file", "query_records", "task"]);
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

test("a subagent starts at the parent's level and clearance", async () => {
  const parent = createGovernor({
    clearance: "confidential",
    classify: async () => "confidential",
  });
  parent.authorize("read_file");
  await parent.admit("a confidential file");

  expect(parent.authorize("task")).toBe(true);
  const subagent = parent.spawn();
  expect(subagent.actor.getSnapshot().context).toMatchObject({
    clearance: "confidential",
    level: "confidential",
  });
  expect(subagent.allowedTools()).not.toContain("web_search");
});

test("the parent rises to the level the subagent ended at", async () => {
  const classified: string[] = [];
  const parent = createGovernor({
    clearance: "secret",
    classify: async (_tool, result) => {
      classified.push(result);
      return "confidential";
    },
  });
  parent.authorize("task");
  const subagent = parent.spawn();
  subagent.authorize("query_records");
  await subagent.admit("a confidential record");
  subagent.end();

  expect(await parent.admit("the subagent's report")).toMatchObject({ admitted: true });
  expect(parent.actor.getSnapshot().context.level).toBe("confidential");
  expect(parent.allowedTools()).not.toContain("web_search");
  // The report takes the subagent's level. Its text is not classified.
  expect(classified).toEqual(["a confidential record"]);
});

test("a report from a subagent that has not ended locks the parent", async () => {
  const parent = createGovernor({ clearance: "secret", classify: async () => "public" });
  parent.authorize("task");
  parent.spawn();
  expect(await parent.admit("an early report")).toEqual({ admitted: false, reason: "locked" });
});

test("a task result with no subagent behind it locks the parent", async () => {
  const parent = createGovernor({ clearance: "secret", classify: async () => "public" });
  parent.authorize("task");
  expect(await parent.admit("a forged report")).toEqual({ admitted: false, reason: "locked" });
});

test("a task call gets one subagent", async () => {
  const parent = createGovernor({ clearance: "secret", classify: async () => "confidential" });
  parent.authorize("task");
  const first = parent.spawn();
  first.authorize("query_records");
  await first.admit("a confidential record");
  first.end();

  // A second subagent would end at public and lend that level to the report.
  expect(() => parent.spawn()).toThrow("This task call already has a subagent.");
  await parent.admit("the first subagent's report");
  expect(parent.actor.getSnapshot().context.level).toBe("confidential");
});

test("a session cannot start above its clearance", () => {
  expect(() =>
    createGovernor({ clearance: "public", level: "secret", classify: async () => "public" }),
  ).toThrow("A session cannot start at secret with public clearance.");
  // The machine refuses the input itself, not only the host wrapper.
  const actor = createActor(governorMachine, { input: { clearance: "public", level: "secret" } });
  expect(actor.getSnapshot().status).toBe("error");
});

test("spawn needs an authorized task call", () => {
  const governor = createGovernor({ clearance: "secret", classify: async () => "public" });
  expect(() => governor.spawn()).toThrow("spawn needs an authorized task call.");
  governor.authorize("read_file");
  expect(() => governor.spawn()).toThrow("spawn needs an authorized task call.");
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

  // A refused event is marked, so an auditor reads denials without a replay.
  expect(
    result.entries.filter((entry) => entry.ignored).map((entry) => [entry.index, entry.event]),
  ).toEqual([
    [9, { type: "TOOL_CALL", tool: "web_search" }],
    [13, { type: "MODEL_REQUEST" }],
    [14, { type: "TOOL_CALL", tool: "read_file" }],
  ]);

  // The subagent has its own log, and it starts at the parent's level.
  const [subagent] = result.subagents;
  expect(subagent![0]!.event).toMatchObject({
    input: { clearance: "confidential", level: "public" },
  });
  expect(subagent!.filter((entry) => entry.ignored).map((entry) => entry.event)).toEqual([
    { type: "TOOL_CALL", tool: "web_search" },
  ]);
  expect(replay(governorMachine, subagent!).snapshot.output).toEqual({ level: "confidential" });

  const stored = JSON.stringify([result.entries, result.subagents]);
  expect(stored).not.toContain("412 MW");
  expect(stored).not.toContain("relay settings");

  const { snapshot } = replay(governorMachine, result.entries);
  expect(snapshot.value).toBe("ended");
  expect(snapshot.context.level).toBe("confidential");
});

test("canReach: web_search is never available once the level is above public", async () => {
  for (const session of SESSIONS) {
    const violation = await canReach(
      governorMachine,
      (snapshot) =>
        context(snapshot).level !== "public" &&
        snapshot.can({ type: "TOOL_CALL", tool: "web_search" }),
      everyBranch(session),
    );
    expect(violation.reachable, JSON.stringify(session)).toBe(false);
    expect(violation.complete, violation.unexplored?.join("; ")).toBe(true);
  }
});

test("canReach: the model is never called while a result is held", async () => {
  for (const session of SESSIONS) {
    const violation = await canReach(
      governorMachine,
      (snapshot) => context(snapshot).active !== null && snapshot.can({ type: "MODEL_REQUEST" }),
      everyBranch(session),
    );
    expect(violation.reachable, JSON.stringify(session)).toBe(false);
    expect(violation.complete).toBe(true);
  }
});

test("canReach: the session level never exceeds the clearance", async () => {
  for (const session of SESSIONS) {
    const violation = await canReach(
      governorMachine,
      (snapshot) => rank(context(snapshot).level) > rank(context(snapshot).clearance),
      everyBranch(session),
    );
    expect(violation.reachable, JSON.stringify(session)).toBe(false);
    expect(violation.complete).toBe(true);
  }
});

test("canReach: a subagent's report never raises the parent above its clearance", async () => {
  // The report's level is the subagent's output. Every level a subagent can
  // end at, from every start, is at most the clearance it shares with its
  // parent, so the parent's quarantine admits the report without locking.
  for (const session of SESSIONS) {
    const violation = await canReach(
      governorMachine,
      (snapshot) =>
        snapshot.status === "done" &&
        rank((snapshot.output as { level: Level }).level) > rank(session.clearance),
      everyBranch(session),
    );
    expect(violation.reachable, JSON.stringify(session)).toBe(false);
    expect(violation.complete).toBe(true);
  }
});

test("canReach: the search does reach the states the proofs rule on", async () => {
  // Without the failure branch, the only way into `locked` is a verdict.
  const { errors: _errors, ...verdictsOnly } = everyBranch({ clearance: "confidential" });
  const locked = await canReach(governorMachine, "locked", verdictsOnly);
  expect(locked.witness).toMatchObject([
    { type: "TOOL_CALL" },
    { type: "TOOL_RESULT" },
    { type: "xstate.done.actor", output: "secret" },
  ]);

  const failed = await canReach(governorMachine, "locked", everyBranch({ clearance: "secret" }));
  expect(failed.witness?.at(-1)?.type).toBe("xstate.error.actor");

  const raised = await canReach(
    governorMachine,
    (snapshot) => snapshot.matches("ready") && context(snapshot).level === "confidential",
    everyBranch({ clearance: "confidential" }),
  );
  expect(raised.reachable).toBe(true);
});
