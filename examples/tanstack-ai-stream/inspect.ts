/**
 * Live inspection for a run, opt-in via `STATELY_INSPECT=1`. `inspector.inspect`
 * from `@statelyai/sdk` IS an xstate inspect-option callback, so it plugs
 * straight into `runAgent({ inspect })` and the machine streams to a relay
 * (default `ws://localhost:4242`) while it answers the chat turn.
 *
 * One inspector PER RUN: xstate sessionIds are only unique within one actor
 * system, so reusing an inspector across turns collides actor ids and the new
 * run never registers. The previous inspector is destroyed; the roomId stays
 * fixed so the visualizer URL never changes.
 */
import type { Inspector } from "@statelyai/sdk/inspect";

// This example uses a local relay by default. The SDK adds the room capability
// as `?r=...`; set STATELY_INSPECT_URL to use another relay.
const DEFAULT_INSPECT_URL = "ws://localhost:4242";
const DEFAULT_INSPECT_ROOM = "tanstack-ai-stream";

let inspector: Inspector | undefined;

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
    producerId: "tanstack-ai-stream-runner",
    autoOpen: false,
    name: "TanStack AI stream",
  });
  return inspector.inspect as (event: unknown) => void;
}
