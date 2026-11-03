import type { InspectionEvent } from "xstate";
import { isRecord } from "./is-record.js";

/**
 * Makes a durable run's inspection stream look like one live actor system to
 * an inspector. The durable runtime re-creates an actor object for each step
 * under the same `sessionId` and announces it again, so an inspector that
 * tracks actors by object (`@statelyai/sdk`) sees a duplicate and drops the
 * rest of the run. Each `sessionId` gets one stable handle that reads from the
 * newest actor object, and is announced once.
 */
export function stableInspection(
  inspect: (event: InspectionEvent) => void,
): (event: InspectionEvent) => void {
  const handles = new Map<string, { latest: object; handle: object }>();
  const announced = new Set<string>();
  const snapshots = new WeakMap<object, object>();

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

  const stable = (ref: unknown): unknown => {
    if (!isRecord(ref) || typeof ref["sessionId"] !== "string") {
      return ref;
    }
    const sessionId = ref["sessionId"];
    const known = handles.get(sessionId);
    if (known) {
      known.latest = ref;
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

  return (event) => {
    const raw = event as unknown as Record<string, unknown>;
    const actorRef = raw["actorRef"];
    const sessionId = isRecord(actorRef) ? actorRef["sessionId"] : undefined;
    if (raw["type"] === "@xstate.actor" && typeof sessionId === "string") {
      if (announced.has(sessionId)) {
        stable(actorRef);
        return;
      }
      announced.add(sessionId);
    }
    const next: Record<string, unknown> = { ...raw, actorRef: stable(actorRef) };
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
  };
}
