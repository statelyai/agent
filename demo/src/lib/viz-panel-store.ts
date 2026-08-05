import { createStore } from "@xstate/store";

export type SystemMessage = Record<string, unknown> & {
  type: string;
  actors?: Array<{
    sessionId: string;
    actorId: string;
    parentSessionId: string | null;
    machine?: unknown;
    snapshot?: unknown;
  }>;
  actorId?: string;
  sessionId?: string;
  parentSessionId?: string | null;
  machine?: unknown;
  snapshot?: unknown;
  event?: unknown;
};

type VizPanelStatus = "connecting" | "ready" | "timedOut" | "failed";

type VizPanelContext = {
  status: VizPanelStatus;
  error: string | null;
  frameKey: number;
  liveMessages: SystemMessage[];
  selectedSessionId: string | null;
  liveEvent: string | null;
  /** Flattened state value of the selected actor, from live inspection. */
  liveStateLabel: string | null;
};

type VizPanelEvents = {
  retry: {};
  timeout: {};
  transportFailed: { message: string };
  iframeReady: { fallbackMessages: SystemMessage[] };
  machineChanged: { initMessage: SystemMessage | null };
  /** Re-init the embed (e.g. theme flip), then replay what it was showing. */
  themeChanged: { initMessage: SystemMessage | null; fallbackMessages: SystemMessage[] };
  fallbackFrame: { message: SystemMessage };
  systemInit: { message: SystemMessage };
  systemMessage: { message: SystemMessage };
};

type VizPanelEmitted = {
  post: { message: SystemMessage };
};

const maxLiveMessages = 200;

function rootActor(message: SystemMessage) {
  return Array.isArray(message.actors)
    ? ([...message.actors]
        .reverse()
        .find((actor) => actor.parentSessionId == null) ?? null)
    : null;
}

function inspectSnapshot(snapshot: unknown, event: unknown): SystemMessage {
  return {
    type: "@statelyai.inspectSnapshot",
    snapshot,
    event,
  };
}

/**
 * Renders an XState state value as a single short label: `"executing"`,
 * `"executing.validating"`, parallel regions joined by `" | "`.
 */
export function flattenStateValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parts = Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const nested = flattenStateValue(child);
    return nested ? `${key}.${nested}` : key;
  });
  return parts.length > 0 ? parts.join(" | ") : null;
}

function snapshotStateLabel(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  return flattenStateValue((snapshot as { value?: unknown }).value);
}

function appendLiveMessage(messages: SystemMessage[], message: SystemMessage) {
  if (messages.length < maxLiveMessages) return [...messages, message];
  return [messages[0], ...messages.slice(2), message];
}

export function createVizPanelStore() {
  return createStore<VizPanelContext, VizPanelEvents, VizPanelEmitted>({
    context: {
      status: "connecting",
      error: null,
      frameKey: 0,
      liveMessages: [],
      selectedSessionId: null,
      liveEvent: null,
      liveStateLabel: null,
    },
    on: {
      retry: (context) => ({
        ...context,
        status: "connecting",
        error: null,
        frameKey: context.frameKey + 1,
      }),
      timeout: (context) =>
        context.status === "connecting" ? { ...context, status: "timedOut" } : context,
      transportFailed: (context, event) => ({
        ...context,
        status: "failed",
        error: event.message,
      }),
      iframeReady: (context, event, enqueue) => {
        // The authored machine is stable across persisted run/resume systems.
        // Always initialize it once, then layer buffered live snapshots on top.
        for (const message of event.fallbackMessages) enqueue.emit.post({ message });
        for (const message of context.liveMessages) enqueue.emit.post({ message });
        return { ...context, status: "ready", error: null };
      },
      machineChanged: (context, event, enqueue) => {
        if (context.status === "ready" && event.initMessage) {
          enqueue.emit.post({ message: event.initMessage });
        }
        return {
          ...context,
          liveMessages: [],
          selectedSessionId: null,
          liveEvent: null,
          liveStateLabel: null,
        };
      },
      themeChanged: (context, event, enqueue) => {
        if (context.status !== "ready") return context;
        if (context.liveMessages.length > 0) {
          if (event.initMessage) enqueue.emit.post({ message: event.initMessage });
          for (const message of context.liveMessages) enqueue.emit.post({ message });
        } else {
          for (const message of event.fallbackMessages) enqueue.emit.post({ message });
        }
        return context;
      },
      fallbackFrame: (context, event, enqueue) => {
        if (context.status === "ready" && context.liveMessages.length === 0) {
          enqueue.emit.post({ message: event.message });
        }
        return context;
      },
      systemInit: (context, event, enqueue) => {
        const root = rootActor(event.message);
        const frame = root?.snapshot
          ? inspectSnapshot(root.snapshot, { type: "@xstate.init" })
          : null;
        if (context.status === "ready" && frame) enqueue.emit.post({ message: frame });
        return {
          ...context,
          liveMessages: frame ? [frame] : [],
          selectedSessionId: root?.sessionId ?? null,
          liveEvent: null,
          liveStateLabel: snapshotStateLabel(root?.snapshot),
        };
      },
      systemMessage: (context, event, enqueue) => {
        const message = event.message;
        let selectedSessionId = context.selectedSessionId;
        let liveEvent = context.liveEvent;
        let liveStateLabel = context.liveStateLabel;
        let frame: SystemMessage | null = null;

        if (
          message.type === "@statelyai.system.actorRegistered" &&
          message.parentSessionId == null &&
          message.machine &&
          message.sessionId
        ) {
          selectedSessionId = message.sessionId;
          liveStateLabel = snapshotStateLabel(message.snapshot) ?? liveStateLabel;
          if (message.snapshot) {
            frame = inspectSnapshot(message.snapshot, { type: "@xstate.init" });
          }
        } else if (
          message.type === "@statelyai.system.actorEvent" &&
          message.sessionId === selectedSessionId
        ) {
          const eventType = (message.event as { type?: string } | null | undefined)?.type;
          if (typeof eventType === "string" && !eventType.startsWith("@xstate.")) {
            liveEvent = eventType;
          }
        } else if (
          message.type === "@statelyai.system.actorSnapshot" &&
          message.sessionId === selectedSessionId
        ) {
          // Internal lifecycle events (@xstate.init / @xstate.stop) would
          // clobber the run's real last event — keep them off the label.
          const eventType = (message.event as { type?: string } | null | undefined)?.type;
          if (typeof eventType === "string" && !eventType.startsWith("@xstate.")) {
            liveEvent = eventType;
          }
          liveStateLabel = snapshotStateLabel(message.snapshot) ?? liveStateLabel;
          frame = inspectSnapshot(message.snapshot, message.event ?? null);
        }

        if (context.status === "ready" && frame) enqueue.emit.post({ message: frame });
        return {
          ...context,
          liveMessages: frame
            ? appendLiveMessage(context.liveMessages, frame)
            : context.liveMessages,
          selectedSessionId,
          liveEvent,
          liveStateLabel,
        };
      },
    },
  });
}
