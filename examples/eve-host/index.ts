/**
 * Runnable demo of the Eve tool bridge WITHOUT a live Eve runtime. Eve would
 * call `start_workflow` / `resume_workflow` from its tool-calling loop; here we
 * call the same tool `execute` functions directly to prove the round-trip
 * against the email-draft machine from ../email-drafter.
 *
 * No API key is needed: the mock executors in ./bridge.ts stand in for the two
 * model calls the machine makes. Set OPENAI_API_KEY to run the same flow
 * against real generations through the email-drafter's declared models.
 *
 * The demo driver has no model of its own, so it cannot improvise like Eve's
 * agent would. Instead it reacts to whatever interaction the machine publishes
 * at each pause and picks an event the machine actually accepts. That keeps it
 * correct on both paths a real model takes (the evaluator may or may not ask
 * for more details) instead of replaying a fixed happy-path script.
 *
 * Run: npx tsx examples/eve-host/index.ts
 */
import assert from "node:assert/strict";
import type { Interaction } from "../email-drafter/agent-logic.js";
import { useLiveExecutors, type ToolResult } from "./bridge.js";
import startWorkflow from "./tools/start_workflow.js";
import resumeWorkflow from "./tools/resume_workflow.js";

// A fake `ctx`: the demo doesn't touch session/sandbox/skills.
const ctx = {
  session: { id: "demo" },
  callId: "demo",
  toolName: "demo",
  abortSignal: new AbortController().signal,
  getSandbox: () => ({}),
  getSkill: () => ({}),
};

/** Every eventType this pause accepts, straight off the published interaction. */
function acceptedEventTypes(interaction: Interaction | null): string[] {
  if (!interaction) return [];
  switch (interaction.type) {
    case "text":
      return [interaction.eventType];
    case "select":
      return interaction.choices.map((choice) => choice.eventType);
    case "confirm":
      return [interaction.trueEventType, interaction.falseEventType];
  }
}

/**
 * The unattended stand-in for a human. Each entry is an event that needs no
 * text, so the demo can answer any pause the machine reaches:
 *
 *   - DRAFT_ANYWAY: the needs-details pause. A real host would collect the
 *     missing details from the user and send MORE_INFO with them instead.
 *   - SEND: the review pause.
 *   - END: the "send another?" pause.
 */
const DEMO_EVENT_PREFERENCE = ["SEND", "DRAFT_ANYWAY", "END"];

function chooseEventType(accepted: string[]): string {
  const chosen = DEMO_EVENT_PREFERENCE.find((eventType) => accepted.includes(eventType));
  if (!chosen) throw new Error(`No demo answer for pause accepting: ${accepted.join(", ")}`);
  return chosen;
}

/** Safety cap so a misbehaving model can never spin this demo forever. */
const MAX_STEPS = 8;

export async function main() {
  let result: ToolResult = await startWorkflow.execute(
    { prompt: "Tell the team the deploy pipeline is twice as fast now." },
    ctx,
  );
  let shownDraft: string | null = null;

  for (let step = 0; step < MAX_STEPS && result.status === "pending"; step++) {
    const draft = result.draft
      ? `To: ${result.draft.to}\nSubject: ${result.draft.subject}\n\n${result.draft.body}`
      : null;
    if (draft && draft !== shownDraft) {
      shownDraft = draft;
      console.log(`\n--- Draft ---\n${draft}\n-------------`);
    }

    const accepted = acceptedEventTypes(result.interaction);
    console.log(`\n${result.interaction?.label ?? "(paused)"}`);
    for (const eventType of accepted) console.log(`  - ${eventType}`);

    const eventType = chooseEventType(accepted);
    console.log(`\n[user picks ${eventType}]\n`);
    result = await resumeWorkflow.execute({ handle: result.handle, eventType, text: null }, ctx);
  }

  assert.equal(result.status, "done");
  // The machine's `failed` state is also final, so "done" alone doesn't mean the
  // run succeeded — it can finish with nothing sent. Assert on the output.
  assert.ok(
    result.status === "done" && result.sentEmails.length >= 1,
    "run finished without sending an email (the machine reached `failed`)",
  );
  console.log("Result:", result);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  // The live path swaps the mocks for real generations; the tools are unchanged.
  if (process.env.OPENAI_API_KEY) useLiveExecutors();
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
