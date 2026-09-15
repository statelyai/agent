/**
 * The contract for an example that tells its story across SEVERAL runs.
 *
 * Most examples are one machine: a host starts it, watches it, and reads its
 * output. A few are not — a crash and its recovery, a run paused on one
 * machine and resumed on the next version of it, a snapshot written to disk in
 * one process and picked up in another. The interesting part of those happens
 * BETWEEN runs, so there is no single machine a host can drive.
 *
 * Such an example exports one function taking these options and threads them
 * into every `runAgent` call it makes. A host then observes the whole story
 * the same way it observes a single run, and `metadata.json` names the export
 * under `runners` so a library can offer it.
 */
import type { AnyStateMachine } from "xstate";
import type { RunAgentOptions } from "@statelyai/agent";

/** The observer and cancellation seams a host threads through every leg. */
export type ExampleRunOptions = Pick<
  RunAgentOptions<AnyStateMachine>,
  "executors" | "signal" | "onTransition" | "on" | "onTrace" | "inspect"
>;
