import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { createMachine } from "xstate";
const createInspectorMock = vi.hoisted(() =>
  vi.fn((_options: unknown) => ({
    actor: vi.fn(),
    snapshot: vi.fn(),
    event: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
  })),
);
vi.mock("@statelyai/sdk/inspect", () => ({ createInspector: createInspectorMock }));

import {
  ensureInspectionRelay,
  inspectionRelayUrl,
  inspectionRoomId,
  inspectionWsUrl,
  machineForInspection,
  maybeCreateRunInspection,
  shouldStartLocalInspectionRelay,
} from "./inspection.server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("demo inspection transport", () => {
  it("uses raw source for the provided root machine runAgent actually inspects", () => {
    const machine = createMachine({ id: "test", initial: "idle", states: { idle: {} } });
    const boundMachine = machine.provide({}).provide({});
    const source = "export const machine = createMachine({ states: {} });";

    expect(machineForInspection({ logic: boundMachine }, machine, source)).toBe(source);
  });

  it("uses hosted Stately Sky without starting a local relay by default", () => {
    vi.stubEnv("DEMO_INSPECT_WS_URL", "");
    vi.stubEnv("DEMO_INSPECT_PORT", "");
    vi.stubEnv("STATELY_INSPECT_URL", "");

    expect(inspectionWsUrl()).toBe("wss://sky.stately.ai");
    expect(shouldStartLocalInspectionRelay()).toBe(false);
  });

  it("enables run inspection after hosted connection info is requested", async () => {
    vi.stubEnv("DEMO_INSPECT_WS_URL", "");
    vi.stubEnv("DEMO_INSPECT_PORT", "");
    vi.stubEnv("STATELY_INSPECT_URL", "");
    const machine = {};
    const source = "export const machine = createMachine({ states: {} });";

    await ensureInspectionRelay();
    const inspect = maybeCreateRunInspection(machine as never, source, "start");

    expect(inspect).toEqual(expect.any(Function));
    expect(createInspectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://sky.stately.ai",
        roomId: inspectionRoomId(),
      }),
    );
    const options = createInspectorMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("extractMachine");
    expect(options).not.toHaveProperty("extractMachineConfig");
  });

  it("keeps one inspector per run session: a new start replaces it, a resume reuses it", async () => {
    await ensureInspectionRelay();
    const machine = {};

    maybeCreateRunInspection(machine as never, undefined, "start");
    const first = createInspectorMock.mock.results.at(-1)?.value as { destroy: Mock };
    const afterFirst = createInspectorMock.mock.calls.length;

    maybeCreateRunInspection(machine as never, undefined, "resume");
    expect(createInspectorMock.mock.calls.length).toBe(afterFirst);
    expect(first.destroy).not.toHaveBeenCalled();

    maybeCreateRunInspection(machine as never, undefined, "start");
    expect(createInspectorMock.mock.calls.length).toBe(afterFirst + 1);
    expect(first.destroy).toHaveBeenCalled();
  });
});

type MockInspector = { actor: Mock; snapshot: Mock; event: Mock; stop: Mock; destroy: Mock };

function currentInspector(): MockInspector {
  return createInspectorMock.mock.results.at(-1)?.value as MockInspector;
}

function fakeActor(overrides: Record<string, unknown> = {}) {
  return {
    id: "test",
    sessionId: "x:1",
    getSnapshot: () => ({ value: "idle", status: "active", context: {} }),
    ...overrides,
  } as never;
}

