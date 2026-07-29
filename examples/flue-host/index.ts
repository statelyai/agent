/**
 * Flue host — a durable-agent framework (https://flueframework.com/) whose LLM
 * agent drives a @statelyai/agent state machine through two tools.
 *
 * Flue's `defineAgent` returns a runtime config with `tools:` as an array of
 * `defineTool` definitions (Valibot `input`/`output` schemas, `run({ input,
 * signal })`). The two tools here bridge to the refund machine in ./machine.ts:
 *
 *   - `start_workflow` runs `runAgent(machine, { input })` to its first idle
 *     (or done) and returns a JSON-safe { handle, status, interaction }.
 *   - `resume_workflow` revives the handle with the human's event via
 *     `runAgent({ snapshot, event })`.
 *
 * The machine owns legality/state; the Flue agent converses. Illegal resumes
 * are refused by `runAgent` itself (AgentIllegalResumeEventError), so no hand-rolled
 * legality checks live in the tools.
 *
 * NOT a full Flue project — @flue/runtime is not a repo dependency, so
 * `defineAgent`/`defineTool`/`v` come from ./flue-shims.ts (delete in a real
 * app; shims mirror flueframework.com/docs as of 2026-07).
 *
 * Run: npx tsx examples/flue-host/index.ts   (no API key — mock executor)
 */
import assert from "node:assert/strict";
import { defineAgent, defineTool, local, v } from "./flue-shims.js";
import { startRefund, resumeRefund, type ToolResult } from "./machine.js";

// Shared result schema: what the model sees back from either tool. Flue
// JSON-stringifies structured output for the model, so keep it flat and safe.
const resultSchema = v.object({
  status: v.string(),
  handle: v.nullable(v.string()),
  label: v.nullable(v.string()),
  refunded: v.nullable(v.boolean()),
  reason: v.nullable(v.string()),
});

/** Project a ToolResult into the flat shape declared by `resultSchema`. */
function toModelResult(result: ToolResult) {
  return result.status === "pending"
    ? {
        status: "pending" as const,
        handle: result.handle,
        label: result.interaction?.label ?? null,
        refunded: null,
        reason: null,
      }
    : {
        status: "done" as const,
        handle: null,
        label: null,
        refunded: result.refunded,
        reason: result.reason,
      };
}

/** Tool #1: begin the refund machine, run to first pause, return a handle. */
export const startWorkflow = defineTool({
  name: "start_workflow",
  description:
    "Start a refund workflow for an order. Returns status 'pending' with a handle " +
    "and a label describing the approval to present, or 'done' with the outcome.",
  input: v.object({
    amount: v.pipe(v.number(), v.description("Refund amount in USD")),
    orderId: v.pipe(v.string(), v.description("Order ID in the form ord-1234")),
  }),
  output: resultSchema,
  async run({ input }) {
    return toModelResult(await startRefund(input));
  },
});

/** Tool #2: revive the handle, deliver the human's decision, run to done. */
export const resumeWorkflow = defineTool({
  name: "resume_workflow",
  description:
    "Resume a paused refund workflow. Pass the handle from start_workflow, the " +
    "decision ('APPROVE' or 'REJECT'), and a reason when rejecting.",
  input: v.object({
    handle: v.pipe(v.string(), v.description("Opaque handle from start_workflow")),
    decision: v.pipe(v.string(), v.description("'APPROVE' or 'REJECT'")),
    reason: v.nullable(v.string()),
  }),
  output: resultSchema,
  async run({ input }) {
    const event =
      input.decision === "REJECT"
        ? ({ type: "REJECT", reason: input.reason ?? "No reason given" } as const)
        : ({ type: "APPROVE" } as const);
    return toModelResult(await resumeRefund(input.handle, event));
  },
});

/**
 * The Flue agent: model + instructions + the two bridge tools. In a real app
 * this is the module Flue deploys (`npx flue run refund-host --input ...`).
 */
export default defineAgent(() => ({
  model: "openai/gpt-5.4-mini",
  instructions:
    "You handle refund requests, but you never decide refunds yourself — a " +
    "state machine owns the policy. Call start_workflow with the order's amount " +
    "and orderId. If the result is pending, present its label to the user and, " +
    "once they decide, call resume_workflow with the same handle and their " +
    "decision. Relay the final outcome (refunded / reason) in plain language.",
  tools: [startWorkflow, resumeWorkflow],
  sandbox: local(),
}));

// ─── Demo: exercise the tool bridge without a live Flue runtime ───
// Flue would call these `run` functions from its tool loop; calling them
// directly proves the start → present → resume round-trip.
export async function main() {
  const started = await startWorkflow.run({ input: { amount: 420, orderId: "ord-1" } });
  assert.equal(started.status, "pending");
  console.log(`\n${started.label}`);
  console.log("\n[user approves]\n");

  const finished = await resumeWorkflow.run({
    input: { handle: started.handle!, decision: "APPROVE", reason: null },
  });
  console.log("Result:", finished);
  assert.equal(finished.status, "done");
  assert.equal(finished.refunded, true);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
