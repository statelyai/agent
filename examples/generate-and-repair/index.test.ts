import { expect, test } from "vitest";
import {
  assertAgentMachine,
  canReach,
  createScriptedExecutors,
  matchesTrajectory,
  runAgent,
} from "@statelyai/agent";
import type { StateValue } from "xstate";
import {
  CANDIDATE_COUNT,
  generateAndRepairMachine,
  MAX_REPAIRS,
  parseGeneratedConfig,
} from "./index.js";

const VALID = `\`\`\`json
{
  "initial": "locked",
  "states": {
    "locked": { "on": { "COIN": "unlocked" } },
    "unlocked": { "on": { "PUSH": "locked" } }
  }
}
\`\`\``;

/** Parses as JSON, but "open" is not a declared state. */
const BAD_TARGET = `\`\`\`json
{
  "initial": "locked",
  "states": { "locked": { "on": { "COIN": "open" } } }
}
\`\`\``;

const BAD_JSON = '```json\n{ "initial": "locked", }\n```';

const NO_BLOCK = "Sure! Here is a turnstile machine with two states.";

/** What `parseConfigActor` returns for `VALID` — the canned `parseConfig` output. */
const PARSED = {
  initial: "locked",
  states: {
    locked: { on: { COIN: "unlocked" } },
    unlocked: { on: { PUSH: "locked" } },
  },
};

function collectStates() {
  const statePath: StateValue[] = [];
  return {
    statePath,
    onTransition: (snapshot: { value: StateValue }) => statePath.push(snapshot.value),
  };
}

test("the first valid candidate wins, with no repair", async () => {
  // One entry per fanned-out invoke: `generating` makes three calls now, so
  // the queue holds three answers rather than one answer holding three.
  const scripted = createScriptedExecutors({
    text: { generateConfig: [VALID, BAD_JSON, NO_BLOCK] },
  });

  const result = await runAgent(generateAndRepairMachine, {
    input: { prompt: "a turnstile" },
    executors: scripted,
  });

  expect(result.status).toBe("done");
  expect(result.status === "done" && result.output.repairs).toBe(0);
  expect(result.status === "done" && result.output.config?.initial).toBe("locked");
  expect(scripted.calls.map((call) => call.name)).toEqual([
    "generateConfig",
    "generateConfig",
    "generateConfig",
  ]);
});

test("every candidate rejected, then one repair fixes it", async () => {
  const scripted = createScriptedExecutors({
    text: {
      generateConfig: [BAD_JSON, NO_BLOCK, BAD_TARGET],
      repairConfig: [VALID],
    },
  });
  const { statePath, onTransition } = collectStates();
  const rejections: string[] = [];

  const result = await runAgent(generateAndRepairMachine, {
    input: { prompt: "a turnstile" },
    executors: scripted,
    onTransition,
    on: { CANDIDATE_REJECTED: (event) => rejections.push(event.error) },
  });

  expect(result.status).toBe("done");
  expect(result.status === "done" && result.output.repairs).toBe(1);
  expect(scripted.calls.map((call) => call.name)).toEqual([
    "generateConfig",
    "generateConfig",
    "generateConfig",
    "repairConfig",
  ]);
  // All three candidates were tried before a repair was spent. The three
  // invokes settle concurrently, so the candidates are asserted as a set.
  expect(rejections).toHaveLength(CANDIDATE_COUNT);
  expect(rejections.some((error) => error.includes('"open"'))).toBe(true);
  // `checkingRepairBudget` is a choice state, so the machine never rests there
  // and it never appears in the transition log. The three `generating` entries
  // are the three fanned-out invokes settling in place; the three `parsing`
  // entries are the three candidates.
  expect(statePath).toEqual([
    "generating",
    "generating",
    "generating",
    "parsing",
    "parsing",
    "parsing",
    "repairing",
    "parsing",
    "done",
  ]);
  expect(matchesTrajectory(statePath, ["generating", "repairing", "parsing", "done"]).matched).toBe(
    true,
  );
});

test("repairs that never parse fail after the cap, having made 1 + maxRepairs calls", async () => {
  const scripted = createScriptedExecutors({
    text: {
      generateConfig: [BAD_JSON, BAD_JSON, BAD_JSON],
      repairConfig: [BAD_TARGET, BAD_JSON],
    },
  });

  const result = await runAgent(generateAndRepairMachine, {
    input: { prompt: "a turnstile" },
    executors: scripted,
  });

  expect(result.status).toBe("done");
  expect(result.status === "done" && result.output.config).toBe(null);
  expect(result.status === "done" && result.output.repairs).toBe(MAX_REPAIRS);
  expect(result.status === "done" && result.output.summary).toContain("No usable config");
  // The author fan-out plus one call per repair round, and no more.
  expect(result.usage.modelCalls).toBe(CANDIDATE_COUNT + MAX_REPAIRS);
});

test("the machine is structurally sound", async () => {
  // A clean lint is the static proof that every state, `failed` included, is a
  // target of some transition.
  assertAgentMachine(generateAndRepairMachine);

  // `explorePaths` reads pending work off the snapshot's live children, so the
  // three concurrent `generateConfig` invokes are all still there after the
  // first settles and the walk gets past `generating`.
  const canned = {
    input: { prompt: "a turnstile" },
    text: { generateConfig: VALID, repairConfig: VALID },
    invokes: { parseConfig: PARSED },
  };

  // Every candidate and every repair is rejected by the parser: the budget runs
  // out and the machine gives up.
  const failure = await canReach(generateAndRepairMachine, "failed", {
    ...canned,
    errors: { parseConfig: new Error("not a declared state") },
  });
  expect(failure.reachable).toBe(true);
  expect(failure.witness).toEqual(
    expect.arrayContaining([{ type: "xstate.error.actor.parseConfig" }]),
  );

  // And the parser accepting a candidate reaches `done`.
  expect((await canReach(generateAndRepairMachine, "done", canned)).reachable).toBe(true);
});

test("the parser rejects the shapes the repair prompt has to describe", () => {
  expect(() => parseGeneratedConfig(NO_BLOCK)).toThrow(/No JSON code block/);
  expect(() => parseGeneratedConfig(BAD_JSON)).toThrow(/not valid JSON/);
  expect(() => parseGeneratedConfig(BAD_TARGET)).toThrow(/not a declared state/);
});
