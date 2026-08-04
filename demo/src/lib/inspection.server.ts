/**
 * Live inspection (server): real-time statechart inspection over a local
 * WebSocket relay, replacing the post-hoc trace replay.
 *
 * Both pieces come from `@statelyai/sdk`:
 * - `createInspectionRelay` — the transport-agnostic relay core, hosted here
 *   over a `ws` WebSocketServer (same shape as the viz repo's WsRelayServer).
 * - `createInspector` — the node-side client. Its `inspect` property IS an
 *   xstate inspect-option callback (v5/v6 events normalized by the SDK), so it
 *   plugs straight into `runAgent({ inspect })`. Stopped actors are retained,
 *   so a settled run stays on screen.
 *
 * One fixed room ("agent-demo") and producer — the demo is a single-user
 * local app; the viz side connects once and every run replaces that producer's
 * replay checkpoint.
 */
import { createInspectionRelay } from "@statelyai/sdk/relay";
import { createInspector, type Inspector } from "@statelyai/sdk/inspect";
import { createInspectionRoomUrls, getInspectionRoomId } from "@statelyai/sdk";
import type { AnyStateMachine } from "xstate";
import { toVizConfig } from "./scenarios";

export const INSPECTION_ROOM_ID = "agent-demo";
const INSPECTION_PRODUCER_ID = "agent-demo-runner";

const DEFAULT_PORT = 4243;

function inspectionPort(): number {
  const raw = Number(process.env.DEMO_INSPECT_PORT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PORT;
}

export function inspectionWsUrl(): string {
  return process.env.DEMO_INSPECT_WS_URL || `ws://localhost:${inspectionPort()}`;
}

export function inspectionRelayUrl(): string {
  return createInspectionRoomUrls({
    url: inspectionWsUrl(),
    roomId: INSPECTION_ROOM_ID,
  }).relayUrl;
}

// Singletons must survive Vite SSR module reloads (HMR re-evaluates this
// module, but the port stays bound), so they live on globalThis.
type InspectionGlobals = {
  relayStarted?: boolean;
  inspector?: Inspector;
};
const globals = globalThis as typeof globalThis & { __agentDemoInspection?: InspectionGlobals };
const state: InspectionGlobals = (globals.__agentDemoInspection ??= {});

/** Starts the WS relay once per server process. Safe to call repeatedly. */
export async function ensureInspectionRelay(): Promise<void> {
  if (state.relayStarted) return;
  state.relayStarted = true;
  const [{ WebSocketServer, WebSocket }, { randomUUID }] = await Promise.all([
    import("ws"),
    import("node:crypto"),
  ]);
  const relay = createInspectionRelay();
  const wss = new WebSocketServer({ port: inspectionPort(), host: "127.0.0.1" });
  const sockets = new Map<string, InstanceType<typeof WebSocket>>();
  wss.on("connection", (ws, request) => {
    const roomId = getInspectionRoomId(new URL(request.url ?? "/", inspectionWsUrl()));
    if (roomId !== INSPECTION_ROOM_ID) {
      ws.close(1008, "Unknown inspection room");
      return;
    }
    const peerId = randomUUID();
    sockets.set(peerId, ws as never);
    ws.on("message", (raw) => {
      for (const effect of relay.receive(peerId, raw.toString())) {
        if (effect.type !== "send") continue;
        const target = sockets.get(effect.peerId);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify(effect.message));
        }
      }
    });
    ws.on("close", () => {
      relay.disconnect(peerId);
      sockets.delete(peerId);
    });
  });
  wss.on("error", (error) => {
    // Port already bound by a previous dev-server process: relay is running.
    console.warn(`[inspection] relay server error: ${String(error)}`);
  });
}

function isMachineConfig(config: unknown): config is Record<string, unknown> {
  return !!config && typeof config === "object" && ("states" in config || "initial" in config);
}

export function machineForInspection(
  actor: { logic?: { config?: unknown } },
  primaryMachine: AnyStateMachine,
  primarySource?: string,
): unknown {
  if (actor.logic === primaryMachine && primarySource) return primarySource;
  const config = actor.logic?.config;
  return isMachineConfig(config) ? toVizConfig({ config } as never) : null;
}

/**
 * Inspection hook for a run — `inspector.inspect` is an xstate inspect-option
 * callback — or undefined when no viz client ever asked for live inspection
 * (tests, headless runs), keeping runs free of WS side effects.
 *
 * One inspector PER RUN (the SDK's intended inspector-per-actor-system
 * usage): xstate sessionIds are only unique within one system, so reusing an
 * inspector across sequential runs collides actor ids and the new machine
 * never re-registers. A fresh inspector per run reconnects and sends a fresh
 * `system.init` carrying the run's machine; the previous one is destroyed
 * (the relay retains its replay for late-joining viz peers).
 */
export function maybeCreateRunInspection(
  primaryMachine: AnyStateMachine,
  primarySource?: string,
): ((event: unknown) => void) | undefined {
  if (!state.relayStarted) return undefined;
  state.inspector?.destroy();
  state.inspector = createInspector({
    url: inspectionWsUrl(),
    roomId: INSPECTION_ROOM_ID,
    producerId: INSPECTION_PRODUCER_ID,
    autoOpen: false,
    name: "Stately Agent Lab",
    readOnly: true,
    panels: { leftPanels: [], rightPanels: [], activePanels: [] },
    capabilities: {
      edit: false,
      export: false,
      ai: false,
      simulate: false,
      inspect: true,
      navigateHierarchy: false,
      maxDepth: 2,
      panels: [],
    },
    // Source preserves guards, inputs, and outputs for the primary machine.
    // Non-machine actors (model-call promises, tools) show as generic nodes.
    extractMachineConfig: (actor: { logic?: { config?: unknown } }) =>
      machineForInspection(actor, primaryMachine, primarySource),
  });
  return state.inspector.inspect as (event: unknown) => void;
}
