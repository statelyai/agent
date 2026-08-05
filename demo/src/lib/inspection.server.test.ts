import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachine } from "xstate";
const createInspectorMock = vi.hoisted(() =>
  vi.fn((_options: unknown) => ({ inspect: vi.fn(), destroy: vi.fn() })),
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
    const inspect = maybeCreateRunInspection(machine as never, source);

    expect(inspect).toEqual(expect.any(Function));
    expect(createInspectorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://sky.stately.ai",
        roomId: inspectionRoomId(),
        extractMachine: expect.any(Function),
      }),
    );
    const options = createInspectorMock.mock.calls.at(-1)?.[0] as {
      extractMachine?: (actor: { logic?: unknown }) => unknown;
      extractMachineConfig?: unknown;
    };
    expect(options.extractMachine?.({ logic: machine })).toBe(source);
    expect(options).not.toHaveProperty("extractMachineConfig");
  });

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
