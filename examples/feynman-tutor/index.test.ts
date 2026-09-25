import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { getInteraction, getStatePath, runAgent } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJevClient, type MockJevEntry } from "../mock-jev.js";
import { createMockModelExecutors } from "../mock-model.js";
import {
  MAX_CHECKPOINTS,
  MAX_RETEACHES,
  PASS_SCORE,
  UNDERSTANDING_LEVELS,
  createVerifyExplanation,
  feynmanTutorMachine,
  runFeynmanTutorExample,
  type FeynmanHumanEvent,
} from "./index.js";

const checkpoints = [
  { title: "Two keys", keyIdea: "A public key encrypts; only the private key decrypts." },
  { title: "Signatures", keyIdea: "Signing with a private key proves who sent a message." },
];

const explain = (text: string): FeynmanHumanEvent => ({ type: "EXPLAIN", text });
/** Jev `understanding` levels (0-4 → 0-100): 3 → 75 passes PASS_SCORE, 1 → 25 does not. */
const pass = 3;
const passScore = 75;
const weak = 1;
const weakScore = 25;

/** The text model, mocked by request name; the grader is Jev, scripted separately. */
function executors() {
  return createMockModelExecutors({
    text: {
      planCheckpoints: [{ checkpoints }],
      introduceCheckpoint: [{ context: "Here is why this matters." }],
      explainSimply: [
        { explanation: "Think of a mailbox: anyone can drop mail in, only you open it." },
      ],
    },
  });
}

/** The grader's answers, in order; the last one repeats. */
function grader(levels: MockJevEntry[]) {
  return createMockJevClient({ understanding: levels });
}

test("every explanation passes: one idle turn per checkpoint, then done", async () => {
  const prompts: string[] = [];
  const result = await runFeynmanTutorExample({
    generateText: executors().generateText,
    jevClient: grader([pass]).client,
    humanEvents: [explain("public encrypts, private decrypts"), explain("signing proves identity")],
    onPrompt: (label) => prompts.push(label),
  });

  expect(result.outcome).toBe("done");
  expect(result).toMatchObject({ passed: 2, failed: 0, skipped: 0 });
  expect(result.summary).toContain("2 of 2 checkpoint(s) passed");
  expect(result.summary).toContain(`1. Two keys: passed (score ${passScore}/100)`);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("Checkpoint 1/2: Two keys");
  expect(prompts[0]).toContain("Explain this back in your own words.");
  expect(result.progress).toEqual([
    "planningCheckpoints",
    "presenting",
    "awaitingExplanation",
    "verifying",
    "presenting",
    "awaitingExplanation",
    "verifying",
    "done",
  ]);
});

test("a weak explanation is re-taught, then passes", async () => {
  const prompts: string[] = [];
  const result = await runFeynmanTutorExample({
    generateText: executors().generateText,
    jevClient: grader([weak, pass]).client,
    humanEvents: [
      explain("private encrypts?"),
      explain("public encrypts, private decrypts"),
      explain("ok"),
    ],
    onPrompt: (label) => prompts.push(label),
  });

  expect(result.outcome).toBe("done");
  expect(result.checkpoints[0]).toEqual({
    title: "Two keys",
    status: "passed",
    score: passScore,
    reteaches: 1,
  });
  // The second idle turn shows the re-teach, not the intro, and the feedback
  // is the matched rubric level.
  expect(prompts[1]).toContain(`Not yet (score ${weakScore}/100, need ${PASS_SCORE})`);
  expect(prompts[1]).toContain(UNDERSTANDING_LEVELS[weak]);
  expect(prompts[1]).toContain("mailbox");
  expect(result.progress.slice(0, 7)).toEqual([
    "planningCheckpoints",
    "presenting",
    "awaitingExplanation",
    "verifying",
    "teaching",
    "awaitingExplanation",
    "verifying",
  ]);
});

test("reteach budget exhausted: the checkpoint fails and the session moves on", async () => {
  const result = await runFeynmanTutorExample({
    // Checkpoint 1 never passes; checkpoint 2 passes first time.
    generateText: executors().generateText,
    jevClient: grader([...Array.from({ length: MAX_RETEACHES + 1 }, () => weak), pass]).client,
    humanEvents: Array.from({ length: MAX_RETEACHES + 2 }, () => explain("not sure")),
  });

  expect(result.outcome).toBe("done");
  expect(result.checkpoints[0]).toMatchObject({
    status: "failed",
    score: weakScore,
    reteaches: MAX_RETEACHES,
  });
  expect(result.checkpoints[1]).toMatchObject({ status: "passed" });
  expect(result).toMatchObject({ passed: 1, failed: 1, skipped: 0 });
  expect(result.progress.filter((state) => state === "teaching")).toHaveLength(MAX_RETEACHES);
});

