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
 * Run: OPENAI_API_KEY=... ANTHROPIC_API_KEY=... npx tsx examples/flue-host/index.ts
 *   Real models drive both agents; the flue-owned agent reviews with an
 *   Anthropic model, so both keys are required.
 *
 * Flue holds one runtime per process, so the demos run in sequence, each
 * starting and stopping its own.
 */
export {
  MachineOwnedAgent,
  completed,
  main,
  resumeDraft,
  resumeWorkflow,
  startDraft,
  startWorkflow,
  useToolExecutors,
  type ToolResult,
} from "./machine-owned.js";
export { FlueOwnedAgent, main as flueOwnedMain, outbox, steps } from "./flue-owned.js";

import { main as machineOwnedMain } from "./machine-owned.js";
import { main as flueOwnedMain } from "./flue-owned.js";

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  (async () => {
    // The flue-owned agent reviews with an Anthropic model, so both keys are
    // checked before either demo starts.
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      if (!process.env[key]) throw new Error(`Set ${key} to run this example.`);
    }
    console.log("=== Way 1: machine-owned ===");
    await machineOwnedMain();
    console.log("\n=== Way 2: flue-owned ===");
    await flueOwnedMain();
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
