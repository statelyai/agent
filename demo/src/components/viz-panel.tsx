import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { ExternalLink, RefreshCcw } from "lucide-react";
import { getTargetOrigin, isTrustedVizMessage } from "@/lib/viz-transport";
import { createVizPanelStore, type SystemMessage } from "@/lib/viz-panel-store";
import { Button } from "@/components/ui/button";
import type { VizFrame } from "@/hooks/use-trace-player";

const defaultVizUrl = "https://editor.stately.ai/embed?auth=message";

export type LiveWs = { wsUrl: string; session: string };

type VizPanelProps = {
  /** Display name of the machine being inspected. */
  title: string;
  /** Stable key for the current machine — a change re-inits the embed. */
  machineKey: string;
  /** Serialized machine config for the embed, or null when none is available. */
  vizConfig: Record<string, unknown> | null;
  frame: VizFrame;
  /**
   * Live inspection relay. When set, the panel connects to the local WS relay
   * and bridges `@statelyai.system.*` messages into the embed as they happen —
   * transitions render in REAL TIME during a run, not as a post-hoc replay.
   */
  liveWs: LiveWs | null;
  /**
   * Full viz `/inspect` page URL (VITE_VIZ_INSPECT_URL). When set it replaces
   * the embed entirely. Use a local HTTP viz app or a WSS relay; a hosted HTTPS
   * page cannot connect directly to the demo's local `ws://` relay.
   */
  liveUrl: string | null;
};

export function VizPanel({ title, machineKey, vizConfig, frame, liveWs, liveUrl }: VizPanelProps) {
  if (liveUrl) {
    return (
      <section className="work-panel viz-panel" aria-labelledby="viz-panel-title">
        <div className="panel-heading viz-heading">
          <div>
            <span className="panel-kicker">Live machine</span>
            <h2 id="viz-panel-title">Statechart</h2>
          </div>
          <div className="live-status" data-ready>
            <span aria-hidden="true" />
            live inspection
          </div>
        </div>
        <div className="viz-frame-wrap">
          <iframe
            className="viz-frame"
            data-ready
            title={`Live inspection for ${title}`}
            src={liveUrl}
            referrerPolicy="strict-origin"
          />
        </div>
      </section>
    );
  }
  return (
    <EmbedVizPanel
      title={title}
      machineKey={machineKey}
      vizConfig={vizConfig}
      frame={frame}
      liveWs={liveWs}
    />
  );
}

function createInitMessage(machine: unknown): SystemMessage {
  return {
    type: "@statelyai.init",
    machine,
    mode: "inspecting",
    theme: "light",
    readOnly: true,
    capabilities: {
      edit: false,
      export: false,
      ai: false,
      simulate: false,
      inspect: true,
      navigateHierarchy: false,
      maxDepth: 2,
      panels: [],
    },
    leftPanels: [],
    rightPanels: [],
    activePanels: [],
  };
}

function createFrameMessage(frame: VizFrame): SystemMessage {
  return {
    type: "@statelyai.inspectSnapshot",
    snapshot: { value: frame.value, status: frame.status, context: frame.context },
    event: frame.event,
  };
}

function createStaticMessages(vizConfig: Record<string, unknown> | null, frame: VizFrame) {
  return vizConfig ? [createInitMessage(vizConfig), createFrameMessage(frame)] : [];
}

