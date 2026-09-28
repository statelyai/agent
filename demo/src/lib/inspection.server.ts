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
 * One secure room capability per browser session and one producer per room.
 * The viz side connects once and every run replaces that producer's replay
 * checkpoint.
 *
 * The room does not wait for a run: `declareInspectionMachine` publishes the
 * selected machine's graph (SDK >= 0.33) as soon as an example is picked, so
 * the visualizer draws the statechart immediately and the first run lights up
 * states on a chart that is already on screen.
 *
 * ONE ROOM PER BROWSER SESSION: `openInspectionRoom` mints a room id each time
 * a client asks for connection info, and every declaration, start, and resume
 * carries that id back. Each room keeps its own inspector, actor-id maps,
 * declared machine, and declaration ticket, so two browsers on one dev server
 * never see each other's runs. Rooms are evicted least-recently-used past
 * `MAX_ROOMS`, or after `ROOM_IDLE_MS` without use; a request naming an evicted
 * room recreates it empty (the next run re-registers its actors).
 */
import { randomUUID } from "node:crypto";
import { createInspectionRelay } from "@statelyai/sdk/relay";
import { createInspector, type Inspector } from "@statelyai/sdk/inspect";
import { createInspectionRoomUrls, getInspectionRoomId } from "@statelyai/sdk";
import type { AnyStateMachine, InspectionEvent } from "xstate";
import { toVizConfig } from "./scenarios";
import { nextDeclaration } from "./declaration-ticket";

const INSPECTION_PRODUCER_ID = "agent-demo-runner";

/** Manual id of the inspected root actor — stable across every turn's run. */
const ROOT_ID = "root";
const STOPPED_STATUSES = new Set(["done", "error", "stopped"]);

