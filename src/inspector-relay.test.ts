import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { createInspector } from "@statelyai/sdk/inspect";
import {
  createNodeInspectionRelay,
  type NodeInspectionRelayServer,
} from "@statelyai/sdk/node-relay";
import { runAgent, setupAgent } from "./index.js";

// End to end: a run streams through @statelyai/sdk's inspector to a local
// relay, and a viewer in the same room receives every actor and its states.

type RelayMessage = {
  type: string;
  sessionId?: string;
  snapshot?: { value?: unknown };
  [key: string]: unknown;
};

function createTwoStepMachine() {
  return setupAgent({
    context: z.object({}),
    actors: { work: createAsyncLogic<number>({ run: async () => 1 }) },
  }).createMachine({
    id: "two-step",
    context: {},
    initial: "a",
    states: {
      a: { invoke: { src: "work", onDone: { target: "b" } } },
      b: { invoke: { src: "work", onDone: { target: "c" } } },
      c: { type: "final" },
    },
  });
}

async function joinAsViewer(url: string, roomId: string) {
  const messages: RelayMessage[] = [];
  const socket = new WebSocket(`${url}?r=${roomId}`);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("viewer could not connect"));
  });
  socket.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as RelayMessage);
  };
  socket.send(JSON.stringify({ type: "@statelyai.register", protocolVersion: 2, role: "viewer" }));
  // The run starts only after the relay acknowledges this viewer.
  await until(() => messages.some((m) => m.type === "@statelyai.registered"));
  if (!messages.some((m) => m.type === "@statelyai.registered")) {
    socket.close();
    throw new Error("relay never acknowledged the viewer");
  }
  socket.send(JSON.stringify({ type: "@statelyai.ready", version: "test", protocolVersion: 2 }));
  socket.send(JSON.stringify({ type: "@statelyai.system.loaded" }));
  return { messages, close: () => socket.close() };
}

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("runAgent through the Stately inspector", () => {
  let relay: NodeInspectionRelayServer;

  beforeEach(async () => {
    relay = createNodeInspectionRelay({ port: 0 });
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  test("a viewer sees each actor once and every root state, with no inspector errors", async () => {
    const roomId = "room-" + Math.random().toString(36).slice(2);
    const inspector = createInspector({ url: relay.url, roomId, session: "direct", name: "e2e" });
    const errors: unknown[] = [];
    inspector.on("error", (error) => errors.push(error));
    let viewer: Awaited<ReturnType<typeof joinAsViewer>> | undefined;

    try {
      await inspector.ready;
      viewer = await joinAsViewer(relay.url, roomId);
      const { messages } = viewer;
      await runAgent(createTwoStepMachine(), { inspect: inspector.inspect });

      const snapshotsOf = (sessionId: string) =>
        messages.filter(
          (m) => m.type === "@statelyai.system.actorSnapshot" && m.sessionId === sessionId,
        );
      const registered = () =>
        messages.filter((m) => m.type === "@statelyai.system.actorRegistered");
      const rootId = () =>
        registered().find((m) => JSON.stringify(m).includes("two-step"))?.sessionId;
      await until(() => {
        const id = rootId();
        return !!id && snapshotsOf(id).some((m) => m.snapshot?.value === "c");
      });

      const sessionIds = registered().map((m) => m.sessionId);
      // Root plus one child per invoke, each registered exactly once.
      expect(sessionIds.length).toBe(3);
      expect(new Set(sessionIds).size).toBe(3);

      const root = rootId();
      expect(root).toBeDefined();
      const values = snapshotsOf(root!).map((m) => m.snapshot?.value);
      expect(values).toContain("a");
      expect(values).toContain("b");
      expect(values.at(-1)).toBe("c");

      expect(errors).toEqual([]);
    } finally {
      viewer?.close();
      inspector.destroy();
    }
  });
});
