import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { createMachine } from "xstate";
const createInspectorMock = vi.hoisted(() =>
  vi.fn((_options: unknown) => ({
    actor: vi.fn(),
    machine: vi.fn(),
    snapshot: vi.fn(),
    event: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
  })),
);
vi.mock("@statelyai/sdk/inspect", () => ({ createInspector: createInspectorMock }));

import {
  declareInspectionMachine,
  ensureInspectionRelay,
  inspectionRelayUrl,
  inspectionWsUrl,
  machineForInspection,
  MAX_ROOMS,
  maybeCreateRunInspection,
  openInspectionRoom,
  rootMachinePayload,
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
    const room = openInspectionRoom();
    const inspect = maybeCreateRunInspection(room, machine as never, source, "start");

    expect(inspect).toEqual(expect.any(Function));
    expect(createInspectorMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: "wss://sky.stately.ai", roomId: room }),
    );
    const options = createInspectorMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("extractMachine");
    expect(options).not.toHaveProperty("extractMachineConfig");
  });

  it("publishes the selected machine to the room before any run", async () => {
    await ensureInspectionRelay();
    const machine = createMachine({ id: "declared", initial: "idle", states: { idle: {} } });
    const source = "export const machine = createMachine({ states: {} });";

    expect(
      declareInspectionMachine(openInspectionRoom(), rootMachinePayload(machine, source)),
    ).toBe(true);

    const inspector = createInspectorMock.mock.results.at(-1)?.value as { machine: Mock };
    // Seeded on the new inspector rather than pushed onto it: nothing was
    // connected yet, so the declaration rides the first system checkpoint.
    expect(createInspectorMock.mock.calls.at(-1)?.[0]).toMatchObject({
      machines: { root: source },
    });
    expect(inspector.machine).not.toHaveBeenCalled();
  });

  it("swaps the declared machine in place while no run has used the inspector", async () => {
    await ensureInspectionRelay();
    const room = openInspectionRoom();
    declareInspectionMachine(room, "first source");
    const created = createInspectorMock.mock.calls.length;
    const inspector = createInspectorMock.mock.results.at(-1)?.value as {
      machine: Mock;
      destroy: Mock;
    };

    declareInspectionMachine(room, "second source");

    // A selection change must not reload the /inspect page that is already
    // drawing this room.
    expect(createInspectorMock.mock.calls.length).toBe(created);
    expect(inspector.destroy).not.toHaveBeenCalled();
    expect(inspector.machine).toHaveBeenCalledWith("root", "second source");
  });

  it("pins the root selection for a run but never for a bare declaration", async () => {
    await ensureInspectionRelay();
    const room = openInspectionRoom();

    declareInspectionMachine(room, "declared source");
    // The visualizer drops its declared machine as soon as an init names a
    // selected session, so a pre-run checkpoint must not name one.
    expect(createInspectorMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("selectedSessionId");

    maybeCreateRunInspection(room, {} as never, "declared source", "start");
    // The same `<producer>:<id>` shape the actors carry on the wire.
    expect(createInspectorMock.mock.calls.at(-1)?.[0]).toMatchObject({
      selectedSessionId: "agent-demo-runner:root",
      machines: { root: "declared source" },
    });
  });

  it("declares the source the root actor will register with", () => {
    const machine = createMachine({ id: "test", initial: "idle", states: { idle: {} } });
    const source = "export const machine = createMachine({ states: {} });";
    const boundMachine = machine.provide({}).provide({});

    // Same payload both ways, so starting a run does not swap the graph the
    // viz is already drawing.
    expect(rootMachinePayload(machine, source)).toBe(
      machineForInspection({ logic: boundMachine }, machine, source),
    );
  });

  it("falls back to a serialized config when there is no source", () => {
    const machine = createMachine({ id: "test", initial: "idle", states: { idle: {} } });

    expect(rootMachinePayload(machine)).toMatchObject({ id: "test", initial: "idle" });
  });

  it("keeps one inspector per run session: a new start replaces it, a resume reuses it", async () => {
    await ensureInspectionRelay();
    const machine = {};
    const room = openInspectionRoom();

    maybeCreateRunInspection(room, machine as never, undefined, "start");
    const first = createInspectorMock.mock.results.at(-1)?.value as { destroy: Mock };
    const afterFirst = createInspectorMock.mock.calls.length;

    maybeCreateRunInspection(room, machine as never, undefined, "resume");
    expect(createInspectorMock.mock.calls.length).toBe(afterFirst);
    expect(first.destroy).not.toHaveBeenCalled();

    maybeCreateRunInspection(room, machine as never, undefined, "start");
    expect(createInspectorMock.mock.calls.length).toBe(afterFirst + 1);
    expect(first.destroy).toHaveBeenCalled();
  });
});

