/**
 * The Claude Code host over a fake `spawn`: canned `--output-format json`
 * envelopes, no CLI, no network.
 */
import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import { runEpisode } from "./bench.js";
import { createClaudeCodeExecutors, parseEnvelope, type Spawn } from "./claude-code.js";
import { codeReviewLoopMachine, createRunChecks } from "./environment.js";
import { createPolicyDecide, loadPolicy, withPolicy } from "./policy.js";
import { getTask } from "./tasks.js";
import { fakeRunner, reference } from "./test-doubles.js";

const envelope = (fields: Record<string, unknown>) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    ...fields,
  });

type Call = { command: string; args: string[]; stdin: string; cwd: string };

/** A fake CLI: answers by the flags it was called with. */
function fakeCli(answer: (call: Call) => string): { spawn: Spawn; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    spawn: async (command, args, { stdin, cwd }) => {
      const call = { command, args, stdin, cwd };
      calls.push(call);
      return { stdout: `${answer(call)}\n`, stderr: "", exitCode: 0 };
    },
  };
}

const flag = (args: string[], name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

describe("Claude Code executors", () => {
  test("parses a canned envelope: text, structured output, and an error", () => {
    expect(parseEnvelope(envelope({ result: "hi" })).result).toBe("hi");
    expect(() => parseEnvelope(envelope({ is_error: true, subtype: "error_max_turns" }))).toThrow(
      /error_max_turns/,
    );
    expect(() => parseEnvelope("", "Not logged in")).toThrow(/Not logged in/);
  });

  test("a whole task runs through the CLI: author text, structured self-check and review", async () => {
    const code = reference("clamp")!;
    const { spawn, calls } = fakeCli(({ args, stdin }) => {
      const schema = flag(args, "--json-schema");
      if (!schema) return envelope({ result: `\`\`\`js\n${code}\`\`\`` });
      if (schema.includes("approved")) {
        return envelope({ result: "", structured_output: { approved: true, issues: [] } });
      }
      expect(stdin).toContain("## Your patch (clamp.mjs)");
      // Structured answers may also come back as JSON text.
      return envelope({ result: '{"ok": true, "concerns": []}' });
    });
    const usage: number[] = [];
    const cli = createClaudeCodeExecutors({
      spawn,
      models: { author: "sonnet", reviewer: "opus" },
      onCall: (call) => usage.push(call.inputTokens ?? 0),
    });
    const episode = await runEpisode(getTask("clamp"), {
      executors: withPolicy(cli, createPolicyDecide(loadPolicy("v1"), { classify: cli.classify })),
      runner: fakeRunner,
      policyVersion: "v1",
    });
    expect(episode).toMatchObject({ outcome: "shipped", rounds: 1, hiddenPassed: true });
    expect(calls).toHaveLength(3);
    expect(usage).toEqual([110, 110, 110]);

    for (const call of calls) {
      expect(call.command).toBe("claude");
      expect(call.args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
      expect(flag(call.args, "--tools")).toBe("");
      expect(call.args).toContain("--no-session-persistence");
      expect(call.args).toContain("--safe-mode");
      expect(flag(call.args, "--system-prompt")).toBeTruthy();
    }
    const [author, ...structured] = calls;
    expect(flag(author!.args, "--model")).toBe("sonnet");
    expect(author!.args).not.toContain("--json-schema");
    expect(author!.stdin).toContain("## Spec\nImplement `clamp(value, min, max)`");
    expect(structured.map((c) => flag(c.args, "--model")).sort()).toEqual(["opus", "sonnet"]);
  });

  test("a structured answer that misses its schema fails the request", async () => {
    const { spawn } = fakeCli(({ args }) =>
      flag(args, "--json-schema")
        ? envelope({ structured_output: { approved: "yes" } })
        : envelope({ result: reference("clamp") }),
    );
    const cli = createClaudeCodeExecutors({ spawn });
    const result = await runAgent(codeReviewLoopMachine, {
      executors: withPolicy(cli, async () => ({
        event: { type: "ESCALATE", reason: "repeated failures" },
      })),
      actors: { runChecks: createRunChecks(fakeRunner) },
      input: { taskId: "clamp" },
    });
    // The review failed to parse, so it counts as no approval and goes to a person.
    expect(result.status).toBe("idle");
    expect(result.snapshot.context.review?.issues[0]?.note).toBe("the review failed to run");
  });

  test("decide answers a closed choice with an option id", async () => {
    const { spawn, calls } = fakeCli(() => envelope({ structured_output: { option: "option-2" } }));
    const { decide } = createClaudeCodeExecutors({ spawn });
    const { event } = await decide({
      kind: "decision",
      id: "d",
      name: "pick",
      model: "policy",
      prompt: "Pick one.",
      events: [{ type: "RETRY", toolName: "RETRY" }],
      options: [
        { event: { type: "ESCALATE", reason: "repeated failures" } },
        { event: { type: "RETRY", feedback: "f", focus: "all" } },
      ],
      attempts: [],
    });
    expect(event).toEqual({ type: "RETRY", feedback: "f", focus: "all" });
    expect(calls[0]!.stdin).toContain('option-2: {"type":"RETRY","feedback":"f","focus":"all"}');
    expect(JSON.parse(flag(calls[0]!.args, "--json-schema")!).properties.option.enum).toEqual([
      "option-1",
      "option-2",
    ]);
  });
});