test("SKIP records the checkpoint as skipped without scoring it", async () => {
  const jev = grader([pass]);
  const result = await runFeynmanTutorExample({
    generateText: executors().generateText,
    jevClient: jev.client,
    humanEvents: [{ type: "SKIP" }, explain("signing proves identity")],
  });

  expect(result.checkpoints[0]).toEqual({
    title: "Two keys",
    status: "skipped",
    score: null,
    reteaches: 0,
  });
  expect(result).toMatchObject({ passed: 1, failed: 0, skipped: 1 });
  expect(jev.calls).toHaveLength(1);
});

test("idle → persist() → resume round-trips through JSON", async () => {
  const scripted = executors();
  const actors = { verifyExplanation: createVerifyExplanation(grader([pass]).client) };
  const first = await runAgent(feynmanTutorMachine, {
    input: { topic: "RSA" },
    executors: scripted,
    actors,
  });
  expect(first.status).toBe("idle");
  if (first.status !== "idle") return;
  expect(getStatePath(first.snapshot)).toBe("awaitingExplanation");
  const interaction = getInteraction(first.snapshot);
  expect(interaction?.textEvent).toBe("EXPLAIN");
  expect(interaction?.events.map((choice) => choice.type)).toEqual(["EXPLAIN", "SKIP"]);

  const second = await runAgent(feynmanTutorMachine, {
    snapshot: JSON.parse(JSON.stringify(first.persist())),
    event: explain("public encrypts, private decrypts"),
    executors: scripted,
    actors,
  });
  expect(second.status).toBe("idle");
  if (second.status !== "idle") return;
  expect(second.snapshot.context.checkpointIndex).toBe(1);
  expect(second.snapshot.context.results).toHaveLength(1);
});

test("planner caps checkpoints at MAX_CHECKPOINTS; zero checkpoints ends in failed", async () => {
  const many = Array.from({ length: MAX_CHECKPOINTS + 2 }, (_, i) => ({
    title: `C${i}`,
    keyIdea: "x",
  }));
  const capped = await runFeynmanTutorExample({
    generateText: createMockModelExecutors({
      text: {
        planCheckpoints: [{ checkpoints: many }],
        introduceCheckpoint: [{ context: "intro" }],
      },
    }).generateText,
    jevClient: grader([pass]).client,
    humanEvents: Array.from({ length: MAX_CHECKPOINTS }, () => explain("x")),
  });
  expect(capped.checkpoints).toHaveLength(MAX_CHECKPOINTS);

  const empty = await runFeynmanTutorExample({
    generateText: createMockModelExecutors({ text: { planCheckpoints: [{ checkpoints: [] }] } })
      .generateText,
  });
  expect(empty.outcome).toBe("failed");
  expect(empty.summary).toContain("no checkpoints");
});

test("a model error lands in failed with the checkpoints finished so far", async () => {
  const result = await runFeynmanTutorExample({
    generateText: createMockModelExecutors({
      text: {
        planCheckpoints: [{ checkpoints }],
        introduceCheckpoint: [{ context: "intro" }],
      },
    }).generateText,
    jevClient: grader([
      pass,
      () => {
        throw new Error("provider down");
      },
    ]).client,
    humanEvents: [explain("a"), explain("b")],
  });
  expect(result.outcome).toBe("failed");
  expect(result.summary).toContain("verifyExplanation failed");
  expect(result.passed).toBe(1);
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  expect(starters.length).toBeGreaterThanOrEqual(2);
  for (const topic of starters) {
    const scripted = executors();
    const result = await runFeynmanTutorExample({
      topic,
      generateText: scripted.generateText,
      jevClient: grader([pass]).client,
      humanEvents: [explain("a"), explain("b")],
    });
    // Each starter is the topic the planner sees; the session asks before scoring.
    expect((scripted.calls[0]!.input as { topic: string }).topic).toBe(topic);
    expect(result.progress[2]).toBe("awaitingExplanation");
    expect(result.outcome).toBe("done");
  }
});

test("verifying asks Jev one five-level score over the checkpoint, and PASS_SCORE splits the levels", async () => {
  // Level 2 maps to 50/100, under PASS_SCORE; level 3 maps to 75/100, over it.
  const jev = grader([2, 3]);
  const result = await runFeynmanTutorExample({
    generateText: executors().generateText,
    jevClient: jev.client,
    humanEvents: [
      explain("private decrypts"),
      explain("public encrypts, private decrypts"),
      explain("signing proves identity"),
    ],
  });

  const call = jev.calls[0]!;
  expect(call.state).toEqual({
    checkpoint: "Two keys",
    keyIdea: checkpoints[0]!.keyIdea,
    explanation: "private decrypts",
  });
  expect(Object.keys(call.questions)).toEqual(["understanding"]);
  const question = call.questions.understanding!;
  expect(question.type).toBe("score");
  expect(question.type === "score" && question.criteria).toEqual([...UNDERSTANDING_LEVELS]);
  expect(result.progress.slice(3, 5)).toEqual(["verifying", "teaching"]);
  expect(result.checkpoints[0]).toMatchObject({ status: "passed", score: 75, reteaches: 1 });
});

test("lintAgentMachine is clean", () => {
  expect(() => lintAgentMachine(feynmanTutorMachine, { throw: true })).not.toThrow();
});
