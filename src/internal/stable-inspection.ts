import type { InspectionEvent } from "xstate";
import { isRecord } from "./is-record.js";

/** An inspect callback from {@link stableInspection}. */
export interface StableInspection {
  (event: InspectionEvent): void;
  /**
   * Marks the end of one runtime's pass. In the next pass, an actor at the
   * same path as one still live now is the same actor under a new
   * `sessionId`, and keeps its handle. `persisted` is the pass's persisted
   * snapshot: a child it lists was stopped only by the pass's teardown and
   * carries over too.
   */
  endPass(persisted?: unknown): void;
}

const stableInspections = new WeakSet<object>();

/** Whether `inspect` already came from {@link stableInspection}. */
export function isStableInspection(inspect: unknown): inspect is StableInspection {
  return typeof inspect === "function" && stableInspections.has(inspect);
}

// The actor's ids from the root down, read from the internal `_parent` chain.
function actorPath(ref: Record<string, unknown>): string {
  const ids: unknown[] = [];
  let current: unknown = ref;
  while (isRecord(current)) {
    ids.unshift(current["id"]);
    current = current["_parent"];
  }
  return JSON.stringify(ids);
}

// Each child's id path below the root, from a persisted snapshot's `children`.
function persistedChildPaths(persisted: unknown, prefix: string[] = [], paths = new Set<string>()) {
  const children = isRecord(persisted) ? persisted["children"] : undefined;
  if (!isRecord(children)) return paths;
  for (const [id, child] of Object.entries(children)) {
    const path = [...prefix, id];
    paths.add(JSON.stringify(path));
    persistedChildPaths(isRecord(child) ? child["snapshot"] : undefined, path, paths);
  }
  return paths;
}

/**
 * Makes a durable run's inspection stream look like one live actor system to
 * an inspector. The durable runtime re-creates an actor object for each step
 * under the same `sessionId` and announces it again, so an inspector that
 * tracks actors by object (`@statelyai/sdk`) sees a duplicate and drops the
 * rest of the run. Each `sessionId` gets one stable handle that reads from the
 * newest actor object, and is announced once. Across runtimes (`runAgent`'s
 * `onIdle` passes), {@link StableInspection.endPass} carries live actors over.
 */
