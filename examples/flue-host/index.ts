/**
 * Flue 2 host (https://flueframework.com), two ways:
 *
 *   - ./machine-owned.ts — the email-draft machine owns the workflow (model
 *     calls, branches, pauses, legality); the Flue agent is a conversational
 *     shell with two bridge tools.
 *   - ./flue-owned.ts — Flue's hooks own the workflow (per-step model, skills,
 *     tools, persistent state); the machine is only the step graph, replacing
 *     the docs' `usePersistentState('step', ...)` string.
 *
 * Real `@flue/runtime@2` — no shims. Both demos boot the actual runtime with
 * `start()` from `@flue/runtime/node` and drive an agent through
 * `init()` / `dispatch()` / `read()`.
 *
 * Run: npx tsx examples/flue-host/index.ts
 *   No API key -> pi's faux provider plays the model, so both demos run
 *     offline against the real runtime.
 *   OPENAI_API_KEY + ANTHROPIC_API_KEY -> real models drive the same agents.
 *
 * Flue holds one runtime per process, so the demos run in sequence, each
 * starting and stopping its own.
 */
export {
  MachineOwnedAgent,
  completed,
  main,
  mockRunOptions,
  resumeDraft,
  resumeWorkflow,
  startDraft,
  startWorkflow,
  useLiveExecutors,
  type ToolResult,
} from "./machine-owned.js";
export {
  FlueOwnedAgent,
  main as flueOwnedMain,
  outbox,
  scriptedModel as flueOwnedScriptedModel,
  steps,
} from "./flue-owned.js";

import { main as machineOwnedMain } from "./machine-owned.js";
import { main as flueOwnedMain } from "./flue-owned.js";

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  // The flue-owned agent reviews with an Anthropic model, so live mode needs
  // both keys; with either missing, both demos run on the faux provider.
  const live = Boolean(process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY);
  (async () => {
    console.log(`=== Way 1: machine-owned (${live ? "live" : "keyless"}) ===`);
    await machineOwnedMain({ live });
    console.log(`\n=== Way 2: flue-owned (${live ? "live" : "keyless"}) ===`);
    await flueOwnedMain({ live });
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
