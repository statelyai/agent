/**
 * Automated checks: write a patch into a temp copy of a task fixture and run
 * one of its test files with `node --test` (no install, no network).
 *
 * The patch is untrusted model output, so the test process runs under Node's
 * permission model: reads and writes only inside the temp workspace, no child
 * processes, workers, addons, or WASI; an env holding only PATH; and SIGKILL
 * at the timeout. That narrows what a patch can do; it is not a sandbox (see
 * the README).
 *
 * `runChecks` in the environment runs the VISIBLE suite every round. The
 * objective runs the HIDDEN suite once, on whatever shipped. Tests swap the
 * real runner for a fake one (see test-doubles.ts) whose answers
 * tasks.test.ts checks against this runner.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
    let message = -1;
    for (let j = i + 1; j < lines.length && !/^\s*\.\.\.$/.test(lines[j]!); j++) {
      const line = lines[j]!.trim();
      if (/^(expected|actual|operator):/.test(line)) summary.push(`  ${line}`);
      // A load error (a syntax error in the patch) names its class on its own line.
      const errorName = /^name:\s*['"]?(\w*Error)['"]?$/.exec(line)?.[1];
      if (errorName && message >= 0)
        summary[message] = `  ${errorName}: ${summary[message]!.trim()}`;
      if (line.startsWith("error:")) {
        const inline = line.replace(/^error:\s*/, "").replace(/^(['"])(.*)\1$/, "$2");
        if (inline && inline !== "|-") message = summary.push(`  ${inline}`) - 1;
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
  // A run only passes once the reporter printed its summary: a patch that
  // calls `process.exit(0)` before the tests ran must not pass.
  const finished = /^# tests [1-9]/m.test(tap);
  const passed = exitCode === 0 && failingTests.length === 0 && finished;
  return {
    passed,
    failingTests,
    output: passed
      ? "all tests passed"
      : output ||
        (exitCode === 0 && !finished
          ? "the test run exited before reporting any results"
          : tap.slice(-MAX_OUTPUT)),
  };
}

/**
 * Replaces each workspace dir (and its `file://` URL) with `<workspace>`, so
 * check output is the same on every machine. Pass the realpath too: on macOS
 * `/var/...` is `/private/var/...`.
 */
export function scrubWorkspace(text: string, dirs: string[]): string {
  let scrubbed = text;
  for (const dir of [...new Set(dirs)].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed
      .replaceAll(pathToFileURL(dir).href, "<workspace>")
      .replaceAll(dir, "<workspace>");
  }
  return scrubbed;
}

/** Newer Node spells it `--test-isolation`; older 22.x only has the experimental name. */
const ISOLATION_FLAG = process.allowedNodeEnvironmentFlags.has("--test-isolation")
  ? "--test-isolation=none"
  : "--experimental-test-isolation=none";

function run(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd,
        // Nothing inherited: no API keys, tokens, or NODE_OPTIONS.
        env: { PATH: process.env["PATH"] ?? "" },
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        encoding: "utf-8",
      },
      (error, stdout) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout: String(stdout), exitCode: code, timedOut: Boolean(error?.killed) });
      },
    );
  });
}

/**
 * The real runner: a temp dir holding the patch and one test file, then
 * `node --test` in one process (no test-file subprocess, so child processes
 * stay denied) under `--permission` scoped to that dir.
 */
export function createNodeTestRunner(options: { timeoutMs?: number } = {}): TestRunner {
  const { timeoutMs = 20_000 } = options;
  return async (task, code, suite) => {
    const tmp = await mkdtemp(path.join(tmpdir(), `code-review-loop-${task.id}-`));
    const dir = await realpath(tmp);
    try {
      await writeFile(path.join(dir, task.file), code);
      const testFile = `${suite}-tests.mjs`;
      await copyFile(fixturePath(task.id, testFile), path.join(dir, testFile));
      const { stdout, exitCode, timedOut } = await run(
        [
          "--permission",
          `--allow-fs-read=${dir}`,
          `--allow-fs-write=${dir}`,
          ISOLATION_FLAG,
          "--test",
          "--test-reporter=tap",
          testFile,
        ],
        dir,
        timeoutMs,
      );
      if (timedOut) {
        return {
          passed: false,
          failingTests: [],
          output: `the test run timed out after ${timeoutMs / 1000}s and was killed`,
        };
      }
      return parseTap(scrubWorkspace(stdout, [tmp, dir]), exitCode);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export const nodeTestRunner: TestRunner = createNodeTestRunner();
