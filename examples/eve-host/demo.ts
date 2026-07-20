/**
 * Runnable demo of the Eve tool bridge WITHOUT a live Eve runtime. Eve would
 * call `start_workflow` / `resume_workflow` from its tool-calling loop; here we
 * call the same tool `execute` functions directly to prove the round-trip.
 *
 * Run: npx tsx examples/eve-host/demo.ts   (no API key — uses the mock executor)
 */
import assert from "node:assert/strict";
import startWorkflow from "./tools/start_workflow.js";
import resumeWorkflow from "./tools/resume_workflow.js";

// A fake `ctx` — the demo doesn't touch session/sandbox/skills.
const ctx = {
  session: { id: "demo" },
  callId: "demo",
  toolName: "demo",
  abortSignal: new AbortController().signal,
  getSandbox: () => ({}),
  getSkill: () => ({}),
};

export async function main() {
  const started = await startWorkflow.execute({ amount: 420, orderId: "ord-1" }, ctx);
  assert.equal(started.status, "pending");
  if (started.status !== "pending") return;

  console.log(`\n${started.interaction?.label}`);
  for (const choice of started.interaction?.choices ?? []) {
    console.log(`  - ${choice.label} (${choice.eventType})`);
  }
  console.log("\n[user approves]\n");

  const finished = await resumeWorkflow.execute(
    { handle: started.handle, event: { type: "APPROVE" } },
    ctx,
  );
  console.log("Result:", finished);
  assert.equal(finished.status, "done");
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
