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
};

type VizPanelEvents = {
  retry: {};
  timeout: {};
  iframeReady: { fallbackMessages: SystemMessage[] };
  machineChanged: { initMessage: SystemMessage | null };
  fallbackFrame: { message: SystemMessage };
  systemInit: { message: SystemMessage };
  systemMessage: { message: SystemMessage };
};

type VizPanelEmitted = {
  post: { message: SystemMessage };
};

const maxLiveMessages = 200;

function rootActorId(message: SystemMessage) {
  const root = Array.isArray(message.actors)
    ? [...message.actors]
        .reverse()
        .find((actor) => actor.parentActorId == null && (actor.machineConfig ?? actor.machine))
    : undefined;
  return root?.actorId ?? null;
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
        };
      },
      fallbackFrame: (context, event, enqueue) => {
        if (context.status === "ready" && context.liveMessages.length === 0) {
          enqueue.emit.post({ message: event.message });
        }
        return context;
      },
      systemInit: (context, event, enqueue) => {
        if (context.status === "ready") enqueue.emit.post({ message: event.message });
        return {
          ...context,
          liveMessages: [event.message],
          selectedActorId: rootActorId(event.message),
          liveEvent: null,
        };
      },
      systemMessage: (context, event, enqueue) => {
        const message = event.message;
        let selectedActorId = context.selectedActorId;
        let liveEvent = context.liveEvent;

        if (
          message.type === "@statelyai.system.actorRegistered" &&
          message.parentActorId == null &&
          message.machine &&
          message.actorId
        ) {
          selectedActorId = message.actorId;
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
          const eventType = (message.event as { type?: string } | null | undefined)?.type;
          liveEvent = typeof eventType === "string" ? eventType : null;
        }

        if (context.liveMessages.length === 0) {
          return { ...context, selectedActorId, liveEvent };
        }
        if (context.status === "ready") enqueue.emit.post({ message });
        return {
          ...context,
          liveMessages: appendLiveMessage(context.liveMessages, message),
          selectedActorId,
          liveEvent,
        };
      },
    },
  });
}