export function stableInspection(inspect: (event: InspectionEvent) => void): StableInspection {
  const handles = new Map<string, { latest: object; handle: object }>();
  const announced = new Set<string>();
  const snapshots = new WeakMap<object, object>();
  // A later pass's sessionId → the sessionId its actor was first announced as.
  const aliases = new Map<string, string>();
  // Announced actors not yet seen done, by sessionId → path.
  const live = new Map<string, string>();
  // Announced actors seen stopped, by sessionId → path: a pass's teardown
  // stops the children it persists.
  const stopped = new Map<string, string>();
  // At a pass boundary: path → the sessionId of the actor live there.
  let carried = new Map<string, string>();

  // A snapshot whose `children` are handles too, so walking the actor tree
  // from it never reaches a step's raw actor object.
  const stableSnapshot = (snapshot: unknown): unknown => {
    if (!isRecord(snapshot) || !isRecord(snapshot["children"])) {
      return snapshot;
    }
    const cached = snapshots.get(snapshot);
    if (cached) {
      return cached;
    }
    const copy = Object.create(
      Object.getPrototypeOf(snapshot) as object | null,
      Object.getOwnPropertyDescriptors(snapshot),
    ) as Record<string, unknown>;
    copy["children"] = Object.fromEntries(
      Object.entries(snapshot["children"]).map(([id, child]) => [id, stable(child)]),
    );
    snapshots.set(snapshot, copy);
    return copy;
  };

  // Only the actor an event comes from (`adopt`) moves its handle to a newer
  // object. A reference reached any other way (a child's `_parent`, a
  // snapshot's children) may be an older step's object and only looks up.
  const stable = (ref: unknown, adopt = false): unknown => {
    if (!isRecord(ref) || typeof ref["sessionId"] !== "string") {
      return ref;
    }
    const sessionId = aliases.get(ref["sessionId"]) ?? ref["sessionId"];
    const known = handles.get(sessionId);
    if (known) {
      if (adopt) known.latest = ref;
      return known.handle;
    }
    const entry = { latest: ref as object, handle: ref as object };
    entry.handle = new Proxy(ref, {
      get(_target, key) {
        const value = Reflect.get(entry.latest, key, entry.latest) as unknown;
        // Every way back to an actor goes through its handle: the parent,
        // the actor's own `ref`, and the parent in its options.
        if (key === "_parent") {
          return stable(value);
        }
        if (key === "ref") {
          return entry.handle;
        }
        if (key === "sessionId") {
          return sessionId;
        }
        if (key === "getSnapshot") {
          return () => stableSnapshot((entry.latest as { getSnapshot(): unknown }).getSnapshot());
        }
        if (key === "_snapshot") {
          return stableSnapshot(value);
        }
        if (key === "options" && isRecord(value) && value["parent"] !== undefined) {
          return { ...value, parent: stable(value["parent"]) };
        }
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(entry.latest)
          : value;
      },
      has: (_target, key) => key in entry.latest,
    });
    handles.set(sessionId, entry);
    return entry.handle;
  };

  const stableInspect = ((event: InspectionEvent) => {
    const raw = event as unknown as Record<string, unknown>;
    const actorRef = raw["actorRef"];
    const rawSessionId = isRecord(actorRef) ? actorRef["sessionId"] : undefined;
    if (raw["type"] === "@xstate.actor" && typeof rawSessionId === "string") {
      const path = actorPath(actorRef as Record<string, unknown>);
      const previous = carried.get(path);
      if (previous !== undefined && previous !== rawSessionId) {
        carried.delete(path);
        aliases.set(rawSessionId, previous);
      }
      const sessionId = aliases.get(rawSessionId) ?? rawSessionId;
      live.set(sessionId, path);
      if (announced.has(sessionId)) {
        stable(actorRef, true);
        return;
      }
      announced.add(sessionId);
    }
    if (typeof rawSessionId === "string" && isRecord(raw["snapshot"])) {
      const status = raw["snapshot"]["status"];
      if (status !== undefined && status !== "active") {
        const sessionId = aliases.get(rawSessionId) ?? rawSessionId;
        const path = live.get(sessionId);
        live.delete(sessionId);
        if (status === "stopped" && path !== undefined) stopped.set(sessionId, path);
      }
    }
    const next: Record<string, unknown> = { ...raw, actorRef: stable(actorRef, true) };
    if (raw["snapshot"] !== undefined) next["snapshot"] = stableSnapshot(raw["snapshot"]);
    // A transition's sent events name their targets by actor too.
    if (Array.isArray(raw["sent"])) {
      next["sent"] = raw["sent"].map((sent: unknown) =>
        isRecord(sent) && sent["targetRef"] !== undefined
          ? { ...sent, targetRef: stable(sent["targetRef"]) }
          : sent,
      );
    }
    for (const key of ["parentRef", "sourceRef", "targetRef"] as const) {
      if (raw[key] !== undefined) next[key] = stable(raw[key]);
    }
    inspect(next as unknown as InspectionEvent);
  }) as StableInspection;
  stableInspect.endPass = (persisted) => {
    const kept = persistedChildPaths(persisted);
    const root = [...live.values(), ...stopped.values()].find(
      (path) => (JSON.parse(path) as unknown[]).length === 1,
    );
    const rootId = root === undefined ? undefined : (JSON.parse(root) as unknown[])[0];
    const carriedStopped = [...stopped].filter(([, path]) => {
      const [id, ...rest] = JSON.parse(path) as unknown[];
      return id === rootId && kept.has(JSON.stringify(rest));
    });
    stopped.clear();
    carried = new Map([...live, ...carriedStopped].map(([sessionId, path]) => [path, sessionId]));
  };
  stableInspections.add(stableInspect);
  return stableInspect;
}
