/**
 * Host wiring shared by both route handlers: the executors a run uses, and
 * (env-gated) live inspection.
 *
 * Executors are the real model: set `OPENAI_API_KEY` before `pnpm dev`.
 * Without it, `resolveExecutors()` throws naming the missing variable, so a
 * run fails loudly instead of answering with something that is not a model.
 */
import { openai } from "@ai-sdk/openai";
import { type AgentRequestExecutors } from "@statelyai/agent";
import { type AiSdkModelMap, createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import type { Inspector } from "@statelyai/sdk/inspect";

/** The machine's `writeDraft` request asks for model `"writer"`; map it here. */
export const models: AiSdkModelMap<"writer"> = {
  writer: openai("gpt-5.4-mini"),
};

/** The real model executors; throws when `OPENAI_API_KEY` is not set. */
export function resolveExecutors(): Partial<AgentRequestExecutors> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to run the next-host example.");
  }
  return createAiSdkExecutors({ models });
}

// ─── Live inspection (opt-in) ───

// This example uses a local relay by default. The SDK adds the room capability
// as `?r=...`; set STATELY_INSPECT_URL to use another relay.
const DEFAULT_INSPECT_URL = "ws://localhost:4242";
const DEFAULT_INSPECT_ROOM = "next-host";

let inspector: Inspector | undefined;

/**
 * An xstate `inspect` callback streaming the run to a Stately inspection relay,
 * or `undefined` unless `STATELY_INSPECT=1`.
 *
 * One inspector PER RUN. xstate sessionIds are only unique within one actor
 * system, so reusing an inspector across sequential runs collides actor ids and
 * the new machine never registers; a fresh one reconnects and sends a fresh
 * `system.init`. The previous inspector is destroyed.
 */
export async function maybeCreateRunInspection(): Promise<((event: unknown) => void) | undefined> {
  if (process.env.STATELY_INSPECT !== "1") return undefined;
  const { createInspector } = await import("@statelyai/sdk/inspect");
  inspector?.destroy();
  inspector = createInspector({
    url: process.env.STATELY_INSPECT_URL ?? DEFAULT_INSPECT_URL,
    roomId:
      process.env.STATELY_INSPECT_ROOM ??
      process.env.STATELY_INSPECT_SESSION ??
      DEFAULT_INSPECT_ROOM,
    producerId: "next-host-runner",
    autoOpen: false,
    name: "Next.js host",
  });
  return inspector.inspect as (event: unknown) => void;
}