type AnyActorRefLike = {
  id?: string;
  /** The actor's path in the system (`"<root>/<child>"`), stable across turns. */
  address?: string;
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
    error: jsonSafe(source.error instanceof Error ? source.error.message : source.error),
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

export function inspectionRelayUrl(roomId: string): string {
  return createInspectionRoomUrls({ url: inspectionWsUrl(), roomId }).relayUrl;
}

/** Rooms kept at once; the least recently used goes first past this. */
export const MAX_ROOMS = 32;
/** A room unused for this long is dropped (its tab is most likely gone). */
const ROOM_IDLE_MS = 60 * 60 * 1000;

/** One browser session's inspection state. */
type InspectionRoom = {
  lastUsed: number;
  inspector?: Inspector;
  actorIds?: WeakMap<object, string>;
  idCounts?: Map<string, number>;
  registeredIds?: Set<string>;
  /** Manual id per actor address: a child restored on the next turn is a new
   * object at the same address, and must keep its id. */
  addressIds?: Map<string, string>;
  /** Child ids of the root's latest snapshot. */
  rootChildIds?: Set<string>;
  /** Root machine published to the room ahead of any actor, so the viz can
   * render the selected example before a run exists. */
  declaredMachine?: unknown;
  /** The newest declaration ticket already applied (see `declaration-ticket`).
   * Declarations load their payload asynchronously, so an older one can finish
   * last; without this it would put the previous selection back on screen. */
  declarationApplied?: number;
  /** The current inspector exists only to carry that declaration, so the next
   * declaration can swap its graph in place instead of rebuilding the room. */
  declarationOnly?: boolean;
};

// Singletons must survive Vite SSR module reloads (HMR re-evaluates this
// module, but the port stays bound), so they live on globalThis.
type InspectionGlobals = {
  inspectionEnabled?: boolean;
  relayStarted?: boolean;
  relayStart?: Promise<void>;
  /** In least-recently-used order: a use moves a room to the end. */
  rooms?: Map<string, InspectionRoom>;
};
const globals = globalThis as typeof globalThis & { __agentDemoInspection?: InspectionGlobals };
const state: InspectionGlobals = (globals.__agentDemoInspection ??= {});
const rooms = (state.rooms ??= new Map());

/** Mints a new room — one per browser session asking for connection info. */
export function openInspectionRoom(): string {
  const roomId = randomUUID();
  touchRoom(roomId);
  return roomId;
}

/**
 * The room's state, created when missing (an evicted room comes back empty),
 * marked used, and moved to the back of the eviction order.
 */
function touchRoom(roomId: string): InspectionRoom {
  const now = Date.now();
  const room = rooms.get(roomId) ?? { lastUsed: now };
  rooms.delete(roomId);
  room.lastUsed = now;
  rooms.set(roomId, room);
  // Oldest first, and the room just used is newest, so it is never evicted.
  for (const [id, candidate] of rooms) {
    if (rooms.size <= MAX_ROOMS && now - candidate.lastUsed < ROOM_IDLE_MS) break;
    candidate.inspector?.destroy();
    rooms.delete(id);
  }
  return room;
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
    if (!roomId || !rooms.has(roomId)) {
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
  if (actor.logic?.config === primaryMachine.config && primarySource) {
    return rootMachinePayload(primaryMachine, primarySource);
  }
  const config = actor.logic?.config;
  return isMachineConfig(config) ? toVizConfig({ config } as never) : null;
}

/**
 * What the root actor shows in the visualizer: the authored source when the
 * demo has it (executable expressions survive), otherwise a plain config.
 *
 * `declareInspectionMachine` publishes exactly this ahead of the run, so the
 * graph the viz draws before a run is the same one the root actor registers
 * with — no swap when the first turn starts.
 */
export function rootMachinePayload(machine: AnyStateMachine, source?: string): unknown {
  return source ?? (isMachineConfig(machine.config) ? toVizConfig(machine) : null);
}

/**
 * Creates the room's inspector and resets the per-session id bookkeeping.
 * `machines` seeds the system checkpoint so a declared root machine survives
 * the inspector being rebuilt for a new run session.
 *
 * `pinSelection` is for run sessions only. The visualizer clears its declared
 * machine the moment an init names a selected session, whether or not that
 * actor exists yet — so pinning the root before a run has actors would hide
 * the very graph the declaration is there to show.
 */
function createRoomInspector(
  roomId: string,
  room: InspectionRoom,
  { pinSelection }: { pinSelection: boolean },
): Inspector {
  const inspector = createInspector({
    url: inspectionWsUrl(),
    roomId,
    producerId: INSPECTION_PRODUCER_ID,
    launch: "none",
    name: "Stately Agent Lab",
    // Manual ids go on the wire as `<producer>:<id>`; a resumed turn may
    // register a child before the root, so pin the selection explicitly.
    ...(pinSelection ? { selectedSessionId: `${INSPECTION_PRODUCER_ID}:${ROOT_ID}` } : {}),
    ...(room.declaredMachine !== undefined
      ? { machines: { [ROOT_ID]: room.declaredMachine } }
      : {}),
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
  room.actorIds = new WeakMap();
  room.idCounts = new Map();
  room.registeredIds = new Set();
  room.addressIds = new Map();
  room.rootChildIds = new Set();
  return inspector;
}

/**
 * Publishes a machine to the inspection room before any actor exists, so the
 * viz renders the selected example's statechart instead of an empty room.
 *
 * `inspector.machine(ROOT_ID, ...)` refreshes the system checkpoint in place,
 * so switching examples replaces the graph on the already-connected /inspect
 * page rather than reloading it. Returns whether anything was published — a
 * machine the demo cannot serialize, or a request that arrives before any viz
 * client asked for inspection, publishes nothing.
 */
export function declareInspectionMachine(
  roomId: string,
  payload: unknown,
  declaration?: number,
): boolean {
  if (!state.inspectionEnabled || payload == null) return false;
  const room = touchRoom(roomId);
  // Something newer already claimed the room while this payload was loading.
  if (declaration !== undefined && declaration < (room.declarationApplied ?? 0)) return false;
  if (declaration !== undefined) room.declarationApplied = declaration;
  room.declaredMachine = payload;
  // Selecting an example resets the run, so an inspector a run session owns
  // goes with it — otherwise that run's actors would sit in the room beside a
  // machine they do not belong to. One that only ever carried a declaration
  // has nothing to drop, so it keeps its connection and swaps graphs in place.
  if (!room.declarationOnly) {
    room.inspector?.destroy();
    room.inspector = undefined;
  }
  if (room.inspector) room.inspector.machine(ROOT_ID, payload);
  else room.inspector = createRoomInspector(roomId, room, { pinSelection: false });
  room.declarationOnly = true;
  return true;
}

/**
 * Inspection hook for a run — an xstate `inspect` callback that drives the
 * SDK inspector's MANUAL actor API — or undefined when no viz client ever
 * asked for live inspection or the run names no room (tests, headless runs),
 * keeping runs free of WS side effects. The run lands in `roomId` only.
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
  roomId: string | undefined,
  primaryMachine: AnyStateMachine,
  primarySource?: string,
  phase: "start" | "resume" = "start",
): ((event: InspectionEvent) => void) | undefined {
  if (!state.inspectionEnabled || !roomId) return undefined;
  const room = touchRoom(roomId);
  // The run is the authority on what the room's machine is: a headless run
  // (no viz client, so nothing declared) must not inherit whatever a previous
  // selection left behind when the inspector is rebuilt below.
  const rootPayload = rootMachinePayload(primaryMachine, primarySource);
  // Assigned either way: a run whose machine cannot be serialized publishes
  // nothing, and must not leave the previous selection's graph behind for the
  // inspector below to seed.
  room.declaredMachine = rootPayload ?? undefined;
  // A run outranks any declaration still in flight.
  room.declarationApplied = nextDeclaration();
  // A run always opens its own inspector: a declaration-only one was built
  // without the root selection pin (see `createRoomInspector`), and that
  // option is fixed at construction.
  if (phase === "start" || !room.inspector) {
    room.inspector?.destroy();
    room.inspector = createRoomInspector(roomId, room, { pinSelection: true });
  }
  room.declarationOnly = false;
  const inspector = room.inspector;
  const actorIds = (room.actorIds ??= new WeakMap());
  const idCounts = (room.idCounts ??= new Map());
  const registeredIds = (room.registeredIds ??= new Set());
  const addressIds = (room.addressIds ??= new Map());

  /** Stable manual id: `"root"`, then `"X"`, `"X#2"`… per xstate actor id. */
  function idOf(actorRef: AnyActorRefLike, parentRef?: AnyActorRefLike): string {
    const existing = actorIds.get(actorRef);
    if (existing) return existing;
    if ((parentRef ?? actorRef._parent) == null) {
      actorIds.set(actorRef, ROOT_ID);
      return ROOT_ID;
    }
    const carried = actorRef.address ? addressIds.get(actorRef.address) : undefined;
    if (carried) {
      actorIds.set(actorRef, carried);
      return carried;
    }
    const base = String(actorRef.id ?? "actor");
    const seen = (idCounts.get(base) ?? 0) + 1;
    idCounts.set(base, seen);
    const id = seen === 1 ? base : `${base}#${seen}`;
    actorIds.set(actorRef, id);
    if (actorRef.address) addressIds.set(actorRef.address, id);
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
      // The runtime stops the root actor between turns (idle waits, persisted
      // snapshot). That stop is a runtime detail, not the session ending:
      // keep the root on its last live snapshot so it never reads as stopped.
      if (id === ROOT_ID && event.event?.type === "@xstate.stop") return;
      if (id === ROOT_ID) {
        room.rootChildIds = new Set(
          Object.keys((event.snapshot as { children?: object } | undefined)?.children ?? {}),
        );
      }
      // The same goes for a child the settled run stops while the root still
      // holds it (a long-lived agent between turns): the next turn restores
      // it at the same address, so it stays on screen as it was.
      if (
        id !== ROOT_ID &&
        event.event?.type === "@xstate.stop" &&
        room.rootChildIds?.has(String(actorRef.id))
      ) {
        return;
      }
      const serialized = serializeSnapshot(event.snapshot);
      inspector.snapshot(id, serialized, event.event);
      if (id !== ROOT_ID && STOPPED_STATUSES.has(String(serialized.status))) {
        inspector.stop(id);
        // A later invoke at this address is a new actor, with a new id.
        if (actorRef.address) addressIds.delete(actorRef.address);
      }
    }
  };
}
