import { describe, expect, it, vi } from "vitest";
import { createVizPanelStore, type SystemMessage } from "./viz-panel-store";

const init = (actorId = "root"): SystemMessage => ({
  type: "@statelyai.system.init",
  actors: [{ actorId, parentActorId: null, machine: {} }],
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

  it("replays buffered live messages in order when the iframe becomes ready", () => {
    const store = createVizPanelStore();
    const post = vi.fn();
    const snapshot: SystemMessage = {
      type: "@statelyai.system.actorSnapshot",
      actorId: "root",
      event: { type: "approve" },
    };
    store.on("post", ({ message }) => post(message));

    store.trigger.systemInit({ message: init() });
    store.trigger.systemMessage({ message: snapshot });
    expect(post).not.toHaveBeenCalled();

    store.trigger.iframeReady({ fallbackMessages: [] });

    expect(post.mock.calls.map(([message]) => message)).toEqual([init(), snapshot]);
    expect(store.getSnapshot().context.liveEvent).toBe("approve");
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
        actorId: "root",
        event: { type: "approve" },
      },
    });

    store.trigger.machineChanged({ initMessage: null });

    expect(store.getSnapshot().context).toMatchObject({
      liveMessages: [],
      selectedActorId: null,
      liveEvent: null,
    });
  });
});
