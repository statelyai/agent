/**
 * Live inspection (server): real-time statechart inspection over hosted
 * Stately Sky by default, replacing the post-hoc trace replay.
 *
 * Both pieces come from `@statelyai/sdk`:
 * - `createInspectionRelay` — the transport-agnostic relay core, hosted here
 *   only when the demo explicitly opts into a local WebSocket URL.
 * - `createInspector` — the node-side client. The demo drives its MANUAL
 *   actor API (`actor`/`snapshot`/`event`/`stop`) from an xstate inspect-option
 *   callback of its own, rather than passing `inspector.inspect`, so actor
 *   identity stays stable across a session's per-turn `runAgent` calls.
 *   Stopped actors are retained, so a settled run stays on screen.
 *
 * One secure room capability per dev-server process and one producer. The viz
 * side connects once and every run replaces that producer's replay checkpoint.
 *
 * SINGLE-USER BY DESIGN: the room, the inspector, and its actor-id maps are
 * process-wide, so two browsers on the same dev server share one inspection
 * stream (a start in one replaces the other's run). The demo is a local,
 * one-person tool; per-session rooms would need connection info, start,
 * resume, and rewind to all carry a session key, and are out of scope here.
 */
import { randomUUID } from "node:crypto";
import { createInspectionRelay } from "@statelyai/sdk/relay";
import { createInspector, type Inspector } from "@statelyai/sdk/inspect";
import { createInspectionRoomUrls, getInspectionRoomId } from "@statelyai/sdk";
import type { AnyStateMachine, InspectionEvent } from "xstate";
import { toVizConfig } from "./scenarios";

const INSPECTION_PRODUCER_ID = "agent-demo-runner";

/** Manual id of the inspected root actor — stable across every turn's run. */
const ROOT_ID = "root";
const STOPPED_STATUSES = new Set(["done", "error", "stopped"]);

type AnyActorRefLike = {
  id?: string;
  _parent?: AnyActorRefLike;
  logic?: { config?: unknown };
  getSnapshot?: () => unknown;
};

/** JSON-safe or dropped — inspected values travel over the relay as JSON. */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** Small, dependency-free wire shape for a snapshot. */
function serializeSnapshot(snapshot: unknown): {
  value: unknown;
  status: unknown;
  context: unknown;
  output: unknown;
  error: unknown;
} {
  const source = (snapshot ?? {}) as {
    value?: unknown;
    status?: unknown;
    context?: unknown;
    output?: unknown;
    error?: unknown;
  };
  return {
    value: jsonSafe(source.value),
    status: source.status,
    context: jsonSafe(source.context),
    output: jsonSafe(source.output),
    error: jsonSafe(
      source.error instanceof Error ? source.error.message : source.error,
    ),
  };
}

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
  actorIds?: WeakMap<object, string>;
  idCounts?: Map<string, number>;
  registeredIds?: Set<string>;
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
 * Inspection hook for a run — an xstate `inspect` callback that drives the
 * SDK inspector's MANUAL actor API — or undefined when no viz client ever
 * asked for live inspection (tests, headless runs), keeping runs free of WS
 * side effects.
 *
 * ONE INSPECTOR PER RUN SESSION, with stable manual actor ids. The demo runs
 * one `runAgent` per chat turn (a fresh run to start, then a resume from the
 * persisted snapshot for every user event), so an inspector per `runAgent`
 * sent a fresh `@statelyai.system.init` every turn and the hosted /inspect
 * page tore down and rebuilt the whole tree (a visible flash). The SDK's auto
 * mode can't span turns either: xstate sessionIds are only unique within one
 * actor system, and each new root triggers another init.
 *
 * So identity is assigned here instead of by the runtime: the root actor is
 * always `"root"` and children keep their xstate id (`"X"`, then `"X#2"` for a
 * re-invocation). `phase: "start"` opens a new session (new inspector, reset
 * bookkeeping); `phase: "resume"` reuses it, so `actor("root")` is a no-op and
 * the turn arrives as `@statelyai.system.actorSnapshot` updates on the same
 * inspected actor.
 */
