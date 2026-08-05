import { describe, expect, it, vi } from "vitest";
import { createVizPanelStore, type SystemMessage } from "./viz-panel-store";

const init = (sessionId = "root-session", value = "drafting"): SystemMessage => ({
  type: "@statelyai.system.init",
  protocolVersion: 2,
  actors: [
    {
      sessionId,
      actorId: "root",
      parentSessionId: null,
      machine: {},
      snapshot: { value, status: "active" },
    },
  ],
});

describe("viz panel store", () => {
  it("retries atomically", () => {
    const store = createVizPanelStore();
    store.trigger.timeout();

    store.trigger.retry();

    expect(store.getSnapshot().context).toMatchObject({ status: "connecting", frameKey: 1 });
  });

  it("does not time out after the iframe is ready", () => {
    const store = createVizPanelStore();
    store.trigger.iframeReady({ fallbackMessages: [] });

    store.trigger.timeout();

    expect(store.getSnapshot().context.status).toBe("ready");
  });

  it("surfaces transport and protocol failures", () => {
    const store = createVizPanelStore();

    store.trigger.transportFailed({ message: "Unsupported inspection protocol" });

    expect(store.getSnapshot().context).toMatchObject({
      status: "failed",
      error: "Unsupported inspection protocol",
    });
  });

  it("keeps the static machine and replays live snapshots when the iframe becomes ready", () => {
    const store = createVizPanelStore();
    const post = vi.fn();
    const fallback: SystemMessage = { type: "@statelyai.init", machine: "source" };
    const snapshot: SystemMessage = {
      type: "@statelyai.system.actorSnapshot",
      sessionId: "root-session",
      snapshot: { value: "reviewing" },
      event: { type: "approve" },
    };
    store.on("post", ({ message }) => post(message));

    store.trigger.systemInit({ message: init() });
    store.trigger.systemMessage({ message: snapshot });
    expect(post).not.toHaveBeenCalled();

    store.trigger.iframeReady({ fallbackMessages: [fallback] });

    expect(post.mock.calls.map(([message]) => message)).toEqual([
      fallback,
      {
        type: "@statelyai.inspectSnapshot",
        snapshot: { value: "drafting", status: "active" },
        event: { type: "@xstate.init" },
      },
      {
        type: "@statelyai.inspectSnapshot",
        snapshot: { value: "reviewing" },
        event: { type: "approve" },
      },
    ]);
    expect(store.getSnapshot().context.liveEvent).toBe("approve");
    expect(store.getSnapshot().context.liveStateLabel).toBe("reviewing");
  });

  it("does not reinitialize the machine when a resumed run registers a new root", () => {
    const store = createVizPanelStore();
    const post = vi.fn();
    store.on("post", ({ message }) => post(message));
    store.trigger.iframeReady({
      fallbackMessages: [{ type: "@statelyai.init", machine: "source" }],
    });
    post.mockClear();

    store.trigger.systemInit({ message: init("resumed-root", "reviewing") });

    expect(post.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "@statelyai.inspectSnapshot",
        snapshot: { value: "reviewing", status: "active" },
        event: { type: "@xstate.init" },
      },
    ]);
  });

  it("initializes the static preview when no live stream exists", () => {
    const store = createVizPanelStore();
    const post = vi.fn();
    const fallback = [{ type: "@statelyai.init" }, { type: "@statelyai.inspectSnapshot" }];
    store.on("post", ({ message }) => post(message));

    store.trigger.iframeReady({ fallbackMessages: fallback });

    expect(post.mock.calls.map(([message]) => message)).toEqual(fallback);
  });

  it("clears live state when the selected machine changes", () => {
    const store = createVizPanelStore();
    store.trigger.systemInit({ message: init() });
    store.trigger.systemMessage({
      message: {
        type: "@statelyai.system.actorEvent",
        sessionId: "root-session",
        event: { type: "approve" },
      },
    });

    store.trigger.machineChanged({ initMessage: null });

    expect(store.getSnapshot().context).toMatchObject({
      liveMessages: [],
      selectedSessionId: null,
      liveEvent: null,
    });
  });

  it("keeps the selected actor and final state after it stops", () => {
    const store = createVizPanelStore();
    store.trigger.systemInit({
      message: {
        ...init(),
        actors: [
          {
            sessionId: "root-session",
            actorId: "root",
            parentSessionId: null,
            machine: {},
            snapshot: { value: "drafting" },
          },
        ],
      },
    });
    store.trigger.systemMessage({
      message: {
        type: "@statelyai.system.actorSnapshot",
        sessionId: "root-session",
        snapshot: { value: "published", status: "done" },
      },
    });

    store.trigger.systemMessage({
      message: { type: "@statelyai.system.actorStopped", sessionId: "root-session" },
    });

    expect(store.getSnapshot().context).toMatchObject({
      selectedSessionId: "root-session",
      liveStateLabel: "published",
    });
  });

  it("tracks every snapshot for the selected v2 session", () => {
    const store = createVizPanelStore();
    store.trigger.systemInit({ message: init() });
    const observed: Array<string | null> = [];

    for (const value of ["drafting", "evaluating", "checking", "done"]) {
      store.trigger.systemMessage({
        message: {
          type: "@statelyai.system.actorSnapshot",
          sessionId: "root-session",
          snapshot: { value },
        },
      });
      observed.push(store.getSnapshot().context.liveStateLabel);
    }

    expect(observed).toEqual(["drafting", "evaluating", "checking", "done"]);
  });
});