type MockInspector = {
  actor: Mock;
  machine: Mock;
  snapshot: Mock;
  event: Mock;
  stop: Mock;
  destroy: Mock;
};

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
    const inspect = maybeCreateRunInspection(openInspectionRoom(), machine, source, "start")!;
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
    const inspect = maybeCreateRunInspection(openInspectionRoom(), machine, source, "start")!;
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
    const inspect = maybeCreateRunInspection(openInspectionRoom(), machine, source, "start")!;
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
    const inspect = maybeCreateRunInspection(openInspectionRoom(), machine, source, "start")!;
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

describe("per-session rooms", () => {
  const machine = createMachine({ id: "test", initial: "idle", states: { idle: {} } });

  /** The mocked inspector created for `room`, most recent first. */
  function inspectorFor(room: string): MockInspector {
    const calls = createInspectorMock.mock.calls;
    for (let index = calls.length - 1; index >= 0; index--) {
      if ((calls[index]![0] as { roomId?: string }).roomId === room) {
        return createInspectorMock.mock.results[index]!.value as MockInspector;
      }
    }
    throw new Error(`No inspector for room ${room}`);
  }

  it("keeps two sessions' runs apart: neither room sees the other's actors", async () => {
    await ensureInspectionRelay();
    const gameRoom = openInspectionRoom();
    const storyRoom = openInspectionRoom();

    const inspectGame = maybeCreateRunInspection(gameRoom, machine, "game source", "start")!;
    const inspectStory = maybeCreateRunInspection(storyRoom, machine, "story source", "start")!;
    const gameRoot = fakeActor({ id: "game", _parent: undefined });
    const storyRoot = fakeActor({ id: "story", _parent: undefined });
    inspectGame({ type: "@xstate.actor", actorRef: gameRoot, rootId: "x:1" } as never);
    inspectStory({ type: "@xstate.actor", actorRef: storyRoot, rootId: "y:1" } as never);
    inspectGame({
      type: "@xstate.actor",
      actorRef: fakeActor({ id: "player", _parent: gameRoot }),
      rootId: "x:1",
    } as never);
    inspectGame({
      type: "@xstate.snapshot",
      actorRef: gameRoot,
      rootId: "x:1",
      snapshot: { value: "playing", status: "active", context: {} },
      event: { type: "HUMAN_ROLL" },
    } as never);

    const game = inspectorFor(gameRoom);
    const story = inspectorFor(storyRoom);
    expect(game).not.toBe(story);
    expect(game.actor.mock.calls.map(([id]) => id)).toEqual(["root", "player"]);
    expect(story.actor.mock.calls.map(([id]) => id)).toEqual(["root"]);
    expect(story.snapshot).not.toHaveBeenCalledWith("root", expect.anything(), {
      type: "HUMAN_ROLL",
    });
    // Starting a run in one room leaves the other's inspector alone.
    maybeCreateRunInspection(storyRoom, machine, "story source", "start");
    expect(game.destroy).not.toHaveBeenCalled();
  });

  it("declares per room: one session's selection is not another's graph", async () => {
    await ensureInspectionRelay();
    const first = openInspectionRoom();
    const second = openInspectionRoom();

    declareInspectionMachine(first, "first source");
    declareInspectionMachine(second, "second source");
    maybeCreateRunInspection(first, {} as never, "first source", "start");

    expect(createInspectorMock.mock.calls.at(-1)?.[0]).toMatchObject({
      roomId: first,
      machines: { root: "first source" },
    });
    expect(inspectorFor(second).machine).not.toHaveBeenCalled();
  });

  it("does not inspect a run that names no room", async () => {
    await ensureInspectionRelay();
    expect(maybeCreateRunInspection(undefined, machine, "source", "start")).toBeUndefined();
  });

  it("evicts the least recently used room past the cap", async () => {
    await ensureInspectionRelay();
    const oldest = openInspectionRoom();
    declareInspectionMachine(oldest, "oldest source");
    const kept = openInspectionRoom();
    declareInspectionMachine(kept, "kept source");
    const oldestInspector = inspectorFor(oldest);

    for (let index = 0; index < MAX_ROOMS; index++) {
      openInspectionRoom();
      // Using a room keeps it: `kept` stays the most recently used but one.
      if (index === 0) declareInspectionMachine(kept, "kept source");
    }

    expect(oldestInspector.destroy).toHaveBeenCalled();
    expect(inspectorFor(kept).destroy).not.toHaveBeenCalled();
  });
});

describe("demo inspection transport urls", () => {
  it("gives every browser session its own secure room capability", () => {
    vi.stubEnv("DEMO_INSPECT_WS_URL", "");
    vi.stubEnv("DEMO_INSPECT_PORT", "");
    vi.stubEnv("STATELY_INSPECT_URL", "");

    const roomId = openInspectionRoom();

    expect(roomId).not.toBe("agent-demo");
    expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
    expect(openInspectionRoom()).not.toBe(roomId);
    expect(new URL(inspectionRelayUrl(roomId)).searchParams.get("r")).toBe(roomId);
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
