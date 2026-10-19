/**
 * The fixtures are real: every variant the fake runner answers for is run
 * here with the real `node --test` runner, and must report exactly the same
 * failing tests. Novel tasks have no reference: no file passes both suites.
 */
import { describe, expect, test } from "vitest";
import { nodeTestRunner, parseTap } from "./checks.js";
import { ALL_TASKS, HELD_OUT_TASKS, TRAIN_TASKS, readFixture } from "./tasks.js";
import { VARIANT_RESULTS, fakeRunner } from "./test-doubles.js";

describe("tasks", () => {
  test("splits: train and held-out each hold a novel-expected task", () => {
    expect(TRAIN_TASKS.map((t) => t.id)).toEqual([
      "clamp",
      "slugify",
      "chunk",
      "parse-duration",
      "round-half",
    ]);
    expect(HELD_OUT_TASKS.map((t) => t.id)).toEqual([
      "truncate",
      "capitalize-words",
      "merge-config",
    ]);
    for (const split of [TRAIN_TASKS, HELD_OUT_TASKS]) {
      expect(split.some((t) => t.label === "novel-expected")).toBe(true);
    }
    for (const task of ALL_TASKS) expect(task.visibleTestNames).toHaveLength(3);
  });

  test(
    "the fake runner's table matches node --test on every variant, and every starter fails",
    { timeout: 60_000 },
    async () => {
      const runs = ALL_TASKS.flatMap((task) =>
        (["starter", "draft", "reference"] as const).flatMap((variant) => {
          const code = readFixture(task.id, `${variant}.mjs`);
          return code === undefined
            ? []
            : (["visible", "hidden"] as const).map(async (suite) => {
                const real = await nodeTestRunner(task, code, suite);
                return { task, variant, suite, real, fake: await fakeRunner(task, code, suite) };
              });
        }),
      );
      for (const { task, variant, suite, real, fake } of await Promise.all(runs)) {
        const where = `${task.id} ${variant} ${suite}`;
        if (variant === "starter") {
          expect(real.passed, where).toBe(false);
          continue;
        }
        expect(real.failingTests, where).toEqual(VARIANT_RESULTS[task.id]![variant]![suite]);
        expect([fake.passed, fake.failingTests], where).toEqual([real.passed, real.failingTests]);
      }
      for (const task of ALL_TASKS) {
        expect(readFixture(task.id, "reference.mjs") === undefined, task.id).toBe(
          task.label === "novel-expected",
        );
      }
    },
  );

  test("a syntax error fails outside every visible test name", async () => {
    const result = await nodeTestRunner(ALL_TASKS[0]!, "export const clamp = (", "visible");
    expect(result.passed).toBe(false);
    expect(result.failingTests).toEqual(["visible-tests.mjs"]);
    expect(result.output).toContain("SyntaxError");
  });

  test("parseTap keeps the assertion message", () => {
    const tap = [
      "TAP version 13",
      "not ok 2 - adds two",
      "  ---",
      "  error: |-",
      "    Expected values to be strictly equal:",
      "    2 !== 3",
      "  expected: 3",
      "  actual: 2",
      "  ...",
      "1..2",
    ].join("\n");
    expect(parseTap(tap, 1)).toEqual({
      passed: false,
      failingTests: ["adds two"],
      output:
        "not ok - adds two\n  Expected values to be strictly equal:\n  2 !== 3\n  expected: 3\n  actual: 2",
    });
  });
});
