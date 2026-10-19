/**
 * Automated checks: write a patch into a temp copy of a task fixture and run
 * one of its test files with `node --test` (no install, no network).
 *
 * `runChecks` in the environment runs the VISIBLE suite every round. The
 * objective runs the HIDDEN suite once, on whatever shipped. Tests swap the
 * real runner for a fake one (see test-doubles.ts) whose answers
 * tasks.test.ts checks against this runner.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixturePath, type TaskBrief } from "./tasks.js";

export type Suite = "visible" | "hidden";

/** What one suite run reports. `failingTests` are the names on `not ok` lines, in order. */
export type CheckResult = {
  passed: boolean;
  failingTests: string[];
  /** A short, model-readable summary: each failure with its assertion message. */
  output: string;
};

/** Runs one suite of a task against `code` (the full contents of `task.file`). */
export type TestRunner = (
  task: Pick<TaskBrief, "id" | "file">,
  code: string,
  suite: Suite,
) => Promise<CheckResult>;

const MAX_OUTPUT = 2_000;

/**
 * Parses `node --test --test-reporter=tap` output: every `not ok` line names
 * a failing test, and the YAML block under it carries the assertion message.
 * Top-level `#` comments (a syntax error, a crash) are kept too.
 */
export function parseTap(tap: string, exitCode: number): CheckResult {
  const lines = tap.split("\n");
  const failingTests: string[] = [];
  const summary: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const notOk = /^\s*not ok \d+ - (.+)$/.exec(lines[i]!);
    if (!notOk) continue;
    const name = notOk[1]!.trim();
    failingTests.push(name);
    summary.push(`not ok - ${name}`);
    for (let j = i + 1; j < lines.length && !/^\s*\.\.\.$/.test(lines[j]!); j++) {
      const line = lines[j]!.trim();
      if (/^(expected|actual|operator):/.test(line)) summary.push(`  ${line}`);
      if (line.startsWith("error:")) {
        const inline = line.replace(/^error:\s*/, "");
        if (inline && inline !== "|-") summary.push(`  ${inline}`);
        // A block scalar: the indented lines that follow.
        for (let k = j + 1; k < lines.length && /^\s{4,}/.test(lines[k]!); k++) {
          const text = lines[k]!.trim();
          if (text) summary.push(`  ${text}`);
        }
      }
    }
  }
  const crash = lines
    .filter((line) => /^# (\S.*Error|file:)/.test(line))
    .map((line) => line.slice(2))
    .slice(0, 4);
  const output = [...crash, ...summary].join("\n").slice(0, MAX_OUTPUT);
  const passed = exitCode === 0 && failingTests.length === 0;
  return {
    passed,
    failingTests,
    output: passed ? "all tests passed" : output || tap.slice(-MAX_OUTPUT),
  };
}

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 20_000, encoding: "utf-8" }, (error, stdout) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ stdout: String(stdout), exitCode: code });
    });
  });
}

/** The real runner: a temp dir holding the patch and one test file, then `node --test`. */
export const nodeTestRunner: TestRunner = async (task, code, suite) => {
  const dir = await mkdtemp(path.join(tmpdir(), `code-review-loop-${task.id}-`));
  try {
    await writeFile(path.join(dir, task.file), code);
    const testFile = `${suite}-tests.mjs`;
    await copyFile(fixturePath(task.id, testFile), path.join(dir, testFile));
    const { stdout, exitCode } = await run(
      process.execPath,
      ["--test", "--test-reporter=tap", testFile],
      dir,
    );
    return parseTap(stdout, exitCode);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
