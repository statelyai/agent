/**
 * Preset machines: `createParallelMachine` from `@statelyai/agent/machines`.
 * Two review branches run concurrently as regions of one parallel state and
 * join when both finish, keyed by branch name. The factory returns an ordinary
 * XState machine — same states, snapshots, and lint as a hand-written one.
 *
 * Keyless: the executor here is scripted, so this runs with no API key and no
 * network. Swap it for `createAiSdkExecutors({ models })` to run for real.
 *
 * Run: npx tsx examples/preset-machine/index.ts
 */
import { runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { createParallelMachine } from "@statelyai/agent/machines";

// Why a preset over a hand-written machine: this one call replaces ~40 lines
// of parallel-state boilerplate (regions, per-branch requests, a keyed join)
// with the two things that actually vary — branch names and instructions. The
// factory bakes in consistent event naming and `version: "1"`, and the result
// is still an ordinary XState machine: lint it, simulate it, visualize it, or
// eject by pasting the equivalent states and editing from there.
export const codeReviewMachine = createParallelMachine({
  model: "quick",
  branches: {
    security: {
      description: "Injection, authz, and secret-handling risks",
      instructions: "Review the diff for security issues. One sentence.",
    },
    performance: {
      description: "Allocation, N+1, and hot-path cost",
      instructions: "Review the diff for performance issues. One sentence.",
    },
  },
});

// Sample data — a stand-in for a diff pulled from a pull request.
const SAMPLE_DIFF = [
  "+ const user = db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);",
  "+ for (const post of user.posts) { post.author = db.query(...); }",
].join("\n");

/** Scripted stand-in for a model: one canned line per branch, routed on `request.name`. */
export const scriptedReviewer: AgentRequestExecutor = async (request) => ({
  output:
    request.name === "security"
      ? "The id is interpolated straight into SQL: parameterize the query."
      : "The per-post author lookup is an N+1: batch it into one query.",
});

export async function main() {
  const result = await runAgent(codeReviewMachine, {
    input: { prompt: SAMPLE_DIFF },
    executors: { generateText: scriptedReviewer },
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Review did not complete: ${result.status}`);
  }
  console.log(JSON.stringify(result.output, null, 2));
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
