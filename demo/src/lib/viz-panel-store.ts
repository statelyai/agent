import { createStore } from "@xstate/store";

export type SystemMessage = Record<string, unknown> & {
  type: string;
  actors?: Array<{
    actorId: string;
    parentActorId: string | null;
    machineConfig?: unknown;
    machine?: unknown;
    snapshot?: unknown;
  }>;
  actorId?: string;
  parentActorId?: string | null;
  machine?: unknown;
  snapshot?: unknown;
  event?: unknown;
};

type VizPanelStatus = "connecting" | "ready" | "timedOut";

type VizPanelContext = {
  status: VizPanelStatus;
  frameKey: number;
  liveMessages: SystemMessage[];
  selectedActorId: string | null;
  liveEvent: string | null;
  /** Flattened state value of the selected actor, from live inspection. */
  liveStateLabel: string | null;
};

type VizPanelEvents = {
  retry: {};
  timeout: {};
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
        .find((actor) => actor.parentActorId == null && (actor.machineConfig ?? actor.machine)) ??
        null)
    : null;
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
      frameKey: 0,
      liveMessages: [],
      selectedActorId: null,
      liveEvent: null,
      liveStateLabel: null,
    },
    on: {
      retry: (context) => ({
        ...context,
        status: "connecting",
        frameKey: context.frameKey + 1,
      }),
      timeout: (context) =>
        context.status === "connecting" ? { ...context, status: "timedOut" } : context,
      iframeReady: (context, event, enqueue) => {
        const messages =
          context.liveMessages.length > 0 ? context.liveMessages : event.fallbackMessages;
        for (const message of messages) enqueue.emit.post({ message });
        return { ...context, status: "ready" };
      },
      machineChanged: (context, event, enqueue) => {
        if (context.status === "ready" && event.initMessage) {
          enqueue.emit.post({ message: event.initMessage });
        }
        return {
          ...context,
          liveMessages: [],
          selectedActorId: null,
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
        if (context.status === "ready") enqueue.emit.post({ message: event.message });
        const root = rootActor(event.message);
        return {
          ...context,
          liveMessages: [event.message],
          selectedActorId: root?.actorId ?? null,
          liveEvent: null,
          liveStateLabel: snapshotStateLabel(root?.snapshot),
        };
      },
      systemMessage: (context, event, enqueue) => {
        const message = event.message;
        let selectedActorId = context.selectedActorId;
        let liveEvent = context.liveEvent;
        let liveStateLabel = context.liveStateLabel;

        if (
          message.type === "@statelyai.system.actorRegistered" &&
          message.parentActorId == null &&
          message.machine &&
          message.actorId
        ) {
          selectedActorId = message.actorId;
          liveStateLabel = snapshotStateLabel(message.snapshot) ?? liveStateLabel;
        } else if (
          message.type === "@statelyai.system.actorEvent" &&
          message.actorId === selectedActorId
        ) {
          const eventType = (message.event as { type?: string } | null | undefined)?.type;
          if (typeof eventType === "string" && !eventType.startsWith("@xstate.")) {
            liveEvent = eventType;
          }
        } else if (
          message.type === "@statelyai.system.actorSnapshot" &&
          message.actorId === selectedActorId
        ) {
          // Internal lifecycle events (@xstate.init / @xstate.stop) would
          // clobber the run's real last event — keep them off the label.
          const eventType = (message.event as { type?: string } | null | undefined)?.type;
          if (typeof eventType === "string" && !eventType.startsWith("@xstate.")) {
            liveEvent = eventType;
          }
          liveStateLabel = snapshotStateLabel(message.snapshot) ?? liveStateLabel;
        }

        if (context.liveMessages.length === 0) {
          return { ...context, selectedActorId, liveEvent, liveStateLabel };
        }
        if (context.status === "ready") enqueue.emit.post({ message });
        return {
          ...context,
          liveMessages: appendLiveMessage(context.liveMessages, message),
          selectedActorId,
          liveEvent,
          liveStateLabel,
        };
      },
    },
  });
}
