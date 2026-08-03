/**
 * Host wiring shared by both route handlers: the executors a run uses, and
 * (env-gated) live inspection.
 *
 * Executors are key-gated by `resolveExecutors()`: a real model when
 * `OPENAI_API_KEY` is set, and otherwise `createScriptedExecutors` replaying
 * canned answers, so `pnpm dev` boots and the whole approve/reject flow works
 * with no API key and no network.
 *
 * A fresh script per request is deliberate: the queues are consumed FIFO, so a
 * module-level singleton would run dry on the second run.
 */
import { openai } from "@ai-sdk/openai";
import { createScriptedExecutors, type AgentRequestExecutors } from "@statelyai/agent";
import type { AgentTextRequest } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import type { Inspector } from "@statelyai/sdk/inspect";

/** The machine's `writeDraft` request asks for model `"writer"`; map it here. */
export const models = defineModels({
  writer: openai("gpt-5.4-mini"),
});

/** The scripted stand-in for the `writeDraft` request. */
const writeDraft = (request: AgentTextRequest): string => {
  const topic = (request.prompt ?? "").replace(/^Write a short announcement about:\s*/, "");
  return `Big news: ${topic.split("\n")[0]} just shipped.`;
};

/**
 * Keyless executors for one request. Four entries so a REJECT (which sends the
 * machine back to `drafting`) still has an answer waiting.
 */
export function createExecutors(): Partial<AgentRequestExecutors> {
  return createScriptedExecutors({ text: [writeDraft, writeDraft, writeDraft, writeDraft] });
}

/** Real models when `OPENAI_API_KEY` is set, scripted playback otherwise. */
export function resolveExecutors(): Partial<AgentRequestExecutors> {
  return process.env.OPENAI_API_KEY ? createAiSdkExecutors({ models }) : createExecutors();
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
