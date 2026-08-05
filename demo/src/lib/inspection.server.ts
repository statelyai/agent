/**
 * Live inspection (server): real-time statechart inspection over hosted
 * Stately Sky by default, replacing the post-hoc trace replay.
 *
 * Both pieces come from `@statelyai/sdk`:
 * - `createInspectionRelay` — the transport-agnostic relay core, hosted here
 *   only when the demo explicitly opts into a local WebSocket URL.
 * - `createInspector` — the node-side client. Its `inspect` property IS an
 *   xstate inspect-option callback (v5/v6 events normalized by the SDK), so it
 *   plugs straight into `runAgent({ inspect })`. Stopped actors are retained,
 *   so a settled run stays on screen.
 *
 * One secure room capability per dev-server process and one producer. The viz
 * side connects once and every run replaces that producer's replay checkpoint.
 */
import { randomUUID } from "node:crypto";
import { createInspectionRelay } from "@statelyai/sdk/relay";
import { createInspector, type Inspector } from "@statelyai/sdk/inspect";
import { createInspectionRoomUrls, getInspectionRoomId } from "@statelyai/sdk";
import type { AnyStateMachine } from "xstate";
import { toVizConfig } from "./scenarios";

const INSPECTION_PRODUCER_ID = "agent-demo-runner";

const DEFAULT_PORT = 4243;
const HOSTED_INSPECTION_URL = "wss://sky.stately.ai";
const LOCAL_RELAY_HOSTS = new Set(["127.0.0.1", "localhost"]);

function inspectionPort(): number {
  const raw = Number(process.env.DEMO_INSPECT_PORT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PORT;
}

export function inspectionWsUrl(): string {
  const demoUrl = process.env.DEMO_INSPECT_WS_URL?.trim();
  if (demoUrl) return demoUrl;
  if (process.env.DEMO_INSPECT_PORT?.trim()) return `ws://localhost:${inspectionPort()}`;
  return process.env.STATELY_INSPECT_URL?.trim() || HOSTED_INSPECTION_URL;
}

/** Whether this process owns the explicitly configured loopback relay. */
export function shouldStartLocalInspectionRelay(): boolean {
  if (!process.env.DEMO_INSPECT_WS_URL?.trim() && !process.env.DEMO_INSPECT_PORT?.trim()) {
    return false;
  }
  const url = new URL(inspectionWsUrl());
  return url.protocol === "ws:" && LOCAL_RELAY_HOSTS.has(url.hostname);
}

export function inspectionRelayUrl(): string {
  return createInspectionRoomUrls({
    url: inspectionWsUrl(),
    roomId: inspectionRoomId(),
  }).relayUrl;
}

// Singletons must survive Vite SSR module reloads (HMR re-evaluates this
// module, but the port stays bound), so they live on globalThis.
type InspectionGlobals = {
  roomId?: string;
  inspectionEnabled?: boolean;
  relayStarted?: boolean;
  relayStart?: Promise<void>;
  inspector?: Inspector;
};
const globals = globalThis as typeof globalThis & { __agentDemoInspection?: InspectionGlobals };
const state: InspectionGlobals = (globals.__agentDemoInspection ??= {});

export function inspectionRoomId(): string {
  return (state.roomId ??= randomUUID());
}

async function startLocalInspectionRelay(): Promise<void> {
  const [{ WebSocketServer, WebSocket }, { randomUUID }] = await Promise.all([
    import("ws"),
    import("node:crypto"),
  ]);
  const relay = createInspectionRelay();
  const relayUrl = new URL(inspectionWsUrl());
  const port = Number(relayUrl.port || 80);
  const host = relayUrl.hostname === "localhost" ? "127.0.0.1" : relayUrl.hostname;
  const wss = new WebSocketServer({ port, host });
  const sockets = new Map<string, InstanceType<typeof WebSocket>>();
  wss.on("connection", (ws, request) => {
    const roomId = getInspectionRoomId(new URL(request.url ?? "/", inspectionWsUrl()));
    if (roomId !== inspectionRoomId()) {
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
  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error) => reject(error);
    wss.once("error", onStartupError);
    wss.once("listening", () => {
      wss.off("error", onStartupError);
      wss.on("error", (error) => {
        console.warn(`[inspection] relay server error: ${String(error)}`);
      });
      resolve();
    });
  });
}

/** Starts an explicitly configured local relay once per server process. */
export async function ensureInspectionRelay(): Promise<void> {
  if (state.inspectionEnabled) return;
  if (shouldStartLocalInspectionRelay() && !state.relayStarted) {
    state.relayStart ??= startLocalInspectionRelay();
    try {
      await state.relayStart;
      state.relayStarted = true;
    } catch (error) {
      state.relayStart = undefined;
      throw error;
    }
  }
  state.inspectionEnabled = true;
}

function isMachineConfig(config: unknown): config is Record<string, unknown> {
  return !!config && typeof config === "object" && ("states" in config || "initial" in config);
}

export function machineForInspection(
  actor: { logic?: { config?: unknown } },
  primaryMachine: AnyStateMachine,
  primarySource?: string,
): unknown {
  // runAgent binds actor implementations with two `.provide(...)` calls, which
  // creates new machine logic objects while preserving the authored config.
  if (actor.logic?.config === primaryMachine.config && primarySource) return primarySource;
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
  if (!state.inspectionEnabled) return undefined;
  state.inspector?.destroy();
  state.inspector = createInspector({
    url: inspectionWsUrl(),
    roomId: inspectionRoomId(),
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
    extractMachine: (actor: { logic?: { config?: unknown } }) =>
      machineForInspection(actor, primaryMachine, primarySource),
  });
  return state.inspector.inspect as (event: unknown) => void;
}