export function maybeCreateRunInspection(
  primaryMachine: AnyStateMachine,
  primarySource?: string,
  phase: "start" | "resume" = "start",
): ((event: InspectionEvent) => void) | undefined {
  if (!state.inspectionEnabled) return undefined;
  if (phase === "start" || !state.inspector) {
    state.inspector?.destroy();
    state.inspector = createInspector({
      url: inspectionWsUrl(),
      roomId: inspectionRoomId(),
      producerId: INSPECTION_PRODUCER_ID,
      launch: "none",
      name: "Stately Agent Lab",
      // Manual ids go on the wire as `<producer>:<id>`; a resumed turn may
      // register a child before the root, so pin the selection explicitly.
      selectedSessionId: `${INSPECTION_PRODUCER_ID}:${ROOT_ID}`,
      readOnly: true,
      panels: [],
      capabilities: {
        edit: false,
        export: false,
        ai: false,
        simulate: false,
        inspect: true,
        maxDepth: 2,
        panels: [],
      },
    });
    state.actorIds = new WeakMap();
    state.idCounts = new Map();
    state.registeredIds = new Set();
  }
  const inspector = state.inspector;
  const actorIds = (state.actorIds ??= new WeakMap());
  const idCounts = (state.idCounts ??= new Map());
  const registeredIds = (state.registeredIds ??= new Set());

  /** Stable manual id: `"root"`, then `"X"`, `"X#2"`… per xstate actor id. */
  function idOf(actorRef: AnyActorRefLike, parentRef?: AnyActorRefLike): string {
    const existing = actorIds.get(actorRef);
    if (existing) return existing;
    if ((parentRef ?? actorRef._parent) == null) {
      actorIds.set(actorRef, ROOT_ID);
      return ROOT_ID;
    }
    const base = String(actorRef.id ?? "actor");
    const seen = (idCounts.get(base) ?? 0) + 1;
    idCounts.set(base, seen);
    const id = seen === 1 ? base : `${base}#${seen}`;
    actorIds.set(actorRef, id);
    return id;
  }

  /** Registers an actor the first time it is seen, and returns its id. */
  function register(
    actorRef: AnyActorRefLike,
    snapshot?: unknown,
    parentRef?: AnyActorRefLike,
  ): string {
    // Ids are assigned lazily (a child's `parentRef` names the root before
    // the root's own `@xstate.actor` arrives), so track registration apart
    // from assignment: the root must still get its `actor()` call.
    const id = idOf(actorRef, parentRef);
    if (registeredIds.has(id)) return id;
    registeredIds.add(id);
    const ref = parentRef ?? actorRef._parent;
    // xstate v6 announces a child before its parent; the wire wants the
    // parent first so the tree (and the initial selection) resolves.
    const parent = ref ? register(ref) : undefined;
    inspector.actor(id, {
      ...(parent ? { parent } : {}),
      machine: machineForInspection(actorRef, primaryMachine, primarySource),
      snapshot: serializeSnapshot(snapshot ?? currentSnapshot(actorRef)),
    });
    return id;
  }

  /** `getSnapshot()` throws while an actor is still initializing. */
  function currentSnapshot(actorRef: AnyActorRefLike): unknown {
    try {
      return actorRef.getSnapshot?.();
    } catch {
      return undefined;
    }
  }

  return (inspectionEvent: InspectionEvent) => {
    // The SDK normalizes v5 (`@xstate.event` + `@xstate.snapshot`) and v6
    // (one `@xstate.transition` carrying both), so both shapes are handled.
    const event = inspectionEvent as unknown as {
      type: string;
      actorRef?: AnyActorRefLike;
      parentRef?: AnyActorRefLike;
      sourceRef?: AnyActorRefLike;
      snapshot?: unknown;
      event?: { type: string };
    };
    const actorRef = event.actorRef;
    if (!actorRef) return;
    if (event.type === "@xstate.actor") {
      const id = register(actorRef, event.snapshot, event.parentRef);
      // The root may already be registered (named as a child's parent, or a
      // resumed turn), so its starting snapshot is pushed explicitly.
      if (id === ROOT_ID && event.snapshot) {
        inspector.snapshot(ROOT_ID, serializeSnapshot(event.snapshot), { type: "@xstate.init" });
      }
      return;
    }
    if (event.type === "@xstate.event") {
      const id = register(actorRef);
      if (event.event) {
        inspector.event(
          id,
          event.event,
          event.sourceRef ? { source: idOf(event.sourceRef) } : undefined,
        );
      }
      return;
    }
    if (event.type === "@xstate.snapshot" || event.type === "@xstate.transition") {
      const id = register(actorRef, event.snapshot);
      // runAgent stops the root actor between turns (idle waits, persisted
      // snapshot). That stop is a runtime detail, not the session ending:
      // keep the root on its last live snapshot so it never reads as stopped.
      if (id === ROOT_ID && event.event?.type === "@xstate.stop") return;
      const serialized = serializeSnapshot(event.snapshot);
      inspector.snapshot(id, serialized, event.event);
      if (id !== ROOT_ID && STOPPED_STATUSES.has(String(serialized.status))) {
        inspector.stop(id);
      }
    }
  };
}