function EmbedVizPanel({
  title,
  machineKey,
  vizConfig,
  frame,
  liveWs,
}: Omit<VizPanelProps, "liveUrl">) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const latestRef = useRef({ vizConfig, frame });
  const [store] = useState(createVizPanelStore);
  const status = useSelector(store, (snapshot) => snapshot.context.status);
  const frameKey = useSelector(store, (snapshot) => snapshot.context.frameKey);
  const liveEvent = useSelector(store, (snapshot) => snapshot.context.liveEvent);
  const ready = status === "ready";
  const timedOut = status === "timedOut";
  const vizUrl = import.meta.env.VITE_VIZ_URL || defaultVizUrl;
  const targetOrigin = useMemo(() => getTargetOrigin(vizUrl), [vizUrl]);

  latestRef.current = { vizConfig, frame };

  const post = useCallback(
    (message: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(message, targetOrigin);
    },
    [targetOrigin],
  );

  useEffect(() => {
    const subscription = store.on("post", ({ message }) => post(message));
    return () => subscription.unsubscribe();
  }, [post, store]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isTrustedVizMessage(event, iframeRef.current?.contentWindow ?? null, targetOrigin))
        return;
      if (event.data?.type === "@statelyai.ready") {
        const latest = latestRef.current;
        store.trigger.iframeReady({
          fallbackMessages: createStaticMessages(latest.vizConfig, latest.frame),
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [store, targetOrigin]);

  // Reset live inspection only when the selected machine changes. In
  // particular, do not clear observations when the iframe becomes ready.
  useEffect(() => {
    store.trigger.machineChanged({ initMessage: vizConfig ? createInitMessage(vizConfig) : null });
    // machineKey identifies the machine; vizConfig is its (stable) payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineKey, store]);

  // Fallback replay frames (only used when live inspection is unavailable).
  useEffect(() => {
    if (!vizConfig) return;
    store.trigger.fallbackFrame({ message: createFrameMessage(frame) });
  }, [frame, store, vizConfig]);

  // ─── live bridge: relay WS → embed postMessage ───
  //
  // The demo page plays the role the viz /inspect route would: it joins the
  // relay session as a "viz" peer and forwards the full streamed system
  // protocol into the (auth-free) embed. The local HTTP parent owns the ws://
  // connection, avoiding mixed content in the hosted HTTPS iframe.
  useEffect(() => {
    if (!liveWs) return;
    let connectedAt = 0;
    const socket = new WebSocket(liveWs.wsUrl);
    socket.onopen = () => {
      connectedAt = Date.now();
      socket.send(
        JSON.stringify({ type: "@statelyai.register", role: "viz", sessionId: liveWs.session }),
      );
    };
    socket.onmessage = (messageEvent) => {
      let message: SystemMessage;
      try {
        message = JSON.parse(String(messageEvent.data)) as SystemMessage;
      } catch {
        return;
      }
      // A `system.init` right after connecting is relay replay of an older
      // session — ignore it so the static preview isn't clobbered on page
      // load. A LATER init is the node inspector's fresh connect (first run
      // in a server process): adopt its root machine.
      if (message.type === "@statelyai.system.init" && Array.isArray(message.actors)) {
        if (Date.now() - connectedAt < 1000) return;
        store.trigger.systemInit({ message });
      } else if (message.type.startsWith("@statelyai.system.")) {
        store.trigger.systemMessage({ message });
      }
    };
    return () => socket.close();
  }, [liveWs?.wsUrl, liveWs?.session, store]);

  useEffect(() => {
    const timeout = window.setTimeout(() => store.trigger.timeout(), 9000);
    return () => window.clearTimeout(timeout);
  }, [frameKey, store, vizUrl]);

  const statusLabel = !ready
    ? "connecting"
    : liveWs
      ? liveEvent
        ? `live · ${liveEvent}`
        : "live inspection"
      : frame.event
        ? `event · ${frame.event.type}`
        : "connected";

  return (
    <section className="work-panel viz-panel" aria-labelledby="viz-panel-title">
      <div className="panel-heading viz-heading">
        <div>
          <span className="panel-kicker">Live machine</span>
          <h2 id="viz-panel-title">Statechart</h2>
        </div>
        <div className="live-status" data-ready={ready || undefined}>
          <span aria-hidden="true" />
          {statusLabel}
        </div>
      </div>

      <div className="viz-frame-wrap">
        {!vizConfig ? (
          <div className="viz-error">
            <span className="offline-mark" aria-hidden="true" />
            <strong>No machine to inspect</strong>
            <p>This example does not export a state machine from its index.ts.</p>
          </div>
        ) : (
          <>
            {!ready && !timedOut && (
              <div className="viz-loading" aria-label="Connecting to Stately Viz">
                <span className="viz-loading__mark" />
                <span>Connecting to Viz…</span>
              </div>
            )}
            {timedOut && !ready && (
              <div className="viz-error">
                <span className="offline-mark" aria-hidden="true" />
                <strong>Viz did not connect</strong>
                <p>Check the embed URL or run the local Viz app.</p>
                <div>
                  <Button size="sm" onClick={() => store.trigger.retry()}>
                    <RefreshCcw size={14} /> Retry
                  </Button>
                  <a href={vizUrl} target="_blank" rel="noreferrer">
                    Open Viz <ExternalLink size={13} />
                  </a>
                </div>
              </div>
            )}
            <iframe
              key={frameKey}
              ref={iframeRef}
              className="viz-frame"
              data-ready={ready || undefined}
              title={`Live statechart for ${title}`}
              src={vizUrl}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="strict-origin"
            />
          </>
        )}
      </div>
    </section>
  );
}
