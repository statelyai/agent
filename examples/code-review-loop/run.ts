/**
 * The code-review loop on Claude Code: every author, self-check, reviewer,
 * and classifier call is a headless `claude -p` process (see claude-code.ts).
 *
 *   pnpm exec tsx examples/code-review-loop/run.ts --task clamp
 *   pnpm exec tsx examples/code-review-loop/run.ts --split train --policy v1
 *   pnpm exec tsx examples/code-review-loop/run.ts --improve
 *
 * Options:
 *   --task <id>                   one task (default: every task in --split)
 *   --split train|held-out|all    default all
 *   --policy v0|v1|current        default current (policies/current.json, else v0)
 *   --model <alias>               Claude Code model for every call (default: the CLI's)
 *   --reviewer-model <alias>      a different model for the reviewer only (default: --model)
 *   --no-human                    leave escalated tasks waiting instead of asking on stdin
 *   --improve                     one improvement round from --policy over train + held-out;
 *                                 a promoted policy is written to policies/current.json
 *
 * Traces go to `.traces/<timestamp>/`, one JSONL file per thread
 * (`<split>/<policyVersion>/<taskId>`). The scorecard reads ground truth:
 * the terminal state, and the hidden tests run on whatever shipped.
 */
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AgentWorkflowConfig } from "@statelyai/agent";
import { runEpisode, summarize, type Episode } from "./bench.js";
import { nodeTestRunner } from "./checks.js";
import { createClaudeCodeExecutors, type ClaudeCodeCall } from "./claude-code.js";
import { createFileEventLogStore } from "./file-store.js";
import { improvePolicy, metricsLine } from "./improve.js";
import { createPolicyDecide, loadPolicy, withPolicy } from "./policy.js";
import { ALL_TASKS, HELD_OUT_TASKS, TRAIN_TASKS, getTask, type Task } from "./tasks.js";
import { createTerminalReviewer } from "./terminal-reviewer.js";

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const CURRENT_POLICY = here("./policies/current.json");

function resolvePolicy(name: string): AgentWorkflowConfig {
  if (name === "current") {
    if (existsSync(CURRENT_POLICY)) return loadPolicy("current");
    console.log("No policies/current.json yet (run --improve to promote one); using v0.");
    return loadPolicy("v0");
  }
  return loadPolicy(name);
}

/**
 * Claude Code models per machine ref. `--reviewer-model` puts the reviewer
 * (model ref "reviewer") on its own model; everything else uses `--model`.
 */
export function modelOptions(values: { model?: string; "reviewer-model"?: string }): {
  defaultModel?: string;
  models?: Record<string, string>;
} {
  return {
    ...(values.model ? { defaultModel: values.model } : {}),
    ...(values["reviewer-model"] ? { models: { reviewer: values["reviewer-model"] } } : {}),
  };
}

function printScorecard(episodes: Episode[], calls: ClaudeCodeCall[], startedAt: number) {
  const rows = episodes.map((e) => {
    const task = getTask(e.taskId);
    return [
      e.taskId,
      task.split,
      e.label,
      e.outcome,
      String(e.rounds),
      e.hiddenPassed === null ? "-" : e.hiddenPassed ? "pass" : "FAIL",
      e.score.toFixed(2),
      e.finalState,
    ];
  });
  const header = ["task", "split", "label", "outcome", "rounds", "hidden", "score", "ended in"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  console.log(`\n${line(header)}\n${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const row of rows) console.log(line(row));
  for (const split of ["train", "held-out"] as const) {
    const subset = episodes.filter((e) => getTask(e.taskId).split === split);
    if (subset.length) console.log(`${split.padEnd(8)}  ${metricsLine(summarize(split, subset))}`);
  }
  const cost = calls.reduce((n, c) => n + (c.costUsd ?? 0), 0);
  console.log(
    `${calls.length} Claude Code calls, $${cost.toFixed(4)}, wall time ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      split: { type: "string", default: "all" },
      policy: { type: "string", default: "current" },
      model: { type: "string" },
      "reviewer-model": { type: "string" },
      "no-human": { type: "boolean", default: false },
      improve: { type: "boolean", default: false },
    },
  });
  const startedAt = Date.now();
  const tracesDir = here(`./.traces/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const store = createFileEventLogStore(tracesDir);
  const calls: ClaudeCodeCall[] = [];
  const cli = createClaudeCodeExecutors({
    ...modelOptions(values),
    onCall: (call) => {
      calls.push(call);
      console.log(
        `  claude ${call.name}: ${(call.durationMs / 1000).toFixed(1)}s` +
          (call.costUsd !== undefined ? `, $${call.costUsd.toFixed(4)}` : ""),
      );
    },
  });
  const policy = resolvePolicy(values.policy);
  console.log(`Policy ${policy.id ?? values.policy}; traces in ${tracesDir}`);

  if (values.improve) {
    const result = await improvePolicy({
      current: policy,
      executors: cli,
      policyDecide: cli.decide,
      classify: cli.classify,
      runner: nodeTestRunner,
      store,
      log: (line) => console.log(line),
    });
    if (result.promoted) {
      writeFileSync(CURRENT_POLICY, `${JSON.stringify(result.config, null, 2)}\n`);
      console.log(`Promoted ${result.config.id ?? "the candidate"} to policies/current.json.`);
    } else {
      console.log(`Kept ${policy.id ?? "the current policy"}.`);
    }
    printScorecard(
      [...result.before.all.episodes, ...(result.after?.all.episodes ?? [])],
      calls,
      startedAt,
    );
    return;
  }

  const tasks: Task[] = values.task
    ? [getTask(values.task)]
    : values.split === "train"
      ? TRAIN_TASKS
      : values.split === "held-out"
        ? HELD_OUT_TASKS
        : ALL_TASKS;
  const human = !values["no-human"] && process.stdin.isTTY ? createTerminalReviewer() : undefined;
  const decide = createPolicyDecide(policy, {
    classify: cli.classify,
    executors: { decide: cli.decide },
  });
  const episodes: Episode[] = [];
  try {
    for (const task of tasks) {
      console.log(`\n${task.id} (${task.split}, ${task.label})`);
      episodes.push(
        await runEpisode(task, {
          executors: withPolicy(cli, decide),
          runner: nodeTestRunner,
          store,
          policyVersion: policy.id ?? values.policy,
          ...(human ? { human } : {}),
        }),
      );
      for (const line of episodes.at(-1)!.trail) console.log(`  ${line}`);
    }
  } finally {
    human?.close();
  }
  printScorecard(episodes, calls, startedAt);
}

// Run directly (`tsx run.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
