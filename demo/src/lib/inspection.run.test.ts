import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "xstate";

const inspectorMock = vi.hoisted(() => ({
  actor: vi.fn(),
  snapshot: vi.fn(),
  event: vi.fn(),
  stop: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@statelyai/sdk/inspect", () => ({ createInspector: vi.fn(() => inspectorMock) }));

import { resumeScenarioRun, startScenarioRun } from "./agent-runner";
import { ensureInspectionRelay } from "./inspection.server";
import { scenarioSource } from "./scenarios";
import { scriptedExecutorsFor } from "./scripted-executors";

afterEach(() => {
  vi.clearAllMocks();
});

// Drives a REAL scenario run through the manual inspector API and checks what
// hits the wire: the root keeps one stable id, carries its source machine, and
// a resumed turn arrives as snapshot updates rather than a re-registration.
describe("run inspection over a real scenario", () => {
  it("registers the root once with its source and updates it across resume", async () => {
    vi.stubEnv("DEMO_INSPECT_WS_URL", "");
    vi.stubEnv("DEMO_INSPECT_PORT", "");
    vi.stubEnv("STATELY_INSPECT_URL", "");
    await ensureInspectionRelay();

    const first = await startScenarioRun(
      "refund",
      "I need a $184 refund for a damaged delivery.",
      "script",
      undefined,
      scriptedExecutorsFor("refund"),
    );
    expect(first.status).toBe("idle");

    const rootRegistrations = inspectorMock.actor.mock.calls.filter(([id]) => id === "root");
    expect(rootRegistrations).toHaveLength(1);
    expect(rootRegistrations[0][1]).toEqual(
      expect.objectContaining({ machine: scenarioSource.refund }),
    );
    expect(rootRegistrations[0][1]).not.toHaveProperty("parent");

    const childRegistrations = inspectorMock.actor.mock.calls.filter(([id]) => id !== "root");
    for (const [, options] of childRegistrations) {
      expect(options).toEqual(expect.objectContaining({ parent: "root" }));
    }

    const rootSnapshots = inspectorMock.snapshot.mock.calls.filter(([id]) => id === "root");
    expect(rootSnapshots.at(-1)?.[1]).toEqual(
      expect.objectContaining({ value: "awaitingApproval" }),
    );
    expect(inspectorMock.stop).not.toHaveBeenCalledWith("root");

    inspectorMock.actor.mockClear();
    inspectorMock.snapshot.mockClear();

    const second = await resumeScenarioRun(
      "refund",
      first.idle!.snapshot as unknown as Snapshot<unknown>,
      { type: "APPROVE" },
      "script",
      undefined,
      scriptedExecutorsFor("refund"),
    );
    expect(second.status).toBe("done");

    // Same inspector, same root id: no second registration, only snapshots.
    expect(inspectorMock.destroy).not.toHaveBeenCalled();
    expect(inspectorMock.actor.mock.calls.filter(([id]) => id === "root")).toHaveLength(0);
    const resumed = inspectorMock.snapshot.mock.calls.filter(([id]) => id === "root");
    expect(resumed.at(-1)?.[1]).toEqual(expect.objectContaining({ value: "approved" }));
    expect(inspectorMock.stop).not.toHaveBeenCalledWith("root");
  });
});
