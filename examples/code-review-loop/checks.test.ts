/**
 * The real `node --test` runner as a boundary for untrusted patches: stable
 * output (no machine paths), a scrubbed env, and Node's permission model.
 */
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createNodeTestRunner, nodeTestRunner, scrubWorkspace } from "./checks.js";
import { getTask } from "./tasks.js";
import { reference } from "./test-doubles.js";

const clamp = getTask("clamp");
const withReference = (prelude: string) => `${prelude}\n${reference("clamp")!}`;

describe("the node --test runner", () => {
  afterEach(() => {
    delete process.env["SECRET"];
    delete process.env["SOME_API_KEY"];
  });

  test("check output names <workspace>, never the machine's temp dir", async () => {
    const result = await nodeTestRunner(clamp, "Mock reply to: the spec", "visible");
    expect(result.passed).toBe(false);
    expect(result.output).toContain("SyntaxError");
    for (const dir of [tmpdir(), realpathSync(tmpdir())]) {
      expect(result.output).not.toContain(dir);
    }
  });

  test("scrubWorkspace replaces the dir, its realpath, and their file:// URLs", () => {
    const dirs = ["/var/folders/x/T/ws-1", "/private/var/folders/x/T/ws-1"];
    const text = [
      "file:///private/var/folders/x/T/ws-1/clamp.mjs:1",
      "/private/var/folders/x/T/ws-1/visible-tests.mjs:2:3",
      "file:///var/folders/x/T/ws-1/clamp.mjs:4",
      "at /var/folders/x/T/ws-1/clamp.mjs:5",
    ].join("\n");
    expect(scrubWorkspace(text, dirs)).toBe(
      [
        "<workspace>/clamp.mjs:1",
        "<workspace>/visible-tests.mjs:2:3",
        "<workspace>/clamp.mjs:4",
        "at <workspace>/clamp.mjs:5",
      ].join("\n"),
    );
  });

  test("a patch sees no inherited env: no secrets, no API keys", async () => {
    process.env["SECRET"] = "hunter2";
    process.env["SOME_API_KEY"] = "sk-test";
    const probe = withReference(
      'if (process.env.SECRET !== undefined) throw new Error("saw SECRET");\n' +
        'if (Object.keys(process.env).some((k) => k.endsWith("_API_KEY"))) throw new Error("saw an API key");',
    );
    const result = await nodeTestRunner(clamp, probe, "visible");
    expect(result).toMatchObject({ passed: true, failingTests: [] });
  });

  test("a patch that writes outside the workspace fails, and nothing is written", async () => {
    const outside = path.join(realpathSync(tmpdir()), `code-review-loop-escape-${process.pid}.txt`);
    const probe = withReference(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(outside)}, "escaped");`,
    );
    try {
      const result = await nodeTestRunner(clamp, probe, "visible");
      expect(result.passed).toBe(false);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("a patch that spawns a child process fails", async () => {
    const probe = withReference(
      'import { execFileSync } from "node:child_process";\nexecFileSync(process.execPath, ["-e", "0"]);',
    );
    const result = await nodeTestRunner(clamp, probe, "visible");
    expect(result.passed).toBe(false);
  });

  test("a patch that starts a worker fails", async () => {
    const probe = withReference(
      'import { Worker } from "node:worker_threads";\nnew Worker("0", { eval: true });',
    );
    const result = await nodeTestRunner(clamp, probe, "visible");
    expect(result.passed).toBe(false);
  });

  test("a patch that exits early with code 0 does not pass", async () => {
    const result = await nodeTestRunner(clamp, withReference("process.exit(0);"), "visible");
    expect(result.passed).toBe(false);
  });

  test("a patch that ignores SIGTERM and hangs is killed at the timeout", async () => {
    const runner = createNodeTestRunner({ timeoutMs: 1_000 });
    const hang = withReference('process.on("SIGTERM", () => {});\nwhile (true) {}');
    const started = Date.now();
    const result = await runner(clamp, hang, "visible");
    expect(result.passed).toBe(false);
    expect(result.output).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