describe("manual inspection identity", () => {
  const machine = createMachine({ id: "test", initial: "idle", states: { idle: {} } });
  const boundMachine = machine.provide({}).provide({});
  const source = "export const machine = createMachine({ states: {} });";

  it("registers the root under a stable id and pushes its snapshot", async () => {
    await ensureInspectionRelay();
    const inspect = maybeCreateRunInspection(machine, source, "start")!;
    const root = fakeActor({ _parent: undefined, logic: boundMachine });

    // xstate v6 `@xstate.actor` events always carry the starting snapshot.
    inspect({
      type: "@xstate.actor",
      actorRef: root,
      rootId: "x:1",
      snapshot: (root as { getSnapshot(): unknown }).getSnapshot(),
    } as never);

    const inspector = currentInspector();
    expect(inspector.actor).toHaveBeenCalledWith(
      "root",
      expect.objectContaining({
        machine: source,
        snapshot: expect.objectContaining({ value: "idle", status: "active" }),
      }),
    );
    expect(inspector.snapshot).toHaveBeenCalledWith("root", expect.anything(), {
      type: "@xstate.init",
    });
  });

  it("forwards root snapshots with the causing event", async () => {
    await ensureInspectionRelay();
    const inspect = maybeCreateRunInspection(machine, source, "start")!;
    const root = fakeActor({ _parent: undefined, logic: boundMachine });
    const event = { type: "NEXT" };

    inspect({ type: "@xstate.actor", actorRef: root, rootId: "x:1" } as never);
    currentInspector().snapshot.mockClear();
    inspect({
      type: "@xstate.snapshot",
      actorRef: root,
      rootId: "x:1",
      snapshot: { value: "idle", status: "active", context: {} },
      event,
    } as never);

    expect(currentInspector().snapshot).toHaveBeenCalledWith(
      "root",
      expect.objectContaining({ value: "idle", status: "active" }),
      event,
    );
  });

  it("parents children under the root and disambiguates re-invocations", async () => {
    await ensureInspectionRelay();
    const inspect = maybeCreateRunInspection(machine, source, "start")!;
    const root = fakeActor({ _parent: undefined, logic: boundMachine });
    inspect({ type: "@xstate.actor", actorRef: root, rootId: "x:1" } as never);

    const childOne = fakeActor({ id: "agent.decide", sessionId: "x:2", _parent: root });
    const childTwo = fakeActor({ id: "agent.decide", sessionId: "x:3", _parent: root });
    inspect({ type: "@xstate.actor", actorRef: childOne, rootId: "x:1" } as never);
    inspect({ type: "@xstate.actor", actorRef: childTwo, rootId: "x:1" } as never);

    const ids = currentInspector().actor.mock.calls.map((call) => call[0]);
    expect(ids).toEqual(["root", "agent.decide", "agent.decide#2"]);
    expect(currentInspector().actor).toHaveBeenCalledWith(
      "agent.decide",
      expect.objectContaining({ parent: "root" }),
    );
  });

  it("drops non-JSON context instead of throwing", async () => {
    await ensureInspectionRelay();
    const inspect = maybeCreateRunInspection(machine, source, "start")!;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const root = fakeActor({
      _parent: undefined,
      logic: boundMachine,
      getSnapshot: () => ({ value: "idle", status: "active", context: circular }),
    });

    expect(() =>
      inspect({ type: "@xstate.actor", actorRef: root, rootId: "x:1" } as never),
    ).not.toThrow();
    expect(currentInspector().actor).toHaveBeenCalledWith(
      "root",
      expect.objectContaining({ snapshot: expect.objectContaining({ context: undefined }) }),
    );
  });

});

describe("demo inspection transport urls", () => {
  it("uses one secure room capability for the relay URL", () => {
    vi.stubEnv("DEMO_INSPECT_WS_URL", "");
    vi.stubEnv("DEMO_INSPECT_PORT", "");
    vi.stubEnv("STATELY_INSPECT_URL", "");

    const roomId = inspectionRoomId();

    expect(roomId).not.toBe("agent-demo");
    expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inspectionRoomId()).toBe(roomId);
    expect(new URL(inspectionRelayUrl()).searchParams.get("r")).toBe(roomId);
  });

  it("honors the SDK inspection URL override without owning its relay", () => {
    vi.stubEnv("DEMO_INSPECT_WS_URL", "");
    vi.stubEnv("DEMO_INSPECT_PORT", "");
    vi.stubEnv("STATELY_INSPECT_URL", "wss://inspect.example.com/socket");

    expect(inspectionWsUrl()).toBe("wss://inspect.example.com/socket");
    expect(shouldStartLocalInspectionRelay()).toBe(false);
  });

  it("starts a local relay only when the demo explicitly selects one", () => {
    vi.stubEnv("DEMO_INSPECT_WS_URL", "ws://127.0.0.1:4545/inspect");
    vi.stubEnv("DEMO_INSPECT_PORT", "");
    vi.stubEnv("STATELY_INSPECT_URL", "");

    expect(inspectionWsUrl()).toBe("ws://127.0.0.1:4545/inspect");
    expect(shouldStartLocalInspectionRelay()).toBe(true);
  });
});
