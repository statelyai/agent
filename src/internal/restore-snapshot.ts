import type { AnyMachineSnapshot, AnyStateMachine } from "xstate";
import { restoreActor } from "xstate/persist";

/**
 * The snapshot `machine` resumes from for `persisted`, with no actor started.
 * XState reports a snapshot it cannot restore as an `'error'` snapshot; this
 * throws that error instead, unless the persisted snapshot was itself an error.
 */
export function restoreMachineSnapshot(
  machine: AnyStateMachine,
  persisted: unknown,
): AnyMachineSnapshot {
  const snapshot = restoreActor(machine, persisted as never).getSnapshot() as AnyMachineSnapshot;
  if (snapshot.status === "error" && (persisted as { status?: unknown })?.status !== "error") {
    throw snapshot.error;
  }
  return snapshot;
}
